import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import type { VcrConclusion, VcrDataTier, VcrIntendedUse, VcrReviewState, VcrValueSource } from "@/lib/vcrClient";
import { conclusionLabel, reviewLabel, sourceLabel, tierLabel, intendedUseLabel } from "./vcrText";

/**
 * The one visual encoding of where a number came from, used by every page of
 * the module (plan §9.6).
 *
 * Four marks, and the rule behind them is the whole reason they exist:
 *
 *  - **observed** (and the three things derived from an observation) — a solid
 *    line with a solid dot. This is the only mark that means someone measured
 *    a real person.
 *  - **aggregate · reconstructed** — a dashed line. A published summary is not
 *    individual data, and a curve digitised out of a figure is not a curve
 *    anybody measured; **a reconstructed KM is dashed everywhere, always**, so
 *    it can never be read as the real thing.
 *  - **predicted · synthetic** — a light band. A model's output carries its
 *    own spread, and drawing it as a line would hide that.
 *  - **assumed** — a hollow diamond and the word 「假设」 beside the value.
 *
 * The mark is drawn rather than written, because a glyph in a font is not the
 * same shape on Windows; `data-forced-colors="preserve"` keeps it in a
 * Windows contrast theme, where it is the only thing left that says which of
 * the four a number is.
 */

/** Which of the four encodings a source belongs to. */
export type VcrMarkKind = "solid" | "dashed" | "band" | "assumed";

export function markKindOf(source: VcrValueSource | null | undefined): VcrMarkKind {
  switch (source) {
    case "observed": case "extracted": case "calculated": case "imputed": return "solid";
    case "aggregate": case "reconstructed": return "dashed";
    case "predicted": case "synthetic": return "band";
    default: return "assumed";
  }
}

/** The mark alone, 16 × 8, for a tag, a legend entry or a table header. */
export function SourceMark({ source, className }: { source: VcrValueSource | null | undefined; className?: string }) {
  const kind = markKindOf(source);
  return (
    <svg
      aria-hidden="true"
      data-vcr-mark={kind}
      data-forced-colors="preserve"
      viewBox="0 0 16 8"
      className={cn("h-2 w-4 shrink-0", className)}
    >
      {kind === "solid" && (
        <>
          <line x1={0} y1={4} x2={16} y2={4} stroke="currentColor" strokeWidth={1.5} />
          <circle cx={8} cy={4} r={2.4} fill="currentColor" />
        </>
      )}
      {kind === "dashed" && (
        <line x1={0} y1={4} x2={16} y2={4} stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 2.5" />
      )}
      {kind === "band" && (
        <rect x={0} y={1} width={16} height={6} rx={3} fill="currentColor" opacity={0.28} />
      )}
      {kind === "assumed" && (
        <path d="M8 1.2 11 4 8 6.8 5 4Z" fill="none" stroke="currentColor" strokeWidth={1.4} />
      )}
    </svg>
  );
}

/**
 * 「汇总」「观察」「重建」 beside a number: the mark, then the word. Quiet by
 * design — it qualifies a number, it is not a status.
 */
export function SourceTag({ source, className }: { source: VcrValueSource | null | undefined; className?: string }) {
  const label = sourceLabel(source);
  if (!label) return null;
  return (
    <Tag className={cn("gap-1 text-text-3", className)}>
      <SourceMark source={source} />
      {label}
    </Tag>
  );
}

/**
 * The review state, which is a countersignature and never a gate (plan §10.2).
 * 「AI 设定」 is amber — needs a look, not a failure; 「已复核」 is the quiet
 * green; 「复核后有变更」 is grey, because it is a fact about a version, not a
 * problem.
 */
export function ReviewChip({ state, by, at, className }: {
  state: VcrReviewState | null | undefined;
  /** Who signed it, printed after the word where there is room. */
  by?: string | null;
  at?: string | null;
  className?: string;
}) {
  if (!state) return null;
  const word = reviewLabel(state);
  const tail = [by, at].filter(Boolean).join(" ");
  return (
    <Tag
      tone={state === "ai_set" ? "warn" : "neutral"}
      className={cn(state === "reviewed" && "bg-ok-soft text-ok", className)}
    >
      {tail ? `${word}（${tail}）` : word}
    </Tag>
  );
}

/**
 * What the method itself says: 可估计 / 有限制地估计 / 不可估计. Never the
 * same thing as the run state and never the same thing as the review state —
 * that is why the three are three components (plan §3.6).
 */
export function ConclusionChip({ state, className }: { state: VcrConclusion | null | undefined; className?: string }) {
  if (!state) return null;
  return (
    <Tag
      tone={state === "limited" ? "warn" : "neutral"}
      className={cn(state === "estimable" && "bg-ok-soft text-ok", className)}
    >
      {conclusionLabel(state)}
    </Tag>
  );
}

/** The two tags in a study page's header: the data tier and the intended use. */
export function StudyTags({ tier, intendedUse }: { tier: VcrDataTier; intendedUse: VcrIntendedUse }) {
  return (
    <>
      <Tag>{tierLabel(tier)}</Tag>
      <Tag>{intendedUseLabel(intendedUse)}</Tag>
    </>
  );
}

/**
 * The legend entry of a chart series, in the series' own colour and with the
 * mark its source demands. A rival can never pick up the brand: `ours` is the
 * only thing that gets `--chart-own`.
 */
export function SeriesLegend({ label, source, ours = false, tone = 1, children }: {
  label: string;
  source: VcrValueSource | null | undefined;
  ours?: boolean;
  /** Which grey a comparator gets: 1 is the darkest. */
  tone?: 1 | 2 | 3;
  children?: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-text-2">
      <span
        aria-hidden="true"
        data-forced-colors="preserve"
        style={{ color: ours ? "var(--chart-own)" : `var(--chart-rival-${tone})` }}
      >
        <SourceMark source={source} />
      </span>
      {label}
      {children}
    </span>
  );
}

/**
 * The whole provenance key, for a chart that draws more than one kind at once.
 * A page states it where a reader first meets a dashed line, not on every
 * card.
 */
export function ProvenanceKey({ sources, className }: { sources: readonly VcrValueSource[]; className?: string }) {
  const seen = new Set<VcrMarkKind>();
  const shown = sources.filter((source) => {
    const kind = markKindOf(source);
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  if (shown.length === 0) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-3", className)}>
      {shown.map((source) => (
        <span key={source} className="inline-flex items-center gap-1.5">
          <SourceMark source={source} />
          {sourceLabel(source)}
        </span>
      ))}
    </p>
  );
}

/**
 * The colour a chart series takes. Ours is the brand; everything else is a
 * grey, darkest first — a reader must find their own arm without reading a
 * legend (DataTable's rule, kept for SVG).
 */
export function seriesColor(ours: boolean, index = 0): string {
  return ours ? "var(--chart-own)" : `var(--chart-rival-${Math.min(3, index + 1)})`;
}

/** A hint a pointer can ask for, on a mark that abbreviates something. */
export function MarkHint({ hint, children }: { hint: string; children: ReactNode }) {
  return <Tooltip content={hint}><span className="inline-flex items-center">{children}</span></Tooltip>;
}
