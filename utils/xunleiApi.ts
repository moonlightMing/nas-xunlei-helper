/**
 * NAS 迅雷（群晖套件 pan-xunlei-com）HTTP 接口客户端。
 *
 * 契约来源：官方 SPK v3.23.5 内的 grpc-gateway 服务（xunlei-pan-cli），
 * 路径前缀 drive/v1/，并在真实设备上只读验证过。要点：
 *
 * - 鉴权不走 cookie：套件在首页 HTML 里内嵌 `function uiauth(){return "<JWT>"}`，
 *   该 JWT（payload.key = "UIAuth"）有效期约 3 天，随请求以 `pan-auth` 头 +
 *   `pan_auth` 查询参数双通道下发。因此本客户端可在 Service Worker 里直连，
 *   不需要打开迅雷页面。
 * - 服务端不接受 PATCH/DELETE，前端把它们隧道成 `POST method/<verb>/<path>`。
 * - 接口路径不能以 `/` 开头（前端会直接报错），拼接时统一用相对路径。
 * - 写操作（建任务/暂停/改名/删除）只允许出现在本文件显式导出的方法里，
 *   不要新增"通用 request 透传"给上层拼路径。
 */

const TOKEN_SESSION_KEY = 'nas_xunlei_pan_auth';
/** 提前刷新窗口，避免卡在过期边界 */
const TOKEN_REFRESH_SKEW_SECONDS = 120;

export type XunleiPhase =
  | 'PHASE_TYPE_PENDING'
  | 'PHASE_TYPE_RUNNING'
  | 'PHASE_TYPE_PAUSED'
  | 'PHASE_TYPE_ERROR'
  | 'PHASE_TYPE_COMPLETE'
  | (string & {});

export const PHASE_IN_PROGRESS: XunleiPhase[] = [
  'PHASE_TYPE_PENDING',
  'PHASE_TYPE_RUNNING',
  'PHASE_TYPE_PAUSED',
  'PHASE_TYPE_ERROR',
];
export const PHASE_DONE: XunleiPhase[] = ['PHASE_TYPE_COMPLETE'];

/** 下载任务类型：直链/磁力走 download-url，本地种子走 download */
export const TASK_TYPE_URL = 'user#download-url';
export const TASK_TYPE_LOCAL = 'user#download';

export interface XunleiTaskParams {
  url?: string;
  info_hash?: string;
  real_path?: string;
  parent_folder_id?: string;
  /** BT 子文件勾选结果，索引区间串，如 "0-1"、"0,3" */
  sub_file_index?: string;
  total_file_count?: string;
  checked_size?: string;
  /** 当前速度，字节/秒（字符串） */
  speed?: string;
  speed_limit?: string;
  target?: string;
  mime_type?: string;
  file_id?: string;
  [key: string]: unknown;
}

export interface XunleiTask {
  kind: string;
  id: string;
  /** 未解析完的任务（PENDING/ERROR）服务端不返回 name，只有 params.url */
  name?: string;
  type: string;
  space: string;
  phase: XunleiPhase;
  /** 0-100 */
  progress: number;
  file_id?: string;
  file_name?: string;
  /** 字节数（字符串） */
  file_size?: string;
  message?: string;
  created_time?: string;
  updated_time?: string;
  params?: XunleiTaskParams;
}

export interface XunleiFileParams {
  RealPath?: string;
  AliasPath?: string;
  category_id?: string;
  /** 目录是否可写，注意是字符串 "true"/"false" */
  is_write?: string;
  default?: string;
  /** 磁盘余量相关，字节 */
  usage?: string;
  limit?: string;
  [key: string]: unknown;
}

export interface XunleiFile {
  kind: string;
  id: string;
  parent_id: string;
  name: string;
  mime_type?: string;
  size?: string;
  phase?: XunleiPhase;
  params?: XunleiFileParams;
  space?: string;
  [key: string]: unknown;
}

export interface DownloadPathEntry {
  Id: string;
  ParentID: string;
  FileName: string;
  RealPath: string;
  Kind: string;
  [key: string]: unknown;
}

