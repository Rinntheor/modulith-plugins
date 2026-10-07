// src/art-trace/codec/jpeg.ts
//
// JPEG（JFIF / Exif / SPIFF）容器的解析与**无损**重建。
//
// ============================================================
// 为什么段式解析必须在 SOS 处停下
// ============================================================
//
// JPEG 由一串 `[FF][marker][payload]` 段组成，每段自带头长 —— 这个规律在 `SOS`
// （`FFDA`）之前成立，之后**完全不成立**：`SOS` 后面是熵编码数据，它是一串经过
// 填充的比特流，里面到处是 `FF`（每到 `FF` 就补一个 `00` 写出去），还有 `FFD0..FFD7`
// 的重启标记。
//
// 如果继续按"读段头、跳段长"的方式解析熵编码数据，会把里面碰巧出现的两个字节当成
// 段长，从此彻底错位 —— 表现为"这张图的元数据列表莫名其妙"，或者更糟：重建出来的
// 文件看起来正常，像素却坏了。因此这里的分工是死板的：
//
//   SOS 之前 —— 逐段解析，每段单独成一个可丢弃的块
//   SOS 之后 —— 不解析，整段原样搬运
//
// ============================================================
// 熵编码数据到哪里为止：为什么扫 FFD9 而不是算长度
// ============================================================
//
// 严格的做法是按 `SOS` 头里的分量表把这一帧的 MCU 数算出来，再按熵解码走完 ——
// 那等于实现半个解码器，而我们一个字都不需要改。相对可靠的替代是**从 `SOS` 往后
// 找第一个真正的 `FFD9`**：
//
//   * 熵数据里不可能出现裸露的 `FFD9`。编码时每个 `FF` 都要补 `00`，而 `FFD0..FFD7`
//     的重启标记是另外几个值，因此 `FF` 后面直接跟 `D9` 只可能是 EOI。
//   * 反过来（按长度算）一旦算错，就再也找不回边界了；而扫描最多读到文件尾，
//     截断的文件也退化成"没有 EOI"这个明确的结果。
//
// 所以扫描既简单又不会比算长度更不可靠。

import type { ImageInfo, MetaGroup } from '../model/types';
import type { ContainerBlock, FormatParse, RebuildOptions } from './format';
import { buildOrientationExif, parseExif } from './exif';
import { extractXmp, summarizeXmp } from './xmp';
import type { ExifField } from '../model/types';
import {
  ByteWriter,
  formatBytes,
  indexOfBytes,
  latin1Encode,
  smartDecode,
  startsWithBytes,
  toDisplayText,
} from './bytes';

/**
 * 一段在重建时要不要保留。
 *
 * 只留下重建真正需要的两样东西：块的元信息（选择键在其中）与它在原文件里的原始
 * 字节视图。**不复制**段体 —— 一张 30 MB 的 JPEG 有几十个段，逐段复制一份等于
 * 在内存里放两张图，而批量清理时这件事会对每一张发生。
 */
interface JpegSegment {
  block: ContainerBlock;
  /** 段自身（含 2 字节标记），**视图**，不复制。熵编码数据块用空数组（见下） */
  raw: Uint8Array;
  /**
   * 这个块是"SOS 段头之后的熵编码数据"，而不是一段常规的段。
   *
   * 为什么需要一个显式标志：熵编码数据在 `blocks` 里单独成块（它太大、又永远不可能
   * 被丢掉，混进 SOS 段头里会让那个块的数字变得没法解释），但它的字节不在 `raw` 里
   * ——只在 `scan` 里。重建时它必须**紧跟**在 SOS 段头后面写出，中间不能插任何东西。
   * 靠"raw 是不是空的"来判断太脆（一个空的常规段会骗过它），因此用显式标志。
   */
  isEntropy: boolean;
}

interface JpegParseState {
  width: number;
  height: number;
  bitDepth: number | null;
  /** SOF 里的分量个数。0 表示还没读到 SOF（截断文件） */
  components: number;
  progressive: boolean;
  /** SOF 的标记码，用于在块里说明"这是 SOF0 还是 SOF2" */
  sofMarker: number | null;
  exif: Uint8Array | null;
  orientation: number | null;
  xmp: string | null;
  iccBytes: number;
  c2pa: string[];
  /** 无法解释的毛病（截断、长度说谎……），拼进相关块的 text 里给用户看 */
  notes: string[];
}

