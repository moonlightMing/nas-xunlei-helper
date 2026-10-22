/**
 * 向 NAS 迅雷 Web 页注入脚本、自动化创建下载任务的模块。
 *
 * 原理沿用原型项目 nas-thunder-helper：复用浏览器里已登录的迅雷 Web 会话，
 * 通过 chrome.scripting.executeScript 注入脚本模拟点击「新建任务 → 填链接 →
 * 解析 → 立即下载」完成建任务。
 *
 * 保存路径需要读取页面的 Vuex（drive.treeNodeId/treeNodePath），因此
 * confirm-download / wait-dialog 两步注入 MAIN world；目录解析复用面板自身的
 * store action（drive/getFolderList、drive/loadFolders），不自行拼接建任务请求。
 *
 * 对接的是群晖套件版迅雷 Web UI（Element UI），选择器与面板状态结构集中在本文件，
 * 迅雷套件更新导致 DOM / Vuex 变化时只需改这里。
 *
 * 注意：注入函数（injectedRunStep）会被序列化进页面执行，必须完全自包含，
 * 不能引用本文件其它顶层作用域的变量。
 */

import type { DownloadMode } from '@/utils/settings';

/** 迅雷 Web UI 关键选择器 */
export const XUNLEI_SELECTORS = {
  /** 「新建任务」按钮 */
  createTaskButton: '.create__task',
  /** 链接输入 textarea */
  linkTextarea: '.el-textarea__inner',
  /** 「解析」/「立即下载」按钮（两个对话框里都有同名 class，查询时需限定对话框） */
  parseButton: '.task-parse-btn',
  /** 解析结果对话框 */
  taskDialog: '.result-nas-task-dialog',
} as const;

/** 自动化单步等待元素的超时（毫秒） */
export const STEP_TIMEOUT_MS = 10_000;

export type AutomationStep = 'create-task' | 'fill-links' | 'confirm-download' | 'wait-dialog';

export interface SendOptions {
  links: string[];
  downloadPath: string;
  mode: DownloadMode;
}

/** 默认路径应用情况 */
export interface PathApplied {
  /** 是否配置了默认路径 */
  needed: boolean;
  /** 是否已写入迅雷面板的目录选择 */
  applied: boolean;
  /** 实际应用的迅雷目录路径（applied=true 时） */
  resolvedPath?: string;
  /** 未能应用的原因（applied=false 且 needed=true 时） */
  reason?: string;
}

/** 发送流程结果（background 与 popup 之间传递，也可用于通知文案） */
export interface SendOutcome {
  /** 流程走到哪一步，失败时用于定位 */
  stage: 'prepare' | 'open-page' | AutomationStep | 'done';
  ok: boolean;
  message: string;
  pathApplied?: PathApplied;
}

interface StepResult {
  ok: boolean;
  message: string;
  pathApplied?: PathApplied;
}

/**
 * 执行完整发送流程（在 background service worker 中调用）。
 * 每一步单独注入一次脚本，步骤间状态由页面 DOM / Vuex 承载。
 */
export async function runSendFlow(tabId: number, options: SendOptions): Promise<SendOutcome> {
  const steps: Array<{ stage: AutomationStep; payload: Record<string, string> }> = [
    { stage: 'create-task', payload: {} },
    { stage: 'fill-links', payload: { links: options.links.join('\n') } },
  ];

  for (const { stage, payload } of steps) {
    const result = await execStep(tabId, stage, payload);
    if (!result.ok) return { stage, ok: false, message: result.message };
  }

  if (options.mode === 'confirm') {
    const result = await execStep(tabId, 'wait-dialog', { downloadPath: options.downloadPath });
    if (!result.ok) return { stage: 'wait-dialog', ok: false, message: result.message };
    return {
      stage: 'done',
      ok: true,
      message: buildDoneMessage('confirm', result.pathApplied),
      pathApplied: result.pathApplied,
    };
  }

  const result = await execStep(tabId, 'confirm-download', { downloadPath: options.downloadPath });
  if (!result.ok) return { stage: 'confirm-download', ok: false, message: result.message };
  return {
    stage: 'done',
    ok: true,
    message: buildDoneMessage('immediate', result.pathApplied),
    pathApplied: result.pathApplied,
  };
}

