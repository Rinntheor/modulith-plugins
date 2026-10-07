// src/art-trace/watermark/invisible.ts
//
// LSB 隐形水印的信道。**这个文件里全部是纯函数** —— 没有 DOM，因此它可以在
// Node 里被真实地跑一遍、断言到每一个比特。这一点决定了它必须是纯的。
//
// ============================================================
// 位序约定（读端必须与写端完全一致）
// ============================================================
//
// * 通道按**光栅顺序**取：像素 (0,0) 的 R、G、B，然后 (1,0) 的 R、G、B，依此类推；
// * 每个字节**从最高位到最低位**写入连续的通道位置。
//
// 这两条必须写死，因为写端与读端一旦不一致（最典型的是某一个把每个字节做了
// bit-reverse），读出来就是一段乱码 —— 而 CRC 一失败，人的第一反应是
// "载荷写入的时候坏了"，会去查编码器，而真正的问题在这两条约定里。
//
// ============================================================
// 为什么不碰 alpha，也不碰 2 位以上
// ============================================================
//
// * **不碰 alpha**：alpha 是最低位被改一下就可见的通道。半透明区域里 alpha 减 1
//   会让整块区域在深色背景上出现一层噪点 —— 而 LSB 水印的全部价值就是"看不见"。
// * **只用 1 位**：改 2 位（±3）在平滑渐变上已经能看出带状纹理。1 位（±1）是
//   人眼与 JPEG 都很难抓住的量级。

/** 每个像素参与藏数据的通道数：R、G、B */
const CHANNELS_PER_PIXEL = 3;

/** 每个通道藏几位。固定 1 —— 见文件头 */
const BITS_PER_CHANNEL = 1;

/**
 * 能藏多少字节。RGB 三个通道各 1 位，**不碰 alpha**。
 *
 * 向下取整：不足一字节的零头不能用。反过来（向上取整）会让写入端多写一个字节的
 * 前几位，读端把它拼成一个**缺位的字节**，CRC 于是永远失败。
 */
export function channelCapacityBytes(pixelCount: number): number {
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) return 0;
  const bits = Math.floor(pixelCount) * CHANNELS_PER_PIXEL * BITS_PER_CHANNEL;
  return Math.floor(bits / 8);
}

/**
 * 把数据写进 RGB 的最低位。**返回改动了的比特数**。
 *
 * 超出容量时**只写能写下的部分**，不抛错：这是水印而不是加密，容量的边界是
 * 用户能看见的（"这段话装不下"），应当由调用方根据返回值与自己的载荷长度去决定
 * "报错"还是"少铺一遍"，而不是在这里把整张图的操作炸掉。
 *
 * 返回值是**实际翻转的比特数**（写入值与原值不同才算），不是写入的比特数 ——
 * 界面上"改动了多少比特"要的是前者，后者恒等于载荷长度×8，是个没信息量的数。
 */
export function writeBits(pixels: Uint8ClampedArray, data: Uint8Array): number {
  const channels = Math.floor(pixels.length / 4) * CHANNELS_PER_PIXEL;
  const total = Math.min(data.length * 8, channels);

  let changed = 0;
  let written = 0;
  let at = 0; // 在 pixels 里的下标；每像素 4 个通道，因此它要走 0,1,2,4,5,6,8,…

  for (let bit = 0; bit < total; bit++) {
    // 每 3 个通道跳过一次 alpha。写成"每像素内偏移 0/1/2"比在写完之后过滤更省，
    // 也不会漏掉最后一个像素的 alpha。
    if (written === CHANNELS_PER_PIXEL) {
      at++; // 跳过 alpha
      written = 0;
    }

    const byteIndex = bit >> 3;
    const shift = 7 - (bit & 7); // 从最高位开始
    const bitValue = (data[byteIndex] >> shift) & 1;

    const original = pixels[at];
    const next = (original & 0xfe) | bitValue;
    if (next !== original) {
      pixels[at] = next;
      changed++;
    }

    at++;
    written++;
  }

  return changed;
}

/**
 * 按光栅顺序读出最多 `neededBytes` 字节。
 *
 * 读不满时**返回已读到的部分**，不抛错、也不补零：调用方（`readTrace`）拿到的
 * 是一张可能被裁切过的图，它需要的是"能读到多少就算多少"，补零反而会造出一段
 * 看似合法、实际截断的载荷。
 */
export function readBits(pixels: Uint8ClampedArray, neededBytes: number): Uint8Array {
  if (!Number.isFinite(neededBytes) || neededBytes <= 0) return new Uint8Array(0);

  const channels = Math.floor(pixels.length / 4) * CHANNELS_PER_PIXEL;
  const bits = Math.min(Math.floor(neededBytes) * 8, channels);
  const out = new Uint8Array(Math.floor(bits / 8));

  let byteValue = 0;
  let bitInByte = 0;
  let outIndex = 0;
  let written = 0;
  let at = 0;

  for (let bit = 0; bit < bits; bit++) {
    if (written === CHANNELS_PER_PIXEL) {
      at++;
      written = 0;
    }

    const shift = 7 - bitInByte;
    byteValue |= (pixels[at] & 1) << shift;
    bitInByte++;

    if (bitInByte === 8) {
      out[outIndex++] = byteValue;
      byteValue = 0;
      bitInByte = 0;
    }

    at++;
    written++;
  }

  return out;
}
