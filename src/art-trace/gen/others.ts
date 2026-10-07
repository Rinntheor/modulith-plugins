// src/art-trace/gen/others.ts
//
// 其余生成器：InvokeAI / Fooocus / SwarmUI（Stable Swarm）/ Draw Things，以及通用兜底。
//
// ============================================================
// 为什么这些"一家一段"的解析器仍然值得写
// ============================================================
//
// 它们每一家的字段名都不一样，而用户看到"这张图是 InvokeAI 生成的"和看到
// "认不出来"之间的差别很大：前者至少能拿到提示词、种子、步数，后者什么都没有。
// 一段三十行的映射换来一张图可复现，性价比很高。
//
// 共同点只有一个：**来源都是 JSON**（InvokeAI 的 `invokeai_metadata`、SwarmUI 的
// `swarm_version`/`parameters`、Draw Things 藏在 XMP 里的 JSON）。因此这个文件里
// 反复出现的动作是"把 JSON 里认识的键抄到 GenParams 上，其余的塞进 extras"。
// 抄不了的不猜 —— 认不出的键进 extras，用户至少看得到。

import type { GenParams } from '../model/types';
import type { TextBlock } from './blocks';
import {
  asNumber,
  asString,
  isRecord,
  parseJsonLoose,
  parseJsonRecord,
  pick,
  pushExtra,
  truncate,
} from './blocks';