export interface XunleiAbout {
  kind: string;
  quota?: { limit?: number; usage?: number };
  [key: string]: unknown;
}

export type XunleiApiErrorKind =
  | 'unreachable'
  | 'token-missing'
  | 'unauthorized'
  | 'api-error'
  | 'bad-response';

export class XunleiApiError extends Error {
  readonly kind: XunleiApiErrorKind;
  readonly status: number;
  readonly apiError?: string;

  constructor(kind: XunleiApiErrorKind, message: string, status = 0, apiError?: string) {
    super(message);
    this.name = 'XunleiApiError';
    this.kind = kind;
    this.status = status;
    this.apiError = apiError;
  }
}

/** 由设置里的页面地址推出接口根（去 hash、去尾斜杠） */
export function toApiBase(xunleiUrl: string): string {
  const raw = xunleiUrl.trim();
  if (!raw) throw new XunleiApiError('token-missing', '未配置 NAS 迅雷地址');
  const hashIndex = raw.indexOf('#');
  const withoutHash = (hashIndex >= 0 ? raw.slice(0, hashIndex) : raw).trim();
  try {
    const url = new URL(withoutHash);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new XunleiApiError('token-missing', 'NAS 迅雷地址格式不正确');
  }
}

function decodeJwtExp(token: string): number {
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp : 0;
  } catch {
    return 0;
  }
}

interface CachedToken {
  base: string;
  token: string;
  exp: number;
}

let memoryToken: CachedToken | null = null;

async function readCachedToken(): Promise<CachedToken | null> {
  if (memoryToken) return memoryToken;
  try {
    const stored = await chrome.storage.session.get(TOKEN_SESSION_KEY);
    const value = stored?.[TOKEN_SESSION_KEY] as CachedToken | undefined;
    if (value?.token) {
      memoryToken = value;
      return value;
    }
  } catch {
    /* storage.session 不可用时只用内存缓存 */
  }
  return null;
}

async function writeCachedToken(cached: CachedToken): Promise<void> {
  memoryToken = cached;
  try {
    await chrome.storage.session.set({ [TOKEN_SESSION_KEY]: cached });
  } catch {
    /* ignore */
  }
}

const UIAUTH_JWT = /uiauth[^"']*?["']([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})["']/;

/** 从套件首页 HTML 里取出内嵌的 UIAuth JWT */
async function mintToken(base: string): Promise<CachedToken> {
  let html: string;
  try {
    const response = await fetch(`${base}/`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      throw new XunleiApiError('token-missing', `读取迅雷首页失败（HTTP ${response.status}）`, response.status);
    }
    html = await response.text();
  } catch (error) {
    if (error instanceof XunleiApiError) throw error;
    throw new XunleiApiError('unreachable', '无法访问 NAS 迅雷地址');
  }
  const matched = UIAUTH_JWT.exec(html);
  if (!matched) {
    throw new XunleiApiError(
      'token-missing',
      '首页里没有找到 uiauth 令牌，迅雷套件版本可能已变化，请改用页面发送模式',
    );
  }
  const token = matched[1];
  const cached: CachedToken = { base, token, exp: decodeJwtExp(token) };
  await writeCachedToken(cached);
  return cached;
}

/** 取得可用的 pan-auth 令牌，必要时刷新 */
export async function getPanAuth(base: string, force = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const cached = await readCachedToken();
    if (
      cached?.base === base &&
      cached.token &&
      (!cached.exp || cached.exp - now > TOKEN_REFRESH_SKEW_SECONDS)
    ) {
      return cached.token;
    }
  }
  const fresh = await mintToken(base);
  return fresh.token;
}

/** 主动失效缓存（收到 401/403 时调用） */
export function invalidatePanAuth(): void {
  memoryToken = null;
  chrome.storage.session.remove(TOKEN_SESSION_KEY).catch(() => {});
}

type QueryValue = string | number | boolean | undefined | null | string[];

