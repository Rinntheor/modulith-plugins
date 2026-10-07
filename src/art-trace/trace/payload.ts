// src/art-trace/trace/payload.ts
//
// 追踪编号与隐形水印的载荷编解码。
//
// ============================================================
// 载荷为什么要带自己的头与校验和
// ============================================================
//
// 隐形水印被读出来的时候，输入是**一段不知道对不对的比特**。它可能来自：
//   * 我们自己写进去的载荷；
//   * 一张恰好也有 LSB 数据、但与本插件无关的图（很多工具都往 LSB 里塞东西）；
//   * 一张被有损转码过、LSB 已经被冲掉的图。
//
// 三者必须被区分开。因此载荷是自描述的：一个魔数（认出"这是我写的"）、一个版本号
// （将来换格式时能拒绝而不是误解）、一个长度、以及一个 CRC-32（认出"这一遍重复是
// 完整的"）。少了任何一个，第三种情况会被读成第二种，而用户会拿着一段乱码去追责。

import type { TracePayload, WatermarkFields } from '../model/types';
import { ByteReader, ByteWriter, utf8Decode, utf8Encode } from '../codec/bytes';
import { crc32 } from '../codec/crc32';

/**
 * 魔数。选 `MTA1` 而不是一串随机字节：
 * 它是 ASCII，因此在十六进制转储里能被一眼认出来 —— 调试"水印到底写进去没有"
 * 的时候，这一点比多几个校验位有用。
 */
const MAGIC = utf8Encode('MTA1');

/** 载荷格式版本。改了布局就要 +1，读端据此拒绝而不是猜 */
const PAYLOAD_VERSION = 1;

/** 头部长度：魔数(4) + 版本(1) + 文本长度(2) + CRC(4) */
const HEADER_BYTES = MAGIC.length + 1 + 2 + 4;

/** 载荷里的文本上限。与 `env.MAX_PAYLOAD_BYTES` 对齐 */
const MAX_TEXT_BYTES = 400;

/**
 * 把模板里的占位符替换成实际值。
 *
 * 认不出的占位符**原样保留**（不替换成空串）。把它抹成空串会让作者以为"这个字段
 * 没值"，而真相是"你打错了名字" —— 前者他不会再查，后者他会。
 */
export function renderTemplate(
  template: string,
  fields: WatermarkFields
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      return fields[name as keyof WatermarkFields] ?? '';
    }
    return whole;
  });
}

