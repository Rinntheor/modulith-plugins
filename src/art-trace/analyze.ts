// src/art-trace/analyze.ts
//
// 「一份字节 → 一份可用的分析结果」的**唯一入口**。
//
// ============================================================
// 这个文件为什么必须存在（它是一次真实缺陷的产物）
// ============================================================
//
// 分层是这样的：
//
//   codec/*   字节 → ContainerBlock[]（每个块带一个**容器层**的分组猜测）
//   gen/*     看内容 → 把"生成参数"那一类块的分组从 `text` 升级成 `generator`
//   clean/*   按分组决定丢什么
//
// 于是有一个不显眼但致命的顺序要求：**策略必须在分组升级之后才能算**。
//
// 先前的写法是 `planClean(parse.blocks, ...)` —— 传进去的是容器层的原始块，那里
// `tEXt(prompt)` 的分组还是 `text`，而默认策略并不丢普通文本块（那是给作者信息用的）。
// 结果是一次**完全静默的失败**：清理报告"成功"，成品与原图逐字节相同，
// 生成参数一个都没少。
//
// 它不可能被单元测试发现 —— 每一个单元都是对的。只有把整条链拼起来、在真实文件上
// 跑一遍才会露出来。因此这里的修法不是"在三个调用点各补一行升级"，而是把
// "认格式 → 解析 → 识别 → 升级分组 → 审计"收成一个函数：**没有任何一个调用点
// 有机会忘记中间那一步。**
//
// 一条副产物：本文件（以及它下游的 `clean/*`）**不认识宿主**。它拿字节、给结论，
// 因此可以在宿主之外被完整验证 —— 端到端脚本正是这么做的。

import type {
  BlockVerdict,
  GenParams,
  ImageFormat,
  ImageInfo,
  MetaBlock,
} from './model/types';
import type { ContainerBlock, FormatParse } from './codec/format';
import { parseContainer } from './codec/format';
import { detectGeneration, tagGeneratedBlocks } from './gen';

/** 一次分析的全部结果。策略层、界面层、台账层都从它取数 */
export interface Analysis {
  format: ImageFormat;
  info: ImageInfo;
  parse: FormatParse;
  generation: GenParams | null;
  /**
   * **已经升级过分组**的块。
   *
   * 凡是"按分组决定做什么"的代码（清理策略、审计、界面上的分类统计）都必须用
   * 这一个，而不是 `parse.blocks`。两者的差别就是本文件存在的理由。
   */
  blocks: ContainerBlock[];
  /** EXIF 里的方向值；没有则 `null` */
  orientation: number | null;
  /** "这张图干净吗"的结论与理由 */
  audit: Audit;
}

/**
 * 一张图在"痕迹"这件事上的三档结论。
 *
 * 类型定义在 `model/types.ts`（它是领域概念，界面与台账都要用），这里再导出一遍
 * 只是为了"从 `analyze` 也能拿到它" —— 调用方不必知道它住在哪个文件里。
 */
export type { BlockVerdict };

export interface Audit {
  /** 有没有 `traces` 那一类痕迹。**只有它决定"是否需要处理"** */
  clean: boolean;
  /** 硬痕迹的理由。`clean` 为假时非空 */
  reasons: string[];
  /** 文本块的理由（作者标注一类）。它不影响 `clean` */
  annotations: string[];
  verdict: BlockVerdict;
}

export type AnalyzeResult =
  | { ok: true; analysis: Analysis }
  | { ok: false; error: string; format: ImageFormat };

/**
 * 分析一份图片字节。
 *
 * 认不出格式、或容器坏到读不出头时返回 `{ ok: false }`，并带一句能显示给用户的话
 * —— "这张图我看不懂"是一个**正常结果**，不该是一次异常。
 */
export function analyze(bytes: Uint8Array): AnalyzeResult {
  const container = parseContainer(bytes);
  if (!container.ok || !container.parse) {
    return {
      ok: false,
      error: container.error ?? '无法解析这个文件',
      format: container.format,
    };
  }

  const parse = container.parse;
  const generation = detectGeneration(parse.blocks);
  const blocks = tagGeneratedBlocks(parse.blocks, generation);

  return {
    ok: true,
    analysis: {
      format: container.format,
      info: parse.info,
      parse,
      generation,
      blocks,
      orientation: readOrientation(parse),
      audit: auditBlocks(blocks),
    },
  };
}

/** 读取方向。没有 EXIF 时是 `null` */
export function readOrientation(parse: FormatParse): number | null {
  const holder = parse.blocks.find((block) => block.orientation !== null);
  return holder?.orientation ?? null;
}

/**
 * 判断一组块在"痕迹"上的结论。
 *
 * 判据分两档（见 `BlockVerdict` 的说明）：
 *   * **硬痕迹** —— 生成参数、EXIF、XMP、C2PA。有任何一个就算 `traces`；
 *   * **标注** —— 普通文本块。它们被单独列出来，但**不**让结论变成 `traces`；
 *   * **不算** —— ICC 与结构性块。它们在任何一档里都不出现：把它们算进去会让
 *     每一张正常的图都显示成"有痕迹"，而那种提示等于没有提示。
 *
 * ⚠️ 传进来的必须是**升级过分组**的块（`analyze()` 给的那一份）。用容器层原始块
 * 调它，生成参数会被当成普通文本块而漏报 —— 那正是本文件存在的理由。
 */
export function auditBlocks(blocks: ContainerBlock[]): Audit {
  const reasons: string[] = [];
  const annotations: string[] = [];

  for (const block of blocks) {
    if (block.structural) continue;
    if (block.group === 'generator') reasons.push(`生成参数：${block.label}`);
    else if (block.group === 'exif') reasons.push(`EXIF：${block.label}`);
    else if (block.group === 'xmp') reasons.push(`XMP：${block.label}`);
    else if (block.group === 'c2pa') reasons.push(`来源凭证：${block.label}`);
    else if (block.group === 'text') annotations.push(`文本块：${block.label}`);
  }

  return {
    clean: reasons.length === 0,
    reasons,
    annotations,
    verdict: assembleVerdict(reasons.length, annotations.length),
  };
}

/** 只问结论、不要理由的调用方用它（列表里的徽标、批量的行内标签） */
export function classifyBlocks(blocks: ContainerBlock[]): BlockVerdict {
  let traces = 0;
  let annotations = 0;
  for (const block of blocks) {
    if (block.structural) continue;
    if (block.group === 'text') annotations += 1;
    else if (block.group !== 'icc') traces += 1;
  }
  return assembleVerdict(traces, annotations);
}

function assembleVerdict(traces: number, annotations: number): BlockVerdict {
  if (traces > 0) return 'traces';
  if (annotations > 0) return 'annotated';
  return 'clean';
}

/** 把 `ContainerBlock[]` 收成界面与台账要的 `MetaBlock[]` */
export function toMetaBlocks(blocks: ContainerBlock[]): MetaBlock[] {
  return blocks.map((block) => ({
    id: block.id,
    label: block.label,
    group: block.group,
    text: block.text,
    bytes: block.bytes,
    removable: block.removable,
    // `undefined`（容器层没填）与 `null`（看过但不认识）对界面是同一件事：
    // 没有来源可显示。合并成 `null` 让 `MetaBlock` 不必也带一个可选字段。
    origin: block.origin ?? null,
  }));
}
