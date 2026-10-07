// src/art-trace/watermark/render.ts
//
// 编排：合成最终图片 / 读出追踪信息。
//
// ============================================================
// 这一层为什么必须存在，以及它买的代价
// ============================================================
//
// 可见水印要"重画像素"，隐形水印要"改字节"，而 PNG 只能整张重编码一次 ——
// 两件事必须落在同一次画布往返里，否则第二次编码会把第一次的结果再压一遍。
//
// **代价必须在界面上说清楚**：只要调用了 `renderWatermarked`，输出就是一张
// 重新编码过的 PNG。它意味着
//   * 像素经过了一次画布往返，**不保证与原图逐位相同**（浏览器可能做色彩空间转换）；
//   * 原图的 ICC / EXIF / XMP / 生成参数**全部丢失**（重编码只写像素）。
// 后一条在"抹除痕迹"的场景里是好事，在"打水印发出去"的场景里可能不是 ——
// 但它是"要打水印"的固有代价：水印必须重画像素，而重画像素就必然重编码。
// 想保留元数据就得在重编码之后再把原来的块拼回去，那是另一条路径（`codec/`）。

import type {
  InvisibleWatermarkOptions,
  TracePayload,
  VisibleWatermarkOptions,
  WatermarkFields,
} from '../model/types';
import { decodePayload, encodePayload, renderTemplate, toTracePayload } from '../trace/payload';
import { channelCapacityBytes, readBits, writeBits } from './invisible';
import { decodeToPixels, encodePixels } from './pixels';
import type { PixelImage } from './pixels';
import {
  createMeasurer,
  decideInk,
  drawWatermark,
  layoutWatermark,
  resolveLines,
} from './visible';

export interface RenderRequest {
  visible: VisibleWatermarkOptions;
  invisible: InvisibleWatermarkOptions;
  fields: WatermarkFields;
}

export interface RenderOutcome {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** 实际渲染出来的可见水印行；未启用时是空数组 */
  visibleLines: string[];
  /** 实际用的墨水；未启用可见水印时是 `'none'` */
  ink: 'light' | 'dark' | 'none';
  /** 实际写进去的载荷文本；未启用时 null */
  payloadText: string | null;
  /** 载荷铺了几遍 */
  payloadCopies: number;
  /** 改动了多少比特（隐形水印的度量） */
  bitsChanged: number;
}

/**
 * 扫描载荷起点时的上限。
 *
 * 4096 是一个刻意的折中：真实写入永远从 0 开始，但"从 0 开始"是**渲染时的编码
 * 决定**，读端不该假设它（将来加了偏移、或者别人把我们的图裁过一刀，起点就变了）。
 * 每次尝试只读十几到几百字节，4096 次的代价可以忽略；再往上加就纯属浪费。
 */
const SCAN_LIMIT = 4096;

/** 载荷头部长度（魔数 4 + 版本 1 + 长度 2 + CRC 4），扫描时要给尾部留出来 */
const HEADER_BYTES = 11;

/**
 * 合成最终图片：解码 → 画可见水印 → 写 LSB 隐形水印 → 编码 PNG。
 *
 * `canvas` 由调用方传入而不是这里自己建：界面要用**同一块**画布做预览，
 * 自建一块会让预览与成品在尺寸/上下文设置上悄悄分叉。
 */
export async function renderWatermarked(
  source: Uint8Array,
  request: RenderRequest,
  canvas?: HTMLCanvasElement
): Promise<RenderOutcome> {
  // 先用 createImageBitmap 解一次位图：它的尺寸是从**文件本身**得到的，而画布的
  // `getImageData` 在尺寸写错时会返回一块全黑（而不是抛错）。步骤 2 的二次解码
  // 是必须的 —— 水印要画在 sRGB 的 RGBA 像素上，而 ImageBitmap 的像素取不出来。
  const bitmap = await decodeBitmap(source);
  const width = bitmap.width;
  const height = bitmap.height;

  const target = canvas ?? document.createElement('canvas');
  const ctx = acquireContext(target, width, height);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  ctx.restore();
  bitmap.close();

  const image: PixelImage = { width, height, data: ctx.getImageData(0, 0, width, height).data };

  // 1) 可见水印。先画它，隐形水印之后才写 —— 顺序反了的话，画上去的文字会把
  // LSB 覆盖掉，结果"预览里看得见水印、导出的图里读不出追踪信息"。
  const visibleLines = resolveLines(request.visible, request.fields);
  let ink: 'light' | 'dark' | 'none' = 'none';
  if (request.visible.enabled && visibleLines.length > 0) {
    const layout = layoutWatermark(width, height, visibleLines, request.visible, createMeasurer());
    const decision = decideInk(image, layout.box, request.visible.ink);
    ink = decision.ink;
    drawWatermark(target, layout, request.visible, decision.ink);
    // 画完之后**必须重新取像素**：`image.data` 是绘制之前的一份快照，
    // 在它上面写 LSB 等于把水印写在看不见的那一份上。
    image.data = ctx.getImageData(0, 0, width, height).data;
  }

  // 2) 隐形水印
  let payloadText: string | null = null;
  let payloadCopies = 0;
  let bitsChanged = 0;

  if (request.invisible.enabled) {
    payloadText = renderTemplate(request.invisible.payloadTemplate, request.fields);
    const payload = encodePayload(payloadText);
    const capacity = channelCapacityBytes(image.width * image.height);
    const redundancy = Math.max(
      1,
      Math.floor(Number.isFinite(request.invisible.redundancy) ? request.invisible.redundancy : 1)
    );

    const fitted = Math.floor(capacity / payload.length);
    const copies = Math.min(redundancy, fitted);
    if (copies < 1) {
      // 一句能照做的话：说清楚"装不下多少 / 你能装多少"。只说"容量不足"没用，
      // 用户需要知道该缩短多少、或者该换多大的图。
      throw new Error(
        `隐形水印写不进去：载荷 ${payload.length} 字节，这张 ${image.width}×${image.height} 的图只能装 ${capacity} 字节。` +
          `请缩短载荷模板，或换一张更大的图。`
      );
    }

    const stream = repeatBytes(payload, copies);
    bitsChanged = writeBits(image.data, stream);
    payloadCopies = copies;
  }

  const bytes = await encodePixels(image);
  return {
    bytes,
    width,
    height,
    visibleLines: ink === 'none' ? [] : visibleLines,
    ink,
    payloadText,
    payloadCopies,
    bitsChanged,
  };
}

