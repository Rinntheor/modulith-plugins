// src/art-trace/ui/views/ledger.tsx
//
// 追踪台账：谁在什么时候拿到了哪一份。
//
// ============================================================
// 这一页真正要回答的问题
// ============================================================
//
// 只有一个：**拿到一张流出的图，查出当初发给了谁**。因此这一页的排版按那个动作的
// 顺序来 —— 先把「写入检查」放在最上面（那是你手上拿着图的时候要点的第一个按钮），
// 再是统计与筛选，最后才是逐条的列表。
//
// ============================================================
// 两条不该被省掉的细节
// ============================================================
//
// 1. **搜索要防抖。** 每一次改动查询条件都会真的去查一次 SQLite（`setLedgerQuery`
//    会立刻 `refreshLedger()`）。不防抖的话"糯米"两个字会触发十几次查询，而台账
//    一万条以后每次都是几十毫秒 —— 用户看到的是输入框一顿一顿的。
// 2. **删除与清空要二次确认。** 沙箱里 `window.confirm` 的返回值不可靠，因此自己画。
//    台账的删除是不可撤销的：它是"谁拿过什么"的唯一记录。

import type { ReactNode } from 'react';
import { React, useEffect, useMemo, useState } from '../../env';
import {
  Banner,
  Button,
  Empty,
  Loading,
  Panel,
  Scroll,
  Segmented,
  Select,
  Stat,
  Table,
  Tag,
  TextInput,
} from '../components';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconEye,
  IconInfo,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '../icons';
import {
  clearProbe,
  probeTrace,
  refreshLedger,
  removeLedgerRow,
  saveTextFile,
  setLedgerQuery,
  useStore,
  wipeLedger,
} from '../store';
import type { LedgerQuery } from '../../trace/ledger';
import { toCsv, toManifestJson, suggestExportName } from '../../trace/report';
import { formatStamp } from '../../trace/payload';
import { formatBytes } from '../../codec/bytes';
import type { LedgerRecord } from '../../model/types';

/** `yyyyMMdd` → `2026-10-07`。认不出形状就原样显示，总好过显示「无效」 */
function issuedText(issued: string): string {
  if (!/^\d{8}$/.test(issued)) return issued || '—';
  return `${issued.slice(0, 4)}-${issued.slice(4, 6)}-${issued.slice(6, 8)}`;
}

/**
 * 一行体积变化的说明。
 *
 * 清理本身多半会让文件变小（丢了块），但打了水印之后又会变大 —— 因此这里显示的
 * 是**净变化**，而不是"省了多少"。源体积为 0（老记录或读不到）时不去硬算一个百分比。
 */
