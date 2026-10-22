import { showTaskComplete, showTaskFailure } from '@/utils/notifications';
import { updateMonitor } from '@/utils/history';
import { ensureSettingsLoaded, getSettings, type DownloadMode } from '@/utils/settings';
import { readTaskState, type TaskStateSnapshot } from '@/utils/xunleiAutomation';
import { findXunleiTab } from '@/utils/xunleiTab';

export const MONITOR_ALARM_NAME = 'nas-xunlei-task-monitor';
export const MONITOR_STORAGE_KEY = 'nas_xunlei_monitor';

const ALARM_PERIOD_MINUTES = 1;
const DISCOVER_MS_IMMEDIATE = 2 * 60 * 1000;
const DISCOVER_MS_CONFIRM = 30 * 60 * 1000;
const HARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;
const MAX_TASKS = 200;
const MAX_BASELINE_IDS = 500;
const MISSED_LIMIT = 5;
const TAB_MISSING_LIMIT = 3;
const FAILED_SCAN_LIMIT = 3;
const DOWNLOAD_TASK_TYPES = new Set(['user#download-url', 'user#download']);

interface MonitoredTask {
  id: string;
  name: string;
  phase: string;
  progress?: number;
  detail?: string;
  lastSeenAt: number;
  missedScans: number;
  notifiedError?: boolean;
  notifiedComplete?: boolean;
}

export interface MonitorSession {
  requestId: string;
  tabUrl: string;
  mode: DownloadMode;
  startedAt: number;
  discoverUntil: number;
  hardUntil: number;
  baselineIds: string[];
  baselineReliable: boolean;
  candidateIds: string[];
  tasks: Record<string, MonitoredTask>;
  tabMissingScans: number;
  failedScans: number;
  lastSummary?: string;
}

export interface StartMonitorInput {
  requestId: string;
  tabUrl: string;
  mode: DownloadMode;
  baselineIds: string[];
  baselineReliable: boolean;
  candidateIds?: string[];
}

type StopReason =
  | 'all-terminal'
  | 'no-task'
  | 'timeout'
  | 'tab-closed'
  | 'page-unavailable'
  | 'disabled'
  | 'missing';

let operation: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = operation.then(task, task);
  operation = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function getStorageArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is MonitorSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<MonitorSession>;
  return (
    typeof session.requestId === 'string' &&
    typeof session.tabUrl === 'string' &&
    typeof session.startedAt === 'number' &&
    Boolean(session.tasks) &&
    typeof session.tasks === 'object'
  );
}

async function readSessions(): Promise<MonitorSession[]> {
  const area = getStorageArea();
  if (!area) return [];
  try {
    const stored = await area.get(MONITOR_STORAGE_KEY);
    const raw = stored?.[MONITOR_STORAGE_KEY];
    return Array.isArray(raw) ? raw.filter(isSession) : [];
  } catch (error) {
    console.warn('[taskMonitor] 读取监控状态失败:', error);
    return [];
  }
}

async function writeSessions(sessions: MonitorSession[]): Promise<void> {
  const area = getStorageArea();
  if (!area) return;
  try {
    await area.set({ [MONITOR_STORAGE_KEY]: sessions.slice(-MAX_SESSIONS) });
  } catch (error) {
    console.warn('[taskMonitor] 写入监控状态失败:', error);
  }
}

async function syncAlarm(needed: boolean): Promise<void> {
  try {
    const existing = await chrome.alarms.get(MONITOR_ALARM_NAME);
    if (needed && !existing) {
      await chrome.alarms.create(MONITOR_ALARM_NAME, {
        periodInMinutes: ALARM_PERIOD_MINUTES,
      });
    } else if (!needed && existing) {
      await chrome.alarms.clear(MONITOR_ALARM_NAME);
    }
  } catch (error) {
    console.warn('[taskMonitor] 同步任务监控 alarm 失败:', error);
  }
}

export function ensureMonitorAlarm(): Promise<void> {
  return serialize(async () => {
    const sessions = await readSessions();
    await syncAlarm(sessions.length > 0);
  });
}

function reasonLabel(reason: StopReason): string {
  switch (reason) {
    case 'all-terminal':
      return '全部任务已结束';
    case 'no-task':
      return '未检测到新任务';
    case 'timeout':
      return '超过 24 小时监控上限';
    case 'tab-closed':
      return '迅雷页面已关闭';
    case 'page-unavailable':
      return '迅雷页面暂不可用';
    case 'disabled':
      return '已关闭任务监控';
    case 'missing':
      return '部分任务已从列表消失';
    default:
      return '监控已停止';
  }
}

