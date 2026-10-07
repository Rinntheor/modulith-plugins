// src/art-trace/gen/comfyui.ts
//
// ComfyUI 的识别与归一化。
//
// ============================================================
// 为什么 ComfyUI 必须比别的生成器多花十倍的代码
// ============================================================
//
// 别的生成器写进图片的是一行参数（A1111 的 `parameters`），ComfyUI 写进去的是**两张
// 图**：
//
//   tEXt(prompt)    API 格式。`{"3": {"inputs": {...}, "class_type": "KSampler"}}`
//   tEXt(workflow)  UI 格式。`{"nodes": [...], "links": [...]}`
//
// 这两张图的信息量完全不同，用途也不同：
//
// * **`prompt` 才是"真正跑了什么"的权威来源。** 它是发往 /prompt 接口的那份请求，
//   只有**实际执行**的节点才会出现在里面。UI 图里被 Ctrl+B 旁路的节点、被删掉又
//   撤销的节点、以及那些只是摆在画布上没连线的节点，**都不在** `prompt` 里。
//   因此所有参数（steps / cfg / 正负提示词 / 模型 / LoRA）只从 `prompt` 取。
//
// * `workflow` 是画布快照。它比 `prompt` 多的是**图结构**：节点标题、旁路状态、
//   widget 的原始顺序、连线。它比 `prompt` 少的是"这一版到底连了什么"—— 因为
//   用户可能改了画布但没重新生成（于是图片里的 `workflow` 与 `prompt` 不一致）。
//
// 两者都读，但**判定参数一律以 `prompt` 为准，`workflow` 只用来补充结构**。把这条
// 搞反（例如从 UI 图里读 widgets_values 去猜 steps），遇到"改了没跑"的画布就会报出
// 一组根本没用于这张图的参数。
//
// ============================================================
// 正负提示词为什么必须遍历图，而不能"取第一个 CLIPTextEncode"
// ============================================================
//
// "第一个 CLIPTextEncode 是正向、第二个是负向"是一条**看起来总对、实际经常错**的
// 启发式：
//
// * 一个图里通常有 4 个以上的文本编码节点（SDXL 的正负各两个、refiner 一套、
//   ControlNet 的提示词、IPAdapter 的提示词）。按出现顺序取，很容易把负向当正向。
// * 两段式采样（先低步出草稿、再高步重绘）会有两组正负，取错了报出的是废弃的那组。
// * 节点的 JSON 键序就是字典序（`"10"` 在 `"7"` 前面），"第一个"甚至不表示"最早建的"。
//
// 唯一可靠的办法是**从主采样器的 `positive` / `negative` 输入出发沿链接向上游走**：
// 采样器接的到底是哪一条链，是图自己说的。这个文件里的 `resolveConditioning` 就是
// 这件事的全部实现，它也是这个模块里最值得读的一段。

import type {
  ComfyNode,
  ComfyWorkflow,
  GenParams,
} from '../model/types';
import type { TextBlock } from './blocks';
import {
  asNumber,
  asString,
  isRecord,
  parseJsonRecord,
  pick,
  pushExtra,
  readPath,
} from './blocks';

/**
 * 读一个节点输入，返回字符串形式（或 null）。
 *
 * 只认 `inputs`：API 格式里所有可调参数都在 `inputs` 下，`_meta` 只有标题。
 * 但真实图里见过把 `seed` 放在节点顶层的（手工拼的 JSON），因此兜底也看一眼顶层 ——
 * 多看一眼的代价为零，而漏掉 seed 会让"复现这张图"直接不可能。
 */
export function readDynamic(node: ComfyApiNode, names: string[]): string | null {
  const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
  const fromInputs = asString(pick(inputs, names));
  if (fromInputs !== null) return fromInputs;
  return asString(pick(node.raw, names));
}

/**
 * 一个节点的 JSON。ComfyUI 的 API 格式里每个节点是 `{inputs, class_type, _meta}`，
 * 但真实文件里有 `inputs` 缺失、`class_type` 是 null、节点值是字符串等等畸形情况，
 * 因此这里一律按"可能什么都没有"来读。
 */
export interface ComfyApiNode {
  id: string;
  classType: string;
  title: string;
  raw: Record<string, unknown>;
}

/** 把 `prompt` 的原文解析成节点表。**解析失败返回空表**，由调用方决定怎么退化。 */
export function parseApiNodes(text: string): ComfyApiNode[] {
  const root = parseJsonRecord(text);
  if (!root) return [];
  const out: ComfyApiNode[] = [];
  for (const [id, value] of Object.entries(root)) {
    if (!isRecord(value)) continue;
    if (value['class_type'] === undefined && value['inputs'] === undefined) continue;
    out.push({
      id,
      classType: asString(value['class_type']) ?? '',
      title: readPath(value, ['_meta', 'title']) ?? '',
      raw: value,
    });
  }
  return out;
}

/** 按节点 id 比较。数字 id 按数值（`"9" < "10"`），非数字按字典序排在其后。 */
export function compareNodeId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const fa = Number.isFinite(na);
  const fb = Number.isFinite(nb);
  if (fa && fb && na !== nb) return na - nb;
  if (fa !== fb) return fa ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 主采样器之外的那些采样器，压缩成一行，放进 `extras`。 */
function describeSampler(node: ComfyApiNode): string {
  const steps = readDynamic(node, ['steps']);
  const cfg = readDynamic(node, ['cfg']);
  const seed = readDynamic(node, ['seed', 'noise_seed']);
  const denoise = readDynamic(node, ['denoise']);
  const parts: string[] = [];
  if (steps !== null) parts.push(`${steps} 步`);
  if (cfg !== null) parts.push(`cfg ${cfg}`);
  if (seed !== null) parts.push(`seed ${seed}`);
  if (denoise !== null) parts.push(`denoise ${denoise}`);
  const label = `${node.classType} #${node.id}`;
  return parts.length > 0 ? `${label}: ${parts.join(' / ')}` : label;
}

// ============================================================
// 采样器的选择
// ============================================================

