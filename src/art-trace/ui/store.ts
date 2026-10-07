// src/art-trace/ui/store.ts
//
// 工作台的状态与动作。
//
// ============================================================
// 为什么用外置 store 而不是把状态放在 App 的 useState 里
// ============================================================
//
// 五个视图共享同一批东西：选中的图片、清理策略、水印设置、身份信息、批量队列。
// 把状态提到 App 再逐层传下去意味着每一层都要声明一堆与它无关的 props，而"某一层
// 忘了转发一个回调"这种错误不会报错 —— 它表现为"点了没反应"。
//
// 外置 store 让视图直接读它需要的、直接调它需要的动作。`useSyncExternalStore` 是
// React 官方给这种用法准备的入口（宿主那份 React 有它）。
//
// ============================================================
// 一条与内存有关的纪律
// ============================================================
//
// **图片字节不进 store。** 一张 ComfyUI 的 PNG 是 2~4.5 MB，一批几十张就是几百 MB。
// 因此：
//
//   * 缩略图用 `ctx.files.url(grant, rel)` —— 让引擎自己去取，它知道怎么省；
//   * 只有**当前选中的那一张**的字节会被读进内存（`activeBytes`），换一张就换掉；
//   * 批量处理逐张读、逐张写、用完即弃，任何时刻内存里只有一张。
//
// ============================================================
// 为什么 `Item` 上要同时有 `grant` 与 `rel`
// ============================================================
//
// `ctx.files` 有两种授权：**单文件**（`rel` 必须为空）与**目录**（`rel` 是目录内的
// 相对路径）。同一个目录下的几十张图共用**一条**目录授权，因此"用 grant 定位一条"
// 是不成立的 —— 必须 `(grant, rel)` 一起。
//
// 这一条如果靠"这个 grant 上挂了几个条目"之类的启发式去猜，就一定会在某个边界上
// 猜错（例如用户先选了目录又单独选了里面的一张）。因此它是一个显式字段。

import type {
  CleanOptions,
  GenParams,
  ImageInfo,
  InspectResult,
  LedgerRecord,
  TracePayload,
  VisibleWatermarkOptions,
  InvisibleWatermarkOptions,
  WatermarkFields,
  ExifField,
} from '../model/types';
import {
  DEFAULT_CLEAN_OPTIONS,
  DEFAULT_ID_PREFIX,
  DEFAULT_PAYLOAD_TEMPLATE,
  DEFAULT_VISIBLE_LINES,
  IMAGE_EXTENSIONS,
  KEY_PREFS,
  MAX_BATCH_FILES,
  MAX_IMAGE_BYTES,
  ctx,
  files,
  React,
  requireFiles,
} from '../env';
import { analyze, toMetaBlocks } from '../analyze';
import { parseExif } from '../codec/exif';
import { sha256Hex } from '../codec/hash';
import { processImage } from '../clean/pipeline';
import { readTrace } from '../watermark/render';
import {
  makeTraceId,
  normalizePrefix,
  renderTemplate,
  todayStamp,
} from '../trace/payload';
import {
  clearLedger,
  deleteRecord,
  existingTraceIds,
  findByTraceId,
  insertRecord,
  ledgerStats,
  listRecords,
} from '../trace/ledger';
import type { LedgerQuery, LedgerStats } from '../trace/ledger';

// ============================================================
// 状态形状
// ============================================================

export type ViewId = 'inspect' | 'batch' | 'watermark' | 'ledger' | 'settings';

