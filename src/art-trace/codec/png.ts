// src/art-trace/codec/png.ts
//
// PNG 容器解析与**无损**重建。
//
// ============================================================
// 为什么这里一行都不碰像素
// ============================================================
//
// PNG 的像素在 `IDAT` 里是 zlib 压缩过的扫描线，而"清理元数据"这件事**完全不需要
// 知道里面是什么**：块边界是自描述的（长度 + 类型 + 数据 + CRC），因此搬运 IDAT
// 就是原样复制那几个字节。
//
// 反过来做（解码 → 丢元数据 → 重编码）会踩两个坑，而且两个都很贵：
//   * **有损**。zlib 重压缩后的字节与原文件不同，"清理过的图"与"原图"的哈希就再也
//     对不上，而台账正是靠哈希做同一性判定的。
//   * **慢**。一张 4000×4000 的图解码重编码要几百毫秒，而搬运只要几毫秒 ——
//     批量处理几十张时这个差距是"点一下等一秒"与"点一下等一分钟"。
//
// 因此本文件对 IDAT 的全部操作是 `subarray`。
//
// ============================================================
// 关于"压缩的文本块不展开"这个决定
// ============================================================
//
// `zTXt` 与压缩的 `iTXt` 要解压才能看到内容，而 Web 平台唯一的解压接口是
// `DecompressionStream` —— 它是**异步**的。但这里的 `parsePng` 必须与 JPEG / WebP /
// GIF 的解析器有同一个签名（同步返回 `FormatParse`），否则 `parseContainer` 要么
// 变成 async（把异步污染扩散到 `clean/`、`trace/`、`ui/` 的每一层），要么就得为
// PNG 单独开一条异步路径（那正是"加一种格式就要改五处"的开端）。
//
// 取舍是：**解析时只报告"这里有一坨 n 字节的压缩数据"，不展开。** 代价是列表里
// 看不到压缩文本的内容；收益是整个解析层保持同步、保持一致。而**重建时这批数据
// 原样搬运**，因此"看不到"不会变成"丢了"。

import type { ImageInfo, MetaGroup } from '../model/types';
import type { ContainerBlock, FormatParse, RebuildOptions } from './format';
import { ByteReader, ByteWriter, formatBytes, latin1Decode, smartDecode, utf8Decode } from './bytes';
import { crc32Parts, readCrc32 } from './crc32';
import { parseExif, buildOrientationExif } from './exif';
import { extractXmpFromText } from './xmp';

/** 8 字节签名。校验它只需要一次逐字节比较，但漏掉它会让任何文件都被当成 PNG 硬解 */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * 结构性块：**丢了文件就坏，因此无论 `drop` 里写什么都保留。**
 *
 * `IHDR`/`PLTE`/`tRNS`/`IDAT`/`IEND` 是明确的。`acTL`/`fcTL`/`fdAT` 是 APNG 的
 * 帧控制与帧数据 —— 它们看起来像"元数据里的动画信息"，但删掉 `fdAT` 会得到一个
 * 只剩第一帧、尺寸对不上的图，而那比"文件打不开"更难排查（它会正常打开）。
 */
const STRUCTURAL = new Set([
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'acTL',
  'fcTL',
  'fdAT',
]);

/**
 * "默认不丢"的非结构性块。
 *
 * 分组给 `structural`（它们在界面上的归处是"图像本身的信息"），但
 * `structural: false` —— 这一个位专指"丢了文件就坏"。`gAMA` 丢了不坏，只是颜色
 * 可能与原意不同；`pHYs` 丢了不坏，只是打印尺寸变了。表意交给 `removable: false`。
 */
const KEEP_BY_DEFAULT = new Set([
  'pHYs',
  'tIME',
  'gAMA',
  'cHRM',
  'sRGB',
  'cICP',
  'bKGD',
  'sBIT',
  'hIST',
  'sPLT',
  'mDCV',
  'cLLI',
]);

/** 三个文本块的类型名。它们的形状各不相同，因此各有各的解析分支 */
const TEXT_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);

/** XMP 在 PNG 里规定的 keyword。**大小写敏感**：写错一个字母就找不到 XMP 了 */
const XMP_KEYWORD = 'XML:com.adobe.xmp';

/** `colorType` → 色彩模型。3（调色板）要等 PLTE 出来才知道表项数，因此单独处理 */
const COLOR_MODEL: Readonly<Record<number, string>> = {
  0: '灰度',
  2: 'RGB',
  4: '灰度+Alpha',
  6: 'RGBA',
};

