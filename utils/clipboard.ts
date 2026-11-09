import { message } from 'ant-design-vue';

/**
 * 复制文本到剪贴板并给出提示。供扩展页面（popup / options）在点击事件中使用，
 * 必须由用户手势触发才会拿到剪贴板写权限；失败时提示手动复制。
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success(`已复制 ${text}`);
  } catch {
    message.error('复制失败，请手动选择文本复制');
  }
}
