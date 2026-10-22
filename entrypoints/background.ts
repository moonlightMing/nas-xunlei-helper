import {
  ensureSettingsLoaded,
  getSettings,
  validateXunleiUrl,
  watchSettingsStorage,
  type XunleiSettings,
} from '@/utils/settings';
import { runSendFlow, type SendOutcome } from '@/utils/xunleiAutomation';

const CONTEXT_MENU_ID = 'nas-xunlei-send';

export interface SendLinksMessage {
  type: 'download';
  action: 'sendLinks';
  data: { links: string[] };
}

export type SendLinksResponse = SendOutcome | { ok: false; message: string };

export default defineBackground(() => {
  // Service Worker 常驻期间也要感知设置页的修改，避免发送时沿用旧路径
  watchSettingsStorage(() => {});

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: '发送到 NAS 迅雷',
        contexts: ['link'],
      });
    });
  });

  // 右键菜单：service worker 冷启动后 onInstalled 不会重放，
  // 但 contextMenus 注册持久化在浏览器侧，这里只负责响应点击
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) return;
    void sendLinksToNas([info.linkUrl], { notify: true });
  });

  chrome.runtime.onMessage.addListener((message: SendLinksMessage, _sender, sendResponse) => {
    if (message?.type !== 'download' || message.action !== 'sendLinks') return;
    const links = Array.isArray(message.data?.links) ? message.data.links : [];
    sendLinksToNas(links, { notify: true })
      .then((outcome) => sendResponse(outcome satisfies SendLinksResponse))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message } satisfies SendLinksResponse));
    return true; // 异步 sendResponse
  });
});

/** 发送链接到 NAS 迅雷：读设置 → 打开/复用迅雷页 → 注入自动化 */
async function sendLinksToNas(
  links: string[],
  options: { notify: boolean },
): Promise<SendOutcome> {
  const outcome = await run(links);
  if (options.notify) {
    await notify(outcome.ok ? 'NAS 迅雷助手' : 'NAS 迅雷助手 · 发送失败', outcome.message);
  }
  return outcome;

  async function run(cleanInput: string[]): Promise<SendOutcome> {
    const cleaned = cleanInput.map((l) => l.trim()).filter(Boolean);
    if (!cleaned.length) {
      return { stage: 'prepare', ok: false, message: '没有可发送的链接' };
    }

    await ensureSettingsLoaded();
    const settings = getSettings();
    const urlError = validateXunleiUrl(settings.xunleiUrl);
    if (urlError) {
      return { stage: 'prepare', ok: false, message: `请先在设置页正确配置 NAS 迅雷地址（${urlError}）` };
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await openXunleiTab(settings);
    } catch (error) {
      return { stage: 'open-page', ok: false, message: (error as Error).message };
    }
    if (tab.id == null) {
      return { stage: 'open-page', ok: false, message: '无法获取迅雷页面标签页' };
    }

    return runSendFlow(tab.id, {
      links: cleaned,
      downloadPath: settings.downloadPath,
      mode: settings.downloadMode,
    });
  }
}

/** 复用已打开的迅雷页（激活 + reload 确保干净状态），否则新开标签页 */
async function openXunleiTab(settings: XunleiSettings): Promise<chrome.tabs.Tab> {
  const xunleiUrl = settings.xunleiUrl.trim();
  const existing = await findXunleiTab(xunleiUrl);
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {
        /* 窗口可能已关闭，忽略 */
      }
    }
    await chrome.tabs.reload(existing.id);
    await waitTabComplete(existing.id);
    return existing;
  }
  const tab = await chrome.tabs.create({ url: xunleiUrl, active: true });
  await waitTabComplete(tab.id!);
  return tab;
}

/**
 * tabs.query 的 url 匹配会忽略 fragment（#/home 后面的部分不参与匹配），
 * 因此去掉 hash 后追加通配符构造匹配模式；模式非法时回退到全量过滤。
 */
async function findXunleiTab(xunleiUrl: string): Promise<chrome.tabs.Tab | undefined> {
  const hashIndex = xunleiUrl.indexOf('#');
  const base = (hashIndex >= 0 ? xunleiUrl.slice(0, hashIndex) : xunleiUrl).trim();
  try {
    const pattern = base.endsWith('*') ? base : `${base}*`;
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length) return tabs[0];
  } catch {
    /* pattern 非法时走下方全量过滤 */
  }
  const all = await chrome.tabs.query({});
  return all.find((tab) => tab.url?.startsWith(base));
}

/** 等待标签页加载完成（监听器保证清理，避免 service worker 泄漏） */
function waitTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && changeInfo.status === 'complete') finish();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(new Error('迅雷页面标签页被关闭'));
    };
    const timer = setTimeout(() => finish(new Error('迅雷页面加载超时')), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 竞态兜底：监听器挂上前可能已加载完成
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish();
      })
      .catch(() => finish(new Error('无法访问迅雷页面标签页')));
  });
}

async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icons/48.png'),
      title,
      message,
    });
  } catch (error) {
    console.warn('[background] 发送通知失败:', error);
  }
}