/** 解析中途记下的一条"这里不对劲"，最后拼成给用户看的原因 */
interface Note {
  text: string;
}

/** 一个块解析之后留下的、重建时需要的全部信息 */
interface Chunk {
  type: string;
  /** 块数据（**副本**，不持有原文件的视图） */
  data: Uint8Array;
  /** 这个块在文件里的位置。`IHDR` 第一，其余按原始顺序 */
  order: number;
  /** 块头里的长度字段（可能因为越界而与 `data.length` 不等） */
  declaredLength: number;
  crcOk: boolean;
  structural: boolean;
  group: MetaGroup;
  /**
   * 重建时的丢块键。文本块带 keyword（`tEXt:prompt`），其余按类型；同一键出现
   * 第二次起加 `#2`。
   *
   * `base` 是**去重前**的键，`finalizeChunk` 要靠它统计同键的块数 —— 直接看去重
   * 后的 `selector` 会得到 `tEXt:prompt#2#2` 这种越滚越长的名字。
   */
  selector: string;
  base: string;
  id: string;
  label: string;
  text: string;
  removable: boolean;
  orientation: number | null;
}

/** 把 `keyword` 洗成合法的 PNG 关键词：Latin-1 可打印、不含 NUL、非空 */
function sanitizeKeyword(keyword: string): string {
  let out = '';
  for (const ch of keyword) {
    const code = ch.codePointAt(0) ?? 0;
    // 规范只允许 1..127 且非 NUL。空格（0x20）是允许的，而 0x7f 不是
    if (code >= 1 && code <= 126) out += ch;
  }
  if (out.length === 0) out = 'Metadata';
  // 关键词长度规范上限是 79 字节。超长不会被解析器拒，但会让别的工具困惑
  return out.length > 79 ? out.slice(0, 79) : out;
}

/** 在一段字节里找 `needle`。用于在 `eXIf` 里认 C2PA 的 JUMBF 标记 */
function containsBytes(haystack: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  const limit = haystack.length - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/** 一个块类型的 4 字节 ASCII 形式。CRC 覆盖"类型 + 数据"，因此它必须与原字节一致 */
function typeBytesOf(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i) & 0xff;
  return out;
}

/** 一个块的完整字节（长度 + 类型 + 数据 + CRC）。重建时每个块都走这里 */
function writeChunk(writer: ByteWriter, type: string, data: Uint8Array): void {
  const typeBytes = typeBytesOf(type);

  writer.u32(data.length);
  writer.bytes(typeBytes);
  writer.bytes(data);
  // CRC 覆盖"类型 + 数据"。用 crc32Parts 而不是先 concat 一份 —— IDAT 有几 MB，
  // 为了算校验和再复制一遍的峰值内存翻倍，而这一步每张图都要走
  writer.u32(crc32Parts([typeBytes, data]));
}

/**
 * 解析一个 PNG。
 *
 * **容错边界**：只有"签名不对"或"IHDR 缺失/长度不是 13"才算失败。长度字段说谎、
 * CRC 不符、块被截断 —— 一律**停下遍历并保留已经拿到的块**，同时把这个事实记进
 * `blockedReason`：用户该看到的是"这个文件有毛病，但我读到了 37 个块"，而不是
 * 一片空白。
 */
