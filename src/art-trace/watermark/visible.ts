// src/art-trace/watermark/visible.ts
//
// 可见水印：模板替换、排版、墨水判定、绘制。
//
// ============================================================
// 为什么排版是纯函数，而绘制不是
// ============================================================
//
// "水印画在哪里、多大、什么颜色"是一堆算术，它错了的表现是"水印压出画面外了"
// 或"贴边贴到只剩半个字"。这类错误在 Node 里断言得到，在浏览器里只能靠肉眼看。
//
// 所以：`layoutWatermark` 把"量文字宽度"这件事**注入**进来（`measure`），
// 于是它自己完全不碰 canvas，可以在 Node 里对任意尺寸、任意布局跑断言。
// `drawWatermark` 只负责"把已经算好的东西画上去"，越薄越好。

import type {
  VisibleWatermarkOptions,
  WatermarkFields,
} from '../model/types';
import { renderTemplate } from '../trace/payload';
import { regionLuminance } from './pixels';
import type { PixelImage } from './pixels';

/**
 * 行数上限。
 *
 * 五行的可见水印在大图上就已经盖掉相当一块画面了，而模板是用户随便写的
 * （也来自预设导入）。不设上限的话，"模板里多打了几个换行"会变成一屏大字糊在
 * 作品上 —— 而那已经不可撤销地写进了成品。
 */
const MAX_LINES = 5;

/** 行高相对字号的倍数。1.35 是"不挤也不散"的经验值；1.2 会让带下伸部的字相碰 */
const LINE_HEIGHT_RATIO = 1.35;

/**
 * 自动墨水的亮度阈值。
 *
 * **不是 128。** 水印通常压在画面边缘，而边缘常常是天空、白墙、浅灰渐变这类偏亮的
 * 区域。按 128 判，一块亮度 135 的浅灰底会被判成"偏亮 → 用深色墨"没问题，但一块
 * 亮度 126 的浅灰底会被判成"偏暗 → 用白色墨" —— 白字压在浅灰上几乎看不见，
 * 而这恰恰是最常见的失败情况。把阈值抬到 140 意味着"只有确实偏暗的地方才用白字"，
 * 代价是中间地带（140 上下）偶尔会用深色墨压在中灰上，那比白字压浅灰可读得多。
 */
const INK_LUMINANCE_THRESHOLD = 140;

/** 墨水判定区域向内收缩的比例。留出边缘，避免框贴着画面边界取到无关的背景 */
const BOX_SHRINK = 0.2;

/** 基线以上的高度按字号的这个比例估算（`measure` 只给宽度，拿不到 ascent） */
const ASCENT_RATIO = 0.8;

/** 字体族。**只用系统字体** —— 见 `fontOf` 的注释 */
const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';

/** 把模板行渲染成实际文本（占位符已替换）。空行会被丢掉 */
export function resolveLines(
  options: VisibleWatermarkOptions,
  fields: WatermarkFields
): string[] {
  const out: string[] = [];
  for (const raw of options.lines) {
    if (out.length >= MAX_LINES) break;
    const text = renderTemplate(raw, fields).trim();
    // 替换后为空的行直接丢：模板里常用空行占位，而空行在排版里会占掉一行行高，
    // 让整块水印看起来"莫名地浮在上面"。
    if (text.length === 0) continue;
    out.push(text);
  }
  return out;
}

/** 墨水判定：`light` 表示画白字（区域偏暗），`dark` 表示画黑字 */
export interface InkDecision {
  ink: 'light' | 'dark';
  luminance: number;
}

/**
 * 决定用哪种墨水。
 *
 * `preference` 是 `'light'` / `'dark'` 时**直接采纳**，但亮度仍然要算出来：
 * 界面上要显示"实测亮度"，用户才能理解为什么自动判定会选这一种，也才能在
 * "我觉得白字更好看"的时候有依据地覆盖它。
 */
export function decideInk(
  image: PixelImage,
  box: { x: number; y: number; width: number; height: number },
  preference: 'auto' | 'light' | 'dark'
): InkDecision {
  const luminance = regionLuminance(image, box);
  if (preference === 'light' || preference === 'dark') {
    return { ink: preference, luminance };
  }
  return {
    ink: luminance > INK_LUMINANCE_THRESHOLD ? 'dark' : 'light',
    luminance,
  };
}