export interface NoticeEntry {
  id: number;
  tone: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

/** 身份信息。水印文案与追加信息共用同一份 —— 两处各填一遍必然会不一致 */
export interface Identity {
  author: string;
  platform: string;
  profile: string;
  contact: string;
  license: string;
  order: string;
  buyer: string;
  extra: string;
}

/** 一张已加入工作台的图片 */
export interface Item {
  /** 稳定的界面 key：`grant` + `rel`（见文件头） */
  key: string;
  /** `ctx.files` 的授权 id。**不是路径** —— 宿主不把路径交给插件 */
  grant: string;
  /** 授权之内的相对路径。单文件授权是空串 */
  rel: string;
  name: string;
  bytes: number;
  /** 缩略图地址（同源，可直接放进 `<img src>`） */
  url: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  inspect?: InspectResult;
  /** 从这张图里读出的追踪信息 */
  trace?: TracePayload | null;
  /** 批量处理的结果 */
  result?: {
    ok: boolean;
    outputName: string;
    bytes: number;
    dropped: number;
    error?: string;
  };
  /** 批量队列里是否勾选 */
  picked: boolean;
}

export interface BatchProgress {
  running: boolean;
  done: number;
  total: number;
  label: string;
  cancelRequested: boolean;
  ok: number;
  failed: number;
}

export interface Prefs {
  schema: number;
  identity: Identity;
  visible: VisibleWatermarkOptions;
  invisible: InvisibleWatermarkOptions;
  clean: CleanOptions;
  idPrefix: string;
  /** 下一个追踪编号的序号 */
  sequence: number;
  watermarkOnClean: boolean;
  writeSoftware: boolean;
  softwareName: string;
  outputPrefix: string;
  outputSuffix: string;
  confirmOverwrite: boolean;
  pageSize: number;
}

export interface ProbeState {
  name: string;
  state: 'loading' | 'done' | 'error';
  payload: TracePayload | null;
  matches: LedgerRecord[];
  error?: string;
}

export interface WorkbenchState {
  view: ViewId;
  ready: boolean;
  items: Item[];
  activeKey: string | null;
  /** 当前选中那张的字节。**只有一张**，见文件头 */
  activeBytes: Uint8Array | null;
  busy: string | null;
  notices: NoticeEntry[];
  prefs: Prefs;
  /** 可写的输出目录授权 */
  output: { grant: string; label: string } | null;
  batch: BatchProgress;
  ledger: {
    rows: LedgerRecord[];
    total: number;
    query: LedgerQuery;
    stats: LedgerStats | null;
    loading: boolean;
  };
  probe: ProbeState | null;
}

// ============================================================
// 默认值
// ============================================================

const PREFS_SCHEMA = 1;

function defaultPrefs(): Prefs {
  return {
    schema: PREFS_SCHEMA,
    identity: {
      author: '',
      platform: '',
      profile: '',
      contact: '',
      license: '',
      order: '',
      buyer: '',
      extra: '',
    },
    visible: {
      enabled: true,
      lines: [...DEFAULT_VISIBLE_LINES],
      layout: 'bottom-right',
      style: 'outline',
      fontSizeRatio: 0.026,
      lineScale: 0.62,
      marginRatio: 0.03,
      opacity: 135,
      ink: 'auto',
    },
    invisible: {
      enabled: true,
      payloadTemplate: DEFAULT_PAYLOAD_TEMPLATE,
      redundancy: 3,
    },
    clean: { ...DEFAULT_CLEAN_OPTIONS, append: [] },
    idPrefix: DEFAULT_ID_PREFIX,
    sequence: 1,
    watermarkOnClean: true,
    writeSoftware: true,
    softwareName: 'Modulith 影像元数据工坊',
    outputPrefix: '',
    outputSuffix: '',
    confirmOverwrite: true,
    pageSize: 50,
  };
}

/**
 * 把读回来的偏好与默认值合并。
 *
 * **逐字段合并而不是整体替换**：升级插件之后新的偏好项在旧存储里不存在，整体替换
 * 会让它们变成 `undefined`，而其中一些是数字（`fontSizeRatio`）—— `undefined`
 * 传进排版计算会得到 `NaN` 字号，画布上什么都不会画，而且不报错。
 */
export function mergePrefs(raw: unknown): Prefs {
  const base = defaultPrefs();
  if (!raw || typeof raw !== 'object') return base;
  const stored = raw as Partial<Prefs> & { schema?: number };

  // 版本更高的数据只读不写：用旧规则覆盖新数据会把它弄坏，而用户只是降级了插件。
  if (typeof stored.schema === 'number' && stored.schema > PREFS_SCHEMA) return base;

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

  const storedVisible = (stored.visible ?? {}) as Partial<VisibleWatermarkOptions>;
  const storedInvisible = (stored.invisible ?? {}) as Partial<InvisibleWatermarkOptions>;
  const storedClean = (stored.clean ?? {}) as Partial<CleanOptions>;

  return {
    schema: PREFS_SCHEMA,
    identity: { ...base.identity, ...(stored.identity ?? {}) },
    visible: {
      ...base.visible,
      ...storedVisible,
      lines:
        Array.isArray(storedVisible.lines) && storedVisible.lines.length > 0
          ? storedVisible.lines.map((line) => String(line))
          : base.visible.lines,
      fontSizeRatio: num(storedVisible.fontSizeRatio, base.visible.fontSizeRatio),
      lineScale: num(storedVisible.lineScale, base.visible.lineScale),
      marginRatio: num(storedVisible.marginRatio, base.visible.marginRatio),
      opacity: num(storedVisible.opacity, base.visible.opacity),
    },
    invisible: {
      ...base.invisible,
      ...storedInvisible,
      payloadTemplate: str(
        storedInvisible.payloadTemplate,
        base.invisible.payloadTemplate
      ),
      redundancy: num(storedInvisible.redundancy, base.invisible.redundancy),
    },
    clean: {
      ...base.clean,
      ...storedClean,
      append: Array.isArray(storedClean.append)
        ? storedClean.append.map((entry) => ({
            key: String(entry.key ?? ''),
            value: String(entry.value ?? ''),
          }))
        : [],
    },
    idPrefix: str(stored.idPrefix, base.idPrefix),
    sequence: Math.max(1, Math.floor(num(stored.sequence, base.sequence))),
    watermarkOnClean: bool(stored.watermarkOnClean, base.watermarkOnClean),
    writeSoftware: bool(stored.writeSoftware, base.writeSoftware),
    softwareName: str(stored.softwareName, base.softwareName),
    outputPrefix: str(stored.outputPrefix, ''),
    outputSuffix: str(stored.outputSuffix, ''),
    confirmOverwrite: bool(stored.confirmOverwrite, base.confirmOverwrite),
    pageSize: Math.max(10, Math.floor(num(stored.pageSize, base.pageSize))),
  };
}

// ============================================================
// store 本体
// ============================================================

let state: WorkbenchState = {
  view: 'inspect',
  ready: false,
  items: [],
  activeKey: null,
  activeBytes: null,
  busy: null,
  notices: [],
  prefs: defaultPrefs(),
  output: null,
  batch: {
    running: false,
    done: 0,
    total: 0,
    label: '',
    cancelRequested: false,
    ok: 0,
    failed: 0,
  },
  ledger: {
    rows: [],
    total: 0,
    query: { limit: 50, offset: 0, order: 'newest' },
    stats: null,
    loading: false,
  },
  probe: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` 的 `getSnapshot` —— 必须返回**稳定引用**，否则会无限重渲染 */
export function getSnapshot(): WorkbenchState {
  return state;
}

export function setState(patch: Partial<WorkbenchState>): void {
  state = { ...state, ...patch };
  emit();
}

/** 读当前状态（动作内部用，避免闭包里的旧快照） */
export function current(): WorkbenchState {
  return state;
}

export function useStore(): WorkbenchState {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setView(view: ViewId): void {
  setState({ view });
}

// ============================================================
// 提示
// ============================================================

let noticeSeq = 1;

export function notify(tone: NoticeEntry['tone'], message: string): void {
  const entry: NoticeEntry = { id: noticeSeq++, tone, message };
  setState({ notices: [...state.notices, entry].slice(-4) });
  // 错误不自动消失（与宿主通知浮层的取舍一致）：它需要被读到。
  if (tone !== 'error') {
    setTimeout(() => dismissNotice(entry.id), tone === 'warn' ? 8000 : 5000);
  }
}

export function dismissNotice(id: number): void {
  setState({ notices: state.notices.filter((entry) => entry.id !== id) });
}

/** 把一次异常变成一条能看懂的通知 */
export function reportError(prefix: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  ctx.logger.error(`${prefix}：${detail}`);
  notify('error', `${prefix}：${detail}`);
}

// ============================================================
// 偏好：读写
// ============================================================

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** 改偏好。写盘是**防抖**的：拖一个滑块会连发几十次变更 */
export function updatePrefs(patch: Partial<Prefs>): void {
  setState({ prefs: { ...state.prefs, ...patch } });
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistPrefs();
  }, 500);
}

export async function persistPrefs(): Promise<void> {
  try {
    await ctx.storage.set(KEY_PREFS, state.prefs);
  } catch (error) {
    // 存储写失败**不弹通知**：拖一次滑块会失败几十次，那会把界面刷屏。记日志。
    ctx.logger.warn(
      `偏好保存失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** 插件启动时读一次 */
export async function hydrate(): Promise<void> {
  let prefs = defaultPrefs();
  try {
    prefs = mergePrefs(await ctx.storage.get<unknown>(KEY_PREFS));
  } catch (error) {
    // 读失败就用默认值继续跑 —— 一个读不到的偏好不该让整个工具打不开。
    ctx.logger.warn(
      `偏好读取失败，使用默认值：${error instanceof Error ? error.message : String(error)}`
    );
  }
  setState({ prefs, ready: true });
  await refreshLedger();
}

// ============================================================
// 加入图片
// ============================================================

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

function itemKey(grant: string, rel: string): string {
  return `${grant}\u0000${rel}`;
}

function makeItem(input: {
  grant: string;
  rel: string;
  name: string;
  bytes: number;
}): Item {
  return {
    key: itemKey(input.grant, input.rel),
    grant: input.grant,
    rel: input.rel,
    name: input.name,
    bytes: input.bytes,
    url: files ? files.url(input.grant, input.rel) : '',
    state: 'idle',
    picked: true,
  };
}

/** 追加条目，按 key 去重 */
function appendItems(incoming: Item[]): Item[] {
  const existing = new Set(state.items.map((item) => item.key));
  const fresh = incoming.filter((item) => !existing.has(item.key));
  if (fresh.length > 0) setState({ items: [...state.items, ...fresh] });
  return fresh;
}

/** 弹原生多选框挑图片 */
export async function addFiles(): Promise<void> {
  if (!files) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files），无法选择图片。');
    return;
  }
  if (state.busy) return;

  setState({ busy: '正在等待你选择文件…' });
  try {
    const picked = await files.pick({
      extensions: IMAGE_EXTENSIONS,
      filterName: '图片',
    });
    if (picked.length === 0) return;

    const oversized = picked.filter((item) => item.bytes > MAX_IMAGE_BYTES);
    const fresh = appendItems(
      picked
        .filter((item) => item.bytes <= MAX_IMAGE_BYTES)
        // 单文件授权：`rel` 必须为空（一条授权只有一个根）。
        .map((item) =>
          makeItem({ grant: item.grant, rel: '', name: item.label, bytes: item.bytes })
        )
    );

    if (oversized.length > 0) {
      notify(
        'warn',
        `${oversized.length} 个文件超过单张上限（128 MB），已跳过：` +
          oversized
            .slice(0, 3)
            .map((item) => item.label)
            .join('、') +
          (oversized.length > 3 ? ' 等' : '')
      );
    }
    if (fresh.length > 0) await inspectItem(fresh[0]);
  } catch (error) {
    reportError('选择文件失败', error);
  } finally {
    setState({ busy: null });
  }
}

/**
 * 弹原生目录框，把里面的图片全部加进来。
 *
 * 与"逐张多选"的区别不只是方便：这里用的是**一条目录授权**，几十张图共用它，
 * 因此不会像多选那样为每张文件各签一条授权。
 */
export async function addDirectory(): Promise<void> {
  if (!files) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files），无法选择目录。');
    return;
  }
  if (state.busy) return;

