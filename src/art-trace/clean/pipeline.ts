// src/art-trace/clean/pipeline.ts
//
// 单张图的完整处理流水线：清理 + 可选水印 + 追加信息。
//
// ============================================================
// 为什么必须有这一层，而不是让界面自己按顺序调三个函数
// ============================================================
//
// "清理"与"打水印"都要求"先有什么、后有什么"，而那个顺序不是随便定的：
//
//   1. **分组升级必须在策略之前。** 容器层把 `tEXt(prompt)` 认成"普通文本块"，
//      是语义层把它升级成"生成参数"。策略按分组决定丢什么 —— 顺序反了的结果是
//      **一次完全静默的失败**：清理报告成功，成品与原图逐字节相同，参数一个没少。
//      因此这里不自己拼这条链，而是走 `analyze()`（单一入口，见它的文件头）。
//   2. **水印必须在最后。** 打水印要重画像素，而重画会把之前写进去的元数据全部
//      丢掉。先写元数据再打水印等于白写。
//   3. **追加信息必须在所有像素操作之后。** 追加的文本块要写进**最终那个容器**。
//
// 三条顺序约束，任何一条写错都会得到一个"看起来成功、但水印/信息没了"的结果 ——
// 那是最难被发现的一类缺陷，因为它不报错。把它们收在一个函数里，顺序就只写一次。

import type { CleanOptions, ImageInfo, WatermarkFields } from '../model/types';
import type { InvisibleWatermarkOptions, VisibleWatermarkOptions } from '../model/types';
import type { ContainerBlock } from '../codec/format';
import { parseContainer } from '../codec/format';
import { analyze } from '../analyze';
import { sha256Hex } from '../codec/hash';
import { decodeToPixels, encodePixels } from '../watermark/pixels';
import { renderWatermarked } from '../watermark/render';
import { planClean, toRebuildOptions } from './plan';
import type { CleanPlan } from './plan';

/** 水印设置。整体为 `null` 表示这次不打水印 */
export interface WatermarkRequest {
  visible: VisibleWatermarkOptions;
  invisible: InvisibleWatermarkOptions;
}

export interface ProcessRequest {
  source: Uint8Array;
  options: CleanOptions;
  /** 打水印。为 `null` 表示只清理 */
  watermark: WatermarkRequest | null;
  /** 水印文案的取值（占位符替换用）。不打水印时忽略 */
  fields: WatermarkFields;
}

export interface ProcessOutcome {
  bytes: Uint8Array;
  info: ImageInfo;
  sourceSha: string;
  outputSha: string;
  beforeBytes: number;
  afterBytes: number;
  /** 像素有没有被重画（无损 / 重编码的分界） */
  pixelsRewritten: boolean;
  dropped: ContainerBlock[];
  kept: ContainerBlock[];
  plan: CleanPlan;
  /** 水印实际渲染出来的行；没打水印时是空数组 */
  visibleLines: string[];
  /** 实际用的墨水；没打水印时是 `'none'` */
  ink: 'light' | 'dark' | 'none';
  /** 隐形载荷全文；没写时是 `null` */
  payloadText: string | null;
  payloadCopies: number;
  /** 隐形水印改动了多少比特 */
  bitsChanged: number;
}

/**
 * 处理一张图。
 *
 * 三条出口：
 *   * 只清理，且不需要重画像素 → **无损**的容器重建（默认路径）；
 *   * 只清理，但打开了 `reencodePixels` → 画布重编码；
 *   * 打水印 → 画布重编码 + 可见水印 + LSB 隐形水印。
 */
export async function processImage(request: ProcessRequest): Promise<ProcessOutcome> {
  const { source, options, watermark, fields } = request;

  const result = analyze(source);
  if (!result.ok) throw new Error(result.error);

  const { parse, blocks, orientation, info } = result.analysis;
  const plan = planClean(blocks, options, orientation);
  const beforeBytes = source.length;

  let bytes: Uint8Array;
  let pixelsRewritten = false;
  let visibleLines: string[] = [];
  let ink: 'light' | 'dark' | 'none' = 'none';
  let payloadText: string | null = null;
  let payloadCopies = 0;
  let bitsChanged = 0;

  // ---- 第 1 步：像素 ----
  if (watermark) {
    // 打水印这一条自己就把清理做完了：画布编码出来的文件里没有任何原图的元数据。
    // 因此这里**不**再走一遍丢块 —— 那只会白跑一次解析。
    const rendered = await renderWatermarked(source, {
      visible: watermark.visible,
      invisible: watermark.invisible,
      fields,
    });
    bytes = rendered.bytes;
    visibleLines = rendered.visibleLines;
    ink = rendered.ink;
    payloadText = rendered.payloadText;
    payloadCopies = rendered.payloadCopies;
    bitsChanged = rendered.bitsChanged;
    pixelsRewritten = true;
  } else if (plan.needsPixelRewrite) {
    const pixels = await decodeToPixels(source);
    bytes = await encodePixels(pixels);
    pixelsRewritten = true;
  } else {
    bytes = parse.rebuild(toRebuildOptions(plan, orientation, options.keepOrientation));
  }

  // ---- 第 2 步：追加信息写进**最终那个容器** ----
  //
  // 只有"像素被重画过"时才需要单独再走一遍：那条路上的 `rebuild` 还没跑过。
  // 无损那条路上 `plan.append` 已经由第一步的 `rebuild` 一并写进去了 ——
  // 再写一遍会得到**两份**相同的块。
  if (pixelsRewritten && plan.append.length > 0) {
    const reparsed = parseContainer(bytes);
    if (!reparsed.ok || !reparsed.parse) {
      throw new Error(`重画之后没能重新解析出图片：${reparsed.error ?? '未知原因'}`);
    }
    bytes = reparsed.parse.rebuild({
      drop: new Set(),
      append: plan.append,
      // 重画之后**不再写方向**：浏览器在解码时已经按 EXIF 方向把画面摆正了，
      // 再写一次会让查看器把摆正过的画面又转一次。这个坑很隐蔽，因此单独写一行。
      keepOrientation: false,
      orientation: null,
    });
  }

  const [sourceSha, outputSha] = await Promise.all([
    sha256Hex(source),
    sha256Hex(bytes),
  ]);

  return {
    bytes,
    info,
    sourceSha,
    outputSha,
    beforeBytes,
    afterBytes: bytes.length,
    pixelsRewritten,
    dropped: plan.dropping,
    kept: plan.keeping,
    plan,
    visibleLines,
    ink,
    payloadText,
    payloadCopies,
    bitsChanged,
  };
}

/** 只读地算一遍"会发生什么"，不产生任何新字节。批量前的试算用它 */
export function dryRun(
  source: Uint8Array,
  options: CleanOptions
): { ok: true; plan: CleanPlan; info: ImageInfo } | { ok: false; error: string } {
  const result = analyze(source);
  if (!result.ok) return { ok: false, error: result.error };
  const { blocks, orientation, info } = result.analysis;
  return { ok: true, plan: planClean(blocks, options, orientation), info };
}
