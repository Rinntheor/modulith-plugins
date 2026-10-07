// src/art-trace/gen/a1111.ts
//
// AUTOMATIC1111 / Forge / reForge / SD.Next / Fooocus 的识别与归一化。
//
// ============================================================
// 为什么这几家必须共用一个解析器
// ============================================================
//
// 它们写进图片的是**同一块** `tEXt(parameters)`，而且格式互相抄：
//
// * A1111 / Forge / reForge / SD.Next 写的是经典多行文本；
// * Fooocus 写的是**一段 JSON**（但关键词同样叫 `parameters`）；
// * SwarmUI 也写 `parameters`，里面是 `{"sui_image_params": {...}}`；
// * 有些 A1111 插件会把 `Software` 一并写进参数行。
//
// 因此判定顺序**必须先试 JSON，再试文本格式**。反过来的话，Fooocus 的那段 JSON 会
// 走进文本分支：里面没有 `Steps:` 行（JSON 是单行、键名是 `"steps"`），于是正负提示词
// 会退化成"整段 JSON 当作正向提示词"，用户看到的是满屏的 `{"prompt": ...}`。
//
// ============================================================
// 这个格式最容易写错的一处：参数行按逗号切
// ============================================================
//
// 参数部分是 `Steps: 28, Sampler: ..., Lora hashes: "a: 1, b: 2"`。看上去按 `, ` 切
// 就行了，但**值里可以有逗号**（`Lora hashes`、`TI hashes` 都带引号里的逗号，而
// reForge 的 `Schedule type` 后面偶尔还跟着一句带逗号的说明）。
//
// 正确做法是"先切再拼回"：切出来的片段如果**不是** `某个已知参数名: ` 的形状，就说明
// 它是上一个参数的值的一部分，要**拼回上一个参数的值**。只看"有没有冒号"是不够的：
// `Lora hashes` 的值 `"a: 1, b: 2"` 里每个片段都带冒号。
//
// 判据因此是**已知参数名**，而不是"像不像键值对"。这份名单见 `KNOWN_KEYS`，
// 它同时也是"哪些参数要进 extras"的清单。

import type { GenParams } from '../model/types';
import type { TextBlock } from './blocks';
import {
  asNumber,
  asString,
  parseJsonRecord,
  pick,
  pushExtra,
  truncate,
} from './blocks';

// ============================================================
// 参数名清单
// ============================================================

/** 会被归一化成 GenParams 正式字段的参数名。 */
const FIELD_KEYS = new Set([
  'steps',
  'sampler',
  'schedule type',
  'scheduler',
  'cfg scale',
  'seed',
  'size',
  'model',
  'model hash',
  'vae',
  'clip skip',
  'denoising strength',
]);

/**
 * 所有已知参数名（小写）。
 *
 * **这份名单是"按逗号切之后能不能拼回来"的唯一判据**，因此宁可长一点：漏掉一个
 * 参数名会把它的值拼到上一个参数上，表现成"Sampler 里出现了一串莫名其妙的东西"，
 * 而多列一个不存在于这张图的参数名，代价为零。
 */
const KNOWN_KEYS = new Set([
  ...FIELD_KEYS,
  'hires upscale',
  'hires upscaler',
  'hires steps',
  'hires checkpoint',
  'hires cfg',
  'hires sampler',
  'hires schedule type',
  'hires prompt',
  'hires negative prompt',
  'ensd',
  'vae hash',
  'version',
  'lora hashes',
  'ti hashes',
  'schedule type',
  'distilled cfg scale',
  'ngms',
  'gits',
  'gits version',
  'refiner',
  'refiner switch at',
  'face restoration',
  'variation seed',
  'variation seed strength',
  'seed resize from',
  'cfg rescale',
  'noise multiplier',
  'scheduler',
  'token merging ratio',
  'pad cond uncond',
  'module 1',
  'module 2',
  'module 3',
  'downcast alphas_cumprod',
  'vae decoder',
  'app',
  'software',
  'user',
  'date',
  'comment',
]);

