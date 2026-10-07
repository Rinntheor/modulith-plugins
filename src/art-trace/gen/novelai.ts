// src/art-trace/gen/novelai.ts
//
// NovelAI 的识别与归一化。
//
// ============================================================
// 为什么它不能并进 A1111 那个解析器
// ============================================================
//
// NovelAI 的 `Comment` 里是一段 JSON，字段名与 A1111 完全不同（`uc` 而不是
// `negative_prompt`、`scale` 而不是 `CFG scale`、`sampler` 的取值是
// `k_euler_ancestral` 这种带前缀的枚举）。硬并进 A1111 会让那一份解析器里出现
// 两套字段名映射，而两套映射共用一个函数体的代价是每加一家都要重新想一遍
// "这个键属于谁"。
//
// ============================================================
// 两条实测出来的判据
// ============================================================
//
// 1. **`uc` 是 NovelAI 的指纹。** 别家叫 negative / negative_prompt /
//    undesired_content。`uc` 这个两字母键只在 NAI 的 JSON 里出现，用它做主判据
//    几乎不会误判。
// 2. **`Comment` 不一定是合法 JSON。** 老版是一个 JSON 对象；新版有把 JSON
//    直接写成一行文本的、也有在 JSON 前后带一句说明的。因此这里用
//    `parseJsonLoose`（允许前后有杂音），并在 JSON 完全失败时**退回纯文本**：
//    `Comment` 里的纯文本就是提示词本身，把它当 `prompt` 比当成"认不出来"有用。

import type { GenParams } from '../model/types';
import type { TextBlock } from './blocks';
import {
  asNumber,
  asString,
  isRecord,
  parseJsonLoose,
  pick,
  pushExtra,
  truncate,
} from './blocks';

/** NovelAI 的 JSON 指纹键。有一个就算。 */
const NAI_KEYS = ['uc', 'scale', 'sampler', 'noise_schedule'];

/** 这个对象像不像 NAI 的 `Comment`。 */
function looksLikeNai(json: Record<string, unknown>): boolean {
  let hits = 0;
  for (const key of NAI_KEYS) {
    if (json[key] !== undefined) hits++;
  }
  // `steps` + `seed` 两者都有也算：它们是最通用的键，但配合 `width`/`height`
  // 与 `sampler` 就只可能是生成参数。
  if (hits >= 2) return true;
  return hits >= 1 && json['steps'] !== undefined && json['seed'] !== undefined;
}

/** 找 NAI 的证据块：`Comment` 优先，`Description` 作为补充。 */
export function matchNovelAI(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  const commentBlocks = blocks.filter((block) => block.keyword === 'Comment');
  const descriptionBlocks = blocks.filter((block) => block.keyword === 'Description');

  const parsedComments: Array<{ block: TextBlock; json: Record<string, unknown> }> = [];
  for (const block of commentBlocks) {
    const json = parseJsonLoose(block.text);
    if (json && looksLikeNai(json)) parsedComments.push({ block, json });
  }

  if (parsedComments.length === 0) {
    // 没有 JSON 形式的 `Comment` 时，只有在**同时**有 `Description` 的情况下
    // 才把纯文本 `Comment` 当 NAI —— 只凭一个 `Comment` 纯文本块认成 NAI 会误判
    // 一大批手写说明的图（很多人用 `Comment` 写自己作品的备注）。
    if (commentBlocks.length === 0 || descriptionBlocks.length === 0) return null;
    const block = commentBlocks[0]!;
    const evidence = `tEXt(Comment) 不是 JSON 但存在 tEXt(Description)（NovelAI 会把提示词与说明分两块写），按 NovelAI 的纯文本形态处理`;
    const params = emptyNai(evidence, block.text);
    params.prompt = block.text.trim().length > 0 ? block.text.trim() : null;
    if (descriptionBlocks[0]) {
      pushExtra(params.extras, 'Description', truncate(descriptionBlocks[0].text));
    }
    return { evidence, params };
  }

  // 多个 `Comment` 时取字段最多的那个：一次拼接会在后面追加一块只含 `Description`
  // 或只含少量键的 `Comment`，取错会得到半份参数。
  const best = parsedComments.reduce((left, right) =>
    Object.keys(right.json).length > Object.keys(left.json).length ? right : left
  );
  const json = best.json;

  const evidenceParts = [
    `tEXt(Comment) 是 JSON 且含 NovelAI 的特征键（${NAI_KEYS.filter((key) => json[key] !== undefined).join(' / ')}）`,
  ];
  if (descriptionBlocks.length > 0) {
    evidenceParts.push('另有 tEXt(Description)，作为补充证据');
  }

  const extras: Array<{ key: string; value: string }> = [];
  if (json['sm'] !== undefined || json['sm_dyn'] !== undefined) {
    // SMEA 是 NAI 特有的采样增强开关，别家没有对应字段，因此只进 extras。
    pushExtra(
      extras,
      'SMEA',
      `sm=${asString(json['sm']) ?? '?'} / sm_dyn=${asString(json['sm_dyn']) ?? '?'}`
    );
  }
  if (descriptionBlocks[0]) {
    pushExtra(extras, 'Description', truncate(descriptionBlocks[0].text));
  }
  for (const [key, value] of Object.entries(json)) {
    const lower = key.toLowerCase();
    if (
      ['prompt', 'uc', 'steps', 'sampler', 'seed', 'scale', 'width', 'height', 'noise_schedule', 'scheduler', 'sm', 'sm_dyn'].includes(
        lower
      )
    ) {
      continue;
    }
    const text = asString(value);
    if (text !== null) pushExtra(extras, key, truncate(text));
    else if (isRecord(value) || Array.isArray(value)) {
      try {
        pushExtra(extras, key, truncate(JSON.stringify(value) ?? ''));
      } catch {
        // 见 a1111.ts 里同样的说明：JSON.parse 的产物不会有环，这里是纯保底。
      }
    }
  }

  const params: GenParams = {
    generator: 'NovelAI',
    evidence: evidenceParts.join('；'),
    prompt: asString(pick(json, ['prompt', 'description'])) ?? null,
    negativePrompt: asString(pick(json, ['uc', 'negative_prompt', 'undesired_content'])) ?? null,
    seed: asString(pick(json, ['seed'])),
    steps: asNumber(pick(json, ['steps'])),
    cfg: asNumber(pick(json, ['scale', 'cfg_scale'])),
    sampler: asString(pick(json, ['sampler'])),
    scheduler: asString(pick(json, ['noise_schedule', 'scheduler'])),
    model: asString(pick(json, ['model', 'model_name'])),
    modelHash: null,
    vae: null,
    clipSkip: null,
    width: asNumber(pick(json, ['width'])),
    height: asNumber(pick(json, ['height'])),
    denoising: asNumber(pick(json, ['strength', 'denoising_strength'])),
    loras: [],
    controlNets: [],
    extras,
    raw: best.block.text,
    workflow: null,
  };

  return { evidence: params.evidence, params };
}

function emptyNai(evidence: string, raw: string): GenParams {
  return {
    generator: 'NovelAI',
    evidence,
    prompt: null,
    negativePrompt: null,
    seed: null,
    steps: null,
    cfg: null,
    sampler: null,
    scheduler: null,
    model: null,
    modelHash: null,
    vae: null,
    clipSkip: null,
    width: null,
    height: null,
    denoising: null,
    loras: [],
    controlNets: [],
    extras: [],
    raw,
    workflow: null,
  };
}
