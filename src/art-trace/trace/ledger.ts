// src/art-trace/trace/ledger.ts
//
// 追踪台账：谁在什么时候拿到过哪一份副本。
//
// ============================================================
// 为什么用 SQLite（`ctx.db`）而不是 `ctx.storage`
// ============================================================
//
// 台账会随着使用一直长。`ctx.storage` 的单值上限是 1 MB、总量 8 MB，而一条台账
// 记录（含两个 SHA-256、提示词长度、编号）大约 400~600 字节 —— 一万条就装不下了。
// 更要命的是**它没有查询**：`storage` 只能把全部数据拉进 JS 自己过滤，而那正是
// "一千条以后就开始卡"的来源。
//
// 这个插件的核心动作之一就是"拿到一张流出的图，查出当初发给了谁"——那就是一次
// 按编号的查询。让 SQLite 去做，而不是让界面去遍历一万条。
//
// ============================================================
// 两条与 `ctx.db` 实现有关的纪律
// ============================================================
//
// 1. **参数一律用 `?1` `?2` 占位**，不拼字符串。台账里会出现用户填的作者名、
//    文件名 —— 里面有单引号是很正常的，拼字符串会直接坏掉（或者更糟）。
// 2. **布尔存成 0/1 的整数**。`ctx.db` 的对象与数组会被存成 JSON 文本，而布尔没有
//    原生表示；存成 JSON 的 `true` 再读回来是一段字符串，那会让
//    `if (row.invisible)` 永远为真 —— 一个不会报错的错误。

import type { LedgerRecord } from '../model/types';
import { ctx } from '../env';
import { TABLE_LEDGER } from '../env';

/** 建表语句。**幂等**，每次打开台账都会跑一遍 */
const DDL_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TABLE_LEDGER} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id      TEXT    NOT NULL,
    output_name   TEXT    NOT NULL,
    output_dir    TEXT    NOT NULL DEFAULT '',
    output_sha    TEXT    NOT NULL DEFAULT '',
    source_name   TEXT    NOT NULL DEFAULT '',
    source_sha    TEXT    NOT NULL DEFAULT '',
    author        TEXT    NOT NULL DEFAULT '',
    platform      TEXT    NOT NULL DEFAULT '',
    order_no      TEXT    NOT NULL DEFAULT '',
    buyer         TEXT    NOT NULL DEFAULT '',
    license       TEXT    NOT NULL DEFAULT '',
    contact       TEXT    NOT NULL DEFAULT '',
    extra         TEXT    NOT NULL DEFAULT '',
    payload       TEXT    NOT NULL DEFAULT '',
    visible_lines TEXT    NOT NULL DEFAULT '[]',
    ink           TEXT    NOT NULL DEFAULT '',
    invisible     INTEGER NOT NULL DEFAULT 0,
    width         INTEGER NOT NULL DEFAULT 0,
    height        INTEGER NOT NULL DEFAULT 0,
    before_bytes  INTEGER NOT NULL DEFAULT 0,
    after_bytes   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    issued        TEXT    NOT NULL DEFAULT ''
  )
