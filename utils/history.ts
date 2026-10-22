import type { DownloadMode } from '@/utils/settings';
import type { SendErrorCode } from '@/utils/sendErrors';
import type { SendSource } from '@/utils/messaging';
import type { PathApplied, SendOutcome } from '@/utils/xunleiAutomation';

export const HISTORY_STORAGE_KEY = 'nas_xunlei_history';
export const HISTORY_LIMIT = 50;
const MAX_LINKS_PER_ENTRY = 50;
const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export interface HistoryMonitorSummary {
  status: 'active' | 'completed' | 'stopped';
  total: number;
  failed: number;
  completed: number;
  reason?: string;
}

export interface SendHistoryEntry {
  id: string;
  at: number;
  updatedAt: number;
  source: SendSource;
  links: string[];
  linkCount: number;
  mode: DownloadMode;
  path: string;
  status: 'running' | 'ok' | 'failed' | 'partial';
  stage: SendOutcome['stage'];
  code?: SendErrorCode;
  message: string;
  pathApplied?: PathApplied;
  monitor?: HistoryMonitorSummary;
}

export interface StartHistoryInput {
  source: SendSource;
  links: string[];
  mode: DownloadMode;
  path: string;
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
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

function isHistoryEntry(value: unknown): value is SendHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SendHistoryEntry>;
  return typeof entry.id === 'string' && typeof entry.at === 'number' && Array.isArray(entry.links);
}

async function readEntries(area: chrome.storage.StorageArea): Promise<SendHistoryEntry[]> {
  try {
    const stored = await area.get(HISTORY_STORAGE_KEY);
    const raw = stored?.[HISTORY_STORAGE_KEY];
    return Array.isArray(raw) ? raw.filter(isHistoryEntry) : [];
  } catch (error) {
    console.warn('[history] 读取发送历史失败:', error);
    return [];
  }
}

function mutate(
  updater: (entries: SendHistoryEntry[]) => SendHistoryEntry[],
): Promise<void> {
  return enqueue(async () => {
    const area = getStorageArea();
    if (!area) return;
    const entries = await readEntries(area);
    const next = updater(entries).slice(0, HISTORY_LIMIT);
    try {
      await area.set({ [HISTORY_STORAGE_KEY]: next });
    } catch (error) {
      console.warn('[history] 写入发送历史失败:', error);
    }
  });
}

export function createHistoryId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function startEntry(input: StartHistoryInput): Promise<string> {
  const id = createHistoryId();
  const now = Date.now();
  const links = input.links.slice(0, MAX_LINKS_PER_ENTRY);
  const entry: SendHistoryEntry = {
    id,
    at: now,
    updatedAt: now,
    source: input.source,
    links,
    linkCount: links.length,
    mode: input.mode,
    path: input.path,
    status: 'running',
    stage: 'prepare',
    message: '正在发送…',
  };
  await mutate((entries) => [entry, ...entries.filter((item) => item.id !== id)]);
  return id;
}

export function finishEntry(
  id: string,
  patch: Partial<Omit<SendHistoryEntry, 'id' | 'at' | 'updatedAt'>>,
): Promise<void> {
  return mutate((entries) =>
    entries.map((entry) =>
      entry.id === id ? { ...entry, ...patch, updatedAt: Date.now() } : entry,
    ),
  );
}

export function updateMonitor(id: string, monitor: HistoryMonitorSummary): Promise<void> {
  return mutate((entries) =>
    entries.map((entry) =>
      entry.id === id ? { ...entry, monitor, updatedAt: Date.now() } : entry,
    ),
  );
}

export async function listHistory(): Promise<SendHistoryEntry[]> {
  const area = getStorageArea();
  if (!area) return [];
  const entries = await readEntries(area);
  return entries.sort((a, b) => b.at - a.at);
}

export function clearHistory(): Promise<void> {
  return enqueue(async () => {
    const area = getStorageArea();
    if (!area) return;
    try {
      await area.set({ [HISTORY_STORAGE_KEY]: [] });
    } catch (error) {
      console.warn('[history] 清空发送历史失败:', error);
    }
  });
}

export function watchHistory(onChange: (entries: SendHistoryEntry[]) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'local' && changes[HISTORY_STORAGE_KEY]) {
      void listHistory().then(onChange);
    }
  };
  try {
    chrome.storage.onChanged.addListener(listener);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

/** Service Worker 重启后，把长时间停在 running 的记录标记为发送中断 */
export function markInterruptedRuns(): Promise<void> {
  const now = Date.now();
  return mutate((entries) =>
    entries.map((entry) => {
      if (entry.status !== 'running' || now - entry.updatedAt < INTERRUPTED_AFTER_MS) return entry;
      return {
        ...entry,
        status: 'failed' as const,
        code: 'unknown' as const,
        message: '发送中断（扩展或浏览器被重启）',
        updatedAt: now,
      };
    }),
  );
}
