import { nextTick } from 'vue';

/**
 * action popup 窗口高度有浏览器硬上限（600 DIP，页面缩放 >100% 时可换算出
 * 的 CSS 高度更小）。内容自然高度超过可用空间时窗口直接裁掉底部，而文档级
 * overflow:hidden（style.css，用于压制 Cent 幽灵滚动条）让溢出部分完全不可达
 * ——列表内部滚动条拉到底也看不到最后的卡片和页脚。
 *
 * 处理方式：只在「文档实际溢出视口」时把 #app 钉到视口高度，高度链变成
 * 确定值后，各面板既有的 min-height:0 flex 链会把滚动区压缩到可见空间内
 * 滚动，页脚保持吸底。未溢出时不写任何样式，弹窗仍按内容自适应高度。
 */

/** 溢出判定留 1px 余量：高 DPI 下 scrollHeight 常带 0.x 亚像素误差 */
const OVERFLOW_EPSILON = 1;

/** 内容变化后等弹窗窗口随内容长高再测量，避免拿到尚未变大的旧视口把弹窗冻在小尺寸 */
const RESIZE_GRACE_MS = 250;

let checkTimer: ReturnType<typeof setTimeout> | null = null;

const checkNow = async (): Promise<void> => {
  await nextTick();
  const app = document.getElementById('app');
  if (!app) return;
  const doc = document.documentElement;
  // 先解除钉住测自然高度再定稿，全程同步完成，不产生中间绘制。
  // min-height:100vh 不干扰判定：overflow = max(100vh, 内容高) - 视口高，
  // 内容不足时恰为 0，超出时恰为真实溢出量。
  app.style.height = '';
  const overflow = doc.scrollHeight - doc.clientHeight;
  if (overflow > OVERFLOW_EPSILON) {
    app.style.height = `${doc.clientHeight}px`;
  }
};

/**
 * 安排一次复核。窗口未被限高时会先收到 resize（长高到位）再测量，
 * 不会过早钉住；被限高时没有 resize，按超时兜底压缩滚动区。
 */
export const schedulePopupFit = (): void => {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    checkTimer = null;
    void checkNow();
  }, RESIZE_GRACE_MS);
};

/** 内容增长（RO）与窗口变高（resize）都触发复核；后者同时负责解开过早的钉住 */
export const watchPopupHeight = (): (() => void) => {
  const onWindowResize = (): void => {
    void checkNow();
  };
  window.addEventListener('resize', onWindowResize);
  const observer = new ResizeObserver(() => schedulePopupFit());
  observer.observe(document.body);
  return () => {
    window.removeEventListener('resize', onWindowResize);
    observer.disconnect();
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = null;
  };
};
