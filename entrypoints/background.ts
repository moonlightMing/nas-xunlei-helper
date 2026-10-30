import { clearHistory, finishEntry, markInterruptedRuns, startEntry } from '@/utils/history';
import { extractLinks, extractResourceKey, parseLinks } from '@/utils/links';
import type {
  DiagnoseCheck,
  ExtensionMessage,
  ListDirResponse,
  ListTasksResponse,
  OpenXunleiResponse,
  ReadDialogFilesResponse,
  SendSource,
  TaskActionResponse,
  TaskSummary,
  TestConnectionResponse,
} from '@/utils/messaging';
import {
  clearSendResult,
  NOTIFICATION_IDS,
  readNotificationActionState,
  showInfoNotification,
  showSendResult,
  type NotificationAction,
} from '@/utils/notifications';
import type { SendErrorCode } from '@/utils/sendErrors';
import { getSendErrorMeta } from '@/utils/sendErrors';
import {
  ensureSettingsLoaded,
  getSettings,
  validateXunleiUrl,
  watchSettingsStorage,
  type XunleiSettings,
} from '@/utils/settings';
import {
  ensureMonitorAlarm,
  MONITOR_ALARM_NAME,
  scanMonitors,
  startMonitor,
} from '@/utils/taskMonitor';
import {
  checkDownloadPath,
  classifyProbe,
  inspectXunleiPage,
  listXunleiDir,
  probeMessage,
  readTaskState,
  readXunleiFileList,
  runSendFlow,
  type PageProbe,
  type PathApplied,
  type SendOutcome,
} from '@/utils/xunleiAutomation';
import {
  buildConfirmCreateSpecs,
  createConfirmId,
  deletePendingConfirmation,
  findPendingByWindowId,
  getPendingConfirmation,
  pruneExpiredConfirmations,
  savePendingConfirmation,
  setPendingWindowId,
  type ConfirmPath,
  type ConfirmSelectionInput,
  type ConfirmTask,
  type PendingConfirmation,
} from '@/utils/confirm';
import {
  createTask,
  deleteTasks,
  fetchDownloadPaths,
  flattenResourceFiles,
  getDeviceSpace,
  listTasks,
  operateTask,
  parseResources,
  resolveFolderIdByPath,
  PHASE_DONE,
  PHASE_IN_PROGRESS,
  TASK_TYPE_LOCAL,
  TASK_TYPE_URL,
  XunleiApiError,
  type FlatResourceFile,
  type ResourceNode,
  type XunleiPhase,
  type XunleiTask,
} from '@/utils/xunleiApi';
import {
  buildMatchPlan,
  selectSubFiles,
  toMatchSummary,
  type FileListSnapshot,
  type MatchSummary,
  type SnapshotGroup,
} from '@/utils/avMatch';
import { findXunleiTab, focusXunleiTab, openXunleiTab } from '@/utils/xunleiTab';

const CONTEXT_MENU_ID = 'nas-xunlei-send';
const LAST_SEND_KEY = 'nas_xunlei_last_send';
const LAST_SEND_TTL_MS = 30 * 60 * 1000;

interface LastSend {
  links: string[];
  at: number;
}

/** 发送入参：force 用于跳过接口模式的重复资源防呆（用户在弹窗点「仍然发送」时带上） */
interface SendOptions {
  notify: boolean;
  source: SendSource;
  force?: boolean;
}

let activeSend: Promise<SendOutcome> | null = null;

/**
 * 发送互斥锁的跨 SW 重启兜底：activeSend 只在 Service Worker 内存里，
 * SW 中途被回收后锁就丢了。锁同时写入 storage.session，新 SW 靠时间戳判断
 * 是否仍有未结束的发送；超过总超时的锁视为孤儿，可被下一次发送覆盖。
 */
const SEND_LOCK_KEY = 'nas_xunlei_send_lock';
/** 整条发送链路的兜底超时：超时后释放锁并把结果交回调用方，后台流程继续自行收尾 */
const SEND_TOTAL_TIMEOUT_MS = 5 * 60_000;

interface SendLockState {
  at: number;
}

async function readSendLockHeld(): Promise<boolean> {
  try {
    const stored = await chrome.storage.session.get(SEND_LOCK_KEY);
    const lock = stored?.[SEND_LOCK_KEY] as SendLockState | undefined;
    return Boolean(
      lock && typeof lock.at === 'number' && Date.now() - lock.at < SEND_TOTAL_TIMEOUT_MS,
    );
  } catch {
    // storage.session 不可用时退回纯内存锁
    return false;
  }
}

async function acquireSendLock(): Promise<void> {
  try {
    await chrome.storage.session.set({ [SEND_LOCK_KEY]: { at: Date.now() } satisfies SendLockState });
  } catch {
    /* ignore */
  }
}

async function releaseSendLock(): Promise<void> {
  try {
    await chrome.storage.session.remove(SEND_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

/** 发送或诊断是否正在占用迅雷页面/接口（诊断入口与发送共用同一互斥） */
async function isSendBusy(): Promise<boolean> {
  return Boolean(activeSend) || (await readSendLockHeld());
}

export default defineBackground(() => {
  // Service Worker 常驻期间也要感知设置页的修改，避免发送时沿用旧路径
  watchSettingsStorage(() => {});
  void bootstrap();

  chrome.runtime.onInstalled.addListener((details) => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: '发送到 NAS 迅雷',
        contexts: ['link', 'selection', 'video', 'audio'],
      });
    });
    void markInterruptedRuns();
    if (details.reason === 'install') {
      void (async () => {
        await ensureSettingsLoaded();
        if (!getSettings().xunleiUrl.trim()) {
          await chrome.runtime.openOptionsPage();
        }
      })();
    }
    void ensureMonitorAlarm();
  });

  chrome.runtime.onStartup.addListener(() => {
    void bootstrap();
  });

  // 右键菜单：service worker 冷启动后 onInstalled 不会重放，
  // 但 contextMenus 注册持久化在浏览器侧，这里只负责响应点击
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    const links = collectContextLinks(info);
    if (!links.length) {
      void notifyNoLinks();
      return;
    }
    void sendLinksToNas(links, { notify: true, source: 'context-menu' });
  });

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: Error) =>
        sendResponse({ ok: false, code: 'unknown', message: error.message || '后台处理失败' }),
      );
    return true; // 异步 sendResponse
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    void handleNotificationClick(notificationId);
  });

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    void handleNotificationButton(notificationId, buttonIndex);
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MONITOR_ALARM_NAME) void scanMonitors();
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void handleConfirmWindowClosed(windowId);
  });
});

async function bootstrap(): Promise<void> {
  await markInterruptedRuns();
  await ensureMonitorAlarm();
  await expireConfirmations();
}

/** 确认窗口 30 分钟未提交时按取消处理，避免发送记录永远停在等待状态 */
async function expireConfirmations(): Promise<void> {
  const expired = await pruneExpiredConfirmations();
  for (const pending of expired) {
    await finishEntry(pending.historyId, {
      status: 'paused',
      stage: 'confirm-download',
      message: '确认窗口已超时，未创建下载',
      pathApplied: pending.pathApplied,
    });
  }
}

/** 直接关闭确认窗口：没有提交就按取消处理 */
async function handleConfirmWindowClosed(windowId: number): Promise<void> {
  const pending = await findPendingByWindowId(windowId);
  if (!pending) return;
  await deletePendingConfirmation(pending.id);
  await finishEntry(pending.historyId, {
    status: 'paused',
    stage: 'confirm-download',
    message: '已关闭确认窗口，未创建下载',
    pathApplied: pending.pathApplied,
  });
}

function collectContextLinks(info: chrome.contextMenus.OnClickData): string[] {
  const candidates = [info.linkUrl, info.srcUrl].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    const parsed = parseLinks(candidate);
    if (parsed.links.length) return parsed.links;
  }
  if (info.selectionText) return extractLinks(info.selectionText);
  return [];
}

