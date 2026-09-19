// scripts/zip.ts
// 最小 zip 写入器：只为生成 .lcp 服务。
//
// 为什么不用现成的库：本仓库坚持零依赖 —— 插件的目录规范里明确禁止提交
// node_modules，仓库自己的工具链不该开一个例外。而 zip 的写入格式足够小，值得
// 自己实现一次。
//
// 为什么不用 PowerShell 的 Compress-Archive：那是 Windows 专属，别人克隆这个仓库
// 之后就无法发布。
//
// **输出是确定性的**（前提：同一个 Node / zlib 版本）。条目按名称排序，时间戳固定为
// 1980-01-01，压缩级别固定，且对压不小的数据回退为不压缩。同一份源码重复构建会得到
// 同一串字节，因此索引里记录的 sha256 才有意义 —— 否则它只能证明「这个包没被改动过」，
// 不能证明「这个包就是这份源码构建出来的」。
//
// 那个版本前提不能省：deflate 的输出由 zlib 实现决定，而 build.ts 的二次打包比对是
// **同一进程内**的比较，挡不住版本差异。`--check` 会把「当前源码打包出的哈希 ≠ 索引
// 记录」报成错误，所以换 Node 版本后跑校验可能得到一次**假失败** —— 先确认 Node 版本。

import { deflateRawSync } from 'node:zlib';

/** 一个待写入的条目 */
export interface ZipEntry {
  /** 压缩包内的路径，一律使用 `/` 分隔 */
  name: string;
  data: Uint8Array;
}

// DOS 时间戳的起点是 1980-01-01。固定成这个值以换取可复现的输出。
// 写成「年 0、月 1、日 1」正好对应 1980-01-01。
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** CRC-32（IEEE 802.3），查表实现 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafeName(name: string): void {
  if (name.length === 0) throw new Error('zip 条目名为空');
  if (name.startsWith('/')) throw new Error(`zip 条目不能是绝对路径: ${name}`);
  if (/^[A-Za-z]:/.test(name)) throw new Error(`zip 条目不能带盘符: ${name}`);
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '')) {
    throw new Error(`zip 条目路径非法: ${name}`);
  }
}

/** 把若干条目打成一个 zip。条目按名称排序后写入，保证输出可复现。 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const seen = new Set<string>();
  for (const entry of sorted) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) throw new Error(`zip 内条目重名: ${entry.name}`);
    seen.add(entry.name);
  }

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const crc = crc32(raw);

    // 对很小的数据，deflate 的头开销可能超过收益。取两者中更小的那个：
    // 这既让包更小，也让「压缩方式」成为内容的确定函数，而不是随机波动。
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    // ---- 本地文件头 ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0, 6); // 通用标志位
    local.writeUInt16LE(method, 8); // 压缩方式
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // 压缩后大小
    local.writeUInt32LE(raw.length, 22); // 原始大小
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    localChunks.push(local, nameBytes, payload);

    // ---- 中央目录项 ----
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 签名
    central.writeUInt16LE(0x0314, 4); // 生成平台 UNIX(3)、规范版本 2.0
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0, 8); // 通用标志位
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    // external attrs 的高 16 位是 Unix 权限位。`<<` 在 JS 里返回有符号 32 位整数，
    // 0o100644 << 16 会变成负数，因此必须用 >>> 0 转回无符号。
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：普通文件 0644
    central.writeUInt32LE(offset, 42); // 本地文件头偏移
    centralChunks.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralChunks);

  // ---- 中央目录结束记录 ----
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 签名
  end.writeUInt16LE(0, 4); // 当前磁盘号
  end.writeUInt16LE(0, 6); // 中央目录所在磁盘号
  end.writeUInt16LE(sorted.length, 8); // 本磁盘条目数
  end.writeUInt16LE(sorted.length, 10); // 总条目数
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16); // 中央目录偏移
  end.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localChunks, centralBuf, end]);
}