export function parsePng(bytes: Uint8Array): FormatParse {
  const notes: Note[] = [];
  const chunks: Chunk[] = [];

  // 失败时统一走这个出口：`blocks` 为空、`rewritable` 为假，原因给用户看
  const fail = (reason: string): FormatParse => {
    const info: ImageInfo = {
      format: 'png',
      width: 0,
      height: 0,
      bitDepth: null,
      colorModel: null,
      interlaced: false,
      animated: false,
      frames: 1,
      bytes: bytes.length,
    };
    return {
      info,
      blocks: [],
      exif: null,
      xmp: null,
      iccBytes: 0,
      c2pa: [],
      rewritable: false,
      blockedReason: reason,
      rebuild: () => {
        throw new Error(`PNG 无法重建：${reason}`);
      },
    };
  };

  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return fail('不是 PNG 文件：开头 8 字节不是 PNG 签名');
  }

  const info: ImageInfo = {
    format: 'png',
    width: 0,
    height: 0,
    bitDepth: null,
    colorModel: null,
    interlaced: false,
    animated: false,
    frames: 1,
    bytes: bytes.length,
  };

  let sawIhdr = false;
  let colorType = -1;
  let paletteEntries = 0;
  let acTlFrames = 0;
  let exifBytes: Uint8Array | null = null;
  let xmp: string | null = null;
  let iccBytes = 0;
  const c2pa: string[] = [];

  // selector 与 id 的去重计数在收尾那一轮现建（见 finalizeChunk）

  const reader = new ByteReader(bytes, SIGNATURE.length);

  // ---------------- 遍历 ----------------
  for (;;) {
    if (reader.remaining < 8) break; // 连长度与类型都放不下，后面不会再有完整块

    const lengthAt = reader.offset;
    const declaredLength = reader.u32();
    const type = reader.ascii(4);

    if (declaredLength > reader.remaining - 4) {
      // **长度字段说谎**：剩下的字节装不下它。这一块的数据不可信，但**前面的块
      // 是好的** —— 因此记下来就停，不抛错
      notes.push({
        text: `块 ${type}（位置 ${lengthAt}）声明长度 ${declaredLength} 字节，超出文件末尾（只剩 ${reader.remaining - 4} 字节），已停止遍历`,
      });
      break;
    }

    // 数据是**副本**：解析结果可能被长期持有，而持有原文件的一个视图会让整个
    // 几 MB 的 buffer 无法被回收。
    //
    // **唯一例外是 IDAT。** 一张图有几十个 IDAT 块、合起来几 MB，逐个复制等于把
    // 整个文件在内存里再放一份；而 IDAT 只被搬运（既不解析也不改动），因此共享
    // 原数组的视图是安全的。这也是"无损重建"在内存上的必要条件 —— 4.5 MB 的图
    // 走一遍重建不该需要 9 MB。
    const data = type === 'IDAT' ? reader.slice(declaredLength) : reader.copy(declaredLength);

    if (reader.remaining < 4) {
      notes.push({ text: `块 ${type} 的 CRC 字段缺失（文件被截断），已停止遍历` });
      chunks.push(makeChunk(type, data, declaredLength, false));
      break;
    }
    const crcField = readCrc32(bytes, reader.offset);
    reader.skip(4);

    // CRC 校验：**算出来不对也照常解析**，只在该块的 `text` 里附一句。理由是这个
    // 值可以被用户自己改坏（有些工具写完不更新 CRC），而那不该让人看不到内容。
    //
    // **但 IDAT 不校验。** 校验等于把整个文件哈希一遍，而 IDAT 占文件体积的 99%
    // 以上（一张 2384×1584 的图有 4.5 MB 分散在 70 个块里）。元数据块总共几十 KB，
    // 校验它们是免费的，而"IDAT 的 CRC 坏了"本来就无法通过重建修复 ——
    // **重建时每个块的 CRC 都会重算**，因此最终产物的 CRC 一定是对的，这一点不会
    // 因为跳过校验而改变。
    const crcOk =
      type === 'IDAT' ? true : crc32Parts([typeBytesOf(type), data]) === crcField;

    chunks.push(makeChunk(type, data, declaredLength, crcOk));

    if (type === 'IHDR') {
      sawIhdr = true;
      if (declaredLength !== 13) {
        return fail(`IHDR 块长度应为 13 字节，实际为 ${declaredLength} 字节，文件已损坏`);
      }
      const head = new ByteReader(data);
      info.width = head.u32();
      info.height = head.u32();
      info.bitDepth = head.u8();
      colorType = head.u8();
      info.interlaced = head.u8() !== 0;
    } else if (type === 'PLTE') {
      // 表项数 = 数据长度 / 3。**不整除时向下取整**：多余的尾部字节是畸形数据，
      // 把它当成一个不完整的表项会得到 256 这种"看起来对"的数
      paletteEntries = Math.floor(declaredLength / 3);
    } else if (type === 'acTL') {
      // num_frames 是 data[0..4] 大端 u32
      if (declaredLength >= 4) {
        acTlFrames = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
      }
    } else if (type === 'eXIf') {
      if (exifBytes === null) exifBytes = data;
    }
  }

  if (!sawIhdr) return fail('缺少 IHDR 块，这不是一个完整的 PNG 文件');

  // ---------------- 用 IHDR（与 PLTE / acTL）补齐 info ----------------
  if (colorType === 3) {
    info.colorModel = `调色板(${paletteEntries})`;
  } else {
    info.colorModel = COLOR_MODEL[colorType] ?? `未知colorType(${colorType})`;
  }
  info.animated = acTlFrames > 0;
  info.frames = acTlFrames > 0 ? acTlFrames : 1;

  // ---------------- 把已解析的块整理成模型 ----------------
  // 分两轮而不是一轮：
  //   * 第一轮填内容（文本要解码、eXIf 要试解、C2PA 要按字节找标记）
  //   * 第二轮分配 `selector` 与 `id`
  // 分开的理由是 `selector` 的序号必须按**文件里的顺序**分配，而内容解析里任何
  // 一处失败（例如 eXIf 坏掉）都不该让序号错位。
  const describeContext: DescribeContext = {
    setExif: (value) => {
      // 只留第一块：PNG 规范只允许一个 eXIf，而"第一个"与文件顺序一致
      if (exifBytes === null) exifBytes = value;
    },
    setXmp: (value) => {
      if (xmp === null) xmp = value;
    },
    addIce: (length) => {
      iccBytes = length;
    },
    addC2pa: (where) => {
      if (!c2pa.includes(where)) c2pa.push(where);
    },
  };

  let order = 0;
  for (const chunk of chunks) {
    chunk.order = order++;
    describeChunk(chunk, describeContext);
  }
  // selector 与 id 的计数表在收尾这一轮现建：它们是纯粹的"数一数同名的第几个"，
  // 没有任何跨调用状态需要保留，因此不放在模块作用域（那里会串味到下一次解析）
  const selectorSeen = new Map<string, number>();
  const idSeen = new Map<string, number>();
  for (const chunk of chunks) finalizeChunk(chunk, selectorSeen, idSeen);

  const blockedReason =
    notes.length > 0 ? notes.map((note) => note.text).join('；') : null;

  return {
    info,
    blocks: chunks.map(toBlock),
    exif: exifBytes,
    xmp,
    iccBytes,
    c2pa,
    // PNG 的重建是纯搬运，任何尺寸、任何块组合都能重建
    rewritable: true,
    blockedReason,
    rebuild: (options: RebuildOptions) => rebuildPng(chunks, options),
  };
}

