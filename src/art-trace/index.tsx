/// <reference path="../../types/modulith.d.ts" />
// src/art-trace/index.tsx
//
// 影像元数据工坊的入口。
//
// ============================================================
// 这个文件只做三件事
// ============================================================
//
//   1. 用 `Modulith.run` 拿一次引导信息（宿主版本、本次激活事件）；
//   2. 登记收尾动作；
//   3. 把界面交给宿主（`registerModule`）。
//
// 具体的活全在 `ui/`、`codec/`、`gen/`、`clean/`、`watermark/`、`trace/` 里。
// 入口保持这么薄是有意的：它是唯一一个必须在**加载期同步执行完**的文件，
// 因此也是最容易因为一个多余的 await 而整块白屏的地方。
//
// ============================================================
// 为什么用 `run` 而不是 `createContext`
// ============================================================
//
// `run` 把插件身份作为**参数**交进来（跨得了进程），而 `createContext()` 依赖
// 「当前正在加载哪个插件」这个全局状态。宿主文档里明说新插件应当用 `run`。
// `src/art-trace/env.ts` 里已经用 `createContext()` 取了一次 `ctx` —— 两者返回的是
// **同一个对象**，因此这里用 `run` 只是为了拿到 bootstrap 里的那几个值，不冲突。

import { Modulith, React, ctx } from './env';
import { App } from './ui/app';
import { persistPrefs } from './ui/store';

/** 模块 id。它必须与 `manifest.json` 的 `contributes.modules[].id` 以及
 *  `activationEvents` 里的 `onModule:<id>` **三处逐字一致** —— 这三处对不上
 *  没有任何门禁能发现，症状是"侧边栏有这一项，点开却是空的"。 */
const MODULE_ID = 'artTraceView';

Modulith.run((bootstrap) => {
  ctx.logger.info('影像元数据工坊已加载', {
    host: bootstrap.hostVersion,
    activation: bootstrap.activationEvent,
    // 这一条在排查"插件装上了但用不了"时是第一现场证据：老宿主上它是 false，
    // 而界面会画出那句解释，不需要用户去翻控制台。
    files: typeof ctx.files === 'object' && ctx.files !== null,
  });
});

/**
 * 收尾登记。
 *
 * 偏好的写盘是**防抖**的（拖一次滑块会连发几十次变更，每次都写盘是浪费）。
 * 代价是"最后一次改动可能还没落盘" —— 用户拖完滑块立刻关掉插件就会丢掉它。
 * 这一条在插件被停用/卸载/重载时把最后那次写盘补上。
 *
 * 失败只记日志：收尾阶段抛错没有接收方，而"卸载时崩一下"比"少存一次设置"糟得多。
 */
ctx.disposables.add(() => {
  void persistPrefs().catch(() => {});
});

Modulith.registerModule({
  id: MODULE_ID,
  name: '影像元数据工坊',
  displayName: '影像元数据工坊',
  description: '查清一张图里到底有什么，抹掉痕迹，打上可追踪的水印，并留下台账',
  icon: 'Fingerprint',
  category: 'plugin',
  // 排在常用工具附近。宿主的模块列表按 priority 升序。
  priority: 58,
  component: App,
});
