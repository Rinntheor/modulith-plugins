// src/art-trace/codec/xmp.ts
//
// XMP（Adobe 的元数据包）提取与摘要。
//
// ============================================================
// 为什么这里不写 XML 解析器
// ============================================================
//
// XMP 在容器里的样子是"一坨 XML 塞在一个块里"，而它那坨 XML 的形态至少有三种：
//
//   * `<?xpacket begin=...?>` 包着 `<x:xmpmeta>`（Adobe 系，最标准）
//   * 只有 `<x:xmpmeta>`（不少生成器把 xpacket 外壳省了）
//   * `<rdf:RDF>` 直接裸着，或者干脆只给一串 `dc:creator="..."` 属性
//
// 写一个"够用"的 XML 解析器要处理命名空间、CDATA、自闭合标签、实体、以及几十种
// 畸形写法 —— 而这里**只想要几个字段**。因此本文件用正则做**定向抽取**：认得
// 属性形式与元素形式两种常见写法，认不出来的就当作没有。
//
// 代价是明确的：**复杂结构（嵌套 rdf:Bag 里的结构体、xml:lang 的多种语言变体）
// 只会取到第一个值。** 那种情况下用户看到的是"少了一个字段"，而不是一个错误的
// 值 —— 对一个"摘要列表"来说这是正确的取舍。真要完整的 XMP 语义，得引一个真正的
// 解析器，而插件不允许引第三方包。

import { indexOfBytes, latin1Decode, utf8Decode } from './bytes';

// ============================================================
// 定位
// ============================================================

/** XMP 包的开头。有了它才算"这是一整包 XMP"，否则只能截到 `</x:xmpmeta>` */
const PACKET_BEGIN = latin1Bytes('<?xpacket');
/** 没有 xpacket 外壳时的起点 */
const XMPMETA_BEGIN = latin1Bytes('<x:xmpmeta');
/** 没有 xpacket 时的终点 */
const XMPMETA_END = latin1Bytes('</x:xmpmeta>');
/** xpacket 的结束指令。它**带着属性**（`end="w"` / `end='r'`），必须补到 `?>` */
const PACKET_END = latin1Bytes('<?xpacket end=');

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 从字节里提取 XMP 包原文。
 *
 * **先按字节找，再解码。** 反过来（先整段 UTF-8 解码再 indexOf）也能work，但要先
 * 把整个块解成字符串 —— 一个 2 MB 的 `eXIf` 里可能根本没有 XMP，却已经付了一次
 * 解码的代价。而且 UTF-8 是自同步的（ASCII 字节永远不会出现在多字节序列的续字节
 * 位置上），因此 ASCII 标记按字节匹配与我们想要的语义**完全等价**。
 */
export function extractXmp(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  const packetAt = indexOfBytes(bytes, PACKET_BEGIN, 0);
  const metaAt = indexOfBytes(bytes, XMPMETA_BEGIN, 0);

  let start = -1;
  if (packetAt >= 0) start = packetAt;
  else if (metaAt >= 0) start = metaAt;
  if (start < 0) return null;

  let end = -1;
  if (packetAt >= 0) {
    const endAt = indexOfBytes(bytes, PACKET_END, packetAt);
    if (endAt >= 0) {
      const close = indexOfBytes(bytes, latin1Bytes('?>'), endAt);
      // `?>` 找不到说明文件被截断了 —— 那就当它一直延伸到末尾，至少把内容交出去。
      end = close >= 0 ? close + 2 : bytes.length;
    }
  }
  if (end < 0) {
    const metaEndAt = indexOfBytes(bytes, XMPMETA_END, start);
    end = metaEndAt >= 0 ? metaEndAt + XMPMETA_END.length : bytes.length;
  }

  const slice = bytes.subarray(start, Math.min(end, bytes.length));
  const text = utf8Decode(slice);
  return text.length > 0 ? text : null;
}

/**
 * 同上，但输入已经是文本。
 *
 * 单独一个入口而不是让调用方自己编码回字节再走 `extractXmp`：PNG 的 `iTXt`
 * 本来就是文本，绕一圈编码回 UTF-8 只为了再解码一次是纯粹的浪费。
 */
export function extractXmpFromText(text: string): string | null {
  if (text.length === 0) return null;

  const packetAt = text.indexOf('<?xpacket');
  const metaAt = text.indexOf('<x:xmpmeta');
  const start = packetAt >= 0 ? packetAt : metaAt;
  if (start < 0) return null;

  let end = -1;
  if (packetAt >= 0) {
    const endAt = text.indexOf('<?xpacket end=', packetAt);
    if (endAt >= 0) {
      const close = text.indexOf('?>', endAt);
      end = close >= 0 ? close + 2 : text.length;
    }
  }
  if (end < 0) {
    const metaEndAt = text.indexOf('</x:xmpmeta>', start);
    end = metaEndAt >= 0 ? metaEndAt + '</x:xmpmeta>'.length : text.length;
  }

  const slice = text.slice(start, end);
  return slice.length > 0 ? slice : null;
}

// ============================================================
// 实体解码
// ============================================================

/**
 * 把 XML 实体解回字符。
 *
 * 不解码的后果不是"少几个字符"，而是**显示出来的值是错的**：写作者名字里带 `&`
 * 的（`Smith &amp; Sons`）会原样显示成 `Smith &amp; Sons`，而版权声明里的 `&lt;`
 * 会变成 `&lt;`。用户没有任何办法知道那是实体而不是原文。
 *
 * 数字实体（`&#169;` 与 `&#xA9;`）一并处理：它们是 XMP 里写非 ASCII 字符的常规
 * 手段之一，而 `String.fromCodePoint` 对那两个分支是同一个答案。
 */
