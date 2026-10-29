import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { InlineBar } from "@/components/ui/DataTable";

/**
 * A short ranked list of things with a length each — the kinds of site the engines cite, what a group's errors are made of — where
 * the bar is the count and a row can be the filter of the table beside it ("a chart and its table share one selection", rule 11).
 *
 * A row with `onSelect` is a button whose pressed state is `selected`; pressing the selected row again lets go. Without it the
 * list is a plain figure. The bar is the page's one comparison grammar (`InlineBar`): the brand for what is ours, grey for the
 * rest; here every row is a count of the same kind of thing, so they share one grey.
 */
export interface BarListRow {
  key: string;
  label: string;
  value: number;
  /** What the value counts, as a short phrase after the number (「次引用」「个站」). */
  unit?: string;
  /** A grey word after the label: 「34 个站」. */
  note?: ReactNode;
}

export function BarList({
  label,
  rows,
  selected = null,
  onSelect,
  tone = "rival",
  className,
}: {
  /** The list's accessible name. */
  label: string;
  rows: readonly BarListRow[];
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  tone?: "own" | "rival" | "quiet";
  className?: string;
}) {
  const max = rows.reduce((top, row) => Math.max(top, row.value), 0);
  return (
    <ul aria-label={label} data-bar-list="" className={cn("flex flex-col gap-1", className)}>
      {rows.map((row) => {
        const chosen = selected === row.key;
        const body = (
          <>
            <span className="w-24 shrink-0 truncate text-left text-ui text-text-2 sm:w-32">{row.label}</span>
            <span className="min-w-0 flex-1"><InlineBar value={row.value} max={max} tone={tone} label={`${row.label}：${row.value}${row.unit ?? ""}`} /></span>
            <span className="w-20 shrink-0 text-right text-ui tabular-nums text-text">
              {row.value.toLocaleString("zh-CN")}
              {row.unit && <span className="ml-0.5 text-caption text-text-3">{row.unit}</span>}
            </span>
            {row.note != null && <span className="hidden shrink-0 text-caption tabular-nums text-text-3 sm:inline">{row.note}</span>}
          </>
        );
        return (
          <li key={row.key} data-bar-row={row.key}>
            {onSelect ? (
              <button
                type="button"
                aria-pressed={chosen}
                onClick={() => onSelect(chosen ? null : row.key)}
                className={cn("flex h-sm w-full items-center gap-3 rounded px-2 hover:bg-surface-2", chosen && "bg-accent-soft")}
              >
                {body}
              </button>
            ) : (
              <div className="flex h-sm items-center gap-3 px-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
