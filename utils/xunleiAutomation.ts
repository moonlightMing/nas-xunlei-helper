/**
 * 向 NAS 迅雷 Web 页注入脚本、自动化创建下载任务的模块。
 *
 * 原理沿用原型项目 nas-thunder-helper：复用浏览器里已登录的迅雷 Web 会话，
 * 通过 chrome.scripting.executeScript 注入脚本模拟点击「新建任务 → 填链接 →
 * 解析 → 立即下载」完成建任务。
 *
 * 保存路径需要读取页面的 Vuex（drive.treeNodeId/treeNodePath），因此
 * confirm-download / wait-dialog 两步注入 MAIN world；目录解析复用面板自身的
 * store action（drive/getFolderList、drive/loadFolders），不自行拼接建任务请求。
 *
 * 任务监控同样只读注入 MAIN world，读取 drive.all/tasks/tasksDone，并按需复用
 * 面板自身的 drive/getTask 刷新单个任务；不调用 NAS HTTP API。
 *
 * 对接的是群晖套件版迅雷 Web UI（Element UI），选择器与面板状态结构集中在本文件，
 * 迅雷套件更新导致 DOM / Vuex 变化时只需改这里。
 *
 * 注意：注入函数（injectedRunStep / injectedProbe / injectedReadTasks）会被序列化
 * 进页面执行，必须完全自包含，不能引用本文件其它顶层作用域的变量。
 */

import {
  buildMatchPlan,
  toMatchSummary,
  type AvMatchSettings,
  type FileListSnapshot,
  type MatchPlan,
  type MatchSummary,
  type SnapshotFile,
  type SnapshotGroup,
} from '@/utils/avMatch';
import type { DownloadMode } from '@/utils/settings';
import { classifyInjectionError, type SendErrorCode } from '@/utils/sendErrors';

/** 迅雷 Web UI 关键选择器 */
export const XUNLEI_SELECTORS = {
  /** 「新建任务」按钮 */
  createTaskButton: '.create__task',
  /** 链接输入 textarea */
  linkTextarea: '.el-textarea__inner',
  /** 「解析」/「立即下载」按钮（两个对话框里都有同名 class，查询时需限定对话框） */
  parseButton: '.task-parse-btn',
  /** 解析结果对话框 */
  taskDialog: '.result-nas-task-dialog',
  /** 错误 toast（解析失败、任务创建失败等） */
  errorToast: '.el-message--error, .el-notification--error',
  /** 登录表单（用于识别会话失效） */
  loginForm: 'input[type="password"]',
  /** BT 解析结果的文件树容器 */
  fileTree: '.result-nas-task-dialog .bt_select_plus',
  /** Element Plus 文件树节点 */
  fileTreeEl: '.result-nas-task-dialog .bt_select_plus .el-tree',
} as const;

/** 自动化单步等待元素的超时（毫秒） */
export const STEP_TIMEOUT_MS = 10_000;

export type AutomationStep = 'create-task' | 'fill-links' | 'confirm-download' | 'wait-dialog';

type ExecStep = AutomationStep | 'check-path' | 'list-dir';

export interface SendOptions {
  links: string[];
  downloadPath: string;
  mode: DownloadMode;
  match: AvMatchSettings;
}

/** 默认路径应用情况 */
export interface PathApplied {
  /** 是否配置了默认路径 */
  needed: boolean;
  /** 是否已写入迅雷面板的目录选择 */
  applied: boolean;
  /** 实际应用的迅雷目录路径（applied=true 时） */
  resolvedPath?: string;
  /** 未能应用的原因（applied=false 且 needed=true 时） */
  reason?: string;
}

/** 发送流程结果（background 与 popup 之间传递，也可用于通知文案） */
export interface SendOutcome {
  /** 流程走到哪一步，失败时用于定位 */
  stage: 'prepare' | 'open-page' | AutomationStep | 'match' | 'done';
  ok: boolean;
  /** 失败原因分类，供通知/UI 决定动作 */
  code?: SendErrorCode;
  message: string;
  pathApplied?: PathApplied;
  /** 立即下载点击后读到的任务 id，用于任务监控初始候选 */
  taskIds?: string[];
  /** 严格模式/文件列表异常时暂停，不点击立即下载 */
  paused?: { reason: 'unmatched' | 'file-list-timeout' };
  /** 番号匹配摘要（只含计数，不含完整文件列表） */
  match?: MatchSummary;
}

interface StepResult {
  ok: boolean;
  code?: SendErrorCode;
  message: string;
  pathApplied?: PathApplied;
  data?: unknown;
}

export interface PageProbe {
  reachable: boolean;
  url: string;
  title: string;
  hasApp: boolean;
  hasStore: boolean;
  loggedIn: boolean;
  hasCreateTask: boolean;
  hasLoginForm: boolean;
  loginText: boolean;
  errorText: string;
  hasResultDialog: boolean;
  injectionError?: string;
}

export interface DirItem {
  id: string;
  name: string;
  path: string;
  realPath?: string;
  writable: boolean;
}

export interface TaskStateItem {
  id: string;
  name: string;
  phase: string;
  progress?: number;
  detail?: string;
  type?: string;
}

export interface TaskStateSnapshot {
  currentIds: string[];
  tasks: Record<string, TaskStateItem>;
}

export interface ReadFileListResult {
  ok: boolean;
  snapshot?: FileListSnapshot;
  message?: string;
  debug?: string;
}

export interface ApplySelectionPlan {
  treeHash: string;
  selectedIds: string[];
  preserveRootIds: string[];
}

export interface ApplySelectionResult {
  ok: boolean;
  /** 是否已经调用过 setCheckedKeys；false 表示页面状态未被修改 */
  attempted?: boolean;
  stale?: boolean;
  applied?: boolean;
  parentSynced?: boolean;
  buttonDisabled?: boolean;
  checkedCount?: number;
  message?: string;
  debug?: string;
}

/**
 * 执行完整发送流程（在 background service worker 中调用）。
 * 每一步单独注入一次脚本，步骤间状态由页面 DOM / Vuex 承载。
 */
export async function runSendFlow(tabId: number, options: SendOptions): Promise<SendOutcome> {
  const steps: Array<{ stage: AutomationStep; payload: Record<string, string> }> = [
    { stage: 'create-task', payload: {} },
    { stage: 'fill-links', payload: { links: options.links.join('\n') } },
  ];

  for (const { stage, payload } of steps) {
    let result = await execStep(tabId, stage, payload);
    if (!result.ok && (stage === 'create-task' || stage === 'fill-links')) {
      result = await refineStepError(tabId, result);
    }
    if (!result.ok) {
      return { stage, ok: false, code: result.code, message: result.message };
    }
  }

  if (!options.match.enabled) {
    if (options.mode === 'confirm') {
      const result = await execStep(tabId, 'wait-dialog', { downloadPath: options.downloadPath });
      if (!result.ok) {
        return { stage: 'wait-dialog', ok: false, code: result.code, message: result.message };
      }
      return {
        stage: 'done',
        ok: true,
        message: buildDoneMessage('confirm', result.pathApplied),
        pathApplied: result.pathApplied,
      };
    }

    const result = await execStep(tabId, 'confirm-download', { downloadPath: options.downloadPath });
    if (!result.ok) {
      return { stage: 'confirm-download', ok: false, code: result.code, message: result.message };
    }
    const taskIds = (result.data as { taskIds?: unknown } | undefined)?.taskIds;
    return {
      stage: 'done',
      ok: true,
      message: buildDoneMessage('immediate', result.pathApplied),
      pathApplied: result.pathApplied,
      taskIds: Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === 'string') : undefined,
    };
  }

  return runMatchingSendFlow(tabId, options);
}