function buildDoneMessage(mode: DownloadMode, pathApplied?: PathApplied): string {
  if (!pathApplied?.needed) {
    return mode === 'confirm' ? '链接已解析完成，请在迅雷页面确认下载' : '任务已发送并开始下载';
  }
  if (pathApplied.applied) {
    const path = pathApplied.resolvedPath ? ` ${pathApplied.resolvedPath}` : '';
    return mode === 'confirm'
      ? `链接已解析完成，已预选保存路径${path}，请在迅雷页面确认`
      : `任务已发送并开始下载（保存到${path || '指定目录'}）`;
  }
  const reason = pathApplied.reason ? `：${pathApplied.reason}` : '';
  return mode === 'confirm'
    ? `链接已解析完成，但未能应用保存路径${reason}，请在迅雷页面手动选择后确认`
    : `任务已发送并开始下载（未能应用保存路径${reason}，已使用迅雷当前目录）`;
}

async function execStep(
  tabId: number,
  step: AutomationStep,
  payload: Record<string, string>,
): Promise<StepResult> {
  try {
    // 路径预选要读取页面主世界的 Vuex（treeNodeId/treeNodePath），必须注入 MAIN world；
    // 其余步骤只操作 DOM，留在隔离世界即可。
    const needsPageWorld = step === 'confirm-download' || step === 'wait-dialog';
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedRunStep,
      args: [step, payload, XUNLEI_SELECTORS, STEP_TIMEOUT_MS],
      world: needsPageWorld ? 'MAIN' : 'ISOLATED',
    });
    const result = results[0]?.result as StepResult | undefined;
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, message: '注入脚本未返回有效结果' };
    }
    return result;
  } catch (error) {
    return { ok: false, message: `注入迅雷页面脚本失败：${(error as Error).message}` };
  }
}

/**
 * 注入页面执行的步骤函数（自包含，勿引用外部作用域）。
 */