function encodeQuery(query: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * 需要出现在查询串里的 space（GET 列目录/列任务、DELETE 批量删）。
   * 建任务/改任务类接口只在 body 里带 space，与套件前端保持一致，不要重复注入。
   */
  space?: string;
  /** 多设备场景下的 device_space，单设备留空 */
  deviceSpace?: string;
}

/**
 * 发起一次接口调用。path 必须是相对路径（不以 / 开头）。
 * PATCH/DELETE 自动走 method/<verb>/ 隧道。
 */
export async function xunleiRequest<T>(
  xunleiUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const base = toApiBase(xunleiUrl);
  const cleanPath = path.replace(/^\/+/, '');
  const method = options.method ?? 'GET';
  const deviceSpace = options.deviceSpace ?? '';

  const call = async (token: string): Promise<Response> => {
    let url = `${base}/${cleanPath}`;
    let effectiveMethod = method;
    if (method === 'PATCH' || method === 'DELETE') {
      url = `${base}/method/${method.toLowerCase()}/${cleanPath}`;
      effectiveMethod = 'POST';
    }
    const query = encodeQuery({
      ...options.query,
      pan_auth: token,
      space: options.space || undefined,
      device_space: deviceSpace || undefined,
    });
    if (query) url += `?${query}`;

    const headers: Record<string, string> = { 'pan-auth': token, 'Device-Space': deviceSpace };
    const init: RequestInit = { method: effectiveMethod, headers, credentials: 'omit', cache: 'no-store' };
    const isRead = method === 'GET';
    if (!isRead && options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init);
  };

  const token = await getPanAuth(base);
  let response: Response;
  try {
    response = await call(token);
    if (response.status === 401 || response.status === 403) {
      invalidatePanAuth();
      response = await call(await getPanAuth(base, true));
    }
  } catch {
    throw new XunleiApiError('unreachable', '无法访问 NAS 迅雷接口');
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (response.ok) throw new XunleiApiError('bad-response', '迅雷接口返回了非 JSON 内容', response.status);
    }
  }

  const record = (payload ?? {}) as Record<string, unknown>;
  const apiError = typeof record.error === 'string' ? record.error : undefined;
  if (!response.ok || apiError) {
    if (response.status === 402 || response.status === 403 || /permission_deny|checkAuth/.test(apiError ?? '')) {
      throw new XunleiApiError('unauthorized', apiError ?? '令牌无效或已过期', response.status, apiError);
    }
    throw new XunleiApiError('api-error', apiError ?? `迅雷接口返回 HTTP ${response.status}`, response.status, apiError);
  }
  return payload as T;
}

export function fetchAbout(xunleiUrl: string): Promise<XunleiAbout> {
  return xunleiRequest<XunleiAbout>(xunleiUrl, 'drive/v1/about');
}

/** 设备 space（device_id#…）：从 authlogin 返回的跳转链接里解析 */
export async function resolveDeviceSpace(xunleiUrl: string): Promise<string> {
  const raw = await xunleiRequest<string>(xunleiUrl, 'device/authlogin');
  if (typeof raw !== 'string') return '';
  const matched = /[?&]space=([^&]+)/.exec(raw);
  return matched ? decodeURIComponent(matched[1]) : '';
}

const SPACE_TTL_MS = 10 * 60_000;
let spaceCache: { base: string; space: string; at: number } | null = null;

/** 带缓存的设备 space；接口模式下所有任务/目录调用都依赖它 */
export async function getDeviceSpace(xunleiUrl: string, force = false): Promise<string> {
  const base = toApiBase(xunleiUrl);
  if (!force && spaceCache && spaceCache.base === base && spaceCache.space && Date.now() - spaceCache.at < SPACE_TTL_MS) {
    return spaceCache.space;
  }
  const space = await resolveDeviceSpace(xunleiUrl);
  spaceCache = { base, space, at: Date.now() };
  return space;
}

/** 已登记的下载根目录（含 RealPath 与 Id） */
export function fetchDownloadPaths(xunleiUrl: string, space: string): Promise<DownloadPathEntry[]> {
  return xunleiRequest<DownloadPathEntry[]>(xunleiUrl, 'device/download_paths', { space });
}