function matchSuffix(plan: MatchPlan): string {
  if (plan.status === 'skipped') return '';
  const fallbackNote =
    plan.policy === 'fallback' && plan.status !== 'applied'
      ? '（已保留未匹配任务的原勾选）'
      : '';
  return `；${plan.summary}${fallbackNote}`;
}

async function runMatchingSendFlow(tabId: number, options: SendOptions): Promise<SendOutcome> {
  const wait = await execStep(tabId, 'wait-dialog', { downloadPath: options.downloadPath });
  if (!wait.ok) {
    return { stage: 'wait-dialog', ok: false, code: wait.code, message: wait.message };
  }
  const pathApplied = wait.pathApplied;

  const read = await readXunleiFileList(tabId, options.links);
  if (!read.ok || !read.snapshot) {
    const message = read.message || '读取迅雷文件列表失败';
    if (!options.match.fallbackToDefault) {
      return {
        stage: 'match',
        ok: true,
        paused: { reason: 'file-list-timeout' },
        code: 'av-file-list-timeout',
        message: `未能读取迅雷文件列表，已暂停：${message}`,
        pathApplied,
      };
    }
    return finishWithoutMatch(
      tabId,
      options,
      `未能读取迅雷文件列表，已按迅雷原勾选继续：${message}`,
      undefined,
      pathApplied,
    );
  }

  const snapshot = read.snapshot;
  const plan = buildMatchPlan(snapshot, options.match, options.links);
  const summary = toMatchSummary(plan);
  const strict = !options.match.fallbackToDefault;

  if (plan.skipped) {
    if (plan.skipped === 'no-file-list') {
      return finishWithoutMatch(tabId, options, plan.summary, plan, pathApplied);
    }
    if (strict) {
      return {
        stage: 'match',
        ok: true,
        paused: { reason: 'file-list-timeout' },
        code: 'av-file-list-timeout',
        message: `${plan.summary}，已暂停`,
        match: summary,
        pathApplied,
      };
    }
    return finishWithoutMatch(
      tabId,
      options,
      `${plan.summary}；已按迅雷原勾选继续`,
      plan,
      pathApplied,
    );
  }

  if (strict && plan.status !== 'applied') {
    const applied = await applyPlanOrHandle(tabId, plan, snapshot, pathApplied, summary, false);
    if ('outcome' in applied) return applied.outcome;
    return {
      stage: 'match',
      ok: true,
      paused: { reason: 'unmatched' },
      code: 'av-unmatched',
      message: `${plan.summary}。未匹配任务已取消勾选，已停在迅雷弹窗，请手动检查后下载`,
      match: summary,
      pathApplied,
    };
  }

  if (!strict && plan.status === 'empty') {
    if (!snapshot.checkedIds.length) {
      return {
        stage: 'match',
        ok: true,
        paused: { reason: 'unmatched' },
        code: 'av-unmatched',
        message: `${plan.summary}；迅雷默认也没有勾选文件，已暂停`,
        match: summary,
        pathApplied,
      };
    }
    return finishWithoutMatch(
      tabId,
      options,
      `${plan.summary}；已保留迅雷原勾选继续`,
      plan,
      pathApplied,
    );
  }

  const applied = await applyPlanOrHandle(tabId, plan, snapshot, pathApplied, summary, !strict);
  if ('outcome' in applied) return applied.outcome;
  if (applied.warning) {
    return finishWithoutMatch(
      tabId,
      options,
      `${plan.summary}；${applied.warning}，已按迅雷原勾选继续`,
      undefined,
      pathApplied,
    );
  }
  if (applied.buttonDisabled) {
    return {
      stage: 'match',
      ok: false,
      code: 'av-selection-failed',
      message: '「立即下载」按钮不可用，请打开迅雷检查文件选择、磁盘空间或登录状态',
      match: summary,
      pathApplied,
    };
  }

  if (options.mode === 'confirm') {
    return {
      stage: 'done',
      ok: true,
      message: `${buildDoneMessage('confirm', pathApplied)}${matchSuffix(plan)}`,
      pathApplied,
      match: summary,
    };
  }

  const click = await execStep(tabId, 'confirm-download', {
    downloadPath: options.downloadPath,
    skipPath: '1',
  });
  if (!click.ok) {
    return {
      stage: 'confirm-download',
      ok: false,
      code: click.code,
      message: click.message,
      pathApplied: click.pathApplied ?? pathApplied,
      match: summary,
    };
  }
  const taskIds = (click.data as { taskIds?: unknown } | undefined)?.taskIds;
  return {
    stage: 'done',
    ok: true,
    message: `${buildDoneMessage('immediate', click.pathApplied ?? pathApplied)}${matchSuffix(plan)}`,
    pathApplied: click.pathApplied ?? pathApplied,
    taskIds: Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === 'string') : undefined,
    match: summary,
  };
}

async function applyPlanOrHandle(
  tabId: number,
  plan: MatchPlan,
  snapshot: FileListSnapshot,
  pathApplied: PathApplied | undefined,
  summary: MatchSummary,
  fallback: boolean,
): Promise<{ buttonDisabled: boolean; warning?: string } | { outcome: SendOutcome }> {
  const result = await applyXunleiFileSelection(tabId, {
    treeHash: snapshot.treeHash,
    selectedIds: plan.selectedIds,
    preserveRootIds: plan.preserveRootIds,
  });

  if (result.ok && result.applied && result.parentSynced) {
    return { buttonDisabled: Boolean(result.buttonDisabled) };
  }

  if (!result.attempted) {
    if (result.stale) {
      return {
        outcome: {
          stage: 'match',
          ok: true,
          paused: { reason: 'file-list-timeout' },
          code: 'av-file-list-timeout',
          message: `${result.message || '文件树在匹配期间发生变化'}，已暂停，请打开迅雷手动处理`,
          match: summary,
          pathApplied,
        },
      };
    }
    if (fallback) {
      return {
        buttonDisabled: false,
        warning: result.message || '无法应用文件勾选',
      };
    }
    return {
      outcome: {
        stage: 'match',
        ok: true,
        paused: { reason: 'file-list-timeout' },
        code: 'av-file-list-timeout',
        message: `${result.message || '无法应用文件勾选'}，已暂停，请打开迅雷手动处理`,
        match: summary,
        pathApplied,
      },
    };
  }

  return {
    outcome: {
      stage: 'match',
      ok: false,
      code: 'av-selection-failed',
      message: result.message || '应用文件勾选失败，已停止点击下载',
      match: summary,
      pathApplied,
    },
  };
}

async function finishWithoutMatch(
  tabId: number,
  options: SendOptions,
  prefix: string,
  plan: MatchPlan | undefined,
  pathApplied: PathApplied | undefined,
): Promise<SendOutcome> {
  const summary = plan ? toMatchSummary(plan) : undefined;

  if (options.mode === 'confirm') {
    return {
      stage: 'done',
      ok: true,
      message: `${prefix}；${buildDoneMessage('confirm', pathApplied)}`,
      pathApplied,
      match: summary,
    };
  }

  const click = await execStep(tabId, 'confirm-download', {
    downloadPath: options.downloadPath,
    skipPath: '1',
  });
  if (!click.ok) {
    return {
      stage: 'confirm-download',
      ok: false,
      code: click.code,
      message: click.message,
      pathApplied: click.pathApplied ?? pathApplied,
      match: summary,
    };
  }
  const taskIds = (click.data as { taskIds?: unknown } | undefined)?.taskIds;
  return {
    stage: 'done',
    ok: true,
    message: `${prefix}；${buildDoneMessage('immediate', click.pathApplied ?? pathApplied)}`,
    pathApplied: click.pathApplied ?? pathApplied,
    taskIds: Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === 'string') : undefined,
    match: summary,
  };
}

