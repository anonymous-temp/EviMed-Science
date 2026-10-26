import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import type { Measured, MetricReading } from "@/lib/measurement";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Component: StatTile; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: label, typed reading, context and optional drill-down.
 * Variants: default, safety, dense and leading.
 * States: initial loading, measured, unmeasured and failed with prior value.
 * Hit area: numeric link/button retains its visible figure.
 * Keyboard: native link/button activation.
 * Long content: labels truncate; context wraps.
 * Theme: semantic ink and safety roles.
 * Responsive: dense numbers shrink on narrow screens.
 * Verification: DataPrimitives, Marks and measurement adapter tests.
 */
export interface StatTileProps {
  /** The metric's name. */
  label: string;
  /** The number, or the word that stands in its place. */
  reading: MetricReading;
  renderMeasured?: (reading: Measured) => ReactNode;
  /** 「%」「/ 100」「条严重讲错」 — the unit, set small beside the number. */
  /** 「第 3 / 6」 — where this stands among comparable products. */
  rank?: ReactNode;
  /** A `<Delta>`. */
  delta?: ReactNode;
  /** The words after the delta: 「较基线 · 目标 65」. */
  note?: ReactNode;
  /** The sample the number rests on, as a tooltip — never printed in the tile. */
  hint?: string;
  /** A sparkline or a `BulletBar` under the number. */
  chart?: ReactNode;
  /** The page that lists what the number counts. */
  to?: string;
  /** Or: opens it in place (a drawer, the list narrowed). */
  onOpen?: () => void;
  /** The band's leading metric: the 40 px rung. */
  lead?: boolean;
  /** `safety`: the number itself is a clinical count, and is red. */
  tone?: "default" | "safety";
  /** The value is a word standing in for a number (「样本不足」「未测」「—」). */
  /**
   * A tile among several small counts (a stage, a status): on a phone it is
   * padded 12 and its number set at 20 instead of 32, so a band of four takes two
   * short rows (with `StatBand dense`), not a column of tall ones. From `sm` up
   * it is the ordinary tile. Not for the band's leading metric.
   */
  dense?: boolean;
  className?: string;
}

export function StatTile({
  label,
  reading,
  renderMeasured,
  rank,
  delta,
  note,
  hint,
  chart,
  to,
  onOpen,
  lead = false,
  tone = "default",
  dense = false,
  className,
}: StatTileProps) {
  if (reading.kind === "loading") {
    return (
      <div aria-hidden="true" className={cn("flex animate-pulse flex-col gap-3 p-4", dense && "max-sm:gap-2 max-sm:p-3", className)}>
        <div className="h-3 w-16 rounded bg-surface-2" />
        <div className={cn("w-24 rounded bg-surface-2", lead ? "h-10" : "h-8")} />
        <div className="h-3 w-20 rounded bg-surface-2" />
      </div>
    );
  }
  const measured = reading.kind === "measured" ? reading : reading.kind === "failed" ? reading.previous : undefined;
  const placeholder = measured === undefined;
  const value = measured ? renderMeasured?.(measured) ?? measured.value.toLocaleString("zh-CN") : reading.kind === "unmeasured" ? reading.reason : "读取失败";
  const unit = measured?.unit;
  const opens = !placeholder && (to !== undefined || onOpen !== undefined);
  const tile = (
    <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col p-4", dense && "max-sm:p-3", className)}>
      <p className="truncate text-caption text-text-3">{label}</p>
      {measured && <span className="sr-only">{measured.scope}{measured.observedAt && formatDateTime(measured.observedAt) ? ` · 观测于 ${formatDateTime(measured.observedAt)}` : ""}</span>}
      <p
        data-stat-value
        className={cn(
          "mt-1.5 flex flex-wrap items-baseline gap-x-2 font-semibold tabular-nums",
          // A word does not get a number's size: 「样本不足」 set in 32 px
          // shouts louder than every measurement beside it.
          placeholder ? "text-section text-text-2" : "text-metric",
          dense && !lead && !placeholder && "max-sm:mt-1 max-sm:text-heading",
          !placeholder && (tone === "safety" ? "text-danger-strong" : "text-text"),
        )}
      >
        {opens ? <OpenNumber label={label} value={value} to={to} onOpen={onOpen} /> : value}
        {unit != null && <span className="text-ui font-normal text-text-3">{unit}</span>}
        {rank != null && <Rank>{rank}</Rank>}
      </p>
      {(delta != null || note != null) && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-caption text-text-3">
          {delta}
          {note}
        </p>
      )}
      {reading.kind === "failed" && <p role="alert" className="mt-2 text-caption text-error">{reading.error}{measured && " · 显示上次读数"}<button type="button" onClick={reading.retry} className="ml-2 underline">重试</button></p>}
      {chart != null && <div className="mt-2.5">{chart}</div>}
    </div>
  );
  // The sample behind the number, for the pointer that asks; a screen reader
  // hears it as the tile's description.
  return hint ? <Tooltip content={hint}>{tile}</Tooltip> : tile;
}