/** 排版结果。纯计算，不画 */
export interface WatermarkLayout {
  /** 第一行（主标题）的像素字号 */
  fontSize: number;
  lineHeight: number;
  /** 每行的基线位置（相对画布） */
  lines: Array<{
    text: string;
    x: number;
    y: number;
    size: number;
    align: 'left' | 'center' | 'right';
  }>;
  /** 用来判定墨水的区域 */
  box: { x: number; y: number; width: number; height: number };
  /** 文字块的整体包围盒（badge 底板要它） */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * 算排版。**纯计算，不画**，`measure` 由外部注入（见文件头）。
 *
 * 没有行可画时返回一个空布局（`lines` 为空、字号仍然算出来），而不是抛错 ——
 * 调用方据此跳过绘制即可。
 */
export function layoutWatermark(
  width: number,
  height: number,
  lines: string[],
  options: VisibleWatermarkOptions,
  measure: (text: string, size: number) => number
): WatermarkLayout {
  const fontSize = width * options.fontSizeRatio;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const margin = width * options.marginRatio;
  const lineScale = options.lineScale;
  const atTop = options.layout.startsWith('top');
  const atRight = options.layout.endsWith('right');
  const atCenter = options.layout.endsWith('center');

  const sizeOf = (index: number): number => (index === 0 ? fontSize : fontSize * lineScale);

  const placed: WatermarkLayout['lines'] = [];
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let boxLeft = Number.POSITIVE_INFINITY;
  let boxRight = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    const size = sizeOf(index);
    const textWidth = Math.max(0, measure(text, size));

    let x: number;
    let align: 'left' | 'center' | 'right';
    if (atCenter) {
      // 居中：x 是**中线**。`fillText` 配 textAlign='center' 时 x 也正好是中线，
      // 因此这里不用减半个宽度 —— 那种"多减一次"的错误会让整块水印整体左移。
      x = width / 2;
      align = 'center';
    } else if (atRight) {
      x = width - margin;
      align = 'right';
    } else {
      x = margin;
      align = 'left';
    }

    // 竖直方向：贴底时**从最后一行往上排**，`y` 是每一行的基线。
    // 先算最后一行的基线位置：底部留白 + 该行的下伸量（估算为字号的 20%）。
    // 直接把最后一行基线放在 height - margin 会让带下伸部的字（g/y/中文的竖钩）
    // 探进画布边缘甚至被切掉。
    const descentLast = (atTop ? 0 : sizeOf(lines.length - 1) * 0.2);
    const lastBaseline = atTop
      ? margin + sizeOf(0) * ASCENT_RATIO + (lines.length - 1) * lineHeight
      : height - margin - descentLast;
    const y = lastBaseline - (lines.length - 1 - index) * lineHeight;

    placed.push({ text, x, y, size, align });

    const half = strokeWidthFor(size) / 2;
    const left = align === 'center' ? x - textWidth / 2 : align === 'right' ? x - textWidth : x;
    const right = left + textWidth;
    const lineTop = y - size * ASCENT_RATIO;
    const lineBottom = y + size * 0.2;

    if (left - half < boxLeft) boxLeft = left - half;
    if (right + half > boxRight) boxRight = right + half;
    if (lineTop - half < top) top = lineTop - half;
    if (lineBottom + half > bottom) bottom = lineBottom + half;
  }

  if (placed.length === 0) {
    top = 0;
    bottom = 0;
    boxLeft = 0;
    boxRight = 0;
  }

  return {
    fontSize,
    lineHeight,
    lines: placed,
    box: shrinkBox(
      { x: boxLeft, y: top, width: boxRight - boxLeft, height: bottom - top },
      BOX_SHRINK
    ),
    bounds: { x: boxLeft, y: top, width: boxRight - boxLeft, height: bottom - top },
  };
}

/**
 * 把判定区域向内收缩，并夹到画布之内。
 *
 * 收缩是因为框的边缘常常落在与文字无关的背景上，而判定要回答的是"文字底下那块
 * 是什么颜色"。夹到画布内是必须的：贴边布局下 `bounds` 已经压着画布边界，收缩
 * 之后的算式（`x + width * 0.9`）本来可能算出负宽，而负宽的区域亮度恒为 0 ——
 * 那会让"自动墨水"在贴边的水印上**永远选白字**，是那种看起来能用、实际全错的缺陷。
 */
