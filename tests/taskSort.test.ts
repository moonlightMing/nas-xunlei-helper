import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '@/utils/messaging';
import {
  DEFAULT_TASK_SORT,
  DEFAULT_TASK_SORT_MAP,
  nextTaskSortPreference,
  nextTaskSortPreferenceMap,
  normalizeTaskSortPreference,
  normalizeTaskSortPreferenceMap,
  sortTasks,
  TASK_SORT_FIELDS_BY_SCOPE,
  taskSortLabel,
  taskSortMenuLabel,
} from '@/utils/taskSort';

function task(partial: Partial<TaskSummary>): TaskSummary {
  return {
    id: 't',
    name: '',
    type: 'user#download-url',
    phase: 'PHASE_TYPE_RUNNING',
    progress: 0,
    speed: 0,
    totalSize: 0,
    checkedSize: 0,
    realPath: '',
    message: '',
    createdAt: 0,
    ...partial,
  };
}

describe('sortTasks', () => {
  const serverOrder = [
    task({ id: 'a', name: 'aaa', progress: 10, speed: 100, totalSize: 300, createdAt: 3000 }),
    task({ id: 'b', name: 'bbb', progress: 90, speed: 300, totalSize: 100, createdAt: 1000 }),
    task({ id: 'c', name: 'ccc', progress: 50, speed: 200, totalSize: 200, createdAt: 2000 }),
  ];

  it('默认偏好（创建时间降序）保持服务端顺序且不改入参', () => {
    const input = [...serverOrder];
    const result = sortTasks(input, DEFAULT_TASK_SORT);
    expect(result.map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect(result).not.toBe(input);
    expect(input.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('进度降序：快完成的在前；同值保持原相对次序', () => {
    const ties = [
      task({ id: 'x', progress: 50 }),
      task({ id: 'y', progress: 100 }),
      task({ id: 'z', progress: 50 }),
    ];
    expect(sortTasks(ties, { field: 'progress', dir: 'desc' }).map((t) => t.id)).toEqual([
      'y',
      'x',
      'z',
    ]);
    expect(sortTasks(ties, { field: 'progress', dir: 'asc' }).map((t) => t.id)).toEqual([
      'x',
      'z',
      'y',
    ]);
  });

  it('速度、大小默认降序（越大越靠前）', () => {
    expect(sortTasks(serverOrder, { field: 'speed', dir: 'desc' }).map((t) => t.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(sortTasks(serverOrder, { field: 'size', dir: 'desc' }).map((t) => t.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('名称按字典序正序', () => {
    const names = [task({ id: '2', name: 'ccc' }), task({ id: '1', name: 'aaa' }), task({ id: '3', name: 'bbb' })];
    expect(sortTasks(names, { field: 'name', dir: 'asc' }).map((t) => t.id)).toEqual([
      '1',
      '3',
      '2',
    ]);
  });

  it('创建时间默认降序（最新在前），未知时间（0）排已知时间之后', () => {
    const times = [
      task({ id: 'old', createdAt: Date.parse('2026-10-30T08:15:20.516+08:00') }),
      task({ id: 'unknown', createdAt: 0 }),
      task({ id: 'new', createdAt: Date.parse('2026-10-30T08:17:53.486+08:00') }),
      task({ id: 'mid', createdAt: Date.parse('2026-10-30T08:16:57.102+08:00') }),
    ];
    expect(sortTasks(times, { field: 'created', dir: 'desc' }).map((t) => t.id)).toEqual([
      'new',
      'mid',
      'old',
      'unknown',
    ]);
    expect(sortTasks(times, { field: 'created', dir: 'asc' }).map((t) => t.id)).toEqual([
      'unknown',
      'old',
      'mid',
      'new',
    ]);
  });

  it('单条与空列表直接返回', () => {
    const single = [task({ id: 'a' })];
    expect(sortTasks(single, { field: 'speed', dir: 'desc' })).toHaveLength(1);
    expect(sortTasks([], { field: 'speed', dir: 'desc' })).toEqual([]);
  });
});

describe('nextTaskSortPreference', () => {
  it('点击新字段落到自然方向', () => {
    expect(nextTaskSortPreference(DEFAULT_TASK_SORT, 'progress')).toEqual({
      field: 'progress',
      dir: 'desc',
    });
    expect(nextTaskSortPreference(DEFAULT_TASK_SORT, 'name')).toEqual({ field: 'name', dir: 'asc' });
  });

  it('点击当前字段翻转方向', () => {
    expect(nextTaskSortPreference(DEFAULT_TASK_SORT, 'created')).toEqual({
      field: 'created',
      dir: 'asc',
    });
    expect(nextTaskSortPreference({ field: 'speed', dir: 'desc' }, 'speed')).toEqual({
      field: 'speed',
      dir: 'asc',
    });
    expect(nextTaskSortPreference({ field: 'name', dir: 'asc' }, 'name')).toEqual({
      field: 'name',
      dir: 'desc',
    });
  });
});

describe('normalizeTaskSortPreference', () => {  it('合法值原样保留', () => {
    expect(normalizeTaskSortPreference({ field: 'size', dir: 'asc' })).toEqual({
      field: 'size',
      dir: 'asc',
    });
    expect(normalizeTaskSortPreference({ field: 'created', dir: 'desc' })).toEqual({
      field: 'created',
      dir: 'desc',
    });
  });

  it('非法输入回落默认：未知字段、旧版 default、方向、非对象', () => {
    expect(normalizeTaskSortPreference({ field: 'evil', dir: 'desc' })).toEqual(DEFAULT_TASK_SORT);
    // 旧版存的 {field:'default'} 无感迁移到创建时间降序（与服务端原序渲染一致）
    expect(normalizeTaskSortPreference({ field: 'default', dir: 'desc' })).toEqual(
      DEFAULT_TASK_SORT,
    );
    expect(normalizeTaskSortPreference({ field: 'speed', dir: 'sideways' })).toEqual({
      field: 'speed',
      dir: 'desc',
    });
    expect(normalizeTaskSortPreference(null)).toEqual(DEFAULT_TASK_SORT);
    expect(normalizeTaskSortPreference('speed')).toEqual(DEFAULT_TASK_SORT);
    expect(normalizeTaskSortPreference(undefined)).toEqual(DEFAULT_TASK_SORT);
  });
});

describe('双页签偏好', () => {
  it('已完成页签不提供进度/速度（恒定值无排序意义），进行中提供全部五项', () => {
    expect(TASK_SORT_FIELDS_BY_SCOPE.ing).toEqual(['created', 'progress', 'speed', 'size', 'name']);
    expect(TASK_SORT_FIELDS_BY_SCOPE.done).toEqual(['created', 'size', 'name']);
  });

  it('nextTaskSortPreferenceMap 只更新目标页签，不改入参', () => {
    const map = {
      ing: { field: 'created', dir: 'desc' } as const,
      done: { field: 'size', dir: 'desc' } as const,
    };
    const next = nextTaskSortPreferenceMap(map, 'done', 'size');
    expect(next.done).toEqual({ field: 'size', dir: 'asc' });
    expect(next.ing).toEqual(map.ing);
    expect(next).not.toBe(map);
    expect(map.done.dir).toBe('desc');
  });

  it('新双页签格式逐页签归一化，非法页签值回落默认', () => {
    expect(
      normalizeTaskSortPreferenceMap({
        ing: { field: 'speed', dir: 'asc' },
        done: { field: 'evil', dir: 'desc' },
      }),
    ).toEqual({
      ing: { field: 'speed', dir: 'asc' },
      done: DEFAULT_TASK_SORT_MAP.done,
    });
  });

  it('旧单页签格式迁移：视为进行中的偏好，已完成用默认', () => {
    expect(normalizeTaskSortPreferenceMap({ field: 'size', dir: 'asc' })).toEqual({
      ing: { field: 'size', dir: 'asc' },
      done: DEFAULT_TASK_SORT_MAP.done,
    });
    // 旧版「默认顺序」偏好迁移后与创建时间降序等价
    expect(normalizeTaskSortPreferenceMap({ field: 'default', dir: 'desc' })).toEqual(
      DEFAULT_TASK_SORT_MAP,
    );
    expect(normalizeTaskSortPreferenceMap(null)).toEqual(DEFAULT_TASK_SORT_MAP);
    expect(normalizeTaskSortPreferenceMap('junk')).toEqual(DEFAULT_TASK_SORT_MAP);
  });
});

describe('标签', () => {
  it('按钮标签带方向箭头', () => {
    expect(taskSortLabel('created', 'desc')).toBe('创建时间 ↓');
    expect(taskSortLabel('speed', 'desc')).toBe('速度 ↓');
    expect(taskSortLabel('name', 'asc')).toBe('名称 ↑');
  });

  it('菜单标签：未选中项展示自然方向，选中项展示当前方向', () => {
    expect(taskSortMenuLabel('created', DEFAULT_TASK_SORT)).toBe('创建时间 ↓');
    expect(taskSortMenuLabel('created', { field: 'created', dir: 'asc' })).toBe('创建时间 ↑');
    expect(taskSortMenuLabel('speed', DEFAULT_TASK_SORT)).toBe('速度 ↓');
    expect(taskSortMenuLabel('speed', { field: 'speed', dir: 'asc' })).toBe('速度 ↑');
    expect(taskSortMenuLabel('name', DEFAULT_TASK_SORT)).toBe('名称 ↑');
  });
});
