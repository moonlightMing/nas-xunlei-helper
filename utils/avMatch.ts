/**
 * 番号匹配纯规则：文件分类、番号提取/归一化、自动识别、排序与勾选计划。
 *
 * 不依赖 chrome/DOM，background、选项页预览共用同一套逻辑。
 * 番号归一化参考 xeyes 的 normalizer.go，但只保留匹配所需的最小集合；
 * 匹配比较 base（去掉分集/字幕后缀），因此 ABC-123、ABC-123-C、ABC-123-CD2 同源，
 * ABC-123 不会命中 ABC-1234。
 */

export type FileCategory = 'video' | 'image' | 'text' | 'audio' | 'other';
export type MatchSort = 'size-desc' | 'size-asc' | 'name-asc' | 'name-desc';

export interface AvMatchSettings {
  enabled: boolean;
  manualCodes: string[];
  keepCategories: FileCategory[];
  minFileSizeMB: number;
  maxFilesPerTask: number;
  sort: MatchSort;
  excludeKeywords: string[];
  fallbackToDefault: boolean;
}

export const FILE_CATEGORIES: FileCategory[] = ['video', 'image', 'text', 'audio', 'other'];

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  video: '视频',
  image: '图片',
  text: '文本/字幕',
  audio: '音频',
  other: '其他',
};

export const MATCH_SORT_LABELS: Record<MatchSort, string> = {
  'size-desc': '文件大小：大到小',
  'size-asc': '文件大小：小到大',
  'name-asc': '文件名：A → Z',
  'name-desc': '文件名：Z → A',
};

export const DEFAULT_AV_MATCH_SETTINGS: AvMatchSettings = {
  enabled: false,
  manualCodes: [],
  keepCategories: ['video'],
  minFileSizeMB: 0,
  maxFilesPerTask: 0,
  sort: 'size-desc',
  excludeKeywords: ['sample', 'trailer', '预告', '广告', '宣传', '网址', '说明'],
  fallbackToDefault: false,
};

export function cloneAvMatchSettings(settings: AvMatchSettings): AvMatchSettings {
  return {
    ...settings,
    manualCodes: [...settings.manualCodes],
    keepCategories: [...settings.keepCategories],
    excludeKeywords: [...settings.excludeKeywords],
  };
}

export interface SnapshotFile {
  id: string;
  name: string;
  /** 含祖先文件夹名的路径，用于识别“文件夹含番号、文件名不含”的包 */
  path: string;
  /** 字节；0 表示未知 */
  size: number;
}

export interface SnapshotGroup {
  rootId: string;
  rootName: string;
  files: SnapshotFile[];
}

export interface FileListSnapshot {
  kind: 'bt' | 'single' | 'unknown';
  treeHash: string;
  groups: SnapshotGroup[];
  checkedIds: string[];
  buttonDisabled: boolean;
  truncated: boolean;
}

export type MatchFileReason =
  | 'matched'
  | 'type-filtered'
  | 'keyword-filtered'
  | 'size-filtered'
  | 'code-mismatch'
  | 'over-limit';

export interface MatchFileDecision {
  id: string;
  name: string;
  path: string;
  size: number;
  category: FileCategory;
  codes: string[];
  selected: boolean;
  reason: MatchFileReason;
  matchSource?: 'manual' | 'auto';
  rank?: number;
}

export type MatchGroupStatus = 'matched' | 'no-code' | 'ambiguous' | 'no-files';

export interface MatchGroupResult {
  rootId: string;
  rootName: string;
  status: MatchGroupStatus;
  codes: string[];
  totalFiles: number;
  matchedFiles: number;
  selectedFiles: number;
  selectedIds: string[];
  files: MatchFileDecision[];
}

export type MatchPlanStatus = 'applied' | 'partial' | 'empty' | 'skipped';
export type MatchSkipReason = 'no-file-list' | 'too-many-files' | 'empty-tree' | 'disabled';

export interface MatchPlan {
  applicable: boolean;
  policy: 'strict' | 'fallback';
  status: MatchPlanStatus;
  skipped?: MatchSkipReason;
  groups: MatchGroupResult[];
  selectedIds: string[];
  preserveRootIds: string[];
  totalFiles: number;
  matchedFiles: number;
  selectedFiles: number;
  unmatchedGroups: number;
  fallbackUsed: boolean;
  summary: string;
}

/** 发送结果/历史只携带摘要，避免把几千个文件的决策跨上下文传递 */
export interface MatchSummary {
  status: MatchPlanStatus;
  policy: 'strict' | 'fallback';
  totalGroups: number;
  matchedGroups: number;
  totalFiles: number;
  matchedFiles: number;
  selectedFiles: number;
  codes: string[];
  unmatchedRoots: string[];
  skipped?: MatchSkipReason;
}

export interface ParsedManualCodes {
  codes: string[];
  invalid: string[];
}

interface ParsedCode {
  code: string;
  baseKey: string;
  prefix: string;
  number: string;
  part?: string;
}

interface CodeCandidate extends ParsedCode {
  priority: number;
  index: number;
}

interface TargetCode {
  parsed: ParsedCode;
  source: 'manual' | 'auto';
  inheritFromRoot: boolean;
}

interface FileInfo {
  file: SnapshotFile;
  category: FileCategory;
  candidates: CodeCandidate[];
  typeFiltered: boolean;
  keywordFiltered: boolean;
  sizeFiltered: boolean;
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'ts', 'm2ts', 'mts', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v',
  'mpg', 'mpeg', 'rmvb', 'rm', '3gp', 'asf', 'vob', 'iso', 'tp',
]);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'heic', 'avif', 'svg']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'nfo', 'url', 'lnk', 'srt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'vtt',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'md', 'json', 'xml', 'html', 'htm', 'rtf',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape', 'alac', 'aiff']);

