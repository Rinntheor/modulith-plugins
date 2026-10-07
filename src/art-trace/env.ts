/// <reference path="../../types/modulith.d.ts" />
// src/art-trace/env.ts
//
// 影像元数据工坊的**共享环境**：宿主对象、React 简写、服务句柄、以及全插件共用的常量。
//
// ============================================================
// 为什么单独一个文件，而不是每个模块各自取一遍
// ============================================================
//
// `Modulith.createContext()` **只能在加载期调用**。每个模块各调一次会拿到多个上下文
// —— 存储的读写、通知的可用性、事件订阅表都会分叉，而那种分裂在界面上表现为
// "有时候设置改了没生效"，极难归因。
//
// 同样的理由适用于 `ctx.files`：它是**按界面**授权的，因此这份文件也是"这个插件
// 在哪一块界面上、拿着哪些授权"这一事实的唯一来源。
//
// ============================================================
// 一条硬规矩：解析层不认识 ctx
// ============================================================
//
// `codec/`、`gen/`、`clean/`、`watermark/` 全部是**纯函数**（字节进、模型出）。
// 只有这一层与 `ui/`、`trace/` 碰宿主。这条规矩买到的是：解析逻辑可以在宿主之外
// 被测试、被复用，也不会因为界面重构而失效。

const injected = globalThis.Modulith;
if (!injected) {
  // 宿主连 `Modulith` 都没注入，这本来就是该响一声的事。抛错的效果与"IIFE 里
  // `console.error` 之后 return"一样：入口不会执行，模块不会注册。
  throw new Error('[art-trace] 未找到 window.Modulith，插件无法加载');
}

/**
 * 剩下的部分用**收窄之后的**那个值。
 *
 * 不能直接 `export { injected as Modulith }`：导出的绑定类型仍然是
 * `ModulithHost | undefined`，于是每一个 `Modulith.registerModule(...)` 都会报
 * "possibly undefined" —— 而那个判空就在上面三行。把它赋给一个显式标注了非可选
 * 类型的常量，类型就跟着收窄，调用点不必每个都写 `!`。
 */
const Modulith: ModulithHost = injected;

const React = Modulith.React;
const useEffect = React.useEffect;
const useMemo = React.useMemo;
const useRef = React.useRef;
const useState = React.useState;
const useCallback = React.useCallback;

// createContext() 只能在加载期调用，因此在这里取一次并长期持有。
const ctx = Modulith.createContext();

// ============================================================
// `ctx.files`：一项能力探测，而不是一次强转
// ============================================================
//
// 它是**沙箱独有**的（类型上也是可选的）。插件必须自己判断它在不在，理由是两条
// 都很现实的问题：
//
//   1. 宿主可能比本插件旧。此时 `ctx.files` 是 `undefined`，而任何 `ctx.files.pick()`
//      都会是 `undefined is not a function` —— 那种报错在插件文档里留下一句话，
//      用户看到的却是一块白板（宿主会把插件脚本的错误画出来，但只有一句类型错误）。
//   2. in-process 运行时没有它。
//
// 与其在每个调用点判空，不如在这里收成一个**明确的能力**：要么拿到它，要么拿到
// `null`，而界面据此显示"当前宿主不支持文件访问"，把真正的原因说出来。

const files: PluginFiles | null =
  typeof ctx.files === 'object' && ctx.files !== null ? ctx.files : null;

/** 当前宿主有没有文件访问能力。界面用它决定是画工作台还是画一句解释 */
const canAccessFiles = files !== null;

/**
 * 取文件服务，没有就抛一句**能照做的话**。
 *
 * 与 `canAccessFiles` 的分工：那个用于界面上的分支，这个用于"走到这里就说明一定
 * 有"的路径。抛错的消息里带着怎么办，因此它出现在宿主画出来的错误面板上时是有用的。
 */
function requireFiles(): PluginFiles {
  if (!files) {
    throw new Error(
      '当前宿主不提供 ctx.files（插件文件的读写通道）。' +
        '本插件需要 Modulith Desktop 中带该能力的版本，请在「设置 → 关于」确认宿主版本。'
    );
  }
  return files;
}

