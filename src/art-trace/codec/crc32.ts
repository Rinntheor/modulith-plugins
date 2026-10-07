// src/art-trace/codec/crc32.ts
//
// CRC-32（IEEE 802.3，多项式 0xEDB88320）。
//
// ============================================================
// 它为什么必须逐位正确
// ============================================================
//
// PNG 的每一个块都以它自己的 CRC-32 结尾，而**解码器会校验**。算错一个字节，
// 重建出来的图片在所有查看器里都是"文件已损坏" —— 而这件事没有任何中间状态：
// 要么全对，要么全错。
//
// 因此这里不图省事写逐位移位版（那在几百 KB 的 IDAT 上会慢到不能用），而是建一张
// 256 项的查表。表是按标准算法生成的 —— 不是抄来的魔数表，因此不存在"抄错一位"
// 这种不可能被看出来的错误。

/** 查表。首次使用时生成，之后复用 */
let table: Uint32Array | null = null;

function getTable(): Uint32Array {
  if (table) return table;
  const built = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      // 0xEDB88320 是 0x04C11DB7 的位反转形式 —— CRC-32/ISO-HDLC 用的是后者。
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    built[index] = value >>> 0;
  }
  table = built;
  return built;
}

/**
 * 算一段字节的 CRC-32，返回**无符号** 32 位整数。
 *
 * `seed` 允许接着上一段继续算 —— PNG 的块 CRC 覆盖"类型 + 数据"两段，
 * 而它们通常是分开构造的。
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const lookup = getTable();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (lookup[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 两段拼接之后的 CRC-32，**不真的拼**。
 *
 * PNG 重建时每个块的 CRC 覆盖"4 字节类型 + n 字节数据"，而数据可能是一大块 IDAT
 * （几 MB）。为了算 CRC 而把它复制一份，峰值内存会翻倍 —— 而这一步在批量处理里
 * 会对每一张图发生。`crc32` 的 `seed` 参数让这件事不必发生。
 */
export function crc32Parts(parts: Uint8Array[]): number {
  let crc = 0;
  for (const part of parts) crc = crc32(part, crc);
  return crc;
}

/**
 * 从 `bytes[offset]` 起把 4 字节当成大端 CRC 读出来。
 *
 * 单独一条而不是让调用方写位运算：容器里 CRC 的字节序是**唯一**容易写反的地方，
 * 而写反的表现是"算出来的永远对不上"，排查起来像是算法错了。
 */
export function readCrc32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new RangeError('readCrc32: 越界');
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}