const EXIF_PREFIX = latin1Encode('Exif\0\0');
const XMP_PREFIX = latin1Encode('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT_PREFIX = latin1Encode('http://ns.adobe.com/xmp/extension/\0');
const ICC_PREFIX = latin1Encode('ICC_PROFILE\0');
const JFIF_PREFIX = latin1Encode('JFIF\0');
const JUMBF_SIGNATURE = latin1Encode('jumb');
const C2PA_SIGNATURE = latin1Encode('c2pa');

/**
 * SOS 段与其后的熵编码数据合起来用一个选择键。
 *
 * 为什么不把"熵编码数据"单列成一个块：它和 SOS 是一个不可分割的整体（SOS 的头
 * 必须紧挨着扫描数据），而且它**永远不可能被丢掉**。分成两块只会让界面上多出一行
 * 用户既看不懂也点不动的东西。
 */
const SOS_SELECTOR = 'SOS';

/** 段名表。APPn 之外的段都有固定名字 */
const SEGMENT_NAMES: Record<number, string> = {
  0xc0: 'SOF0',
  0xc1: 'SOF1',
  0xc2: 'SOF2',
  0xc3: 'SOF3',
  0xc4: 'DHT',
  0xc5: 'SOF5',
  0xc6: 'SOF6',
  0xc7: 'SOF7',
  0xc8: 'JPG',
  0xc9: 'SOF9',
  0xca: 'SOF10',
  0xcb: 'SOF11',
  0xcc: 'DAC',
  0xcd: 'SOF13',
  0xce: 'SOF14',
  0xcf: 'SOF15',
  0xda: 'SOS',
  0xdb: 'DQT',
  0xdd: 'DRI',
  0xe0: 'APP0',
  0xe1: 'APP1',
  0xe2: 'APP2',
  0xe3: 'APP3',
  0xe4: 'APP4',
  0xe5: 'APP5',
  0xe6: 'APP6',
  0xe7: 'APP7',
  0xe8: 'APP8',
  0xe9: 'APP9',
  0xea: 'APP10',
  0xeb: 'APP11',
  0xec: 'APP12',
  0xed: 'APP13',
  0xee: 'APP14',
  0xef: 'APP15',
  0xfe: 'COM',
};

/**
 * 是不是 SOF（帧头）。
 *
 * `FFC0..FFCF` 里只有一部分是 SOF：`FFC4` 是 DHT、`FFC8` 是 JPG、`FFCC` 是 DAC。
 * 把它们当成帧头会把 DHT 的内容按帧头解读，读出来的宽高是垃圾值 —— 而"宽高看起来
 * 像是几十万"这种结果没人会去怀疑是段名表写错了。
 */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** 结构性段：丢了文件就坏。它们永远保留 */
function isStructuralMarker(marker: number): boolean {
  return (
    isSofMarker(marker) ||
    marker === 0xc4 || // DHT
    marker === 0xdb || // DQT
    marker === 0xdd || // DRI
    marker === 0xda // SOS
  );
}

function segmentName(marker: number): string {
  const known = SEGMENT_NAMES[marker];
  if (known) return known;
  // APPn 之外的未知段用十六进制写出来，这样用户能拿去搜
  return `FF${marker.toString(16).toUpperCase().padStart(2, '0')}`;
}

function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return indexOfBytes(haystack, needle) >= 0;
}

/** 在 payload 里找一段 ASCII 签名第一次出现的位置（找不到 -1） */
function signatureAt(payload: Uint8Array, signature: Uint8Array): number {
  return indexOfBytes(payload, signature);
}

/** 把 segment 的原始字节写进输出。写的是视图，因此这里一次拷贝就够了 */
function writeRaw(writer: ByteWriter, segment: JpegSegment): void {
  writer.bytes(segment.raw);
}

// ============================================================
// 解析
// ============================================================

/**
 * 解析一个 JPEG。
 *
 * 只有"连 SOI 都没有"才算失败（抛错，由 `format.ts` 的容器层翻译成给用户看的一句话）。
 * 段长度非法、文件被截断、APP1 里是一包看不懂的字节 —— 这些都是**正常结果**，
 * 已经解析出来的段照样返回。
 */