async function refineStepError(tabId: number, result: StepResult): Promise<StepResult> {
  if (
    result.code &&
    !['panel-not-ready', 'injection-failed', 'unknown'].includes(result.code)
  ) {
    return result;
  }
  const probe = await inspectXunleiPage(tabId);
  const code = classifyProbe(probe);
  if (!code) return result;
  return { ok: false, code, message: probeMessage(code, probe, result.message) };
}

export function probeMessage(
  code: SendErrorCode,
  probe: PageProbe | null,
  fallback: string,
): string {
  switch (code) {
    case 'nas-unreachable':
      return probe?.errorText
        ? `无法访问 NAS 迅雷页面：${probe.errorText}`
        : '无法访问 NAS 迅雷页面，请检查地址与网络';
    case 'login-required':
      return '迅雷页面需要登录，请在迅雷页面完成登录后重试';
    case 'page-mismatch':
      return '当前页面不是迅雷下载面板，请检查地址或套件版本';
    case 'panel-not-ready':
      return '迅雷下载面板尚未就绪，请回到下载首页后重试';
    default:
      return fallback;
  }
}

function buildDoneMessage(mode: DownloadMode, pathApplied?: PathApplied): string {
  if (!pathApplied?.needed) {
    return mode === 'confirm' ? '链接已解析完成，请在迅雷页面确认下载' : '任务已发送并开始下载';
  }
  if (pathApplied.applied) {
    const path = pathApplied.resolvedPath ? ` ${pathApplied.resolvedPath}` : '';
    return mode === 'confirm'
      ? `链接已解析完成，已预选保存路径${path}，请在迅雷页面确认`
      : `任务已发送并开始下载（保存到${path || '指定目录'}）`;
  }
  const reason = pathApplied.reason ? `：${pathApplied.reason}` : '';
  return mode === 'confirm'
    ? `链接已解析完成，但未能应用保存路径${reason}，请在迅雷页面手动选择后确认`
    : `任务已发送并开始下载（未能应用保存路径${reason}，已使用迅雷当前目录）`;
}

async function execStep(
  tabId: number,
  step: ExecStep,
  payload: Record<string, string>,
): Promise<StepResult> {
  try {
    // 路径预选、目录读取、任务读取要访问页面主世界的 Vuex（__vue_app__），必须注入 MAIN world；
    // 其余步骤只操作 DOM，留在隔离世界即可。
    const needsPageWorld =
      step === 'confirm-download' ||
      step === 'wait-dialog' ||
      step === 'check-path' ||
      step === 'list-dir';
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedRunStep,
      args: [step, payload, XUNLEI_SELECTORS, STEP_TIMEOUT_MS],
      world: needsPageWorld ? 'MAIN' : 'ISOLATED',
    });
    const result = results[0]?.result as StepResult | undefined;
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, code: 'injection-failed', message: '注入脚本未返回有效结果' };
    }
    return result;
  } catch (error) {
    const message = (error as Error).message || '注入迅雷页面脚本失败';
    return {
      ok: false,
      code: classifyInjectionError(message),
      message: `注入迅雷页面脚本失败：${message}`,
    };
  }
}

/**
 * 检查迅雷页面是否可访问、是否登录、下载面板是否就绪。
 * 只读，不点击任何元素。
 */
export async function inspectXunleiPage(tabId: number): Promise<PageProbe | null> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  const tabUrl = tab.url ?? '';
  if (tabUrl.startsWith('chrome-error://') || tabUrl.startsWith('edge-error://')) {
    return {
      reachable: false,
      url: tabUrl,
      title: tab.title ?? '',
      hasApp: false,
      hasStore: false,
      loggedIn: false,
      hasCreateTask: false,
      hasLoginForm: false,
      loginText: false,
      errorText: '页面不可达',
      hasResultDialog: false,
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedProbe,
      args: [XUNLEI_SELECTORS],
      world: 'MAIN',
    });
    const probe = results[0]?.result as Omit<PageProbe, 'reachable'> | undefined;
    if (!probe) {
      return {
        reachable: true,
        url: tabUrl,
        title: tab.title ?? '',
        hasApp: false,
        hasStore: false,
        loggedIn: false,
        hasCreateTask: false,
        hasLoginForm: false,
        loginText: false,
        errorText: '',
        hasResultDialog: false,
        injectionError: '注入脚本未返回有效结果',
      };
    }
    return { reachable: true, ...probe };
  } catch (error) {
    return {
      reachable: true,
      url: tabUrl,
      title: tab.title ?? '',
      hasApp: false,
      hasStore: false,
      loggedIn: false,
      hasCreateTask: false,
      hasLoginForm: false,
      loginText: false,
      errorText: '',
      hasResultDialog: false,
      injectionError: (error as Error).message,
    };
  }
}

/** 把页面探针结果映射为错误码；返回 null 表示页面可继续发送 */
export function classifyProbe(probe: PageProbe | null): SendErrorCode | null {
  if (!probe) return 'injection-failed';
  if (!probe.reachable) return 'nas-unreachable';
  if (probe.errorText) return 'nas-unreachable';
  if (probe.injectionError) {
    if (/showing error page|ERR_[A-Z_]+|net::/i.test(probe.injectionError)) {
      return 'nas-unreachable';
    }
    if (/Cannot access a chrome|chrome:\/\//i.test(probe.injectionError)) return 'page-mismatch';
    if (!probe.hasApp && !probe.hasStore) return 'injection-failed';
  }
  const loginSignals = probe.hasLoginForm || probe.loginText;
  if (loginSignals && !probe.hasCreateTask) return 'login-required';
  if (!probe.hasApp || !probe.hasStore) return loginSignals ? 'login-required' : 'page-mismatch';
  if (!probe.hasCreateTask) return loginSignals ? 'login-required' : 'panel-not-ready';
  return null;
}

/** 只读检查默认路径是否存在且可写；不修改面板当前目录 */
export async function checkDownloadPath(
  tabId: number,
  downloadPath: string,
): Promise<PathApplied | null> {
  if (!downloadPath.trim()) return { needed: false, applied: false };
  const result = await execStep(tabId, 'check-path', { downloadPath });
  if (!result.ok) {
    return { needed: true, applied: false, reason: result.message };
  }
  return result.pathApplied ?? { needed: true, applied: false, reason: '未返回目录检查结果' };
}

/** 读取迅雷目录树的一层；parentId 为空时返回根目录 */
export async function listXunleiDir(
  tabId: number,
  parentId = '',
  parentPath = '',
): Promise<{ ok: boolean; items: DirItem[]; code?: SendErrorCode; message?: string }> {
  const result = await execStep(tabId, 'list-dir', { parentId, parentPath });
  if (!result.ok) {
    return { ok: false, items: [], code: result.code, message: result.message };
  }
  const items = Array.isArray(result.data) ? (result.data as DirItem[]) : [];
  return { ok: true, items };
}

/**
 * 只读读取当前解析弹窗的文件树。不点击、不修改勾选；
 * 非 BT 任务（没有文件树）返回 kind='single'。
 */
export async function readXunleiFileList(
  tabId: number,
  links: string[] = [],
  requireVisible = true,
): Promise<ReadFileListResult> {
  try {
    const injection = chrome.scripting.executeScript({
      target: { tabId },
      func: injectedReadFileList,
      args: [XUNLEI_SELECTORS, links, requireVisible],
      world: 'MAIN',
    });
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 20_000);
    });
    const results = await Promise.race([injection, timeout]);
    if (!results) return { ok: false, message: '读取迅雷文件列表超时' };
    const result = results[0]?.result as ReadFileListResult | undefined;
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, message: '注入脚本未返回有效结果' };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      message: `读取迅雷文件列表失败：${(error as Error).message}`,
    };
  }
}

