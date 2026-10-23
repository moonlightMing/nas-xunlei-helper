/**
 * 扩展设置：NAS 迅雷地址、默认下载位置、下载模式、番号匹配规则。
 *
 * 存放于 chrome.storage.local 单 key（storage.local 而非 sync：NAS 地址是
 * 局域网设备相关配置，跨设备同步无意义）。读取为同步 getter（返回内存值），
 * 发送前调用 ensureSettingsLoaded() 确保已加载；options / popup / background
 * 之间的变更通过 watchSettingsStorage 互相感知。
 */

import {
  cloneAvMatchSettings,
  DEFAULT_AV_MATCH_SETTINGS,
  normalizeAvMatchSettings,
  type AvMatchSettings,
} from '@/utils/avMatch';

export const SETTINGS_STORAGE_KEY = 'nas_xunlei_settings';

/** 下载模式：立即下载 / 停在迅雷确认框由用户编辑后再下载 */
export type DownloadMode = 'immediate' | 'confirm';

export const DOWNLOAD_MODE_LABELS: Record<DownloadMode, string> = {
  immediate: '立即下载',
  confirm: '确认后下载',
};

export interface XunleiSettings {
  /** NAS 迅雷 Web 地址（含 #/home），如 http://192.168.5.2:2345/webman/3rdparty/pan-xunlei-com/index.cgi/#/home */
  xunleiUrl: string;
  /** 默认下载位置（NAS 路径，如 /downloads/movies）；留空 = 使用 NAS 当前默认目录 */
  downloadPath: string;
  /** 下载模式 */
  downloadMode: DownloadMode;
  /** 复用迅雷页发送前是否刷新（关闭可减少对当前页面的打断） */
  reloadBeforeSend: boolean;
  /** 发送成功后是否弹桌面通知 */
  notifyOnSendSuccess: boolean;
  /** 发送失败后是否弹桌面通知 */
  notifyOnSendFailure: boolean;
  /** 保存路径未能应用时是否弹桌面通知 */
  notifyOnPathFallback: boolean;
  /** 是否在发送后监控下载任务状态 */
  monitorDownloads: boolean;
  /** 下载任务失败时是否弹桌面通知 */
  notifyOnDownloadFailure: boolean;
  /** 下载任务完成时是否弹桌面通知 */
  notifyOnDownloadComplete: boolean;
  /** 磁力/种子解析后的番号匹配规则 */
  avMatch: AvMatchSettings;
}

export const DEFAULT_SETTINGS: XunleiSettings = {
  xunleiUrl: '',
  downloadPath: '',
  downloadMode: 'immediate',
  reloadBeforeSend: true,
  notifyOnSendSuccess: false,
  notifyOnSendFailure: true,
  notifyOnPathFallback: true,
  monitorDownloads: true,
  notifyOnDownloadFailure: true,
  notifyOnDownloadComplete: false,
  avMatch: cloneAvMatchSettings(DEFAULT_AV_MATCH_SETTINGS),
};

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 校验 NAS 迅雷地址，返回错误信息；合法返回 null */
export function validateXunleiUrl(url: string): string | null {
  const value = url.trim();
  if (!value) return '请填写 NAS 迅雷地址';
  if (!/^https?:\/\//i.test(value)) return '地址必须以 http:// 或 https:// 开头';
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return '地址缺少主机名';
  } catch {
    return '地址格式不正确';
  }
  return null;
}

/** 校验默认下载位置（允许留空），返回错误信息；合法返回 null */
export function validateDownloadPath(path: string): string | null {
  const value = path.trim();
  if (!value) return null;
  if (!value.startsWith('/')) return '路径必须以 / 开头，如 /downloads/movies';
  return null;
}