export interface ListFilesResult {
  kind: string;
  files: XunleiFile[];
  next_page_token?: string;
}

/** 逐层列目录；with 传 withCategoryDiskMountPath/withCategoryDownloadPath 可拿到挂载与下载根标记 */
export function listFiles(
  xunleiUrl: string,
  params: { space: string; parentId?: string; pageToken?: string; limit?: number; with?: string[] },
): Promise<ListFilesResult> {
  return xunleiRequest<ListFilesResult>(xunleiUrl, 'drive/v1/files', {
    space: params.space,
    query: {
      parent_id: params.parentId ?? '',
      page_token: params.pageToken ?? '',
      limit: params.limit ?? 200,
      with: params.with,
    },
  });
}

export interface ListTasksResult {
  kind?: string;
  /** 过滤条件无命中时服务端会整个省略该字段（线上实测），不可当必存在 */
  tasks?: XunleiTask[];
  next_page_token?: string;
  /** 服务端建议的下次刷新秒数 */
  expires_in?: number;
}

export function listTasks(
  xunleiUrl: string,
  params: {
    space: string;
    phases?: XunleiPhase[];
    types?: string[];
    ids?: string[];
    pageToken?: string;
    limit?: number;
  },
): Promise<ListTasksResult> {
  const filters: Record<string, { in: string }> = {};
  if (params.phases?.length) filters.phase = { in: params.phases.join(',') };
  if (params.types?.length) filters.type = { in: params.types.join(',') };
  if (params.ids?.length) filters.id = { in: params.ids.join(',') };
  return xunleiRequest<ListTasksResult>(xunleiUrl, 'drive/v1/tasks', {
    space: params.space,
    query: {
      filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined,
      page_token: params.pageToken ?? '',
      limit: params.limit ?? 100,
    },
  });
}

export interface CreateTaskInput {
  space: string;
  /** 直链 / 磁力 / thunder / ed2k */
  url: string;
  /** 目标目录的接口 Id（drive/v1/files 或 device/download_paths 的 id） */
  parentFolderId: string;
  name?: string;
  fileName?: string;
  /** 字节数；未知传 0 */
  fileSize?: number;
  /** BT 子文件勾选结果，如 "0-1"；整包不传 */
  subFileIndex?: string;
  totalFileCount?: number;
  mimeType?: string;
  type?: string;
}

export function createTask(
  xunleiUrl: string,
  input: CreateTaskInput,
): Promise<{ task?: XunleiTask; HttpStatus?: number }> {
  const type = input.type ?? TASK_TYPE_URL;
  return xunleiRequest(xunleiUrl, 'drive/v1/task', {
    method: 'POST',
    body: {
      type,
      name: input.name || input.fileName || '',
      file_name: input.fileName || input.name || '',
      file_size: String(input.fileSize ?? 0),
      space: input.space,
      params: {
        target: input.space,
        url: input.url,
        total_file_count: String(input.totalFileCount ?? 0),
        parent_folder_id: input.parentFolderId,
        sub_file_index: input.subFileIndex || undefined,
        mime_type: input.mimeType ?? '',
      },
    },
  });
}

/** 暂停 / 继续：phase 传 PHASE_TYPE_PAUSED 或 PHASE_TYPE_RUNNING */
export function operateTask(
  xunleiUrl: string,
  params: { space: string; id: string; type: string; phase: XunleiPhase },
): Promise<Record<string, unknown>> {
  return xunleiRequest(xunleiUrl, 'drive/v1/task', {
    method: 'PATCH',
    body: {
      space: params.space,
      type: params.type,
      id: params.id,
      set_params: { spec: JSON.stringify({ phase: params.phase }) },
    },
  });
}

export function renameTask(
  xunleiUrl: string,
  params: { space: string; id: string; type: string; name: string },
): Promise<Record<string, unknown>> {
  return xunleiRequest(xunleiUrl, 'drive/v1/task', {
    method: 'PATCH',
    body: { id: params.id, space: params.space, type: params.type, name: params.name },
  });
}

