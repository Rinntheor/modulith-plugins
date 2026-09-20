// types/modulith.d.ts
//
// 插件 API 的类型定义 —— 给插件作者用的**纯声明**，不含任何运行时。
//
// ============================================================
// 怎么用
// ============================================================
//
// 1. 装 React 的类型（如果你写界面）：`npm i -D @types/react`
// 2. 让 TypeScript 找到这个文件，二选一：
//    * 在 `tsconfig.json` 的 `include` 里加上本文件；
//    * 或在源码顶部写 `/// <reference path="../types/modulith.d.ts" />`
// 3. 然后 `Modulith` 与 `ctx` 就有补全与类型检查了：
//
//    const ctx = Modulith.createContext();
//    const value = await ctx.storage.get<number>('count', 0);
//
// 注意 `Modulith` 是**全局变量**，不需要 import —— 宿主在插件脚本执行前注入它。
//
// ============================================================
// 这份文件是手写的镜像，真源在应用仓库
// ============================================================
//
// 真源是 `modulith-desktop/src/services/pluginRuntime.ts` 与
// `pluginContributions.ts` 的 `HOST_CAPABILITIES`。这份声明由应用仓库的
// `scripts/check-contributions.ts` 核对 —— 它已经在读本仓库的真实插件清单了，
// 跨仓库的文本核对在这个项目里有先例（见「已知问题」里的相关记录）。
//
// **它只用于写代码时，不做运行时校验。** 类型说错了比没有类型更糟（作者会相信
// 补全），所以任何一处与实际不符都应当按缺陷处理。
//
// ============================================================
// 能力的可用性取决于清单声明的权限
// ============================================================
//
// 类型无法表达「有没有声明 `notification`」这件事，所以：
//   * 需要权限的能力都提供 `isAvailable()`，**用它做降级**，不要靠 try/catch；
//   * 未声明权限时宿主**不抛错**（除了 `ctx.settings.set`），而是降级为空实现
//     并记录一次警告 —— 一个可选能力不该让整个插件在加载期失败。

import type * as React from 'react';