function deltaText(row: LedgerRecord): string {
  if (!Number.isFinite(row.beforeBytes) || row.beforeBytes <= 0) {
    return formatBytes(row.afterBytes);
  }
  const percent = ((row.afterBytes - row.beforeBytes) / row.beforeBytes) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/** 一笔的筛选条件用一句人话描述。导出的 JSON 里带上它，半年后才看得懂这份清单是什么 */
function describeFilter(query: LedgerQuery): string {
  const parts: string[] = [];
  if ((query.search ?? '').trim()) parts.push(`搜索「${query.search?.trim()}」`);
  if ((query.issued ?? '').trim()) parts.push(`发放日期 ${issuedText(query.issued ?? '')}`);
  parts.push(query.order === 'oldest' ? '按记录时间从早到晚' : '按记录时间从新到旧');
  return parts.join('；');
}

/** 导出文件名里用的日期时间戳，形如 `20261007-1432` */
function exportStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function LedgerView() {
  const state = useStore();
  const ledger = state.ledger;
  const query = ledger.query;

  // 搜索框是**受控但本地**的：立刻回显用户敲的字，但只有停下 300ms 才去查库。
  const [search, setSearch] = useState(query.search ?? '');
  const [wipeArmed, setWipeArmed] = useState(false);
  const [removeArmed, setRemoveArmed] = useState<number | null>(null);

  useEffect(() => {
    if ((query.search ?? '') === search) return;
    const timer = setTimeout(() => {
      setLedgerQuery({ search, offset: 0 });
    }, 300);
    // 清理函数是这条防抖的全部意义所在：不 clear 的话，敲十下就会排队十个定时器，
    // 于是最后一次输入之后还会陆续发出十次查询。
    return () => clearTimeout(timer);
  }, [search, query.search]);

  const stats = ledger.stats;
  const total = ledger.total;
  const pageSize = Math.max(1, state.prefs.pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.floor((query.offset ?? 0) / pageSize) + 1);

  /**
   * 发放日期的选项。
   *
   * 取舍：**从当前这一页的 `rows` 里现取**，而不是异步调 `issuedDates()`。
   * 好处是不多一次查询与一段加载态；代价是"只在别的页出现过的日期"不在下拉里 ——
   * 而那种情况可以直接用上面的搜索框（它也能匹配日期所在的那几条记录的关键字段）。
   * 筛选本身仍然是准确的：它是在数据库里按 `issued = ?` 做的，不是在前端过滤 rows。
   */
  const issuedOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const row of ledger.rows) if (row.issued) seen.add(row.issued);
    // 当前选中的那个日期必须出现在选项里 —— 否则 `<select>` 找不到匹配的 option，
    // 会退回显示第一个（「全部」），于是筛着筛着看起来像"筛选自己失效了"。
    if ((query.issued ?? '').trim()) seen.add(query.issued ?? '');
    return [...seen]
      .sort((a, b) => b.localeCompare(a))
      .map((value) => ({ value, label: issuedText(value) }));
  }, [ledger.rows, query.issued]);

  // ============================================================
  // 导出
  // ============================================================
  //
  // 导出的是**当前这一页**的 rows，因此文件名与 JSON 里的 filter 都写清楚条件 ——
  // 一份"看不出来筛了什么"的 CSV 会在几天后被当成全量数据用。

  async function exportCsv(): Promise<void> {
    const text = toCsv(ledger.rows);
    await saveTextFile(suggestExportName('art-trace-ledger', Date.now(), 'csv'), text, '台账 CSV');
  }

  async function exportJson(): Promise<void> {
    const text = toManifestJson(ledger.rows, {
      exportedAt: Date.now(),
      schema: 1,
      filter: `${describeFilter(query)}；共 ${total} 条，本页 ${ledger.rows.length} 条`,
    });
    await saveTextFile(suggestExportName('art-trace-ledger', Date.now(), 'json'), text, '台账 JSON');
  }

  const probe = state.probe;

  return (
    <div className="arttrace__col">
      {/* ================= 顶部：标题与动作 ================= */}
      <div className="arttrace__bar">
        <span className="arttrace__bar-title">追踪台账</span>
        <span className="arttrace__bar-sub">
          共 {total} 条 · 第 {page} / {pageCount} 页
        </span>
        <span className="arttrace__bar-spacer" />
        <Button
          size="sm"
          icon={<IconEye size={13} />}
          onClick={() => void probeTrace()}
          disabled={!!state.busy || probe?.state === 'loading'}
        >
          写入检查
        </Button>
        <Button
          size="sm"
          icon={<IconDownload size={13} />}
          onClick={() => void exportCsv()}
          disabled={ledger.rows.length === 0}
        >
          导出 CSV
        </Button>
        <Button
          size="sm"
          icon={<IconDownload size={13} />}
          onClick={() => void exportJson()}
          disabled={ledger.rows.length === 0}
        >
          导出 JSON
        </Button>
        <Button
          size="sm"
          variant="subtle"
          icon={<IconRefresh size={13} />}
          onClick={() => void refreshLedger()}
          disabled={ledger.loading}
        >
          刷新
        </Button>
      </div>

      <Scroll className="arttrace__col">
        {/* ================= 写入检查 ================= */}
        {probe ? (
          <Panel
            title={`写入检查${probe.name ? ` · ${probe.name}` : ''}`}
            actions={
              <Button size="sm" variant="subtle" icon={<IconX size={12} />} onClick={clearProbe}>
                关闭
              </Button>
            }
          >
            {probe.state === 'loading' ? (
              <Loading text="正在读像素最低位里的载荷…" />
            ) : probe.state === 'error' ? (
              <Banner tone="error">读这张图失败了：{probe.error ?? '未知原因'}</Banner>
            ) : probe.payload === null ? (
              <Banner tone="warn">
                没有读到隐形水印。这张图可能没有打过水印，也可能经过了有损转码
                （JPEG/WebP 重编码会冲掉最低位）。想确认是哪种情况，可以用「检视」页看
                它的元数据里有没有 art-trace 那一行。
              </Banner>
            ) : (
              <>
                <Banner tone={probe.matches.length > 0 ? 'success' : 'info'}>
                  读到了载荷，完整重复 {probe.payload.copies} 份。
                  {probe.matches.length > 0
                    ? '台账里有这个编号的记录，下面就是当初发出去的那几份。'
                    : '但台账里没有这个编号的记录 —— 它可能是别的工具写的水印，也可能是台账被清空过。'}
                </Banner>

                <div className="arttrace__row arttrace__row--wrap">
                  <Tag className="arttrace__tag--mono">{probe.payload.text}</Tag>
                </div>

                <span className="arttrace__label">载荷字段</span>
                <Scroll style={{ maxHeight: 260 }}>
                  {probe.payload.fields.map((field, index) => (
                    <div className="arttrace__kv" key={`${field.key}-${index}`}>
                      <span className="arttrace__kv-key">{field.key}</span>
                      <span className="arttrace__kv-value is-mono">{field.value || '（空）'}</span>
                    </div>
                  ))}
                </Scroll>

                <span className="arttrace__label">台账里匹配到的记录</span>
                {probe.matches.length === 0 ? (
                  <Banner tone="warn">
                    读到了编号，但台账里没有这个编号的记录。台账可能被清空过，
                    或者这张图来自另一个插件的实例。
                  </Banner>
                ) : (
                  <Table
                    dense
                    head={
                      <tr>
                        <th>追踪编号</th>
                        <th>作者</th>
                        <th>平台</th>
                        <th>订单</th>
                        <th>买家</th>
                        <th>发放日期</th>
                        <th>记录时间</th>
                      </tr>
                    }
                  >
                    {probe.matches.map((record) => (
                      <tr key={record.id}>
                        <td className="arttrace__mono">{record.traceId}</td>
                        <td>{record.author || '—'}</td>
                        <td>{record.platform || '—'}</td>
                        <td>{record.order || '—'}</td>
                        <td>{record.buyer || '—'}</td>
                        <td>{issuedText(record.issued)}</td>
                        <td className="arttrace__nowrap">{formatStamp(record.createdAt)}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </>
            )}
          </Panel>
        ) : (
          <Banner tone="info">
            拿到一张流出的图时，点右上角的「写入检查」选它 —— 插件会读像素最低位里的
            隐形水印，并直接告出当初是哪一条台账记录发出的。它只读这张图，不留任何改动。
          </Banner>
        )}

        {/* ================= 统计 ================= */}
        <div className="arttrace__stats">
          <Stat value={stats ? stats.records : '—'} label="台账记录数" />
          <Stat value={stats ? stats.distinctIds : '—'} label="不同追踪编号" />
          <Stat
            value={stats ? formatBytes(stats.totalAfterBytes) : '—'}
            label="成品总体积"
          />
          <Stat value={stats ? formatStamp(stats.lastAt) : '—'} label="最近一条记录" />
          <Stat
            value={`${pageSize} 条`}
            label={`每页（共 ${pageCount} 页）`}
          />
        </div>

        {stats && stats.records !== stats.distinctIds ? (
          <Banner tone="error">
            <Tag className="arttrace__tag--bad">编号被重复发放</Tag>{' '}
            有编号发给了不止一份（{stats.records} 条记录只有 {stats.distinctIds} 个不同编号）。
            这是台账最要紧的异常：同一个编号对应两个人时，「当初发给了谁」这个问题的答案就不再唯一。
            常见原因是把同一张成品复制给了多位买家，或者在两台机器上并行跑批量
            （序号是各自持久化的，隔开的两份存储不会互相查重）。
          </Banner>
        ) : null}

        {/* ================= 筛选 ================= */}
        <Panel
          title="筛选"
          actions={
            <span className="arttrace__faint">
              当前：{describeFilter(query)}；共 {total} 条
            </span>
          }
        >
          <div className="arttrace__row arttrace__row--wrap">
            <span className="arttrace__grow arttrace__row">
              <IconSearch size={14} />
              <span className="arttrace__grow">
                <TextInput
                  value={search}
                  onChange={setSearch}
                  placeholder="编号 / 输出文件名 / 作者 / 平台 / 订单 / 买家 / 载荷"
                />
              </span>
            </span>
            <span className="arttrace__muted arttrace__nowrap">发放日期</span>
            <Select
              value={query.issued ?? ''}
              onChange={(value) => setLedgerQuery({ issued: value || undefined, offset: 0 })}
              options={[{ value: '', label: '全部' }, ...issuedOptions]}
            />
            <Segmented
              value={query.order ?? 'newest'}
              onChange={(value) => setLedgerQuery({ order: value, offset: 0 })}
              options={[
                { value: 'newest', label: '最新' },
                { value: 'oldest', label: '最早' },
              ]}
            />
            {search.trim().length > 0 && (query.search ?? '') !== search ? (
              <span className="arttrace__hint">正在等你停下…</span>
            ) : null}
          </div>
          <span className="arttrace__hint">
            日期下拉只列出**这一页里出现过**的发放日期；要在全部历史里按日期找，
            用上面的搜索框搜编号或文件名更快。
          </span>
        </Panel>

        {/* ================= 列表 ================= */}
        <Panel
          title="记录"
          flush
          className="arttrace__panel--fill"
          actions={
            <span className="arttrace__faint">
              第 {page} / {pageCount} 页
            </span>
          }
        >
          {ledger.loading && ledger.rows.length === 0 ? (
            <Loading text="正在读取台账…" />
          ) : ledger.rows.length === 0 ? (
            <Empty
              icon={<IconInfo size={26} />}
              title="台账是空的"
              hint="处理一批图片之后，每一份成品都会在这里留下一条记录 —— 谁在什么时候拿到了哪一份。"
              action={
                <Button
                  size="sm"
                  variant="subtle"
                  icon={<IconRefresh size={12} />}
                  onClick={() => void refreshLedger()}
                >
                  重新读取
                </Button>
              }
            />
          ) : (
            <>
              <Table
                head={
                  <tr>
                    <th>追踪编号</th>
                    <th>输出文件</th>
                    <th>作者</th>
                    <th>平台</th>
                    <th>订单 / 买家</th>
                    <th>发放日期</th>
                    <th>记录时间</th>
                    <th className="arttrace__table-num">体积变化</th>
                    <th />
                  </tr>
                }
              >
                {ledger.rows.map((row) => {
                  const delta = deltaText(row);
                  return (
                    <tr key={row.id}>
                      <td>
                        <Tag className="arttrace__tag--mono" title={row.traceId}>
                          {row.traceId}
                        </Tag>
                      </td>
                      <td>
                        <div className="arttrace__nowrap" title={`${row.outputDir}/${row.outputName}`}>
                          {row.outputName}
                        </div>
                        <div className="arttrace__faint arttrace__nowrap">
                          源：{row.sourceName || '—'}
                        </div>
                      </td>
                      <td>{row.author || '—'}</td>
                      <td>{row.platform || '—'}</td>
                      <td>
                        <div>{row.order || '—'}</div>
                        <div className="arttrace__muted">{row.buyer || '—'}</div>
                      </td>
                      <td className="arttrace__nowrap">{issuedText(row.issued)}</td>
                      <td className="arttrace__nowrap">{formatStamp(row.createdAt)}</td>
                      <td className="arttrace__table-num" title={`${formatBytes(row.beforeBytes)} → ${formatBytes(row.afterBytes)}`}>
                        {delta}
                      </td>
                      <td>
                        <div className="arttrace__table-actions">
                          {removeArmed === row.id ? (
                            <>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => {
                                  setRemoveArmed(null);
                                  void removeLedgerRow(row.id);
                                }}
                              >
                                确认删除
                              </Button>
                              <Button
                                size="sm"
                                variant="subtle"
                                onClick={() => setRemoveArmed(null)}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="subtle"
                              icon={<IconTrash size={12} />}
                              title="删掉这一条记录（不可撤销）"
                              onClick={() => setRemoveArmed(row.id)}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Table>

              <div className="arttrace__row arttrace__row--between" style={{ padding: '8px 10px' }}>
                <span className="arttrace__muted">
                  第 {page} / {pageCount} 页 · 共 {total} 条
                </span>
                <span className="arttrace__row">
                  <Button
                    size="sm"
                    variant="subtle"
                    icon={<IconChevronLeft size={12} />}
                    disabled={page <= 1 || ledger.loading}
                    onClick={() =>
                      setLedgerQuery({ offset: Math.max(0, (page - 2) * pageSize) })
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={page >= pageCount || ledger.loading}
                    onClick={() => setLedgerQuery({ offset: page * pageSize })}
                  >
                    下一页
                  </Button>
                  <IconChevronRight size={12} />
                </span>
              </div>
            </>
          )}
        </Panel>

        {/* ================= 危险区 ================= */}
        <Panel
          title="危险区"
          actions={<span className="arttrace__faint">不可撤销</span>}
        >
          <span className="arttrace__hint">
            清空之后，「这张图当初发给了谁」就再也查不出来了 —— 这正是台账存在的全部理由。
            想留档就先导出 CSV 或 JSON：导出的文件在输出目录里，清空台账不会动它们。
          </span>
          <div className="arttrace__row">
            {wipeArmed ? (
              <>
                <Button
                  variant="danger"
                  icon={<IconTrash size={13} />}
                  onClick={() => {
                    setWipeArmed(false);
                    void wipeLedger();
                  }}
                  disabled={ledger.loading}
                >
                  确认清空台账（{total} 条）
                </Button>
                <Button variant="subtle" onClick={() => setWipeArmed(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="danger"
                icon={<IconTrash size={12} />}
                onClick={() => setWipeArmed(true)}
                disabled={total === 0 || ledger.loading}
              >
                清空台账
              </Button>
            )}
          </div>
        </Panel>
      </Scroll>
    </div>
  );
}
