import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { getVcrRows, type VcrRowCell, type VcrRowColumn, type VcrRowsPage, type VcrRowsSource } from "@/lib/vcrRowsClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { IconButton } from "@/components/ui/IconButton";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { useVcrLoad } from "../vcrTabKit";
import { numberText } from "../vcrText";

/**
 * The people of a generated table, as a table (R19, plan §5.3 「虚拟患者页重做」; audit B §4.5 `PatientTable`).
 *
 * The page called 「虚拟患者」 had no patients on it: no count, no list, no filter, no one to open — though the data plane holds
 * a row for each. This is that list. The server reads, filters, sorts and pages the table (`vcrRows.mjs`, the same doors the CSV
 * download goes through), so a table of two million cells is a window of at most a few hundred rows in the browser.
 *
 * Hidden knowledge:
 *  - **The selection is the page's.** Which arm and which columns are filtered is the page's toolbar (and the charts' legend); this
 *    table only draws what it is given and reports the press on a row. A narrowing goes back to the first page.
 *  - **A press on a row opens the record**, by the mouse anywhere on it and by the keyboard through the id in its first cell. A
 *    population has no ids — its rows are addressed by position and open nothing (`onOpen` absent).
 *  - **A sort the table is too long for is refused by name** (`vcr_rows_too_large`) and the refusal is the answer: the sentence and
 *    the way back (取消排序), never a partial order.
 *  - **The previous page stays on screen while the next is read**, so paging does not blink the table away.
 */
export interface PatientTableProps {
  studyId: string;
  source: VcrRowsSource;
  /** The result the table belongs to (`records.result`); the server's own current one when absent. */
  result: string | null;
  /** The section's heading (「患者」). */
  title: string;
  /** The study's own words for its variables, by column key; the engine's words win. */
  labels: Readonly<Record<string, string>>;
  /** The arm filter (`1`, `0`), or null for both. */
  arm?: string | null;
  /** Column → filter text (`60..70`). */
  filters?: Readonly<Record<string, string>>;
  /** The patient whose record is open. */
  selected?: string | null;
  /** Opens a patient's record; absent for a table that has none to open. */
  onOpen?: (patientId: string) => void;
  pageSize?: number;
  /** The column that opens a record. */
  idColumn?: string;
}

interface Paging {
  /** What the offset belongs to: a change of arm, filter, sort or table starts over. */
  view: string;
  offset: number;
}

const formatCell = (value: VcrRowCell): string => {
  if (value === null) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value;
};

