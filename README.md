# Modulith 插件仓库

Modulith Desktop 的第一方插件生态仓库。这里存放插件的源码与分发包，以及应用端
「插件市场」读取的索引。

应用本体在 [Rinntheor/modulith-desktop](https://github.com/Rinntheor/modulith-desktop)。
两个仓库分开是有意的：应用仓库不该被插件二进制文件污染，插件生态也应当有自己的
贡献者、许可证与 issue 列表。

## 仓库结构

```
.
├── plugins/            插件源码，一个插件一个目录
│   ├── hello/          参考插件：把所有约定示范一遍的最小完整形态
│   ├── notes/          文本速记：只用 storage 的完整插件
│   ├── pomodoro/       番茄工作钟：后台计时 + 应用内通知 + 自定义提示音
│   └── quick-launch/   快捷启动：需要宿主原生能力的一类（process-spawn / filesystem-read）
├── dist/               构建产物 .lcp
├── scripts/            打包与索引生成
├── index.json          客户端读取的索引（由脚本生成，勿手工编辑）
├── index.json.sig      索引的签名（客户端验签通过才使用索引）
└── docs/               目录规范与发布流程
```

```bash
node scripts/build.ts          # 打包 + 生成索引
node scripts/build.ts --check  # 只校验索引与产物是否一致
```

零依赖，只需要 Node 23.6 以上（脚本是 TypeScript，由 Node 直接执行，不经过编译）。
完整发布步骤见 [docs/发布流程.md](docs/发布流程.md)。

## 插件是怎么到达用户的

不需要服务端。整条链路是：

1. 插件源码与 `.lcp` 提交到本仓库，每个插件的每个版本打一个**不可变 tag**。
2. 客户端从 jsDelivr 读取 `index.json`，得到插件列表与各自版本。
3. 用户点安装时，客户端按索引里的**仓库内相对路径**拼出 CDN 地址下载 `.lcp`，
   校验 `sha256`，再交给应用已有的安装流水线。

存储用 GitHub（免费、有版本历史、可回溯），加速用 jsDelivr（免费 CDN，国内有节点）。
月成本为零。

## 为什么同时提交源码与 .lcp

`.lcp` 是构建产物，通常不该入库。这里刻意入库，原因有两个：

- **CDN 只能代理仓库内容**，不能代理 Release 附件。产物不入库就没有稳定的分发地址。
- 任何人都能 `git checkout` 某个 tag，逐字节核对线上包与仓库内容是否一致。产物不入库
  的话，「某个版本到底发了什么」就无从复查。

## 索引格式定义在哪里

索引格式在**应用仓库**里定义，只有那一份：

[插件生态设计](https://github.com/Rinntheor/modulith-desktop/blob/main/docs/08-规划/插件生态设计.md) 第 4 节

在这里再抄一份必然会与它漂移，因此本文不重复。索引由构建脚本生成，**不手工维护** ——
手工维护的错误模式是可预测的：改了清单版本忘了改索引、算了哈希忘了更新、删了插件忘了
删条目。

## 加一个插件

- 结构与命名规则：[docs/目录规范.md](docs/目录规范.md)
- 打包、打 tag、推送：[docs/发布流程.md](docs/发布流程.md)

`plugins/hello` 是参考实现。它刻意做到最小 —— 一个按钮，记住你点了几次。它的价值不在
功能，而在把所有约定示范一遍：照着复制、改掉名字与图标，就是一份合法插件。

另外三个是**完整的示例插件**，各自侧重一面：`notes` 只用一项权限，`pomodoro` 把计时核心
放在 React 之外并用通知提醒，`quick-launch` 演示需要宿主原生能力的那一类。它们既是可用的
插件，也是可以照着读的源码 —— 应用仓库里还有一份更小的、只示范核心接口的参考插件
`modulith-desktop/samples/reference`。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。**现阶段只接受维护者自己的插件**，投稿流程尚未
开放，原因见该文第 1 节。

## 许可

本仓库的文档以 MIT 提供。每个插件各自声明许可，见其 `manifest.json` 的 `license` 字段
与目录内的 `LICENSE` 文件。

宿主框架是 GPL-3.0，但依据 GPL-3.0 第 7 条附加的**插件例外**，只调用公开插件接口的插件
不被视为框架的衍生作品，因此插件可以用任意许可（含闭源）—— 前提是不复制框架的实现代码。
详见应用仓库的
[版权与授权](https://github.com/Rinntheor/modulith-desktop/blob/main/docs/07-法务/版权与授权.md)。