/**
 * 应用勾选计划：调用面板自身的树组件 setCheckedKeys，不伪造 change 事件、不点 DOM 复选框。
 * 树结构变化（hash 不一致）时不修改任何状态。
 */
export async function applyXunleiFileSelection(
  tabId: number,
  plan: ApplySelectionPlan,
): Promise<ApplySelectionResult> {
  try {
    const injection = chrome.scripting.executeScript({
      target: { tabId },
      func: injectedApplyFileSelection,
      args: [XUNLEI_SELECTORS, plan],
      world: 'MAIN',
    });
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 8_000);
    });
    const results = await Promise.race([injection, timeout]);
    if (!results) return { ok: false, message: '应用文件勾选超时', attempted: true };
    const result = results[0]?.result as ApplySelectionResult | undefined;
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, message: '注入脚本未返回有效结果', attempted: true };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      message: `应用文件勾选失败：${(error as Error).message}`,
      attempted: true,
    };
  }
}

/**
 * 读取任务列表快照。currentIds 包含 tasks/tasksDone/all 的并集；
 * refresh=true 时对最多 3 个非终态 tracked id 调用面板自身的 drive/getTask。
 */
export async function readTaskState(
  tabId: number,
  trackedIds: string[] = [],
  refresh = true,
): Promise<TaskStateSnapshot | null> {
  try {
    const injection = chrome.scripting.executeScript({
      target: { tabId },
      func: injectedReadTasks,
      args: [trackedIds, refresh],
      world: 'MAIN',
    });
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 8_000);
    });
    const results = await Promise.race([injection, timeout]);
    if (!results) return null;
    return (results[0]?.result as TaskStateSnapshot | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * 注入页面执行的探针（自包含，勿引用外部作用域）。
 */
async function injectedProbe(selectors: typeof XUNLEI_SELECTORS) {
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    const node = el as HTMLElement;
    return node.offsetParent !== null || node.getBoundingClientRect().width > 0;
  };

  const readState = () => {
    const app = document.querySelector('#app') as any;
    const store = app?.__vue_app__?.config?.globalProperties?.$store;
    const hasCreateTask = Boolean(document.querySelector(selectors.createTaskButton));
    const bodyText = (document.body?.innerText || '').slice(0, 6000);
    const hasLoginForm = isVisible(document.querySelector(selectors.loginForm));
    const loginText = /(扫码登录|账号登录|登录迅雷|请先登录)/.test(bodyText);
    return { store, hasCreateTask, bodyText, hasLoginForm, loginText };
  };

  // 刷新后 Vue 挂载与「新建任务」渲染都可能晚于 load complete；
  // 耐心等按钮就绪，不要因页面启动瞬间的登录文案提前判定未登录。
  let state = readState();
  for (let i = 0; i < 20; i++) {
    if (state.store && state.hasCreateTask) break;
    if (i < 19) await sleep(500);
    state = readState();
  }

  const { store, hasCreateTask, bodyText, hasLoginForm, loginText } = state;
  const dialog = document.querySelector(selectors.taskDialog) as HTMLElement | null;
  const dialogVisible = Boolean(
    dialog && (dialog.offsetParent !== null || dialog.getBoundingClientRect().width > 0),
  );
  const errorMatch = bodyText.match(
    /(无法访问此网站|连接已重置|ERR_[A-Z_]+|This site can’t be reached)/,
  );

  return {
    url: location.href,
    title: document.title,
    hasApp: Boolean(document.querySelector('#app')),
    hasStore: Boolean(store),
    loggedIn: Boolean(store?.state?.user?.userInfo?.target),
    hasCreateTask,
    hasLoginForm,
    loginText,
    errorText: errorMatch?.[0] ?? '',
    hasResultDialog: dialogVisible,
  };
}

/**
 * 注入页面读取 BT 文件树（自包含，勿引用外部作用域）。
 * 只读：不点击、不修改勾选；非 BT 任务返回 kind='single'。
 */