`;

const DDL_INDEXES = [
  `CREATE INDEX IF NOT EXISTS ${TABLE_LEDGER}_trace ON ${TABLE_LEDGER} (trace_id)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE_LEDGER}_created ON ${TABLE_LEDGER} (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE_LEDGER}_output ON ${TABLE_LEDGER} (output_name)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE_LEDGER}_issued ON ${TABLE_LEDGER} (issued)`,
];

/**
 * 一次会话里只建一次表。
 *
 * `CREATE TABLE IF NOT EXISTS` 本身是幂等的，但它仍是一次 IPC 往返。批量处理几百张
 * 图时，每条记录前都往返一次是白花的钱 —— 而这条缓存在**同一个插件文档**里有效，
 * 界面重开时会重新建一次（无害）。
 */
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await ctx.db.exec(DDL_TABLE);
      for (const statement of DDL_INDEXES) {
        await ctx.db.exec(statement);
      }
    })().catch((error) => {
      // 失败时**清掉缓存**，否则这一次会话里后面每一条都会拿到同一个失败，
      // 而用户看到的是"重试也没用"。
      ready = null;
      throw error;
    });
  }
  return ready;
}

/** 数据库里的原始行 */
interface LedgerRow {
  id: number;
  trace_id: string;
  output_name: string;
  output_dir: string;
  output_sha: string;
  source_name: string;
  source_sha: string;
  author: string;
  platform: string;
  order_no: string;
  buyer: string;
  license: string;
  contact: string;
  extra: string;
  payload: string;
  visible_lines: string;
  ink: string;
  invisible: number;
  width: number;
  height: number;
  before_bytes: number;
  after_bytes: number;
  created_at: number;
  issued: string;
}

function fromRow(row: LedgerRow): LedgerRecord {
  let lines: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.visible_lines || '[]');
    if (Array.isArray(parsed)) lines = parsed.map((item) => String(item));
  } catch {
    // 坏掉的 JSON 不该让整条记录读不出来 —— 其余字段仍然是有价值的。
    lines = [];
  }

  return {
    id: Number(row.id),
    traceId: String(row.trace_id ?? ''),
    outputName: String(row.output_name ?? ''),
    outputDir: String(row.output_dir ?? ''),
    outputSha: String(row.output_sha ?? ''),
    sourceName: String(row.source_name ?? ''),
    sourceSha: String(row.source_sha ?? ''),
    author: String(row.author ?? ''),
    platform: String(row.platform ?? ''),
    order: String(row.order_no ?? ''),
    buyer: String(row.buyer ?? ''),
    license: String(row.license ?? ''),
    contact: String(row.contact ?? ''),
    extra: String(row.extra ?? ''),
    payload: String(row.payload ?? ''),
    visibleLines: lines,
    ink: String(row.ink ?? ''),
    invisible: Number(row.invisible) === 1,
    width: Number(row.width),
    height: Number(row.height),
    beforeBytes: Number(row.before_bytes),
    afterBytes: Number(row.after_bytes),
    createdAt: Number(row.created_at),
    issued: String(row.issued ?? ''),
  };
}

const COLUMNS = [
  'trace_id',
  'output_name',
  'output_dir',
  'output_sha',
  'source_name',
  'source_sha',
  'author',
  'platform',
  'order_no',
  'buyer',
  'license',
  'contact',
  'extra',
  'payload',
  'visible_lines',
  'ink',
  'invisible',
  'width',
  'height',
  'before_bytes',
  'after_bytes',
  'created_at',
  'issued',
];

/** 写入一条记录，返回它的自增 id */
export async function insertRecord(
  record: Omit<LedgerRecord, 'id'>
): Promise<number> {
  await ensureReady();

  const placeholders = COLUMNS.map((_, index) => `?${index + 1}`).join(', ');
  const values: unknown[] = [
    record.traceId,
    record.outputName,
    record.outputDir,
    record.outputSha,
    record.sourceName,
    record.sourceSha,
    record.author,
    record.platform,
    record.order,
    record.buyer,
    record.license,
    record.contact,
    record.extra,
    record.payload,
    // 数组存成 JSON 文本 —— `ctx.db` 会把对象/数组再包一层 JSON，那样读回来是
    // **两层**编码的字符串。这里显式 stringify 一次，读的时候显式 parse 一次，
    // 两边的约定写在同一条注释里，免得下一个人以为可以直接交数组。
    JSON.stringify(record.visibleLines ?? []),
    record.ink,
    record.invisible ? 1 : 0,
    Math.round(record.width) || 0,
    Math.round(record.height) || 0,
    Math.round(record.beforeBytes) || 0,
    Math.round(record.afterBytes) || 0,
    Math.round(record.createdAt) || Date.now(),
    record.issued,
  ];

  const result = await ctx.db.exec(
    `INSERT INTO ${TABLE_LEDGER} (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return Number(result.lastInsertRowId);
}

/** 台账的查询条件 */
export interface LedgerQuery {
  /** 按编号/文件名/作者/订单/买家的模糊匹配 */
  search?: string;
  /** 只看某个发放日期 `yyyyMMdd` */
  issued?: string;
  limit?: number;
  offset?: number;
  /** 排序方向 */
  order?: 'newest' | 'oldest';
}

/** 一页查询结果 */
export interface LedgerPage {
  rows: LedgerRecord[];
  /** 满足条件的总条数（不是这一页的条数） */
  total: number;
}

/**
 * 分页查询。
 *
 * **总条数单独查一次**，而不是"把全部读出来数一数"：那正是台账要避免的那种做法。
 * 两次查询之间可能有人写入了新记录，因此 `total` 与 `rows` 严格来说不是同一个
 * 瞬间的快照 —— 但那个差异对上界面无意义，而为此开一个事务要贵得多。
 */
