// src/art-trace/codec/webp.ts
//
// WebP（RIFF 容器）的解析与**无损**重建。
//
// ============================================================
// 为什么 WebP 的元数据比它看起来更容易"没生效"
// ============================================================
//
// WebP 有两代结构：老的简单格式（`VP8 ` 有损 / `VP8L` 无损，两个 chunk 就完了）
// 与扩展格式（`VP8X` 打头，后面可以挂 `ICCP` / `ALPH` / `EXIF` / `XMP ` / 动画）。
//
// 关键的一条：扩展格式里，**元数据 chunk 存不存在是一回事，`VP8X` 有没有声明它是
// 另一回事**。`VP8X` 的 flags 字节里有 ICC / Alpha / EXIF / XMP / 动画五个位，严格的
// 解码器只看这些位：位没置，它就不会去读那个 chunk。
//
// 这带来两个方向的坑，本文件两个都要处理：
//
//   * **解析**：chunk 明明在、标志位没置 → 要把这句说出来。否则用户会奇怪
//     "我明明看到有 EXIF，工具却说没有"。
//   * **重建**：丢掉了 `EXIF` / `XMP ` / `ICCP` → 必须把对应的位清掉。不清的话，
//     文件里已经没有任何 EXIF 数据了，而 `VP8X` 还在向全世界声明"我有 EXIF" ——
//     这既是一个假的元数据痕迹，也会让部分解码器去读一个不存在的块。
//
// ============================================================
// RIFF 的长度与填充
// ============================================================
//
// `RIFF` 头里的 size 字段覆盖"`WEBP` 那 4 个字节 + 之后所有内容"，因此是
// 文件总长 − 8。每个 chunk 的数据后面如果长度是奇数，要补一个 `\0` 到偶数边界，
// 而**那个填充字节不计入 chunk 的 size 字段**。重建时这两件事都要重算 —— 少补一个
// 填充字节，后面所有 chunk 都会错位半个字节，表现为"图片能开但元数据全是乱码"。

import type { ImageInfo, MetaGroup } from '../model/types';
import type { ContainerBlock, FormatParse, RebuildOptions } from './format';
import { buildOrientationExif, parseExif } from './exif';
import { extractXmp, summarizeXmp } from './xmp';
import {
  ByteWriter,
  formatBytes,
  latin1Decode,
  latin1Encode,
  smartDecode,
  toDisplayText,
} from './bytes';

/** 一个 chunk：四字符码 + 数据。填充字节不在这里，重建时按需补 */
interface WebpChunk {
  block: ContainerBlock;
  /** 四字符码的原文，例如 `VP8X`、`XMP `（注意 XMP 后面有个空格） */
  fourcc: string;
  /** chunk 数据（不含 fourcc 与 size 字段），**视图** */
  data: Uint8Array;
  /** 原文件里这个 chunk 数据后面有没有填充字节 */
  hadPadding: boolean;
}

/** `VP8X` 的 flags 位。低 2 位保留不用 */
const FLAG_ICC = 0x20;
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;
const FLAG_ANIMATION = 0x02;

/** 常见 chunk 的名字（给用户看的说明） */
const CHUNK_LABELS: Record<string, string> = {
  'VP8 ': 'VP8（有损图像数据）',
  VP8L: 'VP8L（无损图像数据）',
  VP8X: 'VP8X（扩展格式头）',
  ALPH: 'ALPH（alpha 通道）',
  ANIM: 'ANIM（动画头）',
  ANMF: 'ANMF（动画帧）',
  EXIF: 'EXIF（拍摄信息）',
  'XMP ': 'XMP（元数据包）',
  ICCP: 'ICCP（ICC 色彩描述文件）',
};

interface WebpParseState {
  width: number;
  height: number;
  hasAlpha: boolean;
  animated: boolean;
  frames: number;
  lossless: boolean;
  exif: Uint8Array | null;
  orientation: number | null;
  xmp: string | null;
  iccBytes: number;
  c2pa: string[];
}

/**
 * 解析一个 WebP。
 *
 * 只有"缺 `RIFF` 或 `WEBP`"才算失败。chunk 长度超出文件、`RIFF` size 字段与实际
 * 不符 —— 这些都是**正常结果**：前者停止解析并保留已读到的 chunk，后者以实际字节
 * 为准并把这件事写进块里。
 */