/** 末尾是调度器的采样器：`DPM++ 2M Karras` 要拆成 `DPM++ 2M` + `Karras`。 */
const SCHEDULERS = [
  'SGM Uniform',
  'Align Your Steps',
  'Karras',
  'Exponential',
  'Normal',
  'Simple',
  'Beta',
  'DDIM',
  'Euler a',
  'Euler',
  'Heun',
  'LCM',
  'Polyexponential',
  'KL Optimal',
  'Automatic',
  'Uniform',
  'Linear',
];

/**
 * `Lora hashes: "a: 1, b: 2"` → `['a', 'b']`（哈希本身进 extras）。
 * 名字里可能有逗号以外的一切字符，因此以 `, ` 分隔、以第一个 `:` 切分。
 */
function parseLoraHashes(value: string): string[] {
  const inner = value.replace(/^"/, '').replace(/"$/, '');
  const out: string[] = [];
  for (const part of inner.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const name = colon >= 0 ? trimmed.slice(0, colon).trim() : trimmed;
    if (name.length > 0) out.push(name);
  }
  return out;
}

/** 提示词里的 `<lora:名字:0.8>` / `<lyco:...>` / `<hypernet:...>` 标签。 */
const TAG_PATTERN = /<(lora|lyco|hypernet|lokr):([^:>]+)(?::([^>]+))?>/gi;

function parsePromptTags(prompt: string): string[] {
  const out: string[] = [];
  // 用 matchAll 而不是 exec 循环：exec 的 lastIndex 是有状态的，而这条正则是模块级
  // 常量 —— 有状态的正则被并发调用时会互相吃掉匹配位置。
  for (const match of prompt.matchAll(TAG_PATTERN)) {
    const kind = (match[1] ?? '').toLowerCase();
    const name = (match[2] ?? '').trim();
    const weight = (match[3] ?? '').trim();
    if (name.length === 0) continue;
    const label = kind === 'lora' || kind === 'lokr' ? name : `${kind}: ${name}`;
    out.push(weight.length > 0 ? `${label} (${weight})` : label);
  }
  return out;
}

// ============================================================
// 文本格式
// ============================================================

interface ParameterLine {
  positive: string;
  negative: string | null;
  params: Array<{ key: string; value: string }>;
}

/**
 * 把 `parameters` 拆成"正负提示词 + 参数行"。
 *
 * 参数部分的起点是**第一个行首的 `Steps:`**：A1111 的行序是固定的（提示词 → 参数），
 * 而提示词是自由文本，里面完全可能出现 `Steps:` 这几个字（有人在提示词里写
 * "Steps: 30 的效果更好"）。用行首定位能把这一类误判挡掉。
 */
export function parseParameterText(text: string): ParameterLine {
  const normalized = text.replace(/\r\n?/g, '\n');
  // 参数部分的起点是**第一个行首的 `Steps:`**：A1111 的行序是固定的（提示词 → 参数），
  // 而提示词是自由文本，里面完全可能出现 `Steps:` 这几个字（有人在提示词里写
  // "Steps: 30 的效果更好"）。用行首定位能把这一类误判挡掉。
  const stepsMatch = /^[ \t]*Steps:[ \t]*/m.exec(normalized);
  const promptPart = stepsMatch ? normalized.slice(0, stepsMatch.index) : normalized;
  // 拼回 `Steps: ` 前缀：切掉它会让 `Steps` 这一项从参数列表里消失，
  // 表现成"steps 读不出来"（其它参数都正常），是一个很容易漏掉的 off-by-one。
  const paramPart = stepsMatch
    ? `Steps: ${normalized.slice(stepsMatch.index + stepsMatch[0].length)}`
    : '';

  const negativeMatch = /^Negative prompt:[ \t]?/m.exec(promptPart);
  let positive: string;
  let negative: string | null;
  if (negativeMatch) {
    positive = promptPart.slice(0, negativeMatch.index).trim();
    negative = promptPart.slice(negativeMatch.index + negativeMatch[0].length).trim();
  } else {
    positive = promptPart.trim();
    negative = null;
  }

  const lines: ParameterLine['params'] = [];
  if (paramPart.length > 0) {
    // 只切第一行：A1111 的参数行是一行，之后的内容（如果有）是别的工具追加的，
    // 按新行起一条参数、值里带换行，反而比丢掉更糟。
    const firstLine = paramPart.split('\n')[0] ?? '';
    for (const segment of firstLine.split(', ')) {
      const colon = segment.indexOf(':');
      const candidate = colon > 0 ? segment.slice(0, colon).trim().toLowerCase() : '';
      if (colon > 0 && KNOWN_KEYS.has(candidate)) {
        lines.push({ key: segment.slice(0, colon).trim(), value: segment.slice(colon + 1).trim() });
      } else if (lines.length > 0) {
        // 值里有逗号。**拼回上一个参数**（`Lora hashes` 的引号里最常见）。
        const last = lines[lines.length - 1]!;
        last.value = `${last.value}, ${segment.trim()}`;
      }
      // lines 为空时的片段只能丢：它前面没有参数可以归属，留着会变成假参数。
    }
  }

  return { positive, negative, params: lines };
}

