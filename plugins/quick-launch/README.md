# 快捷启动 —— Modulith 插件

把常用程序、快捷方式和网址收在一处，一下打开。

它演示的是**需要宿主原生能力的插件怎么写**：启动程序与打开文件、提取文件图标、
在文件管理器中定位，以及接收拖入的文件。仓库里另有
[`plugins/notes`](../notes/)（只用 `storage` 的完整插件）与
[`plugins/clipboard-history`](../clipboard-history/)（SQLite + 图片落盘 + 虚拟列表）。

> 本插件以 MIT 许可提供。宿主框架是 GPL-3.0，但依据
> [PLUGIN-EXCEPTION.md](https://github.com/Rinntheor/modulith-desktop/blob/main/PLUGIN-EXCEPTION.md)，
> 你自己的插件可以用任意许可（含闭源），只要**不复制框架的实现代码**。
> 复制时请替换名称、作者与图标。详见
> [版权与授权](https://github.com/Rinntheor/modulith-desktop/blob/main/docs/07-法务/版权与授权.md)。

## 功能

| 功能 | 怎么用 |
| --- | --- |
| 添加程序 / 文件 | 右上角「添加 ▾」→「添加程序 / 文件…」，或**把文件/文件夹直接拖进窗口** |
| 添加网址 | 右上角「添加 ▾」→「添加网址…」。只写 `example.com` 会自动补成 `https://example.com`，补出来的结果会**在输入框里回显** |
| 新建分组 | 顶部「+ 分组」，或「添加 ▾」→「新建分组…」 |
| 分类 | 右键条目 →「移入分组」；右键分组可重命名 / 删除 / 只看这个分组 |
| 视图 | 右上角 **网格 / 列表 / 紧凑**，或「外观」菜单；三档在图标尺寸、行高与副标题上真的不同 |
| 打开 | **双击**卡片（可在设置里改成单击），或右键 →「打开」，或选中后按 `Enter` |
| 搜索 | 顶部搜索框，匹配**名称 / 备注 / 路径 / 网址**；按 `/` 聚焦，`Esc` 清空，框内按 `Enter` 启动第一条匹配 |
| 固定 | 右键 →「固定到最前」。固定项在**任何排序下**都排在最前，卡片上有独立标识 |
| 使用统计 | 每次启动记录次数与时间；鼠标悬浮或右键菜单里能看到「已启动 N 次 · 最近 …」 |
| 排序 | 「外观」菜单或设置页：手动 / 最近使用 / 最常使用 / 按名称（默认**手动**） |
| 键盘操作 | 方向键在条目间移动焦点，`Enter` 启动，`Delete` / `Backspace` 删除，`Esc` 退出搜索或关闭对话框 |
| 失效标记 | 启动失败时条目上留下持久的「打不开」标记，下一次成功启动后自动清除；重新定位走右键 →「编辑…」 |
| 刷新图标 | 右键 →「重新提取图标」，清掉缓存重新提取 |
| 导出 / 导入 | 右键空白处 →「导出配置…」/「导入配置…」。导入是**合并或替换二选一**，替换前要再确认一次 |
| 备注 | 右键 →「编辑…」填写；之后鼠标悬浮即显示（与使用统计一起，不占主视觉） |
| 编辑 / 删除 | 右键 →「编辑…」/「删除」（两步确认） |
| 复制路径 | 右键 →「复制路径」 |

图标、分组、视图与排序偏好都存在插件私有存储里，卸载插件时一并清除。

## 申请的三项权限

| 权限 | 用途 | 风险 |
| --- | --- | --- |
| `storage` | 保存条目、分组、偏好与图标缓存；读本插件在清单里声明的设置项 | 低 |
| `process-spawn` | 启动你添加的程序、打开你添加的文件与网址 | **高** |
| `filesystem-read` | 提取文件图标、在文件管理器中定位、接收拖入的文件路径 | 中 |

`process-spawn` 让插件能运行本机上的任意程序，权限等同于你自己的用户账户 ——
安装前请确认你信任该插件的来源。这与「安装插件视同运行本机程序」是同一件事的
两种说法。

**没有申请 `network`。** 因此网址条目不会有 favicon，用的是一块按域名首字母生成的
字母瓦片。抓一张 favicon 的代价是让这个插件能往任意地址发请求，不值得。

## 已知限制

**启动参数不支持引号。** 「启动参数」输入框按空格切分，因此带空格的参数没法写。
参数本身是作为独立的 argv 项传给系统的（不经过 shell，因此没有注入问题），
缺的只是输入层的引号解析。只有可执行文件会用到这里 —— 网址与非可执行文件走
文件关联，不接受参数。

**快捷方式与网址需要宿主 1.7.1 或更高。** 宿主在 1.7.1 才加上
`ctx.launcher.open`（走 shell 的文件关联，也就是资源管理器双击那一条路）。
更旧的宿主上这个插件**照常安装、照常能启动 .exe**，只是打开 `.lnk` / `.url` /
目录 / 文档 / 网址时会明确告诉你需要升级 —— 而不是抛一个
`ctx.launcher.open is not a function`。这也是 `engines.modulith` 仍然写
`>=1.6.0` 的原因：这条能力是做**运行时探测**的，不是靠清单挡住的。

**卡片不能拖到分组上。** 这是一个被平台限制堵住的交互，值得单独说明：Tauri 的
`dragDropEnabled` 默认为 `true` 时会拦截系统拖放，**此时 WebView 内的 HTML5
拖放整体不可用**（Tauri 文档明确要求关闭它才能启用 HTML5 拖放）。因此
「把卡片拖到分组」需要自己用指针事件实现一遍，本插件没有做，改用右键菜单归类。
文件拖入不受影响 —— 它走的是 Tauri 的窗口级事件，正是本插件用的那条通道。

**图标提取目前只在 Windows 上实现。** 其他平台调用 `ctx.icons.extract()` 会明确
报错（而不是返回占位图），卡片回退为字母瓦片。图标取自文件的图标资源，
因此没有图标资源的文件（例如 `.txt`）会提取失败，同样回退到瓦片 ——
`.lnk` 会退到 shell 取图标，因此拖入快捷方式通常能拿到正确的图标。

**拖入只按扩展名判类型。** 插件拿不到文件类型，这是唯一可行的粗判：`.url` 当作
网址条目，有扩展名的当作文件，没有扩展名的当作目录。目录是允许的（打开它会
在资源管理器里打开）。同一个目标重复拖入时不会加第二条，而是把已有的那一条高亮出来。

## 为什么这个插件没有构建步骤

插件的价值在于可读、可改。用 esbuild/rollup 打包会让「源码」与「你看到的代码」
之间隔一层配置，读者得先搭一遍工具链才能改一行试试。因此 `index.js` 直接写成宿主
能加载的形式：一个立即执行函数，不使用 `import` / `export`。

代价是不能用 JSX，因此代码里全部是 `React.createElement`（简写为 `h`）。

三条必须遵守的约定（与是否用构建工具无关）：

1. **不要自己 import React。** 宿主与插件必须共用同一份 React 实例，否则 hooks
   会报错。用 `Modulith.React`。
2. **必须在加载期同步调用 `registerModule()`**（即 IIFE 顶层，不能放进异步回调）。
   宿主按「加载结束时是否注册了模块」判断插件是否加载成功。
3. **不要用 `window.confirm` / `alert` / `prompt`。** 这个宿主里
   `tauri-plugin-dialog` 注入的脚本把它们换成了走 IPC 的 async 版本，于是
   `!window.confirm(...)` 取反的是一个 Promise —— **永远是 false**，
   「用户点了取消」根本拦不住。本插件的所有确认都是自己渲染的两步确认
   （`ConfirmButton`：第一次点击只把按钮变成「确认删除？」，几秒内再点一次才执行）。

## 目录结构

```
quick-launch/
├── manifest.json      清单（声明 storage / process-spawn / filesystem-read 与 6 个设置项）
├── index.js           手写 IIFE，无构建步骤
├── index.css          插件自带样式（深浅两套）
├── icon.svg           图标（SVG 文本会被直接内联渲染）
├── README.md          会显示在插件详情抽屉里
└── LICENSE            MIT
```

打包与发布见[发布流程](../../docs/发布流程.md)：`node scripts/build.ts` 会把 `plugins/` 下的每个
插件打成 `dist/<插件 ID>-<版本>.lcp` 并重新生成 `index.json`。**索引改了必须重新签名** ——
客户端会验签，签名与索引对不上时市场对所有人打不开。

## 实现上值得注意的几点

### 「打开」有两条宿主路径，选错会拿到 os error 193

`ctx.launcher.launch(program, args)` 走 `CreateProcess`，**只认可执行映像**。
把一个 `.lnk` 交给它，得到的是：

```
启动失败：Error: IO 错误: 启动失败 \\?\C:\Users\Public\Desktop\Brave.lnk:
%1 不是有效的 Win32 应用程序。 (os error 193)
```

`ctx.launcher.open(target)` 走 shell 的文件关联（`ShellExecuteExW`），也就是
资源管理器双击那一条路 —— 快捷方式、网址、目录、文档都靠它。

因此本插件里**没有任何一处**直接决定调哪一个，全部经过一个纯函数：

```js
function resolveLaunch(item) {
  if (item.kind === 'url') { /* 校验网址 → open */ }
  else if (looksExecutable(item.target)) return { method: 'launch', target, args };
  // 剩下的一切（.lnk / .url / 目录 / 文档）→ open
  if (!canOpen()) return { error: '这个版本的应用还不支持打开…请升级到 1.7.1 或更高' };
  return { method: 'open', target, args: [] };
}
```

两条细节值得单独写下来：

* **带参数的可执行文件必须走 `launch`。** `open` 不接受参数，用它会把参数
  **静默丢掉** —— 用户填了 `--profile work`，程序却按默认配置起来了。
* **`open` 不存在时要给一句能照做的中文。** `canOpen()` 做的是
  `typeof ctx.launcher.open === 'function'`；直接调用会让用户看到
  `ctx.launcher.open is not a function`，那对用户没有任何指导意义。

### 网址只放行 http / https / mailto

宿主的 `open` 只放行这三种 scheme，因此校验放在插件这一侧，而且**错误消息要说清
为什么**：`file:` 能读本机文件、`javascript:` 能执行脚本、`ms-settings:` 能改系统
设置 —— 把它们交给 shell 关联，等于把这些能力一起交出去。校验逻辑在
`validateUrl()`，它是纯函数，返回 `{ ok, url, normalized, message }`；
`normalized` 为真表示这次补了 scheme，调用方**必须把它回显出来**（对话框里那条
「已自动补全为 …」的说明）。

### `user-select: none`，但输入框要恢复 `text`

拖选卡片时出现一片蓝色高亮是网页行为，不像原生工具。因此 `.ql-root` 上禁掉了
文本选中与 `-webkit-user-drag`，但 `.ql-root input / textarea / select` 单独恢复
`user-select: text` —— **名称、参数、备注、导入用的 JSON 都必须能选中和定位光标**。
反过来写（默认能选、只给卡片禁掉）不行：卡片内部有几层节点，漏掉任何一层都会
重新出现蓝色高亮。

### 设置是异步的，而且沙箱里没有 `subscribe`

`types/modulith.d.ts` 把 `PluginSettingsAPI.get` 声明成同步，而**沙箱桥接层返回的
是 Promise**。两处都是对的（类型包映射的是宿主 in-process 那份契约），因此代码里
用 `Promise.resolve` 收口，不假定是哪种。

由此还有两条结论：

* **沙箱里没有 `ctx.settings.subscribe`。** 因此只在两处重新读：组件挂载时，
  以及模块**重新可见**时（`Modulith.useModuleActive()` 从假变真）—— 那是"用户刚在
  设置页改过"唯一能被发现的时机。
* **写完之后必须重新读，不能"以写代读"。** `ctx.settings.set` 是异步的，就地改
  缓存会让界面显示一个还没落盘的值；落盘失败时它看起来一切正常，直到重开应用。

面板里的「外观」菜单与「设置 → 插件设置」写的是**同一份** `ctx.settings`，因此
两处不会分叉。

### 图标单独存，不塞进主状态

图标是几十 KB 的 PNG data URL。若把它们一起放进条目数组，**改个名字也要重写整份
数据**。因此每个条目的图标存在独立的键 `icon.<条目ID>` 下，主状态始终保持很小。

顺带一个容易踩的坑：存储键只允许字母数字与 `.` `_` `-`，所以用 `icon.` 前缀而不是
`icon:` —— 冒号会被后端直接拒绝。

### 弹窗必须自己限制在模块区域内

`position: fixed` 是相对**窗口**定位的。插件写在模块里的弹窗如果直接 `inset: 0`，
就会盖住标题栏与二级标题栏 —— 那些是宿主的外壳，不该被模块内容压住。

宿主的布局是「每个标签一个独立的滚动容器」（这是滚动位置保活的前提），
**那个容器的可见矩形就是模块可见区域**。因此正确做法是：找到最近的可滚动祖先，
实测它的 `getBoundingClientRect()`，再拿它当固定定位弹窗的 `top/left/width/height`：

```js
function findScrollAncestor(node) {
  let el = node && node.parentElement;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}
```

这里刻意**按计算样式判断，而不是 `closest('.lc-tab-panel')`**：插件不该依赖宿主的
内部类名，「最近的可滚动祖先」是通用的 CSS 语义，宿主换布局也不会失效。

实测而不是写死 `76px`（标题栏 40 + 二级标题栏 36）还有一个好处：初始化告警条出现、
侧边栏折叠等情况下内容区的起点会变，实测会自动跟上。

还有一点很容易漏：**必须观察元素本身的尺寸变化，不能只监听 `window.resize`。**
折叠侧边栏改的是 `main` 的 `margin-left`（256px → 0），**窗口尺寸一点没变**，
`resize` 因此不会触发，弹窗就会停在折叠前的位置上 —— 界面尺寸明明变了，弹窗却在
原地，看起来像没适配。用 `ResizeObserver` 观察滚动容器即可，它还会在折叠那 200ms
过渡的每一帧回调，弹窗因此是连续移动而不是跳一下。

同一个边界也用在右键菜单、备注提示与所有对话框上 —— 根因相同：固定定位不认识
模块的边界。

### 拖放只在模块可见时订阅

`ctx.fileDrop` 的事件是**窗口级**的：只要有文件被拖进窗口就会触发，与当前显示哪个
模块无关。因此订阅前必须判断可见性：

```js
const active = Modulith.useModuleActive();
React.useEffect(() => {
  if (!active) return;
  return ctx.fileDrop.subscribe(handle);
}, [active]);
```

少了这一步，插件会在后台抢走本该属于其它模块的拖放。

### 存储格式变更时向前兼容

`normalizeState()` 认识三种历史形态：最早那版把条目数组直接存在 `shortcuts` 下、
v1 的 `{ version, items, groups, view, filter }`、以及当前的 v2。用户的数据只有
一份，**读的时候容错比写的时候谨慎更重要** —— 读失败就全丢了。

迁移的规则写在代码里，几条关键的是：缺 `kind` 的旧条目按 `app` 处理；缺
`launchCount` / `lastLaunchedAt` / `pinned` / `broken` 的给默认值；旧结构里散在顶层的
设置（`view`）读进 `settings`；指向已删除分组的条目回落到「未分组」，失效的筛选
回落到「全部」。归一化后**条目一个都不会少**。

### 错误直接显示给用户

路径不存在、不是绝对路径、没有声明权限、启动失败 —— 这些都由 Rust 侧拒绝并返回
可读文案，本插件把它显示在界面顶部，而不是吞掉。静默失败会让人以为是路径写错了。

**但"弹一句错误"不够。** 程序被卸载、快捷方式被删掉是长期使用里最常见的一类问题，
而错误提示一闪就没了，用户下次回来只看得到一张点不动的卡片。因此启动失败时会把
标记**落到条目上**（`broken` + `brokenReason` 存进状态），卡片上出现一个红色的
`!`，悬浮能看到原因，右键 →「编辑…」重新定位。下一次成功启动后这个标记自动清除。

### 键盘操作

方向键在条目间移动焦点（`focusOffset` 会同时更新选中态并把 DOM 焦点交过去 ——
只更新状态的话按键事件会一直在原来那张卡片上打转）、`Enter` 启动、
`Delete` / `Backspace` 删除、`Esc` 退出搜索或关闭对话框、`/` 聚焦搜索框。
每个可聚焦元素都有 `aria-label`，卡片本身是 `tabIndex=0` 的 `role="button"`。

## 可用的运行时 API

```js
const ctx = Modulith.createContext();

// 存储（需要 storage）
await ctx.storage.get('key', fallback);
await ctx.storage.set('key', value);
await ctx.storage.delete('key');
await ctx.storage.keys();

// 启动程序（需要 process-spawn，走 CreateProcess，只认可执行映像）
await ctx.launcher.launch('C:\\path\\app.exe', ['--flag']);
// 打开文件 / 快捷方式 / 目录 / 网址（需要 process-spawn，走 shell 的文件关联）
// —— 宿主 1.7.1 起提供；旧宿主上要先探测：typeof ctx.launcher.open === 'function'
await ctx.launcher.open('C:\\path\\Brave.lnk');

// 图标与文件管理（需要 filesystem-read）
const dataUrl = await ctx.icons.extract('C:\\path\\app.exe');
await ctx.shell.revealInFolder('C:\\path\\app.exe');

// 接收拖入（需要 filesystem-read，且是窗口级事件）
const off = ctx.fileDrop.subscribe((e) => {
  if (e.type === 'drop') console.log(e.paths);
});

// 读本插件自己声明的设置项（需要 storage）
ctx.settings.get('launchOn');
await ctx.settings.set('launchOn', 'single');

// 网络（需要 network）
await ctx.http.get(url);

ctx.logger.info('消息', extra);
```

完整签名见应用仓库的[宿主 API 参考](https://github.com/Rinntheor/modulith-desktop/blob/main/docs/02-开发指南/插件开发/宿主API参考.md)。

## 在清单里声明的设置项

| id | 默认值 | 说明 |
| --- | --- | --- |
| `launchOn` | `double` | 双击 / 单击启动。默认双击 —— 改成单击会让"点一下想选中"变成误启动 |
| `sortBy` | `manual` | 手动 / 最近使用 / 最常使用 / 按名称。固定项在任何排序下都在最前 |
| `iconSize` | `medium` | 小 / 中 / 大 |
| `showLabels` | `true` | 关掉之后卡片上只留图标（名称仍在悬浮提示与右键菜单里） |
| `density` | `cozy` | 宽松 / 紧凑 |
| `view` | `grid` | 网格 / 列表 / 紧凑。面板顶部的分段控件也写这一项 |

面板里的「外观」菜单提供同一份设置的快捷入口 —— 两处写的是同一个 `ctx.settings`。