/** 从 JSON 的 `prompt` 字段取值：它有时是字符串，有时是数组（旧的 sd-metadata）。 */
function promptFrom(value: unknown): string | null {
  const direct = asString(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      // 旧版 InvokeAI 的 `sd-metadata.prompt` 是 `[{"prompt": "...", "weight": 1}]`
      // 或者 `["a photo of", {"prompt": "x"}]` 这种混合数组。
      if (isRecord(item)) {
        const nested = asString(item['prompt']);
        if (nested !== null) parts.push(nested);
      } else {
        const text = asString(item);
        if (text !== null) parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

// ============================================================
// InvokeAI
// ============================================================

/** 逐个试 `invokeai_metadata`（新版）/ `invokeai`（旧版）/ `sd-metadata`（更旧）。 */
export function matchInvokeAI(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  const candidates: Array<{ block: TextBlock; json: Record<string, unknown> }> = [];
  for (const block of blocks) {
    if (
      block.keyword !== 'invokeai_metadata' &&
      block.keyword !== 'invokeai' &&
      block.keyword !== 'sd-metadata'
    ) {
      continue;
    }
    const json = parseJsonRecord(block.text) ?? parseJsonLoose(block.text);
    if (json) candidates.push({ block, json });
  }
  if (candidates.length === 0) return null;

  // 新版 `invokeai_metadata` 字段最全，优先；旧版 `sd-metadata` 常常只有提示词。
  const preferred =
    candidates.find((item) => item.block.keyword === 'invokeai_metadata') ??
    candidates.find((item) => item.block.keyword === 'invokeai') ??
    candidates[0]!;

  // `sd-metadata` 里真正的参数在 `image` 下（`{"image": {"prompt": [...], "seed": ...}}`），
  // 而有些版本把 `image` 省了。两层都试。
  const imageValue = preferred.json['image'];
  const inner = isRecord(imageValue) ? imageValue : preferred.json;

  const extras: Array<{ key: string; value: string }> = [];
  const loras: string[] = [];
  const loraValue = inner['loras'];
  if (Array.isArray(loraValue)) {
    for (const item of loraValue) {
      if (isRecord(item)) {
        const name = asString(pick(item, ['lora', 'name', 'model_name']));
        const weight = asString(pick(item, ['weight', 'strength']));
        if (name) loras.push(weight ? `${name} (${weight})` : name);
      } else {
        const name = asString(item);
        if (name) loras.push(name);
      }
    }
  }

  for (const [key, value] of Object.entries(inner)) {
    const lower = key.toLowerCase();
    if (
      [
        'prompt',
        'positive_prompt',
        'negative_prompt',
        'seed',
        'steps',
        'cfg_scale',
        'scheduler',
        'model',
        'width',
        'height',
        'loras',
        'model_hash',
        'vae',
        'strength',
      ].includes(lower)
    ) {
      continue;
    }
    const text = asString(value);
    if (text !== null) pushExtra(extras, key, truncate(text));
    else if (isRecord(value) || Array.isArray(value)) {
      try {
        pushExtra(extras, key, truncate(JSON.stringify(value) ?? ''));
      } catch {
        // JSON.parse 的产物不会有环，这里是纯保底。
      }
    }
  }

  const evidence = `tEXt(${preferred.block.keyword}) 是 JSON 且含 InvokeAI 的固定键名（${
    preferred.block.keyword === 'sd-metadata' ? '`image` 下是生成参数' : 'positive_prompt / negative_prompt / cfg_scale 这一组'
  }）`;

  return {
    evidence,
    params: {
      generator: 'InvokeAI',
      evidence,
      prompt: asString(pick(inner, ['positive_prompt', 'prompt'])) ?? promptFrom(inner['prompt']),
      negativePrompt: asString(pick(inner, ['negative_prompt', 'negative'])) ?? null,
      seed: asString(pick(inner, ['seed'])),
      steps: asNumber(pick(inner, ['steps'])),
      cfg: asNumber(pick(inner, ['cfg_scale', 'cfg'])),
      sampler: asString(pick(inner, ['sampler', 'sampler_name'])),
      scheduler: asString(pick(inner, ['scheduler'])),
      model: asString(pick(inner, ['model', 'model_name'])),
      modelHash: asString(pick(inner, ['model_hash'])),
      vae: asString(pick(inner, ['vae'])),
      clipSkip: asNumber(pick(inner, ['clip_skip'])),
      width: asNumber(pick(inner, ['width'])),
      height: asNumber(pick(inner, ['height'])),
      denoising: asNumber(pick(inner, ['strength', 'denoising_strength'])),
      loras,
      controlNets: [],
      extras,
      raw: preferred.block.text,
      workflow: null,
    },
  };
}

// ============================================================
// Fooocus / SwarmUI —— 两者都写 `parameters`（有时还有 `swarm_version`）
// ============================================================

function matchJsonParameters(
  blocks: TextBlock[],
  generatorName: string
): { evidence: string; params: GenParams } | null {
  for (const block of blocks) {
    const keyword = block.keyword.toLowerCase();
    if (keyword !== 'parameters' && keyword !== 'swarm_version') continue;
    const trimmed = block.text.trim();
    if (!trimmed.startsWith('{')) continue;
    const json = parseJsonRecord(trimmed);
    if (!json) continue;

    const swarm = json['sui_image_params'];
    const isSwarm = isRecord(swarm) || block.keyword.toLowerCase() === 'swarm_version';
    if (generatorName === 'SwarmUI' && !isSwarm) continue;
    if (generatorName === 'Fooocus' && isSwarm) continue;
    if (generatorName === 'Fooocus' && !looksLikeFooocusJson(json)) continue;

    const inner = isRecord(swarm) ? swarm : json;
    const extras: Array<{ key: string; value: string }> = [];
    const loras: string[] = [];
    const loraValue = inner['loras'];
    if (Array.isArray(loraValue)) {
      for (const item of loraValue) {
        if (isRecord(item)) {
          const name = asString(pick(item, ['name', 'model_name', 'lora']));
          const weight = asString(pick(item, ['weight', 'strength']));
          if (name) loras.push(weight ? `${name} (${weight})` : name);
        } else {
          const name = asString(item);
          if (name) loras.push(name);
        }
      }
    }

    for (const [key, value] of Object.entries(inner)) {
      const lower = key.toLowerCase();
      if (
        [
          'prompt',
          'negative_prompt',
          'negativeprompt',
          'steps',
          'sampler',
          'sampler_name',
          'seed',
          'cfg_scale',
          'cfgscale',
          'guidance_scale',
          'width',
          'height',
          'model',
          'base_model',
          'scheduler',
          'loras',
        ].includes(lower)
      ) {
        continue;
      }
      const text = asString(value);
      if (text !== null) pushExtra(extras, key, truncate(text));
      else if (isRecord(value) || Array.isArray(value)) {
        try {
          pushExtra(extras, key, truncate(JSON.stringify(value) ?? ''));
        } catch {
          // 保底
        }
      }
    }

    const evidence = isSwarm
      ? `tEXt(${block.keyword}) 是 JSON 且含 \`sui_image_params\`（SwarmUI / Stable Swarm 的固定键名）`
      : `tEXt(${block.keyword}) 是 JSON 且含 Fooocus 的键（base_model / guidance_scale / styles 之一），而不是 A1111 的多行文本`;

    const params: GenParams = {
      generator: generatorName,
      evidence,
      prompt: asString(pick(inner, ['prompt', 'positive_prompt'])) ?? promptFrom(inner['prompt']),
      negativePrompt: asString(pick(inner, ['negative_prompt', 'negativeprompt', 'negative'])) ?? null,
      seed: asString(pick(inner, ['seed', 'noise_seed'])),
      steps: asNumber(pick(inner, ['steps'])),
      cfg: asNumber(pick(inner, ['cfg_scale', 'cfgscale', 'cfg', 'guidance_scale'])),
      sampler: asString(pick(inner, ['sampler', 'sampler_name'])),
      scheduler: asString(pick(inner, ['scheduler', 'schedule_type'])),
      model: asString(pick(inner, ['base_model', 'model', 'model_name'])),
      modelHash: asString(pick(inner, ['model_hash', 'base_model_hash'])),
      vae: asString(pick(inner, ['vae'])),
      clipSkip: asNumber(pick(inner, ['clip_skip'])),
      width: asNumber(pick(inner, ['width'])),
      height: asNumber(pick(inner, ['height'])),
      denoising: asNumber(pick(inner, ['denoising_strength', 'denoise', 'strength'])),
      loras,
      controlNets: [],
      extras,
      raw: block.text,
      workflow: null,
    };
    return { evidence, params };
  }
  return null;
}

/** Fooocus 的 JSON 指纹：`base_model` 是它独有的键名（A1111 用 `Model`）。 */
function looksLikeFooocusJson(json: Record<string, unknown>): boolean {
  if (json['sui_image_params'] !== undefined) return false;
  return (
    json['base_model'] !== undefined ||
    json['guidance_scale'] !== undefined ||
    json['styles'] !== undefined ||
    json['refiner_model'] !== undefined
  );
}

export function matchFooocus(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  return matchJsonParameters(blocks, 'Fooocus');
}

export function matchSwarmUI(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  return matchJsonParameters(blocks, 'SwarmUI');
}

// ============================================================
// Draw Things
// ============================================================

/** 从 XMP 里抠出 `drawthings` 字段的值。两种写法：属性值 或 元素文本。 */
function extractDrawThingsXmp(xmp: string): string | null {
  const attribute = /drawthings\s*=\s*"([^"]*)"/i.exec(xmp);
  if (attribute?.[1]) {
    return decodeXmlEntities(attribute[1]);
  }
  const element = /<drawthings[^>]*>([\s\S]*?)<\/drawthings>/i.exec(xmp);
  if (element?.[1]) return decodeXmlEntities(element[1]).trim();
  return null;
}

/**
 * XMP 里的值会被 XML 转义。`&quot;` 不解开的话，后面 `JSON.parse` 一定失败 ——
 * 而 Draw Things 的参数是一整段带引号的 JSON，转义得很彻底，因此这一步是必须的。
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

export function matchDrawThings(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  // 形态一：`tEXt(drawthings)` 里直接是 JSON。
  const directBlock = blocks.find(
    (block) => block.keyword.toLowerCase() === 'drawthings'
  );
  if (directBlock) {
    const json = parseJsonLoose(directBlock.text);
    if (json) {
      const evidence = `tEXt(${directBlock.keyword}) 是 Draw Things 写参数的固定关键词`;
      return { evidence, params: buildDrawThings(json, evidence, directBlock.text) };
    }
  }

  // 形态二：XMP 里 `xmp:CreatorTool` 含 "Draw Things"。
  for (const block of blocks) {
    const keyword = block.keyword.toLowerCase();
    if (!keyword.includes('xmp')) continue;
    const text = block.text;
    const creator = /CreatorTool[^>]*>\s*([^<]*)/i.exec(text);
    const hasCreatorTool = creator?.[1] ? creator[1].includes('Draw Things') : false;
    const payload = extractDrawThingsXmp(text);
    if (!hasCreatorTool && !payload) continue;

    const evidence = hasCreatorTool
      ? `XMP 的 xmp:CreatorTool 是 "${(creator?.[1] ?? '').trim()}"（Draw Things 在 XMP 里留的固定署名）`
      : 'XMP 里有 `drawthings` 字段（Draw Things 写参数的固定位置）';
    const json = payload ? parseJsonLoose(payload) : null;
    if (json) return { evidence, params: buildDrawThings(json, evidence, text) };
    return {
      evidence,
      params: emptyOther('Draw Things', `${evidence}，但里面的 JSON 读不出来`, text),
    };
  }

  return null;
}

/** Draw Things 的 JSON 键名与别家都不一样（`guidanceScale` 是驼峰）。 */
function buildDrawThings(
  json: Record<string, unknown>,
  evidence: string,
  raw: string
): GenParams {
  const extras: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(json)) {
    const lower = key.toLowerCase();
    if (
      [
        'prompt',
        'negativeprompt',
        'negative_prompt',
        'steps',
        'sampler',
        'seed',
        'guidancescale',
        'guidance_scale',
        'cfgscale',
        'width',
        'height',
        'model',
        'scheduler',
        'strength',
      ].includes(lower)
    ) {
      continue;
    }
    const text = asString(value);
    if (text !== null) pushExtra(extras, key, truncate(text));
    else if (isRecord(value) || Array.isArray(value)) {
      try {
        pushExtra(extras, key, truncate(JSON.stringify(value) ?? ''));
      } catch {
        // 保底
      }
    }
  }

  return {
    generator: 'Draw Things',
    evidence,
    prompt: asString(pick(json, ['prompt', 'c'])),
    negativePrompt: asString(pick(json, ['negativePrompt', 'negative_prompt', 'uc'])),
    seed: asString(pick(json, ['seed'])),
    steps: asNumber(pick(json, ['steps'])),
    cfg: asNumber(pick(json, ['guidanceScale', 'guidance_scale', 'cfgScale', 'cfg_scale'])),
    sampler: asString(pick(json, ['sampler'])),
    scheduler: asString(pick(json, ['scheduler'])),
    model: asString(pick(json, ['model'])),
    modelHash: null,
    vae: null,
    clipSkip: asNumber(pick(json, ['clipSkip', 'clip_skip'])),
    width: asNumber(pick(json, ['width', 'W'])),
    height: asNumber(pick(json, ['height', 'H'])),
    denoising: asNumber(pick(json, ['strength', 'denoising_strength'])),
    loras: [],
    controlNets: [],
    extras,
    raw,
    workflow: null,
  };
}

