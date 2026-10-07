// src/art-trace/trace/report.ts
//
// 台账的导出：CSV 与 JSON。
//
// ============================================================
// 为什么 CSV 要带 BOM
// ============================================================
//
// Excel 打开不带 BOM 的 UTF-8 CSV 时会按系统本地代码页解释，于是"作者名"、
// "买家"这类中文列全变成乱码。加一个 `\uFEFF` 是最省事也最有效的修法 ——
// 而"导出之后打开是乱码"会让人以为导出功能坏了。
//
// 为什么用 CRLF：Excel 在 Windows 上对 LF 的容忍度时好时坏，而 CRLF 两边都认。

import type { LedgerRecord } from '../model/types';
import { formatStamp } from './payload';

/** CSV 里的一个字段：加引号并把内部引号翻倍 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length === 0) return '';
  // 逗号、引号、换行三者都会破坏 CSV 的结构。**多行**那一条最容易漏：
  // 负向提示词里本来就有换行，而它会让一整行的列数错位。
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 台账列表的列定义。CSV 表头与行都从它生成，因此不会漂 */
const CSV_COLUMNS: Array<{ header: string; of: (record: LedgerRecord) => unknown }> = [
  { header: '追踪编号', of: (r) => r.traceId },
  { header: '输出文件', of: (r) => r.outputName },
  { header: '输出目录', of: (r) => r.outputDir },
  { header: '源文件', of: (r) => r.sourceName },
  { header: '作者', of: (r) => r.author },
  { header: '平台', of: (r) => r.platform },
  { header: '订单号', of: (r) => r.order },
  { header: '买家', of: (r) => r.buyer },
  { header: '授权', of: (r) => r.license },
  { header: '联系方式', of: (r) => r.contact },
  { header: '备注', of: (r) => r.extra },
  { header: '发放日期', of: (r) => r.issued },
  { header: '记录时间', of: (r) => formatStamp(r.createdAt) },
  { header: '宽', of: (r) => r.width },
  { header: '高', of: (r) => r.height },
  { header: '源体积', of: (r) => r.beforeBytes },
  { header: '成品体积', of: (r) => r.afterBytes },
  { header: '隐形水印', of: (r) => (r.invisible ? '是' : '否') },
  { header: '墨水', of: (r) => r.ink },
  { header: '可见水印', of: (r) => r.visibleLines.join(' / ') },
  { header: '隐形载荷', of: (r) => r.payload },
  { header: '成品 SHA-256', of: (r) => r.outputSha },
  { header: '源 SHA-256', of: (r) => r.sourceSha },
];

/** 台账 → CSV 文本（已带 BOM，可直接写进文件） */
export function toCsv(records: LedgerRecord[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.map((column) => csvCell(column.header)).join(','));
  for (const record of records) {
    lines.push(
      CSV_COLUMNS.map((column) => csvCell(column.of(record))).join(',')
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 导出文件的元信息 */
export interface ReportMeta {
  /** 导出时间（毫秒） */
  exportedAt: number;
  /** 导出版本，方便以后认出旧文件 */
  schema: number;
  /** 筛选条件的人话描述，例如"搜索：糯米" */
  filter: string;
}

/** 台账 → JSON 清单（机器可读，且带上导出时的上下文） */
export function toManifestJson(records: LedgerRecord[], meta: ReportMeta): string {
  return `${JSON.stringify(
    {
      generator: 'Modulith 影像元数据工坊',
      schema: meta.schema,
      exportedAt: meta.exportedAt,
      exportedAtText: formatStamp(meta.exportedAt),
      filter: meta.filter,
      count: records.length,
      records,
    },
    null,
    2
  )}\n`;
}

/** 导出文件的默认名字，形如 `art-trace-ledger-20261007-1432.csv` */
export function suggestExportName(prefix: string, at: number, extension: string): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${prefix}-${stamp}.${extension}`;
}

/**
 * 单张图片的检视报告（JSON）。
 *
 * 与台账导出的区别：那个是"谁拿过什么"，这个是"这张图里有什么"。用户拿到一张可疑的
 * 图，想把它里面的东西留档或者贴给别人看时用这个。
 */
export function inspectionToJson(input: {
  name: string;
  sha256: string;
  inspectedAt: number;
  info: unknown;
  generation: unknown;
  blocks: Array<{ label: string; group: string; bytes: number; text: string }>;
  exif: unknown;
  xmp: string | null;
  trace: unknown;
}): string {
  return `${JSON.stringify(
    {
      generator: 'Modulith 影像元数据工坊',
      file: input.name,
      sha256: input.sha256,
      inspectedAt: input.inspectedAt,
      info: input.info,
      generation: input.generation,
      blocks: input.blocks,
      exif: input.exif,
      xmp: input.xmp,
      trace: input.trace,
    },
    null,
    2
  )}\n`;
}

/** CSV 的 MIME。用于下载链接 */
export const CSV_MIME = 'text/csv;charset=utf-8';
/** JSON 的 MIME */
export const JSON_MIME = 'application/json;charset=utf-8';
