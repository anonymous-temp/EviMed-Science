import { formatApproxCount, formatNumber, humanSize } from "./format";
import type { ResearchDatabaseLimits, ResearchDatabaseSnapshot, ResearchDatabaseTable } from "./researchDatabaseClient";

/**
 * What an import of a database table takes and leaves out, in the words a researcher reads: before the import (what this table
 * will lose to the limits) and after it (what the file actually holds). Both are the same facts the service already counted;
 * the numbers are never recomputed here, only said. Pure, so the dialog and its tests share one set of sentences.
 */

/** How many column names a sentence writes out before the rest go behind a fold. */
export const COLUMN_NAMES_INLINE = 6;
/** The only reason to name the schema is that it is not the default one (the table list does the same). */
export const tableLabel = (table: { schema: string; table: string }) => (table.schema === "public" ? table.table : `${table.schema}.${table.table}`);
const typed = (column: { name: string; type: string }) => `${column.name}（${column.type}）`;

const SAMPLE_CAVEAT = "按存放顺序，不是随机抽样";

export interface TableImportNotes {
  /** What every import is bounded by, and where the table ends up. */
  limits: string;
  /** Set when the table is larger than the row limit, or its size is not known yet: only the first rows are imported. */
  rows: string | null;
  /** Columns of a supported type that lie past the column limit. */
  overLimit: string | null;
  /** Columns of a type the import does not read: a sentence, the names, and whether the names are long enough to fold. */
  unsupported: { summary: string; names: string; fold: boolean } | null;
}

/** What importing this table will leave out, before the person presses import. */
export function tableImportNotes(table: ResearchDatabaseTable, limits: ResearchDatabaseLimits): TableImportNotes {
  const cell = humanSize(limits.cellBytes);
  const rows = formatNumber(limits.rows);
  const bound = `单次最多导入 ${rows} 行、${formatNumber(limits.columns)} 列${cell ? `；单个单元格超过 ${cell} 的内容不会导入` : ""}。`;
  const known = table.estimatedRows;
  const rowNote = known === null
    ? `这张表的行数还没有统计；超过 ${rows} 行时，只会导入表里靠前的 ${rows} 行（${SAMPLE_CAVEAT}）。`
    : known > limits.rows
      ? `这张表约有 ${formatApproxCount(known)} 行，只会导入表里靠前的 ${rows} 行（${SAMPLE_CAVEAT}）。`
      : null;
  const count = Math.max(table.unsupportedColumnCount, table.unsupportedColumns.length);
  const listed = table.unsupportedColumns.map(typed);
  const unlisted = count - listed.length;
  return {
    limits: `导入后存为知识库里的数据表，并加入本研究。${bound}`,
    rows: rowNote,
    overLimit: table.omittedColumnCount > 0 ? `另有 ${formatNumber(table.omittedColumnCount)} 列超出 ${formatNumber(limits.columns)} 列的上限，不会导入。` : null,
    unsupported: count > 0
      ? { summary: `${formatNumber(count)} 列的类型暂不支持，不会导入`, names: `${listed.join("、")}${unlisted > 0 ? `${listed.length ? "，以及另外 " : "共 "}${formatNumber(unlisted)} 列` : ""}`, fold: listed.length > COLUMN_NAMES_INLINE || unlisted > 0 }
      : null,
  };
}

export interface ImportOutcome {
  /** The confirmation: what was imported, and when it is only a part, what was not. */
  text: string;
  /** The file is not the whole table as selected: rows stopped, cells were left out or columns were not read. */
  partial: boolean;
  /** Further plain sentences that belong under the confirmation (how the rows were chosen, which columns, which version). */
  notes: string[];
}

/**
 * What an import came to. A complete import keeps the one-line form; a partial one says so in its first words, and says what the
 * file holds and what it does not: the rows (`前 20,000 行（共 52,340 行）`, `共约` when the total is the database's estimate),
 * cells over the cell limit, columns of an unsupported type, columns past the column limit.
 */
export function importOutcome(result: ResearchDatabaseSnapshot, name: string): ImportOutcome {
  const withheld = Number(result.withheldCells) || 0;
  const dropped = Array.isArray(result.droppedColumns) ? result.droppedColumns : [];
  const droppedCount = Math.max(Number(result.droppedColumnCount) || 0, dropped.length);
  const unsupported = dropped.filter(item => item.reason === "unsupported_type").length;
  const overLimit = dropped.filter(item => item.reason === "over_column_limit").length;
  // The list is cut at fifty; a column it no longer names is still a column that is not in the file.
  const unnamed = droppedCount - dropped.length;
  const truncated = result.truncated === true;
  const total = typeof result.totalRows === "number" ? `（共${result.totalRowsExact === false ? "约" : ""} ${formatNumber(result.totalRows)} 行）` : "";
  const shape = `${truncated ? `前 ${formatNumber(result.rowCount)} 行${total}` : `${formatNumber(result.rowCount)} 行`}${result.columns ? ` × ${result.columns} 列` : ""}`;
  const left = [
    withheld > 0 ? `${formatNumber(withheld)} 个单元格过大未导入` : null,
    unsupported > 0 ? `${formatNumber(unsupported)} 列类型不支持未导入` : null,
    overLimit > 0 ? `${formatNumber(overLimit)} 列超出列数上限未导入` : null,
    unnamed > 0 ? `另有 ${formatNumber(unnamed)} 列未导入` : null,
  ].filter((item): item is string => item !== null);
  const partial = result.partial === true || truncated || left.length > 0;
  const text = !partial ? `已导入 ${name}：${shape}，已加入本研究。`
    : left.length > 0 ? `已导入 ${name}，只导入了一部分：${shape}；${left.join("；")}。已加入本研究。`
      : `已导入 ${name}，只导入了一部分：${shape}。已加入本研究。`;
  const notes: string[] = [];
  if (truncated) notes.push(`取的是表里靠前的行（${SAMPLE_CAVEAT}），不能代表整张表。`);
  if (truncated && result.stoppedBy === "bytes") notes.push("数据量超过单次导入的上限，读到这里就停了。");
  if (truncated && result.stoppedBy === "time") notes.push("读取用时超过了上限，读到这里就停了。");
  if (droppedCount > 0) {
    const names = dropped.slice(0, COLUMN_NAMES_INLINE).map(item => item.name);
    notes.push(`未导入的列：${names.join("、")}${droppedCount > names.length ? ` 等 ${formatNumber(droppedCount)} 列` : ""}。`);
  }
  if (Number(result.version) > 1) notes.push(`这是 ${name} 的第 ${Number(result.version)} 版，本研究里已改用这一版。`);
  return { text, partial, notes };
}
