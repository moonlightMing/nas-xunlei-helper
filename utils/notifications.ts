import { getSendErrorMeta } from '@/utils/sendErrors';
import type { XunleiSettings } from '@/utils/settings';
import type { SendOutcome } from '@/utils/xunleiAutomation';

export type NotificationAction = 'open-options' | 'open-xunlei' | 'retry';

export interface NotificationActionState {
  id: string;
  actions: NotificationAction[];
  defaultAction: NotificationAction;
  at: number;
}

export const NOTIFICATION_IDS = {
  sendResult: 'nas-xunlei-send-result',
  taskFailure: 'nas-xunlei-task-failure',
  taskComplete: 'nas-xunlei-task-complete',
  info: 'nas-xunlei-info',
} as const;

const ACTION_STORAGE_KEY = 'nas_xunlei_notification_actions';
const ICON_URL = '/icons/48.png';

let memoryActionState: NotificationActionState | null = null;

function iconUrl(): string {
  try {
    return chrome.runtime.getURL(ICON_URL);
  } catch {
    return ICON_URL;
  }
}

function trimMessage(message: string, max = 180): string {
  const value = (message || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function actionLabel(action: NotificationAction): string {
  if (action === 'open-options') return '打开设置';
  if (action === 'retry') return '重试';
  return '打开迅雷';
}

type NotificationContent = Omit<
  chrome.notifications.NotificationCreateOptions,
  'iconUrl' | 'type'
>;

async function show(id: string, options: NotificationContent): Promise<void> {
  try {
    await chrome.notifications.create(id, { iconUrl: iconUrl(), type: 'basic', ...options });
  } catch (error) {
    console.warn('[notifications] 创建通知失败:', error);
  }
}

async function saveActionState(state: NotificationActionState): Promise<void> {
  memoryActionState = state;
  try {
    await chrome.storage.session.set({ [ACTION_STORAGE_KEY]: state });
  } catch (error) {
    console.warn('[notifications] 保存通知动作失败:', error);
  }
}

export async function readNotificationActionState(
  id: string,
): Promise<NotificationActionState | null> {
  if (memoryActionState?.id === id) return memoryActionState;
  try {
    const stored = await chrome.storage.session.get(ACTION_STORAGE_KEY);
    const state = stored?.[ACTION_STORAGE_KEY] as NotificationActionState | undefined;
    if (state && state.id === id) {
      memoryActionState = state;
      return state;
    }
  } catch {
    /* ignore */
  }
  return memoryActionState?.id === id ? memoryActionState : null;
}

export async function clearSendResult(): Promise<void> {
  try {
    await chrome.notifications.clear(NOTIFICATION_IDS.sendResult);
  } catch {
    /* ignore */
  }
}

export async function showSendResult(
  outcome: SendOutcome,
  settings: XunleiSettings,
  links: string[],
): Promise<void> {
  const meta = getSendErrorMeta(outcome.code);
  if (outcome.paused) {
    if (!settings.notifyOnSendFailure) {
      await clearSendResult();
      return;
    }
    await saveActionState({
      id: NOTIFICATION_IDS.sendResult,
      actions: ['open-xunlei', 'open-options'],
      defaultAction: 'open-xunlei',
      at: Date.now(),
    });
    await show(NOTIFICATION_IDS.sendResult, {
      title: 'NAS 迅雷 · 已暂停',
      message: trimMessage(`${outcome.message} ${meta.hint}`),
      buttons: [{ title: '打开迅雷' }, { title: '打开设置' }],
      requireInteraction: true,
      priority: 2,
    });
    return;
  }
  if (!outcome.ok) {
    if (!meta.notify || !settings.notifyOnSendFailure) {
      await clearSendResult();
      return;
    }
    const actions: NotificationAction[] = [];
    const buttons: chrome.notifications.NotificationButton[] = [];
    if (meta.primary) {
      actions.push(meta.primary);
      buttons.push({ title: actionLabel(meta.primary) });
    }
    if (meta.retryable) {
      actions.push('retry');
      buttons.push({ title: actionLabel('retry') });
    }
    await saveActionState({
      id: NOTIFICATION_IDS.sendResult,
      actions,
      defaultAction: actions[0] ?? 'open-xunlei',
      at: Date.now(),
    });
    await show(NOTIFICATION_IDS.sendResult, {
      title: 'NAS 迅雷 · 发送失败',
      message: trimMessage(`${outcome.message} ${meta.hint}`),
      buttons: buttons.length ? buttons : undefined,
      requireInteraction: true,
      priority: 2,
    });
    return;
  }

  const pathFallback = Boolean(outcome.pathApplied?.needed && !outcome.pathApplied.applied);
  if (pathFallback) {
    if (!settings.notifyOnPathFallback) {
      await clearSendResult();
      return;
    }
    await saveActionState({
      id: NOTIFICATION_IDS.sendResult,
      actions: ['open-options', 'open-xunlei'],
      defaultAction: 'open-options',
      at: Date.now(),
    });
    await show(NOTIFICATION_IDS.sendResult, {
      title: 'NAS 迅雷 · 已发送，路径未生效',
      message: trimMessage(outcome.message),
      buttons: [{ title: '打开设置' }, { title: '打开迅雷' }],
      requireInteraction: true,
      priority: 1,
    });
    return;
  }

  if (!settings.notifyOnSendSuccess) {
    await clearSendResult();
    return;
  }
  await saveActionState({
    id: NOTIFICATION_IDS.sendResult,
    actions: ['open-xunlei'],
    defaultAction: 'open-xunlei',
    at: Date.now(),
  });
  await show(NOTIFICATION_IDS.sendResult, {
    title: 'NAS 迅雷 · 已发送',
    message: trimMessage(`${links.length} 个链接。${outcome.message}`),
    buttons: [{ title: '打开迅雷' }],
    requireInteraction: false,
    priority: 0,
  });
}

function taskName(task: { id: string; name: string }): string {
  return task.name || `任务 ${task.id.slice(0, 6)}`;
}

function buildTaskMessage(
  tasks: Array<{ id: string; name: string }>,
  verb: string,
): string {
  const names = tasks.map(taskName);
  const shown = names.slice(0, 3).join('、');
  if (names.length === 1) return `任务${verb}：${shown}。打开迅雷查看详情。`;
  const more = names.length > 3 ? ` 等 ${names.length} 个` : '';
  return `${names.length} 个任务${verb}：${shown}${more}。打开迅雷查看详情。`;
}

export async function showTaskFailure(
  tasks: Array<{ id: string; name: string }>,
): Promise<void> {
  if (!tasks.length) return;
  await show(NOTIFICATION_IDS.taskFailure, {
    title: 'NAS 迅雷 · 下载失败',
    message: trimMessage(buildTaskMessage(tasks, '下载失败')),
    buttons: [{ title: '打开迅雷' }],
    requireInteraction: true,
    priority: 2,
  });
}

export async function showTaskComplete(
  tasks: Array<{ id: string; name: string }>,
): Promise<void> {
  if (!tasks.length) return;
  await show(NOTIFICATION_IDS.taskComplete, {
    title: 'NAS 迅雷 · 下载完成',
    message: trimMessage(buildTaskMessage(tasks, '下载完成')),
    buttons: [{ title: '打开迅雷' }],
    requireInteraction: false,
    priority: 0,
  });
}

export async function showInfoNotification(title: string, message: string): Promise<void> {
  await show(NOTIFICATION_IDS.info, {
    title,
    message: trimMessage(message),
    requireInteraction: false,
    priority: 0,
  });
}