  setState({ busy: '正在等待你选择目录…' });
  try {
    const grant = await files.pickDirectory({
      writable: false,
      title: '选择要检视的图片目录',
    });
    if (!grant) return;

    setState({ busy: `正在列出 ${grant.label}…` });
    const entries = await files.list(grant.grant, '');
    const images = entries.filter(
      (entry) => !entry.isDir && IMAGE_EXTENSIONS.includes(extensionOf(entry.name))
    );

    if (images.length === 0) {
      notify('info', `目录 ${grant.label} 里没有找到图片文件。`);
      // 这次授权没用了，立刻还回去 —— 留着它就是留着一条不再需要的许可。
      await files.release(grant.grant).catch(() => {});
      return;
    }

    const capped = images.slice(0, MAX_BATCH_FILES);
    if (images.length > capped.length) {
      notify(
        'warn',
        `目录里有 ${images.length} 个图片文件，本次只加入前 ${MAX_BATCH_FILES} 个。`
      );
    }

    const fresh = appendItems(
      capped.map((entry) =>
        makeItem({
          grant: grant.grant,
          rel: entry.name,
          name: entry.name,
          bytes: entry.size,
        })
      )
    );

    if (fresh.length > 0) await inspectItem(fresh[0]);
  } catch (error) {
    reportError('读取目录失败', error);
  } finally {
    setState({ busy: null });
  }
}