/** The figure as a link or a button: its name is the tile's label and the figure, so a screen reader hears what it opens. */
function OpenNumber({ label, value, to, onOpen }: { label: string; value: ReactNode; to?: string; onOpen?: () => void }) {
  const name = typeof value === "string" || typeof value === "number" ? `${label} ${value}，查看` : undefined;
  const look = "rounded hover:underline hover:decoration-border-control hover:underline-offset-4";
  if (to !== undefined) return <Link to={to} aria-label={name} className={look}>{value}</Link>;
  return <button type="button" aria-label={name} onClick={onOpen} className={look}>{value}</button>;
}

/** 「第 3 / 6」 beside a number: where it stands among comparable products. */
/**
 * Component: Rank; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Static inline rank content beside a metric.
 * Variants: Caller content; no action variant.
 * States: No inferred rank or verification state.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Intrinsic rank text; no truncation.
 * Theme: Current implementation uses accent-soft/accent.
 * Responsive: Nonshrinking h-tag inline badge.
 * Verification: DataPrimitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Rank({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-tag shrink-0 items-center rounded-tag bg-accent-soft px-1.5 text-meta font-normal tabular-nums text-accent">
      {children}
    </span>
  );
}

/**
 * A band of tiles: one card, hairlines between the tiles, and the block's
 * denominator said once underneath (「按 4 个引擎、264 次有效回答计算」).
 * The first tile may be wider than the rest — the composite index is the
 * leading number and its four parts are its decomposition.
 *
 * The hairlines are the tiles' own: each has a line on its left and its top,
 * pulled 1 px outside the box so the band's clip takes the ones on its edge and
 * the band's own border is the outline. They used to be the grid's gap over a
 * border-coloured ground, and a band with fewer tiles than columns — two tiles
 * of four, five at the width of three — showed that ground as a grey block where
 * the tiles ran out. Now the room a row does not fill is the card's own white.
 */
/** How many tiles a band spreads across at full width: as many as it has, up to six. */
const BAND_COLUMNS: Record<2 | 3 | 4 | 5 | 6, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

/**
 * Component: StatBand; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Named section with shared described-by footnote and bordered metric grid.
 * Variants: Two through six target columns; dense narrow layout.
 * States: Children own reading states; footnote renders once per band.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Shared footnote retained; grid children must manage long values.
 * Theme: Neutral surface and cell borders.
 * Responsive: One or dense two columns initially; sm/lg/xl expand by configured count.
 * Verification: DataPrimitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function StatBand({
  label,
  footnote,
  columns = 6,
  dense = false,
  className,
  children,
}: {
  /** The band's accessible name. */
  label: string;
  /** The denominator, and anything else true of every number above it. */
  footnote?: ReactNode;
  columns?: 2 | 3 | 4 | 5 | 6;
  /** On a phone, two tiles to a row instead of one (pair it with `StatTile dense`). */
  dense?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const footnoteId = useId();
  return (
    <section aria-label={label} aria-describedby={footnote != null ? footnoteId : undefined} className={className}>
      {/* Every tile's left and top line, 1 px out of its box: a divider wherever two tiles meet, at any wrap, and none on the band's
          edge (the clip takes it). */}
      <div
        className={cn(
          "grid overflow-hidden rounded-panel border border-border bg-surface [&>*]:-ml-px [&>*]:-mt-px [&>*]:border-l [&>*]:border-t [&>*]:border-border",
          dense ? "grid-cols-2" : "grid-cols-1",
          BAND_COLUMNS[columns],
        )}
      >
        {children}
      </div>
      {footnote != null && <p id={footnoteId} data-note="" className="mt-2 text-caption text-text-3">{footnote}</p>}
    </section>
  );
}

