import { DataTable, InlineBar, type DataColumn } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import type { LibraryComposition as Composition } from "@/lib/knowledgeBaseClient";

/** A table is drawn when at least this many documents say what it counts; a library of fewer has no composition to speak of. */
export const COMPOSITION_MIN_DOCUMENTS = 3;

interface Row { key: string; label: string; count: number }
interface Table { key: string; title: string; label: string; rows: Row[] }

/** The tables the composition has enough documents behind to draw. */
export function compositionTables(composition: Composition): Table[] {
  if (composition.total < COMPOSITION_MIN_DOCUMENTS) return [];
  const tables: Table[] = [];
  if (composition.dated >= COMPOSITION_MIN_DOCUMENTS && composition.years.length > 0) {
    tables.push({ key: "years", title: "发表年份", label: "按发表年份的资料数",
      rows: composition.years.map((entry) => ({ key: String(entry.year), label: String(entry.year), count: entry.count })) });
  }
  if (composition.keyworded >= COMPOSITION_MIN_DOCUMENTS && composition.keywords.length > 0) {
    tables.push({ key: "keywords", title: "关键词", label: "按关键词的资料数",
      rows: composition.keywords.map((entry) => ({ key: entry.keyword, label: entry.keyword, count: entry.count })) });
  }
  return tables;
}

/**
 * 「资料组成」: what the project's library is made of, by the year its documents were published and by their keywords — at the top
 * of the page, folded, and not drawn at all where the library is too small to have a composition (fewer than three documents say
 * what a table counts). Each table is a ranked list with its bar in the row (appendix E §4.1: never a pie, never a chart
 * library): the count is printed and its length is the bar's, and nothing in it is a control — it counts, it does not filter.
 */
export function LibraryComposition({ composition }: { composition: Composition }) {
  const tables = compositionTables(composition);
  if (tables.length === 0) return null;
  return (
    <Disclosure summary="资料组成" className="mb-4">
      <div className="grid gap-6 md:grid-cols-2">
        {tables.map((table) => {
          const max = Math.max(...table.rows.map((row) => row.count));
          const columns: DataColumn<Row>[] = [
            { key: "label", header: table.title, rowHeader: true, cell: (row) => row.label },
            { key: "bar", header: <span className="sr-only">数量</span>, width: "w-40", cell: (row) => <InlineBar value={row.count} max={max} tone="quiet" label={`${row.label}：${row.count} 份`} /> },
            { key: "count", header: "份数", align: "right", width: "w-16", cell: (row) => row.count },
          ];
          return (
            <div key={table.key} className="min-w-0" data-composition={table.key}>
              <DataTable label={table.label} columns={columns} rows={table.rows} rowKey={(row) => row.key} minWidth="min-w-0" />
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}