declare global {
  // ============================================================
  // 全局入口
  // ============================================================

  /**
   * 宿主注入的全局对象。
   *
   * **只在插件 bundle 执行期间可用**：`createContext()`、`registerCommand()` 与
   * `onDeactivate()` 都必须在 IIFE 顶层同步调用 —— 它们要归属到"当前正在加载的
   * 插件"，而只有加载期才有确定值。
   */
  const Modulith: ModulithHost;

  interface Window {
    Modulith?: ModulithHost;
  }

  interface ModulithHost {
    /** 宿主版本，形如 `1.3.1`。**不要用它做特性判断**，用 `capabilities` */
    readonly version: string;
    /** `windows` / `macos` / `linux` */
    readonly platform: string;

    /**
     * 宿主自己的 React 实例。
     *
     * 给的是同一个实例（不是副本），因此 hooks、context、`React.lazy` 都能用。
     * 代价是**插件与宿主的 React 版本耦合**：插件不能自带一份 React，
     * 两个实例会互相不认识（context 取不到、hook 调用错乱）。
     */
    readonly React: typeof React;
    readonly jsx: typeof React.createElement;
    readonly jsxs: typeof React.createElement;
    readonly Fragment: typeof React.Fragment;

    /**
     * 注册一个模块（占侧边栏一个条目）。
     *
     * 命令型 / 设置型 / 后台型的插件不需要调用它 —— 那些能力由清单的 `contributes`
     * 声明即可，一行代码都不用写。它只服务于**界面型**插件。
     */
    registerModule(registration: PluginModuleRegistration): void;

    /**
     * 创建一个上下文。**只能在 bundle 顶层调用**（见 `Modulith` 的说明）。
     *
     * 通常只在顶层调一次并保存下来，供 `registerModule` 的组件使用。
     */
    createContext(): ModulithContext;

    /** 把一个动作注册进全局搜索框。同样只能在顶层调用 */
    registerCommand(command: PluginCommandRegistration): void;

    /**
     * 登记一个「插件被禁用 / 卸载 / 重载时执行」的清理函数。
     *
     * **功能型插件（后台服务）必须用它。** 宿主知道插件注册的模块与命令，但
     * 不知道它创建的定时器、监听器、观察者与连接 —— 不登记，禁用之后它们会
     * 一直活着。`ctx.disposables.add` 是同一个入口。
     */
    onDeactivate(dispose: () => void): void;

    /**
     * 判断「本模块当前是否真的对用户可见」。
     *
     * 标签页保活意味着模块被切走后**不会卸载**，定时器与轮询会照常跑。用它决定
     * 要不要暂停后台工作：
     *
     * ```ts
     * const active = Modulith.useModuleActive();
     * React.useEffect(() => {
     *   if (!active) return;
     *   const timer = setInterval(refresh, 30_000);
     *   return () => clearInterval(timer);
     * }, [active]);
     * ```
     *
     * 宿主给的是**感知能力**，不是强制暂停 —— JS 里拿不到模块创建的定时器句柄。
     */
    useModuleActive(): boolean;

    /**
     * 宿主能力表。**用它做特性探测**，而不是比较 `version` 字符串。
     *
     * `engines.loopcore` 只表达「我要求宿主至少多新」，而且只提示、不阻断；
     * 真正决定一段代码能不能跑的，是这里列出的东西。
     */
    readonly capabilities: ModulithCapabilities;
  }

  // ============================================================
  // 能力表
  // ============================================================

  interface ModulithCapabilities {
    /** 宿主 API 的主版本。**不匹配就不要跑** —— 宿主会拒绝加载 API 版本更高的插件 */
    readonly api: number;
    /** 全局对象上的成员名 */
    readonly host: readonly string[];
    /** 上下文（`ctx`）上的成员名 */
    readonly context: readonly string[];
    /** 支持的贡献点种类 */
    readonly contributions: readonly string[];
    /** 支持的激活事件名 */
    readonly activationEvents: readonly string[];
  }

  // ============================================================
  // 上下文
  // ============================================================

  interface ModulithContext {
    /** 插件 ID，等于清单的 `name` */
    readonly pluginId: string;
    /** 插件版本，等于清单的 `version` */
    readonly pluginVersion: string;
    /** 宿主版本 */
    readonly version: string;
    /** 本次激活由什么触发；旧式插件为 `'legacy'` */
    readonly activationEvent: string | null;
    /** 本插件的清单（只读） */
    readonly manifest: PluginManifest | undefined;

    /** 键值存储。**需要 `storage` 权限** */
    readonly storage: PluginStorage;
    /** HTTP 请求。**需要 `network` / `network-external` 权限** —— 见下面的说明 */
    readonly http: PluginHttp;
    /** 日志。除控制台外还写进宿主的日志文件 */
    readonly logger: PluginLogger;
    /** 应用内通知。**需要 `notification` 权限** */
    readonly notifications: PluginNotifications;
    /** 插件间通信。**需要 `plugin-communicate` 权限** */
    readonly events: PluginEvents;
    /** 启动外部程序。**需要 `process-spawn` 权限** */
    readonly launcher: PluginLauncher;
    /** 提取本机文件的图标。**需要 `filesystem-read` 权限** */
    readonly icons: PluginIcons;
    /** 在系统文件管理器中定位文件。**需要 `filesystem-read` 权限** */
    readonly shell: PluginShell;
    /** 文件拖放。**需要 `filesystem-read` 权限** */
    readonly fileDrop: PluginFileDrop;
    /** 导入音频文件。**需要 `filesystem-read` 权限** */
    readonly audio: PluginAudio;
    /** 读插件自己声明的设置项。**需要 `storage` 权限** */
    readonly settings: PluginSettingsAPI;
    /** 收尾登记。功能型插件的必备项 */
    readonly disposables: PluginDisposables;
  }

  // ---- storage ----

  interface PluginStorage {
    /** 读取。键不存在时返回 `defaultValue` */
    get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
    /** 写入。值会被 JSON 序列化，因此需要能序列化 */
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    keys(): Promise<string[]>;
    all(): Promise<Record<string, unknown>>;
  }

  // ---- http ----

  /**
   * 插件联网的**唯一通道**。
   *
   * 直接用 `fetch` / `XMLHttpRequest` / `WebSocket` 会被拒绝：CSP 的 `connect-src`
   * 只放行 IPC 与回环地址，宿主还会在调用时给出原因并记一条流量日志。走这里才能
   * 带上权限检查、出站策略与日志 —— 那三样都挂在宿主这一侧。
   *
   * 唯一例外是**回环地址**（`127.0.0.1` / `localhost` / `::1`）：连本机不出这台
   * 机器，因此直接连也放行。即便如此，走这里仍然更好 —— 它会留下日志。
   */
  interface PluginHttp {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    get(url: string, init?: RequestInit): Promise<Response>;
    /** `data` 会被 JSON 序列化，并自动带上 `content-type: application/json` */
    post(url: string, data?: unknown, init?: RequestInit): Promise<Response>;
    put(url: string, data?: unknown, init?: RequestInit): Promise<Response>;
    delete(url: string, init?: RequestInit): Promise<Response>;
  }

  // ---- logger ----

  interface PluginLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    /**
     * 计时器。返回一个函数，调用它打印从创建到调用的毫秒数 —— 宿主自己的
     * `log::*` 记不到插件内部的耗时，这是插件作者唯一的入口。
     */
    trace(label: string): () => void;
  }

  // ---- notifications ----

  interface PluginNotifications {
    /** `dedupeKey` 相同的未读通知会合并，而不是堆成一串 */
    show(title: string, body?: string, dedupeKey?: string): Promise<void>;
    info(title: string, body?: string, dedupeKey?: string): Promise<void>;
    success(title: string, body?: string, dedupeKey?: string): Promise<void>;
    warn(title: string, body?: string, dedupeKey?: string): Promise<void>;
    error(title: string, body?: string, dedupeKey?: string): Promise<void>;
    /** 权限是否已声明。用它降级，不要靠 try/catch */
    isAvailable(): boolean;
  }

  // ---- events ----

  interface PluginEvents {
    publish(topic: string, payload?: unknown): void;
    /** 返回取消订阅函数。插件被禁用/卸载时宿主会一并摘掉，不必自己记 */
    subscribe<T = unknown>(topic: string, handler: (payload: T) => void): () => void;
    isAvailable(): boolean;
  }

  // ---- launcher ----

  interface PluginLauncher {
    /** 启动一个外部程序。参数由宿主转交，不做 shell 解析 */
    launch(program: string, args?: string[]): Promise<void>;
  }

  // ---- icons ----

  interface PluginIcons {
    /**
     * 提取本机某个文件的图标，返回可直接放进 `<img src>` 的字符串。
     *
     * 与插件自己的 `icon.svg` 是两件事：那个是清单里的插件图标，这个是任意
     * 本机文件的图标。
     */
    extract(path: string): Promise<string>;
  }

  // ---- shell ----

  interface PluginShell {
    /** 在系统文件管理器里打开并选中该文件 */
    revealInFolder(path: string): Promise<void>;
  }

  // ---- fileDrop ----

  interface PluginFileDrop {
    /** 权限已声明**且**宿主支持拖放时为真 */
    isAvailable(): boolean;
    /**
     * 订阅窗口级拖放事件。返回取消订阅函数。
     *
     * **这是窗口级事件**：无论当前显示哪个模块，只要有文件被拖进窗口就会触发。
     * 必须用 `Modulith.useModuleActive()` 自行判断当前是否可见，否则会在后台
     * 抢走本该属于其它模块的拖放。
     */
    subscribe(
      handler: (event: { type: 'enter' | 'over' | 'drop' | 'leave'; paths: string[] }) => void
    ): () => void;
  }

  // ---- audio ----

  interface PluginAudio {
    /** 打开文件选择框导入音频。用户取消时返回 `null` */
    pick(): Promise<PickedAudio | null>;
  }

  interface PickedAudio {
    /** 原始文件名 */
    name: string;
    /** 形如 `data:audio/mpeg;base64,...`，可直接交给 `new Audio(...)` */
    dataUrl: string;
    bytes: number;
  }

  // ---- settings ----

  /**
   * 读取插件**自己声明的**设置项（清单的 `contributes.settings`）。
   *
   * `get` / `getAll` 是**同步**的：设置值在插件激活之前就已随贡献目录读好，
   * 因此可以在 IIFE 顶层直接读它来决定怎么做，不必先 `await`。这一点很重要 ——
   * 插件的顶层是同步执行的，一个异步的设置读取根本来不及参与。
   */
  interface PluginSettingsAPI {
    isAvailable(): boolean;
    get<T = unknown>(id: string): T | undefined;
    getAll(): Record<string, unknown>;
    /**
     * 写入。**这是唯一一个在缺少 `storage` 权限时抛错的能力** —— 静默丢弃一次
     * 写入会让用户以为设置生效了。
     */
    set(id: string, value: unknown): Promise<void>;
    /** 订阅变更（用户在设置页改了值）。返回取消订阅函数 */
    subscribe(listener: () => void): () => void;
  }

  // ---- disposables ----

  interface PluginDisposables {
    /** 与 `Modulith.onDeactivate` 等价 */
    add(dispose: () => void): void;
    /** 已登记的数量。用于自检"我有没有漏登记" */
    size(): number;
  }

  // ============================================================
  // 注册入参
  // ============================================================

  interface PluginModuleRegistration {
    /** 模块内的局部 ID。宿主会加插件前缀，因此不必担心与别人撞名 */
    id: string;
    name?: string;
    displayName?: string;
    description?: string;
    /** lucide 图标名（`StickyNote`）或插件包内的 svg 路径（`icon.svg`） */
    icon?: string;
    path?: string;
    priority?: number;
    category?: string;
    badge?: string | number;
    /** 渲染该模块的 React 组件 */
    component: React.ComponentType<Record<string, never>>;
  }

  interface PluginCommandRegistration {
    /** 命令内的局部 ID，宿主会加 `plugin:<插件ID>:` 前缀 */
    id: string;
    title: string;
    subtitle?: string;
    keywords?: string[];
    icon?: string;
    run: () => void | Promise<void>;
  }

  // ============================================================
  // 清单
  // ============================================================

  /**
   * 插件清单（`manifest.json`）。
   *
   * 这里列出的是**插件自己会读到**的那些字段。完整定义与校验规则见应用仓库的
   * `docs/02-开发指南/插件开发/清单文件参考.md` —— 清单由宿主解析与校验，
   * 这份类型不重复描述校验规则。
   */
  interface PluginManifest {
    name: string;
    version: string;
    displayName?: string;
    description?: string;
    main: string;
    style?: string;
    icon?: string;
    author?: { name: string; url?: string };
    license?: string;
    homepage?: string;
    permissions?: PluginPermission[];
    contributes?: unknown;
    activationEvents?: string[];
  }

  /**
   * 权限标识符。
   *
   * **全部用 kebab-case。** 写成 `filesystem:read` 那样的冒号形式会让整份清单
   * 解析失败（而不是被忽略）—— 拼错的文件名与拼错的权限名，后果不一样。
   */
  type PluginPermission =
    | 'storage'
    | 'network'
    | 'network-external'
    | 'notification'
    | 'clipboard'
    | 'filesystem-read'
    | 'filesystem-write'
    | 'filesystem-scoped'
    | 'plugin-communicate'
    | 'process-spawn';
}

export {};
