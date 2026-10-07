// src/art-trace/codec/gif.ts
//
// GIF（87a / 89a）的解析与**无损**重建。
//
// ============================================================
// 为什么这个文件里最要命的是"子块链"
// ============================================================
//
// GIF 的可变长部分全部用同一种形状编码：**一个长度字节 + 那么多字节的数据，一个
// 长度为 0 的子块表示结束**。图像数据（LZW 压缩的像素）是子块链，注释扩展是子块链，
// 应用扩展也是子块链。
//
// 于是"跳过一段图像数据"这件事**不能**靠某个长度字段：图像描述符与结束块之间没有
// 总长度。唯一正确的做法是逐个子块读长度、往前走，直到那个 0。
//
// 少读一个子块 → 后面全部错位，可能把调色板的字节当成图像描述符，读出一串不存在
// 的帧；多读一个子块 → 直接跨过图片结束块。两种错法的表现都是"解析出来一堆莫名其
// 妙的块"，而文件本身完全正常 —— 因此这里把子块链单独写成一个函数，只在这一处
// 实现它，任何别的写法都容易在某个分支上漏掉一个字节。
//
// 另外一条：**不解压 LZW**。我们要丢的是注释与应用扩展，像素一个字节都不需要懂。
// 解压再压缩是有损的（GIF 的调色板索引一模一样，但重编码可能换掉压缩表），而且会
// 把"无损清理"变成"重画一张图"。

import type { ImageInfo } from '../model/types';
import type { ContainerBlock, FormatParse, RebuildOptions } from './format';
import { extractXmpFromText, summarizeXmp } from './xmp';
import {
  ByteWriter,
  formatBytes,
  latin1Decode,
  latin1Encode,
  smartDecode,
  toDisplayText,
} from './bytes';

/** 一个块：从 `0x2C` / `0x21` / `0x3B` 那个引导字节开始，到它自己的边界为止 */
interface GifBlock {
  block: ContainerBlock;
  /** 这一块的原始字节（含引导字节、含子块链的结束 0），**视图**，不复制 */
  raw: Uint8Array;
  kind: 'image' | 'comment' | 'app' | 'gce' | 'plaintext' | 'unknown' | 'trailer';
}

interface GifParseState {
  frames: number;
  globalPaletteColors: number;
  hasLocalPalette: boolean;
  localPaletteBits: number;
  animated: boolean;
  xmp: string | null;
  c2pa: string[];
}

const MAX_SUB_BLOCK = 255;

/**
 * 解析一个 GIF。
 *
 * 只有"缺 `GIF87a` / `GIF89a` 头"才算失败。缺结束块、图像数据被截断、子块链中途
 * 断掉 —— 这些都是**正常结果**：把已经读到的块返回，并把"文件不完整"写进块里。
 */
