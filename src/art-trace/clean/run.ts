// src/art-trace/clean/run.ts
//
// 清理层对外的三个小接口：试算、审计、块投影。
//
// ============================================================
// 这个文件曾经有一个重复实现，它是一次真实缺陷的温床
// ============================================================
//
// 它原本还有一份自己的 `cleanImage()` —— 与 `clean/pipeline.ts` 的 `processImage()`
// 做同一件事。两份实现里**只有一份**走对了"先升级分组、再算策略"的顺序，而另一份
// （以及 `previewClean` 与界面上的预览）走的是容器层的原始块，于是：
//
//   默认策略丢掉的块数 = 0，成品与原图逐字节相同，而报告说"成功"。
//
// 修法不是"在三个地方各补一行"，而是：
//   * 顺序收进 `analyze()`（唯一入口）；
//   * **删掉重复实现** —— 一份做同一件事的代码里，只要有一份是对的，另一份就一定
//     会在某次改动静默地落后。
//
// 因此现在这里只剩三件互不重叠的事。`auditBlocks` / `toMetaBlocks` 从 `analyze`
// 再导出，是为了让"这两个函数住在哪里"对调用方不重要。

import type { CleanOptions, ImageInfo } from '../model/types';
import type { FormatParse } from '../codec/format';
import { analyze } from '../analyze';
import { planClean } from './plan';
import type { CleanPlan } from './plan';

export { auditBlocks, toMetaBlocks } from '../analyze';

/**
 * 只做"试算"：解析 + 升级分组 + 算策略，不产生任何新字节。
 *
 * 界面上"开始之前先看看会发生什么"用的就是它；批量场景下它也让"这批一共会丢掉
 * 多少体积"可以在动手之前算出来。
 */
export function previewClean(
  source: Uint8Array,
  options: CleanOptions
): { ok: true; parse: FormatParse; plan: CleanPlan; info: ImageInfo } | { ok: false; error: string } {
  const result = analyze(source);
  if (!result.ok) return { ok: false, error: result.error };

  const { parse, blocks, orientation, info } = result.analysis;
  return {
    ok: true,
    parse,
    info,
    plan: planClean(blocks, options, orientation),
  };
}
