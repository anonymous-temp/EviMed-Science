import { cn } from "@/lib/cn";

/**
 * A change between two readings, on a data page (fusion plan §5.9).
 *
 * Three things are said at once, as every status on this product is: a shape
 * (▲ ▼ or nothing), a colour, and a word for assistive technology. Red and
 * green mean opposite things in a Chinese market chart and one reader in
 * twelve cannot tell them apart, so improvement is the brand colour and
 * worsening is plain dark text — red is kept for safety alone (`tone`).
 *
 * `noise` is the measured fluctuation band of the metric. A change inside it
 * is 「持平」, never an arrow: the platform measures a daily wobble of a
 * couple of points, and reporting that as a rise is the single easiest way
 * for a dashboard to lie.
 *
 * A rate's change is in percentage points, never in per cent — 「提升 5%」 is
 * ambiguous and the two were mixed on the old board.
 */

/** Which direction is the good one. 「越低越好」 metrics (风险问句被推荐率) are `down`. */
export type DeltaPolarity = "up" | "down";
/** What the number is counted in: percentage points, index points, or things. */
export type DeltaUnit = "point" | "index" | "count";

const UNIT_WORDS: Record<DeltaUnit, string> = { point: "个百分点", index: "", count: "" };

export interface DeltaProps {
  /** The change, on the metric's own scale; null renders nothing. */
  value: number | null | undefined;
  unit?: DeltaUnit;
  /** The metric's fluctuation band: |value| within it reads 「持平」. */
  noise?: number | null;
  polarity?: DeltaPolarity;
  /** `safety`: a worsening is red, because this one is a clinical risk. */
  tone?: "default" | "safety";
  /** What 「持平」 is called here, when the metric wants other words. */
  flatLabel?: string;
  className?: string;
}

/** Whether the change is an improvement, a worsening, or inside the noise. */
export function deltaSense(
  value: number | null | undefined,
  { noise = null, polarity = "up" }: { noise?: number | null; polarity?: DeltaPolarity } = {},
): "up" | "down" | "flat" | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.abs(value) >= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  if (rounded === 0) return "flat";
  if (typeof noise === "number" && Number.isFinite(noise) && Math.abs(rounded) <= Math.abs(noise)) return "flat";
  const better = polarity === "up" ? rounded > 0 : rounded < 0;
  return better ? "up" : "down";
}

/** 「8」「0.4」 — the size of the change, without a sign. */
export function deltaMagnitude(value: number): string {
  const size = Math.abs(value);
  return String(size >= 1 ? Math.round(size) : Math.round(size * 10) / 10);
}

export function Delta({
  value,
  unit = "point",
  noise = null,
  polarity = "up",
  tone = "default",
  flatLabel = "持平",
  className,
}: DeltaProps) {
  const sense = deltaSense(value, { noise, polarity });
  if (sense === null) return null;
  if (sense === "flat") {
    return (
      <span data-delta="flat" className={cn("inline-flex items-center text-caption font-medium text-text-3", className)}>
        {flatLabel}
      </span>
    );
  }
  const rose = (value as number) > 0;
  const worse = sense === "down";
  return (
    <span
      data-delta={sense}
      className={cn(
        "inline-flex items-center gap-1 text-caption font-medium tabular-nums",
        worse ? (tone === "safety" ? "text-danger" : "text-text-2") : "text-accent",
        className,
      )}
    >
      <span aria-hidden="true">{rose ? "▲" : "▼"}</span>
      {deltaMagnitude(value as number)}
      <span className="sr-only">{`${rose ? "上升" : "下降"}${UNIT_WORDS[unit]}`}</span>
    </span>
  );
}