async function injectedRunStep(
  step: AutomationStep,
  payload: Record<string, string>,
  selectors: typeof XUNLEI_SELECTORS,
  timeoutMs: number,
): Promise<StepResult> {
  /** 等待匹配元素出现（MutationObserver + 超时 reject） */
  function waitElement<T extends HTMLElement = HTMLElement>(selector: string, text?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const hit = queryOnce();
      if (hit) return resolve(hit);
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素超时：${selector}${text ? `（文本含“${text}”）` : ''}`));
      }, timeoutMs);
      const observer = new MutationObserver(() => {
        const el = queryOnce();
        if (el) {
          observer.disconnect();
          window.clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      function queryOnce(): T | null {
        const nodes = Array.from(document.querySelectorAll<T>(selector));
        const filtered = text ? nodes.filter((n) => (n.textContent || '').includes(text)) : nodes;
        return filtered[0] ?? null;
      }
    });
  }

  /** 轮询等待条件成立（用于按钮文本变化等非 DOM 出现型状态） */
  async function waitFor<T>(probe: () => T | null): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('等待解析结果超时');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function setTextValue(el: HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 迅雷面板的 Vuex store（目录选择保存在 drive.treeNodeId/treeNodePath） */
  function getPanelStore(): any {
    const root = document.querySelector('#app') as any;
    return root?.__vue_app__?.config?.globalProperties?.$store ?? null;
  }

  function normalizePath(value: string): string {
    const parts = (value || '').trim().replace(/\\/g, '/').split('/').filter(Boolean);
    return '/' + parts.join('/');
  }

  function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(message)), Math.min(timeoutMs, 8_000));
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function waitPanelStore(): Promise<any | null> {
    const deadline = Date.now() + Math.min(timeoutMs, 3_000);
    for (;;) {
      const store = getPanelStore();
      if (store?.state?.drive && store?.state?.user?.userInfo?.target) return store;
      if (Date.now() > deadline) return null;
      await new Promise((r) => window.setTimeout(r, 100));
    }
  }

  async function listFolders(store: any, parentId: string): Promise<any[]> {
    const space = store.state.user.userInfo.target;
    const folders: any[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const result = await withTimeout<any>(
        store.dispatch('drive/loadFolders', {
          space,
          parent_id: parentId,
          limit: 200,
          filters: JSON.stringify({ kind: { eq: 'drive#folder' } }),
          page_token: pageToken,
        }),
        '读取迅雷目录超时',
      );
      folders.push(...(Array.isArray(result?.files) ? result.files : []));
      pageToken = result?.next_page_token || '';
      if (!pageToken) break;
    }
    return folders;
  }

  function clearPanelPath(store: any): void {
    try {
      store.commit('drive/update', { treeNodeId: '', treeNodePath: '', treeNodeName: '' });
    } catch {
      /* 清理失败只影响回退目录，不阻断发送 */
    }
  }

  /**
   * 把配置的保存路径写入迅雷面板的目录选择（Vuex drive.treeNodeId/treeNodePath）。
   * 面板点「立即下载」时会用该目录的 id 作为 parent_folder_id 建任务。
   */
  async function applyDownloadPath(path: string): Promise<PathApplied> {
    const raw = (path || '').trim();
    if (!raw) return { needed: false, applied: false };

    const fail = (reason: string): PathApplied => {
      const store = getPanelStore();
      if (store) clearPanelPath(store);
      return { needed: true, applied: false, reason };
    };

    try {
      const store = await waitPanelStore();
      if (!store) return fail('无法读取迅雷页面状态');

      const target = normalizePath(raw);
      if (target === '/') return fail('不能使用根目录');

      const rootsLoaded =
        Array.isArray(store.state.drive.rootDiskSelectList) && store.state.drive.rootDiskSelectList.length > 0;
      if (!rootsLoaded) {
        await withTimeout(store.dispatch('drive/getFolderList'), '读取迅雷下载目录超时');
      }
      const roots: any[] = Array.isArray(store.state.drive.rootDiskSelectList)
        ? store.state.drive.rootDiskSelectList
        : [];
      if (!roots.length) return fail('未读取到迅雷下载目录');

      const root = roots
        .map((item) => ({ item, path: normalizePath(item?.path || '') }))
        .filter(({ path }) => path && (target === path || target.startsWith(`${path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!root) return fail(`目录不在迅雷可用的下载目录中：${target}`);

      let currentId = root.item.id as string;
      let currentPath = root.path;
      // 面板自身的 treeNodePath 带结尾斜杠，保留它可让路径显示、磁盘空间匹配与手动选择一致
      let currentRealPath = (root.item.path || root.path) as string;
      let currentName = (root.item.title || '') as string;
      const rest = target
        .slice(currentPath.length)
        .split('/')
        .filter(Boolean);

      for (const segment of rest) {
        const children = await listFolders(store, currentId);
        const next =
          children.find(
            (folder) => normalizePath(folder?.params?.RealPath || '') === `${currentPath}/${segment}`,
          ) ?? children.find((folder) => folder?.name === segment);
        if (!next) return fail(`迅雷中不存在目录：${target}`);
        const writable = next.params?.is_write;
        if (writable === false || writable === 'false') return fail(`目录不可写：${target}`);
        currentId = next.id;
        currentRealPath = next.params?.RealPath || `${currentRealPath.replace(/\/+$/, '')}/${segment}/`;
        currentPath = normalizePath(currentRealPath);
        currentName = next.name || segment;
      }

      if (currentPath !== target) return fail(`迅雷中不存在目录：${target}`);

      store.commit('drive/update', {
        treeNodeId: currentId,
        treeNodePath: currentRealPath,
        treeNodeName: currentName,
      });
      await new Promise((r) => window.setTimeout(r, 0));
      if (store.state.drive.treeNodeId !== currentId) return fail('写入迅雷目录选择失败');

      return { needed: true, applied: true, resolvedPath: target };
    } catch (error) {
      return fail((error as Error)?.message || '应用保存路径失败');
    }
  }

  try {
    switch (step) {
      case 'create-task': {
        const button = await waitElement(selectors.createTaskButton);
        button.click();
        return { ok: true, message: '已打开新建任务弹窗' };
      }
      case 'fill-links': {
        const textarea = await waitElement<HTMLTextAreaElement>(selectors.linkTextarea);
        setTextValue(textarea, payload.links || '');
        const parseButton = await waitElement(selectors.parseButton);
        parseButton.click();
        return { ok: true, message: '已填入链接并触发解析' };
      }
      case 'confirm-download': {
        const dialog = await waitElement(selectors.taskDialog);
        // 解析完成后按钮文本从「解析」变为「立即下载」，等它就绪再点。
        // 旧「添加链接」对话框可能还在 DOM 中，必须限定在结果对话框内查找。
        const downloadButton = await waitFor(() => {
          const button = dialog.querySelector<HTMLElement>(selectors.parseButton);
          return button && (button.textContent || '').includes('立即下载') ? button : null;
        });
        const pathApplied = await applyDownloadPath(payload.downloadPath || '');
        downloadButton.click();
        return { ok: true, message: '已点击立即下载', pathApplied };
      }
      case 'wait-dialog': {
        const dialog = await waitElement(selectors.taskDialog);
        await waitFor(() => {
          const button = dialog.querySelector<HTMLElement>(selectors.parseButton);
          return button && (button.textContent || '').includes('立即下载') ? true : null;
        });
        const pathApplied = await applyDownloadPath(payload.downloadPath || '');
        return { ok: true, message: '链接已解析完成', pathApplied };
      }
      default:
        return { ok: false, message: `未知步骤：${step}` };
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message || '自动化步骤执行失败' };
  }
}