async function notifyNoLinks(): Promise<void> {
  await ensureSettingsLoaded();
  await showSendResult(
    { stage: 'prepare', ok: false, code: 'no-links', message: '选中内容里没有可识别的下载链接' },
    getSettings(),
    [],
  );
}

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  if (message.type === 'download') {
    return sendLinksToNas(message.data.links, {
      notify: true,
      source: message.data.source ?? 'popup',
      force: message.data.force,
    });
  }
  if (message.type === 'xunlei') {
    return openXunlei(message.data?.url);
  }
  if (message.type === 'diagnostics') {
    switch (message.action) {
      case 'testConnection':
        return testConnection(message.data.url, message.data.downloadPath);
      case 'listDir':
        return listDir(message.data.url, message.data.parentId, message.data.parentPath);
      default:
        return { ok: false, code: 'unknown', message: '未知诊断操作' };
    }
  }
  if (message.type === 'confirm') {
    switch (message.action) {
      case 'submit':
        return submitConfirmation(message.data);
      case 'cancel':
        await cancelConfirmation(message.data.id);
        return { ok: true };
      default:
        return { ok: false, code: 'unknown', message: '未知确认操作' };
    }
  }
  if (message.type === 'avMatch') {
    return readDialogFiles();
  }
  if (message.type === 'history') {
    // 发送记录的写入统一收口在 background 的串行队列里，
    // 避免 options「清空」与监控回写在两个上下文里整键互相覆盖
    if (message.action === 'clear') {
      await clearHistory();
      return { ok: true };
    }
    return { ok: false, message: '未知历史操作' };
  }
  if (message.type === 'tasks') {
    switch (message.action) {
      case 'list':
        return listTasksViaApi(message.data?.tab ?? 'ing', message.data?.limit);
      case 'operate':
        return operateTaskViaApi(message.data.id, message.data.phase);
      case 'delete':
        return deleteTasksViaApi(message.data.ids);
      default:
        return { ok: false, code: 'unknown', message: '未知任务操作' };
    }
  }
  return { ok: false, code: 'unknown', message: '未知消息类型' };
}

/** 接口异常映射成消息层错误码，供 popup 直接展示 */
function apiErrorMeta(error: unknown): { code: SendErrorCode; message: string } {
  if (error instanceof XunleiApiError) {
    if (error.kind === 'unreachable') return { code: 'nas-unreachable', message: error.message };
    if (error.kind === 'unauthorized' || error.kind === 'token-missing') {
      return { code: 'login-required', message: error.message };
    }
    return { code: 'unknown', message: error.message };
  }
  return { code: 'unknown', message: (error as Error)?.message || '迅雷接口调用失败' };
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** created_time 是带时区偏移的 ISO 8601 串（如 2026-10-30T08:17:53.486+08:00），Date.parse 可直接解析 */
function toTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTaskSummary(task: XunleiTask): TaskSummary {
  return {
    id: task.id,
    name: task.name || task.file_name || '(未命名任务)',
    type: task.type,
    phase: task.phase,
    progress: toNumber(task.progress),
    speed: toNumber(task.params?.speed),
    totalSize: toNumber(task.file_size),
    checkedSize: toNumber(task.params?.checked_size),
    realPath: task.params?.real_path ?? '',
    message: task.message ?? '',
    createdAt: toTimestamp(task.created_time),
  };
}

/** 读接口需要设备 space；设置缺失/非法时直接返回错误响应 */
async function prepareApiCall(): Promise<{ url: string; space: string } | { error: { code: SendErrorCode; message: string } }> {
  await ensureSettingsLoaded();
  const settings = getSettings();
  const urlError = validateXunleiUrl(settings.xunleiUrl);
  if (urlError) {
    return {
      error: {
        code: settings.xunleiUrl.trim() ? 'settings-invalid' : 'settings-missing',
        message: urlError,
      },
    };
  }
  try {
    const space = await getDeviceSpace(settings.xunleiUrl);
    if (!space) return { error: { code: 'login-required', message: '未获取到 NAS 设备标识，请先在迅雷页登录' } };
    return { url: settings.xunleiUrl, space };
  } catch (error) {
    return { error: apiErrorMeta(error) };
  }
}

async function listTasksViaApi(tab: 'ing' | 'done', limit?: number): Promise<ListTasksResponse> {
  const prepared = await prepareApiCall();
  if ('error' in prepared) {
    return { ok: false, tasks: [], code: prepared.error.code, message: prepared.error.message };
  }
  try {
    const result = await listTasks(prepared.url, {
      space: prepared.space,
      phases: tab === 'done' ? PHASE_DONE : PHASE_IN_PROGRESS,
      types: [TASK_TYPE_URL, TASK_TYPE_LOCAL],
      limit: limit ?? 50,
    });
    return {
      ok: true,
      tasks: (result.tasks ?? []).map(toTaskSummary),
      expiresIn: result.expires_in,
    };
  } catch (error) {
    const meta = apiErrorMeta(error);
    return { ok: false, tasks: [], code: meta.code, message: meta.message };
  }
}

/** 暂停/继续/删除都要回读任务本身拿到 type，避免猜参数 */
async function requireTask(url: string, space: string, id: string): Promise<XunleiTask> {
  const result = await listTasks(url, { space, ids: [id], limit: 1 });
  const task = (result.tasks ?? [])[0];
  if (!task) throw new XunleiApiError('api-error', `没有找到任务 ${id}`);
  return task;
}

async function operateTaskViaApi(id: string, phase: XunleiPhase): Promise<TaskActionResponse> {
  const prepared = await prepareApiCall();
  if ('error' in prepared) return { ok: false, ...prepared.error };
  try {
    const task = await requireTask(prepared.url, prepared.space, id);
    await operateTask(prepared.url, {
      space: prepared.space,
      id: task.id,
      type: task.type,
      phase,
    });
    return { ok: true, message: phase === 'PHASE_TYPE_PAUSED' ? '已暂停' : '已继续' };
  } catch (error) {
    return { ok: false, ...apiErrorMeta(error) };
  }
}

async function deleteTasksViaApi(ids: string[]): Promise<TaskActionResponse> {
  const prepared = await prepareApiCall();
  if ('error' in prepared) return { ok: false, ...prepared.error };
  if (!ids.length) return { ok: false, code: 'no-links', message: '没有选中要删除的任务' };
  try {
    await deleteTasks(prepared.url, { space: prepared.space, ids });
    return { ok: true, message: `已删除 ${ids.length} 个任务` };
  } catch (error) {
    return { ok: false, ...apiErrorMeta(error) };
  }
}

/** 选项页只读诊断：读取当前已打开迅雷页的解析文件树，不点击、不下载 */
async function readDialogFiles(): Promise<ReadDialogFilesResponse> {
  // 读取弹窗文件树与发送共用迅雷标签页，避免与进行中的自动化互相干扰
  if (await isSendBusy()) {
    return { ok: false, code: 'busy', message: '正在发送任务，请稍后再试' };
  }
  await ensureSettingsLoaded();
  const settings = getSettings();
  const urlError = validateXunleiUrl(settings.xunleiUrl);
  if (urlError) {
    return {
      ok: false,
      code: settings.xunleiUrl.trim() ? 'settings-invalid' : 'settings-missing',
      message: urlError,
    };
  }

  const tab = await findXunleiTab(settings.xunleiUrl);
  if (!tab?.id) {
    return {
      ok: false,
      message: '请先打开迅雷页面并解析一个磁力/种子，再读取文件列表',
    };
  }

  const result = await readXunleiFileList(tab.id, [], false);
  if (!result.ok || !result.snapshot) {
    const message =
      result.message === '文件树尚未就绪，请稍后重试'
        ? '未读到 BT 文件树：请确认当前解析的是磁力/种子任务；直链任务不参与番号匹配'
        : result.message || '读取迅雷文件列表失败';
    return {
      ok: false,
      message,
      debug: result.debug,
    };
  }
  return { ok: true, snapshot: result.snapshot, debug: result.debug };
}

/** 发送链接到 NAS 迅雷：锁 → 解析/校验 → 历史 → 打开/复用迅雷页 → 预检 → 自动化 → 监控 → 通知 */
async function sendLinksToNas(
  links: string[],
  options: SendOptions,
): Promise<SendOutcome> {
  const busyOutcome = (): SendOutcome => ({
    stage: 'prepare',
    ok: false,
    code: 'busy',
    message: '正在发送中，请稍候再试',
  });
  if (activeSend || (await readSendLockHeld())) return busyOutcome();
  await acquireSendLock();

  const run = runSend(links, options).catch((error: Error): SendOutcome => ({
    stage: 'prepare',
    ok: false,
    code: 'unknown',
    message: error.message || '发送失败',
  }));
  activeSend = run;
  void run.finally(async () => {
    activeSend = null;
    await releaseSendLock();
  });

  // 总超时兜底：单次 executeScript 卡死时后续发送不至于永远 busy。
  // 超时只释放锁并返回结果，不打断后台流程，其历史/通知收尾照常发生。
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<SendOutcome>((resolve) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      resolve({
        stage: 'prepare',
        ok: false,
        code: 'unknown',
        message: `发送超时（${Math.round(SEND_TOTAL_TIMEOUT_MS / 60_000)} 分钟无进展），迅雷页面可能无响应，请打开页面检查`,
      });
    }, SEND_TOTAL_TIMEOUT_MS);
  });
  const outcome = await Promise.race([run, timeoutOutcome]).finally(() => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  });
  if (timedOut) {
    activeSend = null;
    await releaseSendLock();
  }
  return outcome;
}