function taskCounts(session: MonitorSession): {
  total: number;
  failed: number;
  completed: number;
} {
  const all = Object.values(session.tasks);
  return {
    total: all.length,
    failed: all.filter((task) => task.phase === 'PHASE_TYPE_ERROR').length,
    completed: all.filter((task) => task.phase === 'PHASE_TYPE_COMPLETE').length,
  };
}

async function stopSession(
  session: MonitorSession,
  reason: StopReason,
): Promise<void> {
  const counts = taskCounts(session);
  await updateMonitor(session.requestId, {
    status: reason === 'all-terminal' ? 'completed' : 'stopped',
    ...counts,
    reason: reasonLabel(reason),
  });
}

function activeTrackedIds(session: MonitorSession): string[] {
  return Object.values(session.tasks)
    .filter(
      (task) =>
        task.phase !== 'PHASE_TYPE_COMPLETE' &&
        task.phase !== 'PHASE_TYPE_ERROR' &&
        task.phase !== 'MISSING',
    )
    .map((task) => task.id);
}

function upsertTask(
  session: MonitorSession,
  id: string,
  item: TaskStateSnapshot['tasks'][string] | undefined,
  now: number,
): void {
  const existing = session.tasks[id];
  if (existing) {
    if (item) {
      if (item.name) existing.name = item.name;
      if (item.phase) existing.phase = item.phase;
      if (item.progress !== undefined) existing.progress = item.progress;
      if (item.detail) existing.detail = item.detail;
      existing.lastSeenAt = now;
      existing.missedScans = 0;
    }
    return;
  }
  session.tasks[id] = {
    id,
    name: item?.name ?? '',
    phase: item?.phase ?? '',
    progress: item?.progress,
    detail: item?.detail,
    lastSeenAt: now,
    missedScans: 0,
  };
}

async function processSession(
  session: MonitorSession,
  snapshot: TaskStateSnapshot,
  settings: ReturnType<typeof getSettings>,
  now: number,
): Promise<StopReason | null> {
  const snapshotTasks = snapshot.tasks;
  const currentIds = new Set(snapshot.currentIds);

  // 发现期：把基线与候选之外的新任务纳入监控
  if (now <= session.discoverUntil) {
    const known = new Set([...session.baselineIds, ...Object.keys(session.tasks)]);
    const fresh = new Set<string>();
    for (const id of currentIds) {
      if (!known.has(id)) fresh.add(id);
    }
    for (const id of session.candidateIds) {
      if (!known.has(id)) fresh.add(id);
    }

    for (const id of fresh) {
      if (Object.keys(session.tasks).length >= MAX_TASKS) break;
      const item = snapshotTasks[id];
      const isCandidate = session.candidateIds.includes(id);
      if (item?.type && !DOWNLOAD_TASK_TYPES.has(item.type) && !isCandidate) continue;
      // 基线不可靠时只收“正在下载”的任务，避免把历史 ERROR/COMPLETE 当成新任务；
      // 本次发送的候选 id 不受此限制。
      if (!session.baselineReliable && !isCandidate) {
        const phase = item?.phase ?? '';
        if (
          phase !== 'PHASE_TYPE_PENDING' &&
          phase !== 'PHASE_TYPE_RUNNING' &&
          phase !== 'PHASE_TYPE_PAUSED'
        ) {
          continue;
        }
      }
      upsertTask(session, id, item, now);
    }
  }

  // 候选 id 即使过了发现窗也继续尝试，它们明确属于本次发送
  for (const id of session.candidateIds) {
    if (session.tasks[id]) continue;
    const item = snapshotTasks[id];
    if (item) upsertTask(session, id, item, now);
  }
  session.candidateIds = session.candidateIds.filter((id) => !session.tasks[id]);

  // 跟踪期：快照里没有的任务，本轮先记为未见；超过阈值标记 MISSING
  for (const task of Object.values(session.tasks)) {
    const item = snapshotTasks[task.id];
    if (item) {
      upsertTask(session, task.id, item, now);
      continue;
    }
    if (task.phase === 'PHASE_TYPE_COMPLETE' || task.phase === 'PHASE_TYPE_ERROR') {
      continue;
    }
    task.missedScans += 1;
    if (task.missedScans > MISSED_LIMIT) task.phase = 'MISSING';
  }

  const failures = Object.values(session.tasks).filter(
    (task) => task.phase === 'PHASE_TYPE_ERROR' && !task.notifiedError,
  );
  const completions = Object.values(session.tasks).filter(
    (task) => task.phase === 'PHASE_TYPE_COMPLETE' && !task.notifiedComplete,
  );
  for (const task of failures) task.notifiedError = true;
  for (const task of completions) task.notifiedComplete = true;

  if (failures.length && settings.notifyOnDownloadFailure) {
    await showTaskFailure(failures.map((task) => ({ id: task.id, name: task.name })));
  }
  if (completions.length && settings.notifyOnDownloadComplete) {
    await showTaskComplete(completions.map((task) => ({ id: task.id, name: task.name })));
  }

  const counts = taskCounts(session);
  const summaryKey = `${counts.total}/${counts.failed}/${counts.completed}`;
  if (session.lastSummary !== summaryKey) {
    session.lastSummary = summaryKey;
    await updateMonitor(session.requestId, { status: 'active', ...counts });
  }

  if (now > session.hardUntil) return 'timeout';

  if (now > session.discoverUntil) {
    const all = Object.values(session.tasks);
    if (!all.length) return 'no-task';
    const active = all.filter(
      (task) =>
        task.phase !== 'PHASE_TYPE_COMPLETE' &&
        task.phase !== 'PHASE_TYPE_ERROR' &&
        task.phase !== 'MISSING',
    );
    if (!active.length) {
      const missing = all.filter((task) => task.phase === 'MISSING').length;
      return missing > 0 && counts.failed + counts.completed === 0 ? 'missing' : 'all-terminal';
    }
  }

  return null;
}

