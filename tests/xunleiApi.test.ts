import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteTasks,
  downloadPathsToDirItems,
  filesToDirItems,
  flattenResourceFiles,
  invalidatePanAuth,
  listTasks,
  operateTask,
  taskStatusMessage,
  toApiBase,
  XunleiApiError,
  type ResourceNode,
} from '@/utils/xunleiApi';

const TOKEN = 'headerhead.payloadpayload.signaturee';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * 拦截全局 fetch：首次访问首页下发 uiauth JWT，之后返回空 JSON。
 * 用于断言线上请求格式（pan-auth 双通道、method 隧道）。
 */
function stubFetch(responses: Array<(call: RecordedCall) => Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      const respond = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (!respond) throw new Error(`unexpected fetch: ${call.url}`);
      return respond(call);
    }),
  );
  return calls;
}

afterEach(() => {
  // 令牌缓存是模块级内存态，用例间必须清掉，否则第二个用例不会重新拉首页
  invalidatePanAuth();
  vi.unstubAllGlobals();
});

describe('toApiBase', () => {
  it('去掉 hash、search 与尾斜杠', () => {
    expect(toApiBase('http://nas.local:5000/#/down')).toBe('http://nas.local:5000');
    expect(toApiBase('http://nas.local:5000///')).toBe('http://nas.local:5000');
    expect(toApiBase('https://nas.local?a=1#/x')).toBe('https://nas.local');
  });

  it('未配置或格式错误抛 token-missing', () => {
    expect(() => toApiBase('')).toThrow(XunleiApiError);
    expect(() => toApiBase('not a url')).toThrowError(/地址格式不正确/);
  });
});

describe('taskStatusMessage（失败原因取值口径）', () => {
  // 2026-11-05 线上实测：新任务失败时顶层 message 只是「失败」，具体原因在 params.error
  it('失败任务优先取 params.error，顶层 message 兜底', () => {
    expect(
      taskStatusMessage({
        phase: 'PHASE_TYPE_ERROR',
        message: '失败',
        params: { error: '任务超时,已重试10次,请更换资源' },
      }),
    ).toBe('任务超时,已重试10次,请更换资源');
    expect(taskStatusMessage({ phase: 'PHASE_TYPE_ERROR', message: '任务连接超时，无法添加到云盘' })).toBe(
      '任务连接超时，无法添加到云盘',
    );
    expect(taskStatusMessage({ phase: 'PHASE_TYPE_ERROR' })).toBe('');
  });

  it('非失败状态不受 params.error 影响，保持顶层 message', () => {
    expect(taskStatusMessage({ phase: 'PHASE_TYPE_PENDING', message: '等待中', params: { error: '历史错误' } })).toBe(
      '等待中',
    );
    expect(taskStatusMessage({ phase: 'PHASE_TYPE_RUNNING' })).toBe('');
  });
});

describe('flattenResourceFiles', () => {
  it('根节点是任务名，绝不拼进文件 path', () => {
    const root: ResourceNode = {
      name: 'ABC-123 整包',
      is_dir: true,
      dir: {
        resources: [
          { name: 'a.mp4', id: 'x.0', file_size: 10 },
          { name: 'sub', is_dir: true, dir: { resources: [{ name: 'b.mp4', id: 'x.1', file_size: 20 }] } },
        ],
      },
    };
    const files = flattenResourceFiles(root);
    expect(files.map((file) => file.path)).toEqual(['a.mp4', 'sub/b.mp4']);
  });

  it('迅雷会省略序号 0：从 id 末段回退推导，推不出为 -1', () => {
    const root: ResourceNode = {
      name: 'r',
      is_dir: true,
      dir: {
        resources: [
          { name: 'a.mp4', id: 'pkg.7', file_size: 1 },
          { name: 'b.mp4', id: 'weird', file_size: 2 },
        ],
      },
    };
    const files = flattenResourceFiles(root);
    expect(files[0]?.fileIndex).toBe(7);
    expect(files[1]?.fileIndex).toBe(-1);
  });
});