const BLACKLIST_PREFIXES = new Set([
  'H264', 'H265', 'X264', 'X265', 'HEVC', 'AVC', 'HDR', 'HDR10', 'DIVX', 'XVID',
  'AAC', 'DTS', 'AC3', 'EAC3', 'MPEG', 'MPG', 'WEB', 'DL', 'UHD', 'FHD', 'HD', 'SD',
  'CD', 'DVD', 'BD', 'REMUX', 'PROPER', 'REPACK', 'BLURAY', 'BRRIP', 'BDRIP', 'HDRIP',
  'AV1', 'VP9', 'MP4', 'MKV', 'PPV', 'COM', 'NET', 'ORG', 'XYZ', 'WWW',
  'VIDEO', 'VIDEOS', 'MOVIE', 'MOVIES', 'CLIP', 'CLIPS', 'SAMPLE', 'SAMPLES',
  'TRAILER', 'TRAILERS', 'PREVIEW', 'PROMO', 'COLLECTION', 'PACK', 'SEASON',
  'EPISODE', 'EPISODES', 'VOL', 'VOLUME', 'PART', 'DISC', 'FULL',
  // 通用文件名词：file01/track01/scene02/img_1234 这类序号名不是番号，
  // 不拦会把"零候选→根名兜底"这条生命线堵死（严格模式整组误判未匹配）
  'FILE', 'FILES', 'TRACK', 'TRACKS', 'SCENE', 'SCENES', 'IMAGE', 'IMAGES',
  'IMG', 'PIC', 'PICS', 'PHOTO', 'PHOTOS', 'SCREEN', 'SCREENS', 'TOP',
]);

const DOMAIN_SUFFIX = /^(?:com|net|org|xyz|me|vip|cc|tv|info|top|club|site|online|app|io|co|la|ws)\b/i;

const FC2_PATTERN = /FC2[-_\s.]?(?:PPV[-_\s.]?)?(\d{5,8})(?!\d)(?:[-_](\d+|[A-Z]))?/gi;
const TOKYO_HOT_PATTERN = /(?<![A-Za-z0-9])N\d{4}(?:[-_][A-Z]+)+(?![A-Za-z0-9])/gi;
const TOKYO_HOT_BARE_PATTERN = /(?<![A-Za-z0-9])N\d{3,4}(?![A-Za-z0-9])/gi;
const CARIBBEAN_PATTERN = /(?<![A-Za-z0-9])\d{6}[-_]\d{3}(?:[-_][A-Za-z0-9]+)?(?![A-Za-z0-9])/g;
const DIGIT_PREFIX_PATTERN =
  /(?<![A-Za-z0-9])\d{3,4}([A-Za-z]{2,8})[-_.\s]?(\d{2,5})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?(?![A-Za-z0-9])/g;
const PREFIX_WITH_DIGITS_PATTERN =
  /(?<![A-Za-z0-9])([A-Za-z]{1,4}\d{1,3})[-_.\s](\d{2,7})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?(?![A-Za-z0-9])/g;
const STANDARD_PATTERN =
  /(?<![A-Za-z0-9])([A-Za-z]{2,10})[-_.\s]?(\d{2,7})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?(?![A-Za-z0-9])/g;
const CD_ADJACENT_PATTERN =
  /(?<![A-Za-z0-9])([A-Za-z]{2,10})[-_.\s]?(\d{2,7})cd(\d{1,2})(?![A-Za-z0-9])/gi;
const CH_ADJACENT_PATTERN =
  /(?<![A-Za-z0-9])([A-Za-z]{2,10})[-_.\s]?(\d{2,7})(C|UC|CH|R)(?![A-Za-z0-9])/gi;
const UNCENSORED_DATE_PATTERN =
  /^(?:1PON(?:DO)?|10MU(?:SUME)?|CARIB(?:BEAN)?)[-_\s]?(\d{6})[-_](\d{2,3})$/i;
const QUALITY_SUFFIX_PATTERN =
  /(?:[-_.\s](?:H26[45]|X26[45]|HEVC|AVC|FHD|HD|SD|UHD|4K|8K|1080P|720P|2160P|WEB[-_.\s]?DL|BLURAY|BRRIP|BDRIP|HDRIP|REMUX|HDR10?|DIVX|XVID))(?=$|[-_.\s/])/gi;

const PRIORITY_FC2 = 100;
const PRIORITY_TOKYO = 90;
const PRIORITY_UNCENSORED = 85;
const PRIORITY_DIGIT_PREFIX = 80;
const PRIORITY_CD = 70;
const PRIORITY_PREFIX_DIGITS = 60;
const PRIORITY_STANDARD = 50;
const PRIORITY_NO_DASH = 40;

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function uniqueKeywords(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim().slice(0, 40);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

export function getExtension(name: string): string {
  const clean = name.trim();
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  const ext = clean.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function classifyFileCategory(name: string): FileCategory {
  const ext = getExtension(name);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'other';
}

function stripExtension(name: string): string {
  const clean = name.trim();
  const ext = getExtension(clean);
  if (!ext) return clean;
  return clean.slice(0, clean.length - ext.length - 1);
}

function stripQualitySuffixes(name: string): string {
  return name.replace(QUALITY_SUFFIX_PATTERN, '');
}

export function normalizeAvId(value: string): string {
  return value.toUpperCase().replace(/[\s._-]+/g, '');
}

function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+(?=\d)/, '');
  return stripped || '0';
}

