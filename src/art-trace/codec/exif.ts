// src/art-trace/codec/exif.ts
//
// TIFF / EXIF 解析与最小 EXIF 构造。
//
// ============================================================
// 为什么 EXIF 是一个"文件系统"而不是一张表
// ============================================================
//
// EXIF 不是"一串键值"，而是 **TIFF 格式**：一个头，加上若干 IFD（Image File
// Directory），每个 IFD 是一张表，表里的每一项除了 tag / 类型 / 值，还能指向别的
// IFD。于是"读一遍 EXIF"实际上是**走一遍图**：
//
//   IFD0 ──0x8769──▶ ExifIFD ──0xA005──▶ Interop
//     │
//     └──0x8825──▶ GPS IFD
//     │
//     └── next IFD ──▶ IFD1（缩略图）
//
// 只读 IFD0 的实现能拿到 Orientation 与 Make/Model，**但拿不到拍摄时间、曝光、
// 镜头** —— 那些全在 ExifIFD 里。因此这里的 `ifd()` 是递归入口而不是展开的表。
//
// ============================================================
// 两条硬约束
// ============================================================
//
// 1. **一切越界都是跳过，不是抛错。** EXIF 块经常是被裁过的（很多工具写 EXIF 时
//    只搬前面几百字节），而一个越界的偏移量会让"抛出异常"变成"整个文件读不出来"。
//    这里所有读取都先过 `within()`。
//
// 2. **不认识的 tag 也要显示。** 相机与生成器一直在加新 tag。丢掉不认识的等于
//    丢掉了"最新的那部分信息"，而它们恰恰是最可能带痕迹的。因此未知 tag 显示成
//    `Tag(0xA434)` 而不是被过滤掉。

import type { ExifField } from '../model/types';

export interface ExifParse {
  fields: ExifField[];
  orientation: number | null;
  hasOtherThanOrientation: boolean;
}

// ============================================================
// 类型表
// ============================================================

/** TIFF 的字段类型编号 → `[名字, 单元字节数]`。类型 6/8 在 TIFF 6.0 里被废除，因此缺席 */
const TYPE_TABLE: Readonly<Record<number, readonly [string, number]>> = {
  1: ['BYTE', 1],
  2: ['ASCII', 1],
  3: ['SHORT', 2],
  4: ['LONG', 4],
  5: ['RATIONAL', 8],
  7: ['UNDEFINED', 1],
  9: ['SLONG', 4],
  10: ['SRATIONAL', 8],
  11: ['FLOAT', 4],
  12: ['DOUBLE', 8],
};

// ============================================================
// tag 名表
// ============================================================
//
// **一张平表，不按 IFD 分。** 理由：同一个 tag 号在不同 IFD 里偶尔重号（最典型的是
// 0x0001/0x0002，IFD0 里是 InteropIndex 而 GPS 里是 GPSLatitudeRef），但真正重号
// 且两边都常见的只有 GPS 那一组。给每个 tag 存"名字 + 只在哪个 IFD 生效"会让表长
// 三倍、读起来更差；这里改为**在 GPS IFD 里先查 GPS 表**，其余一律走平表 ——
// 代价是 IFD0 里出现 0x0002 时会显示成 `GPSLatitude`，而那种文件本来就不存在。

