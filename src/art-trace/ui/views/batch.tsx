// src/art-trace/ui/views/batch.tsx
//
// 批量清理与导出。这是插件的主战场：一张图一次的操作在「检视」里做，而真正会被
// 用上几十次的是这一页。
//
// ============================================================
// 这一页怎么分工
// ============================================================
//
// 左栏是**会一直用下去的决定**（清理策略、身份信息、输出命名），右栏是**这一次的
// 队列与执行**。把两者上下叠在一起会让"这批处理完之后改个策略再跑一批"变成一次
// 长滚动，而那是这个工具最常用的动作。
//
// ============================================================
// 三个在别处不明显、但会真的坏事的约定
// ============================================================
//
// 1. **不读整批的字节。** 队列里只留 `url`、名字与体积；唯一的例外是当前选中那一张
//    （`state.activeBytes`）。因此左栏那句"计划摘要"只能在选中了一张图之后才算得出来
//    —— 这看起来像偷懒，其实是这个工具能处理几百张图的前提。
// 2. **破坏性动作自己画二次确认。** 沙箱里 `window.confirm` 的返回值不可靠（它可能
//    同步返回 `false` 而用户其实点了确定），因此"清空队列"这类动作换成两个按钮。
// 3. **不写 `<form>`。** 宿主给插件文档开了 `allow-forms`，而 CSP 的
//    `form-action 'none'` 会把提交拦掉 —— 一个没写 `type` 的按钮落在表单里时，
//    点击会变成"什么都没发生"。

import type { ReactNode } from 'react';
import {
  React,
  useEffect,
  useMemo,
  useState,
} from '../../env';
import {
  Banner,
  Button,
  Empty,
  Field,
  Loading,
  Panel,
  Progress,
  Scroll,
  Table,
  Tag,
  TextInput,
  Toggle,
  cx,
} from '../components';
import {
  IconAlert,
  IconChevronRight,
  IconFilePlus,
  IconFolder,
  IconImage,
  IconPlay,
  IconStop,
  IconTrash,
  IconX,
} from '../icons';
import {
  addDirectory,
  addFiles,
  chooseOutputDirectory,
  clearItems,
  notify,
  removeItem,
  requestCancel,
  runBatch,
  selectItem,
  setAllPicked,
  setView,
  togglePicked,
  updatePrefs,
  useStore,
} from '../store';
import type { Identity, Item } from '../store';
import type { CleanOptions } from '../../model/types';
import { summarizePlan } from '../../clean/plan';
import { previewClean } from '../../clean/run';
import { ViewBar } from '../view-chrome';
import { formatBytes } from '../../codec/bytes';
import { todayStamp } from '../../trace/payload';

// ============================================================
// 小工具
// ============================================================

/**
 * 体积变化的百分比。
 *
 * 源体积为 0 时返回 `null` 而不是 `Infinity`：那会显示成 `Infinity%`，而用户在那一刻
 * 需要知道的是"这个数字算不出来"，不是看见一个数学符号。
 */