/**
 * 从一张图里读出追踪水印。没读到返回 `null`。
 *
 * **已知限制：JPEG / WebP 的有损重编码会冲掉 LSB。** 因此对 PNG 可靠、对
 * "被转发过一次的微信图"基本无效。这不是缺陷，是 LSB 的固有性质 —— 有损编码
 * 量化掉的正是最低有效位。真要抗有损，得换 DCT / 频域水印，那是另一套东西。
 */
export async function readTrace(source: Uint8Array): Promise<TracePayload | null> {
  const image = await decodeToPixels(source);
  const capacity = channelCapacityBytes(image.width * image.height);
  if (capacity < HEADER_BYTES) return null;

  const stream = readBits(image.data, capacity);
  const limit = Math.min(SCAN_LIMIT, stream.length - HEADER_BYTES);

  let copies = 0;
  let found: { text: string; version: number } | null = null;

  for (let start = 0; start <= limit; start++) {
    // 从头开始扫描而不是假设起点是 0：`writeBits` 的起点由渲染时的编码决定
    // （将来可能加偏移、图也可能被裁过），而每次尝试只读十几到几百字节，
    // 4096 次的上限代价可以忽略。
    const decoded = decodePayload(stream.subarray(start));
    if (decoded) {
      copies++;
      if (!found) found = decoded;
    }
  }

  if (!found) return null;
  return toTracePayload(found, copies);
}

/**
 * 只做预览：返回可直接放进 `<img src>` 的 data URL，以及排版信息。
 * **不产生成品字节。**
 *
 * 预览里**不写 LSB**：它看不见，写进去只是白花时间（大图上一次 LSB 写入是几十
 * 万次循环），而预览的全部意义是"看清楚水印长什么样"。
 */
export async function previewWatermark(
  source: Uint8Array,
  request: RenderRequest,
  maxWidth: number
): Promise<{ dataUrl: string; visibleLines: string[]; ink: 'light' | 'dark' | 'none' }> {
  const full = await decodeToPixels(source);
  const scale = maxWidth > 0 && full.width > maxWidth ? maxWidth / full.width : 1;
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));

  const canvas = document.createElement('canvas');
  const ctx = acquireContext(canvas, width, height);
  const bitmap = await decodeBitmap(source);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // 缩放后的尺寸必须重新测量排版：直接用原图尺寸算出来的字号贴到缩略图上会大
  // 出一大截（`fontSizeRatio` 是相对**图宽**的），预览就完全不像成品了。
  const preview: PixelImage = {
    width,
    height,
    data: ctx.getImageData(0, 0, width, height).data,
  };
  const visibleLines = resolveLines(request.visible, request.fields);

  let ink: 'light' | 'dark' | 'none' = 'none';
  if (request.visible.enabled && visibleLines.length > 0) {
    const layout = layoutWatermark(width, height, visibleLines, request.visible, createMeasurer());
    const decision = decideInk(preview, layout.box, request.visible.ink);
    ink = decision.ink;
    drawWatermark(canvas, layout, request.visible, decision.ink);
  }

  return { dataUrl: canvas.toDataURL('image/png'), visibleLines, ink };
}

// ============================================================
// DOM 小工具
// ============================================================

/** 解码成 ImageBitmap。**DOM 依赖** */
async function decodeBitmap(source: Uint8Array): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前环境不支持 createImageBitmap，无法解码图片像素。');
  }
  try {
    return await createImageBitmap(new Blob([source]));
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`这张图无法解码：${reason}`);
  }
}

/**
 * 准备一块指定像素尺寸的画布，并取回上下文。**DOM 依赖**。
 *
 * `willReadFrequently: true` 在这里是必需的：这块画布会被 `getImageData` 读两次
 * （判定墨水一次、写 LSB 前一次），而默认的 GPU 后备存储每次都要整张回读。
 */
function acquireContext(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): CanvasRenderingContext2D {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('拿不到 2D 画布上下文，无法渲染水印');
  return ctx;
}

/** 把载荷首尾相接铺 `copies` 遍 */
function repeatBytes(payload: Uint8Array, copies: number): Uint8Array {
  const out = new Uint8Array(payload.length * copies);
  for (let index = 0; index < copies; index++) {
    out.set(payload, index * payload.length);
  }
  return out;
}