// ============================================================
// 通用兜底
// ============================================================

/**
 * 生成工具的名字片段。**只有落在这一张表里的 `Software` 才算生成器证据。**
 *
 * ============================================================
 * 为什么必须有这张表（它是一次真实的自伤）
 * ============================================================
 *
 * 这一条原本的判据是"只要有一个 `Software` 块就当作生成器"。理由看起来站得住：
 * `Software` 是 PNG 规范的标准关键词，它至少回答了"这张图经过了什么"。
 *
 * 但它有一个当天就会撞上的后果：**本插件自己会往成品里写 `Software`**
 * （「成品标注」那一项，值就是插件名）。于是流程变成：
 *
 *     抹掉生成参数 → 写上 `Software: Modulith 影像元数据工坊` → 重新打开这张成品
 *     → 工具说"这张图带着 **Modulith 影像元数据工坊** 的生成参数"
 *
 * 用户会以为清理失败。而更普遍的问题是：`Software` 是**通用**字段 ——
 * Photoshop、GIMP、ImageMagick、相机固件都写它。把"这个字段存在"当成"这是 AI 生成的"，
 * 是一个不该由这个工具做出的推断。
 *
 * 因此现在的判据是**内容**：值里出现下列任一名字才算生成器证据。这不是白名单式
 * 的"支持列表"，而是"这个名字本身就在说它是什么"。
 *
 * 认不出来时返回 `null`，而 `Software` 那一块仍然会出现在「元数据块」列表里 ——
 * **信息一点没丢**，丢掉的只是一个错误的结论。
 */