/** 哪些 class_type 算采样器。含 `Sampler` 的第三方节点（Efficient、Inspire、Ultimate…）都算。 */
function isSamplerClass(classType: string): boolean {
  const lower = classType.toLowerCase();
  if (!lower.includes('sampler')) return false;
  // 这些虽然名字里带 Sampler，却不是"跑一遍去噪"的节点：
  // SamplerCustom 是容器（自身可能没有 steps），SamplerCustomAdvanced 才是真正的采样器；
  // 而 `KSamplerSelect` 只是给 SamplerCustom 挑采样算法的一个下拉框。
  if (lower === 'ksamplerselect' || lower === 'samplerselect') return false;
  return true;
}

/** 从任意输入值里取"上游节点 id"。值应当是 `["<nodeId>", <outputIndex>]`。 */
function upstreamIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const head = raw[0];
  if (typeof head === 'string') return [head];
  if (typeof head === 'number' && Number.isFinite(head)) return [String(head)];
  return [];
}

/**
 * 挑出主采样器。
 *
 * 优先级是三级，每一级都对应一种真实图：
 *
 * 1. **嵌在核心节点里的那一个**（`SamplerCustomAdvanced` 用于 Inspire 包的两段式采样，
 *    而用户真正的 steps/cfg 在上游的 `KSampler` 里）。这种情况下"更靠下游"是错的，
 *    因为下游那个根本没有参数。
 * 2. **不被任何其它采样器消费的那一个**。两段式放大（低步出草稿 → 高清重绘）里两个
 *    采样器都带完整参数，第一个的输出是第二个的 `latent_image`；最终存盘的是第二个。
 *    判据就是"它的输出没有流向别的采样器"。
 * 3. 兜底：**id 最大者**（id 通常是自增的，所以"最晚加的"≈"最终那一步"）。
 *
 * 之所以要做成三级而不是简单取 id 最大者：真实图里 id 顺序与执行顺序**并不总是一致**
 * （用户会复制粘贴节点、会重排），只按 id 取会在"重绘采样器 id 更小"的图上取错，
 * 而取错的后果是 steps/cfg 报的是废弃的那组 —— 这正是这个模块最不能犯的错。
 */
export function pickMainSampler(nodes: ComfyApiNode[]): ComfyApiNode | null {
  const samplers = nodes.filter((node) => isSamplerClass(node.classType));
  if (samplers.length === 0) return null;
  if (samplers.length === 1) return samplers[0]!;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const consumed = new Set<string>();
  for (const node of nodes) {
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
    for (const value of Object.values(inputs)) {
      for (const upstream of upstreamIds(value)) {
        if (byId.has(upstream)) consumed.add(upstream);
      }
    }
  }

  const candidates = samplers.filter((sampler) => !consumed.has(sampler.id));
  const pool = candidates.length > 0 ? candidates : samplers;

  const nested = pool.find(
    (node) => isRecord(node.raw['_meta']) && node.raw['_meta']['nested'] !== undefined
  );
  if (nested) return nested;

  // id 最大者。`compareNodeId` 保证 `"10" > "9"` —— 用字符串比较会反过来。
  return pool.slice().sort((a, b) => compareNodeId(b.id, a.id))[0] ?? null;
}

// ============================================================
// 正负提示词的遍历
// ============================================================

interface ResolveResult {
  texts: string[];
  /** 走过了哪些节点类型，写进 evidence 用 —— 用户要能看懂"你凭什么说这是正向" */
  trace: string[];
  /** 是否退化成"收集全部 CLIPTextEncode" */
  degraded: boolean;
  /** 遇到环 */
  cyclic: boolean;
}

/**
 * 这些节点是纯粹的"透传/组合"容器：必须继续往上走，否则漏掉真实文本。
 *
 * **判据的顺序在这里就是正确性本身。** 这两个函数都用"class_type 里含某个子串"来
 * 分类，而 `ControlNetApply` 是 `ControlNetApplyAdvanced` 的前缀 —— 先判前者，
 * 高级版就会去读一个**不存在的 `conditioning` 输入**，读不到就返回空数组，
 * 于是整条正向链路在这里断掉。
 *
 * 实测过一次：`ControlNetApplyAdvanced` 挂掉之后，遍历拿不到任何文本，代码退化成
 * "收集全部 CLIPTextEncode" —— 结果**看起来是对的**（提示词都在），只是负向被拼进了
 * 正向、#13 那一支被重复算了一次。这种"结果正确、过程错误"的 bug 不会有人报，
 * 因此这里特意用 `describeConditioningNode` 把它测出来（见 staging 的探针脚本）。
 */
function conditioningInputNames(classType: string): string[] | null {
  const lower = classType.toLowerCase();
  if (lower.includes('conditioningzeroout')) return []; // 明确表示"这里没有条件"
  // 更长的名字必须排在更短的前缀前面（applyadvanced / applysd3 都含 apply）。
  if (lower.includes('controlnetapplyadvanced') || lower.includes('controlnetapplysd3')) {
    return ['positive', 'negative'];
  }
  if (lower.includes('controlnetapply')) return ['conditioning'];
  if (lower.includes('conditioningcombine')) return ['conditioning_1', 'conditioning_2'];
  if (lower.includes('conditioningconcat')) return ['conditioning_to', 'conditioning_from'];
  if (lower.includes('conditioningsetarea')) return ['conditioning'];
  if (lower.includes('conditioningsettimesteprange')) return ['conditioning'];
  if (lower.includes('conditioningsetstrength')) return ['conditioning'];
  if (lower.includes('conditioningaverage')) return ['conditioning_to', 'conditioning_from'];
  if (lower.includes('reroute')) return ['*first*'];
  if (lower.includes('conditioning')) return ['conditioning'];
  return null;
}

/** 导出给验收探针用：确认"某个 class_type 会被当成什么"。 */
export function describeConditioningNode(classType: string): {
  textEncode: string[] | null;
  passThrough: string[] | null;
} {
  return {
    textEncode: textEncodeKeys(classType),
    passThrough: conditioningInputNames(classType),
  };
}

