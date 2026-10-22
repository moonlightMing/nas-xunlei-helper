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
} as const;

/** 自动化单步等待元素的超时（毫秒） */
export const STEP_TIMEOUT_MS = 10_000;

export type AutomationStep = 'create-task' | 'fill-links' | 'confirm-download' | 'wait-dialog';

type ExecStep = AutomationStep | 'check-path' | 'list-dir';

export interface SendOptions {
  links: string[];
  downloadPath: string;
  mode: DownloadMode;
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
  stage: 'prepare' | 'open-page' | AutomationStep | 'done';
  ok: boolean;
  /** 失败原因分类，供通知/UI 决定动作 */
  code?: SendErrorCode;
  message: string;
  pathApplied?: PathApplied;
  /** 立即下载点击后读到的任务 id，用于任务监控初始候选 */
  taskIds?: string[];
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
          dialog = await waitElement(selectors.taskDialog);
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
        const pathApplied = await resolveDownloadPath(payload.downloadPath || '', true);
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
          dialog = await waitElement(selectors.taskDialog);
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
