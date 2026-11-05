import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeTextForCount } from '@/utils/badge';

describe('badgeTextForCount', () => {
  it('0、负数与非数字返回空串（清空角标）', () => {
    expect(badgeTextForCount(0)).toBe('');
    expect(badgeTextForCount(-3)).toBe('');
    expect(badgeTextForCount(Number.NaN)).toBe('');
    expect(badgeTextForCount(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('常规数量直接显示数字', () => {
    expect(badgeTextForCount(1)).toBe('1');
    expect(badgeTextForCount(12)).toBe('12');
    expect(badgeTextForCount(99)).toBe('99');
  });

  it('超过 99 折叠为 99+（与原生角标习惯一致）', () => {
    expect(badgeTextForCount(100)).toBe('99+');
    expect(badgeTextForCount(12345)).toBe('99+');
  });
});

describe('badge 数量持久化与重启恢复', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  /** 按用例重置模块并注入 chrome.storage.local / chrome.action 桩 */
  async function loadBadgeModule(stored: Record<string, unknown>) {
    vi.resetModules();
    const set = vi.fn(async () => {});
    const setBadgeText = vi.fn();
    (globalThis as Record<string, unknown>).chrome = {
      storage: { local: { get: vi.fn(async () => stored), set } },
      action: { setBadgeText, setBadgeBackgroundColor: vi.fn() },
    };
    const mod = await import('@/utils/badge');
    return { mod, set, setBadgeText };
  }

  it('updateTaskBadge 把数量写入 storage.local，供重启后恢复', async () => {
    const { mod, set, setBadgeText } = await loadBadgeModule({});
    mod.updateTaskBadge(27);
    expect(set).toHaveBeenCalledWith({
      nas_xunlei_badge_count: { count: 27, at: expect.any(Number) },
    });
    expect(setBadgeText).toHaveBeenCalledWith({ text: '27' });
  });

  it('restoreBadgeCount 从 storage 恢复上次角标文本（重启后不等接口往返）', async () => {
    const { mod, setBadgeText } = await loadBadgeModule({
      nas_xunlei_badge_count: { count: 27, at: 1 },
    });
    await mod.restoreBadgeCount();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '27' });
  });

  it('无持久化数据（或数量为 0）时 restoreBadgeCount 不写角标', async () => {
    const { mod, setBadgeText } = await loadBadgeModule({
      nas_xunlei_badge_count: { count: 0, at: 1 },
    });
    await mod.restoreBadgeCount();
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});