const TAG_NAMES: Readonly<Record<number, string>> = {
  // ---- IFD0：基本图像信息 ----
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x0102: 'BitsPerSample',
  0x0103: 'Compression',
  0x0106: 'PhotometricInterpretation',
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0111: 'StripOffsets',
  0x0112: 'Orientation',
  0x0115: 'SamplesPerPixel',
  0x0116: 'RowsPerStrip',
  0x0117: 'StripByteCounts',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x011c: 'PlanarConfiguration',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x013e: 'WhitePoint',
  0x013f: 'PrimaryChromaticities',
  0x0201: 'JPEGInterchangeFormat',
  0x0202: 'JPEGInterchangeFormatLength',
  0x0211: 'YCbCrCoefficients',
  0x0213: 'YCbCrPositioning',
  0x0214: 'ReferenceBlackWhite',
  0x8298: 'Copyright',
  0x8769: 'ExifOffset',
  0x8825: 'GPSInfo',
  0xa005: 'InteroperabilityOffset',

  // ---- ExifIFD：拍摄参数 ----
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8822: 'ExposureProgram',
  0x8824: 'SpectralSensitivity',
  0x8827: 'ISOSpeedRatings',
  0x8828: 'OECF',
  0x8830: 'SensitivityType',
  0x8831: 'StandardOutputSensitivity',
  0x8832: 'RecommendedExposureIndex',
  0x8833: 'ISOSpeed',
  0x8834: 'ISOSpeedLatitudeyyy',
  0x8835: 'ISOSpeedLatitudezzz',
  0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9010: 'OffsetTime',
  0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized',
  0x9101: 'ComponentsConfiguration',
  0x9102: 'CompressedBitsPerPixel',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue',
  0x9205: 'MaxApertureValue',
  0x9206: 'SubjectDistance',
  0x9207: 'MeteringMode',
  0x9208: 'LightSource',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0x9214: 'SubjectArea',
  0x927c: 'MakerNote',
  0x9286: 'UserComment',
  0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal',
  0x9292: 'SubSecTimeDigitized',
  0xa000: 'FlashpixVersion',
  0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa004: 'RelatedSoundFile',
  0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution',
  0xa210: 'FocalPlaneResolutionUnit',
  0xa214: 'SubjectLocation',
  0xa215: 'ExposureIndex',
  0xa217: 'SensingMethod',
  0xa300: 'FileSource',
  0xa301: 'SceneType',
  0xa302: 'CFAPattern',
  0xa401: 'CustomRendered',
  0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType',
  0xa407: 'GainControl',
  0xa408: 'Contrast',
  0xa409: 'Saturation',
  0xa40a: 'Sharpness',
  0xa40c: 'SubjectDistanceRange',
  0xa420: 'ImageUniqueID',
  0xa430: 'CameraOwnerName',
  0xa431: 'BodySerialNumber',
  0xa432: 'LensSpecification',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
  0xa435: 'LensSerialNumber',
  0xa460: 'CompositeImage',
  0xa461: 'SourceImageNumberOfCompositeImage',
  0xa462: 'SourceExposureTimesOfCompositeImage',
  0xa500: 'Gamma',

  // ---- Interop ----
  0x0001: 'InteropIndex',
  0x0002: 'InteropVersion',

  // ---- 生成器 / 图像处理软件常写的一组 ----
  0x013c: 'HostComputer',
  0x02bc: 'XMLPacket',
  0x83bb: 'IPTC-NAA',
  0x8649: 'PhotoshopImageResources',
  0xc4a5: 'PrintImageMatching',
};

/** GPS IFD 的名字表。0x0000..0x001f 之外没有 GPS tag */
const GPS_TAG_NAMES: Readonly<Record<number, string>> = {
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x0008: 'GPSSatellites',
  0x0009: 'GPSStatus',
  0x000a: 'GPSMeasureMode',
  0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef',
  0x000d: 'GPSSpeed',
  0x000e: 'GPSTrackRef',
  0x000f: 'GPSTrack',
  0x0010: 'GPSImgDirectionRef',
  0x0011: 'GPSImgDirection',
  0x0012: 'GPSMapDatum',
  0x0013: 'GPSDestLatitudeRef',
  0x0014: 'GPSDestLatitude',
  0x0015: 'GPSDestLongitudeRef',
  0x0016: 'GPSDestLongitude',
  0x0017: 'GPSDestBearingRef',
  0x0018: 'GPSDestBearing',
  0x0019: 'GPSDestDistanceRef',
  0x001a: 'GPSDestDistance',
  0x001b: 'GPSProcessingMethod',
  0x001c: 'GPSAreaInformation',
  0x001d: 'GPSDateStamp',
  0x001e: 'GPSDifferential',
  0x001f: 'GPSHPositioningError',
};

