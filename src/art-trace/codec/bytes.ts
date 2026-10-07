// src/art-trace/codec/bytes.ts
//
// 字节读写的基础设施。
//
// ============================================================
// 为什么不用 DataView 就够了
// ============================================================
//
// 解析 PNG / JPEG / RIFF 的代码里有大量"读一个 4 字节的 ASCII 名字、看看是不是
// 我要的那个"以及"从这里往后 n 个字节"。裸 DataView 每次都要写
// `new DataView(buf, offset, len)` 并且自己管游标，那些样板会把真正重要的东西
// （边界检查）淹掉。
//
// 这里因此给两个小对象：`ByteReader`（带游标、越界即抛）与 `ByteWriter`（自己扩容）。
// 越界**抛错而不是返回 0** —— 一个被静默截断的解析结果会一路走到界面上，变成
// "这张图的参数看起来怪怪的"，而真正的原因在几百行之前。

/** 读一个字节序列。游标越界一律抛错，不返回 0。 */
export class ByteReader {
  private readonly view: DataView;
  private readonly raw: Uint8Array;
  private pos: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.raw = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  /** 当前游标位置 */
  get offset(): number {
    return this.pos;
  }

  /** 还剩多少字节 */
  get remaining(): number {
    return this.raw.length - this.pos;
  }

  /** 总长度 */
  get length(): number {
    return this.raw.length;
  }

  /** 到当前游标为止的原始字节（不改游标） */
  get bytes(): Uint8Array {
    return this.raw;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.raw.length) {
      throw new RangeError(`ByteReader: 游标 ${pos} 越界（长度 ${this.raw.length}）`);
    }
    this.pos = pos;
  }

  skip(count: number): void {
    this.seek(this.pos + count);
  }

  /** 边界检查。**这是这个类存在的理由** —— 每一处读取都过它 */
  private need(count: number): void {
    if (count < 0 || this.pos + count > this.raw.length) {
      throw new RangeError(
        `ByteReader: 需要 ${count} 字节，但只剩 ${this.remaining}（位置 ${this.pos}）`
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  /** 大端 16 位。容器格式里绝大多数整数都是大端 */
  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return value;
  }

  u24(): number {
    this.need(3);
    const value =
      (this.view.getUint8(this.pos) << 16) |
      (this.view.getUint8(this.pos + 1) << 8) |
      this.view.getUint8(this.pos + 2);
    this.pos += 3;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return value;
  }

  /** 小端 16 位。TIFF/EXIF 与 RIFF 用它 */
  u16le(): number {
    this.need(2);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  /** 小端 32 位 */
  u32le(): number {
    this.need(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  /** 取 n 个字节的**视图**（不复制）。改它会影响原数组，因此只用于只读场景 */
  slice(count: number): Uint8Array {
    this.need(count);
    const out = this.raw.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  /** 取 n 个字节的**副本** */
  copy(count: number): Uint8Array {
    return new Uint8Array(this.slice(count));
  }

  /** 读 n 个字节当作 Latin-1 文本。容器里的名字与标签都是这个编码 */
  ascii(count: number): string {
    return latin1Decode(this.slice(count));
  }

  /** 在当前位置读一个以 NUL 结尾的字符串（不含结尾的 NUL） */
  cstring(): string {
    const start = this.pos;
    while (this.pos < this.raw.length && this.raw[this.pos] !== 0) this.pos++;
    const text = latin1Decode(this.raw.subarray(start, this.pos));
    if (this.pos < this.raw.length) this.pos++; // 吃掉 NUL
    return text;
  }

  /** 往前看若干字节而不移动游标 */
  peek(count: number): Uint8Array {
    const save = this.pos;
    const out = this.slice(count);
    this.pos = save;
    return out;
  }

  /** 从当前位置往后找一段字节第一次出现的位置（相对整个数组）。找不到返回 -1 */
  indexOf(needle: Uint8Array, from = this.pos): number {
    return indexOfBytes(this.raw, needle, from);
  }
}

/** 攒一段字节。用于重建容器。 */
export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initial = 1024) {
    this.buffer = new Uint8Array(initial);
  }

  get size(): number {
    return this.length;
  }

  private ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length === 0 ? 64 : this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  u8(value: number): this {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  u24(value: number): this {
    this.ensure(3);
    this.buffer[this.length++] = (value >>> 16) & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.buffer[this.length++] = (value >>> 24) & 0xff;
    this.buffer[this.length++] = (value >>> 16) & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  u16le(value: number): this {
    this.ensure(2);
    this.buffer[this.length++] = value & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    return this;
  }

  u32le(value: number): this {
    this.ensure(4);
    this.buffer[this.length++] = value & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    this.buffer[this.length++] = (value >>> 16) & 0xff;
    this.buffer[this.length++] = (value >>> 24) & 0xff;
    return this;
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
    return this;
  }

  /** 写一段 Latin-1 文本（容器里的名字与标签） */
  ascii(text: string): this {
    return this.bytes(latin1Encode(text));
  }

  /** 长度 + 内容，PNG 的文本块用这个形状 */
  asciiChunk(text: string): this {
    const data = latin1Encode(text);
    this.u32(data.length);
    return this.bytes(data);
  }

  /** 把已经写好的内容整体覆盖掉（用于回填长度字段） */
  patchU32(at: number, value: number): void {
    if (at + 4 > this.length) throw new RangeError('ByteWriter: 回填位置越界');
    this.buffer[at] = (value >>> 24) & 0xff;
    this.buffer[at + 1] = (value >>> 16) & 0xff;
    this.buffer[at + 2] = (value >>> 8) & 0xff;
    this.buffer[at + 3] = value & 0xff;
  }

  /** 当前长度（回填长度字段时先用它记下位置） */
  mark(): number {
    return this.length;
  }

  /** 取出成品。**返回的是副本**，之后继续写不会影响它 */
  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer.subarray(0, this.length));
  }
}

// ============================================================
// 文本
// ============================================================

/**
 * Latin-1 解码（每字节一个码位）。
 *
 * 容器里的关键词、块名、以及 PNG 的 `tEXt`（**不是** `iTXt`）都是 Latin-1。
 * 用 UTF-8 去解它会得到替换字符，而"参数里出现了一堆问号"会被误认为是编码坏了。
 */
export function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  // 分块是为了不把超长字符串一次性塞进 apply 的参数表
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    out += String.fromCharCode(...bytes.subarray(start, end));
  }
  return out;
}

/** Latin-1 编码。码位 &gt; 255 的字符会被问号替换 —— 调用方应当先确认编码 */
export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code > 0xff ? 0x3f : code;
  }
  return out;
}

