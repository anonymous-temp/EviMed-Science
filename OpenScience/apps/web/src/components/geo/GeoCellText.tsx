import type { GeoCell } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import type { GeoUnit } from "./geoText";

/**
 * One GEO number and what it rests on (build spec §0 ruling 8).
 *
 *  - `ok` → the value, and beside it the sample line “310 次里 56 次”.
 *  - `insufficient` (< 30 valid answers) → “样本不足”, never the number,
 *    even though the cell keeps it for the record; the sample line says how
 *    few there were.
 *  - `absent` (the engine was not measured) → “未测”, never zero.
 *  - `not_measurable` because the engine cited titles without links → “引用不可测”
 *    (G8): whether it cited us cannot be told, which is not the same as “—”.
 *  - any other `not_measurable`, or no cell at all → “—”.
 */

/** The word for a citation rate an engine's linkless citations make impossible to take. */
export const GEO_LINKLESS_WORD = "引用不可测";

/** The value on the metric's own scale: 18%, 0.4%, 38. */
export function formatGeoValue(value: number, unit: GeoUnit = "percent"): string {
  if (unit === "count") return String(Math.round(value));
  const rounded = Math.abs(value) >= 1 || value === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit === "percent" ? `${rounded}%` : String(rounded);
}

/** What stands in the value's place: the number, or the word that replaces it. */
export function geoCellWord(cell: GeoCell | null | undefined, unit: GeoUnit = "percent"): string {
  if (!cell) return "—";
  if (cell.status === "insufficient") return "样本不足";
  if (cell.status === "absent") return "未测";
  if (cell.status === "not_measurable" && cell.reason === "citations_without_links") return GEO_LINKLESS_WORD;
  if (cell.status !== "ok" || cell.value === null) return "—";
  return formatGeoValue(cell.value, unit);
}

/**
 * The sample line: “310 次里 56 次” when both counts are known, “310 次回答”
 * when only the denominator is, else null. Absent and unmeasurable cells have
 * none — there was nothing to count.
 */
export function geoSampleText(cell: GeoCell | null | undefined, unit: GeoUnit = "percent"): string | null {
  if (!cell || cell.status === "absent" || cell.status === "not_measurable") return null;
  const n = cell.denominator;
  const k = cell.numerator;
  if (n === null || n <= 0) return null;
  if (unit === "percent" && k !== null && cell.status === "ok") return `${fmt(n)} 次里 ${fmt(k)} 次`;
  return `${fmt(n)} 次回答`;
}

/** “18%，310 次里 56 次” — the value and its sample in one phrase, for a draft or a tooltip. */
export function geoCellPhrase(cell: GeoCell | null | undefined, unit: GeoUnit = "percent"): string {
  const word = geoCellWord(cell, unit);
  const sample = geoSampleText(cell, unit);
  return sample ? `${word}，${sample}` : word;
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

export function GeoCellText({
  cell,
  unit = "percent",
  layout = "inline",
  hideSample = false,
  className,
}: {
  cell: GeoCell | null | undefined;
  unit?: GeoUnit;
  /** `inline`: value then the sample on one line. `stack`: the sample under the value. */
  layout?: "inline" | "stack";
  /** Only where the sample is already stated beside it, in the same row. */
  hideSample?: boolean;
  className?: string;
}) {
  const word = geoCellWord(cell, unit);
  const sample = hideSample ? null : geoSampleText(cell, unit);
  const measured = cell?.status === "ok" && cell.value !== null;
  return (
    <span
      data-geo-cell={cell?.status ?? "none"}
      className={cn(layout === "stack" ? "inline-flex flex-col" : "inline-flex flex-wrap items-baseline gap-x-2", className)}
    >
      <span
        className={cn("tabular-nums", measured ? "text-text" : "text-text-3")}
      >
        {word}
      </span>
      {sample && <span className="text-caption tabular-nums text-text-3">{sample}</span>}
    </span>
  );
}
