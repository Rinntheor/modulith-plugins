// src/art-trace/watermark/pixels.ts
//
// 画布往返：图片字节 ↔ RGBA 像素。
//
// ============================================================
// 为什么这一层单独存在，而且只剩三个函数
// ============================================================
//
// "把图变成像素"这件事在浏览器里只有一条路：解码 → 画到 canvas → getImageData。
// 这条路**只能跑在 DOM 里**，因此它不可测试 —— 也就是说，凡是能和它分开的逻辑
// 都必须分开，否则"我验证过了"这句话就只剩一半内容。
//
// 所以这个文件里只有三个入口，其中两个是 DOM（明确标注），一个是纯函数。
// 真正的水印算法（LSB 信道、排版、墨水判定）全在别的文件里，全是纯函数。

/** 一张 RGBA 像素图。水印的一切算法都是对它的运算 */
export interface PixelImage {
  width: number;
  height: number;
  /** RGBA，长度 = width * height * 4 */
  data: Uint8ClampedArray;
}

/**
 * 把任意受支持的图片字节解成像素。**DOM 依赖**（`createImageBitmap` + canvas）。
 *
 * 用 `createImageBitmap` 而不是 `new Image()` + `URL.createObjectURL`：
 * 后者要额外管一次 `revokeObjectURL`，而 90% 的写法会在解码失败时漏掉它 ——
 * 每张坏图都漏一个 blob URL，批量处理时是实打实的泄漏；而且 `<img>` 的失败是
 * 一个事件，包成 Promise 还要再写一层监听与清理。`createImageBitmap` 直接返回
 * Promise，并且给出一个能读的 `error`。
 *
 * **已知限制：经过画布往返的像素不保证与原文件逐位相同。** 浏览器可能做色彩空间
 * 转换（广色域图片尤其明显），也可能把 16 位降到 8 位。因此要做"逐字节无损"的
 * 容器操作时**不要走这条路** —— 那条路是 `codec/` 里直接搬运 IDAT / 熵编码数据的。
 */
export async function decodeToPixels(bytes: Uint8Array): Promise<PixelImage> {
  if (typeof createImageBitmap !== 'function') {
    // 宿主 WebView 太旧。这里明确抛出来，而不是让后面一行报
    // `createImageBitmap is not defined` —— 那句话对用户毫无信息。
    throw new Error('当前环境不支持 createImageBitmap，无法解码图片像素。');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch (error) {
    throw new Error(`这张图无法解码：${reasonOf(error)}`);
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) {
      throw new Error(`这张图无法解码：解出来的尺寸是 ${width}×${height}`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    // willReadFrequently 不是性能微调，是正确性的前提：不加它，每个 canvas 默认
    // 走 GPU 后备存储，每次 getImageData 都要把整张图从 GPU 读回 CPU。单张图看不出
    // 差别，批量几十张时这是最慢的一环（而且会让显存一路涨）。
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('这张图无法解码：拿不到 2D 画布上下文');

    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, width, height);
    return { width, height, data: image.data };
  } finally {
    // 不 close 会一直持有解码后的位图。批量处理时这是实打实的内存（一张 4K 图
    // 解码后是 33 MB）。
    bitmap.close();
  }
}

/**
 * 把像素编成 PNG 字节。**DOM 依赖**（`canvas.toBlob`）。
 *
 * 用 PNG 而不是 JPEG/WebP 是**硬要求**，不是偏好：LSB 水印只改最低位，有损编码
 * 第一件事就是把最低位扔掉。用有损格式编码一遍，隐形水印当场消失。
 */
export async function encodePixels(image: PixelImage): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法编码：拿不到 2D 画布上下文');

  // 必须把 data 包成 ImageData 而不是 `putImageData(image.data as any)`：
  // 有些引擎要求 ImageData 实例，有的要求长度严格等于 w*h*4 —— 长度不对时
  // putImageData 是**静默无事发生**，于是导出的是一张全透明的空图。
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    throw new Error(
      `无法编码：像素数组长度 ${image.data.length} 与 ${image.width}×${image.height} 不符（应为 ${expected}）`
    );
  }
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

  return await new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      // toBlob 在内存不足时给 null。这里必须抛错：返回空数组会让调用方写出一张
      // 0 字节的"成品"，而用户看到的是"导出成功但文件打不开"。
      if (!blob) {
        reject(new Error('无法编码 PNG：canvas.toBlob 返回了 null（通常是内存不足）'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch((error: unknown) => reject(error));
    }, 'image/png');
  });
}

/**
 * 取一块区域的**平均感知亮度**（0..255），供墨水判定。**纯函数**。
 *
 * 用 Rec.601 的权重（0.299 / 0.587 / 0.114）而不是简单平均：人眼对绿最敏感、
 * 对蓝最不敏感，简单平均会让"一片纯蓝"和"一片纯黄"算出同一亮度，而白字压在
 * 纯黄上什么都看不见。
 *
 * 越界的区域按画布裁剪而不是抛错：调用方是排版算出来的框，贴着边缘时差一两个
 * 像素是正常的，为这个抛错只会让"贴边的水印画不出来"。
 */
export function regionLuminance(
  image: PixelImage,
  box: { x: number; y: number; width: number; height: number }
): number {
  const left = clampInt(Math.floor(box.x), 0, image.width);
  const top = clampInt(Math.floor(box.y), 0, image.height);
  const right = clampInt(Math.ceil(box.x + box.width), left, image.width);
  const bottom = clampInt(Math.ceil(box.y + box.height), top, image.height);

  if (right <= left || bottom <= top) return 0;

  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    let at = (y * image.width + left) * 4;
    for (let x = left; x < right; x++) {
      sum +=
        0.299 * image.data[at] +
        0.587 * image.data[at + 1] +
        0.114 * image.data[at + 2];
      at += 4;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return value < low ? low : value > high ? high : value;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
