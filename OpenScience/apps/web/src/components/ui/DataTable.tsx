import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * The data page's table: a sticky header, numbers right-aligned in tabular
 * figures, one row optionally marked as ours, and inline bars where a number
 * wants a length (appendix E §4.1: a ranking is a table with bars, never a
 * pie and never a chart library).
 *
 * **A column nothing fills is not drawn.** The source table shipped with three
 * of seven columns reading 「—」 in every row, which is the cheapest thing a
 * dashboard can look like; a column says how to recognise its own emptiness
 * (`isEmpty`) and the table drops it when every row agrees. A column with no
 * `isEmpty` is always drawn — a column can only disappear when its author
 * said what empty means.
 *
 * Four states, like every list on this product: skeleton, empty sentence,
 * error with 重试, content.
 */

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  /** Numbers go right; everything else left. */
  align?: "left" | "right";
  /** The first column is usually the row's own header. */
  rowHeader?: boolean;
  /** A width class from the scale (`w-24`, `w-40`). */
  width?: string;
  cell: (row: T) => ReactNode;
  /** True when this row has nothing here; a column empty in every row is dropped. */
  isEmpty?: (row: T) => boolean;
}

/** The columns that survive: one a reader would only ever see as 「—」 is gone. */
export function drawnColumns<T>(columns: ReadonlyArray<DataColumn<T>>, rows: readonly T[]): Array<DataColumn<T>> {
  return columns.filter((column) => !column.isEmpty || rows.length === 0 || rows.some((row) => !column.isEmpty!(row)));
}

export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  highlight,
  rowAttrs,
  state = "content",
  emptyText,
  errorMessage,
  onRetry,
  footnote,
  minWidth = "min-w-[36rem]",
  className,
}: {
  /** The table's accessible name. */
  label: string;
  columns: ReadonlyArray<DataColumn<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** The row that is ours: the accent ground and the accent rule. */
  highlight?: (row: T) => boolean;
  /** `data-` attributes a walk or a test reads off the row. */
  rowAttrs?: (row: T) => Record<string, string>;
  state?: "content" | "loading" | "empty" | "error";
  emptyText?: string;
  errorMessage?: string;
  onRetry?: () => void;
  /** The denominator, said once for the whole table. */
  footnote?: ReactNode;
  /** The width below which the table scrolls sideways instead of crushing. */
  minWidth?: string;
  className?: string;
}) {
  if (state === "loading") {
    return (
      <div aria-hidden="true" className={cn("animate-pulse", className)}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-4 border-b border-faint py-3">
            <div className="h-3.5 w-1/4 rounded bg-surface-2" />
            <div className="h-3.5 w-1/6 rounded bg-surface-2" />
          </div>
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className={cn("flex flex-wrap items-center gap-3 rounded border border-danger bg-danger-soft px-3 py-2 text-ui text-danger-strong", className)}>
        <span className="min-w-0 flex-1 break-words">{errorMessage ?? "暂时无法读取，请稍后重试。"}</span>
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />重试
          </Button>
        )}
      </div>
    );
  }
  if (state === "empty" || rows.length === 0) {
    return <p className={cn("py-6 text-ui text-text-3", className)}>{emptyText ?? "还没有可以看的数据。"}</p>;
  }
  const drawn = drawnColumns(columns, rows);
  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className={cn("w-full border-collapse", minWidth)}>
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr className="border-b border-border">
              {drawn.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "sticky top-0 z-10 bg-bg px-2 pb-2 pt-1 text-compact font-normal text-text-3",
                    column.align === "right" ? "text-right" : "text-left",
                    column.width,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ours = highlight?.(row) ?? false;
              return (
                <tr
                  key={rowKey(row)}
                  {...(rowAttrs?.(row) ?? {})}
                  data-row-ours={ours ? "" : undefined}
                  className={cn("border-b border-faint", ours && "bg-accent-soft")}
                >
                  {drawn.map((column) => {
                    const body = column.cell(row);
                    const shared = cn(
                      "px-2 py-2.5 align-middle text-ui",
                      column.align === "right" ? "text-right tabular-nums" : "text-left",
                      ours ? "font-medium text-text" : "text-text",
                    );
                    return column.rowHeader
                      ? <th key={column.key} scope="row" className={cn(shared, "font-normal", ours && "font-medium")}>{body}</th>
                      : <td key={column.key} className={shared}>{body}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footnote != null && <p className="mt-2 text-caption text-text-3">{footnote}</p>}
    </div>
  );
}

/**
 * A number's length inside a table row. `tone="own"` is the brand and
 * everything else is a neutral grey, which is the whole rule of a comparison
 * chart on this product: a reader must be able to find their own product
 * without reading a legend.
 */
export function InlineBar({
  value,
  max,
  tone = "rival",
  label,
}: {
  value: number | null;
  max: number;
  tone?: "own" | "rival" | "quiet";
  /** The bar's accessible name; the number itself is printed beside it. */
  label: string;
}) {
  if (typeof value !== "number" || !Number.isFinite(value) || max <= 0) {
    return <span className="text-text-3">—</span>;
  }
  const width = `${Math.max(2, Math.min(100, (value / max) * 100))}%`;
  return (
    <span role="img" aria-label={label} data-bar-tone={tone} className="block h-2 w-full rounded-full bg-surface-2">
      <span
        className={cn("block h-2 rounded-full", tone === "own" ? "bg-accent" : tone === "rival" ? "bg-text-graphic" : "bg-border-control")}
        style={{ width }}
      />
    </span>
  );
}
