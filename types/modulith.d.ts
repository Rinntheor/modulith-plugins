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
   *
   * 声明成 `var` 而不是 `const`：宿主是往全局对象上**挂属性**来注入的，只有 `var`
   * 声明同时给出「裸标识符 `Modulith`」和「`globalThis.Modulith`」两种写法（`const`
   * 在 JS 里不会成为 globalThis 的属性，TS 也据此拒绝 `globalThis.Modulith`）。
   *
   * 类型里带 `| undefined` 是如实描述：宿主没注入时它就是没有，插件必须先判空
   * （见 `src/kanban/env.ts` 的开头）。
   */
  var Modulith: ModulithHost | undefined;

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

    /**
     * **显式引导入口**：宿主把插件身份与数据作为**参数**交进去，而不是让插件去读
     * "当前正在加载哪个插件"这个隐式全局。
     *
     * ```ts
     * Modulith.run(function (bootstrap) {
     *   const ctx = bootstrap.ctx;          // 与 Modulith.createContext() 等价
     *   const saved = bootstrap.settings;    // 本插件设置的当前值快照（只读）
     *   if (bootstrap.capabilities.context.includes('events')) { ... }
     *   Modulith.registerModule({ ... });    // 行为与在顶层调用完全一致
     * });
     * ```
     *
     * 为什么用它：`createContext()` 能工作，靠的是"当前正在加载哪个插件"这个隐式全局 ——
     * 而插件挪进独立进程（沙箱化）之后那个全局不复存在。显式传参是唯一跨得过去的形态，
     * 因此这是新插件应当采用的入口。
     *
     * **回调在 bundle 执行期同步跑完。** 它不是"延迟到激活事件再执行"的生命周期钩子 ——
     * 什么时候执行整段 bundle，仍然由清单的 `activationEvents` 决定。
     *
     * 回调的返回值**被忽略**：贡献仍然通过 `registerModule()` / `registerCommand()` 登记。
     */
    run(entry: (bootstrap: PluginBootstrap) => void): void;

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
     * `engines.modulith` 只表达「我要求宿主至少多新」，而且只提示、不阻断；
     * 真正决定一段代码能不能跑的，是这里列出的东西。
     */
    readonly capabilities: ModulithCapabilities;
  }

  // ============================================================
  // 引导数据（`Modulith.run` 的参数）
  // ============================================================

  /**
   * 宿主交给插件的一份**只读快照**。
   *
   * 全部字段都是值（字符串、数字、纯对象），因此它可以跨进程传递 —— 这正是
   * `Modulith.run` 与 `createContext()` 的区别所在。
   */
  interface PluginBootstrap {
    /** 插件 ID，等于清单的 `name` */
    readonly pluginId: string;
    /** 插件版本，等于清单的 `version` */
    readonly pluginVersion: string;
    /** 宿主版本 */
    readonly hostVersion: string;
    /** 本插件的清单（只读） */
    readonly manifest: PluginManifest | undefined;
    /** 本次执行由什么触发；旧式插件为 `'legacy'` */
    readonly activationEvent: string | null;

    /** 宿主能力表。**特性探测用它**，不要比较版本号 */
    readonly capabilities: ModulithCapabilities;

    /**
     * 本插件自己声明的设置项的**当前值快照**。
     *
     * 是快照，不是读取器：它在 bundle 执行之前取好，之后**不会**跟着变化。
     * 需要跟进变更就用 `ctx.settings.onChange`。
     *
     * 需要清单声明 `storage` 权限；未声明时是空对象。
     */
    readonly settings: Readonly<Record<string, unknown>>;

    /** 本插件的上下文。与 `Modulith.createContext()` 返回的是同一个对象 */
    readonly ctx: ModulithContext;
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
    /**
     * 插件私有文件目录。**需要 `plugin-data` 权限**。
     *
     * 与 `storage` 的分工：那个是一键一个 JSON（单值 1 MB、总量 8 MB），适合配置与
     * 小状态；这个是**目录**，能建子目录、能存二进制（单文件 256 MB、总量 1 GiB），
     * 适合文档、图片、缓存。
     *
     * 路径一律相对数据根，语义是 chroot —— 前导 `/` 没有特殊含义，`/a` 与 `a` 等价。
     * `..`、盘符、以及指向目录之外的符号链接都会被宿主拒绝。
     */
    readonly dataDir: PluginDataDir;
    /**
     * 结构化数据：每插件一个 SQLite 文件。**需要 `plugin-data` 权限**。
     *
     * 前两层（`storage` / `dataDir`）装不下**查询** —— 这个能。
     */
    readonly db: PluginDb;
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
    /** 读写系统剪贴板。**需要 `clipboard` 权限** */
    readonly clipboard: PluginClipboard;
    /** 读插件自己声明的设置项。**需要 `storage` 权限** */
    readonly settings: PluginSettingsAPI;
    /** 收尾登记。功能型插件的必备项 */
    readonly disposables: PluginDisposables;
    /**
     * 访问**用户在原生对话框里当场选中**的文件与目录。
     *
     * 需要 `filesystem-read`（读）与/或 `filesystem-scoped`（可写目录）。
     *
     * ============================================================
     * 为什么它是可选的，以及为什么路径不由插件给出
     * ============================================================
     *
     * 1. **它只有沙箱侧有。** 授权的载体是一条带令牌的 URL，而令牌只发给沙箱界面；
     *    in-process 插件跑在宿主文档里、没有令牌。所以类型上带 `?`，而不是声明成
     *    必有 —— 一个 `ctx.files!` 会在 in-process 下变成运行期 TypeError。
     * 2. **没有 `open(path)` 这种接口，也不会有。** 插件能提供的只有对话框标题与
     *    扩展名过滤器；文件与目录一律由用户在原生对话框里选定。拿到的是不透明的
     *    `grant` 句柄，**绝对路径不会交给插件**。
     * 3. **授权是会话级的**：绑在 `(插件, 界面)` 上，界面一关 / 插件一停用 / 应用
     *    一退出就失效。因此**不要把它存进 `ctx.storage`** —— 下次打开界面时那个 id
     *    已经作废，而每一次调用都会拿到 403。要知道"这次选过哪些"，用 `grants()`。
     *
     * 宿主有没有这个成员也可以直接用 `Modulith.capabilities.context` 探测。
     */
    readonly files?: PluginFiles;
  }

  // ---- files ----

  /**
   * 一次授权的描述。
   *
   * `grant` 是唯一可用的句柄；`label` 只用于显示，**不参与任何路径解析**。
   */
  interface PluginFileGrant {
    grant: string;
    kind: 'file' | 'directory';
    /** 给人看的文件名或目录名 */
    label: string;
    readable: boolean;
    writable: boolean;
    /** 文件授权是文件大小；目录授权恒为 0 */
    bytes: number;
  }

  /** 授权目录里的一个条目，与 `PluginDataEntry` 同形 */
  interface PluginFileEntry {
    name: string;
    isDir: boolean;
    size: number;
    modified: number;
  }

  /**
   * 用户授权的文件访问（`ctx.files`）。**沙箱独有。**
   *
   * 分工上与 `ctx.dataDir` 是"谁的目录"这一个问题：那个是插件自己的私有目录，
   * 这个是用户当场选定的目录。因此这里的总量**没有**迁就插件私有目录那套配额 ——
   * 目标目录是用户自己选的，插件决定的只是它里面的相对路径。
   */
  interface PluginFiles {
    /** 清单里声明了 `filesystem-read` */
    isAvailable(): boolean;
    /** 清单里声明了 `filesystem-scoped`（能不能拿到**可写**的目录授权） */
    canWrite(): boolean;

    /**
     * 弹原生多选框让用户挑文件。取消时返回**空数组**（不是 `null`）。
     *
     * `extensions` 只影响对话框里的过滤器 —— 用户仍然可以切到「所有文件」，
     * 因此**不要把它当成校验**。
     */
    pick(options?: {
      extensions?: string[];
      filterName?: string;
    }): Promise<PluginFileGrant[]>;

    /**
     * 弹原生目录框。用户取消时返回 `null`。
     *
     * `writable` 为真时**需要 `filesystem-scoped`**；只读目录授权只要
     * `filesystem-read`。
     */
    pickDirectory(options?: {
      writable?: boolean;
      title?: string;
    }): Promise<PluginFileGrant | null>;

    /** 这块界面当前持有的全部授权。**这是唯一真源**，不要自己记账 */
    grants(): Promise<PluginFileGrant[]>;

    /** 主动放开一条授权 */
    release(grant: string): Promise<boolean>;

    /** 列一个**目录授权**里的条目 */
    list(grant: string, rel?: string): Promise<PluginFileEntry[]>;

    /** 取元信息；不存在时返回 `null`（不是错误） */
    stat(grant: string, rel?: string): Promise<PluginFileEntry | null>;

    /** 建目录（含中间层）。需要可写 */
    mkdir(grant: string, rel: string): Promise<void>;

    /**
     * 删掉授权目录里的一个文件或一棵树。需要可写。
     *
     * **删不掉授权根** —— 空路径被显式拒绝。最坏情况只能是删掉插件自己写进去的东西。
     */
    remove(grant: string, rel: string): Promise<void>;

    /** 读成字节。**大文件用这个** */
    read(grant: string, rel?: string): Promise<ArrayBuffer>;
    /** 读成文本（UTF-8） */
    readText(grant: string, rel?: string): Promise<string>;

    /** 写一个文件（覆盖）。落盘是"全有或全无" */
    write(
      grant: string,
      rel: string,
      data: ArrayBuffer | ArrayBufferView | Blob | string
    ): Promise<void>;
    /** 写一段文本（UTF-8） */
    writeText(grant: string, rel: string, text: string): Promise<void>;

    /**
     * 一条授权之内的地址，**可以直接放进 `<img src>`**。
     *
     * 用它做预览，不要 `read()` 之后再造 `blob:` —— 后者要求整份字节先经过 JS 堆，
     * 缩略图列表里几十张就是几百 MB。
     */
    url(grant: string, rel?: string): string;
  }

  // ---- dataDir ----

  /**
   * 插件私有文件目录（`ctx.dataDir`）。
   *
   * 所有路径都相对插件的数据根：`''` 是根，`'notes/2026/a.md'` 是子路径。
   * **写入不会自动建父目录** —— 先 `mkdir`，否则会失败。
   */
  interface PluginDataDir {
    /**
     * 数据目录现在能不能用。**它不是装饰。**
     *
     * 数据放在外置盘或网络盘上时，"盘没插"是一个真实状态；那时读出来是空的，
     * 而"空"与"还没有数据"看起来一模一样。写之前先问一次，为假时明确告诉用户
     * "数据目录不可用"，而不是让他以为数据丢了。
     */
    available(): Promise<boolean>;
    list(rel?: string): Promise<PluginDataEntry[]>;
    stat(rel: string): Promise<PluginDataEntry | null>;
    read(rel: string): Promise<Uint8Array>;
    readText(rel: string): Promise<string>;
    write(rel: string, bytes: Uint8Array): Promise<void>;
    writeText(rel: string, text: string): Promise<void>;
    /** 建目录（含中间层）。 */
    mkdir(rel: string): Promise<void>;
    /** 删除文件或**整棵目录树**。不可撤销。 */
    remove(rel: string): Promise<void>;
    /** 当前占用字节数。 */
    used(): Promise<number>;
  }

  interface PluginDataEntry {
    name: string;
    isDir: boolean;
    size: number;
    /** Unix 毫秒 */
    modified: number;
  }

  // ---- db ----

  /**
   * 每插件一个 **SQLite 文件**。**需要 `plugin-data` 权限**。
   *
   * 与另外两层数据的分工：`storage` 是一键一个 JSON（单值 1 MB），`dataDir` 是
   * 文件目录（单文件 256 MB）—— 两者都装不下**查询**。要"按标签筛、按更新时间排、
   * 取第 3 页"时，只有它能把这些交给 SQLite 做，而不是把所有数据拉进 JS 自己过滤。
   *
   * 文件是插件数据目录里的 `plugin.db`，因此 `dataDir.used()` 把它算在内。
   *
   * ## 边界（都由宿主侧的 SQLite 引擎执行，不是文本过滤）
   *
   * * `ATTACH` / `DETACH` 被拒绝 —— 那是唯一一条能在同一个连接里打开**别的文件**
   *   的 SQL，也就是唯一一条能跨出插件数据目录的路；
   * * `PRAGMA max_page_count` / `page_size` / `journal_mode` / `locking_mode` /
   *   `writable_schema` / `mmap_size` 的**设值**被拒绝（读取照常）；
   * * `load_extension` 被拒绝 —— 它会在插件里再开一个没有边界的洞；
   * * 一次调用**只编译一条语句**。多条要一起成功或一起失败，用 `transaction`。
   *
   * ## 值的形状
   *
   * 参数里对象与数组会被存成 JSON 文本；二进制用 `{ $blob: '<base64>' }` 表示
   * （**两个方向都是**）—— 裸 base64 字符串与一段恰好是合法 base64 的文本分不开。
   * 整数与浮点数保持数值类型，`null` 保持 `null`。
   */
  interface PluginDb {
    /**
     * 查询，返回**对象数组**（列名 → 值）。
     *
     * 重名列只保留最后一个 —— 需要全部取值请用 `queryRaw()`，或者给列起别名。
     *
     * 参数用 `?1` / `?2` 占位，按数组顺序绑定。**不要自己拼 SQL 字符串**：
     * 那既是注入面，也会让语句无法被缓存。
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    /** 原始形状。重名列、或者你只是想要数组时用它。 */
    queryRaw(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }>;
    /** 执行一条写入 / DDL。一次调用只能有一条语句。 */
    exec(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
    /**
     * 一批语句，**全成功或全回滚**。
     *
     * **没有 `begin()` / `commit()`。** 跨调用的显式事务是**会泄漏的状态**：
     * 插件崩溃、被卸载、或者只是忘了提交，那条写事务就一直挂着，而这个连接会被
     * 下一个打开数据库的实例继续用 —— 于是"我什么都没干，它却说数据库被锁住了"。
     * 更要命的是插件那一侧拿不到一个"无论发生什么都会执行"的 `finally`。
     */
    transaction(
      statements: Array<{ sql: string; params?: unknown[] }>
    ): Promise<Array<{ changes: number; lastInsertRowId: number }>>;
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

  // ---- clipboard ----

  /**
   * 读写系统剪贴板。**需要 `clipboard` 权限。**
   *
   * ============================================================
   * 强制程度是「前端」，这一点值得知道
   * ============================================================
   *
   * 剪贴板是浏览器 API：`navigator.clipboard` 在页面脚本里本来就可达，
   * 因此宿主**无法**真正拦住一个铁了心要绕过的插件。
   *
   * 与其它能力相比，这一项的实际保障要弱一些 —— 它管住的是"插件按约定走宿主通道"，
   * 而不是"插件拿不到剪贴板"。宿主仍然值得提供它：调用会被记录、行为统一，
   * 而且权限列表里这一项是**真的会拦下忘记声明的插件**的。
   *
   * 需要真正的强隔离，只能等插件挪进独立进程（见
   * `docs/08-规划/插件架构与API-v1.5范围.md`）。
   */
  interface PluginClipboard {
    /** 权限已声明**且**当前环境提供剪贴板接口。用它降级，不要靠 try/catch */
    isAvailable(): boolean;

    /**
     * 读取剪贴板文本。
     *
     * **可能失败，而且失败不是缺陷**：浏览器通常要求页面处于聚焦状态，
     * 剪贴板也可能被别的程序独占。因此调用方应当准备回退路径，
     * 而不是把拒绝当成致命错误。未声明权限时返回空串并记录一次警告。
     */
    readText(): Promise<string>;

    /**
     * 写入剪贴板文本。
     *
     * ⚠️ **这会静默替换用户剪贴板里的内容** —— 用户可能正打算粘贴别的东西。
     * 它不像通知那样显眼，因此别在用户没主动触发的时候调用它。
     *
     * 未声明权限时**静默返回**（记录一次警告）。真的失败时抛错，消息里
     * 会说明原因（通常是"需要用户手势"或"页面未聚焦"）。
     */
    writeText(text: string): Promise<void>;
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
    | 'plugin-data'
    | 'network'
    | 'network-external'
    | 'notification'
    | 'clipboard'
    | 'filesystem-read'
    | 'filesystem-write'
    | 'filesystem-scoped'
    | 'plugin-communicate'
    | 'native-module'
    | 'dev-tools'
    | 'process-spawn';
}

export {};