// ============================================================
// 块 → 模型
// ============================================================

/** 造一个只有结构字段的块记录。内容字段由 `describeChunk` / `finalizeChunk` 填 */
function makeChunk(
  type: string,
  data: Uint8Array,
  declaredLength: number,
  crcOk: boolean
): Chunk {
  return {
    type,
    data,
    order: 0,
    declaredLength,
    crcOk,
    structural: STRUCTURAL.has(type),
    group: 'other',
    selector: type,
    base: type,
    id: type,
    label: type,
    text: '',
    removable: true,
    orientation: null,
  };
}

/** 解析 `tEXt`：`keyword\0latin1text` */
function parseText(data: Uint8Array): { keyword: string; text: string } {
  const nul = data.indexOf(0);
  if (nul < 0) return { keyword: latin1Decode(data), text: '' };
  return {
    keyword: latin1Decode(data.subarray(0, nul)),
    // 规范说 tEXt 是 Latin-1，但**现实里的生成器全部写 UTF-8**（ComfyUI 的
    // workflow JSON 里有中文节点标题）。`smartDecode` 先判断它是不是合法 UTF-8，
    // 是就按 UTF-8 解 —— 否则中文会变成一堆问号，而用户会以为文件坏了
    text: smartDecode(data.subarray(nul + 1)),
  };
}

/** 解析 `zTXt`：`keyword\0method(1)deflate数据`。**不解压**（见文件头说明） */
function parseZtxt(data: Uint8Array): { keyword: string; method: number; payload: Uint8Array } {
  const nul = data.indexOf(0);
  if (nul < 0) return { keyword: latin1Decode(data), method: -1, payload: new Uint8Array(0) };
  const method = nul + 1 < data.length ? data[nul + 1] : -1;
  return {
    keyword: latin1Decode(data.subarray(0, nul)),
    method,
    payload: data.subarray(Math.min(nul + 2, data.length)),
  };
}