/** UTF-8 编码。`TextEncoder` 在宿主 WebView 里一直有 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * UTF-8 解码，**带 Latin-1 兜底**。
 *
 * 用 `fatal: false`（默认）的 `TextDecoder` 而不是手工解码：PNG 的 `tEXt` 块在实际
 * 文件里经常装着 UTF-8 中文（生成器并不遵守 Latin-1 的规定），而 `iTXt` 明确是
 * UTF-8。一律按 UTF-8 解会在真正的 Latin-1 上得到替换字符 —— 这正是兜底存在的原因。
 */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return latin1Decode(bytes);
  }
}

/** 一段字节是不是合法的 UTF-8（用于在 Latin-1 与 UTF-8 之间选一个） */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 按"像什么就按什么"解码：合法 UTF-8 走 UTF-8，否则 Latin-1 */
export function smartDecode(bytes: Uint8Array): string {
  return looksLikeUtf8(bytes) ? utf8Decode(bytes) : latin1Decode(bytes);
}

// ============================================================
// 杂项
// ============================================================

/** 在 `haystack` 里找 `needle`，从 `from` 开始。找不到返回 -1 */
export function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0
): number {
  if (needle.length === 0) return from;
  const limit = haystack.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** `bytes` 是不是以 `prefix` 开头 */
export function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** 把几个数组拼起来 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 一段 ASCII 文本的字节 */
export function asciiBytes(text: string): Uint8Array {
  return latin1Encode(text);
}

/** 十六进制（小写），用于哈希显示 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 人类可读的字节数，例如 `3.4 MB` */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 把字节缩到人类可读的**单行**文本，用于把块的内容显示在列表里。
 *
 * 换行被压成 `⏎`：一段 A1111 的 `parameters` 有十几行，直接塞进列表会把表格撑散，
 * 而如果只取第一行，用户又会以为后面的内容丢了。
 */
export function toDisplayText(text: string, max = 240): string {
  const flat = text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ⏎ ');
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}