export async function listRecords(query: LedgerQuery = {}): Promise<LedgerPage> {
  await ensureReady();

  const where: string[] = [];
  const params: unknown[] = [];

  const search = (query.search ?? '').trim();
  if (search.length > 0) {
    // `LIKE` 的通配符要转义，否则用户搜一个 `%` 就会匹配到全部记录 ——
    // 那看起来像"搜索坏了"，而不是"你搜的是通配符"。
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    const fields = [
      'trace_id',
      'output_name',
      'author',
      'platform',
      'order_no',
      'buyer',
      'license',
      'payload',
    ];
    where.push(
      `(${fields.map((field) => `${field} LIKE ?${params.length + 1} ESCAPE '\\'`).join(' OR ')})`
    );
    // 同一个值要绑定到每一个字段上 —— SQLite 的 `?N` 是按序号绑定的，
    // 因此这里必须重复 push，而不能指望一个占位符被复用。
    for (let index = 0; index < fields.length; index++) params.push(like);
  }

  if (query.issued && query.issued.trim().length > 0) {
    params.push(query.issued.trim());
    where.push(`issued = ?${params.length}`);
  }

  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const countRows = await ctx.db.query(
    `SELECT COUNT(*) AS total FROM ${TABLE_LEDGER}${clause}`,
    params
  );
  const total = Number((countRows[0] as { total?: unknown } | undefined)?.total ?? 0);

  const limit = clampInt(query.limit ?? 50, 1, 500);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const direction = query.order === 'oldest' ? 'ASC' : 'DESC';

  const rows = await ctx.db.query(
    `SELECT * FROM ${TABLE_LEDGER}${clause} ORDER BY created_at ${direction} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    rows: (rows as unknown as LedgerRow[]).map(fromRow),
    total,
  };
}

/** 按追踪编号查。这正是"拿到一张流出图，查当初发给了谁"那一步 */
export async function findByTraceId(traceId: string): Promise<LedgerRecord[]> {
  await ensureReady();
  const rows = await ctx.db.query(
    `SELECT * FROM ${TABLE_LEDGER} WHERE trace_id = ?1 ORDER BY created_at DESC LIMIT 50`,
    [traceId.trim()]
  );
  return (rows as unknown as LedgerRow[]).map(fromRow);
}

/** 按输出文件的哈希查。改过名的副本靠它认出来 */
export async function findBySha(sha: string): Promise<LedgerRecord[]> {
  await ensureReady();
  const value = sha.trim().toLowerCase();
  if (value.length === 0) return [];
  const rows = await ctx.db.query(
    `SELECT * FROM ${TABLE_LEDGER} WHERE output_sha = ?1 OR source_sha = ?1 ORDER BY created_at DESC LIMIT 50`,
    [value]
  );
  return (rows as unknown as LedgerRow[]).map(fromRow);
}

/** 删一条记录 */
export async function deleteRecord(id: number): Promise<void> {
  await ensureReady();
  await ctx.db.exec(`DELETE FROM ${TABLE_LEDGER} WHERE id = ?1`, [Math.floor(id)]);
}

/** 清空台账。**不可撤销**，界面必须先确认 */
export async function clearLedger(): Promise<number> {
  await ensureReady();
  const result = await ctx.db.exec(`DELETE FROM ${TABLE_LEDGER}`);
  return Number(result.changes) || 0;
}

/** 台账的统计 */
export interface LedgerStats {
  records: number;
  /** 不同追踪编号的个数。**它与 `records` 不相等时说明同一个编号发了多份** */
  distinctIds: number;
  totalAfterBytes: number;
  firstAt: number;
  lastAt: number;
}

export async function ledgerStats(): Promise<LedgerStats> {
  await ensureReady();
  const rows = await ctx.db.query(
    `SELECT COUNT(*) AS records,
            COUNT(DISTINCT trace_id) AS distinct_ids,
            COALESCE(SUM(after_bytes), 0) AS total_bytes,
            COALESCE(MIN(created_at), 0) AS first_at,
            COALESCE(MAX(created_at), 0) AS last_at
       FROM ${TABLE_LEDGER}`
  );
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    records: Number(row.records ?? 0),
    distinctIds: Number(row.distinct_ids ?? 0),
    totalAfterBytes: Number(row.total_bytes ?? 0),
    firstAt: Number(row.first_at ?? 0),
    lastAt: Number(row.last_at ?? 0),
  };
}

/** 已经用过哪些发放日期（供界面上的筛选下拉） */
export async function issuedDates(): Promise<string[]> {
  await ensureReady();
  const rows = await ctx.db.query(
    `SELECT DISTINCT issued FROM ${TABLE_LEDGER} WHERE issued <> '' ORDER BY issued DESC LIMIT 200`
  );
  return (rows as unknown as Array<{ issued: string }>).map((row) => String(row.issued));
}

/** 台账里已有多少个不同的编号 —— 生成新编号时用它避免重复 */
export async function existingTraceIds(prefix: string, date: string): Promise<string[]> {
  await ensureReady();
  const rows = await ctx.db.query(
    `SELECT trace_id FROM ${TABLE_LEDGER} WHERE trace_id LIKE ?1 ORDER BY trace_id DESC LIMIT 1000`,
    [`${prefix}-${date}-%`]
  );
  return (rows as unknown as Array<{ trace_id: string }>).map((row) =>
    String(row.trace_id)
  );
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.floor(Number(value));
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}