export function parseJpeg(bytes: Uint8Array): FormatParse {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('不是 JPEG 文件：开头没有 FFD8（SOI）');
  }

  const state: JpegParseState = {
    width: 0,
    height: 0,
    bitDepth: null,
    components: 0,
    progressive: false,
    sofMarker: null,
    exif: null,
    orientation: null,
    xmp: null,
    iccBytes: 0,
    c2pa: [],
    notes: [],
  };
  const segments: JpegSegment[] = [];
  let scan: { start: number; raw: Uint8Array } | null = null;

  let at = 2; // 跳过 SOI
  let stopped = false;

  while (at < bytes.length && !stopped) {
    const header = bytes[at];
    if (header === undefined || header !== 0xff) {
      // 期望段边界上是 FF。这里不抛错是因为真实的坏文件就是这样，而"已经读到的
      // 那几个段"对用户仍然有价值
      state.notes.push(`位置 ${at} 处不是段标记（读到 0x${(header ?? 0).toString(16)}），从这里停止解析`);
      break;
    }
    let markerAt = at;
    // 段标记前面允许有任意多个 FF 填充字节，真正的标记码是最后一个 FF 之后那个
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++;
    if (markerAt >= bytes.length) {
      state.notes.push('文件在段标记的填充字节处结束（截断）');
      break;
    }
    const marker = bytes[markerAt];
    const next = markerAt + 1;

    if (marker === 0xd9) {
      // EOI。正常路径下我们在 SOS 里就已经停下了，走到这里说明这份文件没有 SOS
      // （例如只有元数据的骨架文件），把 EOI 也当成结构性块保住
      const raw = bytes.subarray(at, next);
      segments.push({
        block: {
          id: `jpeg:0x${marker.toString(16)}:${at}`,
          selector: 'EOI',
          label: 'EOI（图像结束）',
          group: 'structural',
          text: '图像数据结束标记',
          bytes: raw.length,
          removable: false,
          structural: true,
          orientation: null,
        },
        raw,
        isEntropy: false,
      });
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // TEM 与 RSTn 是**独立**标记，后面没有长度字段，占 2 字节
      const raw = bytes.subarray(at, next);
      segments.push({
        block: {
          id: `jpeg:0x${marker.toString(16)}:${at}`,
          selector: `FF${marker.toString(16).toUpperCase()}`,
          label: `FF${marker.toString(16).toUpperCase()}（独立标记）`,
          group: 'other',
          text: '无长度字段的独立标记',
          bytes: raw.length,
          removable: false,
          structural: false,
          orientation: null,
        },
        raw,
        isEntropy: false,
      });
      at = next;
      continue;
    }

    if (next + 2 > bytes.length) {
      state.notes.push(`位置 ${at} 的段标记 ${segmentName(marker)} 后面没有长度字段（文件截断）`);
      break;
    }
    // 长度字段包含它自己那 2 字节，因此段体长度是 length - 2
    const length = (bytes[next] << 8) | bytes[next + 1];
    if (length < 2 || next + length > bytes.length) {
      // 这是要求里明确的一条：长度非法时**停止解析并保留已解析的段**，不抛错。
      // 抛错会让一张只有一处坏段的好图整个打不开
      state.notes.push(
        `段 ${segmentName(marker)} 的长度字段是 ${length}（位置 ${at}，文件长 ${bytes.length}），说明文件截断或长度说谎；从这里停止解析`
      );
      break;
    }

    const end = next + length;
    const raw = bytes.subarray(at, end);
    const payload = bytes.subarray(next + 2, end);

    if (isStructuralMarker(marker)) {
      segments.push(buildStructuralSegment(marker, at, raw, payload, state));
      if (marker === 0xda) {
        // SOS：段头读完了，后面全是熵编码数据。**不再按段解析**，见文件头的说明
        const entropyStart = end;
        const eoiAt = findEoi(bytes, entropyStart);
        const entropyEnd = eoiAt < 0 ? bytes.length : eoiAt + 2;
        if (eoiAt < 0) {
          state.notes.push('没有找到 EOI（FFD9），文件在熵编码数据中途结束（截断）');
        }
        scan = { start: entropyStart, raw: bytes.subarray(entropyStart, entropyEnd) };
        segments.push(
          buildEntropySegment(entropyStart, entropyEnd, eoiAt, bytes.length, state),
        );
        stopped = true;
        break;
      }
    } else {
      segments.push(buildMetadataSegment(marker, at, raw, payload, state));
    }

    at = end;
  }

  // 一段都没有解析出来时，把"为什么"说清楚 —— 否则界面上只有一张空列表
  if (segments.length === 0 && state.notes.length === 0) {
    state.notes.push('这个文件里没有任何可识别的段');
  }

  const info = buildInfo(bytes.length, state);

  return {
    info,
    blocks: segments.map((segment) => segment.block),
    exif: state.exif,
    xmp: state.xmp,
    iccBytes: state.iccBytes,
    c2pa: state.c2pa,
    rewritable: true,
    blockedReason: null,
    rebuild: (options: RebuildOptions) => rebuildJpeg(segments, scan, options),
  };
}

/**
 * 找 EOI。见文件头对"为什么扫描 FFD9 就够"的说明。
 *
 * 逐字节走是必要的：`indexOfBytes` 会命中熵数据里 `FF00` 填充之后的 `D9`，
 * 从而把一个字节当成 EOI 的第二个字节。
 */
function findEoi(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue;
    const next = bytes[i + 1];
    if (next === 0xd9) return i; // 真正的 EOI
    if (next === 0xff) {
      i--; // 连着多个 FF：下轮从后一个 FF 重新判断
      continue;
    }
    // FF00 是填充、FFD0..FFD7 是重启标记，两者都在熵数据里合法出现，继续找
  }
  return -1;
}

