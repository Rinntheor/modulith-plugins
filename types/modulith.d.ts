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
//   * 未声明权限时宿主**不抛错**（`ctx.settings.set` 与 `ctx.secrets` 的读写除外），
//     而是降级为空实现并记录一次警告 —— 一个可选能力不该让整个插件在加载期失败。
//     `ctx.secrets` 是刻意的例外：那里的 `get` 返回 `null` 会被读成"用户还没配置
//     密钥"，然后引导用户重新输入一遍 —— 而真正的原因是没有声明权限。凭据这件事
//     上，"看起来正常的空答案"比一条错误危险得多。

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
     * 加密的密钥存储：访问令牌、API key 一类凭据。**需要 `secrets` 权限**。
     *
     * **凭据用它，不要用 `storage`。** 两者的保证完全不同，见 `PluginSecrets`。
     */
    readonly secrets: PluginSecrets;
    /**
     * 宿主渲染的**结果卡片**。**需要 `notification` 权限**。
     *
     * 这是 `ui` 上唯一三个运行位置都有的方法。它的同族（对话框、右键菜单、
     * 多界面、状态指示）**只在沙箱侧存在**，理由见 `PluginUi`。
     */
    readonly ui: PluginUi;
    /**
     * 全局热键。**需要 `global-hotkey` 权限**。
     *
     * ⚠️ 一个组合键在系统里是**独占**的：这个插件占用它期间，**这台机器上所有
     * 其它程序**都收不到同一个组合。插件被停用、卸载、或应用退出时宿主会全部
     * 解绑 —— 那是这一项能成立的前提。每个插件最多 4 条。
     */
    readonly hotkey: PluginHotkey;
    /**
     * 读取**前台应用程序**里当前选中的文本。**需要 `read-selection` 权限**。
     *
     * ⚠️ 宿主的实现是"向前台程序合成一次 Ctrl+C 再读剪贴板"，因此它会**短暂
     * 覆盖用户的剪贴板**：文本会被还原，而图片、富文本、文件这类非文本内容
     * **无法还原**。这是这项能力真实的代价，不是实现细节。
     */
    readonly selection: PluginSelection;
    /**
     * ⚠️ **沙箱独有的成员不在这份声明里**，`files` 就是其中一个。
     *
     * 这份文件映射的是**宿主 `HOST_CAPABILITIES.context` 那一份契约**，也就是
     * in-process 的 `ctx`。而 `theme` / `shortcuts` / `commands` / `files`
     * 这些只有沙箱侧才有（它们的载体是令牌或宿主推送），把它们写进这里会让这份
     * 镜像与真实契约**不一致** —— 应用仓库的 `check:contributions.ts` 会逐字比对
     * 两者，因此那样写会当场让宿主那边的门禁变红（试过）。
     *
     * `ui` 是这条规矩的一个**成员级例外**：它两侧都有，但两侧的方法集合不同
     * （in-process 只有 `popover`）。方法级的差异由应用仓库的 `check:sandbox`
     * 逐条登记，而不是靠这里的一句话。
     *
     * 需要给沙箱独有成员补类型的插件，应当在**自己的源码里**做全局声明合并：
     *
     * ```ts
     * // src/<你的插件>/host-extras.d.ts
     * declare global {
     *   interface ModulithContext {
     *     readonly files?: PluginFiles;
     *   }
     * }
     * ```
     *
     * 这样"哪一份契约里有它"这件事就写在需要它的那个插件里，而不是被混进共享镜像。
     * 本插件就是这么做的，见 `src/art-trace/host-files.d.ts`。
     */
  }

  // ---- hotkey ----

  /**
   * 全局热键（`ctx.hotkey`）。**需要 `global-hotkey` 权限**。
   *
   * 它让插件在用户按下某个组合键时被唤醒，**而那个按键发生在别的程序里** ——
   * 这正是"选中即翻译"这类插件成立的前提，也是后台运行位置上最该被用到的能力。
   *
   * ============================================================
   * 三条必须知道的性质
   * ============================================================
   *
   *   1. **组合键在系统里是独占的。** 这个插件占用它期间，`Ctrl+Q` 在别的程序里
   *      不再触发它们自己的行为。用户能拿回它的方式只有：让插件解绑、停用插件、
   *      或关掉应用。宿主在这三条路径上都会解绑 —— 插件**不该**依赖自己记得调用
   *      `unregister()`（热重载与界面重挂载都会重跑顶层代码）。
   *   2. **最多 4 条。** 上限的理由是"用户能看懂"：一个插件占掉十几个组合键时，
   *      用户在系统里按什么都不灵，却没有任何一处能看到是谁拿走的。
   *   3. **组合键语法与宿主一致**：`mod+q` / `mod+shift+tab`，修饰符 `mod`（Windows
   *      上是 Ctrl，macOS 上是 Cmd）、`shift`、`alt`，主键必须恰好一个。只带一个
   *      **普通键**（例如 `a`）的组合会被拒绝 —— 那会把那个键从整台机器上拿走；
   *      单独使用 `F1`..`F24` 是允许的。
   */
  interface PluginHotkey {
    /**
     * 现在能不能注册全局热键。**同步**，用于特性探测。
     *
     * 两个条件都满足才为真：清单里声明了 `global-hotkey`，**且**这个平台支持
     * （只有 Windows 有 `RegisterHotKey`）。
     */
    isAvailable(): boolean;
    /**
     * 注册一条组合键，返回**宿主实际绑定的规范化组合键**（`Ctrl+Q` 回来是 `mod+q`）。
     *
     * 失败时**抛错**，而且错误消息里会点名是谁占着它 —— 宿主快捷键、另一个插件、
     * 还是这台机器上的别的程序。那三种情况下你能做的事完全不同，因此**不要**把
     * 它改写成一句笼统的"注册失败"。
     */
    register(combo: string): Promise<string>;
    /**
     * 解绑一条组合键。
     *
     * **不做权限检查** —— 一条解不掉的绑定就是一个泄漏（它偷的是用户整台机器上的
     * 一个按键）。解绑一条本来就没注册的组合是**静默成功**。
     */
    unregister(combo: string): Promise<void>;
    /** 这个插件当前注册的组合键（规范化形式，最多 4 条）。 */
    list(): Promise<string[]>;
    /**
     * 订阅"我注册的组合键被按下了"，返回取消订阅函数。
     *
     * 触发方向是**宿主 → 插件**（按键发生在别的程序里，这一侧观察不到），因此
     * 与 `fileDrop.subscribe` / `clipboard.subscribe` 同一个形状。平台不支持时
     * **降级成空订阅并告警一次**，而不是抛错 —— 先 `isAvailable()` 自查。
     *
     * 处理函数收到 `{ combo }`：一个插件最多能注册 4 条组合，因此需要这个字段
     * 才能分辨是哪一条触发了（契约里的 `handler()` 表示不要求参数，多给一个字段
     * 不会让任何写法失效）。
     */
    subscribe(handler: (fired: { combo: string }) => void): () => void;
  }

  // ---- selection ----

  /**
   * 读取**前台应用程序**里当前选中的文本（`ctx.selection`）。
   *
   * **需要 `read-selection` 权限**，风险等级是 `high`。
   *
   * ============================================================
   * 它读的是什么、代价是什么
   * ============================================================
   *
   * 它读的是焦点所在那个程序里的选区 —— 可能是编辑器里的一段外文，也可能是
   * **密码框**里的内容、一封正在写的邮件。宿主不能保证"密码不会被读到"：某些
   * 程序不会把密码放进剪贴板，但那是**对方**的决定。
   *
   * 实现方式是向前台程序合成一次 **Ctrl+C** 再读剪贴板，因此它会：
   *   * **短暂覆盖用户的剪贴板**（文本会被还原回去）；
   *   * **无法还原非文本内容** —— 图片、富文本、文件列表在那一刻就没了。
   *
   * 这是"要么接受，要么换成 UI Automation（而在浏览器、Electron 应用、终端里
   * 大面积不生效）"的取舍，不是实现缺陷。
   */
  interface PluginSelection {
    /**
     * 现在能不能读取选中文本。**同步**，用于特性探测。
     *
     * 两个条件都满足才为真：清单里声明了 `read-selection`，**且**这个平台支持
     * （只有 Windows 有 `SendInput`）。
     */
    isAvailable(): boolean;
    /**
     * 读一次前台应用程序里选中的文本。
     *
     * 三种结果**必须分开处理**：
     *   * `string` —— 读到了；
     *   * **`null`** —— 捕获成功了，但剪贴板上最终没有文本（用户选中的是一段空白，
     *     或者那个程序放了一份没有文本的东西）；
     *   * **抛错** —— 这次捕获根本没成功。宿主会说明是哪一种：前台窗口是本应用、
     *     当前没有前台窗口、那个程序不响应 Ctrl+C、或者上一次捕获还没结束。
     *
     * 把后两者混成 `null` 是最糟的处理：你会写出"没有选中就提示用户先选一段"，
     * 而用户明明选中了 —— 那个分支永远走不到，也没有任何线索。
     */
    read(): Promise<string | null>;
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

  // ---- secrets ----

  /**
   * 加密的密钥存储（`ctx.secrets`）。**需要 `secrets` 权限。**
   *
   * ============================================================
   * 它为什么不是 `ctx.storage` 的一个选项
   * ============================================================
   *
   * `ctx.storage` 是明文 JSON，而且插件读得到自己的文件（键文件与 `ctx.dataDir`
   * 的根在同一个目录里）。凭据放进去，等于它平平整整地躺在磁盘上，并且会随备份
   * 一起被导出。`ctx.secrets` 把值加密后存在插件数据目录**之外**，也不属于任何
   * 备份类别。
   *
   * ============================================================
   * 加密保护什么、不保护什么
   * ============================================================
   *
   *   * 密钥由**本机硬件指纹**派生 —— 换机器（或换网卡 / CPU / 主机名）之后这些值
   *     **解不开**。那时 `get` 会抛出一条说明原因的错误，而**不是**返回 `null`：
   *     `null` 会被读成"这个键从来没存过"，于是用户以为凭据丢了，其实它还在磁盘上；
   *   * 它**不是系统钥匙串**。能读这台机器上这个账户文件的人一样能解。
   *     它挡的是"文件被复制到别处"与"凭据明文躺在磁盘/备份里"。
   *
   * 边界（宿主强制，写错了会拿到一条能照做的错误）：
   *   * 密钥名 1..=128 字符，只允许 `A-Za-z0-9._-`；
   *   * 每个值最多 4096 字节（UTF-8 字节数，不是字符数）；
   *   * 每个插件最多 64 个键；
   *   * 未知的键在 `get` 上返回 `null`。
   */
  interface PluginSecrets {
    /** 清单里声明了 `secrets` 权限没有。**同步**，用它做降级 */
    isAvailable(): boolean;

    /**
     * 读一个值。
     *
     * 未知的键返回 `null`。**密文解不开时抛错**（通常是换了机器或文件被改过），
     * 错误消息里会说明"密文仍然在磁盘上、没有被删除" —— 那种情况下不要把它
     * 当成"没有这个键"去覆盖它。
     */
    get(key: string): Promise<string | null>;

    /** 写入一个值（覆盖已有的同名键）。 */
    set(key: string, value: string): Promise<void>;

    /** 删除一个键。**删除不存在的键也是成功**（幂等） */
    delete(key: string): Promise<void>;

    /** 全部键名。**永远只有名字，没有值** */
    keys(): Promise<string[]>;

    /** 清空**本插件**的密钥。别的插件的密钥不受影响 */
    clear(): Promise<void>;
  }

  // ---- ui ----

  /**
   * 宿主渲染的**结果卡片**（`ctx.ui.popover`）。
   *
   * **需要 `notification` 权限** —— 与 `ctx.notifications` 同一档：卡片出现时会
   * 打断用户正在做的事，而这一项权限管的正是"打断用户"。
   *
   * ============================================================
   * 为什么这里只有 `popover` 一个方法
   * ============================================================
   *
   * 沙箱插件拿到的 `ui` 上还有 `dialog` / `contextMenu` / `openSurface` /
   * `closeSurface` / `listSurfaces` / `badge` / `progress` / `splash`。那 8 个
   * **刻意不在这一份里**：这一份映射的是 in-process 的 `ctx`，而那些方法要么挂在
   * "我在哪个界面里"（多界面按 `(插件 id, 界面 id)` 签发令牌），要么要画在宿主的
   * 标签栏或插件那一块 webview 的位置上 —— in-process 插件没有令牌，也没有属于它
   * 自己的那一块。
   *
   * 卡片是这一族里唯一**不需要界面上下文**的：它是一个独立窗口，贴的是屏幕上的
   * 光标。因此它是后台插件唯一能用的"把结果拿给用户看"的入口。
   *
   * 需要那 8 个方法的插件应当在**自己的源码里**做全局声明合并（做法与 `files`
   * 相同，见下面 `ModulithContext` 末尾的说明）。
   */
  interface PluginUi {
    /**
     * 让宿主显示一张结果卡片，等用户点一个动作（或什么都不点）。
     *
     * 返回 `{ action }`：用户点中的动作 id，或者 `null`。
     *
     * ============================================================
     * `null` 的三种来源，以及它**不是**失败
     * ============================================================
     *
     * 到点自动收起、用户按了 Escape、用户点了别处 —— 三者都是 `null`，都属于
     * "用户没回答"。真正的失败（没声明 `notification` 权限、浮层窗口起不来）
     * 会让这个 Promise **拒绝**，因此 `try/catch` 仍然是有意义的。
     *
     * ============================================================
     * 宿主渲染意味着什么
     * ============================================================
     *
     * 你提供的只有**内容**：一段文本与几个按钮文案。没有 HTML、没有样式、没有
     * 图标 —— 卡片长什么样由宿主决定，因此它一眼就是宿主的东西。这也意味着
     * `body` 里的标记会被当成普通文字显示出来。
     *
     * 边界（宿主强制，写错了会拿到一条能照做的错误）：
     *   * `body` 必填，按 4000 个字符截断；`title` 按 120 个字符截断；
     *   * `tone` 取 `'info' | 'success' | 'warning' | 'error'`，认不出的落到 `info`；
     *   * `actions` 最多 3 个。id 只允许 `[a-z0-9-]` 且不超过 32 个字符 ——
     *     形状不对时**整次调用被拒绝**（id 是你回给代码的取值，悄悄改掉它或丢掉
     *     一个按钮比报错糟得多）。label 按 32 个字符截断；
     *   * `timeoutMs` 缺省 8000，钳制到 1000..30000；
     *   * 同一时刻**只有一张卡片**：新的来时旧的当场以 `null` 结束。
     */
    popover(input: PluginPopoverInput): Promise<PluginPopoverResult>;
  }

  /** `ctx.ui.popover` 的入参 */
  interface PluginPopoverInput {
    /** 短标题，可省略 */
    title?: string;
    /** 正文。译文放这里。**它永远是文本**，不是标记 */
    body: string;
    /** 语气。缺省 `info` */
    tone?: 'info' | 'success' | 'warning' | 'error';
    /** 最多 3 个按钮 */
    actions?: Array<{ id: string; label: string }>;
    /** 自动收起的毫秒数，缺省 8000，钳制到 1000..30000 */
    timeoutMs?: number;
    /** 贴在光标处（缺省）还是屏幕正中 */
    at?: 'cursor' | 'center';
  }

  /** `ctx.ui.popover` 的返回值 */
  interface PluginPopoverResult {
    /** 被点中的动作 id；`null` = 到点收起 / Escape / 点别处 */
    action: string | null;
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
    | 'process-spawn'
    | 'secrets'
    | 'clipboard-monitor'
    // 全局热键与读取选中文本（1.6.x）。两项都**只有 Windows 上可用**。
    | 'global-hotkey'
    | 'read-selection';
    // ⚠️ 这个联合类型与宿主枚举之间**没有门禁**：宿主那一侧的扫描只比对 `ModulithHost` /
    // `ModulithContext` 的**成员名**，权限名根本不在它的视野里。正因如此，这份名单曾经
    // 悄悄少过 `secrets` 与 `clipboard-monitor` 两项（它们早已随宿主发布）—— 而"少一个
    // 权限名"的症状，只是插件作者在清单里写它时得到一个类型错误，没有任何检查会报出来。
    // 顺序与 `PluginPermission::ALL` 保持一致，这样将来加值时至少能靠肉眼对上。
    // 要根治得在宿主侧加一条门禁，把这份联合与 `PluginPermission::ALL` 逐项比对。
}

export {};