export function parseWebp(bytes: Uint8Array): FormatParse {
  if (bytes.length < 12) {
    throw new Error('不是 WebP 文件：字节数不足 12（连 RIFF 头都放不下）');
  }
  if (latin1Decode(bytes.subarray(0, 4)) !== 'RIFF') {
    throw new Error('不是 WebP 文件：开头不是 RIFF');
  }
  if (latin1Decode(bytes.subarray(8, 12)) !== 'WEBP') {
    throw new Error('不是 WebP 文件：RIFF 后面不是 WEBP');
  }

  // RIFF size 覆盖 'WEBP' + 之后的内容，因此文件总长应当是 size + 8
  const declaredRiff = readU32Le(bytes, 4);
  const expectedLength = declaredRiff + 8;
  const sizeMismatch = expectedLength !== bytes.length;

  const state: WebpParseState = {
    width: 0,
    height: 0,
    hasAlpha: false,
    animated: false,
    frames: 0,
    lossless: false,
    exif: null,
    orientation: null,
    xmp: null,
    iccBytes: 0,
    c2pa: [],
  };

  const chunks: WebpChunk[] = [];
  const present = new Set<string>();
  let vp8xFlags: number | null = null;
  let at = 12;
  let truncated = false;

  while (at + 8 <= bytes.length) {
    const chunkStart = at;
    const fourcc = latin1Decode(bytes.subarray(at, at + 4));
    const size = readU32Le(bytes, at + 4);
    const dataStart = at + 8;
    const dataEnd = dataStart + size;
    // 单数长度要补一个填充字节才能到偶数边界
    const padded = dataEnd + (size % 2);
    // chunk 内容超出文件：**不抛错**，把它按剩余字节收下并停止。真实文件里
    // "最后一个 chunk 的长度字段是坏的"很常见，而此时前面那些 chunk 完全可用
    const overruns = dataEnd > bytes.length;
    const effectiveEnd = Math.min(dataEnd, bytes.length);
    const data = bytes.subarray(dataStart, effectiveEnd);
    let truncatedHere = false;
    if (overruns) {
      truncated = true;
      truncatedHere = true;
    } else if (padded > bytes.length) {
      // 数据是完整的，只缺最后那个填充字节（例如文件被砍掉一个字节）
      truncated = true;
    }

    if (fourcc === 'VP8X' && data.length >= 10) {
      vp8xFlags = data[0];
    }
    present.add(fourcc);

    chunks.push({
      block: describeChunk(chunkStart, fourcc, data, size, truncatedHere, state),
      fourcc,
      data,
      hadPadding: padded <= bytes.length && size % 2 === 1,
    });

    if (fourcc === 'ANMF') state.frames++;
    if (fourcc === 'ANIM') state.animated = true;
    // alpha 可以从三处得知：VP8X 的标志位、独立的 ALPH chunk、VP8L 位流里的位
    if (fourcc === 'ALPH' || fourcc === 'VP8L') state.hasAlpha = true;

    if (overruns) break;
    at = padded;
  }

  // 走完 chunk 之后还剩字节（或者一开始就进不去循环）：末尾有垃圾，或者文件被
  // 截断在 chunk 中间。记一句，不要静默吞掉 —— "无损工具"丢字节必须说出来
  const tailBytes = truncated ? 0 : bytes.length - at;

  if (state.frames === 0) state.frames = 1; // 静态图算一帧

  const flagNotes: string[] = [];
  if (sizeMismatch) {
    flagNotes.push(
      `RIFF 头声明总长 ${expectedLength} 字节，实际 ${bytes.length} 字节，以实际为准`
    );
  }
  if (truncated) flagNotes.push('chunk 数据超出文件（截断）');
  if (tailBytes > 0) {
    flagNotes.push(`末尾还有 ${formatBytes(tailBytes)} 字节不属于任何 chunk，重建时不会保留`);
  }

  // 解析尺寸。VP8X 优先（它是扩展格式的权威来源），否则回到帧头
  if (!resolveSize(chunks, state, vp8xFlags)) {
    // 认不出帧头时宽高留 0，并把原因挂到第一个结构性块上（见 format.ts 的
    // 硬约束：解析失败要说得出为什么）
    const first = chunks.find((chunk) => chunk.block.structural);
    if (first) {
      first.block.text = `${first.block.text}；读不出画布尺寸（帧头不是已知的 VP8 / VP8L 布局）`;
    }
  }

  // ---- 标志位与可见性：这一层是 WebP 最容易被忽略的地方 ----
  for (const chunk of chunks) {
    const bit = flagFor(chunk.fourcc);
    if (bit === null || vp8xFlags === null) continue;
    if ((vp8xFlags & bit) === 0) {
      // chunk 在，但 VP8X 没声明它 → 严格解码器会当它不存在
      chunk.block.text = `存在，但 VP8X 未声明该块（严格解码器会忽略）—— ${chunk.block.text}`;
    }
  }

  // 把"结构层面的毛病"挂到第一个结构性块上。它永远保留，因此这些话不会因为
  // 用户丢掉了某个元数据块就跟着消失
  if (flagNotes.length > 0) {
    const anchor = chunks.find((chunk) => chunk.block.structural);
    if (anchor) anchor.block.text = `${anchor.block.text}（${flagNotes.join('；')}）`;
  }

  const info = buildInfo(bytes.length, state);

  return {
    info,
    blocks: chunks.map((chunk) => chunk.block),
    exif: state.exif,
    xmp: state.xmp,
    iccBytes: state.iccBytes,
    c2pa: state.c2pa,
    rewritable: true,
    blockedReason: null,
    rebuild: (options: RebuildOptions) => rebuildWebp(chunks, options),
  };
}