function buildStructuralSegment(
  marker: number,
  at: number,
  raw: Uint8Array,
  payload: Uint8Array,
  state: JpegParseState,
): JpegSegment {
  const name = segmentName(marker);
  let text = '结构性段，丢了文件就坏';
  let descriptor = name;

  if (isSofMarker(marker)) {
    // SOF 的布局：精度(1) 高(2) 宽(2) 分量数(1) + 每个分量 3 字节
    if (payload.length >= 6) {
      state.bitDepth = payload[0];
      state.height = (payload[1] << 8) | payload[2];
      state.width = (payload[3] << 8) | payload[4];
      state.components = payload[5];
      state.sofMarker = marker;
    } else {
      state.notes.push(`${name} 段太短（${payload.length} 字节），读不出宽高`);
    }
    // 渐进式是 SOF2。它影响的是解码顺序，不是元数据
    state.progressive = marker === 0xc2;
    const parts = [`${state.width}×${state.height}`];
    if (state.bitDepth !== null) parts.push(`${state.bitDepth} 位`);
    if (state.components > 0) parts.push(`${state.components} 分量`);
    if (state.progressive) parts.push('渐进式');
    text = parts.join('，');
    descriptor = `${name}（${state.width}×${state.height}）`;
  } else if (marker === 0xc4) {
    text = '霍夫曼表（熵编码用）';
    descriptor = 'DHT（霍夫曼表）';
  } else if (marker === 0xdb) {
    text = '量化表（有损程度就存在这里）';
    descriptor = 'DQT（量化表）';
  } else if (marker === 0xdd) {
    // DRI 的长度是 4：2 字节长度 + 2 字节重启间隔
    const interval = payload.length >= 2 ? (payload[0] << 8) | payload[1] : null;
    text = interval === null ? '重启间隔' : `重启间隔 ${interval} 个 MCU`;
    descriptor = 'DRI（重启间隔）';
  } else if (marker === 0xda) {
    // SOS 的头里带分量数与精度：**这两个值在 SOF 里也有**，读它是为了在 SOF 缺失
    // （截断文件）时仍能说出一点东西
    const components = payload.length >= 1 ? payload[0] : 0;
    const bits = [];
    bits.push(`${components} 个分量参与扫描`);
    if (payload.length >= 1 + components * 2 + 3) {
      // 分量表(1+n*2) + 谱选起始(1) + 谱选结束(1) + 逐次逼近(1)
      const pred = payload[1 + components * 2 + 2];
      bits.push(`逐次逼近 0x${pred.toString(16).padStart(2, '0')}`);
    }
    text = bits.join('，');
    descriptor = `SOS（${components} 分量）`;
    if (state.components === 0) {
      state.components = components;
    }
  }

  return {
    block: {
      id: `jpeg:0x${marker.toString(16)}:${at}`,
      selector: name,
      label: descriptor,
      group: 'structural',
      text,
      bytes: raw.length,
      removable: false,
      structural: true,
      orientation: null,
    },
    raw,
    isEntropy: false,
  };
}

/**
 * 熵编码数据 + EOI。
 *
 * 它**不是**一个可以按段解析的东西，因此这里只记下它在原文件里的位置与长度；
 * 重建时整段 `subarray` 原样搬运。逐字节不经过任何解码 —— 这是"清理痕迹"与
 * "重画一张图"的分界。
 */
function buildEntropySegment(
  start: number,
  end: number,
  eoiAt: number,
  fileLength: number,
  state: JpegParseState,
): JpegSegment {
  const trailing = eoiAt >= 0 ? fileLength - (eoiAt + 2) : 0;
  const bits = [`熵编码数据与 EOI，${formatBytes(end - start)}`];
  if (eoiAt < 0) bits.push('未找到 EOI（截断）');
  if (trailing > 0) {
    // EOI 之后还能有字节（缩略图尾巴、写坏的附加数据）。重建时不会保留它们，
    // 因此必须说出来 —— 静默丢字节是"无损工具"最不该有的行为
    bits.push(`EOI 之后还有 ${trailing} 字节附加数据，重建时不会保留`);
  }
  if (state.notes.length > 0) bits.push(state.notes[0]);
  return {
    block: {
      id: `jpeg:entropy:${start}`,
      // 与 SOS 段头**同一个选择键**（`SOS`）：两者是一个整体，丢一个而不丢另一个
      // 是不可能的。用同一个键还有一个直接的工程后果 —— 重建时只要比较一次选择键
      // 就能找到"追加内容该插在哪"，而两个不同的键会让那个判断悄悄失配（真踩过：
      // 段头叫 `SOS`、熵数据叫 `SOS:SOS`，于是追加的段落到了 EOI 之后）
      selector: 'SOS',
      label: '熵编码数据（SOS 之后）',
      group: 'structural',
      text: bits.join('；'),
      bytes: end - start,
      removable: false,
      structural: true,
      orientation: null,
    },
    // **必须是空的。** SOS 的段头由紧挨着它前面的那个结构性块（`FFDA` 段）持有并
    // 写出；熵编码数据只在 `scan` 里持有一次，重建时单独搬。这里如果也存一份段头，
    // 重建出来的文件里 `FFDA` 会出现两次、多出整整一个段头的字节 —— 而"多 12 个
    // 字节"这种错误在字节数上是看不出来的（只有逐字节对比才会露出来），解码器则会
    // 从第二个 SOS 开始彻底错位。
    raw: new Uint8Array(0),
    isEntropy: true,
  };
}

