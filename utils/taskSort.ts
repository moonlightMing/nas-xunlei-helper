import type { TaskSummary } from './messaging';

/**
 * popup「下载任务」列表的排序字段。`default` 保持服务端返回顺序
 * （接口按创建时间倒序下发，即最新任务在前），其余在 popup 本地排序。
 */
export type TaskSortField = 'default' | 'created' | 'progress' | 'speed' | 'size' | 'name';

export type TaskSortDir = 'asc' | 'desc';

export interface TaskSortPreference {
  field: TaskSortField;
  dir: TaskSortDir;
}

/** 切换到新字段时的自然方向：名称、创建时间旧值在前/后按直觉——名称正序，其余越大/越新越靠前 */
export const TASK_SORT_NATURAL_DIR: Record<Exclude<TaskSortField, 'default'>, TaskSortDir> = {
  created: 'desc',
  progress: 'desc',
  speed: 'desc',
  size: 'desc',
  name: 'asc',
};

export const DEFAULT_TASK_SORT: TaskSortPreference = { field: 'default', dir: 'desc' };

const FIELD_LABELS: Record<TaskSortField, string> = {
  default: '默认顺序',
  created: '创建时间',
  progress: '进度',
  speed: '速度',
  size: '大小',
  name: '名称',
};

/** 排序按钮上的短标签；`default` 无方向 */
export function taskSortLabel(field: TaskSortField, dir: TaskSortDir): string {
  if (field === 'default') return FIELD_LABELS[field];
  return `${FIELD_LABELS[field]} ${dir === 'asc' ? '↑' : '↓'}`;
}

/**
 * 菜单项标签：未选中的字段展示其自然方向（点击后得到的方向），
 * 当前选中的字段展示实际生效的方向。
 */
export function taskSortMenuLabel(field: TaskSortField, current: TaskSortPreference): string {
  if (field === 'default') return FIELD_LABELS[field];
  const dir = current.field === field ? current.dir : TASK_SORT_NATURAL_DIR[field];
  return taskSortLabel(field, dir);
}

/** 菜单点击后的下一个偏好：点击当前字段翻转方向，点击新字段落到自然方向 */
export function nextTaskSortPreference(
  current: TaskSortPreference,
  field: TaskSortField,
): TaskSortPreference {
  if (field === 'default') return { ...DEFAULT_TASK_SORT };
  if (current.field === field) {
    return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { field, dir: TASK_SORT_NATURAL_DIR[field] };
}

/** `storage.local` 读回值校验：字段非法一律回落默认，不让坏数据卡住列表 */
export function normalizeTaskSortPreference(input: unknown): TaskSortPreference {
  if (!input || typeof input !== 'object') return { ...DEFAULT_TASK_SORT };
  const field = (input as { field?: unknown }).field;
  const dir = (input as { dir?: unknown }).dir;
  if (field !== 'default' && field !== 'created' && field !== 'progress' && field !== 'speed' && field !== 'size' && field !== 'name') {
    return { ...DEFAULT_TASK_SORT };
  }
  return { field, dir: dir === 'asc' ? 'asc' : 'desc' };
}

/**
 * 按偏好排序，返回新数组不改入参。`default` 保持服务端顺序；
 * 数值同值时保持原相对次序（ES2019 起 sort 稳定），保证轮询刷新下列表不跳动。
 */
export function sortTasks(tasks: TaskSummary[], pref: TaskSortPreference): TaskSummary[] {
  const sorted = [...tasks];
  if (pref.field === 'default' || sorted.length < 2) return sorted;
  const sign = pref.dir === 'asc' ? 1 : -1;
  switch (pref.field) {
    case 'created':
      // createdAt 为 0（服务端未返回）时排在已知时间之后（desc）/之前（asc）
      sorted.sort((a, b) => sign * (a.createdAt - b.createdAt));
      break;
    case 'progress':
      sorted.sort((a, b) => sign * (a.progress - b.progress));
      break;
    case 'speed':
      sorted.sort((a, b) => sign * (a.speed - b.speed));
      break;
    case 'size':
      sorted.sort((a, b) => sign * (a.totalSize - b.totalSize));
      break;
    case 'name':
      sorted.sort((a, b) => sign * a.name.localeCompare(b.name, 'zh-Hans-CN'));
      break;
  }
  return sorted;
}