/** 小端 32 位。调用前必须自己确认边界（这个文件里所有读整数的地方都先算过长度） */
function readU32Le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  );
}

/** 小端 24 位（VP8X 的 canvas 尺寸用 3 字节存） */
function readU24Le(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

/** 这个 fourcc 在 VP8X 里对应哪一位（没有对应关系则 null） */
function flagFor(fourcc: string): number | null {
  switch (fourcc) {
    case 'ICCP':
      return FLAG_ICC;
    case 'EXIF':
      return FLAG_EXIF;
    case 'XMP ':
      return FLAG_XMP;
    case 'ALPH':
      return FLAG_ALPHA;
    case 'ANIM':
    case 'ANMF':
      return FLAG_ANIMATION;
    default:
      return null;
  }
}

/**
 * 把画布尺寸解出来。
 *
 * 三个来源依次退让：`VP8X` 的 canvas（权威）→ `VP8 ` 的帧头 → `VP8L` 的位流头。
 * 返回 false 表示三个都没读出来。
 */
function resolveSize(chunks: WebpChunk[], state: WebpParseState, vp8xFlags: number | null): boolean {
  const vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X');
  if (vp8x && vp8x.data.length >= 10) {
    // canvas 的宽高各 3 字节小端，**存的是减 1 之后的值**（1..2^24）
    state.width = readU24Le(vp8x.data, 4) + 1;
    state.height = readU24Le(vp8x.data, 7) + 1;
    if (vp8xFlags !== null) {
      state.hasAlpha = state.hasAlpha || (vp8xFlags & FLAG_ALPHA) !== 0;
      state.animated = state.animated || (vp8xFlags & FLAG_ANIMATION) !== 0;
    }
    return true;
  }

  const lossless = chunks.find((chunk) => chunk.fourcc === 'VP8L');
  if (lossless && lossless.data.length >= 5) {
    const data = lossless.data;
    // VP8L 的第一个字节是签名 0x2F，后面 4 字节小端里：低 14 位 = 宽-1，
    // 接着 14 位 = 高-1，再 1 位 = 有没有 alpha，最后 3 位是版本
    if (data[0] === 0x2f) {
      const bits = readU32Le(data, 1);
      state.width = (bits & 0x3fff) + 1;
      state.height = ((bits >>> 14) & 0x3fff) + 1;
      state.hasAlpha = (bits & 0x10000000) !== 0 || state.hasAlpha;
      state.lossless = true;
      return true;
    }
    // 签名不对：不要按 VP8L 解读，那样会给出一个看起来很正常的错误宽高
    return false;
  }

  const lossy = chunks.find((chunk) => chunk.fourcc === 'VP8 ');
  if (lossy && lossy.data.length >= 10) {
    const data = lossy.data;
    // 关键帧的帧头：3 字节 frame tag，然后是起始码 9D 01 2A，再是宽高各 2 字节
    // （小端，各 14 位有效）。检查起始码是为了不把非关键帧的数据当尺寸读
    if (data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      state.width = (data[6] | (data[7] << 8)) & 0x3fff;
      state.height = (data[8] | (data[9] << 8)) & 0x3fff;
      return true;
    }
    return false;
  }

  return false;
}

/** 把一个 chunk 描述成一个块（含它自己那一块元数据的解读） */
function describeChunk(
  at: number,
  fourcc: string,
  data: Uint8Array,
  declaredSize: number,
  truncated: boolean,
  state: WebpParseState,
): ContainerBlock {
  const label = CHUNK_LABELS[fourcc] ?? fourcc;
  // 块占的字节数按容器里的实际形状算：fourcc(4) + size(4) + 数据 + 填充
  const containerBytes = 8 + declaredSize + (declaredSize % 2);
  const structural =
    fourcc === 'VP8X' ||
    fourcc === 'VP8 ' ||
    fourcc === 'VP8L' ||
    fourcc === 'ALPH' ||
    fourcc === 'ANIM' ||
    fourcc === 'ANMF';

  let group: MetaGroup = 'other';
  let text = '';
  let removable = true;
  let orientation: number | null = null;

  switch (fourcc) {
    case 'VP8X': {
      group = 'structural';
      removable = false;
      const flags = data.length >= 10 ? data[0] : 0;
      const declared: string[] = [];
      if (flags & FLAG_ICC) declared.push('ICC');
      if (flags & FLAG_ALPHA) declared.push('Alpha');
      if (flags & FLAG_EXIF) declared.push('EXIF');
      if (flags & FLAG_XMP) declared.push('XMP');
      if (flags & FLAG_ANIMATION) declared.push('动画');
      text = `扩展格式头，声明：${declared.length > 0 ? declared.join(' / ') : '（无）'}`;
      break;
    }
    case 'VP8 ': {
      group = 'structural';
      removable = false;
      text = '有损图像数据（VP8）。像素数据原样搬运，不重新编码';
      break;
    }
    case 'VP8L': {
      group = 'structural';
      removable = false;
      state.lossless = true;
      text = '无损图像数据（VP8L）。像素数据原样搬运，不重新编码';
      break;
    }
    case 'ALPH': {
      group = 'structural';
      removable = false;
      text = 'alpha 通道（独立存储的透明度）';
      break;
    }
    case 'ANIM': {
      group = 'structural';
      removable = false;
      const loops =
        data.length >= 6 ? (data[4] | (data[5] << 8)) : null;
      text = `动画头，循环次数 ${loops === null ? '读不出' : loops === 0 ? '无限' : loops}`;
      break;
    }
    case 'ANMF': {
      group = 'structural';
      removable = false;
      text = `动画帧，${formatBytes(data.length)}`;
      break;
    }
    case 'EXIF': {
      group = 'exif';
      removable = true;
      // WebP 的 EXIF chunk 装的是**裸 TIFF 字节**，不像 JPEG 的 APP1 那样带
      // `Exif\0\0` 前缀。带上前缀解析会整体偏 6 字节，读出满屏垃圾
      text = `EXIF 拍摄信息，${formatBytes(data.length)}`;
      try {
        const parsed = parseExif(data);
        orientation = parsed.orientation;
        if (state.orientation === null) state.orientation = orientation;
        if (parsed.fields.length > 0) {
          text = `EXIF 拍摄信息，${parsed.fields.length} 项${
            orientation !== null && orientation !== 1 ? `，方向 ${orientation}` : ''
          }`;
        }
      } catch (error) {
        text = `EXIF 拍摄信息，${formatBytes(data.length)}；字段解析失败：${errorText(error)}`;
      }
      if (state.exif === null) state.exif = data;
      break;
    }
    case 'XMP ': {
      group = 'xmp';
      removable = true;
      try {
        const xmp = extractXmp(data) ?? smartDecode(data);
        state.xmp = xmp;
        text = `XMP 包，${formatBytes(data.length)}${summarize(xmp)}`;
      } catch (error) {
        state.xmp = null;
        text = `XMP 包，${formatBytes(data.length)}；提取失败：${errorText(error)}`;
      }
      break;
    }
    case 'ICCP': {
      group = 'icc';
      // ICC 不是隐私，是"这些数字该被解释成什么颜色"。丢了广色域作品会明显偏色，
      // 而用户要的是抹掉痕迹，不是把图弄坏
      removable = false;
      state.iccBytes += data.length;
      text = `ICC 色彩描述文件，${formatBytes(data.length)}`;
      break;
    }
    default: {
      // 认不出的 chunk。它可能是 C2PA（`C2PA` 是正在讨论中的 fourcc），
      // 因此顺带看一眼里面有没有那两个签名
      text = `未知 chunk，${formatBytes(data.length)}，开头：${toDisplayText(preview(data, 8), 60)}`;
      if (data.length >= 4) {
        const head = latin1Decode(data.subarray(0, 4));
        if (/^(jumb|c2pa|C2PA)$/i.test(head)) {
          group = 'c2pa';
          state.c2pa.push(`chunk ${fourcc} 里出现 ${head} 签名`);
          text = `内容凭证（C2PA / JUMBF），${formatBytes(data.length)}`;
        }
      }
      break;
    }
  }

  if (truncated) text = `${text}（chunk 数据超出文件，已按剩余字节收下）`;

  return {
    // id 用"fourcc + 在原文件里的偏移"：同一份字节解析两次必然得到同一批 id，
    // 而 fourcc 单独用不够 —— 动画可以有一串 ANMF
    id: `webp:${fourcc}:${at}`,
    selector: fourcc,
    label: `${label}(${fourcc.trim()})`,
    group,
    text,
    bytes: containerBytes,
    removable,
    structural,
    orientation,
  };
}

/** 二进制 chunk 的开头几个字节，按"像什么就按什么"解，控制字符换成点 */
function preview(data: Uint8Array, count: number): string {
  return smartDecode(data.subarray(0, count)).replace(/[\u0000-\u001f\u007f]/g, '.');
}

function summarize(xmp: string): string {
  try {
    const items = summarizeXmp(xmp);
    if (items.length === 0) return '';
    const head = items
      .slice(0, 4)
      .map((item) => `${item.key}=${item.value}`)
      .join('，');
    return `，${items.length} 项：${toDisplayText(head, 160)}`;
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildInfo(fileLength: number, state: WebpParseState): ImageInfo {
  const kind = state.lossless ? '无损' : '有损';
  const alpha = state.hasAlpha ? '，含 alpha' : '';
  return {
    format: 'webp',
    width: state.width,
    height: state.height,
    // WebP 没有"位深"这个容器字段：无损的是预测编码，有损的是 8 位 YUV420。
    // 报一个数字比报 null 更像在胡说，因此这里诚实地说 null
    bitDepth: null,
    colorModel: `${kind}${alpha}`,
    // WebP 没有隔行扫描的概念（动画是另一回事，由 animated 表达）
    interlaced: false,
    animated: state.animated || state.frames > 1,
    frames: state.frames,
    bytes: fileLength,
  };
}

// ============================================================
// 重建
// ============================================================

/**
 * 按丢掉集合与追加集合重建一个 WebP。
 *
 * 顺序：`RIFF` + size + `WEBP` → 保留的 chunk（按原顺序，padding 重算）→ 新增的
 * `EXIF`。
 *
 * `VP8X` 的标志位**必须跟着一起改**：丢掉了 `EXIF` 就把 EXIF 位清掉。不清的话，
 * 重建出来的文件里已经没有任何 EXIF 数据，而 `VP8X` 还在向解码器声明"我有" ——
 * 这本身就是一条假的元数据痕迹，而且会让严格解码器去找一个不存在的块。
 */
function rebuildWebp(chunks: WebpChunk[], options: RebuildOptions): Uint8Array {
  // 先算清楚"留下来的是哪些"，因为 VP8X 的标志位要看最终结果而不是原文件
  const kept: WebpChunk[] = [];
  const relevant: WebpChunk[] = [];
  let vp8x: WebpChunk | null = null;
  for (const chunk of chunks) {
    // **结构性 chunk 永远保留，哪怕 drop 里点了名。** 这条不变量守在这里而不是
    // 策略层：`VP8X`/`VP8 `/`VP8L`/`ALPH`/`ANIM`/`ANMF` 少一个就是一张坏图或一段
    // 坏动画，而 `rebuild` 是公开接口 —— 安全网必须放在最后一个能拦住它的地方。
    // （与 PNG 模块一致：PNG 也拒绝丢掉 IHDR/IDAT/IEND。）
    if (!chunk.block.structural && options.drop.has(chunk.block.selector)) continue;
    if (chunk.fourcc === 'VP8X') {
      // VP8X 有两个身份：它是"扩展格式头"（结构性），同时它的 flags 又要按最终
      // 留下的 chunk 重算。因此这里单独收下、稍后重写，而不是直接搬
      vp8x = chunk;
      continue;
    }
    kept.push(chunk);
    if (flagFor(chunk.fourcc) !== null) relevant.push(chunk);
  }

  const body = new ByteWriter(4096);

  // 方向回写要在写 VP8X 之前算好：EXIF 位必须跟"最终真的会写这个 chunk"一致，
  // 否则又是"声明了却没有"（或者反过来）的错配
  const orientationExif = shouldWriteOrientation(options)
    ? buildOrientationExifOrNull(options.orientation)
    : null;

  if (vp8x) {
    let flags = syncFlags(vp8x.data, relevant);
    // 写回了 EXIF chunk，就把 EXIF 位置起来。这是唯一一处**置位**的地方 ——
    // 因为这里我们确实会写出那个 chunk
    if (orientationExif && orientationExif.length > 0) flags |= FLAG_EXIF;
    body.bytes(latin1Encode('VP8X'));
    body.u32le(10);
    body.u8(flags);
    // flags 之后的 9 字节（2 字节保留位 + canvas 宽高）原样保留：canvas 尺寸由
    // 像素数据决定，重建不改像素，因此不能动它
    body.bytes(vp8x.data.subarray(1, 10));
  }

  for (const chunk of kept) {
    body.bytes(latin1Encode(chunk.fourcc));
    body.u32le(chunk.data.length);
    body.bytes(chunk.data);
    // 单数长度补一个 0 到偶数边界。**这个字节不计入 chunk 的 size 字段**
    if (chunk.data.length % 2 === 1) body.u8(0);
  }

  // 方向回写：WebP 的方向在 EXIF 里，因此写回一个只含方向的最小 EXIF chunk
  if (orientationExif && orientationExif.length > 0) {
    body.bytes(latin1Encode('EXIF'));
    body.u32le(orientationExif.length);
    body.bytes(orientationExif);
    if (orientationExif.length % 2 === 1) body.u8(0);
  }

  const bodyBytes = body.toBytes();
  const writer = new ByteWriter(bodyBytes.length + 12);
  writer.bytes(latin1Encode('RIFF'));
  // size 覆盖 'WEBP' + 之后的所有内容
  writer.u32le(bodyBytes.length + 4);
  writer.bytes(latin1Encode('WEBP'));
  writer.bytes(bodyBytes);
  return writer.toBytes();
}

/** 方向回写的前提：要求保留、方向有效且不是"正常朝向" */
function shouldWriteOrientation(options: RebuildOptions): boolean {
  if (!options.keepOrientation) return false;
  const orientation = options.orientation;
  return orientation !== null && orientation !== 1;
}

function buildOrientationExifOrNull(orientation: number | null): Uint8Array | null {
  if (orientation === null) return null;
  try {
    return buildOrientationExif(orientation);
  } catch {
    // `buildOrientationExif` 还在实现中，而且在畸形数据上也可能抛错。造不出来就
    // 不写 —— 让"清理"整体失败比丢一个方向更糟
    return null;
  }
}

/**
 * 按**最终保留下来的** chunk 重算 `VP8X` 的 flags 字节。
 *
 * 五个位逐一对照实际存在的 chunk：ICCP / ALPH / EXIF / XMP / 动画。这里只清位、
 * 不置位（除了方向回写那条路径会在之后补上 EXIF 位）—— 凭空置位会让解码器去找
 * 一个不存在的块，那比少一个位更坏。
 *
 * 返回新的 flags 字节，其余 9 个字节（保留位 + canvas 尺寸）原样保留：canvas 的
 * 值由像素数据决定，重建不改像素，因此不能动它。
 */
function syncFlags(vp8xData: Uint8Array, relevant: WebpChunk[]): number {
  let flags = vp8xData.length >= 1 ? vp8xData[0] : 0;
  const presence = new Set(relevant.map((chunk) => chunk.fourcc));

  // VP8X 自己声明的 alpha 位不能只看 ALPH：位图 alpha 也可以编码在 VP8L/VP8 内部，
  // 那种情况下没有 ALPH chunk 而位是对的。因此 alpha 位**只清不置**
  if (!presence.has('ICCP')) flags &= ~FLAG_ICC;
  if (!presence.has('EXIF')) flags &= ~FLAG_EXIF;
  if (!presence.has('XMP ')) flags &= ~FLAG_XMP;
  if (!presence.has('ANIM') && !presence.has('ANMF')) flags &= ~FLAG_ANIMATION;
  return flags;
}