/** APPn / COM 段：把它们的内容解成可显示、可判断要不要丢的样子 */
function buildMetadataSegment(
  marker: number,
  at: number,
  raw: Uint8Array,
  payload: Uint8Array,
  state: JpegParseState,
): JpegSegment {
  const name = segmentName(marker);

  if (marker === 0xe1) {
    return buildApp1Segment(at, raw, payload, state);
  }
  if (marker === 0xe2) {
    return buildIccSegment(at, raw, payload, state);
  }
  if (marker === 0xeb) {
    return buildJumbfSegment(at, raw, payload, state);
  }
  if (marker === 0xed) {
    // APP13 = Photoshop IRB。IPTC 就在里面（作者、版权、说明），因此默认丢
    return makeMetadataSegment(at, raw, {
      selector: 'APP13:Photoshop',
      label: 'APP13(Photoshop)',
      group: 'other',
      text: describeModel(payload, 6),
      removable: true,
    });
  }
  if (marker === 0xee) {
    // APP14 = Adobe。它声明色彩变换（YCbCr/CMYK 的解释方式），但绝大多数编辑器
    // 只看 SOF，丢了不会变色；它同时也是"过没过 Adobe 的手"的一个痕迹
    const transform = payload.length >= 12 ? payload[11] : null;
    const transformName =
      transform === null
        ? '读不出'
        : transform === 0
          ? '未知（RGB 或 CMYK）'
          : transform === 1
            ? 'YCbCr'
            : transform === 2
              ? 'YCCK'
              : String(transform);
    return makeMetadataSegment(at, raw, {
      selector: 'APP14:Adobe',
      label: 'APP14(Adobe)',
      group: 'other',
      text: `Adobe 标记，色彩变换 ${transformName}`,
      removable: true,
    });
  }
  if (marker === 0xe0) {
    const isJfif = startsWithBytes(payload, JFIF_PREFIX);
    const version =
      isJfif && payload.length >= 7
        ? `${payload[5]}.${payload[6].toString().padStart(2, '0')}`
        : null;
    return makeMetadataSegment(at, raw, {
      selector: isJfif ? 'APP0:JFIF' : 'APP0',
      label: isJfif ? 'APP0(JFIF)' : 'APP0',
      group: 'other',
      text: isJfif
        ? `JFIF 版本 ${version}，密度单位 ${payload.length >= 9 ? payload[7] : '?'}`
        : describeModel(payload, 4),
      // JFIF 头很常见，而且有一部分老软件缺了它就不认这张图。它本身不含任何隐私，
      // 因此默认保留 —— 清理的目标是痕迹，不是兼容性
      removable: false,
    });
  }
  if (marker === 0xfe) {
    return makeMetadataSegment(at, raw, {
      selector: 'COM',
      label: 'COM（注释）',
      group: 'text',
      // COM 的规定编码是 Latin-1，但生成器往里面写 UTF-8 中文是常态
      text: commentText(payload),
      removable: true,
    });
  }

  // APP3..APP12、APP15 等等：认不出内容，但它是可丢的
  return makeMetadataSegment(at, raw, {
    selector: name,
    label: name,
    group: 'other',
    text: describeModel(payload, 8),
    removable: true,
  });
}

/** APP1：Exif 与 XMP 共用这一个标记码，靠开头的命名空间区分 */
function buildApp1Segment(
  at: number,
  raw: Uint8Array,
  payload: Uint8Array,
  state: JpegParseState,
): JpegSegment {
  if (startsWithBytes(payload, EXIF_PREFIX)) {
    const tiff = payload.subarray(EXIF_PREFIX.length);
    let text = `Exif 拍摄信息，${formatBytes(tiff.length)}`;
    let orientation: number | null = null;
    let fields: ExifField[] = [];
    try {
      const parsed = parseExif(tiff);
      fields = parsed.fields;
      orientation = parsed.orientation;
      if (orientation !== null && orientation !== 1) {
        text = `Exif 拍摄信息，${fields.length} 项，方向 ${orientation}`;
      } else if (fields.length > 0) {
        text = `Exif 拍摄信息，${fields.length} 项`;
      }
    } catch (error) {
      // 解析器抛错是要预料到的情况：EXIF 是自由格式的重灾区（偏移越界、类型长度
      // 对不上、坏指针成环）。而"这张图有 EXIF 但我读不出来"与"这张图没有 EXIF"
      // 是两件必须区分的事 —— 用户要决定丢不丢它
      text = `Exif 拍摄信息，${formatBytes(tiff.length)}；字段解析失败：${errorText(error)}`;
    }
    // exif 字段取 TIFF 头开始的字节（不含 Exif\0\0），因为 TIFF 解析器从这里开始
    if (state.exif === null) state.exif = tiff;
    if (state.orientation === null) state.orientation = orientation;
    return {
      block: {
        id: `jpeg:app1-exif:${at}`,
        selector: 'APP1:Exif',
        label: 'APP1(Exif)',
        group: 'exif',
        text: withNotes(text, state.notes, ['截断', '长度']),
        bytes: raw.length,
        removable: true,
        structural: false,
        orientation,
      },
      raw,
      isEntropy: false,
    };
  }

  if (startsWithBytes(payload, XMP_PREFIX)) {
    const body = payload.subarray(XMP_PREFIX.length);
    let text = '';
    try {
      // 标准 XMP 是 UTF-8。extractXmp 兼容"整包外面还包了一层 xpacket"的情况
      const xmp = extractXmp(body) ?? smartDecode(body);
      state.xmp = xmp;
      text = `XMP 包，${formatBytes(body.length)}${summarize(xmp)}`;
    } catch (error) {
      // xmp 记 null 并把原因写进 text，让用户知道"这里有东西但没读出来"
      state.xmp = null;
      text = `XMP 包，${formatBytes(body.length)}；提取失败：${errorText(error)}`;
    }
    return {
      block: {
        id: `jpeg:app1-xmp:${at}`,
        selector: 'APP1:XMP',
        label: 'APP1(XMP)',
        group: 'xmp',
        text,
        bytes: raw.length,
        removable: true,
        structural: false,
        orientation: null,
      },
      raw,
      isEntropy: false,
    };
  }

  if (startsWithBytes(payload, XMP_EXT_PREFIX)) {
    // 扩展 XMP 分片（大包被切开，每片 ≤ 65502 字节）。这里只报告存在：把分片拼起来
    // 需要按 GUID 归组并排序，而"有没有 XMP"这件事已经能回答用户的问题了
    const starts = signatureAt(payload, C2PA_SIGNATURE);
    if (starts >= 0) state.c2pa.push(`APP1 扩展 XMP 里出现 c2pa 签名（偏移 ${starts}）`);
    return makeMetadataSegment(at, raw, {
      selector: 'APP1:XMPExtension',
      label: 'APP1(扩展 XMP)',
      group: 'xmp',
      text: `扩展 XMP 分片（StandardXMP 之外的大包分片），${formatBytes(payload.length)}`,
      removable: true,
    });
  }

  // APP1 也被不少工具当成私有的通用槽位用（例如 Exif 之外的厂商标签）。当作可丢的
  // 未知段处理，而不是丢掉不报 —— 静默丢弃是最坏的结果
  return makeMetadataSegment(at, raw, {
    selector: 'APP1',
    label: 'APP1',
    group: 'other',
    text: describeModel(payload, 12),
    removable: true,
  });
}