export function parseGif(bytes: Uint8Array): FormatParse {
  const signature = latin1Decode(bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new Error('不是 GIF 文件：开头不是 GIF87a / GIF89a');
  }

  const state: GifParseState = {
    frames: 0,
    globalPaletteColors: 0,
    hasLocalPalette: false,
    localPaletteBits: 0,
    animated: false,
    xmp: null,
    c2pa: [],
  };
  const blocks: GifBlock[] = [];
  const notes: string[] = [];

  // ---- 逻辑屏幕描述符：宽(2) 高(2) 打包(1) 背景色索引(1) 像素宽高比(1) ----
  if (bytes.length < 13) {
    throw new Error(`不是完整的 GIF：头之后只有 ${bytes.length} 字节，放不下逻辑屏幕描述符`);
  }
  const width = readU16Le(bytes, 6);
  const height = readU16Le(bytes, 8);
  const packed = bytes[10];
  const hasGlobalPalette = (packed & 0x80) !== 0;
  // 调色板大小：2^(N+1) 项，N 是打包字段低 3 位。全局调色板是每项 3 字节
  const paletteColors = hasGlobalPalette ? 1 << ((packed & 0x07) + 1) : 0;
  const paletteBytes = paletteColors * 3;
  state.globalPaletteColors = paletteColors;

  const headerEnd = 13 + paletteBytes;
  if (headerEnd > bytes.length) {
    // 调色板本身被截断：不抛错，把文件当成"没有可解析的块"，并把原因说出来
    notes.push(
      `全局调色板需要 ${paletteBytes} 字节但文件只剩 ${bytes.length - 13} 字节（截断）`
    );
  }
  const headerRaw = bytes.subarray(0, Math.min(headerEnd, bytes.length));

  blocks.push({
    block: {
      id: 'gif:header:0',
      selector: 'Header',
      label: `文件头与逻辑屏幕（${signature}）`,
      group: 'structural',
      text: `${signature}，画布 ${width}×${height}，${
        hasGlobalPalette ? `全局调色板 ${paletteColors} 色` : '无全局调色板'
      }${notes.length > 0 ? `（${notes[0]}）` : ''}`,
      bytes: headerRaw.length,
      removable: false,
      structural: true,
      orientation: null,
    },
    raw: headerRaw,
    kind: 'unknown',
  });

  // ---- 块序列 ----
  let at = headerEnd;
  let sawTrailer = false;

  while (at < bytes.length) {
    const introducer = bytes[at];
    const start = at;
    // eslint-disable-next-line no-console
    console.log('[G]', at, introducer === undefined ? 'EOF' : '0x' + introducer.toString(16));

    if (introducer === 0x3b) {
      // 结束块。它也是逐字节搬运的 —— 少了它，所有解码器都认为文件被截断
      at += 1;
      sawTrailer = true;
      blocks.push({
        block: {
          id: `gif:trailer:${start}`,
          selector: 'Trailer',
          label: 'Trailer（文件结束）',
          group: 'structural',
          text: '文件结束块（0x3B）',
          bytes: 1,
          removable: false,
          structural: true,
          orientation: null,
        },
        raw: bytes.subarray(start, at),
        kind: 'trailer',
      });
      break;
    }

    if (introducer === 0x2c) {
      // 图像描述符：左(2) 上(2) 宽(2) 高(2) 打包(1)，打包字段的最高位表示有没有
      // 局部调色板，低 3 位是它的大小
      if (at + 10 > bytes.length) {
        notes.push(`位置 ${at} 的图像描述符不完整（截断）`);
        break;
      }
      const framePacked = bytes[at + 9];
      const hasLocal = (framePacked & 0x80) !== 0;
      const localBits = (framePacked & 0x07) + 1;
      const localBytes = hasLocal ? (1 << localBits) * 3 : 0;
      let cursor = at + 10 + localBytes;
      if (hasLocal) {
        state.hasLocalPalette = true;
        state.localPaletteBits = Math.max(state.localPaletteBits, localBits);
      }
      const subBlocks = skipSubBlocks(bytes, cursor);
      // eslint-disable-next-line no-console
      console.log('[I] cursor=', cursor, 'subBlocks=', subBlocks, 'localBytes=', localBytes, 'bytes.length=', bytes.length, 'at=', at);
      if (subBlocks === -1) {
        // 子块链没有结束的 0。把剩下的字节全收成这一块，并在这里停下 ——
        // 继续往前找块只会在垃圾里乱撞，找出根本不存在的"帧"
        notes.push('图像数据（LZW 子块链）没有结束标记，文件被截断');
        cursor = bytes.length;
      } else {
        cursor = subBlocks;
      }
      state.frames++;
      const frameWidth = readU16Le(bytes, at + 5);
      const frameHeight = readU16Le(bytes, at + 7);
      blocks.push({
        block: {
          id: `gif:image:${start}`,
          selector: 'Image',
          label: `图像描述符（${frameWidth}×${frameHeight}）`,
          group: 'structural',
          // 图像数据是 LZW 压缩的，我们不解压 —— 这里只报告它的位置与大小
          text: `第 ${state.frames} 帧，${frameWidth}×${frameHeight}，LZW 图像数据 ${formatBytes(
            Math.max(0, cursor - (at + 10 + localBytes))
          )}${hasLocal ? `，含局部调色板 ${1 << localBits} 色` : ''}`,
          bytes: cursor - start,
          removable: false,
          structural: true,
          orientation: null,
        },
        raw: bytes.subarray(start, cursor),
        kind: 'image',
      });
      at = cursor;
      continue;
    }

    if (introducer === 0x21) {
      const label = at + 1 < bytes.length ? bytes[at + 1] : -1;
      let block: GifBlock | null = null;

      if (label === 0xf9) {
        // 图形控制扩展：延迟时间与透明色索引都在这里，它**影响渲染**，因此永远保留。
        // 当元数据丢掉它，动画的帧时长与透明背景会变 —— 那是把图弄坏，不是清理
        const size = at + 2 < bytes.length ? bytes[at + 2] : 0;
        const end = at + 3 + size;
        const terminated = end < bytes.length && bytes[end] === 0x00;
        const cursor = terminated ? end + 1 : Math.min(end, bytes.length);
        const within = at + 3 + 4 <= bytes.length;
        const gcePacked = within ? bytes[at + 3] : 0;
        const delay = within ? readU16Le(bytes, at + 4) : 0;
        const transparentIndex = within ? bytes[at + 6] : 0;
        if (!terminated) notes.push(`位置 ${at} 的图形控制扩展没有结束标记（截断）`);
        block = {
          block: {
            id: `gif:gce:${start}`,
            selector: 'GCE',
            label: '图形控制扩展',
            group: 'structural',
            text: `延迟 ${delay * 10} 毫秒，${
              (gcePacked & 0x01) !== 0 ? `透明色索引 ${transparentIndex}` : '无透明色'
            }${(gcePacked & 0x02) !== 0 ? '，需要用户输入才继续' : ''}`,
            bytes: cursor - start,
            removable: false,
            structural: true,
            orientation: null,
          },
          raw: bytes.subarray(start, cursor),
          kind: 'gce',
        };
        at = cursor;
      } else if (label === 0xfe) {
        // 注释扩展。这是**最纯的元数据**：它不影响任何渲染，只是"写在文件里的话"，
        // 而生成器（以及一些编辑器）很乐意把作者、参数、软件名写在这里
        const { cursor, data, complete } = readSubBlocks(bytes, at + 2);
        if (!complete) notes.push('注释扩展的子块链没有结束标记（截断）');
        const text = smartDecode(data).replace(/\0+$/, '');
        block = {
          block: {
            id: `gif:comment:${start}`,
            selector: 'Comment',
            label: '注释扩展',
            group: 'text',
            text:
              text.trim().length === 0
                ? `注释扩展，${formatBytes(data.length)}（内容为空）`
                : `注释：${toDisplayText(text.replace(/\s+/g, ' ').trim(), 200)}`,
            bytes: cursor - start,
            removable: true,
            structural: false,
            orientation: null,
          },
          raw: bytes.subarray(start, cursor),
          kind: 'comment',
        };
        at = cursor;
      } else if (label === 0xff) {
        // 应用扩展：`21 FF` 之后是 **11 字节**的应用标识（8 字节名 + 3 字节认证码），
        // 然后是数据子块链。
        //
        // 这里是整个文件里最容易差一个字节的地方：引导字节 `21` 与标签 `FF` 各占一个
        // 字节，因此标识从 `at + 3` 开始 —— 写成 `at + 2` 会把标签 `FF` 读成标识的
        // 第一个字符，于是 `NETSCAPE2.0` 变成 `\x0bNETSCAPE2.`，谁都匹配不上，而
        // 更糟的是子块链的起点也跟着错一位，整段解析从这里开始全错。
        const idStart = at + 3;
        if (idStart + 11 > bytes.length) {
          notes.push(`位置 ${at} 的应用扩展标识不完整（截断）`);
          break;
        }
        // 有些工具把标识写成 8 字符名 + 3 个 0（不按规范补认证码），因此这里两种
        // 写法都要能用：先去尾部的 0 与控制字符，再截到 8 字符去比
        const rawAppId = latin1Decode(bytes.subarray(idStart, idStart + 11));
        const appId = rawAppId.replace(/[\u0000-\u001f\u007f]+$/, '');
        const appKey = appId.slice(0, 8).replace(/[\u0000-\u001f\u007f]+$/, '');
        const { cursor, data, complete } = readSubBlocks(bytes, idStart + 11);
        if (!complete) notes.push(`应用扩展 ${appId} 的子块链没有结束标记（截断）`);

        if (appKey === 'NETSCAPE' || rawAppId.startsWith('NETSCAPE2.0')) {
          // NETSCAPE2.0 的循环次数子块（1 + 2 字节）决定动画循环几遍。它**不是**
          // 元数据而是播放行为的一部分 —— 丢了动画就只播一遍。因此保留
          const loops = data.length >= 3 ? readU16Le(data, 1) : null;
          block = {
            block: {
              id: `gif:app:${start}`,
              selector: 'AppExtension:NETSCAPE2.0',
              label: '应用扩展(NETSCAPE2.0)',
              group: 'structural',
              text: `循环次数 ${loops === null ? '读不出' : loops === 0 ? '无限' : loops}`,
              bytes: cursor - start,
              removable: false,
              structural: true,
              orientation: null,
            },
            raw: bytes.subarray(start, cursor),
            kind: 'app',
          };
        } else if (appId.startsWith('XMP Data') || rawAppId.startsWith('XMP DataXMP')) {
          // XMP 在 GIF 里的落法就是这个约定。数据里还夹着一个"魔术尾"（258 字节的
          // 固定模式），因此交给 extractXmpFromText 去定位 <?xpacket 到 </xmpmeta>
          const text = smartDecode(data);
          try {
            const xmp = extractXmpFromText(text);
            state.xmp = xmp;
            block = {
              block: {
                id: `gif:app:${start}`,
                selector: 'AppExtension:XMP',
                label: '应用扩展(XMP)',
                group: 'xmp',
                text: `XMP 包，${formatBytes(data.length)}${xmp === null ? '；没找到 xmpmeta 标记' : summarize(xmp)}`,
                bytes: cursor - start,
                removable: true,
                structural: false,
                orientation: null,
              },
              raw: bytes.subarray(start, cursor),
              kind: 'app',
            };
          } catch (error) {
            state.xmp = null;
            block = {
              block: {
                id: `gif:app:${start}`,
                selector: 'AppExtension:XMP',
                label: '应用扩展(XMP)',
                group: 'xmp',
                text: `XMP 包，${formatBytes(data.length)}；提取失败：${errorText(error)}`,
                bytes: cursor - start,
                removable: true,
                structural: false,
                orientation: null,
              },
              raw: bytes.subarray(start, cursor),
              kind: 'app',
            };
          }
        } else {
          // 其它厂商应用标识：ComfyUI 一类生成器就喜欢把参数塞在这里。认不出内容
          // 也照样列出来 —— 静默丢一个装满了参数的应用扩展是最坏的结果
          const printable = latin1Decode(data.subarray(0, 32)).replace(
            /[\u0000-\u001f\u007f]/g,
            '.'
          );
          block = {
            block: {
              id: `gif:app:${start}`,
              selector: 'AppExtension',
              label: `应用扩展(${appId || '未命名'})`,
              group: 'other',
              text: `厂商标识 ${JSON.stringify(appId)}，数据 ${formatBytes(
                data.length
              )}${printable.trim().length > 0 ? `，开头：${toDisplayText(printable, 60)}` : ''}`,
              bytes: cursor - start,
              removable: true,
              structural: false,
              orientation: null,
            },
            raw: bytes.subarray(start, cursor),
            kind: 'app',
          };
        }
        at = cursor;
      } else if (label === 0x01) {
        // 明文扩展（渲染成一段文字）。它影响显示，因此和图形控制扩展一样保留
        const { cursor, complete } = readSubBlocks(bytes, at + 2);
        if (!complete) notes.push('明文扩展的子块链没有结束标记（截断）');
        block = {
          block: {
            id: `gif:plaintext:${start}`,
            selector: 'PlainText',
            label: '明文扩展',
            group: 'structural',
            text: '明文扩展（渲染成一段文字，影响画面）',
            bytes: cursor - start,
            removable: false,
            structural: true,
            orientation: null,
          },
          raw: bytes.subarray(start, cursor),
          kind: 'plaintext',
        };
        at = cursor;
      } else {
        // 其余标签（0x00 之类的保留值）。按通用子块链跳过，并标记成可丢的未知块
        const { cursor, complete } = readSubBlocks(bytes, at + 2);
        if (!complete) notes.push(`位置 ${at} 的扩展块（标签 0x${label.toString(16)}）被截断`);
        block = {
          block: {
            id: `gif:ext:${start}`,
            selector: 'Extension',
            label: `扩展块(0x${label.toString(16).padStart(2, '0')})`,
            group: 'other',
            text: `认不出的扩展块，标签 0x${label.toString(16).padStart(2, '0')}`,
            bytes: cursor - start,
            removable: true,
            structural: false,
            orientation: null,
          },
          raw: bytes.subarray(start, cursor),
          kind: 'unknown',
        };
        at = cursor;
      }

      if (block) blocks.push(block);
      // 游标没有前进（例如标签后面的长度字节是人为构造的坏值）：强制往前一步，
      // 否则这里会死循环 —— 而死循环的界面表现是"卡住不响应"，比报错更难查
      if (at <= start) at = start + 1;
      continue;
    }

    // 认不出的引导字节。真实的 GIF 到这里就是坏了，但前面读到的块仍然有用
    notes.push(`位置 ${at} 的引导字节是 0x${(introducer ?? 0).toString(16)}，不是已知的块类型，停止解析`);
    break;
  }

  if (!sawTrailer) {
    notes.push('没有找到结束块（0x3B），文件可能在图像数据中途被截断');
    // 把尾部剩下的字节收成一块，重建时逐字节搬回去 —— 丢掉它们就等于把文件改小，
    // 而用户要的是"清理元数据"，不是"截断文件"
    const tailStart = blocks.reduce((max, item) => Math.max(max, endOf(item)), headerEnd);
    if (tailStart < bytes.length) {
      blocks.push({
        block: {
          id: `gif:tail:${tailStart}`,
          selector: 'Tail',
          label: '文件尾部（无结束块）',
          group: 'structural',
          text: `没有结束块之后的 ${formatBytes(bytes.length - tailStart)} 字节`,
          bytes: bytes.length - tailStart,
          removable: false,
          structural: true,
          orientation: null,
        },
        raw: bytes.subarray(tailStart),
        kind: 'unknown',
      });
    }
  }

  state.animated = state.frames > 1;

  if (notes.length > 0) {
    // 把"文件有毛病"挂到头部块上：它永远保留，因此这句话不会因为用户丢掉了某个
    // 注释块就消失
    const header = blocks[0];
    if (header) header.block.text = `${header.block.text}（${notes.join('；')}）`;
  }

  const info = buildInfo(bytes.length, width, height, state);

  return {
    info,
    blocks: blocks.map((item) => item.block),
    // GIF 没有 EXIF（方向在别处：GIF 没有方向概念），因此这两个字段诚实地说没有
    exif: null,
    xmp: state.xmp,
    iccBytes: 0,
    c2pa: state.c2pa,
    rewritable: true,
    blockedReason: null,
    rebuild: (options: RebuildOptions) => rebuildGif(blocks, options),
  };
}

