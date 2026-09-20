# Modulith 插件仓库

Modulith Desktop 的第一方插件生态仓库。这里存放插件的源码与分发包，以及应用端
「插件市场」读取的索引。

应用本体在 [Rinntheor/modulith-desktop](https://github.com/Rinntheor/modulith-desktop)。
两个仓库分开是有意的：应用仓库不该被插件二进制文件污染，插件生态也应当有自己的
贡献者、许可证与 issue 列表。

## 仓库结构

```
.
├── plugins/            插件：一个插件一个目录（清单、资源、以及 index.js）
│   ├── hello/          参考插件：把所有约定示范一遍的最小完整形态
│   ├── notes/          文本速记：只用 storage 的完整插件
│   ├── pomodoro/       番茄工作钟：后台计时 + 应用内通知 + 自定义提示音
│   └── quick-launch/   快捷启动：需要宿主原生能力的一类（process-spawn / filesystem-read）
├── src/                可选的多文件源码，一个插件一个目录（见 src/README.md）
│   └── kanban/         看板的源码；它的产物是 plugins/kanban/index.js
├── types/              插件 API 的类型声明（modulith.d.ts）
├── dist/               构建产物 .lcp
├── scripts/            打包与索引生成
├── tsconfig.json       类型检查配置，只覆盖 src/ 与 types/ 下的 .ts / .tsx
├── index.json          客户端读取的索引（由脚本生成，勿手工编辑）
├── index.json.sig      索引的签名（客户端验签通过才使用索引）
└── docs/               目录规范与发布流程
```

`plugins/<名称>/index.js` 有两个来源，而产物完全一样：**大多数插件是手写的单文件**
（仓库里没有对应的 `src/`），少数放在 `src/<名称>/` 里、由 `node scripts/build.ts`
构建出来。两条路并存而不冲突，理由见[目录规范](docs/目录规范.md)第 2 节。

```bash
node scripts/build.ts          # 打包 + 生成索引
node scripts/build.ts --check  # 只校验索引与产物是否一致
npm run typecheck              # 类型检查，只覆盖 src/ 与 types/ 下的 .ts / .tsx
```

**构建脚本本身零依赖**，只需要 Node 23.6 以上（脚本是 TypeScript，由 Node 直接执行，
不经过编译）—— 手写单文件插件走的就是这条路。仓库里另有三个 devDependency，只服务
「多文件源码」那条快车道：`esbuild` 负责打包，`typescript` 与 `@types/react` 负责类型
检查。详见 [src/README.md](src/README.md)。

完整发布步骤见 [docs/发布流程.md](docs/发布流程.md)。

## 插件是怎么到达用户的

不需要服务端。整条链路是：

1. 插件源码与 `.lcp` 提交到本仓库，每个插件的每个版本打一个**不可变 tag**。
2. 客户端读取 `index.json`，得到插件列表与各自版本。**候选来源有两个，按顺序尝试**：
   jsDelivr 的 `@main` 地址（带 `?t=<时间戳>` 绕缓存），然后是
   `raw.githubusercontent.com` 直连。用户在应用里配了「下载源」时顺序反过来 ——
   GitHub 那条排前面，并由后端把地址接在加速源域名之后。
   **取回索引后必须验签**：签名（`index.json.sig`）用的是应用里 `tauri.conf.json`
   的 minisign 公钥，与软件更新同一把。验签不过的索引会被整体拒绝，而不是「少几个插件」。
3. 用户点安装时，客户端按索引里的**该版本的不可变 tag + 包在仓库内的相对路径**拼出地址
   下载 `.lcp`（同样是 jsDelivr 与 GitHub 直连两条候选），校验 `sha256`，再交给应用已有的
   安装流水线。
4. README 与 `.lcp` 都按该版本的**不可变 tag** 取，因此同一个版本号下的内容永远一致。
   `node scripts/build.ts` 把这条从"约定"变成硬约束：同一个版本号若被打包出不同字节，
   脚本直接失败并要求升一个版本（见 [docs/发布流程.md](docs/发布流程.md) 第 4 节）。

存储用 GitHub（免费、有版本历史、可回溯），加速用 jsDelivr（免费 CDN，国内有节点）。
月成本为零。

**索引是唯一可变的那一份**，因此只有它需要绕缓存 —— 而缓存这一侧的坑见
[docs/发布流程.md](docs/发布流程.md) 第 9 节。

## 为什么同时提交源码与 .lcp

`.lcp` 是构建产物，通常不该入库。这里刻意入库，原因有两个：

- **CDN 只能代理仓库内容**，不能代理 Release 附件。产物不入库就没有稳定的分发地址。
- 任何人都能 `git checkout` 某个 tag，逐字节核对线上包与仓库内容是否一致。产物不入库
  的话，「某个版本到底发了什么」就无从复查。

## 索引格式定义在哪里

索引格式的**设计说明**在应用仓库里，只有那一份：

[插件生态设计](https://github.com/Rinntheor/modulith-desktop/blob/main/docs/08-规划/插件生态设计.md) 第 4 节

注意那一册的性质与其他册不同：**它描述目标形态，不描述当前代码行为**（应用仓库 `docs/README.md` 对该册有明确声明）。因此要确认「现在真正解析的是什么」，以这两处实现为准 —— 生产方 `scripts/build.ts`（本仓库），消费方 `src/services/pluginMarket.ts` 与 `src/config/pluginRegistry.ts`（应用仓库）。

在这里再抄一份格式说明必然会与它们漂移，因此本文不重复。索引由构建脚本生成，**不手工维护** ——
手工维护的错误模式是可预测的：改了清单版本忘了改索引、算了哈希忘了更新、删了插件忘了
删条目。

## 加一个插件

- 结构与命名规则：[docs/目录规范.md](docs/目录规范.md)
- 打包、打 tag、推送：[docs/发布流程.md](docs/发布流程.md)
- **维护者视角**（收到 PR 之后从审核到上架）：[docs/审核与合并.md](docs/审核与合并.md)

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
