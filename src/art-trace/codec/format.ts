// src/art-trace/codec/format.ts
//
// 容器格式的统一契约。
//
// ============================================================
// 为什么要有这一层，而不是让每个调用点自己 switch
// ============================================================
//
// PNG 的块、JPEG 的段、RIFF 的 chunk 在结构上完全不同，但**对上层而言它们是同一件
// 事**：一张图有一批"可以丢掉的东西"，以及一批"丢了就坏"的东西。把这件事定成一个
// 接口（`FormatParse`）之后，`clean/`、`trace/`、`ui/` 里没有任何一处需要知道
// "这是 PNG 还是 JPEG" —— 而那种 switch 一旦散开，加一种格式就要改五处。
//
// 每个格式模块只做两件事：
//   * `parse(bytes)` —— 把容器读成结构化描述（含一批块）
//   * `parse(...).rebuild(options)` —— 按丢掉集合与追加集合重建一个新的容器
//
// ============================================================
// 三条对格式模块的硬约束
// ============================================================
//
// 1. **解析必须容错。** 真实文件是有毛病的：截断的块、长度字段说谎、CRC 对不上。
//    遇到这些要**跳过那一块并继续**，而不是整体抛错 —— 一个坏块不该让用户看不到
//    其余几十个块的内容。只有"连头都认不出来"才返回失败。
//
// 2. **重建必须无损。** 除了被丢掉的块与被追加的内容，其余字节逐字节不变。尤其是
//    像素数据（PNG 的 IDAT、JPEG 的熵编码段、RIFF 的帧数据）**原样搬运**，不经过
//    任何解码再编码。这是"清理痕迹"与"重画一张图"的分界线。
//
// 3. **块 id 必须稳定。** 同一份字节解析两次要得到同一批 id —— 界面用它们做列表
//    key，而每次渲染都换一批 key 会让 React 重建整个列表，表现为滚动位置跳动。

import type { ImageFormat, ImageInfo, MetaGroup } from '../model/types';

/** 容器里的一个块，已经解码成可以显示、可以单独丢弃的样子。 */
export interface ContainerBlock {
  /** 稳定 id。格式模块负责保证"同样的字节 → 同样的 id" */
  id: string;
  /**
   * 重建时的选择键。丢块就是"把这个键放进 `drop` 集合"。
   *
   * 与 `id` 的区别：`id` 要唯一（列表 key），而 `selector` 可以对应多个块
   * （例如"所有 `tEXt` 块"）。**它们通常相同**，只有"一个键对应多个块"时才分开。
   */
  selector: string;
  /** 容器里的确切名字，例如 `tEXt(parameters)`、`eXIf`、`APP1(Exif)` */
  label: string;
  group: MetaGroup;
  /** 解码后的文本；二进制块给一句说明 */
  text: string;
  /** 在文件里占的原始字节数 */
  bytes: number;
  /** 抹除时**默认**要不要丢 */
  removable: boolean;
  /** 结构性块：丢了文件就坏（IHDR、SOF、RIFF 的 VP8/VP8L、帧控制…）。它们永远保留 */
  structural: boolean;
  /** 这一块里的方向信息（EXIF Orientation 的值）；没有则 `null` */
  orientation: number | null;
  /**
   * 识别出的来源，例如 `ComfyUI`。
   *
   * **可选，而且刻意如此。** 容器层（`codec/*`）只负责把字节读成块，它**不可能**
   * 知道"这一段文本是 A1111 的参数"—— 那要等语义层（`gen/*`）看过内容才知道。
   * 因此容器层不填它（`undefined`），`gen/tagGeneratedBlocks` 在识别之后补上
   * （`null` 表示"看过了，认不出来"）。
   *
   * 这两种取值的区别是有意的：`undefined` 是"还没看"，`null` 是"看了，没有"。
   * 界面据此能把"没识别出生成器"与"这一块还没被识别过"分开 —— 虽然当前两者
   * 都不显示，但把语义写清楚比事后猜要便宜。
   */
  origin?: string | null;
}

