// src/art-trace/gen/index.ts
//
// 语义层的入口：把一批容器块变成"这张图是用什么生成的"。
//
// ============================================================
// 这一层为什么不存在"通用解析"
// ============================================================
//
// 生成器之间没有共同格式，只有共同**证据位置**：PNG 的 `tEXt` 关键词、JPEG 的
// `COM` 段、WebP 的 `EXIF`。因此这里的形状是"一串识别器 + 谁先命中谁负责"，
// 而不是"先归一化成某种中间格式再解析"—— 后者要为每一种生成器写两次映射，
// 而第一次映射（生成器 → 中间格式）永远做不对，因为它们的字段本来就对不上。
//
// ============================================================
// 顺序是这段代码里最容易出错的地方
// ============================================================
//
// `parameters` 这个关键词被 **A1111 / Forge / reForge / SD.Next / Fooocus /
// SwarmUI** 六家共用，`Comment` 被 **NovelAI / 一堆手工工具** 共用。所以顺序不是
// 风格问题，它决定了结果：
//
// 1. `invokeai_metadata` / `invokeai` / `sd-metadata` —— 关键词唯一，先认。
// 2. ComfyUI（`prompt` + `workflow`）—— 关键词唯一，且信息量最大。
// 3. Fooocus / SwarmUI 的 JSON —— **必须早于 A1111 的文本解析**。两者都写
//    `parameters`，而 Fooocus 写的是 JSON。先走文本分支的话，Fooocus 的图会得到
//    "正向提示词 = 整段 JSON"。这条顺序在需求里被专门点出来，因为它真的踩过。
// 4. A1111 文本。
// 5. NovelAI。
// 6. Draw Things。
// 7. 通用兜底：只有 `Software` 块时，把软件名当生成器。
//
// 任何一步抛错都不该让整张图看不了，因此每一步都套 try/catch —— 一个畸形的
// 第三方 JSON 只应当让**这一家**认不出来，而不是让界面上什么都没有。

import type { GenParams } from '../model/types';
import type { ContainerBlock } from '../codec/format';
import type { TextBlock } from './blocks';
import { keywordOf, toTextBlocks } from './blocks';
import { matchComfyUI, parseComfyUI } from './comfyui';
import { matchA1111 } from './a1111';
import { matchNovelAI } from './novelai';
import {
  matchDrawThings,
  matchFooocus,
  matchInvokeAI,
  matchSoftwareBlock,
  matchSwarmUI,
} from './others';

/**
 * 一次识别的产物：归一化参数 + **它用了哪些块**。
 *
 * 为什么要把"用了哪些块"带出来，而不是事后按关键词再找一遍：`parameters` 只有一个
 * 关键字，但 ComfyUI 用的是两块（`prompt` + `workflow`），Draw Things 用的是 XMP。
 * 让识别器自己报出它读了哪几块，`tagGeneratedBlocks` 才能准确地只把**被读懂的那块**
 * 标成生成器参数 —— 事后按关键词猜会把同一份文件里无关的 XMP 也标进去。
 */
interface Match {
  params: GenParams;
  used: TextBlock[];
}

interface Detector {
  name: string;
  run(blocks: TextBlock[]): Match | null;
}

/** 挑出关键词匹配的块（识别器报"我读了哪几块"用）。 */
function usedByKeyword(blocks: TextBlock[], keywords: string[]): TextBlock[] {
  const wanted = new Set(keywords);
  return blocks.filter((block) => wanted.has(block.keyword));
}

const DETECTORS: Detector[] = [
  {
    name: 'InvokeAI',
    run(blocks) {
      const matched = matchInvokeAI(blocks);
      if (!matched) return null;
      return {
        params: matched.params,
        used: usedByKeyword(blocks, ['invokeai_metadata', 'invokeai', 'sd-metadata']),
      };
    },
  },
  {
    name: 'ComfyUI',
    run(blocks) {
      const matched = matchComfyUI(blocks);
      if (!matched) return null;
      const params = parseComfyUI(matched.evidence, matched.promptText, matched.workflowText);
      return { params, used: usedByKeyword(blocks, ['prompt', 'workflow']) };
    },
  },
  {
    name: 'Fooocus',
    run(blocks) {
      const matched = matchFooocus(blocks);
      if (!matched) return null;
      return { params: matched.params, used: usedByKeyword(blocks, ['parameters']) };
    },
  },
  {
    name: 'SwarmUI',
    run(blocks) {
      const matched = matchSwarmUI(blocks);
      if (!matched) return null;
      return {
        params: matched.params,
        used: usedByKeyword(blocks, ['parameters', 'swarm_version']),
      };
    },
  },
  {
    name: 'AUTOMATIC1111',
    run(blocks) {
      const matched = matchA1111(blocks);
      if (!matched) return null;
      return { params: matched.params, used: usedByKeyword(blocks, ['parameters']) };
    },
  },
  {
    name: 'NovelAI',
    run(blocks) {
      const matched = matchNovelAI(blocks);
      if (!matched) return null;
      return { params: matched.params, used: usedByKeyword(blocks, ['Comment', 'Description']) };
    },
  },
  {
    name: 'Draw Things',
    run(blocks) {
      const matched = matchDrawThings(blocks);
      if (!matched) return null;
      // XMP 块要精确到"含 Draw Things 的那一块"：一份文件里可能有多个 XMP
      // （相机、编辑软件各写一份），全标成生成器参数会把无关的东西划进"生成器痕迹"。
      const used = blocks.filter((block) => {
        const keyword = block.keyword.toLowerCase();
        if (keyword === 'drawthings') return true;
        return keyword.includes('xmp') && block.text.includes('Draw Things');
      });
      return { params: matched.params, used };
    },
  },
  {
    name: 'Software',
    run(blocks) {
      const matched = matchSoftwareBlock(blocks);
      if (!matched) return null;
      const used = blocks.filter((block) => block.keyword.toLowerCase() === 'software');
      return { params: matched.params, used };
    },
  },
];