/** 丢掉工作台里的一张 */
export async function removeItem(key: string): Promise<void> {
  const item = state.items.find((entry) => entry.key === key);
  if (!item) return;

  const remaining = state.items.filter((entry) => entry.key !== key);
  setState({
    items: remaining,
    activeKey: state.activeKey === key ? null : state.activeKey,
    activeBytes: state.activeKey === key ? null : state.activeBytes,
  });

  // 只有"这条授权上已经没有别的条目了"才还回去 —— 目录授权是几十张共用的，
  // 因为删掉一张就 release 它会让其余那些读不了。
  const stillUsed = remaining.some((entry) => entry.grant === item.grant);
  if (!stillUsed && files) await files.release(item.grant).catch(() => {});
}

export async function clearItems(): Promise<void> {
  const grants = [...new Set(state.items.map((item) => item.grant))];
  setState({ items: [], activeKey: null, activeBytes: null });
  if (!files) return;
  for (const grant of grants) await files.release(grant).catch(() => {});
}

// ============================================================
// 检视
// ============================================================

function patchItem(key: string, patch: Partial<Item>): void {
  setState({
    items: state.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
  });
}

/** EXIF 解析失败不该让整张图看不了 —— 它是整份检视里最可能失败的一步 */
function safeExif(bytes: Uint8Array): ExifField[] {
  try {
    return parseExif(bytes).fields;
  } catch (error) {
    ctx.logger.debug(
      `EXIF 解析失败：${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * 检视一张图：读字节 → 解析容器 → 识别生成器 → 读追踪水印。
 */
export async function inspectItem(target: Item | { grant: string; rel: string; key: string }): Promise<void> {
  const service = files;
  if (!service) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files）。');
    return;
  }

  const { grant, rel, key } = target;
  patchItem(key, { state: 'loading', error: undefined, result: undefined });
  setState({ activeKey: key, activeBytes: null });

  try {
    const source = new Uint8Array(await service.read(grant, rel));
    if (source.length === 0) throw new Error('这个文件是空的');

    // **走 `analyze()`，不自己拼"解析 → 识别 → 升级分组"这三步。**
    // 自己拼过一次，而那次拼漏了升级分组 —— 后果是检视页把生成参数显示成普通
    // 文本块、清理时一个块都不丢，且完全静默。理由见 `analyze.ts` 的文件头。
    const result = analyze(source);
    if (!result.ok) throw new Error(result.error);

    const { parse, blocks, generation, info } = result.analysis;

    // 读 LSB 水印要走一遍画布，是这里最贵的一步。失败不算错：绝大多数图里没有水印。
    let trace: TracePayload | null = null;
    try {
      trace = await readTrace(source);
    } catch (error) {
      ctx.logger.debug(
        `读取追踪水印失败（不影响其它结果）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const inspect: InspectResult = {
      info,
      blocks: toMetaBlocks(blocks),
      // 结论由解析层算好带过来，界面不重算 —— 判据只有一个来源。见 `analyze.ts`。
      verdict: result.analysis.audit.verdict,
      generation,
      exif: parse.exif ? safeExif(parse.exif) : [],
      xmp: parse.xmp,
      iccBytes: parse.iccBytes,
      c2pa: parse.c2pa,
      rewritable: parse.rewritable,
      rewriteBlockedReason: parse.blockedReason,
      sha256: await sha256Hex(source),
    };

    patchItem(key, { state: 'ready', inspect, trace, bytes: source.length });
    // 只有当前选中的那一张保留字节 —— 见文件头那条内存纪律。
    if (current().activeKey === key) setState({ activeBytes: source });
  } catch (error) {
    patchItem(key, {
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    reportError(`检视「${rel || '文件'}」失败`, error);
  }
}

/** 选中一张（把它读进内存） */
export function selectItem(key: string): void {
  const item = state.items.find((entry) => entry.key === key);
  setState({ activeKey: key, activeBytes: null });
  if (item && item.state !== 'ready') {
    void inspectItem(item);
  }
}

export function togglePicked(key: string): void {
  setState({
    items: state.items.map((item) =>
      item.key === key ? { ...item, picked: !item.picked } : item
    ),
  });
}

export function setAllPicked(picked: boolean): void {
  setState({ items: state.items.map((item) => ({ ...item, picked })) });
}

// ============================================================
// 输出目录
// ============================================================

export async function chooseOutputDirectory(): Promise<void> {
  const service = files;
  if (!service) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files）。');
    return;
  }
  if (state.busy) return;

  setState({ busy: '正在等待你选择输出目录…' });
  try {
    const grant = await service.pickDirectory({
      writable: true,
      title: '选择成品的输出目录',
    });
    if (!grant) return;
    if (!grant.writable) {
      throw new Error(
        '拿到的目录授权不可写 —— 这通常意味着插件没有声明 filesystem-scoped 权限'
      );
    }
    setState({ output: { grant: grant.grant, label: grant.label } });
    notify('success', `输出目录已设为「${grant.label}」。`);
  } catch (error) {
    reportError('选择输出目录失败', error);
  } finally {
    setState({ busy: null });
  }
}

// ============================================================
// 水印字段与追踪编号
// ============================================================

export function buildFields(
  identity: Identity,
  traceId: string,
  date: string
): WatermarkFields {
  return {
    author: identity.author,
    platform: identity.platform,
    profile: identity.profile,
    contact: identity.contact,
    license: identity.license,
    order: identity.order,
    buyer: identity.buyer,
    extra: identity.extra,
    id: traceId,
    date,
  };
}

/**
 * 生成下一个追踪编号，并**避开台账里已经用过的那些**。
 *
 * 这一条是台账的全部价值所在：如果同一个编号发给了两张不同的图，"查到当初发给了谁"
 * 就变成了"查到两个人"。因此序号必须持久化，而且要用之前先查一次。
 */
export async function nextTraceId(): Promise<{
  id: string;
  sequence: number;
  date: string;
}> {
  const date = todayStamp();
  const prefix = normalizePrefix(state.prefs.idPrefix);
  let sequence = Math.max(1, Math.floor(state.prefs.sequence));

  let used: string[] = [];
  try {
    used = await existingTraceIds(prefix, date);
  } catch {
    // 台账读不到时仍然给编号：随机段让重复概率极低，而"因为查不了台账就不给编号"
    // 是更坏的选择。但这一点要在日志里留下痕迹。
    ctx.logger.warn('查不到台账里已用的编号，本次编号可能与已有记录重复');
  }

  const usedSet = new Set(used);
  let id = makeTraceId({ prefix, date, sequence });
  let guard = 0;
  while (usedSet.has(id) && guard < 20000) {
    sequence += 1;
    id = makeTraceId({ prefix, date, sequence });
    guard += 1;
  }

  return { id, sequence, date };
}

/** 预览编号（不写回序号），界面上的"下一个编号"用它 */
export async function previewTraceId(): Promise<string> {
  return (await nextTraceId()).id;
}

/** 把可见水印的模板行渲染成实际文本 */
export function resolvedLines(fields: WatermarkFields): string[] {
  return state.prefs.visible.lines
    .map((line) => renderTemplate(line, fields))
    .filter((line) => line.trim().length > 0)
    .slice(0, 5);
}

/** 渲染隐形载荷的文本 */
export function resolvedPayload(fields: WatermarkFields): string {
  return renderTemplate(state.prefs.invisible.payloadTemplate, fields);
}

// ============================================================
// 批量
// ============================================================

export function requestCancel(): void {
  if (!state.batch.running) return;
  setState({ batch: { ...state.batch, cancelRequested: true } });
}

function buildAppend(
  prefs: Prefs,
  traceId: string,
  date: string
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const push = (key: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0) out.push({ key, value: trimmed });
  };

  push('Author', prefs.identity.author);

  const copyright: string[] = [];
  if (prefs.identity.author.trim()) {
    copyright.push(`© ${date.slice(0, 4)} ${prefs.identity.author.trim()}`.trim());
  }
  if (prefs.identity.license.trim()) copyright.push(prefs.identity.license.trim());
  push('Copyright', copyright.join(' · '));

  push('Contact', prefs.identity.contact);

  const source: string[] = [];
  if (prefs.identity.platform.trim()) source.push(prefs.identity.platform.trim());
  if (prefs.identity.profile.trim()) source.push(prefs.identity.profile.trim());
  push('Source', source.join(' · '));
  push('License', prefs.identity.license);
  push('Description', prefs.identity.extra);

  // 机器可读的一条：键名与隐形水印的载荷完全一致，因此从元数据读到的编号与从
  // LSB 读到的可以对上。
  const pairs = ['v=1', `id=${traceId}`, `d=${date}`];
  if (prefs.identity.author.trim()) pairs.push(`a=${prefs.identity.author.trim()}`);
  if (prefs.identity.platform.trim()) pairs.push(`p=${prefs.identity.platform.trim()}`);
  push('art-trace', pairs.join('|'));

  if (prefs.writeSoftware) push('Software', prefs.softwareName);
  return out;
}

function buildOutputName(prefs: Prefs, sourceName: string, traceId: string): string {
  const at = sourceName.lastIndexOf('.');
  const stem = at > 0 ? sourceName.slice(0, at) : sourceName;
  const ext = at > 0 ? sourceName.slice(at) : '.png';
  const suffix = prefs.outputSuffix.trim() || traceId;
  return `${prefs.outputPrefix}${stem}-${suffix}${ext}`;
}

/**
 * 跑一次批量。
 *
 * 逐张处理，**每一张处理完立刻写盘并记台账**。理由：一批几十张可能要跑几分钟，
 * 而"全部算完再一起写"意味着中途出任何问题（用户关掉界面、宿主重载插件、进程被杀）
 * 都会丢掉全部成果。
 */
export async function runBatch(): Promise<void> {
  const service = files;
  if (!service) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files）。');
    return;
  }
  if (state.batch.running || state.busy) return;

  const queue = state.items.filter((item) => item.picked);
  if (queue.length === 0) {
    notify('warn', '批量队列是空的 —— 先加入图片并勾选它们。');
    return;
  }
  const output = state.output;
  if (!output) {
    notify('warn', '还没有选择输出目录。');
    return;
  }

  const prefs = state.prefs;
  const watermarkRequest = prefs.watermarkOnClean
    ? { visible: prefs.visible, invisible: prefs.invisible }
    : null;

  setState({
    batch: {
      running: true,
      done: 0,
      total: queue.length,
      label: '',
      cancelRequested: false,
      ok: 0,
      failed: 0,
    },
  });

  let sequence = Math.max(1, Math.floor(prefs.sequence));
  const date = todayStamp();
  let ok = 0;
  let failed = 0;

  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (current().batch.cancelRequested) {
      notify('warn', `已中止：处理了 ${index} / ${queue.length} 张。`);
      break;
    }

    setState({ batch: { ...current().batch, done: index, label: item.name } });

    try {
      const source = new Uint8Array(await service.read(item.grant, item.rel));

      const traceId = makeTraceId({
        prefix: normalizePrefix(prefs.idPrefix),
        date,
        sequence,
      });
      sequence += 1;

      const outcome = await processImage({
        source,
        options: { ...prefs.clean, append: buildAppend(prefs, traceId, date) },
        watermark: watermarkRequest,
        fields: buildFields(prefs.identity, traceId, date),
      });

      const outputName = buildOutputName(prefs, item.name, traceId);
      await service.write(output.grant, outputName, outcome.bytes);

      await insertRecord({
        traceId,
        outputName,
        outputDir: output.label,
        outputSha: outcome.outputSha,
        sourceName: item.name,
        sourceSha: outcome.sourceSha,
        author: prefs.identity.author,
        platform: prefs.identity.platform,
        order: prefs.identity.order,
        buyer: prefs.identity.buyer,
        license: prefs.identity.license,
        contact: prefs.identity.contact,
        extra: prefs.identity.extra,
        payload: outcome.payloadText ?? '',
        visibleLines: outcome.visibleLines,
        ink: outcome.ink,
        invisible: outcome.payloadText !== null,
        width: outcome.info.width,
        height: outcome.info.height,
        beforeBytes: outcome.beforeBytes,
        afterBytes: outcome.afterBytes,
        createdAt: Date.now(),
        issued: date,
      });

      patchItem(item.key, {
        result: {
          ok: true,
          outputName,
          bytes: outcome.afterBytes,
          dropped: outcome.dropped.length,
        },
      });
      ok += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      patchItem(item.key, {
        result: { ok: false, outputName: '', bytes: 0, dropped: 0, error: message },
      });
      ctx.logger.error(`处理 ${item.name} 失败：${message}`);
    }

    setState({ batch: { ...current().batch, done: index + 1, ok, failed } });
  }

  // 序号必须落盘：不落的话下一次批量会从同一个序号重新开始，于是**同一个编号会被
  // 发给两张不同的图** —— 而那正是台账唯一要防的事。
  updatePrefs({ sequence });

  const total = current().batch.total;
  setState({ batch: { ...current().batch, running: false, label: '' } });

  if (failed === 0) notify('success', `处理完成：${ok} 张。`);
  else notify('warn', `处理完成：成功 ${ok} 张，失败 ${failed} 张（共 ${total} 张）。`);

  if (ctx.notifications.isAvailable()) {
    await ctx.notifications
      .success(
        '影像元数据工坊',
        `批量处理完成：成功 ${ok} / ${total}，输出到「${output.label}」`,
        'art-trace.batch'
      )
      .catch(() => {});
  }

  await refreshLedger();
}

