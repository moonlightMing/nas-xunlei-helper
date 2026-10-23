import { finishEntry, markInterruptedRuns, startEntry } from '@/utils/history';
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
  createTask,
  deleteTasks,
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
      force: message.data.force,
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
  if (message.type === 'tasks') {
    if (message.action === 'list') {
      return listTasksViaApi(message.data?.tab ?? 'ing', message.data?.limit);
    }
    if (message.action === 'operate') {
      return operateTaskViaApi(message.data.id, message.data.phase);
    }
    return deleteTasksViaApi(message.data.ids);
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
    updatedAt: task.updated_time ?? task.created_time ?? '',
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
  options: SendOptions,
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

const BT_LINK = /^(magnet:|thunder:|ed2k:)/i;
/** 与迅雷 BT 弹窗一致的解析上限；顶到该值即视为文件树被截断 */
const PARSE_PAGE_SIZE = 2000;

/** 通知/弹窗里展示链接时取可辨识前缀，避免整条磁力刷屏 */
function shortLinkLabel(link: string): string {
  const dn = /[?&]dn=([^&]+)/.exec(link);
  if (dn) {
    try {
      return decodeURIComponent(dn[1].replace(/\+/g, ' ')).slice(0, 40);
    } catch {
      /* 回退到下面的哈希/截断展示 */
    }
  }
  const hash = /btih:([0-9a-zA-Z]{8,})/.exec(link);
  if (hash) return `${hash[1].slice(0, 10)}…`;
  return link.length > 32 ? `${link.slice(0, 32)}…` : link;
}

/**
 * 接口模式：解析 drive/v1/resource/list + 番号匹配后直接调 drive/v1/task 建任务，
 * 不打开迅雷页面、不抢焦点。
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

  let space = '';
  try {
    space = await getDeviceSpace(settings.xunleiUrl);
  } catch (error) {
    const meta = apiErrorMeta(error);
    return settle({ stage: 'prepare', ok: false, code: meta.code, message: meta.message }, 'failed');
  }
  if (!space) {
    return settle(
      {
        stage: 'prepare',
        ok: false,
        code: 'login-required',
        message: '未获取到 NAS 设备标识，请先在迅雷页面完成登录',
      },
      'failed',
    );
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
        return settle(
          {
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
          'paused',
        );
      }
    } catch {
      // 查重只是防呆，读不到已有任务时宁可放行也不误拦正常发送
    }
  }

  const btLinks = links.filter((link) => BT_LINK.test(link.trim()));
  interface TaskSpec {
    url: string;
    subFileIndex?: string;
    name?: string;
    fileSize?: number;
    totalFileCount?: number;
    /** 严格模式未命中：不建任务，交由暂停语义上报 */
    skippedUnmatched?: boolean;
  }
  const specs: TaskSpec[] = links.map((url) => ({ url }));
  let matchSummary: MatchSummary | undefined;
  /** 给用户看的匹配结论：接口模式没有迅雷弹窗可核对，必须自己把结果说清楚 */
  let matchText = '';

  if (settings.avMatch.enabled && btLinks.length) {
    const groups: SnapshotGroup[] = [];
    const filesByGroup = new Map<string, FlatResourceFile[]>();
    const rootByGroup = new Map<string, ResourceNode>();
    const linkByGroup = new Map<string, string>();
    const noTreeLinks: string[] = [];
    let parseTruncated = false;

    for (const link of btLinks) {
      let parsed;
      try {
        parsed = await parseResources(settings.xunleiUrl, [link], PARSE_PAGE_SIZE);
      } catch (error) {
        // 令牌失效/网络不通是系统性故障，不能退化成"整包发送"把问题吞掉
        if (
          error instanceof XunleiApiError &&
          (error.kind === 'unreachable' || error.kind === 'unauthorized' || error.kind === 'token-missing')
        ) {
          return settle(
            { stage: 'match', ok: false, ...apiErrorMeta(error), pathApplied },
            'failed',
          );
        }
        parsed = undefined;
      }
      const root = parsed?.list?.resources?.[0];
      const files = root ? flattenResourceFiles(root) : [];
      // 解析不出可用的 BT 文件树：与页面自动化一致按 no-file-list 处理——
      // 整包继续发送，不暂停（ed2k、thunder 包直链等本就没有文件树）
      if (!root || !files.length || !root.is_dir) {
        if (root && !root.is_dir && files.length) continue;
        noTreeLinks.push(link);
        continue;
      }
      // 返回叶子数顶到 page_size 说明文件树被截断，不能拿残缺列表下结论
      if (files.length >= PARSE_PAGE_SIZE) parseTruncated = true;
      const rootId = root.id ?? link;
      groups.push({
        rootId,
        rootName: root.name ?? link,
        files: files.map((file) => ({ id: file.id, name: file.name, path: file.path, size: file.size })),
      });
      filesByGroup.set(rootId, files);
      rootByGroup.set(rootId, root);
      linkByGroup.set(rootId, link);
    }

    const strict = !settings.avMatch.fallbackToDefault;
    if (groups.length) {
      const snapshot: FileListSnapshot = {
        kind: 'bt',
        treeHash: groups.map((group) => group.rootId).join('|'),
        groups,
        checkedIds: [],
        buttonDisabled: false,
        truncated: parseTruncated,
      };
      const plan = buildMatchPlan(snapshot, settings.avMatch, btLinks);
      matchSummary = toMatchSummary(plan);
      matchText = plan.summary;
      if (plan.status === 'skipped') {
        // 文件树截断等异常：与页面自动化同一套语义——严格暂停、回退整包，
        // 绝不带着残缺信息去勾选
        for (const spec of specs) {
          if (strict && BT_LINK.test(spec.url)) spec.skippedUnmatched = true;
        }
      } else {
        for (const group of plan.groups) {
          const spec = specs.find((item) => item.url === linkByGroup.get(group.rootId));
          if (!spec) continue;
          const root = rootByGroup.get(group.rootId);
          const selection = selectSubFiles(
            group,
            filesByGroup.get(group.rootId) ?? [],
            Number(root?.file_size ?? 0) || 0,
            plan.policy,
          );
          spec.name = root?.name;
          spec.totalFileCount = Number(root?.file_count ?? 0) || undefined;
          if (selection.skippedUnmatched) {
            spec.skippedUnmatched = true;
          } else {
            spec.subFileIndex = selection.subFileIndex || undefined;
            spec.fileSize = selection.fileSize || undefined;
          }
        }
      }
    }
    if (noTreeLinks.length) {
      const note = `${noTreeLinks.length} 个链接没有 BT 文件树，已跳过番号匹配整包发送`;
      matchText = matchText ? `${matchText}；${note}` : note;
    }
  }

  const skipped = specs.filter((spec) => spec.skippedUnmatched);
  const creatable = specs.filter((spec) => !spec.skippedUnmatched);
  // 只报真正被跳过的链接：group.status 为 ambiguous 时仍会选出文件，
  // 用 MatchSummary.unmatchedRoots 会把已建任务的链接说成未匹配
  const unmatchedLabels = skipped.map((spec) => spec.name || shortLinkLabel(spec.url));

  const taskIds: string[] = [];
  const failures: string[] = [];
  for (const spec of creatable) {
    try {
      const created = await createTask(settings.xunleiUrl, {
        space,
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
      else failures.push(shortLinkLabel(spec.url));
    } catch (error) {
      failures.push(`${shortLinkLabel(spec.url)}（${apiErrorMeta(error).message}）`);
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
  return settle(outcome, complete ? 'ok' : skipped.length && !failures.length ? 'paused' : 'partial');
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