async function injectedReadFileList(
  selectors: typeof XUNLEI_SELECTORS,
  links: string[],
  requireVisible: boolean,
): Promise<ReadFileListResult> {
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    const node = el as HTMLElement;
    return node.offsetParent !== null || node.getBoundingClientRect().width > 0;
  };
  const findDialog = (): HTMLElement | null => {
    const nodes = Array.from(document.querySelectorAll(selectors.taskDialog)) as HTMLElement[];
    if (!nodes.length) return null;
    const visible = nodes.filter(isVisible);
    if (visible.length) return visible[visible.length - 1] ?? null;
    return requireVisible ? null : nodes[nodes.length - 1] ?? null;
  };
  const hash = (text: string): string => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  };
  const findDownloadButton = (dialog: HTMLElement): HTMLButtonElement | null => {
    const buttons = Array.from(
      dialog.querySelectorAll(selectors.parseButton),
    ) as HTMLButtonElement[];
    return (
      buttons.find((button) => (button.textContent || '').includes('立即下载')) ??
      buttons[buttons.length - 1] ??
      null
    );
  };
  const isButtonDisabled = (button: HTMLButtonElement | null): boolean => {
    if (!button) return true;
    return (
      Boolean(button.disabled) ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.classList.contains('is-disabled') ||
      button.classList.contains('disabled')
    );
  };

  const debugParts: string[] = [];
  const debug = () => debugParts.join('; ');

  let dialog = findDialog();
  for (let i = 0; !dialog && i < 12; i++) {
    await sleep(250);
    dialog = findDialog();
  }
  if (!dialog) {
    return {
      ok: false,
      message: '未找到迅雷解析弹窗，请先在迅雷页面解析一个磁力/种子',
      debug: 'dialog=0',
    };
  }
  debugParts.push('dialog=1');

  const findDialogComponent = (): any => {
    let inst = (dialog as any).__vueParentComponent;
    for (let depth = 0; inst && depth < 16; depth++) {
      const vm = inst.proxy || inst.ctx || inst;
      if (vm && Array.isArray(vm.taskAddUrls)) return vm;
      inst = inst.parent;
    }
    return null;
  };
  const dialogVm = findDialogComponent();
  const taskUrls = Array.isArray(dialogVm?.taskAddUrls)
    ? dialogVm.taskAddUrls.map((url: any) => String(url))
    : [];
  const hasBtFlag =
    typeof dialogVm?.isBtSingletask === 'boolean' || typeof dialogVm?.isBatchTask === 'boolean';
  const inputLooksBt = links.some(
    (link) => /^magnet:/i.test(link) || /\.torrent(?:$|[?#])/i.test(link),
  );
  const looksBt = hasBtFlag
    ? Boolean(dialogVm.isBtSingletask || dialogVm.isBatchTask)
    : inputLooksBt;
  const knownNonBt = hasBtFlag
    ? !looksBt
    : links.length > 0 &&
      !inputLooksBt &&
      !links.some((link) => /^thunder:/i.test(link));

  let treeRoot = dialog.querySelector(selectors.fileTree) as HTMLElement | null;
  const treeWaitTicks = knownNonBt ? 12 : 32;
  for (let i = 0; !treeRoot && i < treeWaitTicks; i++) {
    await sleep(250);
    dialog = findDialog() ?? dialog;
    treeRoot = dialog.querySelector(selectors.fileTree) as HTMLElement | null;
  }
  if (!treeRoot) {
    // 只有确认是非 BT 任务才按直链跳过；BT/未知一律暂停，避免把慢种子当直链全下
    if (!knownNonBt) {
      return {
        ok: false,
        message: '文件树尚未就绪，请稍后重试',
        debug: debug() + `;tree=0;looksBt=${looksBt ? 1 : 0};knownNonBt=0`,
      };
    }
    return {
      ok: true,
      snapshot: {
        kind: 'single',
        treeHash: '',
        groups: [],
        checkedIds: [],
        buttonDisabled: isButtonDisabled(findDownloadButton(dialog)),
        truncated: false,
      },
      debug: debug() + ';tree=0;kind=single',
    };
  }
  debugParts.push('tree=1');

  const MAX_LEAVES = 5000;
  let btVm: any = null;
  let parentVm: any = null;
  let treeData: any[] = [];

  const discover = (): boolean => {
    btVm = null;
    parentVm = null;
    treeData = [];
    dialog = findDialog() ?? dialog;
    treeRoot = dialog?.querySelector(selectors.fileTree) as HTMLElement | null;
    if (!treeRoot) return false;
    const treeEl = (treeRoot.querySelector('.el-tree') ?? dialog?.querySelector('.el-tree')) as any;
    if (!treeEl) return false;
    let inst = treeEl.__vueParentComponent;
    for (let depth = 0; inst && depth < 16; depth++) {
      const vm = inst.proxy || inst.ctx || inst;
      if (
        vm &&
        !btVm &&
        typeof vm.setCheckedKeys === 'function' &&
        typeof vm.getCheckedKeys === 'function'
      ) {
        btVm = vm;
      }
      if (
        btVm &&
        vm &&
        vm !== btVm &&
        Array.isArray(vm.treeData) &&
        (typeof vm.handelBtSelectChange === 'function' || Array.isArray(vm.flatNodeList))
      ) {
        parentVm = vm;
        treeData = vm.treeData;
        break;
      }
      inst = inst.parent;
    }
    return Boolean(btVm && parentVm && treeData.length > 0);
  };

  let ready = false;
  for (let i = 0; i < 20; i++) {
    if (discover()) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!btVm || !parentVm) {
    return {
      ok: false,
      message: '无法读取迅雷文件树组件，迅雷页面可能已更新',
      debug: debug() + ';component=0',
    };
  }
  debugParts.push('component=1');
  if (!ready || !treeData.length) {
    return {
      ok: false,
      message: '迅雷文件树为空，解析可能尚未完成',
      debug: debug() + ';roots=0',
    };
  }

  const groups: SnapshotGroup[] = [];
  let leafCount = 0;
  let truncated = false;
  let missingId = false;

  for (let index = 0; index < treeData.length; index++) {
    if (truncated) break;
    const root = treeData[index];
    if (!root || typeof root !== 'object') continue;
    const rootId = root.id == null ? '' : String(root.id);
    if (!rootId) missingId = true;
    const rootName = String(root.label || root.name || '');
    const files: SnapshotFile[] = [];

    const walk = (node: any, ancestors: string[]): void => {
      if (truncated || !node || typeof node !== 'object') return;
      const name = String(node.label || node.name || '');
      // 根节点是任务名，不拼进文件 path，否则根名里的番号会让所有文件恒命中
      const parts =
        node === root && node.is_dir ? ancestors : name ? [...ancestors, name] : ancestors;
      if (!node.is_dir && name) {
        leafCount += 1;
        if (leafCount > MAX_LEAVES) {
          truncated = true;
          return;
        }
        const id = node.id == null ? '' : String(node.id);
        if (!id) missingId = true;
        files.push({
          id,
          name,
          path: parts.join('/'),
          size: Number(node.file_size) || 0,
        });
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        if (truncated) break;
        walk(child, parts);
      }
    };
    walk(root, []);
    groups.push({ rootId: rootId || `root-${index}`, rootName, files });
  }

  if (missingId) {
    return {
      ok: false,
      message: '文件节点缺少 id，无法安全勾选',
      debug: debug() + ';missingId=1',
    };
  }

  const buttonDisabled = isButtonDisabled(findDownloadButton(dialog));
  if (truncated) {
    return {
      ok: true,
      snapshot: {
        kind: 'bt',
        treeHash: '',
        groups: [],
        checkedIds: [],
        buttonDisabled,
        truncated: true,
      },
      debug: debug() + `;leaves>${MAX_LEAVES}`,
    };
  }

  const leafIds = new Set<string>();
  for (const group of groups) {
    for (const file of group.files) leafIds.add(file.id);
  }
  let checkedIds: string[] = [];
  try {
    const keys = btVm.getCheckedKeys?.();
    if (Array.isArray(keys)) {
      checkedIds = keys
        .map((key: any) => String(key))
        .filter((id: string) => leafIds.has(id));
    }
    if (!checkedIds.length && typeof btVm.getChecked === 'function') {
      checkedIds = (btVm.getChecked() || [])
        .filter((node: any) => node && !node.is_dir)
        .map((node: any) => String(node.id))
        .filter((id: string) => leafIds.has(id));
    }
  } catch {
    /* 读取勾选失败不影响快照 */
  }

  const signature = groups
    .map((group) => `${group.rootId}|${group.files.map((file) => file.id).join(',')}`)
    .join(';');
  const treeHash = hash(`${signature}|${[...checkedIds].sort().join(',')}`);

  return {
    ok: true,
    snapshot: {
      kind: 'bt',
      treeHash,
      groups,
      checkedIds,
      buttonDisabled,
      truncated: false,
    },
    debug: debug() + `;roots=${groups.length};leaves=${leafIds.size}`,
  };
}

/**
 * 注入页面应用勾选计划（自包含，勿引用外部作用域）。
 * 只在树 hash 与读取时一致时修改；修改后校验父组件计数与按钮状态。
 */
async function injectedApplyFileSelection(
  selectors: typeof XUNLEI_SELECTORS,
  plan: ApplySelectionPlan,
): Promise<ApplySelectionResult> {
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    const node = el as HTMLElement;
    return node.offsetParent !== null || node.getBoundingClientRect().width > 0;
  };
  const findDialog = (): HTMLElement | null => {
    const nodes = Array.from(document.querySelectorAll(selectors.taskDialog)) as HTMLElement[];
    if (!nodes.length) return null;
    const visible = nodes.filter(isVisible);
    return visible[visible.length - 1] ?? null;
  };
  const findDownloadButton = (dialog: HTMLElement): HTMLButtonElement | null => {
    const buttons = Array.from(
      dialog.querySelectorAll(selectors.parseButton),
    ) as HTMLButtonElement[];
    return (
      buttons.find((button) => (button.textContent || '').includes('立即下载')) ??
      buttons[buttons.length - 1] ??
      null
    );
  };
  const isButtonDisabled = (button: HTMLButtonElement | null): boolean => {
    if (!button) return true;
    return (
      Boolean(button.disabled) ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.classList.contains('is-disabled') ||
      button.classList.contains('disabled')
    );
  };
  const hash = (text: string): string => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  };

  let dialog = findDialog();
  if (!dialog) return { ok: false, message: '未找到迅雷解析弹窗', attempted: false };

  let btVm: any = null;
  let parentVm: any = null;
  let treeData: any[] = [];

  const discover = (): boolean => {
    btVm = null;
    parentVm = null;
    treeData = [];
    dialog = findDialog() ?? dialog;
    const treeRoot = dialog?.querySelector(selectors.fileTree) as HTMLElement | null;
    if (!treeRoot) return false;
    const treeEl = (treeRoot.querySelector('.el-tree') ?? dialog?.querySelector('.el-tree')) as any;
    if (!treeEl) return false;
    let inst = treeEl.__vueParentComponent;
    for (let depth = 0; inst && depth < 16; depth++) {
      const vm = inst.proxy || inst.ctx || inst;
      if (
        vm &&
        !btVm &&
        typeof vm.setCheckedKeys === 'function' &&
        typeof vm.getCheckedKeys === 'function'
      ) {
        btVm = vm;
      }
      if (
        btVm &&
        vm &&
        vm !== btVm &&
        Array.isArray(vm.treeData) &&
        (typeof vm.handelBtSelectChange === 'function' || Array.isArray(vm.flatNodeList))
      ) {
        parentVm = vm;
        treeData = vm.treeData;
        break;
      }
      inst = inst.parent;
    }
    return Boolean(btVm && parentVm && treeData.length > 0);
  };

  let ready = false;
  for (let i = 0; i < 8; i++) {
    if (discover()) {
      ready = true;
      break;
    }
    await sleep(100);
  }
  if (!ready || !btVm || !parentVm || !treeData.length) {
    return { ok: false, message: '无法读取迅雷文件树组件', attempted: false };
  }

  const groups: Array<{ rootId: string; files: string[] }> = [];
  const leafIds = new Set<string>();
  const leafRoot = new Map<string, string>();
  const idByString = new Map<string, any>();

  for (let index = 0; index < treeData.length; index++) {
    const root = treeData[index];
    if (!root || typeof root !== 'object') continue;
    const rootId = root.id == null ? `root-${index}` : String(root.id);
    const ids: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (!node.is_dir && node.id != null) {
        const id = String(node.id);
        ids.push(id);
        leafIds.add(id);
        leafRoot.set(id, rootId);
        idByString.set(id, node.id);
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) walk(child);
    };
    walk(root);
    groups.push({ rootId, files: ids });
  }

  const readCheckedIds = (): string[] => {
    try {
      const keys = btVm.getCheckedKeys?.();
      if (Array.isArray(keys)) {
        const ids = keys.map((key: any) => String(key)).filter((id: string) => leafIds.has(id));
        if (ids.length) return ids;
      }
      return (btVm.getChecked() || [])
        .filter((node: any) => node && !node.is_dir)
        .map((node: any) => String(node.id))
        .filter((id: string) => leafIds.has(id));
    } catch {
      return [];
    }
  };

  const currentChecked = readCheckedIds();
  const signature = groups
    .map((group) => `${group.rootId}|${group.files.join(',')}`)
    .join(';');
  const currentHash = hash(`${signature}|${[...currentChecked].sort().join(',')}`);
  if (currentHash !== plan.treeHash) {
    return {
      ok: false,
      attempted: false,
      stale: true,
      message: '文件树在匹配期间发生变化，请重试',
      debug: `hash ${currentHash} != ${plan.treeHash}`,
    };
  }

  const missingSelected = plan.selectedIds.filter((id) => !leafIds.has(id));
  if (missingSelected.length) {
    return {
      ok: false,
      attempted: false,
      stale: true,
      message: `有 ${missingSelected.length} 个文件已不存在`,
      debug: 'missingSelected=1',
    };
  }

  const preserve = new Set(plan.preserveRootIds);
  const finalIds = new Set(plan.selectedIds);
  for (const id of currentChecked) {
    const rootId = leafRoot.get(id);
    if (rootId && preserve.has(rootId)) finalIds.add(id);
  }

  // 传回原始 id 类型，避免数字 id 被字符串化后 setCheckedKeys 命中不到
  const finalKeys = [...finalIds].map((id) => idByString.get(id) ?? id);
  btVm.setCheckedKeys(finalKeys);
  await sleep(30);

  const checkedNodes: any[] = (btVm.getChecked() || []).filter(
    (node: any) => node && !node.is_dir,
  );
  const checkedIds: string[] = checkedNodes.map((node: any) => String(node.id));
  const checkedSet = new Set(checkedIds);
  const missing = [...finalIds].filter((id) => !checkedSet.has(id));
  const extra = checkedIds.filter((id) => !finalIds.has(id));
  const applied = missing.length === 0 && extra.length === 0;

  const readParentIds = (): Set<string> | null => {
    const collect = (list: any): Set<string> | null => {
      if (!Array.isArray(list)) return null;
      return new Set(
        list
          .filter((node: any) => node && !node.is_dir && node.id != null)
          .map((node: any) => String(node.id)),
      );
    };
    const fromResource = collect(parentVm.computedCheckedResource);
    if (fromResource) return fromResource;
    return collect(parentVm.checkedSource);
  };
  const sameIdSet = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((id) => b.has(id));

  let parentIds = readParentIds();
  let parentSynced = parentIds ? sameIdSet(parentIds, checkedSet) : false;
  if (!parentSynced && typeof parentVm.handelBtSelectChange === 'function') {
    try {
      parentVm.handelBtSelectChange(btVm.getChecked());
      await sleep(30);
      parentIds = readParentIds();
      parentSynced = parentIds ? sameIdSet(parentIds, checkedSet) : false;
    } catch {
      /* ignore */
    }
  }

  const buttonDisabled = isButtonDisabled(findDownloadButton(dialog));
  return {
    ok: applied && parentSynced,
    attempted: true,
    applied,
    parentSynced,
    buttonDisabled,
    checkedCount: checkedSet.size,
    stale: false,
    message: applied && parentSynced ? '文件勾选已应用' : '文件勾选未能完全同步',
    debug: `selected=${finalIds.size};checked=${checkedSet.size};parent=${
      parentIds ? parentIds.size : 'unknown'
    }`,
  };
}

