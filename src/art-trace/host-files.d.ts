// src/art-trace/host-files.d.ts
//
// 给**沙箱独有的** `ctx.files` 补类型。
//
// ============================================================
// 为什么它不在 `types/modulith.d.ts` 里
// ============================================================
//
// 那份共享声明镜像的是宿主 `HOST_CAPABILITIES.context` —— 也就是 **in-process 的
// `ctx`**。而 `ctx.files` 只有沙箱侧才有：授权的载体是一条带令牌的 URL，令牌只发给
// 沙箱界面（`SandboxSurfaces::issue`）；in-process 插件跑在宿主文档里，没有令牌，
// 也就没有承载"这条授权属于谁"的凭据。
//
// 把沙箱独有的成员写进那份共享镜像会让它与真实契约**不一致**，而应用仓库的
// `scripts/check-contributions.ts` 会逐字比对两者 —— 宿主那边的门禁会当场变红。
// （这不是推测：本插件第一版就是那么写的，`check:contributions` 报
// 「ModulithContext 与能力表不一致」。）
//
// 因此正确的做法是**在需要它的插件里做全局声明合并**：`ModulithContext` 声明在
// `declare global` 里，所以这里的同名接口会与它合并。这样"哪一份契约里有它"这件事
// 就写在需要它的地方，而不是被混进共享镜像。

declare global {
  interface ModulithContext {
    /**
     * 访问**用户在原生对话框里当场选中**的文件与目录。
     *
     * 需要 `filesystem-read`（读）与/或 `filesystem-scoped`（可写目录）。
     *
     * **类型上是可选的，而且必须如此。** 它只有沙箱侧有；一个 `ctx.files!` 会在
     * in-process 下变成运行期 TypeError。`env.ts` 因此把它收成一个显式的能力探测：
     * 要么拿到它，要么拿到 `null`，界面据此画出"当前宿主不支持文件访问"。
     */
    readonly files?: PluginFiles;
  }

  /**
   * 一次授权的描述。
   *
   * `grant` 是唯一可用的句柄；`label` 只用于显示，**不参与任何路径解析**。
   * **绝对路径不会交给插件** —— 这是这个能力能被接受的前提。
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
   * 与 `ctx.dataDir` 的分工是"谁的目录"这一个问题：那个是插件自己的私有目录，
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
}

export {};
