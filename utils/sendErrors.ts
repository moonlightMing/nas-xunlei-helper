export type SendAction = 'open-options' | 'open-xunlei';

export type SendErrorCode =
  | 'no-links'
  | 'settings-missing'
  | 'settings-invalid'
  | 'tab-open-failed'
  | 'tab-load-timeout'
  | 'tab-closed'
  | 'nas-unreachable'
  | 'login-required'
  | 'page-mismatch'
  | 'panel-not-ready'
  | 'dialog-open'
  | 'parse-failed'
  | 'parse-timeout'
  | 'download-click-failed'
  | 'injection-failed'
  | 'av-unmatched'
  | 'av-file-list-timeout'
  | 'av-selection-failed'
  | 'busy'
  | 'unknown';

export interface SendErrorMeta {
  hint: string;
  primary: SendAction | null;
  retryable: boolean;
  notify: boolean;
  severity: 'error' | 'warning';
}

export const SEND_ERROR_META: Record<SendErrorCode, SendErrorMeta> = {
  'no-links': {
    hint: '请粘贴或选中至少一个下载链接',
    primary: null,
    retryable: false,
    notify: true,
    severity: 'error',
  },
  'settings-missing': {
    hint: '请在设置页填写 NAS 迅雷地址',
    primary: 'open-options',
    retryable: false,
    notify: true,
    severity: 'error',
  },
  'settings-invalid': {
    hint: '请检查 NAS 迅雷地址格式',
    primary: 'open-options',
    retryable: false,
    notify: true,
    severity: 'error',
  },
  'tab-open-failed': {
    hint: '请检查 NAS 地址与网络连接',
    primary: 'open-options',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'tab-load-timeout': {
    hint: '请确认 NAS 在线，或稍后重试',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'tab-closed': {
    hint: '迅雷页面已关闭，请重新发送',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'nas-unreachable': {
    hint: '请确认 NAS 在线、地址和端口正确',
    primary: 'open-options',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'login-required': {
    hint: '请在迅雷页面完成登录后重试',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'page-mismatch': {
    hint: '请确认地址指向迅雷套件页面；套件升级后可能需要更新插件',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'panel-not-ready': {
    hint: '请回到迅雷下载首页后重试，或开启“发送前刷新”',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'dialog-open': {
    hint: '请先处理迅雷页面上的弹窗，或开启“发送前刷新”',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'parse-failed': {
    hint: '请检查链接是否有效',
    primary: 'open-xunlei',
    retryable: false,
    notify: true,
    severity: 'error',
  },
  'parse-timeout': {
    hint: '请确认链接有效且迅雷页面可正常操作',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'download-click-failed': {
    hint: '请打开迅雷页面查看任务或重试',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'injection-failed': {
    hint: '请确认迅雷页面未关闭，或稍后重试',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
  'av-unmatched': {
    hint: '请打开迅雷页面手动检查文件勾选，或调整番号匹配规则',
    primary: 'open-xunlei',
    retryable: false,
    notify: true,
    severity: 'warning',
  },
  'av-file-list-timeout': {
    hint: '文件列表未就绪，请打开迅雷页面手动处理',
    primary: 'open-xunlei',
    retryable: false,
    notify: true,
    severity: 'warning',
  },
  'av-selection-failed': {
    hint: '请打开迅雷页面检查文件勾选、磁盘空间或登录状态',
    primary: 'open-xunlei',
    retryable: false,
    notify: true,
    severity: 'error',
  },
  busy: {
    hint: '请等待当前发送完成',
    primary: null,
    retryable: false,
    notify: false,
    severity: 'error',
  },
  unknown: {
    hint: '请重试，或打开迅雷页面检查状态',
    primary: 'open-xunlei',
    retryable: true,
    notify: true,
    severity: 'error',
  },
};

export function getSendErrorMeta(code?: SendErrorCode): SendErrorMeta {
  return code ? SEND_ERROR_META[code] : SEND_ERROR_META.unknown;
}

/** 把 chrome.scripting.executeScript 的异常映射为可诊断的错误码 */
export function classifyInjectionError(message: string): SendErrorCode {
  if (/No tab with id|Invalid tab ID|tab was closed/i.test(message)) return 'tab-closed';
  if (/showing error page|ERR_[A-Z_]+|net::/i.test(message)) return 'nas-unreachable';
  if (/Cannot access a chrome|chrome:\/\//i.test(message)) return 'page-mismatch';
  return 'injection-failed';
}
