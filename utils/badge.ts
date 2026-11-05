/**
 * 工具栏图标角标：用原生 chrome.action.setBadgeText 显示进行中的下载任务数。
 *
 * 原生角标叠在满幅图标上会盖住图标主体（16px 图标上角标又小又靠角落），
 * 因此 public/icons 的三个图标资源本身是「小主体居中 + 透明留白」设计
 * （与常见下载器扩展一致，见 git 历史 0.11.0 的图标重生成）：角标数字叠加
 * 在留白处，大而清晰，也不再遮挡图标。无任务时清空角标文本。
 *
 * 数据源与 popup「进行中」页签同一口径，走 drive/v1/tasks 接口（与 sendMode
 * 无关，接口直连可在 Service Worker 里完成，不需要迅雷页面）。刷新时机：
 * ① 每分钟的独立常驻 alarm（与任务监控的 alarm 分开，互不影响生命周期）；
 * ② popup 轮询 tasks/list 成功时由 background 顺带更新（零额外请求）；
 * ③ Service Worker 启动时。
 *
 * 接口失败（不可达/令牌失效）时保持上一次的角标静默重试，NAS 短暂故障
 * 不该让角标闪烁消失；只有开关关闭或地址未配置/非法时才清空并停掉 alarm。
 *
 * 原生角标文本是会话级的：浏览器重启后 Chrome 会把它清掉，而 MV3 Service
 * Worker 是懒唤醒的，若等 alarm + 接口往返才重写，重启后角标会空白一阵
 * （接口失败时更久）。因此每次写入都同步落一份到 storage.local
 * （nas_xunlei_badge_count），SW 启动时 restoreBadgeCount() 先恢复上次数字，
 * 再由 refreshTaskBadge 用接口结果纠正。
 */

import {
  ensureSettingsLoaded,
  getSettings,
  validateXunleiUrl,
  watchSettingsStorage,
} from '@/utils/settings';
import {
  getDeviceSpace,
  listTasks,
  PHASE_IN_PROGRESS,
  TASK_TYPE_LOCAL,
  TASK_TYPE_URL,
} from '@/utils/xunleiApi';

export const BADGE_ALARM_NAME = 'nas-xunlei-badge-refresh';
const BADGE_ALARM_PERIOD_MINUTES = 1;
/** 进行中任务通常远小于此值；角标不需要为极端场景翻页，超出的部分由 99+ 表达 */
const BADGE_TASK_LIMIT = 100;
/** 角标背景色（与常见下载器扩展一致的原生角标蓝） */
const BADGE_BG_COLOR = '#1677ff';
/** 上次角标数量的本地持久化键：浏览器重启会清原生角标文本，SW 启动时据此立即恢复 */
const BADGE_COUNT_STORAGE_KEY = 'nas_xunlei_badge_count';

interface PersistedBadgeCount {
  count: number;
  at: number;
}

/** 角标文本：无任务返回空串（清空），超过 99 折叠为 99+（原生角标的折叠习惯） */
export function badgeTextForCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count <= 99) return String(Math.floor(count));
  return '99+';
}

let lastAppliedCount: number | null = null;

function persistBadgeCount(count: number): void {
  try {
    void chrome.storage.local.set({
      [BADGE_COUNT_STORAGE_KEY]: { count, at: Date.now() } satisfies PersistedBadgeCount,
    });
  } catch {
    /* storage 不可用时只影响下次重启的恢复速度，角标本身照常工作 */
  }
}

/** 按已知数量更新原生角标；数量不变时跳过，避免 popup 轮询反复写 IPC */
function applyBadgeCount(count: number): void {
  if (count === lastAppliedCount) return;
  lastAppliedCount = count;
  persistBadgeCount(count);
  const text = badgeTextForCount(count);
  try {
    void chrome.action.setBadgeText({ text });
    if (text) void chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
  } catch {
    /* action API 不可用时静默 */
  }
}

/** 直接按已知数量更新角标（popup 轮询顺带调用，不额外发请求） */
export function updateTaskBadge(count: number): void {
  if (!Number.isFinite(count) || count < 0) return;
  applyBadgeCount(count);
}

export function clearTaskBadge(): void {
  applyBadgeCount(0);
}

/**
 * SW 启动时从 storage.local 恢复上次角标数字，不依赖接口往返——
 * 浏览器重启会清掉原生角标文本，先恢复上次值再由接口结果纠正。
 */
export async function restoreBadgeCount(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(BADGE_COUNT_STORAGE_KEY);
    const value = stored?.[BADGE_COUNT_STORAGE_KEY] as PersistedBadgeCount | undefined;
    if (!value || typeof value.count !== 'number' || value.count <= 0) return;
    lastAppliedCount = value.count;
    try {
      void chrome.action.setBadgeText({ text: badgeTextForCount(value.count) });
      void chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
    } catch {
      /* ignore */
    }
  } catch {
    /* 读不到就等 refreshTaskBadge 正常刷新 */
  }
}

/** 按开关与地址配置同步角标刷新 alarm：可用时常驻每分钟刷新，否则清除 */
async function syncBadgeAlarm(): Promise<void> {
  try {
    const settings = getSettings();
    const needed = settings.badgeTaskCount && !validateXunleiUrl(settings.xunleiUrl);
    const existing = await chrome.alarms.get(BADGE_ALARM_NAME);
    if (needed && !existing) {
      await chrome.alarms.create(BADGE_ALARM_NAME, {
        periodInMinutes: BADGE_ALARM_PERIOD_MINUTES,
      });
    } else if (!needed && existing) {
      await chrome.alarms.clear(BADGE_ALARM_NAME);
    }
  } catch (error) {
    console.warn('[badge] 同步角标 alarm 失败:', error);
  }
}

let refreshing: Promise<void> | null = null;

/**
 * 读一次进行中任务数并刷新角标；并发调用共享同一 Promise。
 * 开关关闭或地址缺失/非法时清空角标并停掉 alarm；接口失败保持旧值等下轮重试。
 */
export function refreshTaskBadge(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await ensureSettingsLoaded();
    const settings = getSettings();
    if (!settings.badgeTaskCount || validateXunleiUrl(settings.xunleiUrl)) {
      clearTaskBadge();
      await syncBadgeAlarm();
      return;
    }
    try {
      const space = await getDeviceSpace(settings.xunleiUrl);
      if (!space) throw new Error('未获取到 NAS 设备标识');
      const result = await listTasks(settings.xunleiUrl, {
        space,
        phases: PHASE_IN_PROGRESS,
        types: [TASK_TYPE_URL, TASK_TYPE_LOCAL],
        limit: BADGE_TASK_LIMIT,
      });
      updateTaskBadge((result.tasks ?? []).length);
      await syncBadgeAlarm();
    } catch {
      // 读不到任务数就保持上一次的角标，等下一轮 alarm 重试；不打扰用户
    }
  })();
  void refreshing.finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * 监听设置变更（background 用，替代裸 watchSettingsStorage）：
 * 开关关闭时立刻清空角标；重新开启由下一轮刷新/alarm 拉起。
 */
export function watchBadgeSettings(): () => void {
  return watchSettingsStorage((settings) => {
    if (!settings.badgeTaskCount) clearTaskBadge();
  });
}
