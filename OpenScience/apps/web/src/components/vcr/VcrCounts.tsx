import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import type { VcrCountKey, VcrCounts } from "@/lib/vcrClient";
import { countLabel, countText, NO_VALUE, numberText } from "./vcrText";

/**
 * The four counts, said apart, wherever a sample size matters (plan §3.5):
 * 真实患者数 · 事件数 · 有效样本量 · 生成记录数 — and, when their route was
 * used, 先验有效样本量 and 重建伪个体数 beside them.
 *
 * They are four numbers and not one because **generating ten thousand virtual
 * patients narrows no interval**. A single 「样本量」 would let a synthetic
 * record stand in for a person, which is the one thing this module exists to
 * make impossible; the band is fixed on 人群, 对照 and 试验 for the same
 * reason.
 *
 * A count nobody has is 「—」 with its own short line (「设计阶段」「T1 无结局
 * 记录」), never a zero. A zero here is a real zero: 「真实患者数 0」 at T0 is
 * the truth about a design-stage study.
 */

/** The four, in their fixed order, then the two optional ones. */
const FIXED: readonly VcrCountKey[] = Object.freeze(["realPatients", "events", "effectiveSampleSize", "generatedRecords"]);
const OPTIONAL: readonly VcrCountKey[] = Object.freeze(["priorEffectiveSampleSize", "reconstructedPseudoPatients"]);

function shown(counts: VcrCounts): VcrCountKey[] {
  return [...FIXED, ...OPTIONAL.filter((key) => typeof counts[key] === "number" && Number.isFinite(counts[key] as number))];
}

/** No run has counted anything yet: every column reads 「—」, and the band says why. */
const NOT_RUN: VcrCounts = Object.freeze({
  realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: null, note: "尚无运行", scope: null,
});

export function VcrCountsBand({ counts: given, className }: { counts: VcrCounts | null | undefined; className?: string }) {
  // The four are fixed on 人群, 对照 and 试验: a band that vanished when the
  // counts were missing would read as a page that had no sample size at all.
  const counts = given ?? NOT_RUN;
  const keys = shown(counts);
  return (
    <section
      aria-label="样本量的四个数"
      data-vcr-counts=""
      className={cn("rounded-card border border-border bg-surface", className)}
    >
      {/* Below `sm` the scope and the note sit above and below the grid instead of beside it: beside it they left the four labels ~190 px. */}
      <div className="flex flex-col gap-x-8 gap-y-4 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-start">
        {counts.scope && <p className="shrink-0 py-1 text-ui font-medium text-text">{counts.scope}</p>}
        <div className="grid w-full min-w-0 grid-cols-2 gap-x-6 gap-y-4 sm:w-auto sm:flex-1 sm:grid-cols-4 lg:grid-cols-5">
          {keys.map((key) => {
            const value = counts[key];
            const exact = typeof value === "number" && Number.isFinite(value);
            const body = (
              <div className="min-w-0">
                <p className="break-words text-caption text-text-3">{countLabel(key)}</p>
                <p
                  data-vcr-count={key}
                  className={cn("mt-0.5 text-heading font-semibold tabular-nums", exact ? "text-text" : "text-text-3")}
                >
                  {exact ? countText(value) : NO_VALUE}
                </p>
                {counts.notes?.[key] && <p className="mt-0.5 break-words text-caption text-text-3">{counts.notes[key]}</p>}
              </div>
            );
            // The rounded 「约 648 万」 is what a reader can hold; the exact
            // figure stays one hover away rather than in the tile.
            return exact && Math.abs(value) >= 10_000
              ? <Tooltip key={key} content={`${countLabel(key)} ${numberText(value, 0)}`}>{body}</Tooltip>
              : <div key={key}>{body}</div>;
          })}
        </div>
        {counts.note && <p className="text-caption text-text-3 sm:shrink-0 sm:self-center">{counts.note}</p>}
      </div>
    </section>
  );
}

/** The same four as one compact line, for a card that has no room for the band. */
export function VcrCountsLine({ counts: given, className }: { counts: VcrCounts | null | undefined; className?: string }) {
  const counts = given ?? NOT_RUN;
  return (
    <p data-vcr-counts-line="" className={cn("flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-text-3", className)}>
      {shown(counts).map((key) => (
        <span key={key} className="whitespace-nowrap">
          {countLabel(key)}
          <span data-vcr-count={key} className="ml-1 font-medium tabular-nums text-text-2">
            {typeof counts[key] === "number" && Number.isFinite(counts[key] as number) ? countText(counts[key] as number) : NO_VALUE}
          </span>
        </span>
      ))}
      {counts.note && <span>{counts.note}</span>}
    </p>
  );
}
