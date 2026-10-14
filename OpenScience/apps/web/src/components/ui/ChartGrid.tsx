import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Charts and cards laid out by rows (R19, plan §3, T4): a row's cells share its height, and a row is full — its spans add up to
 * the column count — so a grid cannot leave a hole. The 对照 page drew a three-column soup in which the top-right cell was empty
 * because one card had no data and the grid did not close up; the cure is that the page says the rows, not that the grid hopes.
 *
 * ```tsx
 * <ChartGrid rows={[
 *   [{ key: "trend", span: 2, node: <ChartCard title="…">…</ChartCard> }],
 *   [{ key: "engine", node: <ChartCard …/> }, { key: "pool", node: <ChartCard …/> }],
 * ]} />
 * ```
 *
 * Under 768 px every cell is its own row. A cell is a block of its own width: `ChartCard` and `Card` fill it (`h-full`), so a
 * card with less in it is as tall as its neighbour. In development a row whose spans do not add up to `columns` is a console
 * warning naming the row; `data-chart-grid` is what the walk measures for holes.
 */
export interface ChartGridCell {
  key: string;
  /** How many of the row's columns the cell takes; default 1. */
  span?: 1 | 2 | 3;
  node: ReactNode;
}

const COLUMNS = { 2: "md:grid-cols-2", 3: "md:grid-cols-3" } as const;
const SPANS = { 1: "", 2: "md:col-span-2", 3: "md:col-span-3" } as const;

export function ChartGrid({ rows, columns = 2, className }: {
  rows: ReadonlyArray<readonly ChartGridCell[]>;
  columns?: 2 | 3;
  className?: string;
}) {
  if (import.meta.env.DEV) {
    rows.forEach((row, index) => {
      const total = row.reduce((sum, cell) => sum + (cell.span ?? 1), 0);
      if (total !== columns) {
        console.warn(`ChartGrid: row ${index + 1} (${row.map((cell) => cell.key).join(", ")}) spans ${total} of ${columns} columns; a row must be full.`);
      }
    });
  }
  return (
    <div data-chart-grid="" className={cn("flex flex-col gap-3", className)}>
      {rows.map((row, index) => (
        <div key={row.map((cell) => cell.key).join("|") || index} data-chart-row="" className={cn("grid grid-cols-1 items-stretch gap-3", COLUMNS[columns])}>
          {row.map((cell) => (
            <div key={cell.key} className={cn("min-w-0 [&>*]:h-full", SPANS[cell.span ?? 1])}>{cell.node}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