// ============================================================
// 常量
// ============================================================
//
// 存储键只允许字母数字与 `.` `_` `-`，最长 128 字符。

/** 插件的偏好设置（一块 JSON） */
const KEY_PREFS = 'prefs';
/** 台账的写入游标与上次导出信息 */
const KEY_LEDGER_META = 'ledger.meta';
/** 水印模板预设（用户命名的一组内容） */
const KEY_PRESETS = 'presets';

/** 台账数据库的表名。前缀避免与将来别的用途撞上 */
const TABLE_LEDGER = 'art_trace_ledger';

/** 默认追踪编号前缀 */
const DEFAULT_ID_PREFIX = 'AT';

/**
 * 支持的图片扩展名。
 *
 * 它只用于**对话框的过滤器**与"这个文件要不要处理"的初判 —— 真正的判据永远是
 * 读进来的头几个字节（`codec/detect`）。扩展名是用户可以随便改的。
 */
const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'avif',
];

/** 单张图的上限。与宿主 `ctx.files` 的单文件上限（256 MB）留出余量 */
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

/** 一次批量任务最多处理多少张。它挡的是"选了一个几十万文件的目录" */
const MAX_BATCH_FILES = 2000;

/** 列表里一次渲染多少个缩略图。多了会把内存与布局一起拖垮 */
const THUMBNAIL_WINDOW = 60;

/** 缩略图的边长（px）。用于 `<img>` 的显示尺寸，**不改变取到的原图** */
const THUMBNAIL_SIZE = 96;

/** 隐形水印载荷的字节上限。与 `watermark/invisible` 的信道容量有关 */
const MAX_PAYLOAD_BYTES = 400;

/** 一次预览最多渲染多少像素宽的水印画布 */
const PREVIEW_MAX_WIDTH = 720;

/** 通知的去重键前缀 */
const NOTIFY_BATCH = 'art-trace.batch';

/** 默认可见水印的三行模板 */
const DEFAULT_VISIBLE_LINES = ['© {author}', '{platform} · {id}', '{license}'];

/** 默认隐形载荷模板 */
const DEFAULT_PAYLOAD_TEMPLATE =
  'v=1|id={id}|a={author}|p={platform}|o={order}|by={buyer}|d={date}';

/** 默认清理策略。界面上每个开关与这里的一项对应 */
const DEFAULT_CLEAN_OPTIONS = {
  dropGenerator: true,
  dropExif: true,
  dropXmp: true,
  dropC2pa: true,
  dropText: false,
  keepIcc: true,
  keepPhysical: true,
  keepOrientation: true,
  append: [] as Array<{ key: string; value: string }>,
  reencodePixels: false,
};

/**
 * 类名写成查表而不是字符串拼接：拼接出来的类名在全仓库搜索里找不到，改样式时
 * 无法确认「这个类还有没有人在用」，静态检查也会把它当成没人用的废弃规则。
 *
 * 前缀统一用 `arttrace__`（BEM 风格，与仓库里的 `kanban__` 一致），
 * 并刻意避开宿主的 `lc-` 前缀。
 */
const GROUP_CLASS: Record<string, string> = {
  generator: 'arttrace__tag--generator',
  exif: 'arttrace__tag--exif',
  xmp: 'arttrace__tag--xmp',
  icc: 'arttrace__tag--icc',
  c2pa: 'arttrace__tag--c2pa',
  text: 'arttrace__tag--text',
  structural: 'arttrace__tag--structural',
  other: 'arttrace__tag--other',
};

export {
  Modulith,
  React,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  ctx,
  files,
  canAccessFiles,
  requireFiles,
  KEY_PREFS,
  KEY_LEDGER_META,
  KEY_PRESETS,
  TABLE_LEDGER,
  DEFAULT_ID_PREFIX,
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  MAX_BATCH_FILES,
  THUMBNAIL_WINDOW,
  THUMBNAIL_SIZE,
  MAX_PAYLOAD_BYTES,
  PREVIEW_MAX_WIDTH,
  NOTIFY_BATCH,
  DEFAULT_VISIBLE_LINES,
  DEFAULT_PAYLOAD_TEMPLATE,
  DEFAULT_CLEAN_OPTIONS,
  GROUP_CLASS,
};