/** APP2 = ICC 色彩描述文件，可能被切成多片 */
function buildIccSegment(
  at: number,
  raw: Uint8Array,
  payload: Uint8Array,
  state: JpegParseState,
): JpegSegment {
  if (!startsWithBytes(payload, ICC_PREFIX)) {
    return makeMetadataSegment(at, raw, {
      selector: 'APP2',
      label: 'APP2',
      group: 'other',
      text: describeModel(payload, 8),
      removable: true,
    });
  }

  // ICC_PROFILE\0 + 序号(1) + 总数(1) + 数据
  const sequence = payload.length >= 13 ? payload[12] : 0;
  const total = payload.length >= 14 ? payload[13] : 0;
  const dataBytes = Math.max(0, payload.length - 14);
  // 多片要累加，因此这里用 += 而不是 = —— 一个 ICC 描述文件可以被切成十几片，
  // 只报最后一片的字节数会让界面上那个"ICC 大小"小得离谱
  state.iccBytes += dataBytes;

  const pieces = [`ICC 色彩描述文件${total > 1 ? ` 第 ${sequence}/${total} 片` : ''}，${formatBytes(dataBytes)}`];
  if (total > 0 && sequence > total) {
    pieces.push('序号大于总数，文件有问题');
  }
  return {
    block: {
      id: `jpeg:app2-icc:${at}`,
      selector: 'APP2:ICC',
      label: 'APP2(ICC)',
      group: 'icc',
      // ICC 不是隐私：它说明"这些数字该被解释成什么颜色"，丢了广色域作品会明显偏色。
      // 因此默认不丢，与 PNG 的 iCCP 一致
      text: pieces.join('；'),
      bytes: raw.length,
      removable: false,
      structural: false,
      orientation: null,
    },
    raw,
    isEntropy: false,
  };
}

/** APP11 = JUMBF。C2PA（Content Credentials）就装在这里面 */
function buildJumbfSegment(
  at: number,
  raw: Uint8Array,
  payload: Uint8Array,
  state: JpegParseState,
): JpegSegment {
  const hasJumbf = hasBytes(payload, JUMBF_SIGNATURE);
  const hasC2pa = hasBytes(payload, C2PA_SIGNATURE);
  const pieces: string[] = [];
  if (hasC2pa) {
    const c2paAt = signatureAt(payload, C2PA_SIGNATURE);
    state.c2pa.push(`APP11 JUMBF 容器（偏移 ${c2paAt}）`);
    pieces.push('内容凭证（C2PA / Content Credentials）');
  } else if (hasJumbf) {
    pieces.push('JUMBF 容器（来源凭证的封装格式）');
  }
  pieces.push(formatBytes(payload.length));
  return makeMetadataSegment(at, raw, {
    selector: 'APP11:JUMBF',
    label: 'APP11(JUMBF)',
    group: hasJumbf || hasC2pa ? 'c2pa' : 'other',
    text: pieces.join('，'),
    removable: true,
    idKind: hasC2pa ? 'c2pa' : 'jumbf',
  });
}

/**
 * 造一个非结构性的块。
 *
 * `idKind` 只影响 id 里那一段可读的名字，**不影响稳定性** —— id 的稳定性来自
 * `at`（这个段在原文件里的偏移），而偏移对同一份字节永远是同一个值。
 */