/** 指向别的 IFD 的指针 tag。它们**不算"除方向之外还有别的字段"** */
const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005]);

/**
 * tag 名。未知的显示成 `Tag(0xXXXX)`。
 *
 * 十六进制**固定 4 位大写**：`Tag(0x1)` 与 `Tag(0x0001)` 都能被机器认出来，但人眼
 * 在大写十六进制的表里扫 tag 号时，对齐的位数是唯一能让"找 0xA434"这件事变快的
 * 东西。
 */
function tagName(group: ExifField['group'], tag: number): string {
  if (group === 'gps') {
    const gps = GPS_TAG_NAMES[tag];
    if (gps) return gps;
  }
  const known = TAG_NAMES[tag];
  if (known) return known;
  return `Tag(0x${tag.toString(16).toUpperCase().padStart(4, '0')})`;
}

// ============================================================
// 值的格式化
// ============================================================

/**
 * 一个 RATIONAL 值是不是"分母为 0"。
 *
 * 显示成 `—` 而不是 `1/0` 或 `Infinity`：这两个都是"解析器坏了"的样子，而真相是
 * **文件里就这么写的**（相机在无法测量时确实会写 0/0）。让用户看到"没有值"比看到
 * 一个他以为是 bug 的数更接近事实。
 */
function formatRational(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${numerator}/${denominator}`;
}

/**
 * 曝光时间的人类可读形式。
 *
 * 相机写的是 `1/250` 这种分数，但**写出来的是整数比**（分子可能是 10、分母 2500）。
 * 这里保留原始比值：先约分再判断，因为 `10/2500` 直接显示成 `10/2500 s` 而
 * `1/250 s` 才是人在看照片时会说的话。
 */
function formatExposureTime(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  if (numerator === 0) return '0 s';
  const seconds = numerator / denominator;
  if (seconds >= 1) {
    // 长曝光：`2.5 s`。两位小数足够，且不会把 30 显示成 30.00
    return `${Number(seconds.toFixed(2))} s`;
  }
  // 短曝光：换算成 `1/x s`。四舍五入到整数 —— 相机本来就只会写 1/整数 那一档
  const inverse = Math.round(denominator / numerator);
  return `1/${inverse} s`;
}

/** Orientation 的数字 → 含义。**这一步不是装饰**：值 6 与值 8 的差别是"转 90°"与"转 270°" */
const ORIENTATION_MEANING: Readonly<Record<number, string>> = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '转置（顺时针 90° + 水平镜像）',
  6: '顺时针 90°',
  7: '反转（逆时针 90° + 水平镜像）',
  8: '逆时针 90°（顺时针 270°）',
};

/** 分辨率单位。2 = 英寸，3 = 厘米 */
const RESOLUTION_UNIT: Readonly<Record<number, string>> = { 1: '无单位', 2: '英寸', 3: '厘米' };

/** 测光模式 */
const METERING_MODE: Readonly<Record<number, string>> = {
  0: '未知',
  1: '平均',
  2: '中央重点平均',
  3: '点测光',
  4: '多点测光',
  5: '评价测光',
  6: '局部测光',
  255: '其它',
};

/** 曝光程序 */
const EXPOSURE_PROGRAM: Readonly<Record<number, string>> = {
  0: '未定义',
  1: '手动',
  2: '程序自动',
  3: '光圈优先',
  4: '快门优先',
  5: '创意程序',
  6: '人像模式',
  7: '风景模式',
  8: '运动模式',
  9: '微距模式',
};

/** 色彩空间。**这一个的值域只有两个**，因此映射本身几乎没有歧义 */
const COLOR_SPACE: Readonly<Record<number, string>> = { 1: 'sRGB', 2: 'Adobe RGB', 65535: '未校准' };

/** 分辨率单位之外，还有几个"值有名字"的常见 tag。名称 → 取值映射 */
const ENUM_TABLES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  ResolutionUnit: RESOLUTION_UNIT,
  MeteringMode: METERING_MODE,
  ExposureProgram: EXPOSURE_PROGRAM,
  ColorSpace: COLOR_SPACE,
};

/** `UserComment` 的编码前缀。`UNDEFINED` 类型的前 8 字节 */
const USER_COMMENT_PREFIXES: ReadonlyArray<{ bytes: number[]; encoding: string }> = [
  { bytes: [0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00], encoding: 'ascii' },
  { bytes: [0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00], encoding: 'unicode' },
  { bytes: [0x4a, 0x49, 0x53, 0x00, 0x00, 0x00, 0x00, 0x00], encoding: 'jis' },
  { bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], encoding: 'undefined' },
];

// ============================================================
// 读值
// ============================================================

interface IfdEntry {
  tag: number;
  type: number;
  /** 值的个数。**不是字节数** —— 字节数是它乘上类型的单元大小 */
  count: number;
  /** 值区的**文件绝对**起始偏移（相对整个 TIFF 头） */
  valueOffset: number;
  /** 值区的字节数。可能因为越界而被夹到实际可用的长度 */
  valueBytes: number;
  /** 内联值（≤ 4 字节时值就在条目里）的原始 4 字节 */
  inline: Uint8Array | null;
}

class TiffReader {
  /** 整个 TIFF 段（`bytes[0]` 是 `II` 或 `MM`） */
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** 大端（`MM`）还是小端（`II`） */
  readonly bigEndian: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bigEndian = bytes[0] === 0x4d;
  }

  /** 读 u16，按文件自己的字节序 */
  u16(at: number): number {
    return this.view.getUint16(at, !this.bigEndian);
  }

  /** 读 u32，按文件自己的字节序 */
  u32(at: number): number {
    return this.view.getUint32(at, !this.bigEndian);
  }

  /** 读 i32（`SRATIONAL` 的分子分母是有符号的） */
  i32(at: number): number {
    return this.view.getInt32(at, !this.bigEndian);
  }

  f32(at: number): number {
    return this.view.getFloat32(at, !this.bigEndian);
  }

  f64(at: number): number {
    return this.view.getFloat64(at, !this.bigEndian);
  }

  i8(at: number): number {
    return this.view.getInt8(at);
  }

  /** `[at, at+count)` 是不是整个落在文件里 */
  within(at: number, count: number): boolean {
    return at >= 0 && count >= 0 && at + count <= this.bytes.length;
  }
}

/**
 * 读一个 IFD 的全部条目。
 *
 * 越界的部分**在返回前就被夹掉**（`valueBytes` 会被缩短），而不是留到用的时候再判
 * —— 那样每个调用点都要再判一次，而漏判一处就是一个越界读（在 JS 里表现为
 * `undefined`，然后一路安静地传到界面上变成 `NaN`）。
 */
function readIfd(reader: TiffReader, offset: number): IfdEntry[] {
  const entries: IfdEntry[] = [];
  if (!reader.within(offset, 2)) return entries;

  const total = reader.u16(offset);
  const at = offset + 2;
  if (!reader.within(at, total * 12)) return entries;

  for (let index = 0; index < total; index++) {
    const base = at + index * 12;
    const tag = reader.u16(base);
    const type = reader.u16(base + 2);
    const count = reader.u32(base + 4);

    const spec = TYPE_TABLE[type];
    if (!spec) continue; // 未知类型：连大小都不知道，跳过是唯一安全的选择
    const unit = spec[1];
    const totalBytes = count * unit;

    if (count <= 0 || !Number.isFinite(totalBytes)) continue;

    if (totalBytes <= 4) {
      // 值内联在条目的后 4 字节里，**从条目自身**取，不去解那个偏移字段
      entries.push({
        tag,
        type,
        count,
        valueOffset: base + 8,
        valueBytes: totalBytes,
        inline: reader.bytes.subarray(base + 8, base + 12),
      });
      continue;
    }

    const pointer = reader.u32(base + 8);
    if (!reader.within(pointer, 1)) continue; // 偏移本身就飞出文件了
    // 长度可能超出文件末尾（被裁过的 EXIF），**夹到可用长度**并继续用
    const available = Math.min(totalBytes, reader.bytes.length - pointer);
    if (available < unit) continue; // 连一个完整的值都放不下
    entries.push({
      tag,
      type,
      count,
      valueOffset: pointer,
      valueBytes: available,
      inline: null,
    });
  }
  return entries;
}

/** 条目值区的视图（**不复制**）。内联值取条目里的 4 字节切片 */
function valueView(reader: TiffReader, entry: IfdEntry): Uint8Array {
  if (entry.inline) return entry.inline.subarray(0, entry.valueBytes);
  return reader.bytes.subarray(entry.valueOffset, entry.valueOffset + entry.valueBytes);
}

function readNumber(reader: TiffReader, entry: IfdEntry, index: number): number | null {
  const spec = TYPE_TABLE[entry.type];
  if (!spec) return null;
  const unit = spec[1];
  // 第 `index` 个值从值区起点往后 `index × 单元大小`。内联值也一样 —— 它的
  // `valueOffset` 指着条目里的那 4 个字节，因此同一个公式对两种情形都成立
  const offset = entry.valueOffset + index * unit;
  if (!reader.within(offset, unit)) return null;

  switch (entry.type) {
    case 1:
      return reader.bytes[offset];
    case 3:
      return reader.u16(offset);
    case 4:
      return reader.u32(offset);
    case 7:
      return reader.bytes[offset];
    case 9:
      return reader.i32(offset);
    case 11:
      return reader.f32(offset);
    case 12:
      return reader.f64(offset);
    default:
      return null; // ASCII 与 RATIONAL 有自己的走法
  }
}

/**
 * ASCII 值：读到第一个 NUL 为止。
 *
 * **不能只去掉尾部 NUL**：EXIF 里的 ASCII 值经常用 NUL 补齐到偶数长度，而偶尔会
 * 在一段 NUL 之后还有内容（某些工具写完不清零）。规格说"以 NUL 结尾"，因此第一个
 * NUL 之后的东西属于未定义，取它反而会把垃圾拼进字段值。
 */
function readAscii(view: Uint8Array): string {
  let end = view.indexOf(0);
  if (end < 0) end = view.length;
  let out = '';
  for (let i = 0; i < end; i++) out += String.fromCharCode(view[i]);
  return out.trim();
}

function readRational(
  reader: TiffReader,
  entry: IfdEntry,
  index: number,
  signed: boolean
): [number, number] | null {
  const offset = entry.valueOffset + index * 8;
  if (!reader.within(offset, 8)) return null;
  if (signed) return [reader.i32(offset), reader.i32(offset + 4)];
  return [reader.u32(offset), reader.u32(offset + 4)];
}

/**
 * `UserComment` 的解码。
 *
 * 它以 8 字节的"字符编码"前缀开头（`ASCII\0\0\0` / `UNICODE\0` / …），**不剥掉
 * 这个前缀的话，显示出来的字段值前面永远是 8 个乱码**。`UNICODE` 分支在现实中是
 * UTF-16：字节序按 TIFF 头走（这是唯一自洽的选择，因为前缀里没有 BOM）。
 */
function readUserComment(reader: TiffReader, entry: IfdEntry): string {
  const view = valueView(reader, entry);
  if (view.length === 0) return '';

  let encoding = 'undefined';
  let body = view;
  if (view.length >= 8) {
    for (const prefix of USER_COMMENT_PREFIXES) {
      let match = true;
      for (let i = 0; i < 8; i++) {
        if (view[i] !== prefix.bytes[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        encoding = prefix.encoding;
        body = view.subarray(8);
        break;
      }
    }
  }

  // 去掉尾部 NUL（UTF-16 是双字节 NUL，因此循环剥）
  let end = body.length;
  while (end > 0 && body[end - 1] === 0) end--;
  const trimmed = body.subarray(0, end);

  if (encoding === 'unicode') {
    let out = '';
    const littleEndian = !reader.bigEndian;
    for (let i = 0; i + 1 < trimmed.length; i += 2) {
      const code = littleEndian
        ? trimmed[i] | (trimmed[i + 1] << 8)
        : (trimmed[i] << 8) | trimmed[i + 1];
      out += String.fromCharCode(code);
    }
    return out.trim();
  }

  let out = '';
  for (const byte of trimmed) out += String.fromCharCode(byte);
  return out.trim();
}

/** 把条目转成人类可读的字符串。`name` 已知的走专用格式化 */
function formatValue(reader: TiffReader, entry: IfdEntry, name: string): string {
  const spec = TYPE_TABLE[entry.type];
  const typeName = spec ? spec[0] : `TYPE${entry.type}`;

  // UNDEFINED：只有几个 tag 有可读形式，其余给一句说明
  if (entry.type === 7) {
    if (entry.tag === 0x9286) return readUserComment(reader, entry);
    if (entry.tag === 0x9000 || entry.tag === 0xa000) {
      // ExifVersion / FlashpixVersion 是 4 个 ASCII 数字，但类型标成 UNDEFINED
      const view = valueView(reader, entry);
      let out = '';
      for (const byte of view.subarray(0, 4)) {
        if (byte === 0) break;
        out += String.fromCharCode(byte);
      }
      return out.length > 0 ? out : `${entry.valueBytes} 字节`;
    }
    if (entry.tag === 0x9101) {
      // ComponentsConfiguration：4 个字节，每个是一位"通道是否存在"
      const view = valueView(reader, entry);
      const CHANNELS = ['', 'Y', 'Cb', 'Cr', 'R', 'G', 'B'];
      const parts: string[] = [];
      for (const byte of view) parts.push(byte === 0 ? '—' : CHANNELS[byte] ?? String(byte));
      return parts.length > 0 ? parts.join(' ') : '—';
    }
    return `${entry.valueBytes} 字节`;
  }

  if (entry.type === 2) return readAscii(valueView(reader, entry));

  if (entry.type === 5 || entry.type === 10) {
    const signed = entry.type === 10;
    const parts: string[] = [];
    // 值多的 RATIONAL（例如 GPSLatitude 的 3 个）全列出来，只取第一个会丢掉
    // 度分秒里的"分"和"秒"
    const limit = Math.min(entry.count, 16);
    for (let index = 0; index < limit; index++) {
      const pair = readRational(reader, entry, index, signed);
      if (!pair) break;
      if (name === 'ExposureTime' || name === 'ShutterSpeedValue') {
        parts.push(formatExposureTime(pair[0], pair[1]));
      } else {
        parts.push(formatRational(pair[0], pair[1]));
      }
    }
    if (entry.count > limit) parts.push('…');
    return parts.length > 0 ? parts.join(', ') : '—';
  }

  if (entry.type === 11 || entry.type === 12) {
    const parts: string[] = [];
    const limit = Math.min(entry.count, 8);
    for (let index = 0; index < limit; index++) {
      const value = readNumber(reader, entry, index);
      if (value === null) break;
      parts.push(String(Number(value.toFixed(6))));
    }
    if (entry.count > limit) parts.push('…');
    return parts.length > 0 ? parts.join(', ') : '—';
  }

  // 整数类型
  const parts: string[] = [];
  const limit = Math.min(entry.count, 16);
  for (let index = 0; index < limit; index++) {
    const value = readNumber(reader, entry, index);
    if (value === null) break;
    parts.push(String(value));
  }
  if (entry.count > limit) parts.push('…');

  const first = parts.length > 0 ? parts[0] : null;
  const numeric = first === null ? Number.NaN : Number(first);

  // 单个值且这张表认识它 → 附上含义
  if (entry.count === 1 && Number.isFinite(numeric)) {
    if (name === 'Orientation') {
      const meaning = ORIENTATION_MEANING[numeric];
      return meaning ? `${numeric}（${meaning}）` : String(numeric);
    }
    const table = ENUM_TABLES[name];
    const meaning = table ? table[numeric] : undefined;
    if (meaning) return `${numeric}（${meaning}）`;
    if (entry.tag === 0x9209) {
      // Flash 是一个位域，含义组合很多，因此只说"闪光灯有没有触发"
      return (numeric & 1) === 1 ? `${numeric}（闪光灯已触发）` : `${numeric}（未触发闪光灯）`;
    }
    if (entry.tag === 0xa001 && meaning === undefined) return String(numeric);
  }

  return parts.length > 0 ? parts.join(', ') : '—';
}

// ============================================================
// 遍历
// ============================================================

function parse(bytes: Uint8Array): ExifParse {
  const empty: ExifParse = { fields: [], orientation: null, hasOtherThanOrientation: false };
  if (bytes.length < 8) return empty;

  const isLittle = bytes[0] === 0x49 && bytes[1] === 0x49;
  const isBig = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!isLittle && !isBig) return empty;

  const reader = new TiffReader(bytes);
  // 魔数：`II` 是 42，`MM` 也是 42（字节序不同写法不同，但都等于 42）
  if (reader.u16(2) !== 42) return empty;

  const fields: ExifField[] = [];
  const visited = new Set<number>();
  let orientation: number | null = null;
  /** 见过哪些非指针 tag。用它算 `hasOtherThanOrientation` */
  let sawNonOrientation = false;

  /**
   * 走一个 IFD。
   *
   * `visited` 挡的是**环**：畸形（或刻意构造的）EXIF 可以让 ExifOffset 指回 IFD0，
   * 而递归在这里会直接爆栈 —— 一个爆栈的解析会让整个界面白掉，而它只是"这个文件
   * 的 EXIF 坏了"而已。
   */
  const walk = (offset: number, group: ExifField['group'], depth: number): void => {
    if (depth > 8 || offset <= 0 || visited.has(offset)) return;
    visited.add(offset);

    const entries = readIfd(reader, offset);
    for (const entry of entries) {
      const name = tagName(group, entry.tag);
      const spec = TYPE_TABLE[entry.type];
      const typeName = spec ? spec[0] : `TYPE${entry.type}`;

      fields.push({
        tag: entry.tag,
        name,
        group,
        value: formatValue(reader, entry, name),
        raw: `${typeName}×${entry.count}`,
      });

      if (entry.tag === 0x0112 && group === 'ifd0' && entry.count >= 1) {
        const value = readNumber(reader, entry, 0);
        if (value !== null && value >= 1 && value <= 8) orientation = value;
      }
      if (!(group === 'ifd0' && entry.tag === 0x0112) && !POINTER_TAGS.has(entry.tag)) {
        sawNonOrientation = true;
      }

      // 指针：值一定是 LONG×1，直接读
      if (entry.tag === 0x8769 && group === 'ifd0') {
        const next = readNumber(reader, entry, 0);
        if (next !== null) walk(next, 'exif', depth + 1);
      } else if (entry.tag === 0x8825 && group === 'ifd0') {
        const next = readNumber(reader, entry, 0);
        if (next !== null) walk(next, 'gps', depth + 1);
      } else if (entry.tag === 0xa005 && group === 'exif') {
        const next = readNumber(reader, entry, 0);
        if (next !== null) walk(next, 'interop', depth + 1);
      }
    }
  };

  const ifd0 = reader.u32(4);
  walk(ifd0, 'ifd0', 0);

  // IFD1 是 IFD0 的 next IFD（缩略图）。它挂在 IFD0 表尾的 4 字节里
  if (reader.within(ifd0, 2)) {
    const count = reader.u16(ifd0);
    const nextAt = ifd0 + 2 + count * 12;
    if (reader.within(nextAt, 4)) {
      const ifd1 = reader.u32(nextAt);
      if (ifd1 > 0) walk(ifd1, 'ifd1', 1);
    }
  }

  return {
    fields,
    orientation,
    // 只有方向一个字段、外加指向别的 IFD 的指针时，才算"没有别的东西"
    hasOtherThanOrientation: sawNonOrientation,
  };
}

/**
 * 解析一段 EXIF 字节（**从 TIFF 头开始**）。
 *
 * 输入是 PNG 的 `eXIf` 块内容或 JPEG 的 `APP1` 里 `Exif\0\0` 之后的部分 —— 两种
 * 容器都规定"从 `II*\0` / `MM\0*` 开始"，因此这里不做前缀剥离。JPEG 那 6 字节
 * `Exif\0\0` 由 JPEG 模块自己剥。
 */
export function parseExif(bytes: Uint8Array): ExifParse {
  try {
    return parse(bytes);
  } catch {
    // 任何意料之外的越界都不该让"看一眼元数据"失败。已经解析出来的部分是空的
    // 也没关系 —— 上层看到的是"没有 EXIF"，而不是一次异常。
    return { fields: [], orientation: null, hasOtherThanOrientation: false };
  }
}

// ============================================================
// 构造
// ============================================================

/**
 * 造一段**只含方向**的最小 EXIF。
 *
 * 布局（小端，26 字节）：
 *
 * ```
 *   0  49 49 2A 00   II*\0
 *   4  08 00 00 00   IFD0 在偏移 8
 *   8  01 00         1 个条目
 *   10 12 01 03 00   tag 0x0112, type SHORT(3)
 *   14 01 00 00 00   count = 1
 *   18 06 00 00 00   值（SHORT 内联在 4 字节里，高 2 字节按规范补 0）
 *   22 00 00 00 00   next IFD = 0
 * ```
 *
 * 为什么值得单独写一个构造器而不是"留一个最小 TIFF 常量"：方向值是参数，而
 * **把值写错位置是这个格式里最容易犯的错** —— SHORT 内联时值在 4 字节字段的
 * **前** 2 字节（小端），写到后 2 字节会得到一个 6×65536 的荒谬值，而且没有任何
 * 工具会报错，只会把图转错方向。
 *
 * 一律**小端**：两端都能被所有解析器读，但小端是 `II` 分支，字节写起来最不容易
 * 出错（写大端时"值在 4 字节字段的前 2 字节"这条会反过来，实测中那是踩过坑的地方）。
 */
export function buildOrientationExif(orientation: number): Uint8Array {
  // 值域外的一律夹到 1：写一个 0 或 9 会让查看器把它当成未知方向，效果与不写
  // 这个块一样，但多了一个"看起来有 EXIF"的假象
  const value = Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : 1;

  const out = new Uint8Array(26);
  out[0] = 0x49; // 'I'
  out[1] = 0x49; // 'I'
  out[2] = 0x2a; // 42
  out[3] = 0x00;
  // IFD0 偏移 = 8（头 8 字节之后就是它）
  out[4] = 0x08;
  // 条目数 = 1
  out[8] = 0x01;
  out[9] = 0x00;
  // tag 0x0112
  out[10] = 0x12;
  out[11] = 0x01;
  // type = SHORT(3)
  out[12] = 0x03;
  out[13] = 0x00;
  // count = 1
  out[14] = 0x01;
  out[15] = 0x00;
  out[16] = 0x00;
  out[17] = 0x00;
  // 值：SHORT 占 4 字节字段的**前** 2 字节，后 2 字节补 0
  out[18] = value & 0xff;
  out[19] = (value >>> 8) & 0xff;
  // next IFD = 0（out[22..26] 已经是 0，显式写出来只是为了让上面那张布局图与代码对得上）
  out[22] = 0x00;
  out[23] = 0x00;
  out[24] = 0x00;
  out[25] = 0x00;
  return out;
}
