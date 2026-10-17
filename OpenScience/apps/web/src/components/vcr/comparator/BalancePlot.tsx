import type { VcrProfileRow } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { isPlaceholder, valueText } from "../vcrText";

/**
 * How well the two populations match, covariate by covariate, as one plot (R19, plan §5.3; audit B §4.4: 「平衡 SMD 点图（现在是表）」).
 *
 * Each row is a covariate's standardized difference on a shared 0-to-max axis with the 0.1 floor drawn: a hollow dot where it stood
 * before the weighting, a solid one where it stands after, and a hairline between them so the weighting's work is the distance the
 * eye travels. A dot past the floor is amber — shape and colour together, and the numbers stand beside the plot in the same order,
 * so nothing is read off a position alone. The plot reports the server's numbers and works nothing out.
 *
 * Hidden knowledge:
 *  - **Without a weighting there is one dot**: the difference as it is. The legend then says 「标准化差异」 and not 「加权后」.
 *  - **The axis is shared by every row**, so two covariates are comparable by eye; it runs to at least 0.4 so a well-balanced
 *    table is not stretched to fill the box.
 *  - The two populations' own levels (「62 岁 / 61 岁」) are in the row's name for a screen reader and, when the server sent them,
 *    under the covariate's name; most covariates carry none and nothing is drawn for those.
 */
export function BalancePlot({ rows, floor = 0.1 }: { rows: readonly VcrProfileRow[]; floor?: number }) {
  const weighted = rows.some((row) => row.smdBefore != null);
  const highest = Math.max(...rows.flatMap((row) => [Math.abs(row.smd ?? 0), Math.abs(row.smdBefore ?? 0)]), 0);
  const max = Math.max(0.4, Math.ceil(highest * 10) / 10);
  const at = (value: number) => `${Math.min(100, (Math.abs(value) / max) * 100)}%`;
  return (
    <div data-vcr-balance="" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-2">
        {weighted && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" data-forced-colors="preserve" className="inline-block h-2.5 w-2.5 rounded-full border-2 border-text-2 bg-bg" />
            加权前
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" data-forced-colors="preserve" className="inline-block h-2 w-2 rounded-full bg-text-graphic" />
          {weighted ? "加权后" : "标准化差异"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" data-forced-colors="preserve" className="inline-block h-3 w-px bg-border-control" />
          {`界值 ${floor}`}
        </span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => {
          const after = row.smd ?? null;
          const before = row.smdBefore ?? null;
          const over = typeof after === "number" && Math.abs(after) >= floor;
          const levels = !isPlaceholder(row.ours) || !isPlaceholder(row.theirs) ? `本研究 ${valueText(row.ours)} · 对照 ${valueText(row.theirs)}` : null;
          const name = [
            `${row.label} 标准化差异`,
            before !== null ? `加权前 ${before.toFixed(2)}` : null,
            after !== null ? `${before !== null ? "加权后" : ""} ${after.toFixed(2)}`.trim() : null,
            over ? "超过界值" : null,
            levels,
          ].filter(Boolean).join("，");
          return (
            <li key={row.key} data-vcr-balance-row={row.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_5.5rem] items-center gap-3 max-sm:grid-cols-[minmax(0,1fr)_5.5rem]">
              <span className="min-w-0 max-sm:col-span-2">
                <span className="block truncate text-ui text-text">{row.label}</span>
                {levels && <span className="block truncate text-caption text-text-3">{levels}</span>}
              </span>
              <span role="img" aria-label={name} data-vcr-smd={over ? "over" : "under"} data-forced-colors="preserve" className="relative block h-4">
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span className="absolute inset-y-0.5 w-px bg-border-control" style={{ left: at(floor) }} />
                {before !== null && after !== null && (
                  <span
                    className="absolute top-1/2 h-px -translate-y-1/2 bg-text-3"
                    style={{ left: at(Math.min(Math.abs(before), Math.abs(after))), width: `${(Math.abs(Math.abs(before) - Math.abs(after)) / max) * 100}%` }}
                  />
                )}
                {before !== null && (
                  <span data-vcr-smd-before="" className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-text-2 bg-bg" style={{ left: at(before) }} />
                )}
                {after !== null && (
                  <span className={cn("absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full", over ? "bg-warn" : "bg-text-graphic")} style={{ left: at(after) }} />
                )}
              </span>
              <span className={cn("text-right text-caption tabular-nums", over ? "font-medium text-warn-strong" : "text-text-2")}>
                {before !== null ? `${before.toFixed(2)} → ` : ""}{after !== null ? after.toFixed(2) : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