function shrinkBox(
  box: { x: number; y: number; width: number; height: number },
  ratio: number
): { x: number; y: number; width: number; height: number } {
  const dx = box.width * ratio * 0.5;
  const dy = box.height * ratio * 0.5;
  const width = Math.max(0, box.width - dx * 2);
  const height = Math.max(0, box.height - dy * 2);
  return {
    x: box.x + dx,
    y: box.y + dy,
    width,
    height,
  };
}

/** 描边宽度。**不随图宽缩放**：缩放的描边在超宽图上会变成一道能盖住笔画的粗边 */
function strokeWidthFor(size: number): number {
  return Math.max(2, size / 12);
}

/**
 * 真正画。**DOM 依赖**。
 *
 * 这个 canvas 之后还要被 `getImageData` 读回去（隐形水印要写在可见水印之上），
 * 因此这里的绘制必须**成对地 save/restore**：留下来的脏状态（改过的 `globalAlpha`、
 * 换过的字体、偏过的 `textBaseline`）会影响调用方在这块画布上的后续绘制，而那种
 * "第二次绘制位置偏了半个字高"的问题极难归因。
 */
export function drawWatermark(
  canvas: HTMLCanvasElement,
  layout: WatermarkLayout,
  options: VisibleWatermarkOptions,
  ink: 'light' | 'dark'
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法绘制水印：拿不到 2D 画布上下文');
  if (layout.lines.length === 0) return;

  // 浅色墨 = 白填充 + 深色描边；深色墨 = 深填充 + 浅色描边。描边与填充必须是
  // 一对反色，否则"白字压在浅色区"会连描边一起看不见。
  const fill = ink === 'light' ? '#ffffff' : '#101010';
  const stroke = ink === 'light' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';

  ctx.save();
  try {
    ctx.globalAlpha = clamp01(options.opacity / 255);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    // 明确不画阴影：shadowBlur 在部分引擎上开销很大（每次绘制都要做一次模糊），
    // 而且它给文字边缘带来一圈不可控的模糊 —— 水印的可读性靠描边就够了。
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    if (options.style === 'badge') {
      const pad = layout.fontSize * 0.4;
      const radius = Math.max(0, layout.fontSize * 0.45);
      ctx.fillStyle = ink === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
      roundedRect(
        ctx,
        layout.bounds.x - pad,
        layout.bounds.y - pad,
        layout.bounds.width + pad * 2,
        layout.bounds.height + pad * 2,
        radius
      );
      ctx.fill();
    }

    for (const line of layout.lines) {
      ctx.font = fontOf(line.size);
      ctx.textAlign = line.align;
      if (options.style === 'outline') {
        ctx.lineWidth = strokeWidthFor(line.size);
        ctx.strokeStyle = stroke;
        // 先描边再填充：反过来会让填充盖掉内半边描边，字看起来偏细、边缘偏软。
        ctx.strokeText(line.text, line.x, line.y);
      }
      ctx.fillStyle = fill;
      ctx.fillText(line.text, line.x, line.y);
    }
  } finally {
    // 放在 finally 里：中途抛错（例如字体设不上去）时也要把状态还回去，
    // 否则一次失败的绘制会污染这块画布之后的全部操作。
    ctx.restore();
  }
}

/**
 * 造一个只用于测量的 2D 上下文。**DOM 依赖**。
 *
 * 返回的闭包每次都会改这个 ctx 的 `font`：`measureText` 的结果依赖于当时设置的
 * 字体，因此测量函数**必须先设字体再量** —— 那种"设一次字体然后量所有行"的写法
 * 会让副行的宽度全部按主行字号算，右对齐时整块水印会跑出画面。
 */
export function createMeasurer(): (text: string, size: number) => number {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法测量文字：拿不到 2D 画布上下文');

  return (text: string, size: number): number => {
    ctx.font = fontOf(size);
    return ctx.measureText(text).width;
  };
}

/**
 * 字体声明。**只用系统字体，不引用任何外部字体。**
 *
 * 插件文档的 CSP 是 `font-src 'self' data:` —— 一个 `@font-face` 指向 CDN 会加载
 * 失败，而字体加载失败**不会报错**，只会静默回退到默认字体。结果是"我机器上装了这个
 * 字体所以好看，用户那里走样"，而且没人会知道原因。系统字体栈没有这个问题。
 */
function fontOf(size: number): string {
  return `600 ${size}px ${FONT_STACK}`;
}

/** 圆角矩形路径（badge 底板）。`roundRect` 不是所有引擎都有，自己画稳妥 */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