function isAsciiLetter(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z]/.test(char));
}

function isBlacklisted(prefix: string, number: string): boolean {
  const upperPrefix = prefix.toUpperCase();
  if (BLACKLIST_PREFIXES.has(upperPrefix)) return true;
  const basePrefix = upperPrefix.replace(/\d+$/, '');
  if (basePrefix && BLACKLIST_PREFIXES.has(basePrefix) && basePrefix !== upperPrefix) return true;
  if (/^(?:19|20)\d{2}$/.test(number) && upperPrefix.length <= 2) return true;
  return false;
}

function parseCanonicalCode(raw: string): ParsedCode | null {
  const value = stripQualitySuffixes(raw.trim().replace(/^[-_.\s]+|[-_.\s]+$/g, ''));
  if (!value) return null;

  const uncensored = value.match(UNCENSORED_DATE_PATTERN);
  if (uncensored?.[1] && uncensored[2]) {
    const date = uncensored[1];
    const number = uncensored[2];
    return {
      code: `${date}-${number}`,
      baseKey: `${stripLeadingZeros(date)}${stripLeadingZeros(number)}`,
      prefix: date,
      number,
    };
  }

  const fc2 = value.match(/^FC2[-_\s.]?(?:PPV[-_\s.]?)?(\d{5,8})(?:[-_.](\d+|[A-Z]))?$/i);
  if (fc2?.[1]) {
    const number = fc2[1];
    const part = fc2[2] ? fc2[2].toUpperCase() : '';
    return {
      code: `FC2-${number}${part ? `-${part}` : ''}`,
      baseKey: `FC2${stripLeadingZeros(number)}`,
      prefix: 'FC2',
      number,
      part: part || undefined,
    };
  }

  const tokyo = value.match(/^N(\d{3,4})(?:[-_].*)?$/i);
  if (tokyo?.[1]) {
    const number = tokyo[1];
    return {
      code: `N${number}`,
      baseKey: `N${stripLeadingZeros(number)}`,
      prefix: 'N',
      number,
    };
  }

  const caribbean = value.match(/^(\d{6})[-_.\s]?(\d{3})(?:[-_.\s](.+))?$/);
  if (caribbean?.[1] && caribbean[2]) {
    const date = caribbean[1];
    const number = caribbean[2];
    const part = caribbean[3] ? caribbean[3].toUpperCase() : '';
    return {
      code: `${date}-${number}${part ? `-${part}` : ''}`,
      baseKey: `${stripLeadingZeros(date)}${stripLeadingZeros(number)}`,
      prefix: date,
      number,
      part: part || undefined,
    };
  }

  const digitPrefix = value.match(/^\d{3,4}([A-Za-z]{2,8})[-_.\s]?(\d{2,5})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?$/);
  if (digitPrefix?.[1] && digitPrefix[2]) {
    const prefix = digitPrefix[1].toUpperCase();
    const number = digitPrefix[2];
    const part = digitPrefix[3] ? digitPrefix[3].toUpperCase() : '';
    if (!isBlacklisted(prefix, number)) {
      return {
        code: `${prefix}-${number}${part ? `-${part}` : ''}`,
        baseKey: `${prefix}${stripLeadingZeros(number)}`,
        prefix,
        number,
        part: part || undefined,
      };
    }
  }

  const standard = value.match(/^([A-Za-z]{2,10})[-_.\s]?(\d{2,7})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?$/);
  if (standard?.[1] && standard[2]) {
    let prefix = standard[1].toUpperCase();
    const number = standard[2];
    const part = standard[3] ? standard[3].toUpperCase() : '';
    if (prefix === '200GANA') prefix = 'GANA';
    if (!isBlacklisted(prefix, number)) {
      return {
        code: `${prefix}-${number}${part ? `-${part}` : ''}`,
        baseKey: `${prefix}${stripLeadingZeros(number)}`,
        prefix,
        number,
        part: part || undefined,
      };
    }
  }

  const prefixDigits = value.match(/^([A-Za-z]{1,4}\d{1,3})[-_.\s](\d{2,7})(?:[-_.\s]([A-Za-z]{1,3}\d*|\d{1,3}))?$/);
  if (prefixDigits?.[1] && prefixDigits[2]) {
    const prefix = prefixDigits[1].toUpperCase();
    const number = prefixDigits[2];
    const part = prefixDigits[3] ? prefixDigits[3].toUpperCase() : '';
    const basePrefix = prefix.replace(/\d+$/, '');
    if (!isBlacklisted(prefix, number) && !BLACKLIST_PREFIXES.has(basePrefix)) {
      return {
        code: `${prefix}-${number}${part ? `-${part}` : ''}`,
        baseKey: `${prefix}${stripLeadingZeros(number)}`,
        prefix,
        number,
        part: part || undefined,
      };
    }
  }

  return null;
}

function isSiteLike(
  source: string,
  matchIndex: number,
  matchLength: number,
  matchText: string,
): boolean {
  if (/\.(?:com|net|org|xyz|me|vip|cc|tv|info|top|club|site|online|app|io|co|la|ws)\b/i.test(matchText)) {
    return true;
  }
  if (matchIndex > 0 && /^(?:com|net|org|xyz|me|vip|cc|tv|info|top|club|site|online|app|io|co|la|ws)\b/i.test(matchText)) {
    const before = source[matchIndex - 1];
    if (before === '.' || before === '@') return true;
  }
  const after = source.slice(matchIndex + matchLength);
  if (after.startsWith('@')) return true;
  if (after.startsWith('.')) {
    const rest = after.slice(1);
    if (DOMAIN_SUFFIX.test(rest)) return true;
  }
  return false;
}