/** 模板里用到的全部占位符名字（去重、按出现顺序）。界面用它列出可用变量 */
export function templatePlaceholders(template: string): string[] {
  const seen: string[] = [];
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/** 模板里出现的、但不认识的占位符。界面据此警告作者 */
export function unknownPlaceholders(
  template: string,
  known: readonly string[]
): string[] {
  return templatePlaceholders(template).filter((name) => !known.includes(name));
}

// ============================================================
// 唯一追踪编号
// ============================================================

/**
 * 生成一个追踪编号：`<前缀>-<yyyyMMdd>-<序号4位>-<随机4位十六进制>`。
 *
 * 三个部分各有分工，缺一不可：
 *   * **日期** 让人一眼看出批次；
 *   * **序号** 让同一次批量里的每一张**互相不同** —— 这正是"分发给不同人"的依据；
 *   * **随机段** 防的是"别人照着你的格式仿造一个编号"。它不是密码学强度的，
 *     因此**不要**把它当成防伪；真正防伪的是台账里的 SHA-256。
 */
export function makeTraceId(options: {
  prefix: string;
  date: string;
  sequence: number;
  random?: number;
}): string {
  const prefix = normalizePrefix(options.prefix);
  const seq = String(Math.max(1, Math.floor(options.sequence))).padStart(4, '0');
  const random =
    options.random !== undefined
      ? options.random
      : Math.floor(Math.random() * 0x10000);
  const tail = (random & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `${prefix}-${options.date}-${seq}-${tail}`;
}

/**
 * 归一化编号前缀。
 *
 * 只留字母与数字：编号会被写进文件名、写进台账、也会被用户拿去搜索，而中划线
 * 是分隔符 —— 前缀里再出现中划线会让"从编号反推批次"这件事变得有歧义。
 */
export function normalizePrefix(prefix: string): string {
  const cleaned = (prefix || 'AT').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 12) || 'AT';
}

/** `yyyyMMdd`（本地时间）。用本地时间而不是 UTC：用户对"今天发的"有自己的理解 */
export function todayStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/** 本地时间戳，形如 `2026-10-07 14:32`。台账列表显示用 */
export function formatStamp(millis: number): string {
  if (!Number.isFinite(millis) || millis <= 0) return '—';
  const date = new Date(millis);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ============================================================
// 载荷编解码
// ============================================================

/** 把一段文本编成自描述的载荷字节。文本过长时**截断而不是抛错** */
export function encodePayload(text: string): Uint8Array {
  let body = utf8Encode(text);
  if (body.length > MAX_TEXT_BYTES) {
    // 按 UTF-8 边界截断：在字符中间砍一刀会得到一个永远解不出来的尾巴，
    // 而那一截会被解码成替换字符塞进用户的追踪信息里。
    body = truncateUtf8(body, MAX_TEXT_BYTES);
  }

  const writer = new ByteWriter(HEADER_BYTES + body.length);
  writer.bytes(MAGIC);
  writer.u8(PAYLOAD_VERSION);
  writer.u16(body.length);
  writer.bytes(body);
  // CRC 覆盖**版本之后的全部内容**（长度 + 文本），因此长度字段被改坏也能被发现。
  writer.u32(crc32(writer.toBytes().subarray(MAGIC.length)));
  return writer.toBytes();
}

/**
 * 把载荷字节解回文本。任何一步不对就返回 `null`。
 *
 * **`null` 与"读出一段乱码"是两件不同的事**，而返回值必须能区分它们：
 * 这里只有"认出来了"才返回内容，因此调用方拿到非 `null` 就可以相信它。
 */
export function decodePayload(bytes: Uint8Array): { text: string; version: number } | null {
  if (bytes.length < HEADER_BYTES) return null;

  const reader = new ByteReader(bytes);
  const magic = reader.copy(MAGIC.length);
  for (let i = 0; i < MAGIC.length; i++) {
    if (magic[i] !== MAGIC[i]) return null;
  }

  const version = reader.u8();
  if (version !== PAYLOAD_VERSION) {
    // 版本不认识时**明确返回 null**，而不是尽力解析：一个新版载荷用旧规则读出来的
    // 字段可能是错的，而错字段比没有字段更危险（用户会照它去追责）。
    return null;
  }

  const length = reader.u16();
  if (length > MAX_TEXT_BYTES || reader.remaining < length + 4) return null;

  const body = reader.copy(length);
  const want = reader.u32();
  const got = crc32(bytes.subarray(MAGIC.length, MAGIC.length + 1 + 2 + length));
  if (want !== got) return null;

  return { text: utf8Decode(body), version };
}

/** 把载荷文本按 `k=v|k=v` 拆成字段。拆不动的部分整体作为一条 `payload` */
export function parsePayloadFields(
  text: string
): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [];
  for (const part of text.split('|')) {
    const at = part.indexOf('=');
    if (at <= 0) {
      if (part.trim().length > 0) fields.push({ key: 'payload', value: part.trim() });
      continue;
    }
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key.length > 0) fields.push({ key, value });
  }
  return fields;
}

/** 组装最终要交给界面的追踪结果 */
export function toTracePayload(
  decoded: { text: string; version: number },
  copies: number
): TracePayload {
  return {
    version: decoded.version,
    text: decoded.text,
    fields: parsePayloadFields(decoded.text),
    // 走到这里说明 CRC 已经过了 —— `decodePayload` 只在 CRC 正确时返回内容。
    crcOk: true,
    copies,
  };
}

/** 按 UTF-8 边界截断到最多 `limit` 字节 */
function truncateUtf8(bytes: Uint8Array, limit: number): Uint8Array {
  let end = limit;
  // 回退到最后一个字符的起始字节：UTF-8 的续字节形如 10xxxxxx。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/** 载荷的信道容量估算，界面用它提示"这段话装不下" */
export function payloadCapacityBytes(pixelCount: number, bitsPerChannel = 1): number {
  // 每个像素在 RGB 三个通道上各能藏 `bitsPerChannel` 位。不碰 alpha：改 alpha 会
  // 让图在透明背景上出现可见噪点，而那是用户一眼就能看出来的。
  const bits = pixelCount * 3 * bitsPerChannel;
  return Math.floor(bits / 8);
}