function makeMetadataSegment(
  at: number,
  raw: Uint8Array,
  spec: {
    selector: string;
    label: string;
    group: MetaGroup;
    text: string;
    removable: boolean;
    idKind?: string;
  },
): JpegSegment {
  return {
    block: {
      id: `jpeg:${spec.idKind ?? spec.selector}:${at}`,
      selector: spec.selector,
      label: spec.label,
      group: spec.group,
      text: spec.text,
      bytes: raw.length,
      removable: spec.removable,
      structural: false,
      orientation: null,
    },
    // 段体（含 2 字节标记）就是全部需要保留的东西：段头里的长度字段也在这段字节里，
    // 因此重建时不需要重新计算它
    raw,
    isEntropy: false,
  };
}

/** COM 的正文。先按 Latin-1 试，遇到控制字符之外的高位字节再按"像什么就按什么"解 */
function commentText(payload: Uint8Array): string {
  const text = smartDecode(payload).replace(/\0+$/, '');
  const fresh = text.replace(/\s+/g, ' ').trim();
  if (fresh.length === 0) return `注释段，${formatBytes(payload.length)}（内容为空或全是空白）`;
  return `注释：${toDisplayText(fresh, 200)}`;
}

/** 认不出的二进制段：给一句说明而不是一屏乱码 */
function describeModel(payload: Uint8Array, preview: number): string {
  const head = payload.subarray(0, preview);
  const text = smartDecode(head).replace(/[\u0000-\u001f\u007f]/g, '.');
  return `${formatBytes(payload.length)}，开头：${toDisplayText(text, 80)}`;
}

/** XMP 摘要。`summarizeXmp` 在实现中，因此必须容错调用 */
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

/**
 * 把解析期间攒下的毛病挂到结构块上。
 *
 * 为什么不单独造一块：那些 comment 是解析器的自述，不是文件里的内容 —— 让它们
 * 混进元数据列表会让"丢块"这个动作多出几个不知道该不该丢的条目。挂在结构块上
 * （它永远保留）则既看得见，又不会被用户误当成可以丢的东西。
 */
function withNotes(text: string, notes: string[], filter: string[]): string {
  if (notes.length === 0) return text;
  const relevant = notes.filter((note) => filter.some((token) => note.includes(token)));
  if (relevant.length === 0) return text;
  return `${text}（${relevant[0]}）`;
}

function buildInfo(fileLength: number, state: JpegParseState): ImageInfo {
  // 颜色模型按分量数与 SOF 类型说。CMYK 的 JPEG 极少见，但写错了会让用户以为
  // 自己那张印刷稿是 RGB 的
  let colorModel: string | null = null;
  if (state.components === 1) colorModel = '灰度';
  else if (state.components === 3) colorModel = 'YCbCr(3)';
  else if (state.components === 4) {
    colorModel = state.sofMarker === 0xc0 || state.sofMarker === 0xc1 ? 'CMYK(4)' : 'YCCK(4)';
  } else if (state.components > 0) colorModel = `${state.components} 分量`;

  return {
    format: 'jpeg',
    width: state.width,
    height: state.height,
    bitDepth: state.bitDepth,
    colorModel,
    interlaced: state.progressive,
    animated: false,
    frames: 1,
    bytes: fileLength,
  };
}

// ============================================================
// 重建
// ============================================================

/**
 * 按丢掉集合与追加集合重建一个 JPEG。
 *
 * 输出顺序：SOI → 保留的段（**按原顺序**）→ 追加的 COM → （可选）最小方向 EXIF →
 * SOS + 熵编码数据 + EOI。
 *
 * 关于顺序：`SOF` / `DHT` / `DQT` / `DRI` 相对 `SOS` 有隐含要求（表必须在扫描之前
 * 定义，`SOF` 必须在 `SOS` 之前），因此"保留的段维持原顺序、追加的段一律插在
 * `SOS` 之前"是安全的 —— 追加内容只会落到 SOS 前面，不会把任何结构性段挤到 SOS
 * 之后，也不会改变已有段之间的相对次序。
 */
