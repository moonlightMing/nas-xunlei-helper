/**
 * 向 NAS 迅雷 Web 页注入脚本、自动化创建下载任务的模块。
 *
 * 原理沿用原型项目 nas-thunder-helper：复用浏览器里已登录的迅雷 Web 会话，
 * 通过 chrome.scripting.executeScript 注入脚本模拟点击「新建任务 → 填链接 →
 * 解析 → 立即下载」完成建任务，不直接调用 NAS HTTP 接口。
 *
 * 对接的是群晖套件版迅雷 Web UI（Element UI），选择器集中在本文件，
 * 迅雷套件更新导致 DOM 变化时只需改这里。
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
  /** 「解析」/「立即下载」按钮 */
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

/** 发送流程结果（background 与 popup 之间传递，也可用于通知文案） */
export interface SendOutcome {
  /** 流程走到哪一步，失败时用于定位 */
  stage: 'prepare' | 'open-page' | AutomationStep | 'done';
  ok: boolean;
  message: string;
  /**
   * 默认路径应用情况：needed=false 表示未配置默认路径；
   * needed=true 且 applied=false 表示对话框中未找到匹配路径（best-effort 失败）。
   */
  pathApplied?: { needed: boolean; applied: boolean };
}

interface StepResult {
  ok: boolean;
  message: string;
  pathApplied?: { needed: boolean; applied: boolean };
}

/**
 * 执行完整发送流程（在 background service worker 中调用）。
 * 每一步单独注入一次脚本，步骤间状态由页面 DOM 承载。
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
      message: '链接已解析完成，请在迅雷页面确认下载',
      pathApplied: result.pathApplied,
    };
  }

  const result = await execStep(tabId, 'confirm-download', { downloadPath: options.downloadPath });
  if (!result.ok) return { stage: 'confirm-download', ok: false, message: result.message };
  const hint = result.pathApplied?.applied === false && options.downloadPath
    ? '（未能在对话框中定位默认路径，已使用 NAS 当前默认目录）'
    : '';
  return { stage: 'done', ok: true, message: `任务已发送并开始下载${hint}`, pathApplied: result.pathApplied };
}

async function execStep(
  tabId: number,
  step: AutomationStep,
  payload: Record<string, string>,
): Promise<StepResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedRunStep,
      args: [step, payload, XUNLEI_SELECTORS, STEP_TIMEOUT_MS],
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

  /**
   * best-effort 检测默认路径是否已在对话框中生效：
   * 只读检测、不点击任何元素，避免误点未知 DOM。
   */
  function detectPath(dialog: ParentNode, path: string): { needed: boolean; applied: boolean } {
    if (!path) return { needed: false, applied: false };
    const segments = path.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] ?? path;
    const candidates = dialog.querySelectorAll<HTMLElement>(
      '[class*="path" i], [class*="dir" i], [class*="folder" i]',
    );
    for (const el of Array.from(candidates)) {
      const text = (el.textContent || '').trim();
      if (text === path || text.endsWith(path) || text === lastSegment) {
        return { needed: true, applied: true };
      }
    }
    return { needed: true, applied: false };
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
        await waitElement(selectors.taskDialog);
        // 解析完成后按钮文本从「解析」变为「立即下载」，等它就绪再点
        const downloadButton = await waitFor(() => {
          const button = document.querySelector<HTMLElement>(selectors.parseButton);
          return button && (button.textContent || '').includes('立即下载') ? button : null;
        });
        const dialog = document.querySelector(selectors.taskDialog);
        const pathApplied = dialog ? detectPath(dialog, payload.downloadPath || '') : { needed: false, applied: false };
        downloadButton.click();
        return { ok: true, message: '已点击立即下载', pathApplied };
      }
      case 'wait-dialog': {
        const dialog = await waitElement(selectors.taskDialog);
        await waitFor(() => {
          const button = document.querySelector<HTMLElement>(selectors.parseButton);
          return button && (button.textContent || '').includes('立即下载') ? true : null;
        });
        const pathApplied = detectPath(dialog, payload.downloadPath || '');
        const hint =
          pathApplied.needed && !pathApplied.applied
            ? '提示：未在对话框中定位到配置的默认路径，请手动确认保存位置。'
            : '';
        return { ok: true, message: `链接已解析完成${hint}`, pathApplied };
      }
      default:
        return { ok: false, message: `未知步骤：${step}` };
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message || '自动化步骤执行失败' };
  }
}