/** 一块在原文件里结束于哪个偏移（用于找"没有结束块时的尾巴"） */
function endOf(item: GifBlock): number {
  const id = item.block.id;
  const parts = id.split(':');
  const start = Number(parts[parts.length - 1]);
  if (!Number.isFinite(start)) return 0;
  return start + item.raw.length;
}

function readU16Le(bytes: Uint8Array, at: number): number {
  if (at + 2 > bytes.length) return 0;
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * 跳过一条子块链，返回链结束（那个 0 字节之后）的偏移。
 *
 * **这是这个文件里最容易写错的地方**：GIF 的图像数据没有总长度字段，唯一的边界
 * 就是"长度为 0 的子块"。少走一个子块会把后面的字节当成块引导字节，多走一个会
 * 跨过整个文件。返回 -1 表示链没有结束（文件被截断），由调用方决定怎么收尾。
 */
function skipSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at < bytes.length) {
    const size = bytes[at];
    at += 1;
    if (size === 0) return at; // 结束标记
    at += size;
  }
  return -1;
}

/**
 * 读取一条子块链的内容（把它们拼起来），同时返回链结束的偏移。
 *
 * `complete` 为 false 表示链没有结束标记：此时 `cursor` 停在文件尾，内容仍然是
 * 已经读到的那些 —— 一个被截断的注释块里的半句话，比"什么都没有"有用。
 */