/** 文本编码节点：`text` / SDXL 的 `text_g`+`text_l` / Flux 的 `text` / 一些第三方包。 */
function textEncodeKeys(classType: string): string[] | null {
  const lower = classType.toLowerCase();
  // 只认真正的文本编码器。宽度放宽到 `textencode` 是为了第三方包（`BNK_CLIPTextEncodeAdvanced`、
  // `smZ CLIPTextEncode`、`TextEncodeQwenImageEdit`…），而**不能**放宽到"含 text 就算"：
  // `ControlNetApplyAdvanced` 里就含 `text`，把它当成文本编码器会让透传分支永远走不到。
  const isText =
    lower.includes('cliptextencode') ||
    lower.includes('textencode') ||
    lower.includes('text_encode') ||
    lower === 'promptexpander' ||
    lower.includes('promptstyler') ||
    lower.includes('sag_text');
  if (!isText) return null;
  // SDXL / Flux 的文本编码器有两个文本输入（`text_g` 全局 + `text_l` 局部）。
  if (lower.includes('sdxl')) return ['text_g', 'text_l'];
  return ['text'];
}

/**
 * 从 `conditioning` 出发收集文本。
 *
 * **必须带分支走（`branch`）。** `ControlNetApplyAdvanced` 同时有 `positive` 与
 * `negative` 两个输入，而它们常常指向同一个对象（采样器的正负两条链都经过它）。
 * 不分正负地"把所有输入都走一遍"，会把负向提示词拼进正向里 —— 实测过：
 * `prompt` 变成 `"pos part A\npos part B\nneg base\npos part C"`。
 * 这比"漏一段"更坏，因为它**看起来像真的**（读者只会以为作者把负向也写进了正向）。
 * 因此凡是能确定正负的节点（`positive`/`negative` 输入名），只走与当前分支一致的那个。
 *
 * `visited` 是**路径级**的（进入时加、退出时删），不是全局的：菱形图里同一个文本节点被
 * 两条链路引用是常见的（正负共用一个 style 编码），全局 visited 会让第二次引用被当成
 * 环而丢掉，于是正向提示词凭空少一半。真正的环（`A→B→A`）靠"当前路径上已经有它"来断。
 */
function walkConditioning(
  nodeId: string,
  byId: Map<string, ComfyApiNode>,
  visited: Set<string>,
  trace: Set<string>,
  guard: { cyclic: boolean },
  branch: 'positive' | 'negative'
): string[] {
  if (visited.has(nodeId)) {
    guard.cyclic = true;
    return [];
  }
  const node = byId.get(nodeId);
  if (!node) return [];
  visited.add(nodeId);
  const out: string[] = [];

  const encodeKeys = textEncodeKeys(node.classType);
  if (encodeKeys) {
    trace.add(node.classType);
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
    for (const key of encodeKeys) {
      const value = inputs[key];
      if (typeof value === 'string' && value.trim().length > 0) out.push(value);
      else if (Array.isArray(value)) {
        // 极少见：text 被接成了一个上游节点（字符串拼接类）。继续走，别丢。
        for (const upstream of upstreamIds(value)) {
          out.push(...walkConditioning(upstream, byId, visited, trace, guard, branch));
        }
      }
    }
    visited.delete(nodeId);
    return out;
  }

  const passThrough = conditioningInputNames(node.classType);
  trace.add(node.classType);
  if (passThrough !== null) {
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
    if (passThrough.length === 1 && passThrough[0] === '*first*') {
      // Reroute 的输入名不固定（有些版本叫 `input`，有些叫别的），取第一个是链接的值。
      for (const value of Object.values(inputs)) {
        for (const upstream of upstreamIds(value)) {
          out.push(...walkConditioning(upstream, byId, visited, trace, guard, branch));
        }
        if (out.length > 0) break;
      }
    } else {
      for (const key of passThrough) {
        // 能确定正负的输入只走当前分支那一个（见上面的说明）。
        if (/^positive$/i.test(key) && branch !== 'positive') continue;
        if (/^negative$/i.test(key) && branch !== 'negative') continue;
        for (const upstream of upstreamIds(inputs[key])) {
          out.push(...walkConditioning(upstream, byId, visited, trace, guard, branch));
        }
      }
    }
    visited.delete(nodeId);
    return out;
  }

  // 认不出的节点：**不要停下**，把所有链接输入都当成可能的 conditioning 继续走。
  // 停下会让第三方包的透传节点（`ImpactConditioningSetDetail` 之类）把提示词整段吞掉，
  // 表现成"这张图没有提示词"，比多走几步的代价大得多。
  //
  // 但顺序有讲究：先走**按名字就能确定是条件**的输入（`conditioning*` / `positive`），
  // 走不到再退化成"所有链接输入"。纯按对象顺序走会先撞上 `control_net` 这类输入，
  // 把 ControlNet 的加载器整条子树也扫一遍 —— 结果一样，代价是白扫一遍上千个节点。
  // 认不出的节点不排除 positive/negative 里的另一支：它也可能是个"正负同源"的
  // 整流节点，宁可多收也不要漏掉整段提示词。
  const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
  const preferred = Object.keys(inputs).filter((name) =>
    /^(conditioning|positive|negative)/i.test(name)
  );
  const rest = Object.keys(inputs).filter((name) => !preferred.includes(name));
  for (const key of [...preferred, ...rest]) {
    for (const upstream of upstreamIds(inputs[key])) {
      out.push(...walkConditioning(upstream, byId, visited, trace, guard, branch));
    }
  }
  visited.delete(nodeId);
  return out;
}

/** 所有 `CLIPTextEncode` 按 id 升序。这是遍历失败时的退化路径。 */
function collectAllTexts(nodes: ComfyApiNode[]): string[] {
  const out: string[] = [];
  const ordered = nodes.slice().sort((a, b) => compareNodeId(a.id, b.id));
  for (const node of ordered) {
    if (!textEncodeKeys(node.classType)) continue;
    const text = readDynamic(node, ['text', 'text_g', 'text_l']);
    if (text !== null && text.trim().length > 0) out.push(text);
  }
  return out;
}

function resolveConditioning(
  sampler: ComfyApiNode | null,
  byId: Map<string, ComfyApiNode>,
  nodes: ComfyApiNode[],
  key: 'positive' | 'negative'
): ResolveResult {
  const trace = new Set<string>();
  const guard = { cyclic: false };
  const texts: string[] = [];
  if (sampler) {
    const inputs = isRecord(sampler.raw['inputs']) ? sampler.raw['inputs'] : {};
    for (const upstream of upstreamIds(inputs[key])) {
      texts.push(...walkConditioning(upstream, byId, new Set<string>(), trace, guard, key));
    }
  }
  if (texts.length > 0) {
    return { texts, trace: [...trace], degraded: false, cyclic: guard.cyclic };
  }
  return {
    texts: collectAllTexts(nodes),
    trace: [...trace],
    degraded: true,
    cyclic: guard.cyclic,
  };
}