const BT_LINK = /^(magnet:|thunder:|ed2k:)/i;
/** 与迅雷 BT 弹窗一致的解析上限；顶到该值即视为文件树被截断 */
const PARSE_PAGE_SIZE = 2000;

/** 通知/弹窗里展示链接时取可辨识前缀，避免整条磁力刷屏 */
function shortLinkLabel(link: string): string {
  const dn = /[?&]dn=([^&]+)/.exec(link);
  if (dn?.[1]) {
    try {
      return decodeURIComponent(dn[1].replace(/\+/g, ' ')).slice(0, 40);
    } catch {
      /* 回退到下面的哈希/截断展示 */
    }
  }
  const hash = /btih:([0-9a-zA-Z]{8,})/.exec(link);
  return hash?.[1] ? `${hash[1].slice(0, 10)}…` : link.length > 32 ? `${link.slice(0, 32)}…` : link;
}

/** 接口模式共用的上下文：设备 space、目标目录、路径回退信息 */
interface ApiContext {
  space: string;
  parentFolderId: string;
  pathApplied: PathApplied;
}

type ApiContextResult = { ok: true; context: ApiContext } | { ok: false; outcome: SendOutcome };

/** 解析 + 番号匹配后，每个链接对应的任务计划（立即下载与确认下载共用） */
interface ApiTaskPlan {
  link: string;
  kind: 'bt' | 'direct';
  name?: string;
  /** BT 根节点/直链的大小，字节 */
  size: number;
  totalFileCount?: number;
  files: FlatResourceFile[];
  truncated: boolean;
  /** 立即下载：sub_file_index 与选中文件大小 */
  subFileIndex?: string;
  selectedFileSize?: number;
  skippedUnmatched?: boolean;
  /** 确认下载：预选文件、是否只能整包、整包默认态 */
  preselectedIds: string[];
  selectionDisabled: boolean;
  wholePackageDefault: boolean;
  matchStatus?: string;
  note?: string;
}

interface ApiAnalysis {
  tasks: ApiTaskPlan[];
  matchSummary?: MatchSummary;
  /** 给用户看的匹配结论：接口模式没有迅雷弹窗可核对，必须自己把结果说清楚 */
  matchText: string;
}

/** 设备 space + 保存路径 + 重复资源防呆，两种下载模式共用 */
async function resolveApiContext(
  links: string[],
  settings: XunleiSettings,
  options: SendOptions,
): Promise<ApiContextResult> {
  let space = '';
  try {
    space = await getDeviceSpace(settings.xunleiUrl);
  } catch (error) {
    const meta = apiErrorMeta(error);
    return { ok: false, outcome: { stage: 'prepare', ok: false, code: meta.code, message: meta.message } };
  }
  if (!space) {
    return {
      ok: false,
      outcome: {
        stage: 'prepare',
        ok: false,
        code: 'login-required',
        message: '未获取到 NAS 设备标识，请先在迅雷页面完成登录',
      },
    };
  }

  const configuredPath = settings.downloadPath.trim();
  const needed = Boolean(configuredPath);
  let parentFolderId = '';
  let pathApplied: PathApplied = { needed, applied: !needed };
  if (needed) {
    try {
      const resolved = await resolveFolderIdByPath(settings.xunleiUrl, space, configuredPath);
      if (resolved.missing) {
        pathApplied = {
          needed: true,
          applied: false,
          reason: `NAS 上找不到目录（缺少 ${resolved.missing}），已回退迅雷默认目录`,
        };
      } else {
        parentFolderId = resolved.id;
        pathApplied = { needed: true, applied: true, resolvedPath: configuredPath };
      }
    } catch (error) {
      pathApplied = { needed: true, applied: false, reason: apiErrorMeta(error).message };
    }
  }

  // 重复资源防呆：迅雷对同 infohash 重新添加会顶掉旧任务记录，接口模式又不经过
  // 弹窗、用户看不到将被覆盖的是哪个任务，所以默认拦一次，由用户显式确认重发。
  if (!options.force) {
    try {
      const existing = await listTasks(settings.xunleiUrl, {
        space,
        phases: [...PHASE_IN_PROGRESS, ...PHASE_DONE],
        types: [TASK_TYPE_URL, TASK_TYPE_LOCAL],
        limit: 100,
      });
      const known = new Map<string, XunleiTask>();
      for (const task of existing.tasks ?? []) {
        // 未解析完的任务（PENDING/ERROR）没有 info_hash 也没有 name，只有 params.url，
        // 只按 info_hash 比对会漏掉"刚发出去还没解析"的重复发送
        const keys = [
          String(task.params?.info_hash ?? '').toUpperCase(),
          extractResourceKey(String(task.params?.url ?? '')),
        ].filter((key) => key.length > 0);
        for (const key of keys) if (!known.has(key)) known.set(key, task);
      }
      const dupes = links
        .map((link) => ({ link, key: extractResourceKey(link) }))
        .filter((item) => item.key.length > 0 && known.has(item.key))
        .map((item) => known.get(item.key)!);
      if (dupes.length) {
        return {
          ok: false,
          outcome: {
            stage: 'match',
            ok: true,
            code: 'duplicate-task',
            message: `NAS 上已有 ${dupes.length} 个相同资源的任务（${dupes
              .slice(0, 3)
              .map((task) => task.name || shortLinkLabel(String(task.params?.url ?? '')) || task.id)
              .join('、')}），已阻止重复发送`,
            pathApplied,
            paused: { reason: 'duplicate' },
          },
        };
      }
    } catch {
      // 查重只是防呆，读不到已有任务时宁可放行也不误拦正常发送
    }
  }

  return { ok: true, context: { space, parentFolderId, pathApplied } };
}

/**
 * 解析链接并计算番号匹配结果。
 * needFiles 为 false 时（接口模式立即下载且未启用番号匹配）不访问解析接口。
 */
