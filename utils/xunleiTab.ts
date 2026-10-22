export interface OpenXunleiTabOptions {
  /** 复用标签页时是否 reload，默认 true */
  reload?: boolean;
  /** 是否激活标签页，默认 true */
  activate?: boolean;
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    /* 标签页可能已关闭 */
  }
  if (tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* 窗口可能已关闭 */
    }
  }
}

/**
 * tabs.query 的 url 匹配会忽略 fragment，因此去掉 hash 后追加通配符；
 * 模式非法时回退到全量过滤。优先返回当前激活的标签页。
 */
export async function findXunleiTab(xunleiUrl: string): Promise<chrome.tabs.Tab | undefined> {
  const value = xunleiUrl.trim();
  if (!value) return undefined;
  const hashIndex = value.indexOf('#');
  const base = (hashIndex >= 0 ? value.slice(0, hashIndex) : value).trim();
  if (!base) return undefined;

  try {
    const pattern = base.endsWith('*') ? base : `${base}*`;
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length) return tabs.find((tab) => tab.active) ?? tabs[0];
  } catch {
    /* pattern 非法时走下方全量过滤 */
  }

  const all = await chrome.tabs.query({});
  return (
    all.find((tab) => tab.active && tab.url?.startsWith(base)) ??
    all.find((tab) => tab.url?.startsWith(base))
  );
}

/** 等待标签页加载完成（监听器 + 5 秒轮询，轮询同时避免长等待期间 Service Worker 被回收） */
export function waitTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
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
    const poll = setInterval(() => {
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') finish();
        })
        .catch(() => finish(new Error('无法访问迅雷页面标签页')));
    }, 5_000);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
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

/**
 * 打开或复用迅雷页。复用时会先确保 URL 指向配置地址（含 hash），
 * 需要时再 reload，避免用户在小路由里导致新建任务按钮不存在。
 */
export async function openXunleiTab(
  xunleiUrl: string,
  options: OpenXunleiTabOptions = {},
): Promise<chrome.tabs.Tab> {
  const url = xunleiUrl.trim();
  const reload = options.reload ?? true;
  const activate = options.activate ?? true;
  const existing = await findXunleiTab(url);

  if (existing?.id != null) {
    await focusTab(existing);
    let current = existing;
    if ((existing.url ?? '') !== url) {
      current = (await chrome.tabs.update(existing.id, { url, active: activate })) ?? existing;
      await waitTabComplete(existing.id);
    }
    if (reload) {
      await chrome.tabs.reload(existing.id);
      await waitTabComplete(existing.id);
    } else if (current.status === 'loading') {
      await waitTabComplete(existing.id);
    }
    return chrome.tabs.get(existing.id);
  }

  const tab = await chrome.tabs.create({ url, active: activate });
  if (tab.id == null) throw new Error('无法获取迅雷页面标签页');
  await waitTabComplete(tab.id);
  return chrome.tabs.get(tab.id).catch(() => tab);
}

/** 只聚焦或新建，不刷新；用于通知点击、打开迅雷页、测试连接 */
export async function focusXunleiTab(xunleiUrl: string): Promise<chrome.tabs.Tab> {
  const url = xunleiUrl.trim();
  const existing = await findXunleiTab(url);
  if (existing) {
    await focusTab(existing);
    return existing;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id != null) await waitTabComplete(tab.id);
  return tab;
}