/**
 * The measure under a composite index: how far along we are, where the target
 * sits, and where the leading rival stands — the one picture that answers
 * “61 算好还是不好” without a second chart (appendix E §4.1: a bullet, never
 * a gauge, because a gauge can only carry one value). Its fills are the data,
 * so it keeps them in a Windows contrast theme (spec §10.9 rule 6).
 */
/**
 * Component: BulletBar; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Accessible image of measured value with optional baseline/target/rival markers.
 * Variants: Optional scale and marker labels.
 * States: Missing/nonfinite value hides; valid marker positions clamp to bar bounds.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Accessible label retains rounded marker descriptions; scale middle label truncates.
 * Theme: Accent value, chart target, neutral rival; data colors preserved in forced colors.
 * Responsive: Fluid track; fixed-height marks.
 * Verification: DataPrimitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function BulletBar({
  value,
  max = 100,
  target = null,
  targetLabel,
  rival = null,
  rivalLabel,
  baseline = null,
  baselineLabel,
  scale = true,
  label,
}: {
  value: number | null;
  max?: number;
  /** The chosen tier's target on the same scale. */
  target?: number | null;
  targetLabel?: string;
  /** The leading rival's value on the same scale. */
  rival?: number | null;
  rivalLabel?: string;
  /** Where it began, on the same scale: a short quiet tick under the target's, so 「基线 → 现在 → 目标」 is one picture. */
  baseline?: number | null;
  baselineLabel?: string;
  /** The line of 0, the labels and the maximum under the bar. A bar in a column of its own words (a plan's tier) leaves it out. */
  scale?: boolean;
  /** The bar's accessible name. */
  label: string;
}) {
  const share = (level: number) => `${Math.max(0, Math.min(100, (level / max) * 100))}%`;
  const has = (level: number | null): level is number => typeof level === "number" && Number.isFinite(level);
  if (!has(value)) return null;
  return (
    <div>
      <div
        role="img"
        aria-label={[
          `${label} ${Math.round(value)}`,
          has(baseline) ? baselineLabel ?? `基线 ${Math.round(baseline)}` : null,
          has(target) ? targetLabel ?? `目标 ${Math.round(target)}` : null,
          has(rival) ? rivalLabel ?? `对手 ${Math.round(rival)}` : null,
        ].filter(Boolean).join("，")}
        data-forced-colors="preserve"
        className="relative h-2 rounded-full bg-surface-2"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: share(value) }} />
        {has(baseline) && (
          <span data-bullet-baseline="" className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-text-3" style={{ left: share(baseline) }} />
        )}
        {has(target) && (
          <span data-bullet-target="" className="absolute -top-1 h-4 w-0.5 rounded-full bg-chart-target" style={{ left: share(target) }} />
        )}
        {has(rival) && (
          <span data-bullet-rival="" className="absolute -top-0.5 h-3 w-2 rounded-tag border border-border-control bg-surface" style={{ left: share(rival) }} />
        )}
      </div>
      {scale && (
        <div className="mt-1.5 flex items-baseline justify-between gap-2 text-meta tabular-nums text-text-3">
          <span>0</span>
          <span className="truncate">
            {[targetLabel, rivalLabel].filter(Boolean).join(" · ")}
          </span>
          <span>{max}</span>
        </div>
      )}
    </div>
  );
}