/**
 * 解析 `iTXt`：`keyword\0flag(1)method(1)language\0translated\0utf8文本`
 *
 * **尾部三种写法都要认。** 规范要求 language 与 translatedKeyword 各带一个结尾
 * NUL，因此两个都是空串时应当有 **3 个** NUL（keyword 后、language 后、translated
 * 后）。但现实里有不少写入方只写 2 个（把两个"空串"合并成一个 NUL），而那会让
 * 按规范解析出来的 `translated` 名字里带上正文的头一个字符 —— 于是 XMP 的
 * `XML:com.adobe.xmp` 变成了 `XML:com.adobe.xmp<?xpacket…`，keyword 比较失败，
 * **整包 XMP 就此消失**。
 *
 * 处理办法是：**找不到第三个 NUL 时把 `translatedKeyword` 当空串**，不去吞正文。
 * 这是唯一能同时读对两种写法的分支 —— 规范写法会走到下面那条正常路径，宽容
 * 写法走到这条。
 */
function parseItxt(data: Uint8Array): {
  keyword: string;
  compressed: boolean;
  language: string;
  translated: string;
  text: string;
} {
  const empty = { keyword: '', compressed: false, language: '', translated: '', text: '' };
  const first = data.indexOf(0);
  if (first < 0) return { ...empty, keyword: latin1Decode(data) };
  const keyword = latin1Decode(data.subarray(0, first));

  let at = first + 1;
  if (at + 2 > data.length) return { ...empty, keyword };
  const compressed = data[at] !== 0;
  at += 2; // 跳过 compressionFlag 与 compressionMethod

  const languageEnd = data.indexOf(0, at);
  if (languageEnd < 0) return { ...empty, keyword, compressed };
  const language = latin1Decode(data.subarray(at, languageEnd));
  at = languageEnd + 1;

  const translatedEnd = data.indexOf(0, at);
  // 没有第三个 NUL 了：说明写入方只写了 2 个 NUL 且正文紧随其后。此时"翻译关键词"
  // 实际上是空的，正文从 `at` 开始 —— 把那一段当成 translated 会把正文的头一段
  // 当成名字，因此这里直接把它当空串，正文从 `at` 起
  if (translatedEnd < 0) {
    const body = data.subarray(at);
    return {
      keyword,
      compressed,
      language,
      translated: '',
      text: compressed ? '' : utf8Decode(body),
    };
  }
  const translated = utf8Decode(data.subarray(at, translatedEnd));
  at = translatedEnd + 1;

  const body = data.subarray(at);
  if (compressed) return { keyword, compressed, language, translated, text: '' };
  return { keyword, compressed, language, translated, text: utf8Decode(body) };
}

/** `describeChunk` 需要的副作用表。收成一个参数是为了让它的签名短到能一眼看完 */
interface DescribeContext {
  setExif(value: Uint8Array): void;
  setXmp(value: string): void;
  addIce(length: number): void;
  addC2pa(where: string): void;
}

/**
 * 填一个块的内容字段。
 *
 * 这里只做"这一块本身是什么"，不做"它在整个文件里排第几" —— 后者是
 * `finalizeChunk` 的事。分开的理由是：一个块的**显示文本**依赖别处（例如调色板
 * 表项数），把它与序号分配混在一起写，会让"改一下文本"意外地改掉 selector。
 */
