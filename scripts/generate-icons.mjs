/**
 * 图标生成脚本:把 assets/icon.svg(矢量源,主体满幅)渲染成 public/icons/ 下
 * 各尺寸 PNG。Chrome 扩展图标不支持 SVG,构建时用 resvg 位图化。
 *
 * CONTENT_RATIO 控制主体占画布比例:四周留白是刻意的——工具栏角标数字
 * (原生 setBadgeText)叠加在留白处才大而清晰,改小留白会遮住数字。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const CONTENT_RATIO = 0.813;
const SIZES = [16, 32, 48, 128];

const innerSvg = readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8')
  // 去掉 SVG 外壳,只留内容,包进带留白的画布
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '');

const CANVAS = 128;
const innerSize = CANVAS * CONTENT_RATIO;
const offset = (CANVAS - innerSize) / 2;
const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">
<g transform="translate(${offset} ${offset}) scale(${innerSize / CANVAS})">${innerSvg}</g>
</svg>`;

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const width of SIZES) {
  const resvg = new Resvg(wrapped, { fitTo: { mode: 'width', value: width } });
  const out = new URL(`../public/icons/${width}.png`, import.meta.url);
  writeFileSync(out, resvg.render().asPng());
  console.log(`[icons] ${width}.png 已生成`);
}