function normalizeSettings(raw: unknown): XunleiSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<XunleiSettings>;
  return {
    // 校验失败的已存值原样保留（不静默改写），使用方（发送链路）发送前需再校验
    xunleiUrl: typeof input.xunleiUrl === 'string' ? input.xunleiUrl.trim() : DEFAULT_SETTINGS.xunleiUrl,
    downloadPath:
      typeof input.downloadPath === 'string' ? input.downloadPath.trim() : DEFAULT_SETTINGS.downloadPath,
    downloadMode: input.downloadMode === 'confirm' ? 'confirm' : 'immediate',
    reloadBeforeSend: booleanOrDefault(input.reloadBeforeSend, DEFAULT_SETTINGS.reloadBeforeSend),
    notifyOnSendSuccess: booleanOrDefault(
      input.notifyOnSendSuccess,
      DEFAULT_SETTINGS.notifyOnSendSuccess,
    ),
    notifyOnSendFailure: booleanOrDefault(
      input.notifyOnSendFailure,
      DEFAULT_SETTINGS.notifyOnSendFailure,
    ),
    notifyOnPathFallback: booleanOrDefault(
      input.notifyOnPathFallback,
      DEFAULT_SETTINGS.notifyOnPathFallback,
    ),
    monitorDownloads: booleanOrDefault(input.monitorDownloads, DEFAULT_SETTINGS.monitorDownloads),
    notifyOnDownloadFailure: booleanOrDefault(
      input.notifyOnDownloadFailure,
      DEFAULT_SETTINGS.notifyOnDownloadFailure,
    ),
    notifyOnDownloadComplete: booleanOrDefault(
      input.notifyOnDownloadComplete,
      DEFAULT_SETTINGS.notifyOnDownloadComplete,
    ),
    avMatch: normalizeAvMatchSettings(input.avMatch),
  };
}

let current: XunleiSettings = normalizeSettings(null);
let loadPromise: Promise<XunleiSettings> | null = null;

function getStorageArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

/** 同步读取当前设置（未加载时返回默认值） */
export function getSettings(): XunleiSettings {
  return current;
}

/** 从 storage 加载设置（幂等，并发调用共享同一 Promise） */
export function ensureSettingsLoaded(): Promise<XunleiSettings> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const area = getStorageArea();
      if (!area) return current;
      try {
        const stored = await area.get(SETTINGS_STORAGE_KEY);
        current = normalizeSettings(stored?.[SETTINGS_STORAGE_KEY]);
      } catch (error) {
        console.warn('[settings] 读取设置失败，使用默认值:', error);
      }
      return current;
    })();
  }
  return loadPromise;
}

/** 保存设置（合并写入） */
export async function saveSettings(next: Partial<XunleiSettings>): Promise<XunleiSettings> {
  current = normalizeSettings({ ...current, ...next });

  const area = getStorageArea();
  if (area) {
    try {
      await area.set({ [SETTINGS_STORAGE_KEY]: current });
    } catch (error) {
      console.warn('[settings] 保存设置失败:', error);
      throw error;
    }
  }
  loadPromise = Promise.resolve(current);
  return current;
}

/** 保存番号匹配设置（在当前 avMatch 上合并，避免浅合并丢字段） */
export async function saveAvMatchSettings(
  next: Partial<AvMatchSettings>,
): Promise<XunleiSettings> {
  const current = await ensureSettingsLoaded();
  return saveSettings({ avMatch: { ...current.avMatch, ...next } });
}

/** 恢复默认设置 */
export async function resetSettings(): Promise<XunleiSettings> {
  return saveSettings(DEFAULT_SETTINGS);
}

/**
 * 监听其它上下文（options / popup / background）的设置变更：
 * 采用变更后的值更新内存值并触发回调。返回解绑函数。
 */
export function watchSettingsStorage(onChange: (settings: XunleiSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) {
      // 直接采用变更后的值，避免 ensureSettingsLoaded() 命中本上下文旧缓存
      current = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
      loadPromise = Promise.resolve(current);
      onChange(current);
    }
  };
  try {
    chrome.storage.onChanged.addListener(listener);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}