function readSubBlocks(
  bytes: Uint8Array,
  from: number
): { cursor: number; data: Uint8Array; complete: boolean } {
  const pieces: Uint8Array[] = [];
  let at = from;
  let total = 0;
  while (at < bytes.length) {
    const size = bytes[at];
    at += 1;
    if (size === 0) {
      return { cursor: at, data: join(pieces, total), complete: true };
    }
    const end = Math.min(at + size, bytes.length);
    pieces.push(bytes.subarray(at, end));
    total += end - at;
    at = end;
  }
  return { cursor: bytes.length, data: join(pieces, total), complete: false };
}

function join(pieces: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
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

function buildInfo(
  fileLength: number,
  width: number,
  height: number,
  state: GifParseState
): ImageInfo {
  // 调色板的位数：每项的位数 = 3 × 表里的位数（颜色表是按"分量个数的幂"定大小的）
  const globalBits = state.globalPaletteColors > 0 ? log2(state.globalPaletteColors) : 0;
  const bitDepth = (globalBits + state.localPaletteBits) * 3;
  const parts: string[] = [];
  parts.push(
    state.globalPaletteColors > 0 ? `全局调色板(${state.globalPaletteColors})` : '无全局调色板'
  );
  if (state.hasLocalPalette) {
    parts.push(`含局部调色板(${1 << state.localPaletteBits})`);
  }
  return {
    format: 'gif',
    width,
    height,
    bitDepth: bitDepth > 0 ? bitDepth : null,
    colorModel: parts.join('，'),
    // GIF 没有隔行扫描；图像描述符里那个"隔行"位是逐帧的，而且不影响容器解析
    interlaced: false,
    animated: state.animated,
    frames: state.frames,
    bytes: fileLength,
  };
}

/** 表项个数是 2 的幂，取它的指数 */
function log2(value: number): number {
  let bits = 0;
  let current = value;
  while (current > 1) {
    current >>= 1;
    bits++;
  }
  return bits;
}

// ============================================================
// 重建
// ============================================================

/**
 * 按丢掉集合与追加集合重建一个 GIF。
 *
 * 顺序：头部与逻辑屏幕（逐字节）→ 保留的块（**按原顺序**，含图像数据与调色板，
 * 一律逐字节搬运）→ 追加的注释扩展 → 结束块。
 *
 * 追加内容写成**注释扩展**：它是 GIF 里唯一"纯文本、不影响渲染"的载体，和 PNG 的
 * `tEXt` 位置相当。应用扩展要带 11 字节的厂商标识，凭空捏一个等于冒充某个厂商；
 * 注释扩展没有这个问题。
 *
 * `keepOrientation` 在这里被忽略：GIF 没有方向这个概念（没有 EXIF 容器，画面摆放
 * 就是像素的排列）。忽略而不是报错 —— 清理策略是全局设置，用户不该因为处理了一张
 * GIF 就得关掉"保留方向"。
 */
function rebuildGif(blocks: GifBlock[], options: RebuildOptions): Uint8Array {
  const writer = new ByteWriter(4096);

  for (const item of blocks) {
    if (item.kind === 'trailer') {
      // 追加内容插在结束块**之前**：结束块之后的东西规范上没有定义，放那里等于
      // 写了一段大多数解析器都不会读的垃圾
      writeAppended(writer, options);
      writer.bytes(item.raw);
      continue;
    }
    if (options.drop.has(item.block.selector)) continue;
    writer.bytes(item.raw);
  }

  // 原文件没有结束块（截断的 GIF）：追加内容仍然要写出去，否则"我追加了版权信息"
  // 这个操作会静默失败
  const hadTrailer = blocks.some((item) => item.kind === 'trailer');
  if (!hadTrailer) writeAppended(writer, options);

  return writer.toBytes();
}

/**
 * 追加内容落成注释扩展：`0x21 0xFE` + 一条子块链 + 结束的 0。
 *
 * 子块每块最多 255 字节，超过要切。切错（例如每块写 256 字节）会让长度字节溢出成
 * 0，而长度为 0 的子块表示"扩展结束" —— 后面那半句话会变成一堆"未知块"，或者
 * 干脆把结束块吞掉。
 */
function writeAppended(writer: ByteWriter, options: RebuildOptions): void {
  for (const item of options.append) {
    const text = `${item.key}: ${item.value}`;
    const data = latin1Encode(text);
    writer.u8(0x21).u8(0xfe);
    for (let at = 0; at < data.length; at += MAX_SUB_BLOCK) {
      const piece = data.subarray(at, at + MAX_SUB_BLOCK);
      writer.u8(piece.length);
      writer.bytes(piece);
    }
    // 内容为空时也要写这个 0，否则这个扩展没有边界
    writer.u8(0x00);
  }
}
