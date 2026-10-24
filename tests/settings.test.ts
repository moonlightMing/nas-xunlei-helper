import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * settings 模块的内存缓存跨用例共享，按用例重置模块并注入 chrome.storage 桩。
 */
async function loadSettingsModule(stored: Record<string, unknown> | null) {
  vi.resetModules();
  const get = vi.fn(async () => (stored === null ? Promise.reject(new Error('storage broken')) : stored));
  const set = vi.fn(async () => {});
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get, set } },
  };
  const mod = await import('@/utils/settings');
  return { mod, get, set };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('normalizeSettings 回落方向', () => {
  it('downloadMode 缺失/损坏时回落到默认值 confirm（确认后下载），而不是 immediate', async () => {
    const { mod } = await loadSettingsModule({ nas_xunlei_settings: { xunleiUrl: 'http://nas' } });
    const settings = await mod.ensureSettingsLoaded();
    expect(settings.downloadMode).toBe('confirm');
    expect(settings.sendMode).toBe('dom');
  });

  it('显式 immediate 正常保留', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: { xunleiUrl: 'http://nas', downloadMode: 'immediate' },
    });
    expect((await mod.ensureSettingsLoaded()).downloadMode).toBe('immediate');
  });
});

describe('ensureSettingsLoaded 失败重试', () => {
  it(
    '读取失败不永久缓存默认值：下次调用会重试并读到真实设置',
    { timeout: 15_000 },
    async () => {
      let broken = true;
      vi.resetModules();
      const real = { nas_xunlei_settings: { xunleiUrl: 'http://nas', downloadPath: '/movies' } };
      const get = vi.fn(async () => {
        if (broken) throw new Error('storage broken');
        return real;
      });
      (globalThis as Record<string, unknown>).chrome = {
        storage: { local: { get, set: async () => {} } },
      };
      const mod = await import('@/utils/settings');

      const first = await mod.ensureSettingsLoaded();
      expect(first.downloadPath).toBe(''); // 失败 → 默认值

      broken = false;
      const second = await mod.ensureSettingsLoaded();
      expect(second.downloadPath).toBe('/movies'); // 不缓存失败结果，重试读到真实值
      expect(get).toHaveBeenCalledTimes(4); // 首次 3 次重试 + 重试成功 1 次
    },
  );
});
