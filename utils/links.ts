export const MAX_LINKS = 50;

export interface ParsedLinks {
  links: string[];
  duplicates: number;
  ignored: number;
  unsupported: string[];
  truncated: boolean;
}

/** 任意 scheme 的候选（含 magnet 的 query 形式），用于识别并提示不支持的协议 */
const CANDIDATE_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|magnet:\?)[^\s<>"'`]+/gi;
const WRAPPING_QUOTES = /^["'`]+|["'`]+$/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>】》”’"']+$/;

export function trimLink(raw: string): string {
  return raw
    .trim()
    .replace(WRAPPING_QUOTES, '')
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

export function isSupportedLink(link: string): boolean {
  const lower = link.toLowerCase();
  if (lower.startsWith('magnet:?')) return lower.length > 'magnet:?'.length;
  if (lower.startsWith('thunder://')) return lower.length > 'thunder://'.length;
  if (lower.startsWith('ed2k://')) return lower.length > 'ed2k://'.length;
  try {
    const parsed = new URL(link);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 从任意文本中提取下载链接：按空白切分，支持一行多个链接，
 * 保留首次出现顺序并去重；unsupported 记录协议不支持但形似链接的内容。
 */
export function parseLinks(raw: string, max = MAX_LINKS): ParsedLinks {
  const result: ParsedLinks = {
    links: [],
    duplicates: 0,
    ignored: 0,
    unsupported: [],
    truncated: false,
  };
  const seen = new Set<string>();

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const matches = token.match(CANDIDATE_PATTERN) ?? [];
    if (!matches.length) {
      result.ignored += 1;
      continue;
    }
    for (const match of matches) {
      const link = trimLink(match);
      if (!link) {
        result.ignored += 1;
        continue;
      }
      if (!isSupportedLink(link)) {
        result.unsupported.push(link);
        continue;
      }
      if (seen.has(link)) {
        result.duplicates += 1;
        continue;
      }
      if (result.links.length >= max) {
        result.truncated = true;
        continue;
      }
      seen.add(link);
      result.links.push(link);
    }
  }

  return result;
}

export function extractLinks(raw: string, max = MAX_LINKS): string[] {
  return parseLinks(raw, max).links;
}

/** 解开 thunder:// 外壳，返回内部真实链接；结构不符时返回空串 */
export function decodeThunderLink(link: string): string {
  const payload = link.slice('thunder://'.length).replace(/=+$/, '');
  if (!payload) return '';
  try {
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    return decoded.startsWith('AA') && decoded.endsWith('ZZ') ? decoded.slice(2, -2) : '';
  } catch {
    return '';
  }
}

/**
 * 提取资源身份标识，用于识别"同一资源重复发送"。
 * 迅雷对同 infohash 重新添加会顶掉旧任务记录，所以键必须与大小写、
 * 以及 magnet / thunder:// 外壳写法无关。无法识别时返回空串（不做拦截）。
 */
export function extractResourceKey(link: string): string {
  const value = trimLink(link);
  const lower = value.toLowerCase();
  if (lower.startsWith('thunder://')) return extractResourceKey(decodeThunderLink(value));
  if (lower.startsWith('magnet:?')) {
    // 磁力写法是 xt=urn:btih:<hash>（冒号），少数站点会写成 btih=，两者都要认
    const btih = /btih[:=]([0-9a-fA-F]{40}|[A-Za-z2-7]{32})(?:&|$)/i.exec(value);
    return btih?.[1] ? btih[1].toUpperCase() : '';
  }
  if (lower.startsWith('ed2k://')) {
    // ed2k://|file|名称|大小|哈希|/
    const hash = value.split('|')[4];
    return hash ? hash.toUpperCase() : '';
  }
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}
