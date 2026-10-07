// src/art-trace/ui/app.tsx
//
// 工作台外壳：左侧导航 + 主区 + 提示层。
//
// ============================================================
// 导航为什么是"六个固定项"而不是可配置的
// ============================================================
//
// 这个插件的工作流是一条线：**看图 → 决定抹什么 → 打水印 → 批量出片 → 留台账**。
// 可配置的导航在一条线的工作流上只会让"我现在该去哪一页"变成一道选择题。
// 因此这里是固定的六项，顺序就是那条线的顺序。
//
// 「轨迹」放在最后而不是与「水印」交换：它是**事后**才用的（拿到一张流出的图，
// 查当初发给了谁），而水印是事前就要配好的。

import type { ReactNode } from 'react';
import { React, useEffect } from '../env';
import {
  Button,
  Loading,
  Notice,
  Progress,
  cx,
} from './components';
import {
  IconBatch,
  IconInspect,
  IconLedger,
  IconSettings,
  IconWatermark,
  IconX,
} from './icons';
import {
  dismissNotice,
  clearProbe,
  hydrate,
  requestCancel,
  setView,
  useStore,
} from './store';
import type { ViewId } from './store';
import { InspectView } from './views/inspect';
import { BatchView } from './views/batch';
import { WatermarkView } from './views/watermark';
import { LedgerView } from './views/ledger';
import { SettingsView } from './views/settings';

const NAV: Array<{
  id: ViewId;
  label: string;
  icon: ReactNode;
  hint: string;
}> = [
  { id: 'inspect', label: '检视', icon: <IconInspect size={15} />, hint: '看一张图里到底有什么' },
  { id: 'batch', label: '批量清理', icon: <IconBatch size={15} />, hint: '抹掉痕迹并导出' },
  { id: 'watermark', label: '水印设计', icon: <IconWatermark size={15} />, hint: '可见与隐形水印' },
  { id: 'ledger', label: '追踪台账', icon: <IconLedger size={15} />, hint: '谁拿到了哪一份' },
  { id: 'settings', label: '设置', icon: <IconSettings size={15} />, hint: '身份、编号与命名' },
];

export function App() {
  const state = useStore();

  // 偏好与台账在挂载时读一次。`hydrate` 自己会吞掉失败（用默认值继续），
  // 因此这里不需要 catch —— 一个读不到的偏好不该让工具打不开。
  useEffect(() => {
    void hydrate();
  }, []);

  const picked = state.items.filter((item) => item.picked).length;
  const badgeFor = (id: ViewId): number | undefined => {
    if (id === 'batch' && picked > 0) return picked;
    if (id === 'ledger' && state.ledger.stats && state.ledger.stats.records > 0) {
      return state.ledger.stats.records;
    }
    return undefined;
  };

  return (
    <div className="arttrace">
      <div className="arttrace__shell">
        <nav className="arttrace__rail" aria-label="功能">
          {/* 品牌区只有名字与版本，**没有图标**。
              这里原来放了一个盾牌图标当作 logo，被去掉了：左侧导航已经是固定宽度的
              窄栏，图标占掉的是"更长的功能名"与"更少的误点"之间的那点余量，
              而它在信息上什么都没多给 —— 用户看到「影像元数据工坊」就够了。 */}
          <div className="arttrace__brand">
            <span className="arttrace__brand-text">
              <span className="arttrace__brand-name">影像元数据工坊</span>
              <span className="arttrace__brand-version">art-trace 1.0.0</span>
            </span>
          </div>

          {NAV.map((entry) => {
            const badge = badgeFor(entry.id);
            return (
              <button
                key={entry.id}
                type="button"
                className={cx('arttrace__rail-btn', state.view === entry.id && 'is-active')}
                onClick={() => setView(entry.id)}
                title={entry.hint}
                aria-current={state.view === entry.id ? 'page' : undefined}
              >
                {entry.icon}
                <span>{entry.label}</span>
                {badge !== undefined ? (
                  <span className="arttrace__rail-badge">{badge > 99 ? '99+' : badge}</span>
                ) : null}
              </button>
            );
          })}

          <div className="arttrace__rail-foot">
            <span>在制品永不上传</span>
            <span>所有处理都在本机完成</span>
          </div>
        </nav>

        <main className="arttrace__main">
          {/* 正在做的事。它出现在**所有视图的上方**而不是各自视图里：
              批量跑起来之后用户会切到别的页去看结果，而那时他仍然需要看到进度。 */}
          {state.busy ? (
            <div className="arttrace__row">
              <Loading text={state.busy} />
            </div>
          ) : null}

          {state.batch.running ? (
            <div className="arttrace__row">
              <span className="arttrace__grow">
                <Progress
                  value={state.batch.total > 0 ? state.batch.done / state.batch.total : 0}
                  label={`${state.batch.done} / ${state.batch.total}`}
                />
              </span>
              <span className="arttrace__muted arttrace__nowrap">
                {state.batch.label || '准备中…'}
              </span>
              <Button size="sm" variant="danger" icon={<IconX size={13} />} onClick={requestCancel}>
                中止
              </Button>
            </div>
          ) : null}

          {state.notices.length > 0 ? (
            <div className="arttrace__notices">
              {state.notices.map((entry) => (
                <Notice
                  key={entry.id}
                  tone={entry.tone}
                  message={entry.message}
                  onDismiss={() => dismissNotice(entry.id)}
                />
              ))}
            </div>
          ) : null}

          {!state.ready ? (
            <Loading text="正在读取设置…" />
          ) : (
            <ViewBody view={state.view} />
          )}
        </main>
      </div>
    </div>
  );
}

function ViewBody({ view }: { view: ViewId }) {
  switch (view) {
    case 'batch':
      return <BatchView />;
    case 'watermark':
      return <WatermarkView />;
    case 'ledger':
      return <LedgerView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <InspectView />;
  }
}

// ============================================================
// 视图共用的外壳零件住在 `view-chrome.tsx`
// ============================================================
//
// 它们曾经就定义在这个文件里，而每个视图都要用 —— 于是形成 app ↔ views 的循环
// import。ESM 容得下它（这些值在渲染时才被读到），所以它**不会报错**；但那正是
// 它危险的地方：某天有人在模块顶层用一下 `ViewBar`，同一个环就会变成
// `undefined is not a function`，而报错指向一处看起来完全无关的代码。
//
// 这里再导出一次，是为了让"从哪拿"对调用方不重要。
export { ViewBar, NeedFiles, TraceBadge, HintLine, GoodMark } from './view-chrome';

/** 需要时清掉轨迹页的临时状态 */
export { clearProbe };
