import { finishEntry, markInterruptedRuns, startEntry } from '@/utils/history';
import { extractLinks, parseLinks } from '@/utils/links';
import type {
  DiagnoseCheck,
  ExtensionMessage,
  ListDirResponse,
  OpenXunleiResponse,
  ReadDialogFilesResponse,
  SendSource,
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
  type SendOutcome,
} from '@/utils/xunleiAutomation';
import { findXunleiTab, focusXunleiTab, openXunleiTab } from '@/utils/xunleiTab';

const CONTEXT_MENU_ID = 'nas-xunlei-send';
const LAST_SEND_KEY = 'nas_xunlei_last_send';
const LAST_SEND_TTL_MS = 30 * 60 * 1000;

interface LastSend {
  links: string[];
  at: number;
}

let activeSend: Promise<SendOutcome> | null = null;

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
});

async function bootstrap(): Promise<void> {
  await markInterruptedRuns();
  await ensureMonitorAlarm();
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
    });
  }
  if (message.type === 'xunlei') {
    return openXunlei(message.data?.url);
  }
  if (message.type === 'diagnostics') {
    if (message.action === 'testConnection') {
      return testConnection(message.data.url, message.data.downloadPath);
    }
    return listDir(message.data.url, message.data.parentId, message.data.parentPath);
  }
  if (message.type === 'avMatch') {
    return readDialogFiles();
  }
  return { ok: false, code: 'unknown', message: '未知消息类型' };
}

/** 选项页只读诊断：读取当前已打开迅雷页的解析文件树，不点击、不下载 */
async function readDialogFiles(): Promise<ReadDialogFilesResponse> {
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
function sendLinksToNas(
  links: string[],
  options: { notify: boolean; source: SendSource },
): Promise<SendOutcome> {
  if (activeSend) {
    return Promise.resolve({
      stage: 'prepare',
      ok: false,
      code: 'busy',
      message: '正在发送中，请稍候再试',
    } satisfies SendOutcome);
  }

  const task = runSend(links, options);
  activeSend = task
    .then(
      (outcome) => outcome,
      (error: Error) =>
        ({
          stage: 'prepare',
          ok: false,
          code: 'unknown',
          message: error.message || '发送失败',
        }) satisfies SendOutcome,
    )
    .finally(() => {
      activeSend = null;
    });
  return activeSend;
}

async function runSend(
  rawLinks: string[],
  options: { notify: boolean; source: SendSource },
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

  const outcome = await runSendFlow(tab.id, {
    links,
    downloadPath: settings.downloadPath,
    mode: settings.downloadMode,
    match: settings.avMatch,
  });

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