/** 重建选项。`clean/` 把它算好之后交给格式模块。 */
export interface RebuildOptions {
  /** 要丢掉的 `selector` 集合 */
  drop: Set<string>;
  /** 要追加的文本块。格式模块按自己的能力落成 `tEXt` / `COM` / `EXIF` / `XMP` */
  append: Array<{ key: string; value: string }>;
  /**
   * 保留方向信息。
   *
   * 为真且 `orientation` 不为 `null` 且不等于 1 时，格式模块应当写回一个**只含
   * 方向**的最小结构 —— 直接丢掉它会让竖拍图在查看器里变成横的。
   */
  keepOrientation: boolean;
  /** 解析时读到的方向值 */
  orientation: number | null;
}

/** 一个格式模块解析出来的全部东西。 */
export interface FormatParse {
  info: ImageInfo;
  blocks: ContainerBlock[];
  /** EXIF 的原始字节（TIFF 头开始），重建时要重新解释 */
  exif: Uint8Array | null;
  /** XMP 包的原文 */
  xmp: string | null;
  /** ICC 描述文件字节数 */
  iccBytes: number;
  /** 在哪几个地方发现了 C2PA / Content Credentials */
  c2pa: string[];
  /** 这个容器能不能被本插件重建 */
  rewritable: boolean;
  /** 不能重建时的原因（给用户看） */
  blockedReason: string | null;
  /** 重建出一个新容器 */
  rebuild(options: RebuildOptions): Uint8Array;
}

/** 图片文件头的探测结果。**以字节为准，不看扩展名。** */
export function detectFormat(bytes: Uint8Array): ImageFormat {
  const is = (offset: number, ...values: number[]): boolean => {
    if (bytes.length < offset + values.length) return false;
    for (let i = 0; i < values.length; i++) {
      if (bytes[offset + i] !== values[i]) return false;
    }
    return true;
  };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  // JPEG: FF D8 FF
  if (is(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  // RIFF....WEBP
  if (is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  // GIF87a / GIF89a
  if (is(0, 0x47, 0x49, 0x46, 0x38) && (is(4, 0x37) || is(4, 0x39)) && is(5, 0x61)) {
    return 'gif';
  }
  // BMP: 'BM'
  if (is(0, 0x42, 0x4d)) return 'bmp';
  // TIFF: II*\0 或 MM\0*
  if (is(0, 0x49, 0x49, 0x2a, 0x00) || is(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
  // AVIF: ....ftypavif
  if (is(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0
    );
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return 'unknown';
}

/**
 * 把一段字节解析成统一的容器描述。
 *
 * 认不出来的格式**返回带原因的失败对象，而不是抛错** —— "这张图我看不懂"是一个
 * 正常结果，界面上要画成一句解释加上文件名，而不是一次异常。
 */
export interface ContainerParseResult {
  ok: boolean;
  format: ImageFormat;
  parse: FormatParse | null;
  /** 失败原因，给用户看 */
  error: string | null;
  /** 原始字节（重建时需要，因此一并带上） */
  bytes: Uint8Array;
}

/**
 * 格式模块的加载表。
 *
 * 用**动态 import 的静态写法**（一个 map）而不是逐格式 if：新增一种格式只需要在
 * 这里加一行与一个文件，而调用点一处都不用改。esbuild 会把这些相对导入静态地
 * 打进同一个产物里，因此这里没有运行期加载失败的问题。
 */
import { parsePng } from './png';
import { parseJpeg } from './jpeg';
import { parseWebp } from './webp';
import { parseGif } from './gif';

export function parseContainer(bytes: Uint8Array): ContainerParseResult {
  const format = detectFormat(bytes);

  try {
    switch (format) {
      case 'png':
        return { ok: true, format, parse: parsePng(bytes), error: null, bytes };
      case 'jpeg':
        return { ok: true, format, parse: parseJpeg(bytes), error: null, bytes };
      case 'webp':
        return { ok: true, format, parse: parseWebp(bytes), error: null, bytes };
      case 'gif':
        return { ok: true, format, parse: parseGif(bytes), error: null, bytes };
      default:
        return {
          ok: false,
          format,
          parse: null,
          error:
            format === 'unknown'
              ? '认不出这个文件的格式（它不是 PNG / JPEG / WebP / GIF 中的任何一种）'
              : `${format.toUpperCase()} 格式可以读取基本信息，但本插件还不能清理它的元数据`,
          bytes,
        };
    }
  } catch (error) {
    return {
      ok: false,
      format,
      parse: null,
      error: `解析失败：${error instanceof Error ? error.message : String(error)}`,
      bytes,
    };
  }
}
