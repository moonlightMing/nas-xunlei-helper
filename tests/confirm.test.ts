import { describe, expect, it } from 'vitest';
import {
  buildConfirmCreateSpecs,
  buildConfirmTree,
  type ConfirmFile,
  type PendingConfirmation,
} from '@/utils/confirm';

function file(id: string, path: string, fileIndex: number, size = 100): ConfirmFile {
  const name = path.split('/').pop() ?? path;
  return { id, name, path, size, fileIndex };
}

function pending(tasks: PendingConfirmation['tasks']): PendingConfirmation {
  return {
    id: 'p1',
    historyId: 'h1',
    source: 'popup',
    notify: false,
    links: tasks.map((task) => task.link),
    createdAt: Date.now(),
    url: 'http://nas.local:5000',
    space: 'dev#1',
    tasks,
    paths: [{ id: 'dir-1', path: '/downloads', name: 'downloads' }],
    parentFolderId: 'dir-1',
    path: '/downloads',
    message: '',
  };
}

const BT_TASK: PendingConfirmation['tasks'][number] = {
  link: 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567',
  label: 'bt-1',
  kind: 'bt',
  name: '包名',
  size: 400,
  totalFileCount: 5,
  files: [
    file('a', 'a.mp4', 0),
    file('b', 'b.mp4', 1),
    file('c', 'c.mp4', 2),
    file('d', 'd.mp4', 4),
    file('e', 'e.mp4', 9),
  ],
  preselectedIds: [],
  selectionDisabled: false,
  wholePackageDefault: false,
};

describe('buildConfirmTree', () => {
  it('拍平文件还原目录树，父目录大小为子项之和', () => {
    const tree = buildConfirmTree([
      file('a', 'dir1/a.mp4', 0, 10),
      file('b', 'dir1/sub/b.mp4', 1, 20),
      file('c', 'c.mp4', 2, 5),
    ]);
    expect(tree).toHaveLength(2);
    const dir1 = tree.find((node) => node.isDir);
    expect(dir1?.name).toBe('dir1');
    expect(dir1?.size).toBe(30);
    const sub = dir1?.children.find((node) => node.name === 'sub');
    expect(sub?.isDir).toBe(true);
    expect(sub?.size).toBe(20);
    expect(sub?.children[0]?.file?.id).toBe('b');
    expect(tree.find((node) => !node.isDir)?.file?.id).toBe('c');
  });
});

describe('buildConfirmCreateSpecs', () => {
  it('勾选序号折叠成 sub_file_index 区间串', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: true, selectedIds: ['a', 'b', 'c', 'd'] },
    ]);
    expect(plan.specs).toHaveLength(1);
    expect(plan.specs[0]?.subFileIndex).toBe('0-2,4');
    expect(plan.specs[0]?.fileSize).toBe(400);
  });

  it('整包不传 sub_file_index，大小用任务整包大小', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: true, wholePackage: true },
    ]);
    expect(plan.specs[0]?.subFileIndex).toBeUndefined();
    expect(plan.specs[0]?.fileSize).toBe(400);
  });

  it('BT 空选择跳过不建任务，不退化成整包', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: true, selectedIds: [] },
    ]);
    expect(plan.specs).toHaveLength(0);
    expect(plan.skipped).toEqual(['bt-1']);
  });

  it('未包含的链接跳过', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: false },
    ]);
    expect(plan.specs).toHaveLength(0);
  });

  it('任务名可被用户覆盖', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: true, name: '我的名字', selectedIds: ['a'] },
    ]);
    expect(plan.specs[0]?.name).toBe('我的名字');
    expect(plan.specs[0]?.subFileIndex).toBe('0');
  });

  it('文件树截断（selectionDisabled）只接受显式整包', () => {
    const truncated = { ...BT_TASK, selectionDisabled: true };
    const denied = buildConfirmCreateSpecs(pending([truncated]), [
      { link: truncated.link, include: true, selectedIds: ['a'] },
    ]);
    expect(denied.specs).toHaveLength(0);
    const allowed = buildConfirmCreateSpecs(pending([truncated]), [
      { link: truncated.link, include: true, wholePackage: true },
    ]);
    expect(allowed.specs).toHaveLength(1);
    expect(allowed.specs[0]?.subFileIndex).toBeUndefined();
  });

  it('直链任务不参与文件勾选', () => {
    const direct: PendingConfirmation['tasks'][number] = {
      link: 'http://a.test/f.zip',
      label: 'direct-1',
      kind: 'direct',
      name: 'f.zip',
      size: 50,
      totalFileCount: 1,
      files: [],
      preselectedIds: [],
      selectionDisabled: false,
      wholePackageDefault: true,
    };
    const plan = buildConfirmCreateSpecs(pending([direct]), [
      { link: direct.link, include: true, name: '改名.zip' },
    ]);
    expect(plan.specs[0]?.subFileIndex).toBeUndefined();
    expect(plan.specs[0]?.fileSize).toBe(50);
  });

  it('文件 id 不在 pending 里时忽略（不接受窗口伪造的 id）', () => {
    const plan = buildConfirmCreateSpecs(pending([BT_TASK]), [
      { link: BT_TASK.link, include: true, selectedIds: ['a', 'hacked'] },
    ]);
    expect(plan.specs[0]?.subFileIndex).toBe('0');
  });
});