// ============================================================
// 模型链
// ============================================================

interface AssetWalk {
  /** 从采样器往上游走的顺序（采样器一侧在前） */
  items: string[];
  checkpoints: string[];
  loras: string[];
  vae: string | null;
  clipSkip: number | null;
  trace: string[];
}

function walkModelChain(
  sampler: ComfyApiNode | null,
  byId: Map<string, ComfyApiNode>
): AssetWalk {
  const items: string[] = [];
  const checkpoints: string[] = [];
  const loras: string[] = [];
  const trace = new Set<string>();
  const seen = new Set<string>();
  let vae: string | null = null;
  let clipSkip: number | null = null;

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    trace.add(node.classType);
    const lower = node.classType.toLowerCase();
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};

    if (lower.includes('checkpointloader')) {
      const name = readDynamic(node, ['ckpt_name']);
      if (name !== null) {
        items.push(name);
        checkpoints.push(name);
      }
      // CheckpointLoaderSimple 的 `vae` 是 OUTPUT（不是输入）：它把 ckpt 内置的 VAE
      // 直接暴露成一个输出口。它**不是**文件名，没有 `VAELoader` 时 vae 只能是 null。
    } else if (lower.includes('unetloader') || lower.includes('diffusionloader') || lower.includes('diffusionmodelloader')) {
      const name = readDynamic(node, ['unet_name', 'model_name', 'diffusion_model']);
      if (name !== null) {
        items.push(name);
        checkpoints.push(name);
      }
    } else if (lower.includes('loraloader') || lower.includes('loratagloader') || lower.includes('lora')) {
      // 这个分支故意排除了 `vaeloader` / `clipsetlastlayer`（它们都在下面单独判），
      // 而且以 `lora_name` 是否存在为准 —— 名字里含 lora 但没有 `lora_name` 的节点
      // （`LoraTagLoader` 的某些变体、纯开关节点）不该被当成加载器报一个空名字。
      const name = readDynamic(node, ['lora_name']);
      if (name !== null) {
        const strengthModel = readDynamic(node, ['strength_model']);
        const strengthClip = readDynamic(node, ['strength_clip']);
        const detail =
          strengthModel !== null || strengthClip !== null
            ? ` (model ${strengthModel ?? '1'} / clip ${strengthClip ?? strengthModel ?? '1'})`
            : '';
        items.push(`LoRA ${name}${detail}`);
        loras.push(`${name}${detail}`);
      }
    } else if (lower.includes('vaeloader')) {
      const name = readDynamic(node, ['vae_name']);
      if (name !== null && vae === null) vae = name;
    } else if (lower.includes('clipsetlastlayer') || lower.includes('cliplastlayer')) {
      const value = readDynamic(node, ['stop_at_clip_layer']);
      const num = asNumber(value);
      if (num !== null) clipSkip = Math.abs(num);
    }

    // 继续往上走。只走 `model*` 类输入，避免从 ConditioningSetArea 的 model 口拐进
    // 提示词链（那会把 CLIPTextEncode 也算进模型链）。
    for (const [name, value] of Object.entries(inputs)) {
      if (!name.startsWith('model')) continue;
      for (const upstream of upstreamIds(value)) visit(upstream);
    }
  };

  if (sampler) {
    const inputs = isRecord(sampler.raw['inputs']) ? sampler.raw['inputs'] : {};
    for (const upstream of upstreamIds(inputs['model'])) visit(upstream);
  }

  // 遍历是从采样器往上游走的，收下来的顺序天然是"离采样器近的在前"（LoRA #78 在
  // 底座模型 #76 前面）。界面上要的是**加载顺序**：checkpoint → LoRA#77 → LoRA#78 →
  // 采样器。因此整体反转。反转而不是在每一处 push 到头部：链是发散的（一个 LoRA
  // 可以被两个分支引用），逐点插头部会把顺序搅乱，而反转是稳定且可解释的。
  return {
    items: items.reverse(),
    checkpoints: checkpoints.reverse(),
    loras: loras.reverse(),
    vae,
    clipSkip,
    trace: [...trace],
  };
}

/** 从整张图里找 VAE（`VAELoader` 优先），以及 clip skip。链上找不到时的兜底。 */
function scanForVaeAndClipSkip(nodes: ComfyApiNode[]): { vae: string | null; clipSkip: number | null } {
  let vae: string | null = null;
  let clipSkip: number | null = null;
  const ordered = nodes.slice().sort((a, b) => compareNodeId(a.id, b.id));
  for (const node of ordered) {
    const lower = node.classType.toLowerCase();
    if (lower.includes('vaeloader') && vae === null) {
      vae = readDynamic(node, ['vae_name']);
    }
    if ((lower.includes('clipsetlastlayer') || lower.includes('cliplastlayer')) && clipSkip === null) {
      const num = asNumber(readDynamic(node, ['stop_at_clip_layer']));
      if (num !== null) clipSkip = Math.abs(num);
    }
  }
  return { vae, clipSkip };
}

// ============================================================
// 尺寸 / ControlNet / extras
// ============================================================

const LATENT_SIZE_CLASSES = [
  'emptylatentimage',
  'emptysd3latentimage',
  'emptylatentimagecustom',
  'emptylatentimage_',
  'emptysdxllatentimage',
  'emptyfluxlatentimage',
  'latentfrombatch',
];

function isLatentSizeNode(classType: string): boolean {
  const lower = classType.toLowerCase();
  return (
    LATENT_SIZE_CLASSES.some((name) => lower.includes(name)) ||
    (lower.includes('latent') && lower.includes('empty'))
  );
}

/** 常见潜在放大节点的倍率，用来把"基础分辨率"换算成"实际出图分辨率"。 */
function findLatentScale(node: ComfyApiNode): number | null {
  return asNumber(readDynamic(node, ['scale_by', 'scale']));
}

