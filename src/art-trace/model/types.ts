// src/art-trace/model/types.ts
//
// 影像元数据的领域模型。
//
// ============================================================
// 为什么解析与呈现之间要有这一层
// ============================================================
//
// 容器格式（PNG 的块、JPEG 的段、RIFF 的 chunk）与"这张图是用什么生成的"是两件
// 不同的事。把它们混在一起写，得到的是那种"加一个生成器就要动界面"的代码。
//
// 这里因此分成三层，层与层之间只有下面这些类型：
//
//   容器层  codec/*      字节 → ContainerBlock[]（每一条是"名字 + 值 + 原始长度"）
//   语义层  gen/*        文本块 → GenParams | null（识别生成器、抽出字段）
//   呈现层  ui/*         上面两层 → 界面
//
// 一条硬规矩：**解析层不认识 React，也不认识 ctx。** 它是纯函数（字节进、模型出），
// 因此它可以在宿主之外被测试，也不会因为界面重构而失效。

/** 容器格式。`unknown` 表示认不出来 —— 那不是错误，是一个正常结果。 */
export type ImageFormat =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'bmp'
  | 'tiff'
  | 'avif'
  | 'unknown';

/** 一个元数据块的归属。抹除时的粒度就是它。 */
export type MetaGroup =
  /** 生成器参数：ComfyUI / A1111 / NovelAI … 是"痕迹"的主体 */
  | 'generator'
  /** EXIF（拍摄信息、方向、GPS） */
  | 'exif'
  /** XMP（Adobe 系的整包） */
  | 'xmp'
  /** ICC 色彩描述文件。**它不是隐私，删了会变色** */
  | 'icc'
  /** C2PA / Content Credentials 之类的来源凭证 */
  | 'c2pa'
  /** 普通文本块（作者、版权、软件名） */
  | 'text'
  /** 时间戳、物理尺寸之类的结构性块 */
  | 'structural'
  /** 认不出的其它块 */
  | 'other';

/** 容器里的一个块，已经解码成可显示的样子。 */
export interface MetaBlock {
  /** 稳定 id，界面列表的 key。同一份文件两次解析必须得到同一批 id */
  id: string;
  /** 容器里的确切名字，例如 `tEXt(parameters)`、`eXIf`、`APP1(Exif)`、`EXIF` */
  label: string;
  group: MetaGroup;
  /**
   * 解码后的文本。二进制块（ICC、eXIf 的原始字节）在这里是一句说明
   * （"ICC 色彩描述文件，3144 字节"），完整字节不进模型 —— 界面显示不了它，
   * 而把它转成字符串只会在内存里留下一份没人看的垃圾。
   */
  text: string;
  /** 这个块在文件里占的原始字节数 */
  bytes: number;
  /**
   * 抹除时**默认**要不要丢。
   *
   * `false` 只有两种情况：ICC（丢了会偏色）与结构性块（丢了会坏文件）。
   * 其余一律 `true` —— 默认应当是"干净"，而"我要留下这个"是一个需要用户主动做的选择。
   */
  removable: boolean;
  /** 识别出的来源，例如 `ComfyUI`；认不出时 `null` */
  origin: string | null;
}

/** 尺寸与像素格式。 */
export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  /** PNG 的位深 / JPEG 的精度；其它格式为 `null` */
  bitDepth: number | null;
  /** 人类可读的色彩模型，例如 `RGBA`、`YCbCr(3)`、`调色板(256)` */
  colorModel: string | null;
  interlaced: boolean;
  animated: boolean;
  /** 帧数。静态图是 1 */
  frames: number;
  /** 文件总字节数 */
  bytes: number;
}

/** EXIF 里的一个字段。 */
export interface ExifField {
  tag: number;
  name: string;
  group: 'ifd0' | 'exif' | 'gps' | 'ifd1' | 'interop';
  /** 已经转成人类可读形式的值 */
  value: string;
  /** 原始类型与个数，例如 `RATIONAL×1` */
  raw: string;
}

/** ComfyUI 工作流图里的一个节点。 */
export interface ComfyNode {
  id: string;
  type: string;
  title: string;
  inputs: Array<{ name: string; value: string; from: string | null }>;
  outputs: string[];
}

/** ComfyUI 的工作流。它比"一串参数"信息量大得多，值得单独建模。 */
export interface ComfyWorkflow {
  nodes: ComfyNode[];
  /** 从图里摘出来的关键参数，界面先显示这些 */
  highlights: Array<{ label: string; value: string }>;
  /** 原始 JSON 文本 */
  raw: string;
}

