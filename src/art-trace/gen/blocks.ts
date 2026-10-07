// src/art-trace/gen/blocks.ts
//
// 语义层的共用小工具。
//
// ============================================================
// 为什么先把"取值"包一层，而不是处处写 `String(x ?? '')`
// ============================================================
//
// 这些函数的输入是**别人写的 JSON**：ComfyUI 的 `inputs`、NovelAI 的 `Comment`、
// 厨子手改过的 `parameters`。里面的值什么类型都可能是 —— 数字写成字符串、本该是
// 数组的地方给了对象、路径中间少一层、字段名大小写不一致。
//
// 直接 `JSON.parse` 之后按类型读，一处类型不符就是一次 TypeError，而一次异常会让
// **整张图的元数据都显示不出来**，代价和收获完全不成比例。这里因此把"取一个可能
// 不存在、可能类型不对的值"变成返回值可能为 null 的普通函数，让调用方写直线代码。
//
// 另一条：字段名在同一个生成器的不同版本之间会变（`model` / `model_name`、
// `scale` / `cfg_scale`、`noise_schedule` / `scheduler`）。所以取值的接口是**候选名
// 列表**而不是单个名字 —— 加一个别名只要在调用处多写一个字符串，不用改这层。

import type { ContainerBlock } from '../codec/format';

/**
 * 语义层看到的一个文本块。
 *
 * 与 `ContainerBlock` 的关系是"投影"而不是"包装"：这里只要 keyword 与 text，
 * 因为识别只看这两样。把整个 `ContainerBlock` 传来传去会让这层的函数签名依赖
 * 容器层的字段（`selector`、`structural`…），而那些字段在这层一次都用不到。
 */
export interface TextBlock {
  /** 容器里的关键词，例如 `parameters`、`prompt`、`invokeai_metadata` */
  keyword: string;
  /** 块里的文本原文 */
  text: string;
  /** 来源块的 label，写进 evidence 用（例如 `tEXt(parameters)`） */
  label: string;
}

/** 一个普通对象。TS 的 `Record<string, unknown>` 在运行时就是它。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 值是不是"像文本"（字符串或数字）。参数值里数字写成字符串太常见了。 */
export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  // 整数不要写成 `7.0`：种子、步数在 JSON 里是 number，直接拼字符串会带上小数尾巴。
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** 值能不能当数字用。字符串 `"28"` 也算 —— 生成器经常把数字写成字符串。 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/** 值是不是数组（用来区分"文件名"与"上游链接"）。 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 按候选名在一个对象里取值，返回第一个"能当字符串用"的。 */
export function pick(
  record: Record<string, unknown>,
  names: string[]
): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      const value = record[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

/** 按路径取一个嵌套值（`['_meta', 'title']`）。中间任何一层不是对象就返回 null。 */
export function readPath(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return asString(current);
}

/**
 * 解析一段 JSON 对象。**任何失败都返回 null，绝不抛错。**
 *
 * 两份真实数据逼出了这个函数的形状：
 * * ComfyUI 的 `prompt` 在手工改过的图里会截断（复制粘贴丢字节），`JSON.parse` 抛错；
 * * PNG 的 `tEXt` 只保证 Latin-1，里面装 UTF-8 中文时 `JSON.parse` 也能过，但更常见的
 *   是值里混进了裸控制字符。
 *
 * 因此调用方拿到的永远是"对象或 null"，而不是一次异常 —— 一张图读不出参数是遗憾，
 * 整张图的元数据因为一个块坏掉而全灭是事故。
 */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 解析一段 JSON 数组。 */
export function parseJsonArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 尝试解析一段 JSON。**允许前后有杂音**。
 *
 * NovelAI 老版把 JSON 塞在 `Comment` 里，前后可能还跟一句说明文字；Draw Things 的
 * XMP 里 JSON 更是夹在 XML 中间。这里从第一个 `{` 找到最后一个 `}` 再试一次 ——
 * 这一步救回来的图比它误判的多。
 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const direct = parseJsonRecord(text);
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return parseJsonRecord(text.slice(start, end + 1));
}

/** 值数组 → 字符串数组（丢掉取不出字符串的元素）。 */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== null) out.push(text);
  }
  return out;
}

/** 取字符串数组的第一个非空项。 */
export function firstText(value: unknown): string | null {
  for (const item of asStringArray(value)) {
    if (item.trim().length > 0) return item;
  }
  return null;
}

/** 名字里最后一个路径分量（`a/b/c.safetensors` → `c.safetensors`）。 */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * 截断长文本，用于 evidence / extras。
 *
 * 换行压成 `⏎`：extras 是"一行一条"的列表，值里带换行会把界面撑散。
 */
export function truncate(text: string, max = 160): string {
  const flat = text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ⏎ ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 往 extras 里放一条。**同名会合并**（用 ` / ` 连接）。
 *
 * 合并而不是各自一条，是因为界面把 extras 画成两列表格：同一个键出现五次（五个
 * ControlNet、六个 LoRA 强度）会让人以为是重复数据，而合成一条反而更像"这一项有几个值"。
 */
export function pushExtra(
  extras: Array<{ key: string; value: string }>,
  key: string,
  value: string
): void {
  if (value === '') return;
  const existing = extras.find((extra) => extra.key === key);
  if (existing) {
    existing.value = `${existing.value} / ${value}`;
    return;
  }
  extras.push({ key, value });
}

/**
 * 把 `ContainerBlock[]` 里"看起来是文本"的块投影成 `TextBlock[]`。
 *
 * 判据是**有 label 且有文本**：二进制块（ICC、eXIf）在容器层已经用一句说明代替了
 * 文本，把它们喂进识别逻辑只会让 keyword 落空，代价是多写一个 if 的收益都没有。
 */
export function toTextBlocks(blocks: ContainerBlock[]): TextBlock[] {
  const out: TextBlock[] = [];
  for (const block of blocks) {
    if (block.structural) continue;
    const label = block.label;
    if (typeof label !== 'string' || label.length === 0) continue;
    const keyword = keywordOf(block);
    if (keyword === null) continue;
    // iTXt / zTXt 与 tEXt 在这里一视同仁：解码已经在容器层做完了。
    out.push({ keyword, text: block.text, label });
  }
  return out;
}

/**
 * 从一个块里取容器关键词。
 *
 * 两条来源都要认：
 * 1. `label` 的形状是 `tEXt(parameters)` / `iTXt(prompt)` / `APP1(XMP)`；
 * 2. 有些格式模块把关键词直接当 label（`Comment`）或写成 `tEXt:parameters`。
 *
 * 三种形状都试一遍而不是只认一种：容器层是别人写的，`label` 的确切格式在实现落地
 * 之前无法确定，而"识别不出 keyword"会让整个模块静默失效（返回 null），那是最难查的
 * 一类 bug。
 */
export function keywordOf(block: ContainerBlock): string | null {
  const label = block.label;
  const open = label.indexOf('(');
  if (open >= 0 && label.endsWith(')')) return label.slice(open + 1, -1);
  const colon = label.indexOf(':');
  if (colon >= 0) return label.slice(colon + 1).trim();
  return label.length > 0 ? label : null;
}
