import type { SendErrorCode } from '@/utils/sendErrors';
import type { DirItem, SendOutcome } from '@/utils/xunleiAutomation';

export type SendSource = 'popup' | 'context-menu' | 'retry' | 'history';

export interface SendLinksMessage {
  type: 'download';
  action: 'sendLinks';
  data: { links: string[]; source?: SendSource };
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

export type ExtensionMessage =
  | SendLinksMessage
  | OpenXunleiMessage
  | TestConnectionMessage
  | ListDirMessage;