/**
 * 归一化之后的生成参数。
 *
 * **字段是可选的，而且永远会是。** 生成器有几十个，每一个的字段集都不一样，而且
 * 同一个生成器换一版就可能改名。因此这一层的正确形态是"抽出认识的那些 + 把其余的
 * 原样留在 `extras` 里"，而不是"为每一个生成器定义一个类型"—— 后者每加一个生成器
 * 就要动整个插件，而 `extras` 让未知字段至少是**看得到**的。
 */
export interface GenParams {
  /** 识别出的生成器名，例如 `ComfyUI`、`AUTOMATIC1111`、`NovelAI` */
  generator: string;
  /** 判定依据。界面上要能回答"你凭什么说这是 ComfyUI" */
  evidence: string;
  prompt: string | null;
  negativePrompt: string | null;
  seed: string | null;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  model: string | null;
  modelHash: string | null;
  vae: string | null;
  clipSkip: number | null;
  width: number | null;
  height: number | null;
  denoising: number | null;
  loras: string[];
  controlNets: string[];
  /** 上面装不下的键值，原样保留 */
  extras: Array<{ key: string; value: string }>;
  /** 判定所依据的原始文本，供"看原文" */
  raw: string;
  /** 仅 ComfyUI：那张节点图 */
  workflow: ComfyWorkflow | null;
}

/**
 * 一张图在"痕迹"这件事上的三档结论。
 *
 * **为什么不是"干净 / 不干净"两档。** 本插件自己会往成品里写作者、版权、联系方式、
 * 追踪编号这些文本块 —— 那是用户**要的**标注。如果把它们也算成"不干净"，用户拿自己
 * 刚导出的成品回来查会看到"这张图有痕迹"，而那是这个工具在指控自己。
 *
 * 因此分三档，而"需不需要处理"只由第一档决定：
 *   * `traces`    —— 生成参数 / EXIF / XMP / 来源凭证。通常不是你想留的；
 *   * `annotated` —— 只有文本块。可能是你自己加的署名，也可能是别的工具写的；
 *   * `clean`     —— 一个元数据块都没有。
 */
export type BlockVerdict = 'traces' | 'annotated' | 'clean';

/** 一次解析的全部结果。 */
export interface InspectResult {
  info: ImageInfo;
  blocks: MetaBlock[];
  /**
   * 痕迹结论。
   *
   * **由解析层算好带过来**，而不是让每个视图各自从 `blocks` 里推断 ——
   * 界面里重算一遍判据就会与 `auditBlocks` 漂开，而"哪一类块算痕迹"这个判断
   * 已经有三个地方需要它（检视列表、批量队列、检视详情）。
   */
  verdict: BlockVerdict;
  /** 认出来的生成参数；没认出来是 `null` */
  generation: GenParams | null;
  exif: ExifField[];
  /** XMP 包的原文；没有则 `null` */
  xmp: string | null;
  /** ICC 描述文件的字节数；没有则 `0` */
  iccBytes: number;
  /** 在哪几个地方发现了 C2PA / Content Credentials */
  c2pa: string[];
  /** 容器能不能被本插件重建（能不能清理） */
  rewritable: boolean;
  /** 不能重建时的原因，给用户看 */
  rewriteBlockedReason: string | null;
  /** 文件内容的 SHA-256（十六进制小写）。台账要靠它做同一性判定 */
  sha256: string;
}

// ============================================================
// 清理
// ============================================================

/** 清理策略。界面上的开关与它一一对应。 */
export interface CleanOptions {
  /** 丢掉生成器参数（`generator` 组） */
  dropGenerator: boolean;
  /** 丢掉 EXIF（`exif` 组）。`keepOrientation` 为真时方向信息会被留下来 */
  dropExif: boolean;
  /** 丢掉 XMP */
  dropXmp: boolean;
  /** 丢掉 C2PA / Content Credentials */
  dropC2pa: boolean;
  /** 丢掉普通文本块 */
  dropText: boolean;
  /**
   * 保留 ICC 色彩描述文件。**默认开。**
   *
   * 它不是隐私 —— 它描述的是"这些数字该被解释成什么颜色"。丢掉它会让图片在
   * 色彩管理正确的查看器里明显偏色（广色域作品尤其严重），而用户要的是
   * "抹掉痕迹"，不是"把图弄坏"。
   */
  keepIcc: boolean;
  /**
   * 保留物理尺寸（PNG `pHYs`，即 DPI）。**默认开。**
   *
   * 它影响打印尺寸与部分排版工具的默认缩放，不含任何可追踪信息。
   */
  keepPhysical: boolean;
  /**
   * 保留方向（EXIF `Orientation`）。**默认开。**
   *
   * 这是清理里最容易出错的一条：`Orientation` 是元数据，但它**决定画面怎么摆**。
   * 直接删掉，一张竖拍的照片在查看器里会变成横的 —— 而用户会认为工具把图弄坏了。
   * 打开时插件会写回一个**只含 Orientation 一项**的最小 EXIF。
   */
  keepOrientation: boolean;
  /** 要追加的文本块（作者、版权、联系方式…）。空数组表示不追加 */
  append: Array<{ key: string; value: string }>;
  /**
   * 重编码像素。**默认关。**
   *
   * 关着的时候清理是**无损**的：只把容器重建一遍，像素数据（PNG 的 IDAT、JPEG 的
   * 熵编码数据）逐字节原样搬运。开着才经过 canvas —— 那能顺手把"藏在像素排列里的"
   * 东西（例如某些工具的隐写）也洗掉，代价是**会重新采样，可能改变像素**。
   */
  reencodePixels: boolean;
}