function addCandidate(
  source: string,
  matches: CodeCandidate[],
  rawCode: string,
  priority: number,
  index: number,
  matchText: string,
  matchLength: number,
): void {
  const parsed = parseCanonicalCode(rawCode);
  if (!parsed) return;
  if (isBlacklisted(parsed.prefix, parsed.number)) return;
  if (isSiteLike(source, index, matchLength, matchText)) return;
  matches.push({ ...parsed, priority, index });
}

function extractAnchored(name: string): CodeCandidate[] {
  const out: CodeCandidate[] = [];
  const cleaned = name.trim();

  const cdPart = cleaned.match(/^([A-Za-z]{2,10})[-_.\s]?(\d{2,7})[-_.\s]?cd(\d{1,2})$/i);
  if (cdPart) {
    addCandidate(
      cleaned,
      out,
      `${cdPart[1]}-${cdPart[2]}-${cdPart[3]}`,
      PRIORITY_CD,
      0,
      cleaned,
      cleaned.length,
    );
  }

  const chSuffix = cleaned.match(/^([A-Za-z]{2,10}[-_.\s]?\d{2,7})([CH])$/i);
  if (chSuffix) {
    addCandidate(cleaned, out, `${chSuffix[1]}-C`, PRIORITY_CD, 0, cleaned, cleaned.length);
  }

  const noDash = cleaned.match(/^([A-Za-z]{2,10})(\d{2,7})(?:[-_.\s]?([A-Za-z]{1,3}\d*|\d{1,3}))?$/i);
  if (noDash) {
    addCandidate(
      cleaned,
      out,
      `${noDash[1]}-${noDash[2]}${noDash[3] ? `-${noDash[3]}` : ''}`,
      PRIORITY_NO_DASH,
      0,
      cleaned,
      cleaned.length,
    );
  }

  return out;
}

