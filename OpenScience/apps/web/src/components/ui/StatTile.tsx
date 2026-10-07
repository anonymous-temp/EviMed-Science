import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * One number on a data page, and the three things that make it readable: its
 * rank among comparable things, its target, and a change that knows the
 * metric's noise (fusion plan §4.8, appendix E §3.3).
 *
 * The old board printed 「品牌提及率 7%」 alone in four identical grey cards,
 * and a reader could not tell whether 7 was good. A tile therefore carries
 * `rank`, `delta` and `note`, and the leading tile of a band is `lead` — 40 px
 * against 32 px, the reason the 32/40 rungs exist.
 *
 * The denominator is **not** repeated in every tile: a band declares it once
 * in its `footnote`, and a tile that wants it at hand passes `hint`, which
 * becomes the tooltip. 「88 次里 3 次」 twenty times over is noise, and it is
 * what the old diagnosis page did.
 *
 * States: `loading` draws the tile's own skeleton; a number that does not
 * exist is its word (「—」「未测」「样本不足」) in `value`, never a zero.
 *
 * A tile is data, not a section of the document: it is a named group, and its
 * label a paragraph. As an `<h3>` in a `<section>` every tile was a landmark and
 * the page's outline went from its title straight to level three (axe
 * `heading-order`, 2026-10-07 audit B-04).
 */

export interface StatTileProps {
  /** The metric's name. */
  label: string;
  /** The number, or the word that stands in its place. */
  value: ReactNode;
  /** 「%」「/ 100」「条严重讲错」 — the unit, set small beside the number. */
  unit?: ReactNode;
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
  /** The band's leading metric: the 40 px rung. */
  lead?: boolean;
  /** `safety`: the number itself is a clinical count, and is red. */
  tone?: "default" | "safety";
  /** The value is a word standing in for a number (「样本不足」「未测」「—」). */
  placeholder?: boolean;
  /**
   * A tile among several small counts (a stage, a status): on a phone it is
   * padded 12 and its number set at 20 instead of 32, so a band of four takes two
   * short rows (with `StatBand dense`), not a column of tall ones. From `sm` up
   * it is the ordinary tile. Not for the band's leading metric.
   */
  dense?: boolean;
  loading?: boolean;
  className?: string;
}

export function StatTile({
  label,
  value,
  unit,
  rank,
  delta,
  note,
  hint,
  chart,
  lead = false,
  tone = "default",
  placeholder = false,
  dense = false,
  loading = false,
  className,
}: StatTileProps) {
  if (loading) {
    return (
      <div aria-hidden="true" className={cn("flex animate-pulse flex-col gap-3 p-4", dense && "max-sm:gap-2 max-sm:p-3", className)}>
        <div className="h-3 w-16 rounded bg-surface-2" />
        <div className={cn("w-24 rounded bg-surface-2", lead ? "h-10" : "h-8")} />
        <div className="h-3 w-20 rounded bg-surface-2" />
      </div>
    );
  }
  const tile = (
    <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col p-4", dense && "max-sm:p-3", className)}>
      <p className="truncate text-compact text-text-3">{label}</p>
      <p
        data-stat-value
        className={cn(
          "mt-1.5 flex flex-wrap items-baseline gap-x-2 font-semibold tabular-nums",
          // A word does not get a number's size: 「样本不足」 set in 32 px
          // shouts louder than every measurement beside it.
          placeholder ? "text-heading text-text-2" : lead ? "text-metric-lg" : "text-metric",
          dense && !lead && !placeholder && "max-sm:mt-1 max-sm:text-heading",
          !placeholder && (tone === "safety" ? "text-danger-strong" : "text-text"),
        )}
      >
        {value}
        {unit != null && <span className="text-ui font-medium text-text-3">{unit}</span>}
        {rank != null && <Rank>{rank}</Rank>}
      </p>
      {(delta != null || note != null) && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-caption text-text-3">
          {delta}
          {note}
        </p>
      )}
      {chart != null && <div className="mt-2.5">{chart}</div>}
    </div>
  );
  // The sample behind the number, for the pointer that asks; a screen reader
  // hears it as the tile's description.
  return hint ? <Tooltip content={hint}>{tile}</Tooltip> : tile;
}

/** 「第 3 / 6」 beside a number: where it stands among comparable products. */
export function Rank({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-tag shrink-0 items-center rounded-tag bg-accent-soft px-1.5 text-meta font-semibold tabular-nums text-accent-strong">
      {children}
    </span>
  );
}

/**
 * A band of tiles: one card, hairlines between the tiles, and the block's
 * denominator said once underneath (「按 4 个引擎、264 次有效回答计算」).
 * The first tile may be wider than the rest — the composite index is the
 * leading number and its four parts are its decomposition.
 */
/** How many tiles a band spreads across at full width; four to six, no more. */
const BAND_COLUMNS: Record<4 | 5 | 6, string> = {
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

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
  columns?: 4 | 5 | 6;
  /** On a phone, two tiles to a row instead of one (pair it with `StatTile dense`). */
  dense?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={className}>
      {/* The hairlines are the gap: a 1 px grid gap over the border colour
          draws every divider the layout actually has, at any wrap. */}
      <div className={cn("grid gap-px overflow-hidden rounded-panel border border-border bg-border [&>*]:bg-surface", dense ? "grid-cols-2" : "grid-cols-1", BAND_COLUMNS[columns])}>
        {children}
      </div>
      {footnote != null && <p className="mt-2 text-caption text-text-3">{footnote}</p>}
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
export function BulletBar({
  value,
  max = 100,
  target = null,
  targetLabel,
  rival = null,
  rivalLabel,
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
          has(target) ? targetLabel ?? `目标 ${Math.round(target)}` : null,
          has(rival) ? rivalLabel ?? `对手 ${Math.round(rival)}` : null,
        ].filter(Boolean).join("，")}
        data-forced-colors="preserve"
        className="relative h-2 rounded-full bg-surface-2"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: share(value) }} />
        {has(target) && (
          <span data-bullet-target="" className="absolute -top-1 h-4 w-0.5 rounded-full bg-chart-target" style={{ left: share(target) }} />
        )}
        {has(rival) && (
          <span data-bullet-rival="" className="absolute -top-0.5 h-3 w-2 rounded-tag border border-border-control bg-surface" style={{ left: share(rival) }} />
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-meta tabular-nums text-text-3">
        <span>0</span>
        <span className="truncate">
          {[targetLabel, rivalLabel].filter(Boolean).join(" · ")}
        </span>
        <span>{max}</span>
      </div>
    </div>
  );
}