/** 从 `Sampler: DPM++ 2M Karras` 里拆出采样器与调度器。 */
export function splitSampler(
  value: string
): { sampler: string; scheduler: string | null } {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  for (const scheduler of SCHEDULERS) {
    const suffix = scheduler.toLowerCase();
    if (lower === suffix) return { sampler: trimmed, scheduler: null };
    if (lower.endsWith(` ${suffix}`)) {
      const head = trimmed.slice(0, trimmed.length - scheduler.length).trim();
      if (head.length > 0) return { sampler: head, scheduler: scheduler };
    }
  }
  return { sampler: trimmed, scheduler: null };
}

/** 名字里有没有 fooocus / ruinedfooocus 的痕迹。 */
function looksLikeFooocus(text: string, software: string | null): boolean {
  const haystack = `${text.slice(0, 4000)} ${software ?? ''}`.toLowerCase();
  return haystack.includes('fooocus') || haystack.includes('ruinedfooocus');
}

/**
 * 识别 `parameters` 块。**先 JSON 后文本**，顺序不能反（理由见文件头）。
 *
 * 注意返回值里的 `evaluated`：它表示"这个块被我处理过了，别再让别的解析器碰它"。
 * 一个坏掉的 Fooocus JSON 会同时满足"是 JSON 但解析失败"与"没有 Steps: 行"两个条件，
 * 如果不标记已处理，它会一路掉到通用兜底里变成一个名字奇怪的生成器。
 */
export function matchParameters(
  blocks: TextBlock[]
): { evidence: string; evaluated: boolean; params: GenParams } | null {
  const parameterBlocks = blocks.filter((block) => block.keyword === 'parameters');
  if (parameterBlocks.length === 0) return null;

  // 图里可能有多个 `parameters` 块（一次拼接、一次后处理）。取最长的那个：
  // 参数多的那一份几乎总是生成器写的原文，短的那份是后续工具追加的摘要。
  const block = parameterBlocks.reduce((best, item) =>
    item.text.length > best.text.length ? item : best
  );

  const trimmed = block.text.trim();
  if (trimmed.startsWith('{')) {
    const json = parseJsonRecord(trimmed);
    if (json) {
      const params = parseA1111LikeJson(json, block.label, trimmed);
      if (params) return { evidence: params.evidence, evaluated: true, params };
      // JSON 能解析但里面没有本模块认识的参数（既没有提示词也没有 steps/seed）：
      // 返回 null 让别的解析器（必要时是通用兜底）去试。**不在这里编一个生成器名** ——
      // 把 SwarmUI 的 JSON 报成 "AUTOMATIC1111" 比什么都不报更坏。
      return null;
    }
    // 坏 JSON 就继续往下走：它可能是被截断的 Fooocus JSON，也可能是某个分支把 JSON
    // 和文本混在一行里的怪格式，而下面的文本分支还能救回提示词。
  }

  const parsed = parseParameterText(block.text);
  if (parsed.params.length === 0) return null;

  const software = findParameterValue(parsed.params, 'software');
  const fooocus = looksLikeFooocus(block.text, software) || parsed.positive.startsWith('{');
  const generator = fooocus ? 'Fooocus' : 'AUTOMATIC1111';

  const evidenceParts: string[] = [];
  if (fooocus) {
    evidenceParts.push(
      `tEXt(${block.keyword}) 是 A1111 风格文本，但内容里出现 Fooocus 字样${
        /^Fooocus v?\d/.test(trimmed) ? '（或版本行以 Fooocus 开头）' : ''
      }`
    );
  } else {
    evidenceParts.push(
      `tEXt(${block.keyword}) 是 A1111 经典多行格式（有 "Negative prompt:" 与行首 "Steps:"）`
    );
  }
  if (!parsed.negative) evidenceParts.push('没有 "Negative prompt:" 行，负向提示词为空');

  const params = buildFromParameterLines(generator, evidenceParts.join('；'), parsed, block.text);
  return { evidence: params.evidence, evaluated: true, params };
}

