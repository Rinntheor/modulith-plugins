# 久坐提醒

**一个没有界面的插件。** 它在后台每 45 分钟提醒你起来动一下，并把累计提醒次数记下来。

它存在的意义主要是**演示一条路径**：`contributes.background` —— 无界面插件的形态。

## 它跑在哪里

```
插件包
├── manifest.json    ← contributes.background 指向下面那个文件
├── background.js    ← 真正的入口，跑在一个**独立的 Node 进程**里
└── index.js         ← 空文件（仓库格式要求，宿主不加载它）
```

- **不是 webview，也不占渲染进程。** 界面插件走的是跨源 iframe，那条路是给
  "用户要看着的东西"准备的；一个只想每隔一会儿做一件事的插件不该因此多一个
  渲染进程。
- 那个进程用 `--permission` 启动，**文件读只放开它自己的代码目录**。
- `process.env` 已清空；进程里没有 `require` / `import` / `process`。
- 所有数据都经过宿主：`ctx.storage.*` 是这个进程唯一能碰数据的路。

## 它能用哪些能力

跑在后台的插件拿到的是**界面 ctx 的一个子集**，刻意没有 `ui` / `theme` /
`clipboard` / `fileDrop` / `surfaces` —— 那些要么依赖一个文档，要么依赖用户当前的
鼠标与焦点，而后台进程两样都没有。

| 能力 | 说明 |
| --- | --- |
| `ctx.storage` | 插件私有的键值存储（需要 `storage`） |
| `ctx.notifications` | 应用内通知（需要 `notification`） |
| `ctx.dataDir` | 插件私有文件目录（需要 `plugin-data`） |
| `ctx.db` | 每插件一个 SQLite（需要 `plugin-data`） |
| `ctx.http` | 请求（需要 `network` / `network-external`） |
| `ctx.events` | 跨插件事件总线（需要 `plugin-communicate`） |
| `ctx.logger` | 日志（写进宿主日志，**不写 stdout**） |
| `ctx.disposables` | 卸载/停用时执行的清理函数 |
| `ctx.background.on` | 登记"被唤醒之后做什么" |

## 它什么时候被唤醒

由**清单**决定，不由插件自己决定：

```json
"contributes": {
  "background": {
    "entry": "background.js",
    "onStartup": true,
    "interval": 2700,
    "events": []
  }
}
```

- `onStartup` —— 应用启动后拉起；
- `interval` —— 每隔这么多秒投递一次 `interval` 事件（下限 10 秒）；
- `events` —— 订阅的事件名（`onCommand:<本地 id>` / `onPluginEvent:<名字>`）。

插件在这些时点上用 `ctx.background.on(type, handler)` 登记行为。它**不自己持有
长活计时器** —— 那是"插件想活着"与"空闲回收"之间的约定。

## ⚠️ 两件必须知道的事

1. **后台插件的网络不受管。** 宿主从不给这个进程传 `--allow-net`，但"不授予"
   只有在那个权限项**存在**时才等于拒绝，而它**是版本相关的**：较老的 Node
   （例如 24.x）根本没有这一项，那时插件可以直接 `net.connect` / `fetch` 外连。
   `ctx.http` 仍然每次都判 `network` 权限；不受管的是**绕过 ctx** 那条路。
   因此这个插件不依赖"我连不上网"这个假设，也不往任何地方发请求。
2. **`ctx.notifications` 在这里是 `notify({title, body, level, dedupeKey})`**
   （一个对象参数）。界面插件那一侧是位置参数 `show(title, body, dedupeKey)`。
   两者**形状不同**，因此后台代码不要指望能直接搬进界面插件。
   `ctx.events` 同样是 `emit` / `on`，而界面侧是 `publish` / `subscribe`。

## 安装后在哪看它

插件列表里能看到它（并显示它的后台运行状态）。它**不会**出现在侧边栏 ——
没有 `contributes.modules` 就没有标签页入口，这正是"无界面"的意思。

## 权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 记录累计提醒次数 |
| `notification` | 发应用内通知 |

## 许可

MIT