export function PatientTable({ studyId, source, result, title, labels, arm = null, filters = {}, selected = null, onOpen, pageSize = 25, idColumn = "patientId" }: PatientTableProps) {
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null);
  const filtersKey = useMemo(() => JSON.stringify(Object.entries(filters).filter(([, text]) => text).sort()), [filters]);
  const view = `${result ?? ""}|${arm ?? ""}|${filtersKey}|${sort ? `${sort.descending ? "-" : ""}${sort.column}` : ""}`;
  const [paging, setPaging] = useState<Paging>({ view, offset: 0 });
  const offset = paging.view === view ? paging.offset : 0;

  const sortText = sort ? `${sort.descending ? "-" : ""}${sort.column}` : null;
  const { state, reload, last } = useVcrLoad(`${studyId}:rows:${source}:${view}:${offset}`, () => getVcrRows(studyId, source, {
    result, offset, limit: pageSize, sort: sortText, arm, filters: Object.fromEntries(Object.entries(filters).filter(([, text]) => text)),
  }));
  const page: VcrRowsPage | null = state.kind === "ready" ? state.data : last;

  // A page that was asked for and came back empty (the table shrank under it) goes back to the first.
  const emptied = useRef(false);
  useEffect(() => {
    if (state.kind !== "ready" || offset === 0 || state.data.rows.length > 0 || emptied.current) return;
    emptied.current = true;
    setPaging({ view, offset: 0 });
  }, [state, offset, view]);
  useEffect(() => { emptied.current = false; }, [view]);

  const labelOf = (column: VcrRowColumn) => column.label ?? labels[column.key] ?? column.key;
  const columns = useMemo<Array<DataColumn<Record<string, VcrRowCell>>>>(() => {
    if (!page) return [];
    const position: DataColumn<Record<string, VcrRowCell>> = {
      key: "__position",
      header: "序号",
      rowHeader: true,
      align: "right",
      width: "w-16",
      cell: (row) => <span className="tabular-nums text-text-3">{String(row.__position)}</span>,
    };
    const ours = page.columns.map((column): DataColumn<Record<string, VcrRowCell>> => {
      const opens = onOpen !== undefined && column.key === idColumn;
      const active = sort?.column === column.key ? sort : null;
      return {
        key: column.key,
        header: <SortHeader label={labelOf(column)} active={active} onSort={() => setSort(nextSort(sort, column.key))} />,
        rowHeader: opens,
        align: column.kind === "number" ? "right" : "left",
        isEmpty: (row) => row[column.key] === null || row[column.key] === undefined,
        cell: (row) => {
          const value = row[column.key];
          if (opens && typeof value === "string") {
            return (
              <button
                type="button"
                data-vcr-open-patient={value}
                aria-label={`打开 ${value} 的记录`}
                onClick={() => onOpen(value)}
                className="rounded text-left tabular-nums text-link hover:underline"
              >
                {value}
              </button>
            );
          }
          const word = column.values && value !== null ? column.values[String(value)] : undefined;
          return <span className="tabular-nums">{word ?? formatCell(value)}</span>;
        },
      };
    });
    // A table of people with no id column (a population) is addressed by position.
    return onOpen === undefined && !page.columns.some((column) => column.key === idColumn) ? [position, ...ours] : ours;
    // `labelOf` closes over `labels` and the page; both are in the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, labels, sort, onOpen, idColumn]);

  const rows = useMemo<Array<Record<string, VcrRowCell>>>(
    () => (page?.rows ?? []).map((row, index) => ({ ...row, __position: (page?.offset ?? 0) + index + 1 })),
    [page],
  );

  const total = page?.total ?? 0;
  const all = page?.all ?? 0;
  const first = rows.length > 0 ? (page?.offset ?? 0) + 1 : 0;
  const lastShown = (page?.offset ?? 0) + rows.length;
  const count = page ? (total === all ? numberText(all, 0) : `${numberText(total, 0)} / ${numberText(all, 0)}`) : undefined;
  const pager = page && total > pageSize ? (
    <div data-vcr-pager="" className="flex items-center gap-1">
      <span className="text-caption tabular-nums text-text-3">{`${numberText(first, 0)}–${numberText(lastShown, 0)}`}</span>
      <IconButton icon={ChevronLeft} label="上一页" size="sm" disabled={offset === 0} onClick={() => setPaging({ view, offset: Math.max(0, offset - pageSize) })} />
      <IconButton icon={ChevronRight} label="下一页" size="sm" disabled={lastShown >= total} onClick={() => setPaging({ view, offset: offset + pageSize })} />
    </div>
  ) : undefined;

  if (state.kind === "error" && !page) {
    return (
      <Section title={title}>
        <DataTable label={title} columns={[]} rows={[]} rowKey={() => ""} state="error" errorMessage={state.message} onRetry={reload} />
      </Section>
    );
  }

  return (
    <Section title={title} count={count} toolbar={pager}>
      {state.kind === "error" && sort ? (
        <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={() => setSort(null)}>取消排序</Button>}>{state.message}</Note>
      ) : (
        <div aria-busy={state.kind === "loading" || undefined} className={cn(state.kind === "loading" && page && "opacity-disabled transition-opacity")}>
          <DataTable
            label={title}
            columns={columns}
            rows={rows}
            rowKey={(row) => String(row[idColumn] ?? row.__position)}
            state={!page ? "loading" : "content"}
            emptyText="没有符合筛选的记录。"
            minWidth="min-w-[32rem]"
            highlight={(row) => selected !== null && row[idColumn] === selected}
            rowAttrs={(row) => ({ "data-vcr-patient-row": String(row[idColumn] ?? row.__position) })}
            onRowOpen={onOpen ? (row) => { const id = row[idColumn]; if (typeof id === "string") onOpen(id); } : undefined}
          />
        </div>
      )}
    </Section>
  );
}

/** ascending → descending → not sorted. */
function nextSort(current: { column: string; descending: boolean } | null, column: string): { column: string; descending: boolean } | null {
  if (!current || current.column !== column) return { column, descending: false };
  return current.descending ? null : { column, descending: true };
}

/** A column heading that sorts: the arrow is the state (shape, not colour alone), the name says what pressing does next. */
function SortHeader({ label, active, onSort }: { label: string; active: { descending: boolean } | null; onSort: () => void }) {
  const Arrow = active ? (active.descending ? ArrowDown : ArrowUp) : null;
  const state = active ? (active.descending ? "，当前从大到小" : "，当前从小到大") : "";
  return (
    <button
      type="button"
      aria-label={`按${label}排序${state}`}
      aria-pressed={active !== null}
      onClick={onSort}
      className={cn("inline-flex items-center gap-0.5 rounded", active ? "text-text" : "hover:text-text")}
    >
      {label}
      {Arrow && <Arrow size={16} aria-hidden="true" />}
    </button>
  );
}