function describeChunk(chunk: Chunk, ctx: DescribeContext): void {
  chunk.label = chunk.type;
  const note = chunk.crcOk ? '' : '　（CRC 不符）';

  if (chunk.type === 'IHDR') {
    chunk.group = 'structural';
    chunk.removable = false;
    chunk.text = `${readU32(chunk.data, 0)}×${readU32(chunk.data, 4)}，位深 ${chunk.data[8] ?? '?'}，colorType ${chunk.data[9] ?? '?'}${chunk.data[10] ? '，隔行扫描' : ''}${note}`;
    return;
  }

  if (STRUCTURAL.has(chunk.type)) {
    chunk.group = 'structural';
    chunk.removable = false;
    if (chunk.type === 'IDAT') {
      chunk.text = `${formatBytes(chunk.declaredLength)} 压缩像素数据${note}`;
    } else if (chunk.type === 'IEND') {
      chunk.text = `文件结束标记${note}`;
    } else if (chunk.type === 'PLTE') {
      chunk.text = `调色板，${Math.floor(chunk.declaredLength / 3)} 个表项${note}`;
    } else {
      chunk.text = `${chunk.declaredLength} 字节${note}`;
    }
    return;
  }

  if (TEXT_TYPES.has(chunk.type)) {
    chunk.group = 'text';
    chunk.removable = true;
    if (chunk.type === 'tEXt') {
      const { keyword, text } = parseText(chunk.data);
      chunk.base = `tEXt:${keyword}`;
      chunk.label = `tEXt(${keyword})`;
      chunk.text = text + note;
      return;
    }
    if (chunk.type === 'zTXt') {
      const { keyword, method, payload } = parseZtxt(chunk.data);
      chunk.base = `zTXt:${keyword}`;
      chunk.label = `zTXt(${keyword})`;
      chunk.text =
        method === 0
          ? `（zlib 压缩，${payload.length} 字节，解压后内容未展开）${note}`
          : `（压缩方法 ${method} 不是 0，无法解压，${payload.length} 字节）${note}`;
      return;
    }
    const itxt = parseItxt(chunk.data);
    chunk.base = `iTXt:${itxt.keyword}`;
    chunk.label = `iTXt(${itxt.keyword})`;
    if (itxt.compressed) {
      chunk.text = `（zlib 压缩，${Math.max(0, chunk.declaredLength - itxt.keyword.length - 5 - itxt.language.length - itxt.translated.length)} 字节，解压后内容未展开）${note}`;
      return;
    }
    chunk.text = itxt.text + note;
    // XMP 的 iTXt：group 给 `xmp`，包体交给 xmp 模块（它认得 xpacket 外壳与
    // 裸 x:xmpmeta 两种形态）
    if (itxt.keyword === XMP_KEYWORD) {
      chunk.group = 'xmp';
      const extracted = extractXmpFromText(itxt.text);
      if (extracted !== null) ctx.setXmp(extracted);
    }
    return;
  }

  if (chunk.type === 'eXIf') {
    chunk.group = 'exif';
    chunk.removable = true;
    // eXIf 的内容**从 TIFF 头开始**（PNG 规范不带 JPEG 的那 6 字节 `Exif\0\0`）
    const parsed = parseExif(chunk.data);
    chunk.orientation = parsed.orientation;
    chunk.text = `${parsed.fields.length} 个字段，${formatBytes(chunk.declaredLength)}${note}`;
    if (chunk.orientation !== null) {
      chunk.text = `方向 ${chunk.orientation}，${chunk.text}`;
    }
    ctx.setExif(chunk.data);

    // C2PA 的 JUMBF 有时被塞进 eXIf。**按字节找标记**而不是解析 TIFF：
    // JUMBF 是个盒子结构，而这里只需要"它在不在"
    if (containsBytes(chunk.data, 'jumb') || containsBytes(chunk.data, 'c2pa')) {
      ctx.addC2pa(`eXIf 块内嵌的 JUMBF 数据（${formatBytes(chunk.declaredLength)}）`);
    }
    return;
  }

  if (chunk.type === 'iCCP') {
    // 内容形状与 zTXt 相同：`name\0method(1)deflate数据`。**不解压** —— 这里只需要
    // 知道它有多大，而解压一个几 MB 的描述文件只为了量尺寸是纯粹的浪费
    const nul = chunk.data.indexOf(0);
    const name = nul >= 0 ? latin1Decode(chunk.data.subarray(0, nul)) : '';
    const payloadLength = Math.max(0, chunk.declaredLength - (nul < 0 ? 0 : nul + 2));
    chunk.group = 'icc';
    // ICC 是色彩描述文件，**不是隐私**：删了会让图片在色彩管理正确的查看器里偏色
    chunk.removable = false;
    chunk.label = name.length > 0 ? `iCCP(${name})` : 'iCCP';
    chunk.text = `ICC 色彩描述文件，${formatBytes(payloadLength)}${note}`;
    ctx.addIce(payloadLength);
    return;
  }

  if (chunk.type === 'caBX' || chunk.type === 'c2pa' || chunk.type === 'jumb') {
    chunk.group = 'c2pa';
    chunk.removable = true;
    chunk.text = `C2PA / Content Credentials 数据（${formatBytes(chunk.declaredLength)}）${note}`;
    ctx.addC2pa(`${chunk.type} 块（${formatBytes(chunk.declaredLength)}）`);
    return;
  }

  if (KEEP_BY_DEFAULT.has(chunk.type)) {
    // 归到 structural 组（界面上的位置就是"图像自身的信息"），但 structural 位
    // 保持 false —— 那一位专指"丢了文件就坏"
    chunk.group = 'structural';
    chunk.removable = false;
    chunk.text = KEEP_DEFAULT_TEXT[chunk.type]?.(chunk.declaredLength) ?? `${chunk.declaredLength} 字节`;
    chunk.text += note;
    return;
  }

  // 未识别块：**留着并显示出来**。未知块恰恰可能是最新的那批痕迹
  chunk.group = 'other';
  chunk.removable = true;
  chunk.text = `未识别的块，${formatBytes(chunk.declaredLength)}${note}`;
}