/**
 * 注入页面读取任务快照（自包含，勿引用外部作用域）。
 */
async function injectedReadTasks(trackedIds: string[], refresh: boolean) {
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const store: any = (document.querySelector('#app') as any)?.__vue_app__?.config
    ?.globalProperties?.$store;
  const drive = store?.state?.drive;
  if (!drive) return null;

  const asList = (value: any): any[] =>
    Array.isArray(value) ? value : value && Array.isArray(value.list) ? value.list : [];

  const collectIds = (): string[] => {
    const ids = new Set<string>();
    const items = [
      ...asList(drive.tasks),
      ...asList(drive.tasksDone),
      ...Object.keys(drive.all || {}),
    ];
    for (const item of items) {
      if (typeof item === 'string') ids.add(item);
      else if (item && typeof item.id === 'string') ids.add(item.id);
    }
    return [...ids];
  };

  const tasks: Record<
    string,
    {
      id: string;
      name: string;
      phase: string;
      progress?: number;
      detail?: string;
      type?: string;
    }
  > = {};

  const put = (id: string, task: any) => {
    if (!task || typeof task !== 'object') return;
    tasks[id] = {
      id,
      name: String(task.name || task.file_name || task.params?.name || ''),
      phase: String(task.phase || task.params?.phase || '').toUpperCase(),
      progress: Number(task.progress ?? task.params?.progress ?? 0) || 0,
      detail: String(
        task.error_description ||
          task.error_message ||
          task.message ||
          task.params?.error_description ||
          task.params?.message ||
          '',
      ),
      type: String(task.type || ''),
    };
  };

  let currentIds = collectIds();
  for (const id of currentIds) put(id, drive.all?.[id]);

  if (refresh) {
    const targets = trackedIds
      .filter((id) => {
        const item = tasks[id];
        return !item || !/^PHASE_TYPE_(COMPLETE|ERROR)$/.test(item.phase);
      })
      .slice(0, 3);
    for (const id of targets) {
      try {
        await store.dispatch('drive/getTask', { task_id: id });
        await sleep(150);
        put(id, store.state.drive.all?.[id] ?? drive.all?.[id]);
      } catch {
        /* 单个任务刷新失败不影响其它任务 */
      }
    }
    currentIds = collectIds();
    for (const id of currentIds) {
      if (!tasks[id]) put(id, store.state.drive.all?.[id] ?? drive.all?.[id]);
    }
  }

  return { currentIds, tasks };
}

