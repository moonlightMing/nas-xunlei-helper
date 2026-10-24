/**
 * 接口直连「确认后下载」的中间状态与纯决策函数。
 *
 * 后台解析链接后不直接建任务，而是把文件树/预选结果写入 storage.session，
 * 再打开扩展自己的确认窗口；窗口提交只回传用户勾选的文件 id，由后台重新
 * 校验并映射成迅雷的 sub_file_index。这样确认窗口不需要接触接口令牌，
 * 也不会把完整文件列表塞进消息或发送记录。
 */

import { encodeSubFileIndex, type MatchSummary } from '@/utils/avMatch';
import type { SendSource } from '@/utils/messaging';

export const PENDING_CONFIRM_KEY = 'nas_xunlei_pending_confirm';
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface ConfirmFile {
  id: string;
  name: string;
  path: string;
  size: number;
  fileIndex: number;
}

export interface ConfirmTask {
  link: string;
  /** 通知/列表里展示的短标签 */
  label: string;
  kind: 'bt' | 'direct';
  name: string;
  /** 任务整包大小（字节） */
  size: number;
  totalFileCount: number;
  files: ConfirmFile[];
  /** 番号匹配/默认规则给出的预选文件 id */
  preselectedIds: string[];
  /** 文件树被截断或不完整时不能逐文件选择，只能整包下载 */
  selectionDisabled: boolean;
  /** 整包下载是否默认勾选（回退模式为 true） */
  wholePackageDefault: boolean;
  matchStatus?: string;
  note?: string;
}

export interface ConfirmPath {
  id: string;
  path: string;
  name: string;
}

export interface PendingConfirmation {
  id: string;
  historyId: string;
  source: SendSource;
  notify: boolean;
  links: string[];
  createdAt: number;
  /** 建任务用的 NAS 迅雷地址（确认窗口不直接接触设置） */
  url: string;
  space: string;
  tasks: ConfirmTask[];
  paths: ConfirmPath[];
  parentFolderId: string;
  path: string;
  pathApplied?: {
    needed: boolean;
    applied: boolean;
    resolvedPath?: string;
    reason?: string;
  };
  match?: MatchSummary;
  matchText?: string;
  message: string;
  windowId?: number;
}

export interface ConfirmSelectionInput {
  link: string;
  include: boolean;
  name?: string;
  selectedIds?: string[];
  wholePackage?: boolean;
}

export interface ConfirmCreateSpec {
  url: string;
  name?: string;
  fileSize?: number;
  totalFileCount?: number;
  subFileIndex?: string;
}

export interface ConfirmSubmissionPlan {
  specs: ConfirmCreateSpec[];
  skipped: string[];
}

function getSessionArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
  } catch {
    return null;
  }
}

function isPending(value: unknown): value is PendingConfirmation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingConfirmation>;
  return typeof record.id === 'string' && typeof record.createdAt === 'number' && Array.isArray(record.tasks);
}

async function readAll(): Promise<Record<string, PendingConfirmation>> {
  const area = getSessionArea();
  if (!area) return {};
  try {
    const stored = await area.get(PENDING_CONFIRM_KEY);
    const raw = stored?.[PENDING_CONFIRM_KEY];
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, PendingConfirmation] =>
        isPending(entry[1]),
      ),
    );
  } catch (error) {
    console.warn('[confirm] 读取待确认任务失败:', error);
    return {};
  }
}

async function writeAll(all: Record<string, PendingConfirmation>): Promise<void> {
  const area = getSessionArea();
  if (!area) return;
  try {
    if (Object.keys(all).length) await area.set({ [PENDING_CONFIRM_KEY]: all });
    else await area.remove(PENDING_CONFIRM_KEY);
  } catch (error) {
    console.warn('[confirm] 保存待确认任务失败:', error);
    throw error;
  }
}

export function createConfirmId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function savePendingConfirmation(pending: PendingConfirmation): Promise<void> {
  const all = await readAll();
  all[pending.id] = pending;
  await writeAll(all);
}

export async function getPendingConfirmation(id: string): Promise<PendingConfirmation | null> {
  const all = await readAll();
  return all[id] ?? null;
}

export async function deletePendingConfirmation(id: string): Promise<void> {
  const all = await readAll();
  if (!(id in all)) return;
  delete all[id];
  await writeAll(all);
}

