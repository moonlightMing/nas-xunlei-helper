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