/**
 * 找**参与生成的那个**潜在图尺寸。
 *
 * 不能"取第一个有 width/height 的 latent 节点"：一个图里放三个 `EmptyLatentImage`
 * （1024×1344 的竖图、1536×1024 的横图、一个备用的）是常见做法，其中只有**接在主
 * 采样器 `latent_image` 上的那个**真正决定了这张图。实测的 `糯米_00001_.png` 就是
 * 这个形状：`#87` 是 1024×1536 但挂在另一个采样器上，主采样器 #29 用的是
 * `#28 ← #5`（1024×1344）。按 id 升序取会报出 1536 —— 一个**没有用于这张图**的尺寸，
 * 而尺寸是用户对照"我设的是多少"的第一个数字。
 *
 * 做法：从主采样器的 `latent_image` 往上游走，第一个带 width/height 的 latent 节点
 * 就是基础尺寸；路上的潜在放大节点把倍率记下来（`#28 LatentUpscaleBy 1.55`）。
 * 走不到时退化成"整张图里 id 最小的那个 latent 节点"，并在信息里说不确定。
 */
function findLatentSize(
  sampler: ComfyApiNode | null,
  byId: Map<string, ComfyApiNode>,
  nodes: ComfyApiNode[]
): { width: number | null; height: number | null; scales: number[]; fromChain: boolean } {
  const scales: number[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  if (sampler) {
    const inputs = isRecord(sampler.raw['inputs']) ? sampler.raw['inputs'] : {};
    // 只从潜在图那一侧走。跟着 `positive` 走会拐进提示词链，那边没有尺寸节点。
    for (const upstream of upstreamIds(inputs['latent_image'] ?? inputs['samples'] ?? inputs['latent'])) {
      queue.push(upstream);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (isLatentSizeNode(node.classType)) {
      const width = asNumber(readDynamic(node, ['width']));
      const height = asNumber(readDynamic(node, ['height']));
      if (width !== null || height !== null) {
        return { width, height, scales, fromChain: true };
      }
    }
    const scale = findLatentScale(node);
    if (scale !== null) scales.push(scale);
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
    for (const [name, value] of Object.entries(inputs)) {
      // 只继续走潜在图/样本类的输入名，避免顺着 model 或 conditioning 拐远。
      if (!/latent|samples|image/i.test(name)) continue;
      for (const upstream of upstreamIds(value)) queue.push(upstream);
    }
  }

  // 退化路径：图里任何一个 latent 尺寸节点，按 id 升序取第一个。
  // 顺序用数值比较，`"9"` 要排在 `"10"` 前面。
  const ordered = nodes.slice().sort((a, b) => compareNodeId(a.id, b.id));
  for (const node of ordered) {
    if (!isLatentSizeNode(node.classType)) continue;
    const width = asNumber(readDynamic(node, ['width']));
    const height = asNumber(readDynamic(node, ['height']));
    if (width !== null || height !== null) {
      return { width, height, scales, fromChain: false };
    }
  }
  return { width: null, height: null, scales, fromChain: false };
}

/** 收集 ControlNet。值可能是文件名（字符串）也可能是链接（数组 → 标出上游节点）。 */
function collectControlNets(
  nodes: ComfyApiNode[],
  byId: Map<string, ComfyApiNode>
): string[] {
  const out: string[] = [];
  const ordered = nodes.slice().sort((a, b) => compareNodeId(a.id, b.id));
  for (const node of ordered) {
    if (!node.classType.toLowerCase().includes('controlnet')) continue;
    const inputs = isRecord(node.raw['inputs']) ? node.raw['inputs'] : {};
    const value = inputs['control_net_name'] ?? inputs['control_net'];
    if (typeof value === 'string' && value.length > 0) {
      out.push(`${value}（${node.classType} #${node.id}）`);
      continue;
    }
    const upstream = upstreamIds(value)[0];
    if (upstream !== undefined) {
      const source = byId.get(upstream);
      const name = source ? `${source.classType} #${source.id}` : `节点 #${upstream}`;
      out.push(`${name} 提供的模型（${node.classType} #${node.id}）`);
      continue;
    }
    out.push(`${node.classType} #${node.id}`);
  }
  return out;
}

/** 从 API 图里摘 extras：放大、细节修复、存盘前缀、尺寸调整节点。 */
function collectExtras(nodes: ComfyApiNode[]): Array<{ key: string; value: string }> {
  const extras: Array<{ key: string; value: string }> = [];
  const ordered = nodes.slice().sort((a, b) => compareNodeId(a.id, b.id));
  for (const node of ordered) {
    const lower = node.classType.toLowerCase();
    if (lower.includes('saveimage')) {
      const prefix = readDynamic(node, ['filename_prefix']);
      if (prefix !== null) pushExtra(extras, 'filename_prefix', prefix);
    }
    if (lower.includes('upscalemodelloader')) {
      const name = readDynamic(node, ['model_name']);
      if (name !== null) pushExtra(extras, '放大模型', name);
    }
    if (lower.includes('imageupscalewithmodel') || lower.includes('upscalemodel') || lower.includes('imagescaleby')) {
      const name = readDynamic(node, ['model_name', 'upscale_model']);
      if (name !== null && !lower.includes('loader')) pushExtra(extras, '放大节点', `${node.classType} #${node.id} → ${name}`);
    }
    if (lower.includes('latentupscale')) {
      const method = readDynamic(node, ['upscale_method']);
      const scale = readDynamic(node, ['scale_by', 'width', 'height']);
      const parts = [method, scale].filter((part): part is string => part !== null);
      if (parts.length > 0) pushExtra(extras, `潜在放大 #${node.id}`, parts.join(' × '));
    }
    if (lower.includes('imagescale') || lower.includes('resize') || lower.includes('imagesize')) {
      const width = readDynamic(node, ['width']);
      const height = readDynamic(node, ['height']);
      if (width !== null || height !== null) {
        pushExtra(extras, `${node.classType} #${node.id}`, `${width ?? '?'}×${height ?? '?'}`);
      }
    }
    if (lower.includes('facedetailer') || lower.includes('detailer') || lower.includes('adetailer')) {
      pushExtra(extras, `细节修复 #${node.id}`, node.classType);
    }
  }
  return extras;
}

// ============================================================
// UI 格式 → ComfyWorkflow
// ============================================================

const NODE_LIMIT = 200;

interface UiGraph {
  nodes: Array<Record<string, unknown>>;
  /** linkId → 上游节点 id / 上游输出槽 / 下游节点 id */
  links: Map<number, { from: string; fromSlot: number; to: string | undefined }>;
}

function parseUiGraph(text: string): UiGraph | null {
  const root = parseJsonRecord(text);
  if (!root) return null;
  const rawNodes = root['nodes'];
  if (!Array.isArray(rawNodes)) return null;
  const nodes = rawNodes.filter(isRecord);
  const links = new Map<number, { from: string; fromSlot: number; to: string | undefined }>();
  const rawLinks = root['links'];
  if (Array.isArray(rawLinks)) {
    for (const link of rawLinks) {
      // 两种形状：老版/新版都是数组 `[id, fromNode, fromSlot, toNode, toSlot, type]`，
      // 而有的序列化器会输出对象。两种都认 —— 只认一种会在另一种上整张图没有连线。
      if (Array.isArray(link)) {
        const id = asNumber(link[0]);
        const from = asString(link[1]);
        const slot = asNumber(link[2]);
        const to = asString(link[3]) ?? undefined;
        if (id !== null && from !== null) links.set(id, { from, fromSlot: slot ?? 0, to });
      } else if (isRecord(link)) {
        const id = asNumber(link['id']);
        const from = asString(link['origin_id']) ?? asString(link['source_id']);
        const slot = asNumber(link['origin_slot']) ?? asNumber(link['source_slot']);
        const to = asString(link['target_id']) ?? asString(link['target']) ?? undefined;
        if (id !== null && from !== null) links.set(id, { from, fromSlot: slot ?? 0, to });
      }
    }
  }
  return { nodes, links };
}

function widgetValueText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 由 UI 格式构造节点表。
 *
 * `widgets_values` 是一个**没有名字的数组**，元素顺序取决于节点的定义。因此这里
 * 刻意**不去猜**"第 0 个是 seed、第 1 个是 steps"—— 猜错的话界面会信誓旦旦地显示
 * 一个错误的参数。名字用 `widgets_values[i]` 如实标出，值原样给出，让人自己对照。
 */
function buildNodes(
  graph: UiGraph,
  apiByTitle: Map<string, ComfyApiNode>
): { nodes: ComfyNode[]; truncated: number } {
  // 上游 → 下游节点 id 列表。同一个上游对同一个下游只记一次：一个节点有多个输出槽
  // 分别接到同一个下游是常见的，重复列出会让人以为画布上有多根线。
  const downstream = new Map<string, string[]>();
  const nodeIdOf = (raw: Record<string, unknown>): string => {
    const value = raw['id'];
    return typeof value === 'number' ? String(value) : asString(value) ?? '';
  };

  for (const raw of graph.nodes) {
    const from = nodeIdOf(raw);
    const rawOutputs = raw['outputs'];
    if (!Array.isArray(rawOutputs)) continue;
    for (const output of rawOutputs) {
      if (!isRecord(output)) continue;
      const links = output['links'];
      // `links` 经常是 `null`（一个输出口没有任何连线）。`Array.isArray(null)` 是
      // false，但如果不显式判空，这里会走进 `for...of null` 直接抛 —— 而这一抛会被
      // 入口的 try/catch 吞掉，表现成"这张图认不出生成器"，极难定位。
      if (!Array.isArray(links)) continue;
      for (const linkId of links) {
        const link = asNumber(linkId);
        if (link === null) continue;
        const record = graph.links.get(link);
        const target = record?.to;
        if (target === undefined) continue;
        const list = downstream.get(from);
        if (!list) downstream.set(from, [target]);
        else if (!list.includes(target)) list.push(target);
      }
    }
  }

  const nodes: ComfyNode[] = [];
  const limited = graph.nodes.slice(0, NODE_LIMIT);
  const truncated = Math.max(0, graph.nodes.length - limited.length);

  for (const raw of limited) {
    const id = nodeIdOf(raw);
    const type = asString(raw['type']) ?? '未知节点';
    const mode = asNumber(raw['mode']) ?? 0;
    const uiTitle = asString(raw['title']);
    const baseTitle = uiTitle !== null && uiTitle.length > 0 ? uiTitle : type;
    // mode 4 = BYPASS、mode 2 = NEVER。这两种节点**没有参与生成**，因此标题上必须
    // 标出来：用户看到 "UltimateSDUpscale" 会以为图被放大过，而它其实被旁路了；
    // 看到 LoRA 加载器也会以为那张 LoRA 生效了。这是最容易让人误判"这张图用了什么"
    // 的一处细节，所以标在标题上而不是塞进 inputs。
    const suffix = mode === 4 ? '（已旁路）' : mode === 2 ? '（从不执行）' : '';
    const title = `${baseTitle}${suffix}`;

    const inputs: ComfyNode['inputs'] = [];
    const widgets = raw['widgets_values'];
    if (Array.isArray(widgets)) {
      // **不猜映射**：widgets_values 的元素顺序取决于节点定义，这里没有名字可依据。
      // 猜错会得到一个看起来很确定的错误参数，比"列出来让人自己看"坏得多。
      for (let i = 0; i < widgets.length; i++) {
        inputs.push({ name: `widgets_values[${i}]`, value: widgetValueText(widgets[i]), from: null });
      }
    } else if (widgets !== undefined && widgets !== null) {
      inputs.push({ name: 'widgets_values', value: widgetValueText(widgets), from: null });
    }

    const rawInputs = raw['inputs'];
    if (Array.isArray(rawInputs)) {
      for (const input of rawInputs) {
        if (!isRecord(input)) continue;
        const name = asString(input['name']) ?? 'input';
        const linkId = asNumber(input['link']);
        const link = linkId !== null ? graph.links.get(linkId) : undefined;
        inputs.push({
          name,
          value: link ? `← 节点 #${link.from}[${link.fromSlot}]` : '（未连接）',
          from: link ? link.from : null,
        });
      }
    }

    // API 侧 `_meta.title` 是用户在节点上改过的名字。它只出现在 prompt 里，
    // UI 旧版没有它 —— 标题是空的就补一个，界面上至少能看出这是什么节点。
    const apiTitle = apiByTitle.get(type)?.title;
    // `asString` 的返回值是 `string | null`，因此这里必须先判 null 再取 length：
    // `uiTitle.length` 在 `uiTitle === null` 时会抛，而这条抛错会被入口吞掉。
    const hasUiTitle = uiTitle !== null && uiTitle.length > 0;
    if (!hasUiTitle && apiTitle !== null && apiTitle !== undefined && apiTitle.length > 0) {
      inputs.push({ name: '_meta.title', value: `${apiTitle}${suffix}`, from: null });
    }

    nodes.push({ id, type, title, inputs, outputs: downstream.get(id) ?? [] });
  }

  if (truncated > 0 && nodes.length > 0) {
    const last = nodes[nodes.length - 1]!;
    last.inputs.push({
      name: 'truncated',
      value: `工作流共 ${graph.nodes.length} 个节点，这里只保留前 ${NODE_LIMIT} 个（其余 ${truncated} 个已省略）`,
      from: null,
    });
  }

  return { nodes, truncated };
}

/** 图里节点类型 → API 节点，用来在 UI 节点标题缺失时补一个（标题可能只在 API 侧有）。 */
function indexApiByTitle(nodes: ComfyApiNode[]): Map<string, ComfyApiNode> {
  const map = new Map<string, ComfyApiNode>();
  for (const node of nodes) {
    if (!map.has(node.classType)) map.set(node.classType, node);
  }
  return map;
}

/** 摘 6~12 条人最想看的。条数越少越要挑：steps/cfg/sampler/seed 是前四条。 */
function buildHighlights(
  params: {
    mainSampler: ComfyApiNode | null;
    model: string | null;
    loras: string[];
    vae: string | null;
    clipSkip: number | null;
    prompt: string | null;
    negativePrompt: string | null;
    width: number | null;
    height: number | null;
  },
  extras: Array<{ key: string; value: string }>,
  uiNodeCount: number
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const sampler = params.mainSampler;
  const add = (label: string, value: string | null): void => {
    if (out.length >= 12) return;
    if (value === null || value === '') return;
    out.push({ label, value });
  };

  if (sampler) {
    add('采样器', sampler.classType);
    add('步数', readDynamic(sampler, ['steps']));
    add('CFG', readDynamic(sampler, ['cfg']));
    add('采样算法', readDynamic(sampler, ['sampler_name']));
    add('调度器', readDynamic(sampler, ['scheduler']));
    add('种子', readDynamic(sampler, ['seed', 'noise_seed']));
    add('降噪', readDynamic(sampler, ['denoise']));
  }
  add('模型', params.model);
  if (params.loras.length > 0) add('LoRA', params.loras.join('、'));
  add('VAE', params.vae);
  if (params.clipSkip !== null) add('CLIP skip', String(params.clipSkip));
  if (params.width !== null || params.height !== null) {
    add('尺寸', `${params.width ?? '?'}×${params.height ?? '?'}`);
  }
  if (uiNodeCount > 0) add('节点数', String(uiNodeCount));
  if (sampler === null) {
    add('提示', '图里没有找到采样器节点，参数可能不完整');
  }

  // 提示词长度放在最后：它在 6~12 条里属于"锦上添花"，而参数类是必须先显示的。
  if (out.length < 12 && (params.prompt || params.negativePrompt)) {
    add(
      '提示词长度',
      `正向 ${(params.prompt ?? '').length} 字 / 负向 ${(params.negativePrompt ?? '').length} 字`
    );
  }

  // 放大节点是对"这张图到底多大"影响最大的一条，参数都齐了就补上。
  const upscale = extras.find(
    (extra) => extra.key.includes('放大') || extra.key.includes('潜在放大')
  );
  if (out.length < 12 && upscale) add(upscale.key, upscale.value);

  // 一条都没有（例如只有 workflow 没有 prompt）时也要给出非空的 value，
  // 否则界面会显示一行空白，看起来像坏了。
  if (out.length === 0) {
    out.push({ label: '说明', value: '这张图的 ComfyUI 元数据里没有可提取的参数' });
  }
  return out.slice(0, 12);
}

// ============================================================
// 入口
// ============================================================

/** 认不认得出这是 ComfyUI。返回判定依据 + 两个文本块的原文。 */
export function matchComfyUI(
  blocks: TextBlock[]
): { evidence: string; promptText: string | null; workflowText: string | null } | null {
  const promptBlock = blocks.find((block) => block.keyword === 'prompt' && block.text.includes('class_type'));
  const workflowBlock = blocks.find(
    (block) => block.keyword === 'workflow' && block.text.includes('nodes')
  );

  // 有一块就够。两块都有时把两块都写进依据 —— 用户看到"API 图 + UI 图"就知道
  // 图结构与实际执行都在，而只有一块时也能一眼看出缺了哪块。
  if (!promptBlock && !workflowBlock) return null;

  const reasons: string[] = [];
  if (promptBlock) {
    const parsed = parseJsonRecord(promptBlock.text);
    const count = parsed ? Object.keys(parsed).length : 0;
    reasons.push(
      `tEXt(prompt) 是 API 格式图（含 class_type 与 _meta.title，共 ${count} 个节点）`
    );
  }
  if (workflowBlock) {
    const graph = parseUiGraph(workflowBlock.text);
    reasons.push(
      `tEXt(workflow) 是 UI 格式图（含 nodes/links，共 ${graph ? graph.nodes.length : 0} 个节点）`
    );
  }
  if (!promptBlock) {
    reasons.push('没有 tEXt(prompt)：只能读图结构，实际执行的参数可能来自另一次运行');
  }

  return {
    evidence: reasons.join('；'),
    promptText: promptBlock ? promptBlock.text : null,
    workflowText: workflowBlock ? workflowBlock.text : null,
  };
}

/** 从 ComfyUI 证据构造归一化参数。`raw` 优先放 `prompt`。 */
export function parseComfyUI(
  evidence: string,
  promptText: string | null,
  workflowText: string | null
): GenParams {
  const nodes = promptText ? parseApiNodes(promptText) : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sampler = pickMainSampler(nodes);

  const positive = resolveConditioning(sampler, byId, nodes, 'positive');
  const negative = resolveConditioning(sampler, byId, nodes, 'negative');
  const chain = walkModelChain(sampler, byId);
  const scanned = scanForVaeAndClipSkip(nodes);
  const size = findLatentSize(sampler, byId, nodes);

  const extras: Array<{ key: string; value: string }> = [];
  if (sampler) {
    for (const node of nodes) {
      if (!isSamplerClass(node.classType)) continue;
      if (node.id === sampler.id) continue;
      // 其余采样器是"这张图还跑过什么"的关键：两段式放大的第二段参数就在这里，
      // 丢掉它会让用户以为图只有一次采样。
      pushExtra(extras, '其它采样器', describeSampler(node));
    }
  }
  for (const extra of collectExtras(nodes)) pushExtra(extras, extra.key, extra.value);

  // `prompt` 里没有 VAE / clip skip 时，从整张图扫一遍。这两者经常挂在采样器链之外
  // （VAELoader 直接接 VAEDecode），只走模型链会漏。
  const vae = chain.vae ?? scanned.vae;
  const clipSkip = chain.clipSkip ?? scanned.clipSkip;

  const joinTexts = (result: ResolveResult): string | null => {
    const cleaned = result.texts.map((text) => text.trim()).filter((text) => text.length > 0);
    return cleaned.length > 0 ? cleaned.join('\n') : null;
  };

  const prompt = joinTexts(positive);
  const negativePrompt = joinTexts(negative);

  const traceNote = (result: ResolveResult, label: string): string | null => {
    if (result.degraded && result.texts.length > 0) {
      return `${label}是退化结果（从采样器出发没有遍历到任何文本，改为收集全部文本编码节点并按节点 id 升序拼接）`;
    }
    if (result.cyclic) {
      return `${label}的链路上存在环，已在环处停止`;
    }
    return null;
  };

  const evidenceParts = [evidence];
  if (sampler) {
    evidenceParts.push(
      `主采样器是 #${sampler.id} ${sampler.classType}（从它的 positive/negative/model 输入出发遍历；"主采样器"= 输出没有被别的采样器消费的那一个，若无法判定则取节点 id 最大者）`
    );
    if (positive.trace.length > 0) {
      evidenceParts.push(`正向链路经过：${[...new Set(positive.trace)].join(' → ')}`);
    }
    if (negative.trace.length > 0) {
      evidenceParts.push(`负向链路经过：${[...new Set(negative.trace)].join(' → ')}`);
    }
  } else {
    evidenceParts.push('图里没有任何 class_type 含 Sampler 的节点，参数只能从其余节点凑');
  }
  for (const note of [traceNote(positive, '正向提示词'), traceNote(negative, '负向提示词')]) {
    if (note) evidenceParts.push(note);
  }
  if (size.width !== null || size.height !== null) {
    if (size.fromChain) {
      const scaleNote =
        size.scales.length > 0
          ? `；其后有潜在放大 ×${size.scales.join(' ×')}，实际出图尺寸要乘上它（上层拿图片真实尺寸校正）`
          : '';
      evidenceParts.push(
        `尺寸来自主采样器 latent_image 链上的潜在图节点（不是图里随便一个 EmptyLatentImage）${scaleNote}`
      );
    } else {
      evidenceParts.push(
        '尺寸是退化结果（主采样器的 latent_image 链上没有找到带 width/height 的潜在图节点，改为取 id 最小的那个），可能不是这张图的分辨率'
      );
    }
  }
  if (chain.checkpoints.length > 1) {
    evidenceParts.push(`模型链上有 ${chain.checkpoints.length} 个底座模型，取最后加载的那个`);
  }

  // 反转之后"最后加载"的那一个是数组末尾（`items.reverse()` 把 checkpoint 放到了
  // 开头）。因此这里取**第一个**，而不是最后一个 —— 写成最后一个会把 LoRA 当成模型。
  const primaryModel = chain.checkpoints.length > 0 ? chain.checkpoints[0]! : null;

  const workflow = workflowText ? parseWorkflow(workflowText, nodes) : null;

  const highlightsSource = {
    mainSampler: sampler,
    model: primaryModel,
    loras: chain.loras,
    vae,
    clipSkip,
    prompt,
    negativePrompt,
    width: size.width,
    height: size.height,
  };
  const uiNodeCount = workflow ? workflow.nodes.length : 0;

  return {
    generator: 'ComfyUI',
    evidence: evidenceParts.join('；'),
    prompt,
    negativePrompt,
    seed: sampler ? readDynamic(sampler, ['seed', 'noise_seed']) : null,
    steps: sampler ? asNumber(readDynamic(sampler, ['steps'])) : null,
    cfg: sampler ? asNumber(readDynamic(sampler, ['cfg'])) : null,
    sampler: sampler ? readDynamic(sampler, ['sampler_name']) : null,
    scheduler: sampler ? readDynamic(sampler, ['scheduler']) : null,
    model: highlightsSource.model,
    modelHash: null, // API 图里没有模型哈希；要哈希得自己算文件，插件不做这件事。
    vae,
    clipSkip,
    width: size.width,
    height: size.height,
    denoising: sampler ? asNumber(readDynamic(sampler, ['denoise'])) : null,
    loras: chain.loras,
    controlNets: collectControlNets(nodes, byId),
    extras,
    raw: promptText ?? workflowText ?? '',
    workflow: workflow
      ? { ...workflow, highlights: buildHighlights(highlightsSource, extras, uiNodeCount) }
      : null,
  };
}

/** 由 UI 格式文本构造 `ComfyWorkflow`。`apiNodes` 用来补标题。 */
export function parseWorkflow(text: string, apiNodes: ComfyApiNode[]): ComfyWorkflow | null {
  const graph = parseUiGraph(text);
  if (!graph) return null;
  const built = buildNodes(graph, indexApiByTitle(apiNodes));
  return {
    nodes: built.nodes,
    highlights: [], // 由调用方在知道归一化参数之后再填（highlights 要参数，不只是图）
    raw: text,
  };
}

/** 供 `index.ts` 判断"这块文本是不是在做 ComfyUI 的证据"。 */
export function isComfyEvidence(block: TextBlock): boolean {
  if (block.keyword === 'prompt' && block.text.includes('class_type')) return true;
  if (block.keyword === 'workflow' && block.text.includes('nodes')) return true;
  return false;
}