export async function setPendingWindowId(id: string, windowId: number): Promise<void> {
  const all = await readAll();
  const pending = all[id];
  if (!pending) return;
  pending.windowId = windowId;
  await writeAll(all);
}

export async function findPendingByWindowId(windowId: number): Promise<PendingConfirmation | null> {
  const all = await readAll();
  return Object.values(all).find((pending) => pending.windowId === windowId) ?? null;
}

/** 清理超时未确认的条目，返回被清理的 pending（调用方负责回写历史） */
export async function pruneExpiredConfirmations(now = Date.now()): Promise<PendingConfirmation[]> {
  const all = await readAll();
  const expired = Object.values(all).filter((pending) => now - pending.createdAt > PENDING_TTL_MS);
  if (!expired.length) return [];
  for (const pending of expired) delete all[pending.id];
  await writeAll(all);
  return expired;
}

export interface ConfirmTreeNode {
  key: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  file?: ConfirmFile;
  children: ConfirmTreeNode[];
}

/** 把拍平的文件列表还原成目录树（path 已包含子目录，不含任务根名） */
export function buildConfirmTree(files: ConfirmFile[]): ConfirmTreeNode[] {
  const roots: ConfirmTreeNode[] = [];
  const dirs = new Map<string, ConfirmTreeNode>();

  for (const file of files) {
    const segments = (file.path || file.name).split('/').filter(Boolean);
    let level = roots;
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      let node = dirs.get(prefix);
      if (!node) {
        node = {
          key: `dir:${prefix}`,
          name: segments[index],
          path: prefix,
          isDir: true,
          size: 0,
          children: [],
        };
        dirs.set(prefix, node);
        level.push(node);
      }
      node.size += file.size;
      level = node.children;
    }
    const name = segments[segments.length - 1] || file.name;
    level.push({
      key: `file:${file.id}`,
      name,
      path: file.path || name,
      isDir: false,
      size: file.size,
      file,
      children: [],
    });
  }

  return roots;
}

/**
 * 把确认窗口回传的勾选映射成建任务参数。
 * - 未包含 / BT 空选择 → 跳过，不退化成整包
 * - 文件树不完整或显式整包 → 不传 sub_file_index
 * - 文件 id 必须在 pending 里存在，否则忽略
 */
export function buildConfirmCreateSpecs(
  pending: PendingConfirmation,
  selections: ConfirmSelectionInput[],
): ConfirmSubmissionPlan {
  const inputByLink = new Map(selections.map((item) => [item.link, item]));
  const specs: ConfirmCreateSpec[] = [];
  const skipped: string[] = [];

  for (const task of pending.tasks) {
    const input = inputByLink.get(task.link);
    if (!input || !input.include) {
      skipped.push(task.label);
      continue;
    }

    const name = input.name?.trim() || task.name;
    if (task.kind === 'direct') {
      specs.push({
        url: task.link,
        name,
        fileSize: task.size || undefined,
        totalFileCount: task.totalFileCount || undefined,
      });
      continue;
    }

    if (task.selectionDisabled) {
      // 文件树不完整时只接受显式整包，绝不按 selectedIds 猜部分文件
      if (!input.wholePackage) {
        skipped.push(task.label);
        continue;
      }
      specs.push({
        url: task.link,
        name,
        fileSize: task.size || undefined,
        totalFileCount: task.totalFileCount || undefined,
      });
      continue;
    }

    if (input.wholePackage) {
      specs.push({
        url: task.link,
        name,
        fileSize: task.size || undefined,
        totalFileCount: task.totalFileCount || undefined,
      });
      continue;
    }

    const wanted = new Set(input.selectedIds ?? []);
    const selected = task.files.filter((file) => wanted.has(file.id));
    if (!selected.length) {
      skipped.push(task.label);
      continue;
    }
    const subFileIndex = encodeSubFileIndex(selected.map((file) => file.fileIndex));
    if (!subFileIndex) {
      skipped.push(task.label);
      continue;
    }
    specs.push({
      url: task.link,
      name,
      fileSize: selected.reduce((sum, file) => sum + file.size, 0) || undefined,
      totalFileCount: task.totalFileCount || undefined,
      subFileIndex,
    });
  }

  return { specs, skipped };
}