/**
 * 注入页面执行的步骤函数（自包含，勿引用外部作用域）。
 */
async function injectedRunStep(
  step: ExecStep,
  payload: Record<string, string>,
  selectors: typeof XUNLEI_SELECTORS,
  timeoutMs: number,
): Promise<StepResult> {
  class StepError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'StepError';
      this.code = code;
    }
  }

  const PARSE_ERROR_PATTERN =
    /(解析失败|链接无效|链接已失效|无法解析|不支持该链接|下载地址无效|任务创建失败)/;

  /** 等待匹配元素出现（MutationObserver + 超时 reject） */
  function waitElement<T extends HTMLElement = HTMLElement>(selector: string, text?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const hit = queryOnce();
      if (hit) return resolve(hit);
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素超时：${selector}${text ? `（文本含“${text}”）` : ''}`));
      }, timeoutMs);
      const observer = new MutationObserver(() => {
        const el = queryOnce();
        if (el) {
          observer.disconnect();
          window.clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      function queryOnce(): T | null {
        const nodes = Array.from(document.querySelectorAll<T>(selector));
        const filtered = text ? nodes.filter((n) => (n.textContent || '').includes(text)) : nodes;
        return filtered[0] ?? null;
      }
    });
  }

  /** 轮询等待条件成立（用于按钮文本变化等非 DOM 出现型状态） */
  async function waitFor<T>(probe: () => T | null, onTick?: () => void): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      onTick?.();
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) {
        throw new StepError('parse-timeout', '等待解析结果超时');
      }
      await new Promise((r) => window.setTimeout(r, 200));
    }
  }

  function isVisibleElement(el: Element | null): boolean {
    if (!el) return false;
    const node = el as HTMLElement;
    return node.offsetParent !== null || node.getBoundingClientRect().width > 0;
  }

  // 读取/应用与点击必须指向同一个可见结果弹窗，避免隐藏的旧弹窗抢到点击
  async function waitVisibleDialog(): Promise<HTMLElement> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const dialogs = Array.from(document.querySelectorAll(selectors.taskDialog)) as HTMLElement[];
      const visible = dialogs.filter(isVisibleElement);
      if (visible.length) return visible[visible.length - 1];
      if (Date.now() > deadline) {
        throw new StepError('parse-timeout', '等待解析结果超时');
      }
      await new Promise((r) => window.setTimeout(r, 100));
    }
  }

  function setTextValue(el: HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 迅雷面板的 Vuex store（目录选择保存在 drive.treeNodeId/treeNodePath） */
  function getPanelStore(): any {
    const root = document.querySelector('#app') as any;
    return root?.__vue_app__?.config?.globalProperties?.$store ?? null;
  }

  function normalizePath(value: string): string {
    const parts = (value || '').trim().replace(/\\/g, '/').split('/').filter(Boolean);
    return '/' + parts.join('/');
  }

  function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(message)), Math.min(timeoutMs, 8_000));
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function waitPanelStore(): Promise<any | null> {
    const deadline = Date.now() + Math.min(timeoutMs, 3_000);
    for (;;) {
      const store = getPanelStore();
      if (store?.state?.drive && store?.state?.user?.userInfo?.target) return store;
      if (Date.now() > deadline) return null;
      await new Promise((r) => window.setTimeout(r, 100));
    }
  }

  async function listFolders(store: any, parentId: string): Promise<any[]> {
    const space = store.state.user.userInfo.target;
    const folders: any[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const result = await withTimeout<any>(
        store.dispatch('drive/loadFolders', {
          space,
          parent_id: parentId,
          limit: 200,
          filters: JSON.stringify({ kind: { eq: 'drive#folder' } }),
          page_token: pageToken,
        }),
        '读取迅雷目录超时',
      );
      folders.push(...(Array.isArray(result?.files) ? result.files : []));
      pageToken = result?.next_page_token || '';
      if (!pageToken) break;
    }
    return folders;
  }

  function clearPanelPath(store: any): void {
    try {
      store.commit('drive/update', { treeNodeId: '', treeNodePath: '', treeNodeName: '' });
    } catch {
      /* 清理失败只影响回退目录，不阻断发送 */
    }
  }

  /**
   * 把配置的保存路径解析为迅雷目录树中的节点。
   * commit=false 时只读检查，不修改面板当前目录；commit=true 时写入并校验。
   */
  async function resolveDownloadPath(path: string, commit: boolean): Promise<PathApplied> {
    const raw = (path || '').trim();
    if (!raw) return { needed: false, applied: false };

    const fail = (reason: string): PathApplied => {
      if (commit) {
        const store = getPanelStore();
        if (store) clearPanelPath(store);
      }
      return { needed: true, applied: false, reason };
    };

    try {
      const store = await waitPanelStore();
      if (!store) return fail('无法读取迅雷页面状态');

      const target = normalizePath(raw);
      if (target === '/') return fail('不能使用根目录');

      const rootsLoaded =
        Array.isArray(store.state.drive.rootDiskSelectList) &&
        store.state.drive.rootDiskSelectList.length > 0;
      if (!rootsLoaded) {
        await withTimeout(store.dispatch('drive/getFolderList'), '读取迅雷下载目录超时');
      }
      const roots: any[] = Array.isArray(store.state.drive.rootDiskSelectList)
        ? store.state.drive.rootDiskSelectList
        : [];
      if (!roots.length) return fail('未读取到迅雷下载目录');

      const root = roots
        .map((item) => ({ item, path: normalizePath(item?.path || '') }))
        .filter(({ path }) => path && (target === path || target.startsWith(`${path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!root) return fail(`目录不在迅雷可用的下载目录中：${target}`);

      let currentId = root.item.id as string;
      let currentPath = root.path;
      // 面板自身的 treeNodePath 带结尾斜杠，保留它可让路径显示、磁盘空间匹配与手动选择一致
      let currentRealPath = (root.item.path || root.path) as string;
      let currentName = (root.item.title || '') as string;
      const rest = target
        .slice(currentPath.length)
        .split('/')
        .filter(Boolean);

      for (const segment of rest) {
        const children = await listFolders(store, currentId);
        const next =
          children.find(
            (folder) => normalizePath(folder?.params?.RealPath || '') === `${currentPath}/${segment}`,
          ) ?? children.find((folder) => folder?.name === segment);
        if (!next) return fail(`迅雷中不存在目录：${target}`);
        const writable = next.params?.is_write;
        if (writable === false || writable === 'false') return fail(`目录不可写：${target}`);
        currentId = next.id;
        currentRealPath = next.params?.RealPath || `${currentRealPath.replace(/\/+$/, '')}/${segment}/`;
        currentPath = normalizePath(currentRealPath);
        currentName = next.name || segment;
      }

      if (currentPath !== target) return fail(`迅雷中不存在目录：${target}`);

      if (!commit) {
        return { needed: true, applied: true, resolvedPath: target };
      }

      store.commit('drive/update', {
        treeNodeId: currentId,
        treeNodePath: currentRealPath,
        treeNodeName: currentName,
      });
      await new Promise((r) => window.setTimeout(r, 0));
      if (store.state.drive.treeNodeId !== currentId) return fail('写入迅雷目录选择失败');

      return { needed: true, applied: true, resolvedPath: target };
    } catch (error) {
      return fail((error as Error)?.message || '应用保存路径失败');
    }
  }

  function detectLogin(): boolean {
    if (document.querySelector(selectors.loginForm)) return true;
    if (document.querySelector(selectors.createTaskButton)) return false;
    const text = (document.body?.innerText || '').slice(0, 4000);
    return /(扫码登录|账号登录|登录迅雷|请先登录)/.test(text);
  }

  function findErrorToast(): string | null {
    const nodes = document.querySelectorAll<HTMLElement>(selectors.errorToast);
    for (const node of nodes) {
      const text = (node.textContent || '').trim();
      if (text && PARSE_ERROR_PATTERN.test(text)) return text.slice(0, 120);
    }
    const dialog = document.querySelector<HTMLElement>(selectors.taskDialog);
    if (dialog) {
      for (const node of dialog.querySelectorAll<HTMLElement>('[class*="error"], [class*="fail"]')) {
        const text = (node.textContent || '').trim();
        if (text && PARSE_ERROR_PATTERN.test(text)) return text.slice(0, 120);
      }
    }
    return null;
  }

  function collectTaskIds(): string[] {
    const store = getPanelStore();
    const drive = store?.state?.drive;
    const list = (value: any): any[] =>
      Array.isArray(value) ? value : value && Array.isArray(value.list) ? value.list : [];
    const ids = new Set<string>();
    for (const item of [
      ...list(drive?.tasks),
      ...list(drive?.tasksDone),
      ...Object.keys(drive?.all || {}),
    ]) {
      if (typeof item === 'string') ids.add(item);
      else if (item && typeof item.id === 'string') ids.add(item.id);
    }
    return [...ids];
  }

  function throwIfLogin(): void {
    if (detectLogin()) {
      throw new StepError('login-required', '迅雷登录状态已失效，请重新登录后重试');
    }
  }

  function throwIfParseError(): void {
    const error = findErrorToast();
    if (error) throw new StepError('parse-failed', `迅雷解析失败：${error}`);
  }

  try {
    switch (step) {
      case 'create-task': {
        let button: HTMLElement;
        try {
          button = await waitElement(selectors.createTaskButton);
        } catch {
          throwIfLogin();
          throw new StepError(
            'panel-not-ready',
            '未找到「新建任务」按钮，迅雷页面可能未就绪或版本不匹配',
          );
        }
        button.click();
        return { ok: true, message: '已打开新建任务弹窗' };
      }
      case 'fill-links': {
        let textarea: HTMLTextAreaElement;
        try {
          textarea = await waitElement<HTMLTextAreaElement>(selectors.linkTextarea);
        } catch {
          throwIfLogin();
          throw new StepError('panel-not-ready', '未找到链接输入框，迅雷页面可能未就绪');
        }
        setTextValue(textarea, payload.links || '');

        let parseButton: HTMLElement;
        try {
          parseButton = await waitElement(selectors.parseButton);
        } catch {
          throw new StepError('panel-not-ready', '未找到「解析」按钮，迅雷页面可能未就绪');
        }
        parseButton.click();
        await new Promise((r) => window.setTimeout(r, 400));
        throwIfParseError();
        return { ok: true, message: '已填入链接并触发解析' };
      }
      case 'confirm-download': {
        let dialog: HTMLElement;
        try {
          dialog = await waitVisibleDialog();
        } catch {
          throwIfLogin();
          throwIfParseError();
          throw new StepError('parse-timeout', '等待解析结果超时');
        }
        // 解析完成后按钮文本从「解析」变为「立即下载」，等它就绪再点。
        // 旧「添加链接」对话框可能还在 DOM 中，必须限定在结果对话框内查找。
        const downloadButton = await waitFor(
          () => {
            const button = dialog.querySelector<HTMLElement>(selectors.parseButton);
            return button && (button.textContent || '').includes('立即下载') ? button : null;
          },
          () => {
            throwIfLogin();
            throwIfParseError();
          },
        );
        const disabled =
          downloadButton.hasAttribute('disabled') ||
          downloadButton.getAttribute('aria-disabled') === 'true' ||
          downloadButton.classList.contains('is-disabled') ||
          downloadButton.classList.contains('disabled');
        if (disabled) {
          throw new StepError(
            'download-click-failed',
            '「立即下载」按钮不可用，请打开迅雷页面检查文件选择或磁盘空间',
          );
        }
        // 匹配流程已由 wait-dialog 应用过路径，点击时不要再改 Vuex，避免重置文件勾选
        const pathApplied =
          payload.skipPath === '1'
            ? undefined
            : await resolveDownloadPath(payload.downloadPath || '', true);
        downloadButton.click();
        await new Promise((r) => window.setTimeout(r, 800));
        const clickError = findErrorToast();
        if (clickError) {
          throw new StepError('download-click-failed', `迅雷拒绝创建任务：${clickError}`);
        }
        return {
          ok: true,
          message: '已点击立即下载',
          pathApplied,
          data: { taskIds: collectTaskIds() },
        };
      }
      case 'wait-dialog': {
        let dialog: HTMLElement;
        try {
          dialog = await waitVisibleDialog();
        } catch {
          throwIfLogin();
          throwIfParseError();
          throw new StepError('parse-timeout', '等待解析结果超时');
        }
        await waitFor(
          () => {
            const button = dialog.querySelector<HTMLElement>(selectors.parseButton);
            return button && (button.textContent || '').includes('立即下载') ? true : null;
          },
          () => {
            throwIfLogin();
            throwIfParseError();
          },
        );
        const pathApplied = await resolveDownloadPath(payload.downloadPath || '', true);
        return { ok: true, message: '链接已解析完成', pathApplied };
      }
      case 'check-path': {
        const pathApplied = await resolveDownloadPath(payload.downloadPath || '', false);
        return { ok: true, message: '', pathApplied };
      }
      case 'list-dir': {
        const store = await waitPanelStore();
        if (!store) {
          throw new StepError(
            'login-required',
            '无法读取迅雷页面状态，请先在迅雷页面登录',
          );
        }
        const parentId = payload.parentId || '';
        const parentPath = payload.parentPath || '';

        if (!parentId) {
          const rootsLoaded =
            Array.isArray(store.state.drive.rootDiskSelectList) &&
            store.state.drive.rootDiskSelectList.length > 0;
          if (!rootsLoaded) {
            await withTimeout(store.dispatch('drive/getFolderList'), '读取迅雷下载目录超时');
          }
          const roots: any[] = Array.isArray(store.state.drive.rootDiskSelectList)
            ? store.state.drive.rootDiskSelectList
            : [];
          const items = roots
            .map((item) => ({
              id: String(item?.id ?? ''),
              name: String(item?.title ?? item?.name ?? ''),
              path: normalizePath(item?.path || ''),
              realPath: String(item?.path || ''),
              writable: true,
            }))
            .filter((item) => item.id && item.path);
          return { ok: true, message: '', data: items };
        }

        const folders = await listFolders(store, parentId);
        const items = folders
          .map((folder) => {
            const realPath = String(
              folder?.params?.RealPath ||
                `${parentPath.replace(/\/+$/, '')}/${folder?.name || ''}`,
            );
            const writable = !(
              folder?.params?.is_write === false || folder?.params?.is_write === 'false'
            );
            return {
              id: String(folder?.id ?? ''),
              name: String(folder?.name ?? ''),
              path: normalizePath(realPath),
              realPath,
              writable,
            };
          })
          .filter((item) => item.id && item.path);
        return { ok: true, message: '', data: items };
      }
      default:
        return { ok: false, code: 'unknown', message: `未知步骤：${step}` };
    }
  } catch (error) {
    const stepError = error as { code?: SendErrorCode; message?: string };
    return {
      ok: false,
      code: stepError?.code ?? 'unknown',
      message: stepError?.message || '自动化步骤执行失败',
    };
  }
}
