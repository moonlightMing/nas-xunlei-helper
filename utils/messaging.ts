import type { FileListSnapshot } from '@/utils/avMatch';
import type { ConfirmSelectionInput } from '@/utils/confirm';
import type { SendErrorCode } from '@/utils/sendErrors';
import type { DirItem, SendOutcome } from '@/utils/xunleiAutomation';
import type { XunleiPhase } from '@/utils/xunleiApi';

export type SendSource = 'popup' | 'context-menu' | 'retry' | 'history';

export interface SendLinksMessage {
  type: 'download';
  action: 'sendLinks';
  data: { links: string[]; source?: SendSource; /** 忽略重复资源防呆，强制重发 */ force?: boolean };
}

export type SendLinksResponse = SendOutcome;

export interface OpenXunleiMessage {
  type: 'xunlei';
  action: 'open';
  data?: { url?: string };
}

export interface OpenXunleiResponse {
  ok: boolean;
  code?: SendErrorCode;
  message?: string;
}

export interface TestConnectionMessage {
  type: 'diagnostics';
  action: 'testConnection';
  data: { url: string; downloadPath?: string };
}

export interface DiagnoseCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  code?: SendErrorCode;
}

export interface TestConnectionResponse {
  ok: boolean;
  checks: DiagnoseCheck[];
  code?: SendErrorCode;
  message?: string;
}

export interface ListDirMessage {
  type: 'diagnostics';
  action: 'listDir';
  data: { url: string; parentId?: string; parentPath?: string };
}

export interface ListDirResponse {
  ok: boolean;
  items: DirItem[];
  code?: SendErrorCode;
  message?: string;
}

export interface ReadDialogFilesMessage {
  type: 'avMatch';
  action: 'readDialogFiles';
}

export interface ReadDialogFilesResponse {
  ok: boolean;
  snapshot?: FileListSnapshot;
  code?: SendErrorCode;
  message?: string;
  debug?: string;
}

/** popup 任务页用的精简视图（避免把整个 drive#task 塞进消息） */
export interface TaskSummary {
  id: string;
  name: string;
  type: string;
  phase: XunleiPhase;
  /** 0-100 */
  progress: number;
  /** 字节/秒 */
  speed: number;
  /** 任务总大小，字节 */
  totalSize: number;
  /** 已勾选/已下载字节 */
  checkedSize: number;
  /** NAS 上的实际路径 */
  realPath: string;
  message: string;
  /** 创建时间（epoch 毫秒），服务端未返回或解析失败时为 0 */
  createdAt: number;
}

export interface ListTasksMessage {
  type: 'tasks';
  action: 'list';
  data?: { tab?: 'ing' | 'done'; limit?: number };
}

export interface ListTasksResponse {
  ok: boolean;
  tasks: TaskSummary[];
  /** 服务端建议的下次刷新秒数 */
  expiresIn?: number;
  code?: SendErrorCode;
  message?: string;
}

export interface OperateTaskMessage {
  type: 'tasks';
  action: 'operate';
  data: { id: string; phase: XunleiPhase };
}

export interface DeleteTasksMessage {
  type: 'tasks';
  action: 'delete';
  data: { ids: string[] };
}

export interface TaskActionResponse {
  ok: boolean;
  code?: SendErrorCode;
  message?: string;
}

/** 接口模式「确认后下载」窗口提交/取消（内部页面消息） */
export interface ConfirmSubmitMessage {
  type: 'confirm';
  action: 'submit';
  data: { id: string; selections: ConfirmSelectionInput[]; parentFolderId?: string };
}

export interface ConfirmCancelMessage {
  type: 'confirm';
  action: 'cancel';
  data: { id: string };
}

/** 清空发送记录：写入统一走 background 单一队列，避免与监控回写互相覆盖 */
export interface ClearHistoryMessage {
  type: 'history';
  action: 'clear';
}

export interface ClearHistoryResponse {
  ok: boolean;
  message?: string;
}

export type ExtensionMessage =
  | SendLinksMessage
  | OpenXunleiMessage
  | TestConnectionMessage
  | ListDirMessage
  | ReadDialogFilesMessage
  | ListTasksMessage
  | OperateTaskMessage
  | DeleteTasksMessage
  | ConfirmSubmitMessage
  | ConfirmCancelMessage
  | ClearHistoryMessage;