const GENERATOR_NAME_HINTS = [
  'comfyui',
  'comfy',
  'stable diffusion',
  'stablediffusion',
  'automatic1111',
  'a1111',
  'forge',
  'reforge',
  'sd.next',
  'sdnext',
  'invokeai',
  'invoke',
  'novelai',
  'fooocus',
  'ruinedfooocus',
  'swarmui',
  'stable swarm',
  'draw things',
  'drawthings',
  'diffusers',
  'easy diffusion',
  'krita ai',
  'amuse',
  'midjourney',
  'dall-e',
  'dall·e',
  'flux',
  'novelai',
  'nai diffusion',
  'vlad diffusion',
  'sygil',
  'mochi diffusion',
  'diffusionbee',
];

/**
 * 没有任何专用证据，但有一个 `Software` 文本块，且它的值**自己说明了它是生成工具**。
 *
 * 判据不能只看"这个块存在" —— 理由见上面那张表。认不出来时返回 `null`，
 * 让上层如实报告"没有识别出生成参数"。
 */
export function matchSoftwareBlock(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  const block = blocks.find((item) => item.keyword.toLowerCase() === 'software');
  if (!block) return null;
  const name = block.text.trim();
  if (name.length === 0) return null;

  const lowered = name.toLowerCase();
  const hit = GENERATOR_NAME_HINTS.find((hint) => lowered.includes(hint));
  if (!hit) return null;

  return {
    evidence: `tEXt(Software) 的值 "${name}" 里出现了生成工具名（"${hit}"），且没有任何生成器专用的参数块；据此判定，参数留空`,
    params: emptyOther(name, `依据 tEXt(Software) 判定：软件署名是 "${name}"，没有生成参数`, block.text),
  };
}

function emptyOther(generator: string, evidence: string, raw: string): GenParams {
  return {
    generator,
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