function decodeEntities(text: string): string {
  if (text.indexOf('&') < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const value = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // 越界的码位（例如 `&#x110000;`）会让 fromCodePoint 抛错 —— 那会把一次
      // "提取摘要"变成一次崩溃，因此保留原文。
      if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(value);
      } catch {
        return whole;
      }
    }
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        // 认不出的实体**原样留下**：XMP 里允许自定义实体，把它吃掉等于改内容。
        return whole;
    }
  });
}

/** 展开真空格与换行。RDF 的 `<rdf:li>` 之间几乎总是有缩进 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 导出用：把实体解回字符并压平空白。界面拿到的是可以直接显示的文本 */
export function textValue(raw: string): string {
  return collapse(decodeEntities(raw));
}

// ============================================================
// 摘要
// ============================================================

/**
 * 要抽的字段。
 *
 * `refs` 是字段的写法（属性名 / 元素名）。同一件事在 XMP 里有多种写法：标题既可以
 * 是 `dc:title`（元素 + `rdf:Alt`）也可以是 `dc:title`（属性），Adobe 系与
 * 生成器系各写各的，因此一个字段可以给多个别名。
 *
 * **不抽 `dc:subject`** —— 它通常是一个几十项的标签数组，塞进"摘要"里只会把真正
 * 重要的字段挤出去。
 */
const SUMMARY_FIELDS: ReadonlyArray<{ key: string; refs: string[] }> = [
  { key: 'dc:creator', refs: ['dc:creator'] },
  { key: 'dc:title', refs: ['dc:title'] },
  { key: 'dc:description', refs: ['dc:description'] },
  { key: 'dc:rights', refs: ['dc:rights'] },
  { key: 'xmp:CreatorTool', refs: ['xmp:CreatorTool'] },
  { key: 'xmp:CreateDate', refs: ['xmp:CreateDate'] },
  { key: 'xmp:ModifyDate', refs: ['xmp:ModifyDate'] },
  { key: 'xmp:MetadataDate', refs: ['xmp:MetadataDate'] },
  { key: 'photoshop:Credit', refs: ['photoshop:Credit'] },
  { key: 'photoshop:Source', refs: ['photoshop:Source'] },
  { key: 'Iptc4xmpCore:AltTextAccessibility', refs: ['Iptc4xmpCore:AltTextAccessibility'] },
  { key: 'xmpMM:DocumentID', refs: ['xmpMM:DocumentID'] },
  { key: 'xmpMM:InstanceID', refs: ['xmpMM:InstanceID'] },
  { key: 'xmpMM:OriginalDocumentID', refs: ['xmpMM:OriginalDocumentID'] },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 抽一个字段。
 *
 * 顺序是刻意的 —— **属性形式优先于元素形式**：
 *
 *   1. `dc:creator="..."`（属性）—— 最短、最不容易被别的标签截断
 *   2. `<dc:creator><rdf:Seq><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Seq></dc:creator>`
 *      —— 容器形式，多个 `rdf:li` 用 ` / ` 连接（作者是两个人才是常见情况，
 *      只取第一个会静默丢信息）
 *   3. `<dc:creator>直接文本</dc:creator>` —— 有些工具连 rdf 容器都不写
 *
 * 第 2 步用**非贪婪**匹配内容：贪婪的 `([\s\S]*?)` 与 `</dc:creator>` 配对时，
 * 在没有对应结束标签的畸形文档上会一路吃到文件末尾，把整包 XMP 当成字段值。
 * 非贪婪至少只会吃到**第一个**结束标签，那是可解释的结果。
 */
function extractField(xmp: string, ref: string): string | null {
  const name = escapeRegExp(ref);

  // 1. 属性形式。名字前的字符必须是空白或 `<`，否则 `foo:dc:creator=` 也会命中
  const attr = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(xmp);
  if (attr) {
    const value = textValue(attr[2] ?? attr[3] ?? '');
    if (value.length > 0) return value;
  }

  // 2. 元素形式，先把整段内容取出来
  const element = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xmp);
  if (!element) return null;

  // 3. 内容里如果有 rdf:li / rdf:li 的简写，逐个取出来拼
  const items: string[] = [];
  const li = new RegExp(`<rdf:li(?:\\s[^>]*)?>([\\s\\S]*?)</rdf:li>`, 'g');
  let hit: RegExpExecArray | null;
  while ((hit = li.exec(element[1])) !== null) {
    const value = textValue(hit[1]);
    if (value.length > 0) items.push(value);
  }
  if (items.length > 0) return items.join(' / ');

  const value = textValue(element[1]);
  return value.length > 0 ? value : null;
}

/**
 * 抽几个常用字段用于列表显示。
 *
 * 返回值里**只包含真的找到了的**字段 —— 界面上画一堆"（无）"比不画更难看，而
 * "这个文件没有 XMP"已经由 `xmp === null` 表达过了。
 */
export function summarizeXmp(xmp: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (xmp.length === 0) return out;

  for (const field of SUMMARY_FIELDS) {
    for (const ref of field.refs) {
      const value = extractField(xmp, ref);
      if (value !== null) {
        out.push({ key: field.key, value });
        break;
      }
    }
  }
  return out;
}
