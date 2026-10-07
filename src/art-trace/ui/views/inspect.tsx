// src/art-trace/ui/views/inspect.tsx
//
// 检视：一张图里到底有什么。
//
// ============================================================
// 这一页的取舍：先给结论，再给证据
// ============================================================
//
// 用户打开一张 ComfyUI 的图，第一个问题是"这图里有没有我的提示词"，而第二个问题
// 才是"提示词是什么"。因此顺序是：
//
//   1. 一眼能看到的结论（有没有痕迹、是什么生成的）；
//   2. 人最想看的十几个参数（步数、CFG、采样器、种子、模型、LoRA）；
//   3. 提示词原文；
//   4. 然后才是"全部块 / EXIF / XMP / 原始 JSON"这些给排查用的东西。
//
// 把它们平铺在一页上会让第 1 步被淹没 —— 那正是这一类工具最常见的问题：
// 它能显示一切，却没告诉你该看哪里。

import type { ReactNode } from 'react';
import { React, useEffect, useMemo, useState } from '../../env';
import {
  Banner,
  Button,
  CodeBlock,
  Empty,
  KeyValue,
  Loading,
  Panel,
  Scroll,
  Segmented,
  Stat,
  Table,
  Tag,
  TextInput,
  cx,
} from '../components';
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFolder,
  IconImage,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconTrash,
} from '../icons';
import { NeedFiles, TraceBadge, ViewBar } from '../view-chrome';
import {
  addDirectory,
  addFiles,
  clearItems,
  copyText,
  inspectItem,
  removeItem,
  saveTextFile,
  selectItem,
  setView,
  useStore,
} from '../store';
import type { Item } from '../store';
import { canAccessFiles, GROUP_CLASS } from '../../env';
import { formatBytes, toDisplayText } from '../../codec/bytes';
import { previewClean } from '../../clean/run';
import { summarizePlan } from '../../clean/plan';
import { summarizeXmp } from '../../codec/xmp';
import { inspectionToJson } from '../../trace/report';
import type { BlockVerdict, ComfyNode, ExifField, GenParams, MetaBlock } from '../../model/types';

/** 元数据分组的显示名 */
const GROUP_LABEL: Record<string, string> = {
  generator: '生成参数',
  exif: 'EXIF',
  xmp: 'XMP',
  icc: 'ICC',
  c2pa: '来源凭证',
  text: '文本',
  structural: '结构',
  other: '其它',
};

type DetailTab = 'generation' | 'blocks' | 'exif' | 'xmp' | 'raw';