function findParameterValue(
  lines: Array<{ key: string; value: string }>,
  name: string
): string | null {
  const lower = name.toLowerCase();
  for (const line of lines) {
    if (line.key.toLowerCase() === lower) return line.value;
  }
  return null;
}

/** 把一个参数行数组归一化成 GenParams。文本格式与 JSON 格式共用。 */
function buildFromParameterLines(
  generator: string,
  evidence: string,
  parsed: ParameterLine,
  raw: string
): GenParams {
  const extras: Array<{ key: string; value: string }> = [];
  let steps: number | null = null;
  let cfg: number | null = null;
  let seed: string | null = null;
  let sampler: string | null = null;
  let scheduler: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let model: string | null = null;
  let modelHash: string | null = null;
  let vae: string | null = null;
  let clipSkip: number | null = null;
  let denoising: number | null = null;
  const loras: string[] = [];

  for (const { key, value } of parsed.params) {
    // 键名统一小写再比较：A1111 自己写 `Steps`，而有些分支写 `steps`。
    switch (key.toLowerCase()) {
      case 'steps': {
        const num = asNumber(value);
        if (num !== null) steps = num;
        else pushExtra(extras, key, value);
        break;
      }
      case 'sampler': {
        const split = splitSampler(value);
        sampler = split.sampler;
        if (split.scheduler) scheduler = split.scheduler;
        else pushExtra(extras, key, value);
        break;
      }
      case 'schedule type':
      case 'scheduler':
        scheduler = value;
        break;
      case 'cfg scale': {
        const num = asNumber(value);
        if (num !== null) cfg = num;
        else pushExtra(extras, key, value);
        break;
      }
      case 'seed':
        // **种子一律当字符串。** 它可以是 `-1`（随机），也可以是 20 位的大整数，
        // 转成 number 会丢精度 —— 而种子是"复现这张图"的唯一钥匙，丢一位就废了。
        seed = value;
        break;
      case 'size': {
        const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(value);
        if (match) {
          width = Number(match[1]);
          height = Number(match[2]);
        } else {
          pushExtra(extras, key, value);
        }
        break;
      }
      case 'model':
        model = value;
        break;
      case 'model hash':
        modelHash = value;
        break;
      case 'vae':
        vae = value;
        break;
      case 'clip skip': {
        const num = asNumber(value);
        if (num !== null) clipSkip = num;
        else pushExtra(extras, key, value);
        break;
      }
      case 'denoising strength': {
        const num = asNumber(value);
        if (num !== null) denoising = num;
        else pushExtra(extras, key, value);
        break;
      }
      case 'lora hashes': {
        for (const name of parseLoraHashes(value)) loras.push(name);
        pushExtra(extras, 'Lora hashes', value);
        break;
      }
      case 'software': {
        // `Software: Fooocus` 是 Fooocus 的强证据；A1111 也会写它，值形如
        // `Stable Diffusion`。它不该被当成"参数"丢掉，但也不必进 extras 表格。
        pushExtra(extras, key, value);
        break;
      }
      default:
        pushExtra(extras, key, value);
        break;
    }
  }

  // 提示词里的 LoRA 标签。**原文不动**（用户要靠它复现），标签解析出来只进 loras。
  const tagged = parsePromptTags(parsed.positive);
  for (const name of tagged) loras.push(name);

  const evidenceParts = [evidence];
  if (sampler) {
    evidenceParts.push(
      `"Sampler: ${sampler}${scheduler ? ` ${scheduler}` : ''}" 已拆成采样器与调度器（末尾词命中调度器名单就当调度器）`
    );
  }
  if (tagged.length > 0) {
    evidenceParts.push(`正向提示词里有 ${tagged.length} 个 <lora:…> 之类的标签，已并入 LoRA 列表且提示词原文保留`);
  }
  if (loras.length > 0 && (findParameterValue(parsed.params, 'Lora hashes') ?? null) !== null) {
    evidenceParts.push('`Lora hashes` 的值里含逗号，按"已知参数名"判据拼回，未按逗号切开');
  }

  return {
    generator,
    evidence: evidenceParts.join('；'),
    prompt: parsed.positive.length > 0 ? parsed.positive : null,
    negativePrompt: parsed.negative && parsed.negative.length > 0 ? parsed.negative : null,
    seed,
    steps,
    cfg,
    sampler,
    scheduler,
    model,
    modelHash,
    vae,
    clipSkip,
    width,
    height,
    denoising,
    loras,
    controlNets: [], // A1111 的 ControlNet 参数（`ControlNet 0: ...`）各家插件写法都不同，
    // 不在正式字段里假装归一化，让它原样进 extras。
    extras,
    raw,
    workflow: null,
  };
}