/**
 * 按顺序试识别器，返回第一个命中的**连同它读过的块**。
 *
 * `detectGeneration` 与 `tagGeneratedBlocks` 共用它：如果两处各自遍历一遍，
 * 两边就会有两份顺序，而顺序是这个文件里唯一重要的东西 —— 抄错的代价是
 * "界面上显示的生成器"与"被打标的块"对不上。
 */
function recognize(blocks: TextBlock[]): Match | null {
  for (const detector of DETECTORS) {
    try {
      const matched = detector.run(blocks);
      if (matched) return matched;
    } catch {
      // 一家解析器内部炸了不该影响别家：继续试下一个。
      // 真实场景里这救过场 —— 手工拼的 ComfyUI JSON 里 `inputs` 是数组而不是对象，
      // 遍历图的代码在某些形状上会抛，而别的分支本来能正常识别这张图。
      continue;
    }
  }
  return null;
}

/**
 * 从已解析的容器块里识别生成器并归一化参数。认不出来返回 `null`。
 *
 * **`null` 是一个正常结果，不是错误。** 一张被社交平台重新编码过的图什么痕迹都不剩，
 * 界面上应当显示"没有发现生成参数"，而不是一个红色的失败。
 */
export function detectGeneration(blocks: ContainerBlock[]): GenParams | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  let textBlocks: TextBlock[];
  try {
    textBlocks = toTextBlocks(blocks);
  } catch {
    // 容器块是宿主给的，理论上不会抛；但这一层是"纯函数入口"，一次异常会让整张图
    // 的元数据都显示不出来，代价太大，因此入口本身也包一层。
    return null;
  }
  if (textBlocks.length === 0) return null;

  return recognize(textBlocks)?.params ?? null;
}

/**
 * 被打了来源标记的块。
 *
 * `origin` 在这里是**可选**的、而且不在 `ContainerBlock` 上：容器层只负责"这一块
 * 在文件里的位置"（`label` / `selector` / `group` / `bytes`），来源是语义层加上去的。
 * 用交叉类型把它标出来，而不是回头去改 `codec/format.ts` —— 那样容器层就会依赖
 * 语义层，而分层的意义正是让容器层不认识"生成器"这个概念。
 */
export type TaggedBlock = ContainerBlock & { origin?: string | null };

/**
 * 按识别结果给块升级 `group` / `origin`。**返回新数组，不改原对象。**
 *
 * 行为约定：
 * * 被识别器**实际读过**的那几块（ComfyUI 的 `prompt`/`workflow`、A1111 的
 *   `parameters`、NovelAI 的 `Comment`、Invoke 的 `invokeai_metadata`…）的
 *   `group` 变成 `'generator'`，`origin` 填生成器名。
 * * 已经是 `'generator'` 的块即使这次认不出来也保留 —— 上一次的判定不该被一次
 *   失败的解析抹掉，而且这让函数**幂等**（连续调用两次结果相同）。
 * * 其余块原样返回（同一对象引用）。复制全部块会让界面每次解析都重建整份列表，
 *   而列表 key 就是块的 `id`，重建的代价是滚动位置与选中态丢失。
 */
export function tagGeneratedBlocks(
  blocks: ContainerBlock[],
  generation: GenParams | null
): TaggedBlock[] {
  if (!Array.isArray(blocks)) return [];

  // 只把"这次真正读懂的那几块"标成生成器参数。为此要重跑一次识别 ——
  // `GenParams` 的字段是接口约定死的（没有"证据块"这一项），不能往里面加私货。
  // 重跑是纯函数调用，代价与一次解析相同，而准确性的收益是"被标成生成器痕迹的块
  // 与实际读懂的块完全一致"。
  const evidenceKeywords = new Set<string>();
  if (generation) {
    try {
      const matched = recognize(toTextBlocks(blocks));
      if (matched && matched.params.generator === generation.generator) {
        for (const block of matched.used) evidenceKeywords.add(block.keyword);
      }
    } catch {
      // 识别失败时退化成"不改任何块"：给出与旧对象相同的数组内容，调用方不会崩。
    }
  }

  return blocks.map((block) => {
    const already = block.group === 'generator';
    const keyword = keywordOf(block);
    const isEvidence = keyword !== null && evidenceKeywords.has(keyword);

    if (!generation) {
      // 认不出生成器时**不动**任何块。尤其不能把已经标好的 'generator' 降级：
      // 清理界面依赖这个分组来勾选"要丢掉的东西"，降级会让用户以为没有痕迹可清。
      return block;
    }
    if (!already && !isEvidence) return block;
    return { ...block, group: 'generator', origin: generation.generator };
  });
}