function deltaPercent(after: number, before: number): string | null {
  if (!Number.isFinite(after) || !Number.isFinite(before) || before <= 0) return null;
  const percent = ((after - before) / before) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/** 身份信息的八个字段。批次与设置两页共用同一份 `prefs.identity` */const IDENTITY_FIELDS: Array<{ key: keyof Identity; label: string; hint?: string }> = [
  { key: 'author', label: '作者 Author' },
  { key: 'platform', label: '平台 Platform' },
  { key: 'profile', label: '主页 Profile', hint: '作品页或店铺地址' },
  { key: 'contact', label: '联系方式 Contact' },
  { key: 'license', label: '授权 License' },
  { key: 'order', label: '订单号 Order', hint: '只进水印与台账，不写进元数据' },
  { key: 'buyer', label: '买家 Buyer', hint: '只进水印与台账，不写进元数据' },
  { key: 'extra', label: '备注 Extra', hint: '写进 Description' },
];
declare function useIdentityType(): import('../store').Identity;

/**
 * 「有痕迹」的判据。
 *
 * **直接读解析层算好的结论**（`InspectResult.verdict`），不在这里从 `blocks` 重新
 * 推断：判据一旦有两份实现就会漂开，而"哪一类块算痕迹"已经有三个地方要用。
 *
 * 三档的含义见 `model/types.ts` 的 `BlockVerdict`：只有第一档 `traces`（生成参数 /
 * EXIF / XMP / 来源凭证）算"需要处理"。**只有文本块那一档不算** —— 那可能是用户
 * 自己要的署名，把它也算成痕迹会让工具指控自己的成品。
 */
function hasTraces(item: Item): boolean {
  return item.inspect?.verdict === 'traces';
}

/** 队列里的一行状态格 */
function stateCell(item: Item): ReactNode {
  if (item.state === 'loading') return <Loading text="读取中…" />;
  if (item.state === 'error') {
    return (
      <Tag className="arttrace__tag--bad" title={item.error}>
        读不了
      </Tag>
    );
  }
  if (item.state === 'ready' && item.inspect) {
    const traces = hasTraces(item);
    return (
      <>
        <Tag className={traces ? 'arttrace__tag--exif' : 'arttrace__tag--good'}>
          {traces ? '有痕迹' : '干净'}
        </Tag>
        {/* 生成器名是这一格里信息量最大的一项：它直接回答"这张图是怎么来的"。 */}
        {item.inspect.generation ? (
          <Tag className="arttrace__tag--generator" title={item.inspect.generation.evidence}>
            {item.inspect.generation.generator}
          </Tag>
        ) : null}
      </>
    );
  }
  return <span className="arttrace__faint">未检视</span>;
}

/** 队列里的一行结果格 */
function resultCell(item: Item): ReactNode {
  const result = item.result;
  if (!result) return <span className="arttrace__faint">—</span>;
  if (!result.ok) {
    return (
      <Tag className="arttrace__tag--bad" title={result.error ?? '处理失败'}>
        {result.error ?? '处理失败'}
      </Tag>
    );
  }
  const delta = deltaPercent(result.bytes, item.bytes);
  return (
    <>
      <div className="arttrace__nowrap" title={result.outputName}>
        <span className="arttrace__muted">{result.outputName}</span>
      </div>
      <Tag className="arttrace__tag--good" title={`${formatBytes(item.bytes)} → ${formatBytes(result.bytes)}`}>
        {delta ?? '已写出'}
      </Tag>
    </>
  );
}

export function BatchView() {
  const state = useStore();
  const prefs = state.prefs;
  const clean = prefs.clean;
  const identity = prefs.identity;

  const [clearArmed, setClearArmed] = useState(false);
  // 文件名预览里的编号：一次挂载只取一次。它是**示例**而不是承诺 —— 真正的编号在
  // 每一张开始处理时才生成（序号要一张一张往前推），因此这里用当天代号占位，
  // 并在 hint 里把这一点说清楚，免得用户以为它会跟成品里的编号一模一样。
  const [previewId] = useState(() => `AT-${todayStamp()}-0001-XXXX`);
  // 「试算」的计算结果是**一次性**的，因此不进 store：它随左栏设置一起失效，
  // 而 store 里放一份会带来"改完设置之后摘要还是旧的"这种不一致。
  const [calc, setCalc] = useState<ReactNode>(null);

  // 二次确认不该在切换视图之后还留着 —— 回来时看到一个"确认清空"按钮，
  // 那会让人以为上一次点击已经生效了。
  useEffect(() => {
    setClearArmed(false);
  }, [state.view]);

  const pickedItems = state.items.filter((item) => item.picked);
  const allPicked = state.items.length > 0 && pickedItems.length === state.items.length;
  const readyCount = state.items.filter((item) => item.state === 'ready').length;
  const failedCount = state.items.filter((item) => item.state === 'error').length;

  // ============================================================
  // 左栏：清理计划摘要
  // ============================================================
  //
  // 计划要靠解析字节才算得出来，而队列里只有**当前选中那一张**的字节。因此这里
  // 只在"选中的那张确实是队列里的一行"时才算 —— 多出来的这层判断防的是：用户移除
  // 了那一行而字节还挂在 store 上，摘要于是继续描述一张已经不在队列里的图。

  const activeItem = state.items.find((item) => item.key === state.activeKey) ?? null;
  const previewResult = useMemo(() => {
    if (!state.activeBytes || !activeItem) return null;
    try {
      return previewClean(state.activeBytes, clean);
    } catch (error) {
      // `previewClean` 在解析失败时返回对象而不是抛错，但这里仍然要兜住 ——
      // 一次未捕获的异常会让整块界面变成宿主的错误画板，而用户只是换了一张图。
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [state.activeBytes, activeItem?.key, clean]);

  const summary = previewResult && previewResult.ok ? summarizePlan(previewResult.plan) : null;
  const planWarnings = previewResult && previewResult.ok ? previewResult.plan.warnings : [];

  // ============================================================
  // 右栏：执行
  // ============================================================

  const running = state.batch.running;
  const blockedReason = running
    ? ''
    : pickedItems.length === 0
      ? '队列里没有勾选项 —— 先勾几张要处理的图。'
      : !state.output
        ? '还没有选择输出目录。'
        : '';
  const canRun = !running && pickedItems.length > 0 && !!state.output && !state.busy;

  async function onCalc(): Promise<void> {
    if (state.busy) return;
    if (!state.activeBytes || !activeItem) {
      notify('warn', '先在队列里点一张图的「检视」，再试算 —— 计划要读那张图的字节。');
      return;
    }
    try {
      const result = previewClean(state.activeBytes, clean);
      if (!result.ok) {
        setCalc(
          <Banner tone="warn">
            「{activeItem.name}」这次没算出计划：{result.error}。
            多半是容器本插件重建不了 —— 执行时这一张会被跳过并记下原因。
          </Banner>
        );
        return;
      }
      const plan = summarizePlan(result.plan);
      setCalc(
        <Banner tone={plan.dropped > 0 ? 'info' : 'warn'}>
          以「{activeItem.name}」为例：将丢掉 {plan.dropped} 个块（
          {plan.hasGenerator ? '含生成参数' : '不含生成参数'}），保留 {plan.kept} 个，
          追加 {plan.appended} 条文本块。整批图各自的内容不同，这里只是一个样本。
          {result.plan.warnings.length > 0 ? ` ${result.plan.warnings[0]}` : ''}
        </Banner>
      );
    } catch (error) {
      setCalc(
        <Banner tone="error">
          试算失败：{error instanceof Error ? error.message : String(error)}
        </Banner>
      );
    }
  }

  // 左栏每一个开关都只改自己那一项，因此必须展开旧对象再覆盖 ——
  // `updatePrefs({ clean: { dropExif: v } })` 会把其余八项一起抹成 `undefined`。
  const setClean = (patch: Partial<CleanOptions>): void => {
    updatePrefs({ clean: { ...clean, ...patch } });
  };

  const CLEAN_GROUPS: Array<{
    title: string;
    note: string;
    danger?: boolean;
    items: Array<{ key: keyof CleanOptions; label: string; hint: string; checked: boolean }>;
  }> = [
    {
      title: '必清的痕迹',
      note: '这些都是"这张图是怎么做出来的"的载体。它们不是画的一部分，抹掉不影响画面。',
      items: [
        {
          key: 'dropGenerator',
          label: '生成参数（提示词 / 工作流 / 模型名）',
          hint: 'ComfyUI 的整张节点图、A1111 的 parameters 都在这一条里 —— 它是最该丢的一项。',
          checked: clean.dropGenerator,
        },
        {
          key: 'dropExif',
          label: 'EXIF（拍摄信息、设备、GPS）',
          hint: '方向会被单独处理，见下面「保留 EXIF 方向」。',
          checked: clean.dropExif,
        },
        {
          key: 'dropXmp',
          label: 'XMP（Adobe 系的整包）',
          hint: '里面常有编辑历史、评分与旧版作者信息。',
          checked: clean.dropXmp,
        },
        {
          key: 'dropC2pa',
          label: 'C2PA / Content Credentials',
          hint: '来源凭证会记录生成与编辑链条。丢它就等于让这张图不再"自带履历"。',
          checked: clean.dropC2pa,
        },
        {
          key: 'dropText',
          label: '普通文本块（tEXt / COM / Description）',
          hint: '默认关：这一条会把你自己刚追加的作者信息一起算进去，因此交给用户决定。',
          checked: clean.dropText,
        },
      ],
    },
    {
      title: '默认保留',
      note: '这些不是隐私。丢掉它们不会让人少查到什么，只会让图看起来不对。',
      items: [
        {
          key: 'keepIcc',
          label: 'ICC 色彩描述文件',
          hint: '丢掉它会让广色域作品在色彩管理正确的查看器里偏色 —— 它是"这些数字该被解释成什么颜色"，不是痕迹。',
          checked: clean.keepIcc,
        },
        {
          key: 'keepPhysical',
          label: '物理尺寸 / DPI（pHYs）',
          hint: '影响打印尺寸与部分排版工具的默认缩放，不含任何可追踪信息。',
          checked: clean.keepPhysical,
        },
        {
          key: 'keepOrientation',
          label: 'EXIF 方向（Orientation）',
          hint: '丢掉会让竖拍的照片在查看器里变成横的 —— 方向存在元数据里，删了就没人知道该怎么摆。',
          checked: clean.keepOrientation,
        },
      ],
    },
    {
      title: '彻底模式',
      note: '只有在"连藏在像素里的东西也要洗掉"时才打开。',
      danger: true,
      items: [
        {
          key: 'reencodePixels',
          label: '重编码像素',
          hint: '更彻底，但画面可能变化 —— 它不再是无损的。',
          checked: clean.reencodePixels,
        },
      ],
    },
  ];

  return (
    <>
      {/* 全宽顶栏。
          它此前不在这一层，而是在右栏里面 —— 结果是本视图看起来"没有标题"，
          而另外四个视图都有。同一套界面里两种头部结构会被读成"这页还没做完"。
          队列自己的动作（开始 / 中止）留在右栏那条 `arttrace__bar` 上，
          因为它们操作的是那一栏里的东西。 */}
      <ViewBar
        title="批量清理"
        subtitle={
          pickedItems.length > 0
            ? `${state.items.length} 张已载入 · 勾选 ${pickedItems.length} 张`
            : '抹掉痕迹、追加信息、打上水印，然后导出'
        }
        actions={
          <>
            <Button
              size="sm"
              icon={<IconFilePlus size={13} />}
              disabled={running}
              onClick={() => void addFiles()}
            >
              选择图片
            </Button>
            <Button
              size="sm"
              icon={<IconFolder size={13} />}
              disabled={running}
              onClick={() => void addDirectory()}
            >
              选择目录
            </Button>
          </>
        }
      />
      <div className="arttrace__split">
      {/* ================= 左栏：设置 ================= */}
      <Scroll className="arttrace__col">
        <Panel
          title="图片来源"
          actions={
            <>
              <Button
                size="sm"
                icon={<IconFilePlus size={13} />}
                onClick={() => void addFiles()}
                disabled={!!state.busy || running}
              >
                选择图片
              </Button>
              <Button
                size="sm"
                icon={<IconFolder size={13} />}
                onClick={() => void addDirectory()}
                disabled={!!state.busy || running}
              >
                选择目录
              </Button>
            </>
          }
        >
          <div className="arttrace__row arttrace__row--between">
            <span className="arttrace__muted">
              队列 {state.items.length} 张 · 已勾选 {pickedItems.length} 张 · 已检视 {readyCount} 张
              {failedCount > 0 ? ` · 失败 ${failedCount} 张` : ''}
            </span>
          </div>

          <div className="arttrace__row arttrace__row--wrap">
            <Button
              size="sm"
              variant="subtle"
              onClick={() => setAllPicked(!allPicked)}
              disabled={state.items.length === 0 || running}
            >
              {allPicked ? '全不选' : '全选'}
            </Button>
            {clearArmed ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<IconTrash size={12} />}
                  onClick={() => {
                    setClearArmed(false);
                    void clearItems();
                  }}
                >
                  确认清空
                </Button>
                <Button size="sm" variant="subtle" onClick={() => setClearArmed(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="subtle"
                icon={<IconX size={12} />}
                onClick={() => setClearArmed(true)}
                disabled={state.items.length === 0 || running}
              >
                清空
              </Button>
            )}
          </div>

          <span className="arttrace__hint">
            「清空」会放开这一批文件的本地授权。源文件在任何情况下都不会被改动 ——
            本插件只往你选的输出目录里写新文件。
          </span>
        </Panel>

        <Panel
          title="清理策略"
          actions={<span className="arttrace__faint">改动立刻生效</span>}
        >
          {CLEAN_GROUPS.map((group) => (
            <div className="arttrace__stack arttrace__stack--tight" key={group.title}>
              <div className="arttrace__row">
                {group.danger ? <IconAlert size={13} /> : null}
                <span className="arttrace__label">{group.title}</span>
              </div>
              <span className="arttrace__hint">{group.note}</span>
              {group.items.map((entry) => (
                <Toggle
                  key={entry.key}
                  checked={entry.checked}
                  label={entry.label}
                  hint={entry.hint}
                  disabled={running}
                  onChange={(value) => setClean({ [entry.key]: value })}
                />
              ))}
            </div>
          ))}

          {clean.reencodePixels ? (
            <Banner tone="warn">
              像素会被重新采样（不再是原图那几个字节），ICC 与全部元数据在重编码之后都不在了。
              它比默认的容器重建更彻底 —— 能洗掉藏在像素排列里的隐写，代价是画面可能变化。
            </Banner>
          ) : null}

          <div className="arttrace__sep" />

          <span className="arttrace__label">这一次会丢掉什么</span>
          {summary ? (
            <>
              <span className="arttrace__muted">
                将丢掉 {summary.dropped} 个块（{summary.hasGenerator ? '含生成参数' : '不含生成参数'}）
                · 保留 {summary.kept} 个 · 追加 {summary.appended} 条文本块
              </span>
              {planWarnings.length > 0 ? (
                <Banner tone="warn">{planWarnings.join(' ')}</Banner>
              ) : null}
            </>
          ) : (
            <span className="arttrace__hint">
              选中一张图可以看到它会丢掉什么 —— 计划要读那张图的字节才算得出来，
              而为了能处理几百张，队列里只有选中那一张的字节在内存里。
            </span>
          )}
        </Panel>

        <Panel
          title="追加信息"
          actions={
            <span className="arttrace__faint">
              与「设置」里的身份信息是同一份
            </span>
          }
        >
          <span className="arttrace__hint">
            这些会作为文本块写进成品（Author / Copyright / Contact / Source / License /
            Description / art-trace），空字段不写。
          </span>
          <div className="arttrace__form-grid">
            {IDENTITY_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <TextInput
                  value={identity[field.key]}
                  disabled={running}
                  onChange={(value) =>
                    updatePrefs({ identity: { ...identity, [field.key]: value } })
                  }
                />
              </Field>
            ))}
          </div>
          <span className="arttrace__hint">
            订单号与买家不会写进成品元数据，但会进水印与台账 ——
            它们是"这一份发给了谁"的依据。
          </span>
        </Panel>

        <Panel
          title="水印"
          actions={
            <Button size="sm" variant="subtle" onClick={() => setView('watermark')}>
              去水印页
            </Button>
          }
        >
          <Toggle
            checked={prefs.watermarkOnClean}
            label="清理时顺带打水印"
            hint="打水印必然要重画像素，因此这一条打开之后，输出就不再是「只删了点元数据」的那份无损结果。"
            disabled={running}
            onChange={(value) => updatePrefs({ watermarkOnClean: value })}
          />
          <div className="arttrace__row arttrace__row--wrap">
            <Tag>可见水印 {prefs.visible.enabled ? `开 · ${prefs.visible.lines.length} 行` : '关'}</Tag>
            <Tag className={prefs.invisible.enabled ? 'arttrace__tag--good' : undefined}>
              隐形水印 {prefs.invisible.enabled ? `开 · ${prefs.invisible.redundancy} 份冗余` : '关'}
            </Tag>
          </div>
          <span className="arttrace__hint">
            这是这一页唯一会改变画面的开关。上面「清理策略」里的默认路径是无损的：
            像素逐字节原样搬运，只重排容器。具体样式在「水印」页设置。
          </span>
        </Panel>

        <Panel
          title="输出"
          actions={
            <Button
              size="sm"
              icon={<IconFolder size={13} />}
              onClick={() => void chooseOutputDirectory()}
              disabled={!!state.busy || running}
            >
              选择输出目录
            </Button>
          }
        >
          <span className="arttrace__muted">
            输出目录：{state.output ? state.output.label : '还没有选择'}
          </span>

          <div className="arttrace__form-grid">
            <Field label="文件名前缀" hint="留空则不前缀">
              <TextInput
                value={prefs.outputPrefix}
                disabled={running}
                onChange={(value) => updatePrefs({ outputPrefix: value })}
              />
            </Field>
            <Field label="文件名后缀" hint="留空时用追踪编号，因此同一张图跑两次也不会互相覆盖">
              <TextInput
                value={prefs.outputSuffix}
                disabled={running}
                onChange={(value) => updatePrefs({ outputSuffix: value })}
              />
            </Field>
          </div>

          <span className="arttrace__label">输出文件名预览</span>
          <span className="arttrace__mono">
            {`${prefs.outputPrefix}portrait-${prefs.outputSuffix.trim() || previewId}.png`}
          </span>
          <span className="arttrace__hint">
            规则是 前缀 + 源文件名主干 + "-" + （后缀，留空则用追踪编号）+ 扩展名。
            上面这个例子是源文件 <code>portrait.png</code> 的结果；扩展名跟着**源格式**
            走 —— 清理是无损的，不会把 PNG 悄悄换成 JPEG。编号里的序号会一张一张往前
            推，因此预览里的那一串只是格式示例（正式编号在每一张开始处理时才生成，
            并且会先查一遍台账避免与已用的重复）。
          </span>
        </Panel>
      </Scroll>

      {/* ================= 右栏：队列与执行 ================= */}
      <div className="arttrace__col">
        <div className="arttrace__bar">
          <span className="arttrace__bar-title">批量队列</span>
          <span className="arttrace__bar-sub">
            {state.items.length} 张 · 已勾选 {pickedItems.length} 张
          </span>
          <span className="arttrace__bar-spacer" />
          <Button
            size="sm"
            onClick={() => void onCalc()}
            disabled={running || !activeItem}
            title="用当前选中那张的字节算一遍计划，不产生任何新文件"
          >
            试算
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="danger"
              icon={<IconStop size={13} />}
              onClick={requestCancel}
            >
              中止
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<IconPlay size={14} />}
              onClick={() => void runBatch()}
              disabled={!canRun}
            >
              开始处理
            </Button>
          )}
        </div>

        {running ? (
          <div className="arttrace__row">
            <span className="arttrace__grow">
              <Progress
                value={state.batch.total > 0 ? state.batch.done / state.batch.total : 0}
                label={`${state.batch.done} / ${state.batch.total}`}
              />
            </span>
            <span className="arttrace__muted arttrace__nowrap" title={state.batch.label}>
              正在处理 {state.batch.label || '…'}
            </span>
          </div>
        ) : null}

        {!running && blockedReason ? (
          <span className="arttrace__muted">{blockedReason}</span>
        ) : null}

        {running && state.batch.cancelRequested ? (
          <Banner tone="warn">
            已请求中止。当前这一张会做完 —— 中途丢下它会在输出目录里留下一个写了一半的文件，
            因此中止发生在每一张的边界上。
          </Banner>
        ) : null}

        {!running && state.batch.done > 0 ? (
          state.batch.failed > 0 ? (
            <Banner tone="warn">
              上一批：成功 {state.batch.ok} 张，失败 {state.batch.failed} 张，共 {state.batch.total} 张。
              失败的那些在下面每一行的「结果」里写着原因。
            </Banner>
          ) : (
            <Banner tone="success">
              上一批：{state.batch.ok} 张全部成功，输出到「{state.output?.label ?? '输出目录'}」。
              台账里已经留下对应的记录，可以在「追踪台账」页导出。
            </Banner>
          )
        ) : null}

        {calc}

        <Panel
          title="队列"
          flush
          className="arttrace__panel--fill"
          actions={<span className="arttrace__faint">勾选的会被处理</span>}
        >
          {state.items.length === 0 ? (
            <Empty
              icon={<IconImage size={26} />}
              title="队列是空的"
              hint="加进来的图片不会离开你的机器：缩略图由引擎直接读盘，字节只有在你检视或处理某一张时才会进内存。"
              action={
                <div className="arttrace__row">
                  <Button icon={<IconFilePlus size={14} />} onClick={() => void addFiles()}>
                    选择图片
                  </Button>
                  <Button icon={<IconFolder size={14} />} onClick={() => void addDirectory()}>
                    选择目录
                  </Button>
                </div>
              }
            />
          ) : (
            <Table
              head={
                <tr>
                  <th>选</th>
                  <th>预览</th>
                  <th>文件名</th>
                  <th className="arttrace__table-num">体积</th>
                  <th>状态</th>
                  <th>结果</th>
                  <th />
                </tr>
              }
            >
              {state.items.map((item) => (
                <tr key={item.key} className={item.key === state.activeKey ? 'is-selected' : undefined}>
                  <td>
                    <Button
                      size="sm"
                      variant="subtle"
                      className={cx('arttrace__thumb-pick', item.picked && 'is-on')}
                      active={item.picked}
                      disabled={running}
                      title={item.picked ? '取消勾选' : '勾选这一张'}
                      onClick={() => togglePicked(item.key)}
                    >
                      {item.picked ? '✓' : ''}
                    </Button>
                  </td>
                  <td>
                    <img className="arttrace__mini" src={item.url} alt="" />
                  </td>
                  <td>
                    <div className="arttrace__nowrap" title={item.name}>
                      {item.name}
                    </div>
                  </td>
                  <td className="arttrace__table-num">{formatBytes(item.bytes)}</td>
                  <td>{stateCell(item)}</td>
                  <td>{resultCell(item)}</td>
                  <td>
                    <div className="arttrace__table-actions">
                      <Button
                        size="sm"
                        variant="subtle"
                        icon={<IconChevronRight size={12} />}
                        title="在「检视」里看它里面到底有什么"
                        onClick={() => {
                          selectItem(item.key);
                          setView('inspect');
                        }}
                      >
                        检视
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        icon={<IconTrash size={12} />}
                        disabled={running}
                        title="从队列里移除（源文件不动）"
                        onClick={() => void removeItem(item.key)}
                      >
                        移除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        </div>
      </div>
    </>
  );
}