export function InspectView() {
  const state = useStore();
  const [tab, setTab] = useState<DetailTab>('generation');
  const [filter, setFilter] = useState('');

  const active = state.items.find((item) => item.key === state.activeKey) ?? null;

  if (!canAccessFiles) {
    return (
      <>
        <ViewBar title="检视" subtitle="看清楚一张图里到底有什么" />
        <NeedFiles />
      </>
    );
  }

  return (
    <>
      <ViewBar
        title="检视"
        subtitle={
          state.items.length > 0
            ? `已载入 ${state.items.length} 张 · 选中 ${active?.name ?? '—'}`
            : '看清楚一张图里到底有什么'
        }
        actions={
          <>
            <Button icon={<IconImage size={14} />} onClick={() => void addFiles()}>
              选择图片
            </Button>
            <Button icon={<IconFolder size={14} />} onClick={() => void addDirectory()}>
              选择目录
            </Button>
            {state.items.length > 0 ? (
              <Button
                variant="subtle"
                size="sm"
                icon={<IconTrash size={13} />}
                onClick={() => void clearItems()}
              >
                清空
              </Button>
            ) : null}
          </>
        }
      />

      {state.items.length === 0 ? (
        <Panel className="arttrace__panel--fill">
          <Empty
            icon={<IconSearch size={26} />}
            title="还没有载入图片"
            hint="选一批 ComfyUI / Stable Diffusion 的输出，或者直接选一整个目录。所有解析都在本机完成，图片不会被上传到任何地方。"
            action={
              <div className="arttrace__row">
                <Button variant="primary" icon={<IconImage size={14} />} onClick={() => void addFiles()}>
                  选择图片
                </Button>
                <Button icon={<IconFolder size={14} />} onClick={() => void addDirectory()}>
                  选择目录
                </Button>
              </div>
            }
          />
        </Panel>
      ) : (
        <div className="arttrace__split">
          <ItemList items={state.items} activeKey={state.activeKey} />
          <div className="arttrace__col">
            {active ? (
              <Inspector
                item={active}
                tab={tab}
                onTab={setTab}
                filter={filter}
                onFilter={setFilter}
              />
            ) : (
              <Panel className="arttrace__panel--fill">
                <Empty title="从左边选一张图" hint="选中之后这里会显示它的生成参数、全部元数据块、EXIF 与 XMP。" />
              </Panel>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// 左栏：文件列表
// ============================================================

function ItemList({ items, activeKey }: { items: Item[]; activeKey: string | null }) {
  const [query, setQuery] = useState('');
  const shown = query.trim()
    ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  return (
    <Panel
      className="arttrace__panel--fill"
      title="文件"
      actions={
        <TextInput value={query} onChange={setQuery} placeholder="筛选文件名" />
      }
      flush
    >
      <Scroll style={{ padding: 10 }}>
        {shown.length === 0 ? (
          <p className="arttrace__faint" style={{ padding: '18px 4px', textAlign: 'center' }}>
            没有匹配「{query}」的文件
          </p>
        ) : (
          <div className="arttrace__stack arttrace__stack--tight">
            {shown.map((item) => (
              <ItemRow key={item.key} item={item} selected={item.key === activeKey} />
            ))}
          </div>
        )}
      </Scroll>
    </Panel>
  );
}

/**
 * 三档痕迹结论的徽标。
 *
 * 单独一个组件而不是三处各写一段条件：这是同一个判断，而它在列表行、详情页与
 * 批量队列里都要出现 —— 三处各写一遍必然会出现"有一处忘了改"的版本。
 */
function VerdictTag({ verdict }: { verdict: BlockVerdict | null }) {
  if (verdict === 'traces') {
    return (
      <Tag className="arttrace__tag--generator" title="含生成参数 / EXIF / XMP / 来源凭证">
        有痕迹
      </Tag>
    );
  }
  if (verdict === 'annotated') {
    return (
      <Tag className="arttrace__tag--text" title="只有文本块（作者、版权、软件署名一类）">
        仅标注
      </Tag>
    );
  }
  return (
    <Tag className="arttrace__tag--good" title="没有任何元数据块">
      干净
    </Tag>
  );
}

function ItemRow({ item, selected }: { item: Item; selected: boolean }) {
  // 结论来自解析层（`analyze()` 算好放进 `InspectResult.verdict`），**不在这里重算**。
  // 重算一遍就会与 `auditBlocks` 的判据漂开，而"哪一类块算痕迹"已经有三个地方要用。
  const verdict = item.inspect?.verdict ?? null;

  return (
    <div
      className={cx('arttrace__thumb', selected && 'is-selected')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 7 }}
      role="button"
      tabIndex={0}
      onClick={() => selectItem(item.key)}
      onKeyDown={(event: { key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') selectItem(item.key);
      }}
      title={item.name}
    >
      <img className="arttrace__mini" src={item.url} alt="" loading="lazy" />
      <span className="arttrace__grow" style={{ minWidth: 0 }}>
        <span className="arttrace__thumb-name" style={{ display: 'block' }}>
          {item.name}
        </span>
        <span className="arttrace__thumb-sub">
          {formatBytes(item.bytes)}
          {item.state === 'loading' ? ' · 解析中…' : null}
          {item.inspect?.generation ? ` · ${item.inspect.generation.generator}` : null}
        </span>
      </span>

      {item.state === 'error' ? (
        <Tag className="arttrace__tag--bad" title={item.error}>
          失败
        </Tag>
      ) : item.state === 'ready' ? (
        <VerdictTag verdict={verdict} />
      ) : null}

      {item.trace && item.trace.copies > 0 ? <TraceBadge copies={item.trace.copies} /> : null}

      <Button
        variant="subtle"
        size="sm"
        title="移除"
        onClick={() => void removeItem(item.key)}
      >
        <IconTrash size={13} />
      </Button>
    </div>
  );
}

// ============================================================
// 右栏：详情
// ============================================================

function Inspector({
  item,
  tab,
  onTab,
  filter,
  onFilter,
}: {
  item: Item;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  filter: string;
  onFilter: (value: string) => void;
}) {
  if (item.state === 'error') {
    return (
      <Panel className="arttrace__panel--fill" title={`${item.name} 解析失败`}>
        <Banner tone="error">{item.error ?? '未知原因'}</Banner>
        <div className="arttrace__row">
          <Button
            icon={<IconRefresh size={13} />}
            onClick={() => void inspectItem(item)}
          >
            重试
          </Button>
          <Button variant="subtle" onClick={() => void removeItem(item.key)}>
            从列表移除
          </Button>
        </div>
      </Panel>
    );
  }

  if (item.state === 'loading' || !item.inspect) {
    return (
      <Panel className="arttrace__panel--fill" title={item.name}>
        <Loading text={`正在解析 ${item.name}…`} />
      </Panel>
    );
  }

  // 到了这里一定已经有解析结果。**剩下的部分拆成独立组件**：这里上面有两个
  // 提前返回，而 React 要求每次渲染的 Hook 调用顺序一致 —— 在同一个组件里
  // "提前返回之后再 useMemo" 会在 `error → ready` 的状态迁移时改变 Hook 数量，
  // 而那是一次真实的崩溃（"Rendered more hooks than during the previous render"）。
  return (
    <ReadyInspector
      item={item}
      tab={tab}
      onTab={onTab}
      filter={filter}
      onFilter={onFilter}
    />
  );
}

function ReadyInspector({
  item,
  tab,
  onTab,
  filter,
  onFilter,
}: {
  item: Item;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  filter: string;
  onFilter: (value: string) => void;
}) {
  const state = useStore();
  const inspect = item.inspect;

  const blocks = inspect ? inspect.blocks : [];
  // 统计条里**排除结构性块**：一张图的 `IDAT` 占 99% 的体积与九成的块数，
  // 把它算进去之后"生成参数 3.6 KB"这种真正有用的数字会被挤到看不见。
  const counts = useMemo(
    () => groupTally(blocks.filter((block) => block.group !== 'structural')),
    [blocks]
  );
  const planSummary = usePlanSummary(item);

  if (!inspect) return null;

  const tabs: Array<{ value: DetailTab; label: string; badge?: number }> = [
    { value: 'generation', label: '生成参数' },
    { value: 'blocks', label: '元数据块', badge: blocks.length },
    { value: 'exif', label: 'EXIF', badge: inspect.exif.length },
    { value: 'xmp', label: 'XMP' },
    { value: 'raw', label: '原始' },
  ];

  const previewUrl = item.url;

  return (
    <>
      <Panel
        title={item.name}
        actions={
          <>
            <Button
              size="sm"
              variant="subtle"
              icon={<IconRefresh size={13} />}
              onClick={() => void inspectItem(item)}
            >
              重新解析
            </Button>
            <Button
              size="sm"
              variant="subtle"
              icon={<IconCopy size={13} />}
              onClick={() => void copyText(inspect.sha256, 'SHA-256')}
            >
              复制哈希
            </Button>
            <Button
              size="sm"
              variant="subtle"
              icon={<IconDownload size={13} />}
              onClick={() =>
                void saveTextFile(
                  `${stemOf(item.name)}.inspect.json`,
                  inspectionToJson({
                    name: item.name,
                    sha256: inspect.sha256,
                    inspectedAt: Date.now(),
                    info: inspect.info,
                    generation: inspect.generation,
                    blocks: blocks.map((block) => ({
                      label: block.label,
                      group: block.group,
                      bytes: block.bytes,
                      text: block.text,
                    })),
                    exif: inspect.exif,
                    xmp: inspect.xmp,
                    trace: item.trace ?? null,
                  }),
                  '检视报告'
                )
              }
            >
              导出报告
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<IconSparkle size={13} />}
              onClick={() => setView('batch')}
            >
              去清理
            </Button>
          </>
        }
      >
        <div className="arttrace__split arttrace__split--wide-right" style={{ flex: 'none' }}>
          <div className="arttrace__preview">
            <img src={item.url} alt={item.name} />
          </div>
          <div className="arttrace__stack arttrace__stack--tight">
            <div className="arttrace__row arttrace__row--wrap">
              <Tag className="arttrace__tag--mono">{inspect.info.format.toUpperCase()}</Tag>
              <Tag>
                {inspect.info.width} × {inspect.info.height}
              </Tag>
              {inspect.info.bitDepth !== null ? (
                <Tag>{inspect.info.bitDepth} bit</Tag>
              ) : null}
              {inspect.info.colorModel ? <Tag>{inspect.info.colorModel}</Tag> : null}
              {inspect.info.interlaced ? <Tag>隔行</Tag> : null}
              {inspect.info.animated ? <Tag>{inspect.info.frames} 帧</Tag> : null}
              <Tag>{formatBytes(inspect.info.bytes)}</Tag>
              {item.trace && item.trace.copies > 0 ? (
                <TraceBadge copies={item.trace.copies} />
              ) : null}
              <VerdictTag verdict={inspect.verdict} />
            </div>

            <KeyValue
              label="SHA-256"
              mono
              title={inspect.sha256}
              value={`${inspect.sha256.slice(0, 24)}…`}
            />

            {/* 这一条是整页最要紧的结论，因此放在最上面而不是折叠起来。 */}
            {inspect.generation ? (
              <Banner tone="info">
                这张图带着 <strong>{inspect.generation.generator}</strong> 的生成参数。
                判定依据：{inspect.generation.evidence}
              </Banner>
            ) : (
              <Banner tone="success">
                没有识别出生成参数。可能是导出时已经被剥离过，也可能它本来就不是
                AI 生成工具的产物。
              </Banner>
            )}

            {inspect.c2pa.length > 0 ? (
              <Banner tone="warn">
                发现来源凭证（C2PA / Content Credentials）：{inspect.c2pa.join('、')}。
                它记录的是「谁在什么时候用什么工具处理过这张图」，通常是发布方加的。
              </Banner>
            ) : null}

            {!inspect.rewritable ? (
              <Banner tone="warn">
                这个容器不能被清理：{inspect.rewriteBlockedReason ?? '原因未知'}
              </Banner>
            ) : null}

            {planSummary ? (
              <div className="arttrace__row arttrace__row--wrap">
                <Tag className="arttrace__tag--structural">
                  按当前策略：将丢掉 {planSummary.dropped} 个块
                </Tag>
                {planSummary.hasGenerator ? (
                  <Tag className="arttrace__tag--generator">含生成参数</Tag>
                ) : null}
                <span className="arttrace__faint">
                  策略在「批量清理」页调整
                </span>
              </div>
            ) : null}

            <div className="arttrace__stats">
              {counts.slice(0, 4).map((entry) => (
                <Stat
                  key={entry.group}
                  value={entry.count}
                  label={`${GROUP_LABEL[entry.group] ?? entry.group} · ${formatBytes(entry.bytes)}`}
                />
              ))}
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="arttrace__panel--fill" flush>
        <div style={{ padding: '0 13px' }}>
          <Segmented value={tab} onChange={onTab} options={tabs.map((entry) => ({ value: entry.value, label: entry.label }))} />
        </div>
        <div className="arttrace__panel-body" style={{ flex: 1, minHeight: 0 }}>
          {tab === 'generation' ? <GenerationPane generation={inspect.generation} /> : null}
          {tab === 'blocks' ? (
            <BlocksPane blocks={blocks} filter={filter} onFilter={onFilter} />
          ) : null}
          {tab === 'exif' ? <ExifPane fields={inspect.exif} /> : null}
          {tab === 'xmp' ? <XmpPane xmp={inspect.xmp} /> : null}
          {tab === 'raw' ? (
            <CodeBlock
              text={JSON.stringify(inspect, null, 2)}
              onCopy={(text) => void copyText(text, '检视结果')}
              maxHeight={420}
            />
          ) : null}
        </div>
      </Panel>
    </>
  );
}

/** 用当前策略对**选中那一张**试算一次，给出一句"会丢掉什么" */
function usePlanSummary(item: Item): { dropped: number; hasGenerator: boolean } | null {
  const state = useStore();
  return useMemo(() => {
    const bytes = state.activeBytes;
    if (!bytes || state.activeKey !== item.key) return null;
    try {
      const result = previewClean(bytes, state.prefs.clean);
      if (!result.ok) return null;
      const summary = summarizePlan(result.plan);
      return { dropped: summary.dropped, hasGenerator: summary.hasGenerator };
    } catch {
      // 试算失败不该影响检视本身 —— 它只是一个附加结论。
      return null;
    }
  }, [state.activeBytes, state.activeKey, state.prefs.clean, item.key]);
}

// ============================================================
// 生成参数
// ============================================================

function GenerationPane({ generation }: { generation: GenParams | null }) {
  if (!generation) {
    return (
      <Empty
        icon={<IconSearch size={22} />}
        title="没有生成参数"
        hint="这张图里没有可识别的生成器元数据。它可能已经被剥离过，也可能来自一个本插件还不认识的工具 —— 去「元数据块」看看原始的块列表。"
      />
    );
  }

  const chips: Array<{ key: string; value: string }> = [];
  const push = (key: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    chips.push({ key, value: String(value) });
  };
  push('步数', generation.steps);
  push('CFG', generation.cfg);
  push('采样器', generation.sampler);
  push('调度器', generation.scheduler);
  push('随机种子', generation.seed);
  push('模型', generation.model);
  push('模型哈希', generation.modelHash);
  push('VAE', generation.vae);
  push('CLIP skip', generation.clipSkip);
  push('尺寸', generation.width && generation.height ? `${generation.width} × ${generation.height}` : null);
  push('降噪', generation.denoising);

  return (
    <Scroll className="arttrace__stack">
      <div className="arttrace__row arttrace__row--wrap">
        <Tag className="arttrace__tag--generator">{generation.generator}</Tag>
        <span className="arttrace__faint">{generation.evidence}</span>
      </div>

      {chips.length > 0 ? (
        <div className="arttrace__chips">
          {chips.map((chip) => (
            <div className="arttrace__chip" key={chip.key}>
              <span className="arttrace__chip-key">{chip.key}</span>
              <span className="arttrace__chip-value" title={chip.value}>
                {chip.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {generation.loras.length > 0 ? (
        <div className="arttrace__stack arttrace__stack--tight">
          <span className="arttrace__label">LoRA（按从底模到采样器的顺序）</span>
          <div className="arttrace__row arttrace__row--wrap">
            {generation.loras.map((lora) => (
              <Tag key={lora} className="arttrace__tag--xmp">
                {lora}
              </Tag>
            ))}
          </div>
        </div>
      ) : null}

      {generation.controlNets.length > 0 ? (
        <div className="arttrace__stack arttrace__stack--tight">
          <span className="arttrace__label">ControlNet</span>
          <div className="arttrace__row arttrace__row--wrap">
            {generation.controlNets.map((item) => (
              <Tag key={item} className="arttrace__tag--exif">
                {item}
              </Tag>
            ))}
          </div>
        </div>
      ) : null}

      <PromptPane label="正向提示词" text={generation.prompt} />
      <PromptPane label="负向提示词" text={generation.negativePrompt} />

      {generation.workflow && generation.workflow.highlights.length > 0 ? (
        <Panel title="工作流要点" actions={<span className="arttrace__faint">{generation.workflow.nodes.length} 个节点</span>}>
          <div className="arttrace__chips">
            {generation.workflow.highlights.map((entry) => (
              <div className="arttrace__chip" key={`${entry.label}-${entry.value}`}>
                <span className="arttrace__chip-key">{entry.label}</span>
                <span className="arttrace__chip-value" title={entry.value}>
                  {entry.value}
                </span>
              </div>
            ))}
          </div>
          <WorkflowNodes nodes={generation.workflow.nodes} />
          <CodeBlock
            text={generation.workflow.raw}
            onCopy={(text) => void copyText(text, '工作流 JSON')}
            maxHeight={200}
          />
        </Panel>
      ) : null}

      {generation.extras.length > 0 ? (
        <Panel title={`其它参数（${generation.extras.length}）`} flush>
          <Scroll style={{ maxHeight: 240 }}>
            <Table
              dense
              head={
                <tr>
                  <th style={{ width: '34%' }}>键</th>
                  <th>值</th>
                </tr>
              }
            >
              {generation.extras.map((entry, index) => (
                <tr key={`${entry.key}-${index}`}>
                  <td className="arttrace__muted">{entry.key}</td>
                  <td>{entry.value}</td>
                </tr>
              ))}
            </Table>
          </Scroll>
        </Panel>
      ) : null}

      <Panel title="判定所依据的原文">
        <CodeBlock
          text={generation.raw}
          onCopy={(text) => void copyText(text, '生成参数原文')}
          maxHeight={220}
        />
      </Panel>
    </Scroll>
  );
}

function PromptPane({ label, text }: { label: string; text: string | null }) {
  if (!text || text.trim().length === 0) {
    return (
      <Panel title={label}>
        <p className="arttrace__faint">（空）</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={label}
      actions={
        <>
          <span className="arttrace__faint">{text.length} 字符</span>
          <Button
            size="sm"
            variant="subtle"
            icon={<IconCopy size={13} />}
            onClick={() => void copyText(text, label)}
          >
            复制
          </Button>
        </>
      }
    >
      <div className="arttrace__prompt">{text}</div>
    </Panel>
  );
}

function WorkflowNodes({ nodes }: { nodes: ComfyNode[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter(
      (node) =>
        node.type.toLowerCase().includes(needle) ||
        node.title.toLowerCase().includes(needle) ||
        node.id.includes(needle)
    );
  }, [nodes, query]);

  return (
    <div className="arttrace__stack arttrace__stack--tight">
      <div className="arttrace__row">
        <span className="arttrace__grow">
          <TextInput value={query} onChange={setQuery} placeholder="筛选节点（类型 / 标题 / id）" />
        </span>
      </div>
      <Scroll style={{ maxHeight: 220 }}>
        <Table
          dense
          head={
            <tr>
              <th style={{ width: 54 }}>#</th>
              <th style={{ width: '30%' }}>类型</th>
              <th>标题</th>
            </tr>
          }
        >
          {filtered.map((node) => (
            <React.Fragment key={node.id}>
              <tr
                className="arttrace__table-actions is-clickable"
                onClick={() => setOpen(open === node.id ? null : node.id)}
              >
                <td className="arttrace__mono">{node.id}</td>
                <td>{node.type}</td>
                <td>{node.title}</td>
              </tr>
              {open === node.id ? (
                <tr>
                  <td />
                  <td colSpan={2}>
                    <WorkflowNodeInputs node={node} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </Table>
      </Scroll>
    </div>
  );
}

function WorkflowNodeInputs({
  node,
}: {
  node: { inputs: Array<{ name: string; value: string; from: string | null }>; outputs: string[] };
}) {
  if (node.inputs.length === 0) {
    return <p className="arttrace__faint">这个节点没有可显示的输入。</p>;
  }
  return (
    <div className="arttrace__stack arttrace__stack--tight">
      {node.inputs.map((input, index) => (
        <div className="arttrace__kv" key={`${input.name}-${index}`}>
          <span className="arttrace__kv-key">{input.name}</span>
          <span className="arttrace__kv-value">
            <span className="arttrace__mono">{toDisplayText(input.value, 220)}</span>
            {input.from ? <Tag className="arttrace__tag--mono">← #{input.from}</Tag> : null}
          </span>
        </div>
      ))}
      {node.outputs.length > 0 ? (
        <div className="arttrace__row arttrace__row--wrap">
          <span className="arttrace__faint">输出到：</span>
          {node.outputs.map((target) => (
            <Tag key={target} className="arttrace__tag--mono">
              #{target}
            </Tag>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================
// 元数据块
// ============================================================

function BlocksPane({
  blocks,
  filter,
  onFilter,
}: {
  blocks: MetaBlock[];
  filter: string;
  onFilter: (value: string) => void;
}) {
  /**
   * 查看范围。**默认隐藏结构性块**，因为它不是元数据。
   *
   * 这不是优化，是必要的：一张 4.5 MB 的 ComfyUI PNG 有 70 个 `IDAT` 块，
   * 而真正的元数据只有 2 个。全都列出来会让表格被 70 行 `IDAT` 灌满，
   * 用户要滚动很久才能看到那两行有用的 —— 而"看不到重点"正是这类工具最常见的失败。
   */
  const [scope, setScope] = useState<'meta' | 'removable' | 'all'>('meta');

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return blocks.filter((block) => {
      if (scope === 'meta' && block.group === 'structural') return false;
      if (scope === 'removable' && !block.removable) return false;
      if (!needle) return true;
      return (
        block.label.toLowerCase().includes(needle) ||
        block.text.toLowerCase().includes(needle) ||
        block.group.includes(needle)
      );
    });
  }, [blocks, filter, scope]);

  const hiddenStructural = blocks.filter((block) => block.group === 'structural').length;

  return (
    <div className="arttrace__stack" style={{ minHeight: 0, flex: 1 }}>
      <div className="arttrace__row arttrace__row--wrap">
        <span className="arttrace__grow">
          <TextInput value={filter} onChange={onFilter} placeholder="搜索块的名字或内容" />
        </span>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'meta', label: '元数据' },
            { value: 'removable', label: '可抹除' },
            { value: 'all', label: '全部' },
          ]}
        />
        <span className="arttrace__faint">
          {shown.length} / {blocks.length}
        </span>
      </div>

      {scope === 'meta' && hiddenStructural > 0 ? (
        <p className="arttrace__hint">
          已隐藏 {hiddenStructural} 个结构性块（`IDAT` / `IHDR` / `IEND` 之类）。
          它们是像素数据与容器骨架，不是元数据，也不会被清理动到 —— 想看就切到「全部」。
        </p>
      ) : null}

      <Scroll style={{ flex: 1, minHeight: 0 }}>
        <Table
          dense
          head={
            <tr>
              <th style={{ width: '30%' }}>块</th>
              <th style={{ width: 74 }}>类型</th>
              <th style={{ width: 68 }} className="arttrace__table-num">
                体积
              </th>
              <th style={{ width: 68 }}>清理</th>
              <th>内容</th>
            </tr>
          }
        >
          {shown.map((block) => (
            <tr key={block.id}>
              <td className="arttrace__mono">{block.label}</td>
              <td>
                <Tag className={GROUP_CLASS[block.group] ?? 'arttrace__tag'}>
                  {GROUP_LABEL[block.group] ?? block.group}
                </Tag>
              </td>
              <td className="arttrace__table-num">{formatBytes(block.bytes)}</td>
              <td>
                {block.removable ? (
                  <span className="arttrace__muted">会丢</span>
                ) : (
                  <span className="arttrace__faint">保留</span>
                )}
              </td>
              <td className="arttrace__muted">{toDisplayText(block.text, 260)}</td>
            </tr>
          ))}
        </Table>
      </Scroll>

      <p className="arttrace__hint">
        「会丢 / 保留」是按**当前清理策略**算出来的默认值，可以在「批量清理」页逐项调整。
        ICC 色彩描述文件与方向信息默认保留 —— 丢掉它们不是"更干净"，是"图变色或转向"。
      </p>
    </div>
  );
}

// ============================================================
// EXIF / XMP
// ============================================================

function ExifPane({ fields }: { fields: ExifField[] }) {
  if (fields.length === 0) {
    return (
      <Empty
        icon={<IconCheck size={22} />}
        title="没有 EXIF"
        hint="这张图里没有拍摄信息。对 AI 生成的图来说这是正常的 —— 生成工具通常不写 EXIF。"
      />
    );
  }
  return (
    <Scroll style={{ flex: 1, minHeight: 0 }}>
      <Table
        dense
        head={
          <tr>
            <th style={{ width: 66 }}>分组</th>
            <th style={{ width: '30%' }}>标签</th>
            <th>值</th>
            <th style={{ width: 92 }}>原始类型</th>
          </tr>
        }
      >
        {fields.map((field, index) => (
          <tr key={`${field.group}-${field.tag}-${index}`}>
            <td className="arttrace__faint">{field.group}</td>
            <td>{field.name}</td>
            <td>{field.value}</td>
            <td className="arttrace__mono arttrace__faint">{field.raw}</td>
          </tr>
        ))}
      </Table>
    </Scroll>
  );
}

function XmpPane({ xmp }: { xmp: string | null }) {
  if (!xmp || xmp.trim().length === 0) {
    return (
      <Empty
        icon={<IconCheck size={22} />}
        title="没有 XMP"
        hint="XMP 是 Adobe 系工具写的一整包元数据（作者、编辑历史、色彩标记）。这张图里没有。"
      />
    );
  }

  const fields = useMemo(() => summarizeXmpSafe(xmp), [xmp]);

  return (
    <Scroll className="arttrace__stack">
      {fields.length > 0 ? (
        <Panel title="常用字段" flush>
          <div style={{ padding: 13 }}>
            {fields.map((entry, index) => (
              <KeyValue key={`${entry.key}-${index}`} label={entry.key} value={entry.value} />
            ))}
          </div>
        </Panel>
      ) : null}
      <Panel title="XMP 原文">
        <CodeBlock
          text={xmp}
          onCopy={(text) => void copyText(text, 'XMP')}
          maxHeight={300}
        />
      </Panel>
    </Scroll>
  );
}

/** XMP 的字段抽取失败不该让整页看不了 —— 它只是一段 XML，畸形是常事 */
function summarizeXmpSafe(xmp: string): Array<{ key: string; value: string }> {
  try {
    return summarizeXmp(xmp);
  } catch {
    return [];
  }
}

// ============================================================
// 小工具
// ============================================================

function groupTally(blocks: MetaBlock[]): Array<{ group: string; count: number; bytes: number }> {
  const tally = new Map<string, { count: number; bytes: number }>();
  for (const block of blocks) {
    const entry = tally.get(block.group) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += block.bytes;
    tally.set(block.group, entry);
  }
  return [...tally.entries()]
    .map(([group, entry]) => ({ group, count: entry.count, bytes: entry.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

function stemOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(0, at) : name;
}