function rebuildJpeg(
  segments: JpegSegment[],
  scan: { start: number; raw: Uint8Array } | null,
  options: RebuildOptions,
): Uint8Array {
  const writer = new ByteWriter(4096);
  writer.u8(0xff).u8(0xd8); // SOI

  let exifKept = false;
  let appended = false;
  // 原文件里到底有没有 Exif：决定"方向回写"要不要凭空造一个 APP1
  const hadExif = segments.some((segment) => segment.block.selector === 'APP1:Exif');

  /**
   * 追加内容。**必须在 SOS **之前**调用**。
   *
   * 这里踩过一次坑，值得写下来：`SOS` 那个块在数据结构上包含了"段头 + 熵编码数据"
   * 两截（因为它们不可分割），但它们在文件里是**紧挨着**的两段字节。如果把追加的
   * 段写在 SOS 块开始处，得到的是 `... 追加段 SOS头 熵数据 ...`，也就是把追加内容
   * 插到了 SOS 头和它自己的扫描数据之间 —— 解码器会把那几十个字节当成熵编码数据
   * 读，整张图从那里开始错位。
   *
   * 正确的顺序是：`SOS 头` → `追加内容` → `熵编码数据`。
   */
  /**
   * 追加内容。**必须在 SOS 段头写出之前调用。**
   *
   * 这里踩过一次坑，值得写下来。SOS 在 `blocks` 里是两块：段头，以及它后面那坨熵
   * 编码数据。少写一个字节都不行、多插一个字节也不行 —— 两种错法都真出现过：
   *
   *   * 插在段头**之后**（段头与扫描数据之间）：解码器会把那几十个字节当成熵编码
   *     数据读，整张图从那里开始错位；而我们的解析器更直接：它把那一段整个当作
   *     扫描数据跳过，于是**追加的 COM 连自己都读不回来**（验证脚本正是这样抓到的）。
   *   * 顺着"块在数组里的顺序"在熵数据块处 flush：那时段头已经写完了，落到同一个
   *     坑里。
   *
   * 因此正确的时机只有一个：**写 SOS 段头之前**。得到的顺序是
   * `... 追加段 SOS头 熵数据 EOI`，追加段落在 JPEG 规范里 COM 该在的位置上。
   */
  const flushAppended = (): void => {
    if (appended) return;
    appended = true;
    writeAppended(writer, options);
    writeOrientationExif(writer, options, exifKept, hadExif);
  };

  for (const segment of segments) {
    if (segment.isEntropy) {
      // 熵编码数据的字节只在 `scan` 里（下面统一写出）。这个块的作用是标出
      // "SOS 到这里结束了"，但追加内容已经在段头之前写完了
      continue;
    }
    // **结构性段永远保留，哪怕 drop 里点了名。**
    //
    // 这条不变量守在这一层而不是策略层：`clean/plan.ts` 确实不会把 SOF/DHT/DQT/DRI
    // 放进 drop，但那是"当前调用方很小心"，而 `rebuild` 是公开接口 —— 任何将来的
    // 调用方都能绕过策略直接点名。把安全网放在这里，它才是一条**不变量**而不是一个
    // 约定；而且这与 PNG 模块一致（PNG 同样拒绝丢掉 IHDR/IDAT/IEND）。
    if (!segment.block.structural && options.drop.has(segment.block.selector)) continue;
    if (segment.block.selector === 'APP1:Exif') exifKept = true;
    // 段头（`FFDA`）是最后一个保留段，追加内容插在它前面
    if (segment.block.selector === SOS_SELECTOR) flushAppended();
    writeRaw(writer, segment);
  }

  // 熵编码数据 + EOI：紧跟 SOS 段头逐字节搬运，中间不允许有任何东西
  if (scan) writer.bytes(scan.raw);

  // 没有 SOS 的文件（骨架）也要把追加内容写出去，否则"我追加了版权信息"这个操作
  // 会静默失败
  flushAppended();

  return writer.toBytes();
}

/** 追加的文本块落成 COM 段。`key: value` 是这里唯一不用猜的格式约定 */
function writeAppended(writer: ByteWriter, options: RebuildOptions): void {
  for (const item of options.append) {
    const text = `${item.key}: ${item.value}`;
    const data = latin1Encode(text);
    // 段体最长 65533 字节（65535 减去长度字段自身那 2 字节）。超长的追加内容会被
    // 截断 —— 不截断就会写出一个长度字段溢出、所有查看器都拒收的文件
    const limited = data.length > 65533 ? data.subarray(0, 65533) : data;
    writer.u8(0xff).u8(0xfe);
    writer.u16(limited.length + 2);
    writer.bytes(limited);
  }
}

/**
 * 方向回写。
 *
 * 只在"确实丢了原 Exif"时才写：原 Exif 还在的时候再补一个最小的，等于让解析器
 * 面对两份互相矛盾的 Exif —— 而大多数解析器取第一个，于是用户拿到的方向可能不是
 * 他以为的那个。
 */
function writeOrientationExif(
  writer: ByteWriter,
  options: RebuildOptions,
  exifKept: boolean,
  hadExif: boolean,
): void {
  if (!options.keepOrientation) return;
  const orientation = options.orientation;
  if (orientation === null || orientation === 1) return;
  if (exifKept) return;
  // 原文件根本没有 Exif 的时候也没必要凭空造一个：没有 Exif 就没有方向问题
  if (!hadExif) return;
  const block = buildOrientationExifSegment(orientation);
  if (block) writer.bytes(block);
}

/**
 * 造一个只含 Orientation 的最小 APP1 段。
 *
 * `buildOrientationExif` 还在实现中，因此这里必须容错：造不出来就**不写**，
 * 而不是把"清理"整体变成一次失败。代价是方向可能丢，这一点由调用方的
 * `keepOrientation` 语义承担。
 */
function buildOrientationExifSegment(orientation: number): Uint8Array | null {
  try {
    const tiff = buildOrientationExif(orientation);
    if (tiff.length === 0) return null;
    const body = new Uint8Array(EXIF_PREFIX.length + tiff.length);
    body.set(EXIF_PREFIX, 0);
    body.set(tiff, EXIF_PREFIX.length);
    const writer = new ByteWriter(body.length + 4);
    writer.u8(0xff).u8(0xe1);
    writer.u16(body.length + 2);
    writer.bytes(body);
    return writer.toBytes();
  } catch {
    return null;
  }
}
