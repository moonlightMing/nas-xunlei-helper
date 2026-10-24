import { describe, expect, it } from 'vitest';
import {
  buildMatchPlan,
  encodeSubFileIndex,
  extractCodeCandidates,
  selectSubFiles,
  type AvMatchSettings,
  type FileListSnapshot,
} from '@/utils/avMatch';

const BASE_SETTINGS: AvMatchSettings = {
  enabled: true,
  manualCodes: [],
  keepCategories: ['video'],
  minFileSizeMB: 0,
  maxFilesPerTask: 0,
  sort: 'size-desc',
  excludeKeywords: ['sample', 'trailer', '预告', '广告', '宣传', '网址', '说明'],
  fallbackToDefault: false,
};

function btSnapshot(
  rootName: string,
  names: string[],
  extras: Partial<FileListSnapshot> = {},
): FileListSnapshot {
  return {
    kind: 'bt',
    treeHash: `hash:${rootName}`,
    groups: [
      {
        rootId: 'root-1',
        rootName,
        files: names.map((name, index) => ({
          id: `f${index}`,
          name,
          path: name,
          size: 1000,
        })),
      },
    ],
    checkedIds: [],
    buttonDisabled: false,
    truncated: false,
    ...extras,
  };
}

describe('encodeSubFileIndex（sub_file_index 折叠算法）', () => {
  it('连续段折叠为 a-b，单点写 n', () => {
    expect(encodeSubFileIndex([0, 1, 2, 4])).toBe('0-2,4');
    expect(encodeSubFileIndex([3])).toBe('3');
    expect(encodeSubFileIndex([0, 2, 3, 4, 6, 7])).toBe('0,2-4,6-7');
  });

  it('乱序与重复索引先排序去重', () => {
    expect(encodeSubFileIndex([4, 0, 2, 1, 2])).toBe('0-2,4');
  });

  it('负数（序号推导失败）一律剔除', () => {
    expect(encodeSubFileIndex([-1, 2])).toBe('2');
    expect(encodeSubFileIndex([-1, -2])).toBe('');
  });
});

describe('extractCodeCandidates 边界', () => {
  it('标准码提取', () => {
    const candidates = extractCodeCandidates('ABC-123.mp4');
    expect(candidates[0]?.code).toBe('ABC-123');
  });

  it('FC2 数字超过 8 位不截取前 8 位（右边界）', () => {
    expect(extractCodeCandidates('FC2-12345678901.mp4')).toEqual([]);
    expect(extractCodeCandidates('FC2-123456.mp4')[0]?.code).toBe('FC2-123456');
  });

  it('file01/track01 等通用序号名不产生伪番号候选', () => {
    expect(extractCodeCandidates('file01.mp4')).toEqual([]);
    expect(extractCodeCandidates('track02.mp4')).toEqual([]);
    expect(extractCodeCandidates('scene1.mkv')).toEqual([]);
  });
});

describe('buildMatchPlan', () => {
  it('文件名都不带番号时按根名兜底继承（文件夹包场景）', () => {
    const plan = buildMatchPlan(btSnapshot('ABC-123', ['video1.mp4', 'video2.mp4']), BASE_SETTINGS);
    expect(plan.status).toBe('applied');
    expect(plan.selectedIds).toHaveLength(2);
  });

  it('有文件命中后，其余无番号文件一律 code-mismatch（不继承广告）', () => {
    const plan = buildMatchPlan(
      btSnapshot('ABC-123', ['ABC-123.mp4', 'ad1.mp4', 'ad2.mp4']),
      BASE_SETTINGS,
    );
    expect(plan.status).toBe('applied');
    expect(plan.selectedIds).toEqual(['f0']);
  });

  it('纯数字长串不会误命中加勒比日期码（边界匹配回归）', () => {
    // 多数文件命中的场景下，无候选文件走 boundaryMatch 兜底：
    // "1060819917" 去掉分隔符后是 "060819917" 的超串，旧实现按子串误判命中
    const plan = buildMatchPlan(
      btSnapshot('合集包', ['060819-917.mp4', '1060819917.mp4']),
      BASE_SETTINGS,
    );
    expect(plan.status).toBe('applied');
    expect(plan.selectedIds).toEqual(['f0']);
  });

  it('文件树截断时跳过匹配（too-many-files）', () => {
    const plan = buildMatchPlan(
      btSnapshot('ABC-123', ['ABC-123.mp4'], { truncated: true }),
      BASE_SETTINGS,
    );
    expect(plan.status).toBe('skipped');
    expect(plan.skipped).toBe('too-many-files');
  });

  it('非 BT 快照按 no-file-list 跳过', () => {
    const plan = buildMatchPlan(btSnapshot('x', ['a.mp4'], { kind: 'single' }), BASE_SETTINGS);
    expect(plan.skipped).toBe('no-file-list');
  });

  it('excludeKeywords 把唯一带番号的文件滤掉时会触发根名兜底（已知行为，防回归记录）', () => {
    // 该行为会把无番号文件（常是广告）整体选中，改动规则时必须连这条一起评估
    const plan = buildMatchPlan(
      btSnapshot('ABC-123', ['ABC-123 sample.mp4', 'ad1.mp4']),
      BASE_SETTINGS,
    );
    expect(plan.selectedIds).toEqual(['f1']);
  });

  it('maxFilesPerTask 只保留排序前的 N 个', () => {
    const plan = buildMatchPlan(btSnapshot('ABC-123', ['ABC-123-B.mp4', 'ABC-123-A.mp4']), {
      ...BASE_SETTINGS,
      maxFilesPerTask: 1,
      sort: 'name-asc',
    });
    expect(plan.selectedIds).toEqual(['f1']);
  });
});

describe('selectSubFiles（接口模式落地）', () => {
  const files = [
    { id: 'a', fileIndex: 0, size: 100 },
    { id: 'b', fileIndex: 1, size: 200 },
    { id: 'c', fileIndex: 4, size: 50 },
    { id: 'bad', fileIndex: -1, size: 999 },
  ];

  it('选中序号折叠并按选中文件求大小', () => {
    const selection = selectSubFiles(
      { selectedIds: ['a', 'b', 'c'] },
      files,
      9999,
      'strict',
    );
    expect(selection.subFileIndex).toBe('0-1,4');
    expect(selection.fileSize).toBe(350);
    expect(selection.skippedUnmatched).toBe(false);
  });

  it('序号推导失败（-1）的文件不进索引串也不计入大小', () => {
    const selection = selectSubFiles({ selectedIds: ['bad', 'a'] }, files, 9999, 'strict');
    expect(selection.subFileIndex).toBe('0');
    expect(selection.fileSize).toBe(100);
  });

  it('编码为空时严格模式按未命中、回退模式整包', () => {
    const strict = selectSubFiles({ selectedIds: ['bad'] }, files, 9999, 'strict');
    expect(strict.skippedUnmatched).toBe(true);
    const fallback = selectSubFiles({ selectedIds: ['bad'] }, files, 9999, 'fallback');
    expect(fallback.subFileIndex).toBe('');
    expect(fallback.fileSize).toBe(9999);
    expect(fallback.skippedUnmatched).toBe(false);
  });
});