/** 几个"默认不丢"的块的可读说明。用函数是因为它要用到长度 */
const KEEP_DEFAULT_TEXT: Readonly<Record<string, (length: number) => string>> = {
  pHYs: () => '物理尺寸（DPI）',
  tIME: () => '最后修改时间',
  gAMA: () => 'Gamma',
  cHRM: () => '色度坐标',
  sRGB: () => 'sRGB 渲染意图',
  cICP: () => '编码无关的编码点',
  bKGD: () => '背景色',
  sBIT: () => '有效位深',
  hIST: () => '调色板直方图',
  sPLT: () => '建议调色板',
  mDCV: () => '母版显示色彩体积',
  cLLI: () => '内容亮度级别信息',
};

function readU32(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 24 | (data[at + 1] ?? 0) << 16 | (data[at + 2] ?? 0) << 8 | (data[at + 3] ?? 0)) >>> 0;
}

/**
 * 给块分配稳定的 `selector` 与唯一的 `id`。
 *
 * 两条要求在这里交汇：
 *   * `selector` 是"丢块"的键，**同一个键对应的块会被一起丢掉**。
 *   * `id` 是界面列表的 key，**必须唯一** —— 每次渲染都换一批 key 会让 React 重建
 *     整个列表，表现为滚动位置跳动。
 *
 * 因此：文本块的 selector 里带 keyword（`tEXt:prompt`），同名第二块写 `#2`
 * （ComfyUI 偶尔会写两条 `Comment`）；其余块按类型去重（`eXIf`、`eXIf#2`）。
 * 而 `id` 再加一层"同类型内的序号" —— 两个不同的 keyword 之间不会撞车，但
 * **同一类型的不同 keyword** 会（`tEXt:prompt#2` 与 `tEXt:workflow#2` 的 selector
 * 不同、类型相同），因此 id 与 selector 不能用同一套计数。
 *
 * 两个计数都**只看文件里的顺序**，不看任何别的东西 —— 同一份字节解析两次必须得到
 * 同一批名字，否则"上一次丢掉的那个块"在下一次解析里会对不上。
 */
function finalizeChunk(chunk: Chunk, selectorSeen: Map<string, number>, idSeen: Map<string, number>): void {
  const selectorCount = (selectorSeen.get(chunk.base) ?? 0) + 1;
  selectorSeen.set(chunk.base, selectorCount);
  chunk.selector = selectorCount === 1 ? chunk.base : `${chunk.base}#${selectorCount}`;

  const idCount = (idSeen.get(chunk.type) ?? 0) + 1;
  idSeen.set(chunk.type, idCount);
  // 只有同名不止一个块时才加序号 —— 静态图里几十个 IDAT 之外的块都想要一个干净
  // 的名字（`eXIf` 而不是 `eXIf#1`），而 IDAT 那几十个恰好需要序号
  chunk.id = idCount === 1 && selectorCount === 1 ? chunk.base : `${chunk.base}#${idCount}`;
}

// ============================================================
// 重建
// ============================================================

/**
 * 按选项重建一个 PNG。
 *
 * 三条不变量，任何一条破了都会产出"看起来正常但实际坏掉"的文件：
 *
 *   1. **结构性块永不丢。** `drop` 里写 `IHDR` 也不行 —— 那会让重建静默地毁掉文件，
 *      而用户点的是"清理元数据"。
 *   2. **IDAT 必须连续。** PNG 规范要求多个 IDAT 相邻（解码器可以据此流式解码）。
 *      因此追加的块一律插在**第一个 IDAT 之前**，绝不插进 IDAT 序列中间。
 *   3. **CRC 逐块重算。** 丢块之后每个块的位置都变了，而 CRC 只覆盖"类型 + 数据"
 *      （不含位置），因此只有被改动的块需要重算 —— 但重算是逐字节正确的，没有
 *      "看起来对"的余地。
 *
 * 与 `parsePng` 的对称性：把重建结果再喂给 `parsePng`，得到的块集合应当恰好是
 * "原来的块减去被丢的、加上被追加的"。这是本文件唯一的验收标准。
 */