async function analyzeApiLinks(
  links: string[],
  settings: XunleiSettings,
  needFiles: boolean,
): Promise<{ ok: true; analysis: ApiAnalysis } | { ok: false; outcome: SendOutcome }> {
  const tasks: ApiTaskPlan[] = links.map((link) => ({
    link,
    kind: BT_LINK.test(link.trim()) ? 'bt' : 'direct',
    size: 0,
    files: [],
    truncated: false,
    preselectedIds: [],
    selectionDisabled: false,
    wholePackageDefault: false,
  }));
  const btLinks = links.filter((link) => BT_LINK.test(link.trim()));
  const groups: SnapshotGroup[] = [];
  const filesByGroup = new Map<string, FlatResourceFile[]>();
  const rootByGroup = new Map<string, ResourceNode>();
  const rootIdByLink = new Map<string, string>();
  const noTreeLinks: string[] = [];

  if (needFiles) {
    for (const task of tasks) {
      if (task.kind !== 'bt') continue;
      let parsed;
      try {
        parsed = await parseResources(settings.xunleiUrl, [task.link], PARSE_PAGE_SIZE);
      } catch (error) {
        // 令牌失效/网络不通是系统性故障，不能退化成"整包发送"把问题吞掉
        if (
          error instanceof XunleiApiError &&
          (error.kind === 'unreachable' || error.kind === 'unauthorized' || error.kind === 'token-missing')
        ) {
          return { ok: false, outcome: { stage: 'match', ok: false, ...apiErrorMeta(error) } };
        }
        parsed = undefined;
      }
      const root = parsed?.list?.resources?.[0];
      const files = root ? flattenResourceFiles(root) : [];
      // 解析不出可用的 BT 文件树：与页面自动化一致按 no-file-list 处理——
      // 整包继续发送，不暂停（ed2k、thunder 包直链等本就没有文件树）
      if (!root || !files.length || !root.is_dir) {
        task.kind = 'direct';
        if (root) {
          task.name = root.name;
          task.size = Number(root.file_size ?? 0) || 0;
          task.totalFileCount = Number(root.file_count ?? 0) || undefined;
        }
        task.note = '未解析出 BT 文件树，将整包下载';
        noTreeLinks.push(task.link);
        continue;
      }
      // 返回叶子数顶到 page_size 说明文件树被截断，不能拿残缺列表下结论。
      // 截断只影响该链接自己：不进匹配计划，稍后按「严格暂停 / 回退整包」单独处理，
      // 不连累同批其它健康链接（接口模式每个链接是独立任务）
      const truncated = files.length >= PARSE_PAGE_SIZE;
      const rootId = root.id ?? task.link;
      task.name = root.name;
      task.size = Number(root.file_size ?? 0) || 0;
      task.totalFileCount = Number(root.file_count ?? 0) || undefined;
      task.files = files;
      task.truncated = truncated;
      if (truncated) continue;
      groups.push({
        rootId,
        rootName: root.name ?? task.link,
        files: files.map((file) => ({ id: file.id, name: file.name, path: file.path, size: file.size })),
      });
      filesByGroup.set(rootId, files);
      rootByGroup.set(rootId, root);
      rootIdByLink.set(task.link, rootId);
    }
  }

  let matchSummary: MatchSummary | undefined;
  let matchText = '';
  const strict = !settings.avMatch.fallbackToDefault;

  if (settings.avMatch.enabled && groups.length) {
    const snapshot: FileListSnapshot = {
      kind: 'bt',
      treeHash: groups.map((group) => group.rootId).join('|'),
      groups,
      checkedIds: [],
      buttonDisabled: false,
      // 截断的链接已在上一步被隔离出 groups，不再用全局截断标志连累整单
      truncated: false,
    };
    const plan = buildMatchPlan(snapshot, settings.avMatch, btLinks);
    matchSummary = toMatchSummary(plan);
    matchText = plan.summary;

    if (plan.status === 'skipped') {
      // 文件树截断等异常：与页面自动化同一套语义——严格暂停、回退整包，
      // 绝不带着残缺信息去勾选
      for (const task of tasks) {
        if (task.kind !== 'bt') continue;
        task.selectionDisabled = task.truncated;
        task.skippedUnmatched = strict;
        task.preselectedIds = strict ? [] : task.files.map((file) => file.id);
        task.wholePackageDefault = !strict;
        task.note = plan.summary;
      }
    } else {
      const groupByRoot = new Map(plan.groups.map((group) => [group.rootId, group]));
      for (const task of tasks) {
        if (task.kind !== 'bt') continue;
        const rootId = rootIdByLink.get(task.link);
        const group = rootId ? groupByRoot.get(rootId) : undefined;
        if (!group) continue;
        const root = rootByGroup.get(group.rootId);
        const selection = selectSubFiles(
          group,
          filesByGroup.get(group.rootId) ?? [],
          Number(root?.file_size ?? 0) || 0,
          plan.policy,
        );
        task.matchStatus = group.status;
        task.selectionDisabled = task.truncated;
        // 回退模式下未命中的任务保留整包：预选全部文件（与不传 sub_file_index 等价），
        // 用户在确认窗口里仍可取消勾选
        task.preselectedIds = plan.preserveRootIds.includes(group.rootId)
          ? task.files.map((file) => file.id)
          : [...group.selectedIds];
        if (selection.skippedUnmatched) {
          task.skippedUnmatched = true;
        } else {
          task.subFileIndex = selection.subFileIndex || undefined;
          task.selectedFileSize = selection.fileSize;
        }
        if (group.status !== 'matched') {
          task.note =
            group.status === 'no-code'
              ? '未识别到番号'
              : group.status === 'ambiguous'
                ? '番号不唯一，未自动勾选'
                : '未匹配到番号文件';
        }
      }
    }
  } else if (needFiles) {
    // 未启用番号匹配：确认窗口默认全选；文件树被截断时只能整包下载
    for (const task of tasks) {
      if (task.kind !== 'bt') continue;
      task.preselectedIds = task.files.map((file) => file.id);
      task.selectionDisabled = task.truncated;
      task.wholePackageDefault = task.truncated;
      if (task.truncated) task.note = '文件列表不完整，只能整包下载';
    }
  }

  // 截断的链接单独落地：与页面自动化的「plan 被跳过」同一套语义，
  // 但只作用于截断的那条链接——严格暂停、回退整包，绝不带残缺文件树下结论。
  // 番号匹配未启用时不受严格/回退策略影响，维持「只能整包」。
  const truncatedTasks = tasks.filter((task) => task.kind === 'bt' && task.truncated);
  for (const task of truncatedTasks) {
    task.selectionDisabled = true;
    if (settings.avMatch.enabled) {
      task.skippedUnmatched = strict;
      task.preselectedIds = strict ? [] : task.files.map((file) => file.id);
      task.wholePackageDefault = !strict;
    } else {
      task.skippedUnmatched = false;
      task.preselectedIds = task.files.map((file) => file.id);
      task.wholePackageDefault = true;
    }
    task.note = '文件数超过解析上限（列表不完整），只能整包下载';
  }

  if (noTreeLinks.length) {
    const note = `${noTreeLinks.length} 个链接没有 BT 文件树，已跳过番号匹配，将整包下载`;
    matchText = matchText ? `${matchText}；${note}` : note;
  }
  if (truncatedTasks.length) {
    const wholePackage = !settings.avMatch.enabled || !strict;
    const note = `${truncatedTasks.length} 个链接文件数超过解析上限，${wholePackage ? '将整包下载' : '已按未匹配暂停'}`;
    matchText = matchText ? `${matchText}；${note}` : note;
  }

  return { ok: true, analysis: { tasks, matchSummary, matchText } };
}

async function loadConfirmPaths(
  xunleiUrl: string,
  space: string,
  configuredPath: string,
  parentFolderId: string,
): Promise<ConfirmPath[]> {
  const paths: ConfirmPath[] = [];
  try {
    const entries = await fetchDownloadPaths(xunleiUrl, space);
    for (const entry of entries ?? []) {
      const record = entry as Record<string, unknown>;
      const params = (record.params ?? {}) as Record<string, unknown>;
      const id = String(record.Id ?? '');
      const rawPath = String(record.RealPath ?? params.RealPath ?? record.FileName ?? '');
      const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
      const name = String(record.FileName ?? path);
      if (!id || !path || paths.some((item) => item.id === id)) continue;
      paths.push({ id, path, name });
    }
  } catch (error) {
    console.warn('[background] 读取迅雷下载目录失败:', error);
  }
  if (parentFolderId && configuredPath && !paths.some((item) => item.id === parentFolderId)) {
    paths.unshift({
      id: parentFolderId,
      path: configuredPath.length > 1 ? configuredPath.replace(/\/+$/, '') : configuredPath,
      name: configuredPath.split('/').filter(Boolean).pop() || configuredPath,
    });
  }
  return paths;
}

