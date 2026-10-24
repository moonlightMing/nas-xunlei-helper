import { describe, expect, it } from 'vitest';
import {
  decodeThunderLink,
  extractLinks,
  extractResourceKey,
  parseLinks,
} from '@/utils/links';

/** 与迅雷客户端一致的 thunder:// 外壳：base64("AA" + url + "ZZ") */
function encodeThunder(url: string): string {
  return `thunder://${btoa(`AA${url}ZZ`)}`;
}

const MAGNET_HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=ABC-123`;

describe('extractResourceKey 归一性（重复资源防呆的生命线）', () => {
  it('磁力（冒号写法）与裸磁力得到同一键', () => {
    expect(extractResourceKey(MAGNET)).toBe(MAGNET_HASH);
    expect(extractResourceKey(`magnet:?xt=urn:btih:${MAGNET_HASH}`)).toBe(MAGNET_HASH);
  });

  it('btih= 等号写法与大小写差异归一到同一键', () => {
    expect(extractResourceKey(`magnet:?btih=${MAGNET_HASH.toLowerCase()}`)).toBe(MAGNET_HASH);
    expect(extractResourceKey(`magnet:?xt=urn:btih:${MAGNET_HASH.toLowerCase()}`)).toBe(
      MAGNET_HASH,
    );
  });

  it('thunder:// 外壳解开后的磁力与裸磁力同键', () => {
    expect(extractResourceKey(encodeThunder(MAGNET))).toBe(MAGNET_HASH);
  });

  it('ed2k 以文件哈希为键', () => {
    const hash = '0123456789ABCDEF0123456789ABCDEF';
    expect(extractResourceKey(`ed2k://|file|name.mp4|1000|${hash}|/`)).toBe(hash);
  });

  it('http 直链去 hash 后按 URL 归一', () => {
    expect(extractResourceKey('http://a.test/f.zip#x')).toBe('http://a.test/f.zip');
  });

  it('不可识别的输入返回空串（不拦截）', () => {
    expect(extractResourceKey('')).toBe('');
    expect(extractResourceKey('not a link')).toBe('');
  });
});

describe('decodeThunderLink', () => {
  it('解开标准外壳', () => {
    expect(decodeThunderLink(encodeThunder('http://a.test/f.zip'))).toBe('http://a.test/f.zip');
  });

  it('结构不符（无 AA/ZZ 包裹）返回空串', () => {
    expect(decodeThunderLink(`thunder://${btoa('plain-text')}`)).toBe('');
  });
});

describe('parseLinks / extractLinks', () => {
  it('提取、去重并按首现排序', () => {
    const parsed = parseLinks(`foo ${MAGNET} bar http://a.test/1.zip ${MAGNET} http://a.test/1.zip`);
    expect(parsed.links).toEqual([MAGNET, 'http://a.test/1.zip']);
    expect(parsed.duplicates).toBe(2);
    expect(parsed.ignored).toBe(2);
  });

  it('不支持的协议进入 unsupported', () => {
    const parsed = parseLinks('ftp://a.test/x.zip');
    expect(parsed.links).toEqual([]);
    expect(parsed.unsupported).toEqual(['ftp://a.test/x.zip']);
  });

  it('超过上限截断并置 truncated', () => {
    const raw = Array.from({ length: 55 }, (_, i) => `http://a.test/${i}.zip`).join('\n');
    const parsed = parseLinks(raw);
    expect(parsed.links).toHaveLength(50);
    expect(parsed.truncated).toBe(true);
  });

  it('extractLinks 直接返回链接数组', () => {
    expect(extractLinks('http://a.test/1.zip')).toEqual(['http://a.test/1.zip']);
  });
});