/** 从文件名/路径中提取所有可能的番号，按优先级去重 */
export function extractCodeCandidates(input: string): CodeCandidate[] {
  const source = stripQualitySuffixes(stripExtension(String(input || '')));
  if (!source) return [];

  const candidates: CodeCandidate[] = [...extractAnchored(source)];

  for (const match of source.matchAll(FC2_PATTERN)) {
    const index = match.index ?? 0;
    let part = match[2] ? match[2].toUpperCase() : '';
    if (part.length === 1 && isAsciiLetter(part)) {
      const afterPart = source[index + match[0].length];
      if (isAsciiLetter(afterPart)) part = '';
    }
    addCandidate(
      source,
      candidates,
      `FC2-${match[1]}${part ? `-${part}` : ''}`,
      PRIORITY_FC2,
      index,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(TOKYO_HOT_PATTERN)) {
    addCandidate(
      source,
      candidates,
      match[0],
      PRIORITY_TOKYO,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  const leaf = source.split(/[\\/]/).pop() || source;
  const tokyoContext = /(?:tokyo[-_ ]?hot|東熱)/i.test(source);
  if (tokyoContext || /^N\d{3,4}$/i.test(leaf)) {
    for (const match of source.matchAll(TOKYO_HOT_BARE_PATTERN)) {
      addCandidate(
        source,
        candidates,
        match[0],
        PRIORITY_TOKYO - 5,
        match.index ?? 0,
        match[0],
        match[0].length,
      );
    }
  }

  for (const match of source.matchAll(CARIBBEAN_PATTERN)) {
    addCandidate(
      source,
      candidates,
      match[0],
      PRIORITY_UNCENSORED,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(DIGIT_PREFIX_PATTERN)) {
    addCandidate(
      source,
      candidates,
      `${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}`,
      PRIORITY_DIGIT_PREFIX,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(CD_ADJACENT_PATTERN)) {
    addCandidate(
      source,
      candidates,
      `${match[1]}-${match[2]}-${match[3]}`,
      PRIORITY_CD,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(CH_ADJACENT_PATTERN)) {
    addCandidate(
      source,
      candidates,
      `${match[1]}-${match[2]}-${match[3] === 'H' ? 'C' : match[3]}`,
      PRIORITY_CD,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(PREFIX_WITH_DIGITS_PATTERN)) {
    addCandidate(
      source,
      candidates,
      `${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}`,
      PRIORITY_PREFIX_DIGITS,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  for (const match of source.matchAll(STANDARD_PATTERN)) {
    addCandidate(
      source,
      candidates,
      `${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}`,
      PRIORITY_STANDARD,
      match.index ?? 0,
      match[0],
      match[0].length,
    );
  }

  const deduped = new Map<string, CodeCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.baseKey);
    if (!existing || candidate.priority > existing.priority) {
      deduped.set(candidate.baseKey, candidate);
    }
  }
  return [...deduped.values()].sort((a, b) => b.priority - a.priority || a.index - b.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boundaryMatch(source: string, target: ParsedCode): boolean {
  const prefix = target.prefix;
  const number = stripLeadingZeros(target.number);
  if (!prefix || !number) return false;

  if (prefix === 'FC2') {
    const re = new RegExp(
      `(?:^|[^A-Za-z0-9])FC2[-_.\\s]?(?:PPV[-_.\\s]?)?0*${number}(?![0-9])`,
      'i',
    );
    return re.test(source);
  }

  if (/^\d+$/.test(prefix)) {
    // 数字前缀（加勒比/一本道等）：带边界匹配。纯 includes 会让 "1060819917"
    // 误命中 "060819-917"（去分隔符后是子串），把无关文件卷进勾选
    const numericRe = new RegExp(
      `(?:^|[^A-Za-z0-9])0*${escapeRegExp(stripLeadingZeros(target.prefix))}[-_.\\s]?0*${number}(?![0-9])`,
    );
    return numericRe.test(source);
  }

  const re = new RegExp(
    `(?:^|[^A-Za-z0-9])(?:\\d{3,4})?${escapeRegExp(prefix)}[-_.\\s]?0*${number}(?![0-9])`,
    'i',
  );
  return re.test(source);
}

export function fileMatchesCode(file: Pick<SnapshotFile, 'name' | 'path'>, target: ParsedCode): boolean {
  const source = file.path || file.name;
  const candidates = extractCodeCandidates(source);
  if (candidates.some((candidate) => candidate.baseKey === target.baseKey)) return true;
  // 提取失败时才用边界兜底，避免站点 tag 被当成番号
  if (!candidates.length) return boundaryMatch(source, target);
  return false;
}

function matchesAnyTarget(info: FileInfo, targets: TargetCode[]): TargetCode[] {
  const source = info.file.path || info.file.name;
  return targets.filter((target) => {
    if (info.candidates.some((candidate) => candidate.baseKey === target.parsed.baseKey)) {
      return true;
    }
    // 只有没提取到任何番号时才用边界兜底，避免站点 tag 被当成番号
    return info.candidates.length === 0 ? boundaryMatch(source, target.parsed) : false;
  });
}

function countPrimaryBases(files: FileInfo[]): Array<{ base: ParsedCode; count: number }> {
  const counts = new Map<string, { base: ParsedCode; count: number }>();
  for (const info of files) {
    const seen = new Set<string>();
    for (const candidate of info.candidates) {
      if (seen.has(candidate.baseKey)) continue;
      seen.add(candidate.baseKey);
      const existing = counts.get(candidate.baseKey);
      if (existing) existing.count += 1;
      else counts.set(candidate.baseKey, { base: candidate, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

function matchKeyword(info: FileInfo, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const name = info.file.name.toLowerCase();
  return keywords.some((keyword) => keyword && name.includes(keyword));
}

function compareFiles(a: FileInfo, b: FileInfo, sort: MatchSort): number {
  const nameCompare = a.file.name.localeCompare(b.file.name, 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });

  if (sort === 'name-asc') return nameCompare;
  if (sort === 'name-desc') return -nameCompare;

  const aKnown = a.file.size > 0;
  const bKnown = b.file.size > 0;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown && a.file.size !== b.file.size) {
    return sort === 'size-desc' ? b.file.size - a.file.size : a.file.size - b.file.size;
  }
  return nameCompare;
}

function rootMatchesManual(rootName: string, target: ParsedCode): boolean {
  return fileMatchesCode({ name: rootName, path: rootName }, target);
}

function detectTargets(
  group: SnapshotGroup,
  files: FileInfo[],
  settings: AvMatchSettings,
  manualCodes: ParsedCode[],
  extraCodes: ParsedCode[],
): { targets: TargetCode[]; status?: MatchGroupStatus } {
  if (!files.length) return { targets: [], status: 'no-files' };

  const manualTargets: TargetCode[] = [];
  for (const manual of manualCodes) {
    const atRoot = rootMatchesManual(group.rootName, manual);
    const atFile = files.some((info) => info.candidates.some((candidate) => candidate.baseKey === manual.baseKey));
    if (atRoot || atFile) {
      manualTargets.push({ parsed: manual, source: 'manual', inheritFromRoot: atRoot });
    }
  }
  if (manualTargets.length) {
    return { targets: manualTargets };
  }

  const rootCandidates = extractCodeCandidates(group.rootName);
  const rootCodeMap = new Map<string, ParsedCode>();
  for (const candidate of [...rootCandidates, ...extraCodes]) {
    if (!rootCodeMap.has(candidate.baseKey)) rootCodeMap.set(candidate.baseKey, candidate);
  }
  const rootCodes = [...rootCodeMap.values()];

  if (rootCodes.length) {
    const scored = rootCodes.map((parsed) => ({
      parsed,
      hits: files.filter((info) => info.candidates.some((candidate) => candidate.baseKey === parsed.baseKey)).length,
      noCodeCount: files.filter((info) => info.candidates.length === 0).length,
    }));
    scored.sort((a, b) => b.hits - a.hits);

    const top = scored[0];
    const second = scored[1];
    if (top && top.hits > 0 && (!second || top.hits > second.hits)) {
      return { targets: [{ parsed: top.parsed, source: 'auto', inheritFromRoot: true }] };
    }
    if (scored.length === 1 && top?.hits === 0 && top.noCodeCount > 0) {
      return { targets: [{ parsed: top.parsed, source: 'auto', inheritFromRoot: true }] };
    }
    // 根名有码但没有任何文件对得上：不改选文件里的其他番号，交给严格/回退策略处理
    return { targets: [], status: scored.length === 1 ? 'no-files' : 'ambiguous' };
  }

  const counted = countPrimaryBases(files);
  const primary = counted[0];
  if (!primary) return { targets: [], status: 'no-code' };
  const secondary = counted[1];
  if (!secondary || primary.count > secondary.count) {
    return { targets: [{ parsed: primary.base, source: 'auto', inheritFromRoot: false }] };
  }
  return { targets: [], status: 'ambiguous' };
}

function planGroup(
  group: SnapshotGroup,
  settings: AvMatchSettings,
  manualCodes: ParsedCode[],
  extraCodes: ParsedCode[],
): MatchGroupResult {
  const minSize = settings.minFileSizeMB * 1024 * 1024;
  const keywords = settings.excludeKeywords.map(normalizeKeyword).filter(Boolean);
  const keep = new Set(settings.keepCategories);

  const infos: FileInfo[] = group.files.map((file) => {
    const category = classifyFileCategory(file.name);
    const info: FileInfo = {
      file,
      category,
      candidates: extractCodeCandidates(file.path || file.name),
      typeFiltered: !keep.has(category),
      keywordFiltered: false,
      sizeFiltered: false,
    };
    info.keywordFiltered = !info.typeFiltered && matchKeyword(info, keywords);
    info.sizeFiltered =
      !info.typeFiltered &&
      !info.keywordFiltered &&
      minSize > 0 &&
      file.size > 0 &&
      file.size < minSize;
    return info;
  });

  const eligible = infos.filter(
    (info) => !info.typeFiltered && !info.keywordFiltered && !info.sizeFiltered,
  );
  const detected = detectTargets(group, eligible, settings, manualCodes, extraCodes);
  const targets = detected.targets;

  // 根名兜底只服务于“整个任务的文件都没带番号”的包：一旦有文件命中，
  // 其余无番号文件更可能是广告/说明，不能跟着继承，否则会误勾选。
  const hitTargetKeys = new Set<string>();
  for (const info of eligible) {
    for (const candidate of info.candidates) {
      if (targets.some((target) => target.parsed.baseKey === candidate.baseKey)) {
        hitTargetKeys.add(candidate.baseKey);
      }
    }
  }
  const canInherit = targets.some(
    (target) => target.inheritFromRoot && !hitTargetKeys.has(target.parsed.baseKey),
  );

  const matched: Array<{ info: FileInfo; source: 'manual' | 'auto' }> = [];
  for (const info of eligible) {
    const hits = matchesAnyTarget(info, targets);
    const inherited = !hits.length && info.candidates.length === 0 && canInherit;
    if (hits.length || inherited) {
      const source = hits.some((target) => target.source === 'manual') ? 'manual' : 'auto';
      matched.push({ info, source });
    }
  }

  matched.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'manual' ? -1 : 1;
    return compareFiles(a.info, b.info, settings.sort);
  });

  const limit = settings.maxFilesPerTask > 0 ? settings.maxFilesPerTask : matched.length;
  const selectedSet = new Set(matched.slice(0, limit).map((entry) => entry.info.file.id));
  const rankById = new Map<string, number>();
  matched.slice(0, limit).forEach((entry, index) => rankById.set(entry.info.file.id, index + 1));

  const matchedById = new Map(matched.map((entry) => [entry.info.file.id, entry]));
  const decisions: MatchFileDecision[] = [];

  for (const entry of matched) {
    const { info, source } = entry;
    const selected = selectedSet.has(info.file.id);
    decisions.push({
      id: info.file.id,
      name: info.file.name,
      path: info.file.path,
      size: info.file.size,
      category: info.category,
      codes: info.candidates.slice(0, 3).map((candidate) => candidate.code),
      selected,
      reason: selected ? 'matched' : 'over-limit',
      matchSource: source,
      rank: rankById.get(info.file.id),
    });
  }

  for (const info of infos) {
    if (matchedById.has(info.file.id)) continue;
    let reason: MatchFileReason = 'code-mismatch';
    if (info.typeFiltered) reason = 'type-filtered';
    else if (info.keywordFiltered) reason = 'keyword-filtered';
    else if (info.sizeFiltered) reason = 'size-filtered';
    decisions.push({
      id: info.file.id,
      name: info.file.name,
      path: info.file.path,
      size: info.file.size,
      category: info.category,
      codes: info.candidates.slice(0, 3).map((candidate) => candidate.code),
      selected: false,
      reason,
    });
  }

  const codes = [...new Set(targets.map((target) => target.parsed.code))];
  let status: MatchGroupStatus = 'matched';
  if (!targets.length) status = detected.status ?? 'no-code';
  else if (!selectedSet.size) status = 'no-files';

  return {
    rootId: group.rootId,
    rootName: group.rootName,
    status,
    codes,
    totalFiles: group.files.length,
    matchedFiles: matched.length,
    selectedFiles: selectedSet.size,
    selectedIds: [...selectedSet],
    files: decisions,
  };
}

function buildSummaryText(
  status: MatchPlanStatus,
  skipped: MatchSkipReason | undefined,
  selectedFiles: number,
  totalFiles: number,
  codes: string[],
  unmatchedGroups: number,
): string {
  if (skipped === 'disabled') return '未启用番号匹配';
  if (skipped === 'no-file-list') return '无 BT 文件列表，已跳过番号匹配';
  if (skipped === 'too-many-files') return '文件过多，已跳过番号匹配';
  if (skipped === 'empty-tree') return '文件列表为空，已跳过番号匹配';
  if (status === 'empty') return '未匹配到符合条件的番号文件';
  const codeText = codes.length ? `（${codes.slice(0, 2).join('、')}）` : '';
  if (status === 'applied') return `已按番号匹配勾选 ${selectedFiles} 个文件${codeText}`;
  return `已勾选 ${selectedFiles} 个文件${codeText}，${unmatchedGroups} 个任务未匹配`;
}

export function buildMatchPlan(
  snapshot: FileListSnapshot,
  settings: AvMatchSettings,
  links: string[] = [],
): MatchPlan {
  const policy: MatchPlan['policy'] = settings.fallbackToDefault ? 'fallback' : 'strict';
  const emptyPlan = (skipped: MatchSkipReason): MatchPlan => ({
    applicable: false,
    policy,
    status: 'skipped',
    skipped,
    groups: [],
    selectedIds: [],
    preserveRootIds: [],
    totalFiles: 0,
    matchedFiles: 0,
    selectedFiles: 0,
    unmatchedGroups: 0,
    fallbackUsed: false,
    summary: buildSummaryText('skipped', skipped, 0, 0, [], 0),
  });

  if (!settings.enabled) return emptyPlan('disabled');
  if (snapshot.kind !== 'bt') return emptyPlan('no-file-list');
  if (snapshot.truncated) return emptyPlan('too-many-files');
  if (!snapshot.groups.length) return emptyPlan('empty-tree');

  const manualCodes = settings.manualCodes
    .map((code) => parseCanonicalCode(code))
    .filter((code): code is ParsedCode => Boolean(code));
  const extraCodes = links
    .map((link) => extractTaskCodes([link])[0])
    .map((code) => (code ? parseCanonicalCode(code) : null))
    .filter((code): code is ParsedCode => Boolean(code));

  // 多任务时 dn 无法可靠映射到具体根，只在单任务时作为根名兜底
  const groupExtraCodes = snapshot.groups.length === 1 ? extraCodes : [];
  const groups = snapshot.groups.map((group) =>
    planGroup(group, settings, manualCodes, groupExtraCodes),
  );
  const totalFiles = groups.reduce((sum, group) => sum + group.totalFiles, 0);
  const matchedFiles = groups.reduce((sum, group) => sum + group.matchedFiles, 0);
  const selectedFiles = groups.reduce((sum, group) => sum + group.selectedFiles, 0);
  const matchedGroups = groups.filter((group) => group.status === 'matched').length;
  const unmatchedGroups = groups.length - matchedGroups;
  const selectedIds = [...new Set(groups.flatMap((group) => group.selectedIds))];
  const codes = [...new Set(groups.flatMap((group) => group.codes))];
  const status: MatchPlanStatus =
    matchedGroups === groups.length ? 'applied' : matchedGroups > 0 ? 'partial' : 'empty';
  const preserveRootIds = settings.fallbackToDefault
    ? groups.filter((group) => group.status !== 'matched').map((group) => group.rootId)
    : [];

  return {
    applicable: true,
    policy,
    status,
    groups,
    selectedIds,
    preserveRootIds,
    totalFiles,
    matchedFiles,
    selectedFiles,
    unmatchedGroups,
    fallbackUsed: settings.fallbackToDefault && status !== 'applied',
    summary: buildSummaryText(status, undefined, selectedFiles, totalFiles, codes, unmatchedGroups),
  };
}

export function toMatchSummary(plan: MatchPlan): MatchSummary {
  return {
    status: plan.status,
    policy: plan.policy,
    totalGroups: plan.groups.length,
    matchedGroups: plan.groups.filter((group) => group.status === 'matched').length,
    totalFiles: plan.totalFiles,
    matchedFiles: plan.matchedFiles,
    selectedFiles: plan.selectedFiles,
    codes: [...new Set(plan.groups.flatMap((group) => group.codes))].slice(0, 3),
    unmatchedRoots: [
      ...new Set(
        plan.groups
          .filter((group) => group.status !== 'matched')
          .map((group) => group.rootName)
          .filter(Boolean),
      ),
    ].slice(0, 3),
    skipped: plan.skipped,
  };
}

export function extractTaskCodes(links: string[]): string[] {
  const result: string[] = [];
  for (const link of links) {
    let name = '';
    if (/^magnet:\?/i.test(link)) {
      try {
        name = new URL(link).searchParams.get('dn') || '';
      } catch {
        /* ignore */
      }
      if (!name) {
        const match = link.match(/[?&]dn=([^&]+)/i);
        if (match?.[1]) {
          try {
            name = decodeURIComponent(match[1].replace(/\+/g, ' '));
          } catch {
            name = match[1];
          }
        }
      }
    }
    if (!name) continue;
    const candidate = extractCodeCandidates(name)[0];
    if (candidate) result.push(candidate.code);
  }
  return [...new Set(result)];
}

export function parseManualCodes(text: string): ParsedManualCodes {
  const codes: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[\n\r,，;；]+/)) {
    const line = raw.trim();
    if (!line) continue;
    let code: string | null = null;
    const taskCodes = extractTaskCodes([line]);
    if (taskCodes[0]) code = taskCodes[0];
    if (!code) {
      const candidate = extractCodeCandidates(line)[0];
      if (candidate) code = candidate.code;
    }
    if (!code) {
      invalid.push(line);
      continue;
    }
    const parsed = parseCanonicalCode(code);
    if (!parsed) {
      invalid.push(line);
      continue;
    }
    if (seen.has(parsed.baseKey)) continue;
    seen.add(parsed.baseKey);
    codes.push(parsed.code);
  }

  return { codes: codes.slice(0, 500), invalid: invalid.slice(0, 100) };
}

export function parseExcludeKeywords(text: string): string[] {
  return uniqueKeywords(text.split(/[\n\r,，;；]+/), 100);
}

export function normalizeAvMatchSettings(raw: unknown): AvMatchSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AvMatchSettings>;

  let manualCodes: string[] = [];
  if (Array.isArray(input.manualCodes)) {
    const seen = new Set<string>();
    for (const item of input.manualCodes) {
      if (typeof item !== 'string') continue;
      const parsed = parseManualCodes(item);
      for (const code of parsed.codes) {
        const canonical = parseCanonicalCode(code);
        if (!canonical || seen.has(canonical.baseKey)) continue;
        seen.add(canonical.baseKey);
        manualCodes.push(canonical.code);
        if (manualCodes.length >= 500) break;
      }
      if (manualCodes.length >= 500) break;
    }
  } else if (typeof input.manualCodes === 'string') {
    manualCodes = parseManualCodes(input.manualCodes).codes;
  }

  const categories = Array.isArray(input.keepCategories)
    ? input.keepCategories.filter(
        (category): category is FileCategory =>
          typeof category === 'string' && FILE_CATEGORIES.includes(category as FileCategory),
      )
    : [];
  const keepCategories = categories.length ? [...new Set(categories)] : [...DEFAULT_AV_MATCH_SETTINGS.keepCategories];

  let excludeKeywords: string[];
  if (Array.isArray(input.excludeKeywords)) {
    excludeKeywords = uniqueKeywords(
      input.excludeKeywords.filter((keyword): keyword is string => typeof keyword === 'string'),
      100,
    );
  } else if (typeof input.excludeKeywords === 'string') {
    excludeKeywords = parseExcludeKeywords(input.excludeKeywords);
  } else {
    excludeKeywords = [...DEFAULT_AV_MATCH_SETTINGS.excludeKeywords];
  }

  return {
    enabled: booleanOrDefault(input.enabled, DEFAULT_AV_MATCH_SETTINGS.enabled),
    manualCodes,
    keepCategories,
    minFileSizeMB: clampNumber(input.minFileSizeMB, 0, 102400, DEFAULT_AV_MATCH_SETTINGS.minFileSizeMB),
    maxFilesPerTask: clampInteger(input.maxFilesPerTask, 0, 200, DEFAULT_AV_MATCH_SETTINGS.maxFilesPerTask),
    sort: (Object.keys(MATCH_SORT_LABELS) as MatchSort[]).includes(input.sort as MatchSort)
      ? (input.sort as MatchSort)
      : DEFAULT_AV_MATCH_SETTINGS.sort,
    excludeKeywords,
    fallbackToDefault: booleanOrDefault(
      input.fallbackToDefault,
      DEFAULT_AV_MATCH_SETTINGS.fallbackToDefault,
    ),
  };
}

export function formatFileSize(size: number): string {
  if (!size || size <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * 文件序号数组 → 迅雷 sub_file_index 串：连续段折叠成 "a-b"，单点写 "n"，逗号连接。
 * 与套件前端 convertSubFileIndexToString 行为一致（实测单文件命中得到 "0"）。
 */
export function encodeSubFileIndex(indices: number[]): string {
  const sorted = [...new Set(indices.filter((i) => Number.isFinite(i) && i >= 0))].sort(
    (a, b) => a - b,
  );
  if (!sorted.length) return '';
  const runs: string[] = [];
  let start = 0;
  let length = 0;
  const flush = () => {
    const head = sorted[start];
    if (head === undefined) return;
    runs.push(length === 1 ? `${head}` : `${head}-${head + length - 1}`);
  };
  for (let i = 0; i < sorted.length; i += 1) {
    const head = sorted[start];
    const current = sorted[i];
    if (head === undefined || current === undefined) break;
    if (head + length !== current) {
      flush();
      length = 0;
      start = i;
    }
    length += 1;
  }
  flush();
  return runs.join(',');
}

/** 接口模式落地用的单任务勾选结果 */
export interface SubFileSelection {
  /** 迅雷 sub_file_index；整包时为空串 */
  subFileIndex: string;
  /** 本次要下载的文件总大小 */
  fileSize: number;
  /** 严格模式未命中：不建任务 */
  skippedUnmatched: boolean;
}

/**
 * 把一个匹配分组的 selectedIds 映射回迅雷文件序号并编码。
 * 编码为空视为未命中：严格模式暂停、回退模式整包，
 * 绝不把"空选择"当成整包静默下发。
 */
export function selectSubFiles(
  group: Pick<MatchGroupResult, 'selectedIds'>,
  files: Array<{ id: string; fileIndex: number; size: number }>,
  rootFileSize: number,
  policy: MatchPlan['policy'] = 'strict',
): SubFileSelection {
  const indexById = new Map(files.map((file) => [file.id, file.fileIndex]));
  // fileIndex 推导失败为 -1（无法编码）：既不能进索引串，也不能计入 fileSize，
  // 否则会出现"只下 0 号文件、大小却按全选中算"的错单
  const indices = group.selectedIds
    .map((id) => indexById.get(id))
    .filter((value): value is number => typeof value === 'number' && value >= 0);
  const subFileIndex = encodeSubFileIndex(indices);
  if (!subFileIndex) {
    return policy === 'strict'
      ? { subFileIndex: '', fileSize: 0, skippedUnmatched: true }
      : { subFileIndex: '', fileSize: rootFileSize, skippedUnmatched: false };
  }
  const selected = new Set(indices);
  return {
    subFileIndex,
    fileSize: files
      .filter((file) => selected.has(file.fileIndex))
      .reduce((sum, file) => sum + file.size, 0),
    skippedUnmatched: false,
  };
}