// ============================================================
// 台账
// ============================================================

export async function refreshLedger(): Promise<void> {
  setState({ ledger: { ...state.ledger, loading: true } });
  try {
    const [page, stats] = await Promise.all([
      listRecords(state.ledger.query),
      ledgerStats(),
    ]);
    setState({
      ledger: {
        ...current().ledger,
        rows: page.rows,
        total: page.total,
        stats,
        loading: false,
      },
    });
  } catch (error) {
    setState({ ledger: { ...current().ledger, loading: false } });
    reportError('读取台账失败', error);
  }
}

export function setLedgerQuery(patch: Partial<LedgerQuery>): void {
  setState({ ledger: { ...state.ledger, query: { ...state.ledger.query, ...patch } } });
  void refreshLedger();
}

export async function removeLedgerRow(id: number): Promise<void> {
  try {
    await deleteRecord(id);
    await refreshLedger();
    notify('success', '已删除该条台账记录。');
  } catch (error) {
    reportError('删除台账记录失败', error);
  }
}

export async function wipeLedger(): Promise<void> {
  try {
    const removed = await clearLedger();
    await refreshLedger();
    notify('success', `台账已清空（删除 ${removed} 条）。`);
  } catch (error) {
    reportError('清空台账失败', error);
  }
}

// ============================================================
// 读回一张流出图的追踪信息
// ============================================================