/** 确认窗口所需的精简任务视图，不包含接口令牌与设置 */
function toConfirmTask(task: ApiTaskPlan): ConfirmTask {
  return {
    link: task.link,
    label: shortLinkLabel(task.link),
    kind: task.kind,
    name: task.name || shortLinkLabel(task.link),
    size: task.size || 0,
    totalFileCount: task.totalFileCount ?? task.files.length,
    files: task.files.map((file) => ({
      id: file.id,
      name: file.name,
      path: file.path,
      size: file.size,
      fileIndex: file.fileIndex,
    })),
    preselectedIds: task.kind === 'bt' ? [...task.preselectedIds] : [],
    selectionDisabled: task.kind === 'bt' ? task.selectionDisabled : false,
    wholePackageDefault: task.kind === 'direct' ? true : task.wholePackageDefault,
    matchStatus: task.matchStatus,
    note: task.note,
  };
}

/**
 * 接口模式 + 确认后下载：解析并预选后打开扩展自己的确认窗口。
 * 此时还没有创建任何任务，历史先记为暂停/等待确认。
 */
async function prepareApiConfirmation(
  links: string[],
  settings: XunleiSettings,
  historyId: string,
  options: SendOptions,
  context: ApiContext,
): Promise<SendOutcome> {
  const analyzed = await analyzeApiLinks(links, settings, true);
  if (!analyzed.ok) {
    const outcome: SendOutcome = { ...analyzed.outcome, pathApplied: context.pathApplied };
    await finishEntry(historyId, {
      status: 'failed',
      stage: outcome.stage,
      code: outcome.code,
      message: outcome.message,
      pathApplied: context.pathApplied,
    });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  const { tasks, matchSummary, matchText } = analyzed.analysis;
  const confirmTasks = tasks.map(toConfirmTask);
  const configuredPath = settings.downloadPath.trim();
  const paths = await loadConfirmPaths(
    settings.xunleiUrl,
    context.space,
    configuredPath,
    context.parentFolderId,
  );
  const parentFolderId = context.parentFolderId || paths[0]?.id || '';
  const displayConfigured =
    configuredPath.length > 1 ? configuredPath.replace(/\/+$/, '') : configuredPath;
  const defaultPath =
    paths.find((item) => item.id === parentFolderId)?.path || displayConfigured || '迅雷默认目录';
  const pending: PendingConfirmation = {
    id: createConfirmId(),
    historyId,
    source: options.source,
    notify: options.notify,
    links: [...links],
    createdAt: Date.now(),
    url: settings.xunleiUrl,
    space: context.space,
    tasks: confirmTasks,
    paths,
    parentFolderId,
    path: defaultPath,
    pathApplied: context.pathApplied,
    match: matchSummary,
    matchText,
    message: matchText || '请选择要下载的文件与保存位置',
  };

  await savePendingConfirmation(pending);

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`confirm.html?id=${encodeURIComponent(pending.id)}`),
      type: 'popup',
      width: 560,
      height: 780,
      focused: true,
    });
    if (!win?.id) throw new Error('浏览器未返回窗口');
    await setPendingWindowId(pending.id, win.id);
    // 浏览器缩放会同比缩小扩展页面的 CSS 视口；按缩放倍数放大窗口，
    // 让确认界面在 150%/200% 缩放下仍接近 560px 的设计宽度
    try {
      const [tab] = await chrome.tabs.query({ windowId: win.id });
      const zoom = tab?.id != null ? await chrome.tabs.getZoom(tab.id) : 1;
      if (zoom > 1.05) {
        await chrome.windows.update(win.id, {
          width: Math.min(1000, Math.round(560 * zoom)),
          height: Math.min(1000, Math.round(760 * zoom)),
        });
      }
    } catch (error) {
      console.warn('[background] 按缩放调整确认窗口大小失败:', error);
    }
  } catch (error) {
    await deletePendingConfirmation(pending.id);
    const message = `打开确认窗口失败：${(error as Error).message || '未知错误'}`;
    const outcome: SendOutcome = {
      stage: 'confirm-download',
      ok: false,
      code: 'tab-open-failed',
      message,
      pathApplied: context.pathApplied,
      match: matchSummary,
    };
    await finishEntry(historyId, {
      status: 'failed',
      stage: 'confirm-download',
      code: 'tab-open-failed',
      message,
      pathApplied: context.pathApplied,
      match: matchSummary,
    });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  const outcome: SendOutcome = {
    stage: 'confirm-download',
    ok: true,
    message: '已打开确认窗口，请选择要下载的文件与保存位置',
    pathApplied: context.pathApplied,
    match: matchSummary,
  };
  await finishEntry(historyId, {
    status: 'paused',
    stage: 'confirm-download',
    message: `等待确认：${outcome.message}`,
    pathApplied: context.pathApplied,
    match: matchSummary,
  });
  return outcome;
}

/** 确认窗口提交防重入：同一 pending 的并发提交只放行一个 */
const submittingConfirmIds = new Set<string>();

/** 确认窗口提交：重新校验勾选，再真正调用 drive/v1/task 建任务 */
async function submitConfirmation(data: {
  id: string;
  selections: ConfirmSelectionInput[];
  parentFolderId?: string;
}): Promise<SendOutcome> {
  if (submittingConfirmIds.has(data.id)) {
    return {
      stage: 'confirm-download',
      ok: false,
      code: 'busy',
      message: '正在提交，请稍候',
    };
  }
  submittingConfirmIds.add(data.id);
  try {
    return await performConfirmSubmit(data);
  } finally {
    submittingConfirmIds.delete(data.id);
  }
}

async function performConfirmSubmit(data: {
  id: string;
  selections: ConfirmSelectionInput[];
  parentFolderId?: string;
}): Promise<SendOutcome> {
  const pending = await getPendingConfirmation(data.id);
  if (!pending) {
    return {
      stage: 'confirm-download',
      ok: false,
      code: 'unknown',
      message: '确认已失效或已完成，请重新发送链接',
    };
  }

  const selections = Array.isArray(data.selections) ? data.selections : [];
  const submission = buildConfirmCreateSpecs(pending, selections);

  if (!submission.specs.length) {
    await deletePendingConfirmation(pending.id);
    const message = '没有选择任何要下载的文件，未创建任务';
    await finishEntry(pending.historyId, {
      status: 'paused',
      stage: 'match',
      code: 'av-unmatched',
      message,
      pathApplied: pending.pathApplied,
      match: pending.match,
    });
    return {
      stage: 'match',
      ok: true,
      code: 'av-unmatched',
      message,
      pathApplied: pending.pathApplied,
      paused: { reason: 'unmatched' },
      match: pending.match,
    };
  }

  const allowedFolders = new Set(pending.paths.map((item) => item.id));
  const requested = data.parentFolderId ?? '';
  const parentFolderId = allowedFolders.has(requested) ? requested : pending.parentFolderId;
  const pathLabel =
    pending.paths.find((item) => item.id === parentFolderId)?.path || pending.path;
  const pathApplied: PathApplied = parentFolderId
    ? { needed: true, applied: true, resolvedPath: pathLabel }
    : { needed: false, applied: true };

  const taskIds: string[] = [];
  const failures: string[] = [];
  for (const spec of submission.specs) {
    try {
      const created = await createTask(pending.url, {
        space: pending.space,
        url: spec.url,
        parentFolderId,
        name: spec.name,
        fileName: spec.name,
        fileSize: spec.fileSize,
        totalFileCount: spec.totalFileCount,
        subFileIndex: spec.subFileIndex,
      });
      const id = created.task?.id ?? (created as { id?: string }).id ?? '';
      if (id) taskIds.push(id);
      else failures.push(spec.name || shortLinkLabel(spec.url));
    } catch (error) {
      failures.push(`${spec.name || shortLinkLabel(spec.url)}（${apiErrorMeta(error).message}）`);
    }
  }

  if (!taskIds.length) {
    // 一个任务都没建成：保留 pending 让用户在确认窗口里直接「重试提交」，
    // 勾选与命名不丢；重试仍失败或关闭窗口/超时再按取消收尾
    const message = `创建任务失败：${failures[0] ?? '迅雷未返回任务'}`;
    return {
      stage: 'done',
      ok: false,
      code: 'unknown',
      message,
      pathApplied,
      match: pending.match,
      retryable: true,
    };
  }

  // 至少建成了一个任务：pending 的使命结束，删除并收尾（部分失败也删除，重试会造成重复任务）
  await deletePendingConfirmation(pending.id);

  const complete = failures.length === 0 && submission.skipped.length === 0;
  const outcome: SendOutcome = {
    stage: 'done',
    ok: true,
    message: [
      complete
        ? `已发送 ${taskIds.length} 个任务到 NAS`
        : [
            `已发送 ${taskIds.length} 个任务`,
            submission.skipped.length ? `${submission.skipped.length} 个未选择已跳过` : '',
            failures.length ? `${failures.length} 个失败` : '',
          ]
            .filter(Boolean)
            .join('，'),
      failures.length ? `失败：${failures.slice(0, 2).join('、')}` : '',
      pending.matchText ?? '',
    ]
      .filter(Boolean)
      .join('·'),
    pathApplied,
    taskIds,
    paused: undefined,
    match: pending.match,
  };
  await finishEntry(pending.historyId, {
    status: complete ? 'ok' : 'partial',
    stage: 'done',
    message: outcome.message,
    pathApplied,
    match: pending.match,
  });
  if (pending.notify) {
    await ensureSettingsLoaded();
    await showSendResult(outcome, getSettings(), pending.links);
  }
  await maybeStartApiMonitor(pending.historyId, pending.url, taskIds);
  return outcome;
}

