// src/art-trace/ui/view-chrome.tsx
//
// 视图共用的外壳零件。
//
// ============================================================
// 为什么它们不在 `app.tsx` 里
// ============================================================
//
// 这些东西（标题条、空状态、痕迹徽标）**每个视图都要用**，而它们的天然位置看起来
// 就是 `app.tsx`。放那里会形成一条循环 import：
//
//     app.tsx  →  views/inspect.tsx  →  app.tsx
//
// ESM 容得下这个环（这些值都在渲染时才被读到，那时两个模块都已经初始化完了），
// 因此它**不会报错**。但那正是它危险的地方：某一天有人在模块顶层用一下 `ViewBar`
// 或者调整一下导入顺序，同一个环就会变成 `undefined is not a function` ——
// 而报错指向的是一处看起来完全无关的代码。
//
// 拆成独立模块之后，依赖方向是单向的：`app` 与 `views/*` 都依赖这里，这里谁都不依赖。
// 顺带的好处是"视图的头部长得一样"这件事有了唯一的实现 —— 否则每个视图各拼一遍
// 那几个类名，迟早有一个会漏掉 `arttrace__bar-spacer`，而那只表现为"按钮跑到左边去了"。

import type { ReactNode } from 'react';
import { React } from '../env';
import { IconAlert, IconCheck, IconInfo } from './icons';

/** 视图统一的"标题 + 说明 + 动作"条。所有视图都以它开头 */
export function ViewBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="arttrace__bar">
      <span className="arttrace__bar-title">{title}</span>
      {subtitle ? <span className="arttrace__bar-sub">{subtitle}</span> : null}
      <span className="arttrace__bar-spacer" />
      {actions}
    </div>
  );
}

/**
 * "这个宿主没有文件访问能力"的说明。
 *
 * 它是一整块 `Banner` 而不是一句小字：宿主缺这个能力时插件**什么都做不了**，
 * 而用户面对的会是一堆按不动的按钮。把原因和下一步写在这里，比让他去翻控制台有用。
 */
export function NeedFiles(): ReactNode {
  return (
    <div className="arttrace__banner arttrace__banner--warn">
      <span className="arttrace__banner-icon">
        <IconAlert size={15} />
      </span>
      <div className="arttrace__banner-text">
        当前宿主不提供 <code>ctx.files</code>（插件读写用户选定文件的通道）。
        本插件的全部功能都建立在它之上 —— 请在「设置 → 关于」确认宿主版本，
        或换用带该能力的宿主。
      </div>
    </div>
  );
}

/** 隐形水印的读取结果徽标 */
export function TraceBadge({ copies }: { copies: number }) {
  if (copies <= 0) {
    return (
      <span className="arttrace__tag" title="没有在像素最低位里找到本插件写入的载荷">
        无水印
      </span>
    );
  }
  return (
    <span
      className="arttrace__tag arttrace__tag--good"
      title={`在像素最低位里读到 ${copies} 份完整载荷`}
    >
      水印 ×{copies}
    </span>
  );
}

/** 一个"注意"图标加一句话 */
export function HintLine({ children }: { children: ReactNode }) {
  return (
    <span className="arttrace__hint arttrace__row">
      <IconInfo size={12} />
      <span>{children}</span>
    </span>
  );
}

/** 成功的小勾。批量结果那一行用 */
export function GoodMark() {
  return <IconCheck size={13} />;
}