export async function probeTrace(): Promise<void> {
  const service = files;
  if (!service) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files）。');
    return;
  }
  if (state.busy) return;

  setState({ busy: '正在等待你选择要检查的图片…' });
  try {
    const picked = await service.pick({
      extensions: IMAGE_EXTENSIONS,
      filterName: '要检查的图片',
    });
    if (picked.length === 0) return;

    const item = picked[0];
    setState({
      probe: { name: item.label, state: 'loading', payload: null, matches: [] },
    });

    const source = new Uint8Array(await service.read(item.grant));
    const payload = await readTrace(source);

    let matches: LedgerRecord[] = [];
    if (payload) {
      const idField = payload.fields.find((field) => field.key === 'id');
      if (idField) matches = await findByTraceId(idField.value);
    }

    setState({ probe: { name: item.label, state: 'done', payload, matches } });
    // 这次授权只是一次性检查，用完就还。
    await service.release(item.grant).catch(() => {});
  } catch (error) {
    setState({
      probe: {
        name: state.probe?.name ?? '',
        state: 'error',
        payload: null,
        matches: [],
        error: error instanceof Error ? error.message : String(error),
      },
    });
    reportError('读取追踪信息失败', error);
  } finally {
    setState({ busy: null });
  }
}

export function clearProbe(): void {
  setState({ probe: null });
}

/** 把一段文本写进剪贴板。失败时给一句能照做的话 */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    if (!ctx.clipboard.isAvailable()) {
      throw new Error('插件没有声明 clipboard 权限，或者当前环境不提供剪贴板接口');
    }
    await ctx.clipboard.writeText(text);
    notify('success', `${what}已复制到剪贴板。`);
  } catch (error) {
    reportError(`复制${what}失败`, error);
  }
}

/** 把一段文本作为文件写进输出目录（没有输出目录时提示先选一个） */
export async function saveTextFile(
  name: string,
  text: string,
  what: string
): Promise<void> {
  const service = files;
  if (!service) {
    notify('error', '当前宿主不提供文件访问能力（ctx.files）。');
    return;
  }
  const output = state.output;
  if (!output) {
    notify('warn', `导出${what}需要一个输出目录 —— 先在「批量」里选一个。`);
    return;
  }
  try {
    await service.write(output.grant, name, text);
    notify('success', `${what}已写入「${output.label}/${name}」。`);
  } catch (error) {
    reportError(`导出${what}失败`, error);
  }
}
