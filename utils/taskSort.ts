import type { TaskSummary } from './messaging';

/**
 * popup「下载任务」列表的排序字段。列表数据来自接口的原序下发
 * （创建时间倒序），排序在 popup 本地完成；不设「默认顺序」项，
 * 初始偏好即创建时间降序，与不排序时的服务端顺序一致。
 */
export type TaskSortField = 'created' | 'progress' | 'speed' | 'size' | 'name';

export type TaskSortDir = 'asc' | 'desc';

/** 任务页签：进行中 / 已完成 */
export type TaskScope = 'ing' | 'done';

export interface TaskSortPreference {
  field: TaskSortField;
  dir: TaskSortDir;
}

/**
 * 两个页签各自记忆排序偏好。已完成任务进度恒 100%、速度恒 0，
 * 菜单收敛为创建时间/大小/名称。
 */
export interface TaskSortPreferenceMap {
  ing: TaskSortPreference;
  done: TaskSortPreference;
}

/** 各页签可用的排序字段（菜单顺序即展示顺序） */
export const TASK_SORT_FIELDS_BY_SCOPE: Record<TaskScope, TaskSortField[]> = {
  ing: ['created', 'progress', 'speed', 'size', 'name'],
  done: ['created', 'size', 'name'],
};

/** 切换到新字段时的自然方向：名称按字典序正序，其余越大/越新越靠前 */
export const TASK_SORT_NATURAL_DIR: Record<TaskSortField, TaskSortDir> = {
  created: 'desc',
  progress: 'desc',
  speed: 'desc',
  size: 'desc',
  name: 'asc',
};

export const DEFAULT_TASK_SORT: TaskSortPreference = { field: 'created', dir: 'desc' };

export const DEFAULT_TASK_SORT_MAP: TaskSortPreferenceMap = {
  ing: { ...DEFAULT_TASK_SORT },
  done: { ...DEFAULT_TASK_SORT },
};

const FIELD_LABELS: Record<TaskSortField, string> = {
  created: '创建时间',
  progress: '进度',
  speed: '速度',
  size: '大小',
  name: '名称',
};

/** 排序按钮上的短标签 */
export function taskSortLabel(field: TaskSortField, dir: TaskSortDir): string {
  return `${FIELD_LABELS[field]} ${dir === 'asc' ? '↑' : '↓'}`;
}

/**
 * 菜单项标签：未选中的字段展示其自然方向（点击后得到的方向），
 * 当前选中的字段展示实际生效的方向。
 */
export function taskSortMenuLabel(field: TaskSortField, current: TaskSortPreference): string {
  const dir = current.field === field ? current.dir : TASK_SORT_NATURAL_DIR[field];
  return taskSortLabel(field, dir);
}

/** 菜单点击后的下一个偏好：点击当前字段翻转方向，点击新字段落到自然方向 */
export function nextTaskSortPreference(
  current: TaskSortPreference,
  field: TaskSortField,
): TaskSortPreference {
  if (current.field === field) {
    return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { field, dir: TASK_SORT_NATURAL_DIR[field] };
}

/** 在按页签的偏好表上更新指定页签，返回新表不改入参 */
export function nextTaskSortPreferenceMap(
  map: TaskSortPreferenceMap,
  scope: TaskScope,
  field: TaskSortField,
): TaskSortPreferenceMap {
  return { ...map, [scope]: nextTaskSortPreference(map[scope], field) };
}

/**
 * `storage.local` 读回值校验：字段非法（含旧版的 default）一律回落
 * 创建时间降序，不让坏数据卡住列表；created 降序恰与旧「默认顺序」
 * 的服务端原序渲染一致，旧偏好无感迁移。兼容两种存储格式——
 * 旧单页签 `{field, dir}`（视为进行中的偏好）与新双页签 `{ing, done}`。
 */
export function normalizeTaskSortPreference(input: unknown): TaskSortPreference {
  if (!input || typeof input !== 'object') return { ...DEFAULT_TASK_SORT };
  const field = (input as { field?: unknown }).field;
  const dir = (input as { dir?: unknown }).dir;
  if (field !== 'created' && field !== 'progress' && field !== 'speed' && field !== 'size' && field !== 'name') {
    return { ...DEFAULT_TASK_SORT };
  }
  return { field, dir: dir === 'asc' ? 'asc' : 'desc' };
}

export function normalizeTaskSortPreferenceMap(input: unknown): TaskSortPreferenceMap {
  if (!input || typeof input !== 'object') return cloneTaskSortMap(DEFAULT_TASK_SORT_MAP);
  const rec = input as Record<string, unknown>;
  if (rec.ing !== undefined || rec.done !== undefined) {
    return {
      ing: normalizeTaskSortPreference(rec.ing),
      done: normalizeTaskSortPreference(rec.done),
    };
  }
  return {
    ing: normalizeTaskSortPreference(input),
    done: { ...DEFAULT_TASK_SORT_MAP.done },
  };
}

function cloneTaskSortMap(map: TaskSortPreferenceMap): TaskSortPreferenceMap {
  return { ing: { ...map.ing }, done: { ...map.done } };
}

/**
 * 按偏好排序，返回新数组不改入参。数值同值时保持原相对次序
 * （ES2019 起 sort 稳定），保证轮询刷新下列表不跳动。
 */
export function sortTasks(tasks: TaskSummary[], pref: TaskSortPreference): TaskSummary[] {
  const sorted = [...tasks];
  if (sorted.length < 2) return sorted;
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