/** 接口模式建任务成功后按设置启动任务监控（直接读接口，不依赖迅雷页面） */
async function maybeStartApiMonitor(historyId: string, url: string, taskIds: string[]): Promise<void> {
  if (!taskIds.length) return;
  await ensureSettingsLoaded();
  if (!getSettings().monitorDownloads) return;
  await startMonitor({
    requestId: historyId,
    tabUrl: url,
    channel: 'api',
    mode: 'immediate',
    baselineIds: [],
    baselineReliable: true,
    candidateIds: taskIds,
  }).catch((error: Error) => {
    console.warn('[background] 启动接口模式任务监控失败:', error);
  });
}

async function cancelConfirmation(id: string): Promise<void> {
  const pending = await getPendingConfirmation(id);
  if (!pending) return;
  await deletePendingConfirmation(id);
  await finishEntry(pending.historyId, {
    status: 'paused',
    stage: 'confirm-download',
    message: '已取消确认，未创建下载',
    pathApplied: pending.pathApplied,
  });
}

/**
 * 接口模式：解析 drive/v1/resource/list + 番号匹配后直接调 drive/v1/task 建任务，
 * 不打开迅雷页面、不抢焦点。确认模式下改为先打开扩展自己的确认窗口。
 *
 * 与页面自动化模式共用 utils/avMatch.ts 的纯函数，勾选结果编码成迅雷的
 * sub_file_index 索引串（连续段折叠为 "a-b"）。区别在于接口模式每个链接是独立
 * 任务，严格模式下未命中的链接单独暂停，不会像单个「立即下载」按钮那样连累整单。
 */
