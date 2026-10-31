import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteTasks,
  flattenResourceFiles,
  invalidatePanAuth,
  listTasks,
  operateTask,
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