describe('xunleiRequest 请求格式（fetch 拦截断言）', () => {
  it('pan-auth 头与 pan_auth 查询参数双通道下发', async () => {
    const calls = stubFetch([
      () =>
        new Response(`<html>function uiauth(){return "${TOKEN}"}</html>`, { status: 200 }),
      () => new Response(JSON.stringify({ tasks: [] }), { status: 200 }),
    ]);
    const result = await listTasks('http://nas.local:5000/#/down', { space: 'dev#1' });
    expect(result.tasks).toEqual([]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('http://nas.local:5000/');
    const api = calls[1];
    expect(api?.url.startsWith('http://nas.local:5000/drive/v1/tasks?')).toBe(true);
    expect(api?.url).toContain(`pan_auth=${TOKEN}`);
    expect(api?.url).toContain('space=dev%231');
    expect((api?.init.headers as Record<string, string>)['pan-auth']).toBe(TOKEN);
    expect(api?.init.method).toBe('GET');
  });

  it('PATCH/DELETE 隧道成 POST method/<verb>/<path>', async () => {
    const calls = stubFetch([
      () =>
        new Response(`<html>function uiauth(){return "${TOKEN}"}</html>`, { status: 200 }),
      () => new Response('{}', { status: 200 }),
    ]);
    await deleteTasks('http://nas.local:5000', { space: 'dev#1', ids: ['t1', 't2'] });

    const api = calls[1];
    expect(api?.url.startsWith('http://nas.local:5000/method/delete/drive/v1/tasks?')).toBe(true);
    expect(api?.init.method).toBe('POST');
    expect(api?.url).toContain('task_ids=t1');
    expect(api?.url).toContain('task_ids=t2');
  });

  it('operateTask 的 spec.phase 映射为套件前端短形式（完整枚举值会被静默忽略）', async () => {
    const parseBody = (call?: RecordedCall) => JSON.parse(String(call?.init.body ?? '{}'));

    // 继续：PHASE_TYPE_RUNNING → "running"
    const resumeCalls = stubFetch([
      () =>
        new Response(`<html>function uiauth(){return "${TOKEN}"}</html>`, { status: 200 }),
      () => new Response('{}', { status: 200 }),
    ]);
    await operateTask('http://nas.local:5000', {
      space: 'dev#1',
      id: 't1',
      type: 'user#download-url',
      phase: 'PHASE_TYPE_RUNNING',
    });
    expect(resumeCalls[1]?.url.startsWith('http://nas.local:5000/method/patch/drive/v1/task?')).toBe(true);
    expect(resumeCalls[1]?.init.method).toBe('POST');
    expect(parseBody(resumeCalls[1])).toEqual({
      space: 'dev#1',
      type: 'user#download-url',
      id: 't1',
      set_params: { spec: '{"phase":"running"}' },
    });

    invalidatePanAuth();

    // 暂停：PHASE_TYPE_PAUSED → "pause"
    const pauseCalls = stubFetch([
      () =>
        new Response(`<html>function uiauth(){return "${TOKEN}"}</html>`, { status: 200 }),
      () => new Response('{}', { status: 200 }),
    ]);
    await operateTask('http://nas.local:5000', {
      space: 'dev#1',
      id: 't1',
      type: 'user#download-url',
      phase: 'PHASE_TYPE_PAUSED',
    });
    expect(parseBody(pauseCalls[1])).toEqual(
      expect.objectContaining({
        set_params: { spec: '{"phase":"pause"}' },
      }),
    );

    invalidatePanAuth();

    // 其它 phase 值不属于暂停/继续操作，同步抛错而不是发请求
    expect(() =>
      operateTask('http://nas.local:5000', {
        space: 'dev#1',
        id: 't1',
        type: 'user#download-url',
        phase: 'PHASE_TYPE_COMPLETE',
      }),
    ).toThrow(/不支持的任务操作状态/);
  });
});

describe('filesToDirItems（目录树映射）', () => {
  it('只保留目录，RealPath 优先、缺失时按父路径拼接，is_write 字符串/布尔 false 均不可写', () => {
    const items = filesToDirItems(
      [
        {
          kind: 'drive#file',
          id: 'f1',
          parent_id: 'p',
          name: 'movie.mp4',
        },
        {
          kind: 'drive#folder',
          id: 'd1',
          parent_id: 'p',
          name: '电影',
          params: { RealPath: '/vol1/1000/电影/', is_write: 'false' },
        },
        {
          kind: 'drive#folder',
          id: 'd2',
          parent_id: 'p',
          name: '剧集',
        },
        {
          kind: 'drive#folder',
          id: 'd3',
          parent_id: 'p',
          name: '只读目录',
          params: { is_write: false },
        },
      ],
      '/vol1/1000',
    );
    expect(items).toEqual([
      {
        id: 'd1',
        name: '电影',
        path: '/vol1/1000/电影',
        realPath: '/vol1/1000/电影/',
        writable: false,
      },
      {
        id: 'd2',
        name: '剧集',
        path: '/vol1/1000/剧集',
        realPath: '/vol1/1000/剧集',
        writable: true,
      },
      {
        id: 'd3',
        name: '只读目录',
        path: '/vol1/1000/只读目录',
        realPath: '/vol1/1000/只读目录',
        writable: false,
      },
    ]);
  });

  it('undefined 或缺 id/name 的条目被剔除，不抛错', () => {
    expect(filesToDirItems(undefined, '/x')).toEqual([]);
    expect(
      filesToDirItems(
        [
          { kind: 'drive#folder', id: '', parent_id: '', name: 'no-id' },
          { kind: 'drive#folder', id: 'ok', parent_id: '', name: '' },
        ],
        '',
      ),
    ).toEqual([]);
  });
});

describe('downloadPathsToDirItems（下载根目录映射）', () => {
  it('按 Id 与路径双重去重，路径去尾斜杠归一', () => {
    const items = downloadPathsToDirItems([
      {
        Id: 'd992',
        ParentID: '',
        FileName: 'av',
        RealPath: '/vol1/1000/视频/av/',
        Kind: 'DOWNLOAD',
      },
      {
        Id: '5431',
        ParentID: '',
        FileName: 'downloads',
        RealPath: '/var/apps/xunlei/shares/downloads',
        Kind: 'DOWNLOAD',
      },
      // 线上实测同一路径会重复登记：同 Id 同 RealPath，或同 RealPath 不同 Id
      {
        Id: 'd992',
        ParentID: '',
        FileName: 'av',
        RealPath: '/vol1/1000/视频/av/',
        Kind: 'DOWNLOAD',
      },
      {
        Id: 'dup-path',
        ParentID: '',
        FileName: 'av 别名',
        RealPath: '/vol1/1000/视频/av',
        Kind: 'DOWNLOAD',
      },
    ]);
    expect(items.map((item) => item.id)).toEqual(['d992', '5431']);
    expect(items[0]).toEqual({
      id: 'd992',
      name: 'av',
      path: '/vol1/1000/视频/av',
      realPath: '/vol1/1000/视频/av',
      writable: true,
    });
  });

  it('空列表或根路径条目被剔除', () => {
    expect(downloadPathsToDirItems(undefined)).toEqual([]);
    expect(
      downloadPathsToDirItems([
        { Id: 'x', ParentID: '', FileName: '', RealPath: '/', Kind: 'DOWNLOAD' },
        { Id: '', ParentID: '', FileName: 'y', RealPath: '/y', Kind: 'DOWNLOAD' },
      ]),
    ).toEqual([]);
  });
});