async function performScan(sessionsOverride?: MonitorSession[]): Promise<void> {
  await ensureSettingsLoaded();
  const settings = getSettings();
  const sessions = sessionsOverride ?? (await readSessions());

  if (!sessions.length) {
    await syncAlarm(false);
    return;
  }

  if (!settings.monitorDownloads) {
    for (const session of sessions) {
      await stopSession(session, 'disabled');
    }
    await writeSessions([]);
    await syncAlarm(false);
    return;
  }

  const now = Date.now();
  const remaining: MonitorSession[] = [];
  const byTab = new Map<string, MonitorSession[]>();
  for (const session of sessions) {
    const key = session.tabUrl.trim();
    const group = byTab.get(key) ?? [];
    group.push(session);
    byTab.set(key, group);
  }

  for (const [tabUrl, group] of byTab) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await findXunleiTab(tabUrl);
    } catch {
      tab = undefined;
    }

    if (tab?.id == null) {
      for (const session of group) {
        session.tabMissingScans += 1;
        if (session.tabMissingScans > TAB_MISSING_LIMIT) {
          await stopSession(session, 'tab-closed');
        } else {
          remaining.push(session);
        }
      }
      continue;
    }

    for (const session of group) {
      session.tabMissingScans = 0;
      let snapshot: TaskStateSnapshot | null = null;
      try {
        snapshot = await readTaskState(tab.id, activeTrackedIds(session), true);
      } catch {
        snapshot = null;
      }
      if (!snapshot) {
        session.failedScans += 1;
        if (session.failedScans > FAILED_SCAN_LIMIT) {
          await stopSession(session, 'page-unavailable');
        } else {
          remaining.push(session);
        }
        continue;
      }

      session.failedScans = 0;
      let stopReason: StopReason | null = null;
      try {
        stopReason = await processSession(session, snapshot, settings, now);
      } catch (error) {
        console.warn('[taskMonitor] 处理监控 session 失败:', error);
        session.failedScans += 1;
        if (session.failedScans > FAILED_SCAN_LIMIT) stopReason = 'page-unavailable';
      }
      if (stopReason) {
        await stopSession(session, stopReason);
      } else {
        remaining.push(session);
      }
    }
  }

  await writeSessions(remaining);
  await syncAlarm(remaining.length > 0);
}

/** 每分钟由 alarm 调用；同一时间只允许一个扫描 */
export function scanMonitors(): Promise<void> {
  return serialize(() => performScan());
}

export function startMonitor(input: StartMonitorInput): Promise<void> {
  return serialize(async () => {
    await ensureSettingsLoaded();
    if (!getSettings().monitorDownloads) return;

    const now = Date.now();
    const sessions = await readSessions();
    const session: MonitorSession = {
      requestId: input.requestId,
      tabUrl: input.tabUrl,
      mode: input.mode,
      startedAt: now,
      discoverUntil: now + (input.mode === 'confirm' ? DISCOVER_MS_CONFIRM : DISCOVER_MS_IMMEDIATE),
      hardUntil: now + HARD_TIMEOUT_MS,
      baselineIds: input.baselineIds.slice(0, MAX_BASELINE_IDS),
      baselineReliable: input.baselineReliable,
      candidateIds: (input.candidateIds ?? []).slice(0, MAX_TASKS),
      tasks: {},
      tabMissingScans: 0,
      failedScans: 0,
    };

    const next = [...sessions.filter((item) => item.requestId !== session.requestId), session];
    await writeSessions(next);
    await syncAlarm(true);
    // 立即扫描一次，尽快拿到任务名/状态；不通过 scanMonitors 避免重入锁
    await performScan(next);
  });
}