/** 一次清理的结果。 */
export interface CleanResult {
  bytes: Uint8Array;
  /** 丢掉了哪些块（给台账与界面用） */
  dropped: string[];
  /** 留下了哪些块 */
  kept: string[];
  /** 清理前的字节数 */
  beforeBytes: number;
  /** 有没有动过像素 */
  pixelsRewritten: boolean;
}

// ============================================================
// 水印与追踪
// ============================================================

/** 水印文本里可用的占位符的取值。 */
export interface WatermarkFields {
  author: string;
  platform: string;
  profile: string;
  contact: string;
  license: string;
  order: string;
  buyer: string;
  extra: string;
  /** 本次生成的唯一追踪编号 */
  id: string;
  /** `yyyyMMdd` */
  date: string;
}

export interface VisibleWatermarkOptions {
  enabled: boolean;
  /** 多行文本，含占位符。第一行是主标题 */
  lines: string[];
  layout:
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'top-right'
    | 'top-left';
  style: 'outline' | 'badge';
  /** 主行字号 = 图宽 × 这个比例 */
  fontSizeRatio: number;
  /** 副行字号相对主行的比例 */
  lineScale: number;
  /** 边距 = 图宽 × 这个比例 */
  marginRatio: number;
  /** 主行不透明度，0..255 */
  opacity: number;
  /** 墨水颜色。`auto` 会测量水印区域的亮度自己决定 */
  ink: 'auto' | 'light' | 'dark';
}

export interface InvisibleWatermarkOptions {
  enabled: boolean;
  /** 载荷模板，含占位符 */
  payloadTemplate: string;
  /**
   * 冗余份数。
   *
   * LSB 水印的抗损能力来自**重复**：整份载荷在像素里铺几遍，只要还有一遍完整
   * 就能读出来。份数越多越耐裁切，也越容易被有损转码抹掉（因为改动面更大）。
   */
  redundancy: number;
}

/** 从图片里读出来的追踪信息。 */
export interface TracePayload {
  /** 载荷格式版本 */
  version: number;
  /** 载荷原文 */
  text: string;
  /** 解析出来的键值对 */
  fields: Array<{ key: string; value: string }>;
  /** 校验和是否通过。**为假时上面的字段不可信** */
  crcOk: boolean;
  /** 从几处重复里读出来（`0` 表示完全没找到水印） */
  copies: number;
}

// ============================================================
// 台账
// ============================================================

/** 台账里的一条记录。 */
export interface LedgerRecord {
  id: number;
  /** 追踪编号 */
  traceId: string;
  /** 输出文件名 */
  outputName: string;
  /**
   * 输出目录的**显示名**（用户在目录对话框里选的那个目录的名字）。
   *
   * **它不是绝对路径，而且不可能是。** `ctx.files` 刻意不把授权目标的绝对路径
   * 交给插件 —— 那是这个能力能被接受的前提。因此台账记的是"导出到了哪个目录
   * （叫什么名字）"，而不是"导出到了哪条路径"。想在本地找到它，按名字搜即可。
   */
  outputDir: string;
  /** 输出文件的 SHA-256 */
  outputSha: string;
  /** 源文件名 */
  sourceName: string;
  /** 源文件的 SHA-256 */
  sourceSha: string;
  author: string;
  platform: string;
  order: string;
  buyer: string;
  license: string;
  contact: string;
  extra: string;
  /** 隐形水印的载荷原文 */
  payload: string;
  /** 可见水印实际渲染出来的那几行（占位符已替换） */
  visibleLines: string[];
  /** 墨水模式：`light` / `dark`（`auto` 判定的结果） */
  ink: string;
  /** 有没有写隐形水印 */
  invisible: boolean;
  width: number;
  height: number;
  beforeBytes: number;
  afterBytes: number;
  /** 记录创建时间（毫秒时间戳） */
  createdAt: number;
  /** 发放日期 `yyyyMMdd` */
  issued: string;
}

/** 一次批量任务的统计。 */
export interface BatchStats {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  beforeBytes: number;
  afterBytes: number;
}