function rebuildPng(chunks: Chunk[], options: RebuildOptions): Uint8Array {
  const drop = options.drop;
  const writer = new ByteWriter(1024);
  writer.bytes(new Uint8Array(SIGNATURE));

  // ---- 要写的块（结构：类型 + 数据） ----
  interface Out {
    type: string;
    data: Uint8Array;
  }
  const out: Out[] = [];

  // 追加的文本块先落成字节。**文本用 UTF-8**：现实中 A1111/ComfyUI 系的工具全部
  // 这么写，而 `latin1Encode` 会把中文变成问号 —— 一个不可逆、且用户会当成"工具
  // 把我的字弄坏了"的结果
  const appended: Out[] = [];
  for (const item of options.append) {
    const keyword = sanitizeKeyword(item.key);
    const body = new Uint8Array([...latin1BytesOf(keyword), 0, ...new TextEncoder().encode(item.value)]);
    appended.push({ type: 'tEXt', data: body });
  }

  // 方向回写。两种情况都不该写一个新的 eXIf：
  //
  //   * `orientation` 是 1（本来就正）—— 写它只会让文件多一段本不存在的 EXIF，
  //     而清理工具的目标恰恰是"更少的东西"。
  //   * 用户没说要丢原来那份 EXIF —— 那它会被原样保留，而 PNG 规范只允许一个
  //     `eXIf` 块。写两个的话，查看器取哪一个是不确定的（规范没规定），
  //     于是"方向保留"这件事变成了掷骰子。
  const wantsOrientation =
    options.keepOrientation && options.orientation !== null && options.orientation !== 1;
  const keepsOriginalExif = chunks.some(
    (chunk) => chunk.type === 'eXIf' && !chunk.structural && !drop.has(chunk.selector)
  );
  const orientationOnly =
    wantsOrientation && !keepsOriginalExif ? buildOrientationExif(options.orientation as number) : null;

  // ---- 决定插入点 ----
  // 追加块插在**第一个 IDAT 之前的最后一个文本块之后**（用户追加的自定义元数据
  // 自然排在他原有的那些后面）。没有这样的文本块就插在第一个 IDAT 之前。
  //
  // 两条候选位置的共同点是都**在第一个 IDAT 之前**，这是硬要求：PNG 规范要求多个
  // IDAT 相邻（解码器可以据此流式解码），因此任何插入都不能落进 IDAT 序列中间。
  // `lastTextIndex + 1` 恰好等于第一个 IDAT 时就是"紧邻 IDAT 之前"，同样安全。
  let lastTextBeforeIdat = -1;
  let firstIdatIndex = -1;
  for (let index = 0; index < chunks.length; index++) {
    if (chunks[index].type === 'IDAT') {
      firstIdatIndex = index;
      break;
    }
    if (TEXT_TYPES.has(chunks[index].type)) lastTextBeforeIdat = index;
  }
  const insertionIndex =
    lastTextBeforeIdat >= 0
      ? lastTextBeforeIdat + 1
      : firstIdatIndex >= 0
        ? firstIdatIndex
        : chunks.length;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];

    if (index === insertionIndex) {
      for (const item of appended) out.push(item);
      if (orientationOnly) out.push({ type: 'eXIf', data: orientationOnly });
    }

    if (chunk.structural) {
      // 结构性块无条件保留 —— 即使 `drop` 里点名要丢
      out.push({ type: chunk.type, data: chunk.data });
      continue;
    }
    if (drop.has(chunk.selector)) continue;
    out.push({ type: chunk.type, data: chunk.data });
  }

  // 插入点在末尾（没有 IDAT 的畸形文件）时上面那一轮不会触发
  if (insertionIndex >= chunks.length) {
    for (const item of appended) out.push(item);
    if (orientationOnly) out.push({ type: 'eXIf', data: orientationOnly });
  }

  for (const item of out) writeChunk(writer, item.type, item.data);
  return writer.toBytes();
}

/** 关键词的 Latin-1 字节。名字单列是因为它在上面那行内联表达式里读不出来 */
function latin1BytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** 模型转换。把内部记录收成 `ContainerBlock`，**不把内部字段漏出去** */
function toBlock(chunk: Chunk): ContainerBlock {
  return {
    id: chunk.id,
    selector: chunk.selector,
    label: chunk.label,
    group: chunk.group,
    text: chunk.text,
    bytes: chunk.declaredLength + 12,
    removable: chunk.removable,
    structural: chunk.structural,
    orientation: chunk.orientation,
  };
}
