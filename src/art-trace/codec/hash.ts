// src/art-trace/codec/hash.ts
//
// 内容哈希。
//
// ============================================================
// 为什么用 `crypto.subtle` 而不是自己写一个 SHA-256
// ============================================================
//
// 自己写一个纯 JS 的 SHA-256 大约一百行，但它会比引擎里的原生实现慢一到两个数量级
// —— 而这里要对**每一张**待处理的图算两次哈希（源与成品），批量处理几十张几 MB 的
// 图时那一两个数量级是能感觉到的。
//
// `crypto.subtle` 需要安全上下文。插件文档跑在 `http://modulith-plugin.localhost`，
// 而 `.localhost` 被浏览器当作**可信来源**（这正是这套自定义协议能承载剪贴板 API 的
// 同一个理由），因此它可用。真的不可用时**抛错而不是退回一个弱哈希** ——
// 台账里的哈希是用来做同一性判定的，一个悄悄退化的哈希会让"这两张图是不是同一张"
// 变成不可靠的判断。
//
// ============================================================
// 大文件为什么要分块
// ============================================================
//
// `crypto.subtle.digest` 一次只能吃一整块 buffer。对一张 20 MB 的图，那意味着输入
// 已经在内存里了 —— 而它本来就在（是我们读进来的）。因此这里不分块：分块要用
// `crypto.subtle` 之外的增量接口，而 Web Crypto 没有提供。**这一点写在这里是为了
// 下一个人不必再想一遍。**

/** SHA-256，返回小写十六进制。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '当前环境不提供 crypto.subtle（它不是安全上下文），无法计算内容哈希'
    );
  }

  // `bytes.buffer` 可能比这段视图大（它是从一整块里切出来的），因此必须按
  // byteOffset / byteLength 精确地切一份 —— 直接把 buffer 交给 digest 会把
  // 视图之外的那些字节也算进去，而那是一个**不会报错**的错误哈希。
  const exact =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : new Uint8Array(bytes);

  const digest = await subtle.digest('SHA-256', exact as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}