export function deleteTasks(
  xunleiUrl: string,
  params: { space: string; ids: string[] },
): Promise<Record<string, unknown>> {
  return xunleiRequest(xunleiUrl, 'drive/v1/tasks', {
    method: 'DELETE',
    space: params.space,
    query: { task_ids: params.ids },
    body: {},
  });
}

/**
 * 按 NAS 路径（如 /downloads/movies）解析出目录 Id。
 * 逐级用 RealPath 精确匹配，只认已存在且可写的目录，绝不创建目录。
 */
export async function resolveFolderIdByPath(
  xunleiUrl: string,
  space: string,
  path: string,
): Promise<{ id: string; matched: string[]; missing: string }> {
  const segments = path.split('/').filter(Boolean);
  const roots = await listFiles(xunleiUrl, {
    space,
    parentId: '',
    limit: 200,
    with: ['withCategoryDiskMountPath', 'withCategoryDownloadPath'],
  });
  const matched: string[] = [];
  let level = roots.files;
  let parentId = '';

  for (const [index, segment] of segments.entries()) {
    const hit = level.find(
      (file) => file.name === segment || file.params?.RealPath?.replace(/\/+$/, '') === `/${segments.slice(0, index + 1).join('/')}`,
    );
    if (!hit) return { id: parentId, matched, missing: segment };
    matched.push(segment);
    parentId = hit.id;
    if (index === segments.length - 1) return { id: hit.id, matched, missing: '' };
    const next = await listFiles(xunleiUrl, { space, parentId: hit.id, limit: 200 });
    level = next.files;
  }
  return { id: parentId, matched, missing: '' };
}

/** 磁力/种子解析结果里的一个节点；目录节点通过 dir.resources 下挂子项 */
export interface ResourceNode {
  id?: string;
  name?: string;
  file_size?: number | string;
  file_count?: number | string;
  is_dir?: boolean;
  /** 迅雷会省略序号 0 的文件，需回退到 id 末段推导 */
  file_index?: number;
  parent_id?: string;
  meta?: { mime_type?: string; hash?: string; url?: string; bt_infohash?: string; [key: string]: unknown };
  dir?: { page_size?: number; resources?: ResourceNode[] };
}

export interface ResourceListResult {
  list_id?: string;
  list?: { page_size?: number; resources?: ResourceNode[] };
}

/** 磁力/种子解析：POST drive/v1/resource/list，urls 用空格分隔 */
export function parseResources(
  xunleiUrl: string,
  urls: string[],
  pageSize = 1000,
): Promise<ResourceListResult> {
  return xunleiRequest<ResourceListResult>(xunleiUrl, 'drive/v1/resource/list', {
    method: 'POST',
    body: { page_size: pageSize, urls: urls.join(' ') },
  });
}

export interface FlatResourceFile {
  id: string;
  name: string;
  /** 含各级祖先目录名的路径，供番号匹配识别"文件夹含番号、文件名不含"的包 */
  path: string;
  size: number;
  /** 迅雷建任务用的文件序号 */
  fileIndex: number;
  mimeType: string;
}

/** 把一棵解析结果拍平成叶子文件列表 */
export function flattenResourceFiles(root: ResourceNode): FlatResourceFile[] {
  const out: FlatResourceFile[] = [];
  const walk = (node: ResourceNode, trail: string[], isRoot: boolean) => {
    const name = node.name ?? '';
    const children = node.dir?.resources ?? [];
    if (node.is_dir || children.length) {
      // 根节点是任务名，不拼进文件 path，否则根名里的番号会让所有文件恒命中
      const next = isRoot ? trail : [...trail, name];
      for (const child of children) walk(child, next, false);
      return;
    }
    const lastSegment = Number(node.id?.split('.').pop());
    out.push({
      id: node.id ?? '',
      name,
      path: [...trail, name].join('/'),
      size: Number(node.file_size ?? 0) || 0,
      fileIndex:
        typeof node.file_index === 'number'
          ? node.file_index
          : Number.isFinite(lastSegment)
            ? lastSegment
            : 0,
      mimeType: node.meta?.mime_type ?? '',
    });
  };
  walk(root, [], true);
  return out;
}