async function sendViaApi(
  links: string[],
  settings: XunleiSettings,
  historyId: string,
  options: SendOptions,
): Promise<SendOutcome> {
  const settle = async (
    outcome: SendOutcome,
    status: 'ok' | 'failed' | 'partial' | 'paused',
  ): Promise<SendOutcome> => {
    await finishEntry(historyId, {
      status,
      stage: outcome.stage,
      code: outcome.code,
      message: outcome.message,
      match: outcome.match,
    });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  };

  const resolved = await resolveApiContext(links, settings, options);
  if (!resolved.ok) {
    return settle(resolved.outcome, resolved.outcome.paused ? 'paused' : 'failed');
  }
  const { space, parentFolderId, pathApplied } = resolved.context;

  if (settings.downloadMode === 'confirm') {
    return prepareApiConfirmation(links, settings, historyId, options, resolved.context);
  }

  const analyzed = await analyzeApiLinks(links, settings, settings.avMatch.enabled);
  if (!analyzed.ok) {
    return settle({ ...analyzed.outcome, pathApplied }, 'failed');
  }
  const { tasks, matchSummary, matchText } = analyzed.analysis;

  const skipped = tasks.filter((task) => task.skippedUnmatched);
  const creatable = tasks.filter((task) => !task.skippedUnmatched);
  // 只报真正被跳过的链接：group.status 为 ambiguous 时仍会选出文件，
  // 用 MatchSummary.unmatchedRoots 会把已建任务的链接说成未匹配
  const unmatchedLabels = skipped.map((task) => task.name || shortLinkLabel(task.link));
  // 文件树截断时 plan 被跳过，保持原行为：不带 name/size 直接整包建任务
  const useBtMeta = Boolean(matchSummary && !matchSummary.skipped);

  const taskIds: string[] = [];
  const failures: string[] = [];
  for (const task of creatable) {
    const btMeta = useBtMeta && task.kind === 'bt' && task.files.length > 0;
    try {
      const created = await createTask(settings.xunleiUrl, {
        space,
        url: task.link,
        parentFolderId,
        name: btMeta ? task.name : undefined,
        fileName: btMeta ? task.name : undefined,
        fileSize: btMeta ? task.selectedFileSize : undefined,
        totalFileCount: btMeta ? task.totalFileCount : undefined,
        subFileIndex: btMeta ? task.subFileIndex : undefined,
      });
      const id = created.task?.id ?? (created as { id?: string }).id ?? '';
      if (id) taskIds.push(id);
      else failures.push(shortLinkLabel(task.link));
    } catch (error) {
      failures.push(`${shortLinkLabel(task.link)}（${apiErrorMeta(error).message}）`);
    }
  }

  if (!creatable.length) {
    const outcome: SendOutcome = {
      stage: 'match',
      ok: true,
      code: 'av-unmatched',
      message: [
        `番号匹配未命中，已暂停 ${skipped.length} 个任务，未创建任何下载`,
        unmatchedLabels.length ? `未匹配：${unmatchedLabels.slice(0, 3).join('、')}` : '',
        matchText,
      ]
        .filter(Boolean)
        .join('·'),
      pathApplied,
      paused: { reason: 'unmatched' },
      match: matchSummary,
    };
    return settle(outcome, 'paused');
  }

  if (!taskIds.length) {
    return settle(
      {
        stage: 'done',
        ok: false,
        code: 'unknown',
        message: `创建任务失败：${failures[0] ?? '迅雷未返回任务'}`,
        pathApplied,
        match: matchSummary,
      },
      'failed',
    );
  }

  const complete = failures.length === 0 && skipped.length === 0;
  const outcome: SendOutcome = {
    stage: 'done',
    ok: true,
    message: [
      complete
        ? `已发送 ${taskIds.length} 个任务到 NAS`
        : [
            `已发送 ${taskIds.length} 个任务`,
            skipped.length ? `${skipped.length} 个未匹配已暂停` : '',
            failures.length ? `${failures.length} 个失败` : '',
          ]
            .filter(Boolean)
            .join('，'),
      unmatchedLabels.length ? `未匹配：${unmatchedLabels.slice(0, 3).join('、')}` : '',
      failures.length ? `失败：${failures.slice(0, 2).join('、')}` : '',
      matchText,
    ]
      .filter(Boolean)
      .join('·'),
    pathApplied,
    taskIds,
    paused: skipped.length ? { reason: 'unmatched' } : undefined,
    match: matchSummary,
  };
  const settled = await settle(
    outcome,
    complete ? 'ok' : skipped.length && !failures.length ? 'paused' : 'partial',
  );
  if (taskIds.length) await maybeStartApiMonitor(historyId, settings.xunleiUrl, taskIds);
  return settled;
}
async function runSend(
  rawLinks: string[],
  options: SendOptions,
): Promise<SendOutcome> {
  const parsed = parseLinks(rawLinks.join('\n'));
  if (!parsed.links.length) {
    const outcome: SendOutcome = {
      stage: 'prepare',
      ok: false,
      code: 'no-links',
      message: parsed.unsupported.length ? '没有受支持的下载链接' : '没有可发送的链接',
    };
    if (options.notify) {
      await ensureSettingsLoaded();
      await showSendResult(outcome, getSettings(), []);
    }
    return outcome;
  }
  const links = parsed.links;

  await ensureSettingsLoaded();
  const settings = getSettings();
  const urlError = validateXunleiUrl(settings.xunleiUrl);
  if (urlError) {
    const configured = Boolean(settings.xunleiUrl.trim());
    const outcome: SendOutcome = {
      stage: 'prepare',
      ok: false,
      code: configured ? 'settings-invalid' : 'settings-missing',
      message: configured
        ? `NAS 迅雷地址不正确（${urlError}）`
        : `请先在设置页配置 NAS 迅雷地址（${urlError}）`,
    };
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  await saveLastSend(links);
  await clearSendResult();

  const historyId = await startEntry({
    source: options.source,
    links,
    mode: settings.downloadMode,
    path: settings.downloadPath,
  });

  if (settings.sendMode === 'api') {
    return sendViaApi(links, settings, historyId, options);
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await openXunleiTab(settings.xunleiUrl, {
      reload: settings.reloadBeforeSend,
      activate: true,
    });
  } catch (error) {
    const message = (error as Error).message || '打开迅雷页面失败';
    const code: SendErrorCode = /超时|timeout/i.test(message)
      ? 'tab-load-timeout'
      : /关闭|closed|无法访问/i.test(message)
        ? 'tab-closed'
        : 'tab-open-failed';
    const outcome: SendOutcome = { stage: 'open-page', ok: false, code, message };
    await finishEntry(historyId, { status: 'failed', stage: 'open-page', code, message });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  if (tab.id == null) {
    const message = '无法获取迅雷页面标签页';
    const outcome: SendOutcome = {
      stage: 'open-page',
      ok: false,
      code: 'tab-open-failed',
      message,
    };
    await finishEntry(historyId, {
      status: 'failed',
      stage: 'open-page',
      code: 'tab-open-failed',
      message,
    });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  const probe = await inspectXunleiPage(tab.id);
  let preflightCode = classifyProbe(probe);
  if (!preflightCode && !settings.reloadBeforeSend && probe?.hasResultDialog) {
    preflightCode = 'dialog-open';
  }
  if (preflightCode) {
    const fallback =
      preflightCode === 'dialog-open'
        ? '迅雷页面还有未处理的弹窗，请先处理或开启发送前刷新'
        : probe?.injectionError
          ? `无法在迅雷页面执行脚本：${probe.injectionError}`
          : getSendErrorMeta(preflightCode).hint;
    const message = probeMessage(preflightCode, probe, fallback);
    const outcome: SendOutcome = {
      stage: 'open-page',
      ok: false,
      code: preflightCode,
      message,
    };
    await finishEntry(historyId, {
      status: 'failed',
      stage: 'open-page',
      code: preflightCode,
      message,
    });
    if (options.notify) await showSendResult(outcome, settings, links);
    return outcome;
  }

  // 发送前的任务 id 基线，用于区分本次新建的任务
  const baseline = await readTaskState(tab.id, [], false);
  const baselineIds = baseline?.currentIds ?? [];
  const baselineReliable = Boolean(
    baseline && (baseline.currentIds.length > 0 || Object.keys(baseline.tasks).length > 0),
  );

  // 页面自动化 + 立即下载的重复资源防呆：弹窗停留不足 1 秒即被自动点击，
  // 用户没有机会像确认模式那样人工核对，重复资源会静默顶掉旧任务记录。
  // 只读复用页面 Vuex 里的任务 params（url/info_hash），与任务监控同一数据面。
  if (!options.force && settings.downloadMode === 'immediate') {
    const known = new Set<string>();
    for (const item of Object.values(baseline?.tasks ?? {})) {
      if (item.infoHash) known.add(item.infoHash);
      const key = extractResourceKey(item.url ?? '');
      if (key) known.add(key);
    }
    // 页面任务列表没加载出 params 时宁可不拦，也不误拦正常发送
    if (known.size) {
      const dupes = links
        .map((link) => ({ link, key: extractResourceKey(link) }))
        .filter((item) => item.key.length > 0 && known.has(item.key));
      if (dupes.length) {
        const outcome: SendOutcome = {
          stage: 'prepare',
          ok: true,
          code: 'duplicate-task',
          message: `NAS 上已有 ${dupes.length} 个相同资源的任务，重复发送会顶掉旧任务记录，已暂停；可在弹窗选择「仍然发送」`,
          paused: { reason: 'duplicate' },
        };
        await finishEntry(historyId, {
          status: 'paused',
          stage: 'prepare',
          code: 'duplicate-task',
          message: outcome.message,
        });
        if (options.notify) await showSendResult(outcome, settings, links);
        return outcome;
      }
    }
  }

  let outcome: SendOutcome;
  try {
    outcome = await runSendFlow(tab.id, {
      links,
      downloadPath: settings.downloadPath,
      mode: settings.downloadMode,
      match: settings.avMatch,
    });
  } catch (error) {
    // 未预期的异常也要让历史条目收敛到终态，而不是永远停在"发送中"
    outcome = {
      stage: 'match',
      ok: false,
      code: 'unknown',
      message: `发送流程异常：${(error as Error).message || '未知错误'}`,
    };
  }

  const pathFallback = Boolean(
    outcome.ok && outcome.pathApplied?.needed && !outcome.pathApplied.applied,
  );
  const status = outcome.paused
    ? 'paused'
    : !outcome.ok
      ? 'failed'
      : pathFallback
        ? 'partial'
        : 'ok';
  await finishEntry(historyId, {
    status,
    stage: outcome.stage,
    code: outcome.code,
    message: outcome.message,
    pathApplied: outcome.pathApplied,
    match: outcome.match,
  });

  if (options.notify) await showSendResult(outcome, settings, links);

  if (
    settings.monitorDownloads &&
    !outcome.paused &&
    (outcome.ok || outcome.stage === 'confirm-download' || outcome.stage === 'wait-dialog')
  ) {
    void startMonitor({
      requestId: historyId,
      tabUrl: settings.xunleiUrl,
      channel: 'dom',
      mode: settings.downloadMode,
      baselineIds,
      baselineReliable,
      // 基线不可靠时无法区分历史任务，宁可不猜也不误报
      candidateIds: baselineReliable
        ? (outcome.taskIds ?? []).filter((id) => !baselineIds.includes(id))
        : [],
    }).catch((error: Error) => {
      console.warn('[background] 启动任务监控失败:', error);
    });
  }

  return outcome;
}

async function saveLastSend(links: string[]): Promise<void> {
  try {
    await chrome.storage.session.set({
      [LAST_SEND_KEY]: { links, at: Date.now() } satisfies LastSend,
    });
  } catch (error) {
    console.warn('[background] 保存最近发送记录失败:', error);
  }
}

async function readLastSend(): Promise<LastSend | null> {
  try {
    const stored = await chrome.storage.session.get(LAST_SEND_KEY);
    const value = stored?.[LAST_SEND_KEY] as LastSend | undefined;
    if (!value || !Array.isArray(value.links) || typeof value.at !== 'number') return null;
    if (Date.now() - value.at > LAST_SEND_TTL_MS) return null;
    return value;
  } catch {
    return null;
  }
}

async function openXunlei(url?: string): Promise<OpenXunleiResponse> {
  await ensureSettingsLoaded();
  const target = (url ?? getSettings().xunleiUrl).trim();
  const error = validateXunleiUrl(target);
  if (error) {
    return {
      ok: false,
      code: target ? 'settings-invalid' : 'settings-missing',
      message: error,
    };
  }
  try {
    await focusXunleiTab(target);
    return { ok: true };
  } catch (openError) {
    return {
      ok: false,
      code: 'tab-open-failed',
      message: (openError as Error).message || '打开迅雷页面失败',
    };
  }
}

async function testConnection(
  url: string,
  downloadPath?: string,
): Promise<TestConnectionResponse> {
  // 诊断会打开/复用并发送正在使用的同一迅雷标签页，与发送互斥
  if (await isSendBusy()) {
    return { ok: false, checks: [], code: 'busy', message: '正在发送任务，请稍后再试' };
  }
  const checks: DiagnoseCheck[] = [];
  const urlError = validateXunleiUrl(url);
  checks.push({
    key: 'url',
    label: '地址格式',
    ok: !urlError,
    detail: urlError ?? '格式正确',
    code: urlError ? (url.trim() ? 'settings-invalid' : 'settings-missing') : undefined,
  });
  if (urlError) {
    return {
      ok: false,
      checks,
      code: url.trim() ? 'settings-invalid' : 'settings-missing',
      message: urlError,
    };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await openXunleiTab(url, { reload: false, activate: true });
  } catch (error) {
    const message = (error as Error).message || '无法打开迅雷页面';
    checks.push({
      key: 'reachable',
      label: '页面可达',
      ok: false,
      detail: message,
      code: 'nas-unreachable',
    });
    return { ok: false, checks, code: 'nas-unreachable', message };
  }

  if (tab.id == null) {
    const message = '无法获取迅雷页面标签页';
    checks.push({
      key: 'reachable',
      label: '页面可达',
      ok: false,
      detail: message,
      code: 'tab-open-failed',
    });
    return { ok: false, checks, code: 'tab-open-failed', message };
  }

  const probe = await inspectXunleiPage(tab.id);
  const reachable = Boolean(probe?.reachable && !probe.errorText && !probe.injectionError);
  checks.push({
    key: 'reachable',
    label: '页面可达',
    ok: reachable,
    detail: reachable ? '页面已加载' : describeProbe(probe),
    code: reachable ? undefined : 'nas-unreachable',
  });
  if (!reachable) {
    return { ok: false, checks, code: 'nas-unreachable', message: '无法访问迅雷页面' };
  }

  const loggedIn = Boolean(probe?.loggedIn || probe?.hasCreateTask);
  checks.push({
    key: 'login',
    label: '登录状态',
    ok: loggedIn,
    detail: loggedIn ? '已登录' : '未检测到登录态，请在迅雷页面登录',
    code: loggedIn ? undefined : 'login-required',
  });

  const panel = Boolean(probe?.hasCreateTask);
  checks.push({
    key: 'panel',
    label: '下载面板',
    ok: panel,
    detail: panel
      ? '「新建任务」按钮可用'
      : '未找到「新建任务」按钮，页面可能未就绪或套件版本变化',
    code: panel ? undefined : 'panel-not-ready',
  });

  if (downloadPath?.trim() && panel) {
    const pathApplied = await checkDownloadPath(tab.id, downloadPath);
    const ok = Boolean(pathApplied?.applied) || pathApplied?.needed === false;
    checks.push({
      key: 'path',
      label: '默认下载位置',
      ok,
      detail: ok
        ? `目录可用：${pathApplied?.resolvedPath ?? downloadPath}`
        : pathApplied?.reason ?? '目录不可用',
    });
  }

  const failed = checks.find((check) => !check.ok);
  return { ok: !failed, checks, code: failed?.code, message: failed?.detail };
}

async function listDir(
  url: string,
  parentId?: string,
  parentPath?: string,
): Promise<ListDirResponse> {
  // 读取目录会导航/复用发送正在使用的迅雷标签页，与发送互斥
  if (await isSendBusy()) {
    return { ok: false, items: [], code: 'busy', message: '正在发送任务，请稍后再试' };
  }
  const urlError = validateXunleiUrl(url);
  if (urlError) {
    return {
      ok: false,
      items: [],
      code: url.trim() ? 'settings-invalid' : 'settings-missing',
      message: urlError,
    };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await openXunleiTab(url, { reload: false, activate: true });
  } catch (error) {
    return {
      ok: false,
      items: [],
      code: 'nas-unreachable',
      message: (error as Error).message || '无法打开迅雷页面',
    };
  }
  if (tab.id == null) {
    return { ok: false, items: [], code: 'tab-open-failed', message: '无法获取迅雷页面标签页' };
  }

  const probe = await inspectXunleiPage(tab.id);
  const code = classifyDataProbe(probe);
  if (code) {
    return {
      ok: false,
      items: [],
      code,
      message: probeMessage(code, probe, '迅雷页面未就绪'),
    };
  }

  return listXunleiDir(tab.id, parentId, parentPath);
}

/** 目录读取只依赖 Vuex 登录态，不要求「新建任务」按钮可见 */
function classifyDataProbe(probe: PageProbe | null): SendErrorCode | null {
  if (!probe) return 'injection-failed';
  if (!probe.reachable) return 'nas-unreachable';
  if (probe.errorText) return 'nas-unreachable';
  if (probe.injectionError) return 'injection-failed';
  const loginSignals = probe.hasLoginForm || probe.loginText;
  if (!probe.hasApp || !probe.hasStore) {
    return loginSignals ? 'login-required' : 'page-mismatch';
  }
  if (!probe.loggedIn) return 'login-required';
  return null;
}

function describeProbe(probe: PageProbe | null): string {
  if (!probe) return '无法读取页面状态';
  if (probe.errorText) return probe.errorText;
  if (probe.injectionError) {
    if (/showing error page|ERR_[A-Z_]+|net::/i.test(probe.injectionError)) {
      return '页面不可达，请检查 NAS 地址与网络';
    }
    if (/Cannot access a chrome|chrome:\/\//i.test(probe.injectionError)) {
      return '当前页面不是迅雷下载面板';
    }
    return `无法在页面执行脚本：${probe.injectionError}`;
  }
  return '页面不可达';
}

async function handleNotificationClick(notificationId: string): Promise<void> {
  if (
    notificationId === NOTIFICATION_IDS.taskFailure ||
    notificationId === NOTIFICATION_IDS.taskComplete
  ) {
    await runNotificationAction('open-xunlei');
    return;
  }
  if (notificationId === NOTIFICATION_IDS.info) {
    await runNotificationAction('open-options');
    return;
  }
  if (notificationId !== NOTIFICATION_IDS.sendResult) return;
  const state = await readNotificationActionState(notificationId);
  await runNotificationAction(state?.defaultAction ?? 'open-xunlei');
}

async function handleNotificationButton(
  notificationId: string,
  buttonIndex: number,
): Promise<void> {
  if (
    notificationId === NOTIFICATION_IDS.taskFailure ||
    notificationId === NOTIFICATION_IDS.taskComplete
  ) {
    await runNotificationAction('open-xunlei');
    return;
  }
  if (notificationId !== NOTIFICATION_IDS.sendResult) return;
  const state = await readNotificationActionState(notificationId);
  const action = state?.actions[buttonIndex] ?? state?.defaultAction;
  if (action) await runNotificationAction(action);
}

async function runNotificationAction(action: NotificationAction): Promise<void> {
  if (action === 'open-options') {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (action === 'retry') {
    const last = await readLastSend();
    if (!last) {
      await showInfoNotification('NAS 迅雷 · 无法重试', '上次发送记录已过期，请重新发送。');
      return;
    }
    await sendLinksToNas(last.links, { notify: true, source: 'retry' });
    return;
  }

  const result = await openXunlei();
  if (!result.ok && (result.code === 'settings-missing' || result.code === 'settings-invalid')) {
    await chrome.runtime.openOptionsPage();
  }
}