// ============================================================
// JSON 格式（Fooocus / SwarmUI / 以及一些分支）
// ============================================================

function emptyParams(generator: string, evidence: string, raw: string): GenParams {
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

/**
 * 解析 `parameters` 里的 JSON。
 *
 * 覆盖三种真实形状（它们的键名互不相同，因此只能靠候选名列表取值）：
 * * Fooocus：`{"prompt", "negative_prompt", "steps", "guidance_scale", "base_model", ...}`
 * * SwarmUI：`{"sui_image_params": {"prompt", "negativeprompt", "model", "cfgscale", ...}}`
 * * 其它分支：`{"prompt", "negative_prompt", "sampler_name", "cfg_scale", ...}`
 */
function parseA1111LikeJson(
  json: Record<string, unknown>,
  label: string,
  raw: string
): GenParams | null {
  const swarm = json['sui_image_params'];
  const inner: Record<string, unknown> = isRecordLike(swarm) ? swarm : json;

  const promptValue = pick(inner, ['prompt', 'positive_prompt', 'positive']);
  const negativeValue = pick(inner, ['negative_prompt', 'negativeprompt', 'negative', 'uc']);
  const hasAnything =
    promptValue !== undefined ||
    negativeValue !== undefined ||
    pick(inner, ['steps', 'sampler', 'sampler_name', 'seed']) !== undefined;
  if (!hasAnything) return null;

  const extras: Array<{ key: string; value: string }> = [];
  const generator = isRecordLike(swarm) ? 'SwarmUI' : detectJsonGenerator(inner, label);

  const samplerName =
    asString(pick(inner, ['sampler_name', 'sampler'])) ?? null;
  const schedulerName = asString(pick(inner, ['scheduler', 'schedule_type'])) ?? null;
  const split = samplerName ? splitSampler(samplerName) : null;

  const loras: string[] = [];
  const loraValue = inner['loras'];
  if (Array.isArray(loraValue)) {
    for (const item of loraValue) {
      if (isRecordLike(item)) {
        const name = asString(pick(item, ['name', 'model_name', 'lora']));
        const weight = asString(pick(item, ['weight', 'strength', 'scale']));
        if (name) loras.push(weight ? `${name} (${weight})` : name);
      } else {
        const name = asString(item);
        if (name) loras.push(name);
      }
    }
  }
  const loraText = asString(inner['lora_hashes']);
  if (loraText) {
    for (const name of parseLoraHashes(loraText)) loras.push(name);
    pushExtra(extras, 'lora_hashes', truncate(loraText));
  }

  for (const [key, value] of Object.entries(inner)) {
    // 已经进了正式字段的键不再重复进 extras；提示词文本太长，也不进（有 raw 可看）。
    const lower = key.toLowerCase();
    if (
      ['prompt', 'positive_prompt', 'positive', 'negative_prompt', 'negativeprompt', 'negative', 'uc', 'loras'].includes(
        lower
      )
    ) {
      continue;
    }
    const text = asString(value);
    if (text === null) {
      // 对象/数组（例如 Fooocus 的 `styles` 是数组）序列化一行保留：这些字段里
      // 经常藏着"用了哪个 refiner、开了哪个 style"，丢掉就没有第二处可查。
      try {
        pushExtra(extras, key, truncate(JSON.stringify(value) ?? ''));
      } catch {
        // JSON.stringify 对循环引用会抛错。这里**不需要**处理循环引用，
        // 因为 JSON.parse 的产物不可能有环 —— 但 try/catch 保底不亏。
      }
      continue;
    }
    pushExtra(extras, key, truncate(text));
  }

  const evidence = isRecordLike(swarm)
    ? `tEXt(${label.includes('(') ? label.slice(label.indexOf('(') + 1, -1) : label}) 是 JSON，含 \`sui_image_params\`（SwarmUI / Stable Swarm 的固定键名）`
    : `tEXt(parameters) 是 JSON（Fooocus 与部分分支用它代替 A1111 的多行文本），含 prompt/negative_prompt 字段`;

  const seedValue = pick(inner, ['seed', 'noise_seed']);

  return {
    generator,
    evidence,
    prompt: asString(promptValue),
    negativePrompt: asString(negativeValue),
    seed: asString(seedValue),
    steps: asNumber(pick(inner, ['steps'])),
    cfg: asNumber(pick(inner, ['cfg_scale', 'cfgscale', 'cfg', 'guidance_scale'])),
    sampler: split ? split.sampler : samplerName,
    scheduler: split?.scheduler ?? schedulerName,
    model: asString(pick(inner, ['base_model', 'model', 'model_name', 'checkpoint'])),
    modelHash: asString(pick(inner, ['model_hash', 'base_model_hash'])),
    vae: asString(pick(inner, ['vae', 'vae_name'])),
    clipSkip: asNumber(pick(inner, ['clip_skip'])),
    width: asNumber(pick(inner, ['width'])),
    height: asNumber(pick(inner, ['height'])),
    denoising: asNumber(pick(inner, ['denoising_strength', 'denoise', 'strength'])),
    loras,
    controlNets: [],
    extras,
    raw,
    workflow: null,
  };
}

/** `isRecord` 的本地别名：这个文件里到处在用，名字短一点读起来更像在描述数据。 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 JSON 的键名判断这是哪一家。判据只有"哪家的特征键出现了"，不猜。 */
function detectJsonGenerator(inner: Record<string, unknown>, label: string): string {
  if (inner['version'] !== undefined && inner['base_model'] !== undefined) return 'Fooocus';
  if (inner['version'] !== undefined && inner['guidance_scale'] !== undefined) return 'Fooocus';
  if (label.toLowerCase().includes('fooocus')) return 'Fooocus';
  const software = asString(inner['software']);
  if (software && software.toLowerCase().includes('fooocus')) return 'Fooocus';
  if (inner['sui_image_params'] !== undefined) return 'SwarmUI';
  return 'AUTOMATIC1111';
}

// ============================================================
// 入口
// ============================================================

/** 这个块像不像 A1111 系（或它的 JSON 变体）的 `parameters`。 */
export function matchA1111(
  blocks: TextBlock[]
): { evidence: string; params: GenParams } | null {
  const matched = matchParameters(blocks);
  if (!matched) return null;
  return { evidence: matched.params.evidence, params: matched.params };
}

/** 供通用兜底使用：把一个生成器名 + 说明变成空参数的 `GenParams`。 */
export function makeEmptyParams(
  generator: string,
  evidence: string,
  raw: string
): GenParams {
  return emptyParams(generator, evidence, raw);
}
