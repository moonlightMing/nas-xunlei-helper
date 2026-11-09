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

  it('badgeTaskCount 缺失时回落为开启（默认显示角标）', async () => {
    const { mod } = await loadSettingsModule({ nas_xunlei_settings: { xunleiUrl: 'http://nas' } });
    expect((await mod.ensureSettingsLoaded()).badgeTaskCount).toBe(true);
  });

  it('显式关闭的 badgeTaskCount 保留 false', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: { xunleiUrl: 'http://nas', badgeTaskCount: false },
    });
    expect((await mod.ensureSettingsLoaded()).badgeTaskCount).toBe(false);
  });
});

describe('downloadPaths 多下载位置', () => {
  it('旧数据只有 downloadPath 时迁移为单元素列表，downloadPath 投影为列表首项', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: { xunleiUrl: 'http://nas', downloadPath: '/downloads/05' },
    });
    const settings = await mod.ensureSettingsLoaded();
    expect(settings.downloadPaths).toEqual(['/downloads/05']);
    expect(settings.downloadPath).toBe('/downloads/05'); // 发送链路继续读首项作默认
  });

  it('downloadPaths 归一：trim、去空、去重保序；downloadPath 始终投影首项', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: {
        xunleiUrl: 'http://nas',
        downloadPaths: ['  /downloads/05 ', '', '/downloads/04', '/downloads/05', '  '],
      },
    });
    const settings = await mod.ensureSettingsLoaded();
    expect(settings.downloadPaths).toEqual(['/downloads/05', '/downloads/04']);
    expect(settings.downloadPath).toBe('/downloads/05');
  });

  it('非字符串项被剔除；列表清空时 downloadPath 投影为空（回退迅雷默认目录）', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: { xunleiUrl: 'http://nas', downloadPaths: [42, null, '/ok'] },
    });
    expect((await mod.ensureSettingsLoaded()).downloadPaths).toEqual(['/ok']);

    const { mod: cleared } = await loadSettingsModule({
      nas_xunlei_settings: { xunleiUrl: 'http://nas', downloadPaths: [], downloadPath: '' },
    });
    const settings = await cleared.ensureSettingsLoaded();
    expect(settings.downloadPaths).toEqual([]);
    expect(settings.downloadPath).toBe('');
  });

  it('downloadPaths 非空时优先于旧 downloadPath 字段（新数据为准）', async () => {
    const { mod } = await loadSettingsModule({
      nas_xunlei_settings: {
        xunleiUrl: 'http://nas',
        downloadPath: '/legacy',
        downloadPaths: ['/downloads/01', '/downloads/02'],
      },
    });
    const settings = await mod.ensureSettingsLoaded();
    expect(settings.downloadPaths).toEqual(['/downloads/01', '/downloads/02']);
    expect(settings.downloadPath).toBe('/downloads/01');
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
