import { cn } from "@/lib/cn";
import { StatTile } from "@/components/ui/StatTile";
import { Tooltip } from "@/components/ui/Tooltip";
import type { VcrCountKey, VcrCounts } from "@/lib/vcrClient";
import { countLabel, countText, numberText } from "./vcrText";

/**
 * The counts of a study's headline result, said apart, wherever a sample size matters (plan §3.5):
 * 真实患者数 · 事件数 · 有效样本量 · 生成记录数 — and, when their route was used, 先验有效样本量 and 重建伪个体数 beside them.
 *
 * They are separate numbers and not one because **generating ten thousand virtual patients narrows no interval**. A single
 * 「样本量」 would let a synthetic record stand in for a person, which is the one thing this module exists to make impossible.
 *
 * **Only the numbers that exist are drawn** (R19, audit B §2.4 #6, D §3.3). The band used to be four fixed columns with a
 * placeholder in each: at T0 three of four read 「—」 beside a line that said 「设计阶段：尚无真实患者」 and one that said the records
 * were not patients — a standing sentence under a number to keep the number honest. The honesty is the label (it names the count
 * it is: 生成记录数, never 样本量) and the tile that is not there: a count a study does not have is not on its page. Real patients
 * come with a tier that has them, and a zero that is the truth (`0` real patients) is drawn as the zero it is.
 *
 * Each tile opens what it counts (`DESIGN.md` rule 11): where `tabOf` names a tab, the figure is a link to it.
 */

/** The four, in their fixed order, then the two optional ones. */
const ORDER: readonly VcrCountKey[] = Object.freeze([
  "realPatients", "events", "effectiveSampleSize", "generatedRecords", "priorEffectiveSampleSize", "reconstructedPseudoPatients",
]);

/** The counts a band draws: those the study has, in their order. */
export function presentCounts(counts: VcrCounts | null | undefined): VcrCountKey[] {
  if (!counts) return [];
  return ORDER.filter((key) => typeof counts[key] === "number" && Number.isFinite(counts[key] as number));
}

export function VcrCountsBand({ counts, tabOf, className }: {
  counts: VcrCounts | null | undefined;
  /** Where each count is read: the address of the tab that holds what it counts. */
  tabOf?: (key: VcrCountKey) => string | undefined;
  className?: string;
}) {
  const keys = presentCounts(counts);
  if (!counts || keys.length === 0) return null;
  return (
    <section aria-label="样本量的几个数" data-vcr-counts="" className={className}>
      {counts.scope && <p className="mb-1.5 text-compact text-text-3">{counts.scope}</p>}
      {/* A row of tiles that fills its width however many there are: a grid of fixed columns left a grey hole for each one missing. */}
      <div className="flex flex-wrap gap-px overflow-hidden rounded-panel border border-border bg-border [&>*]:min-w-40 [&>*]:flex-1 [&>*]:bg-surface">
        {keys.map((key) => {
          const value = counts[key] as number;
          const tile = <StatTile key={key} label={countLabel(key)} value={countText(value)} to={tabOf?.(key)} dense />;
          // The rounded 「约 648 万」 is what a reader can hold; the exact figure stays one hover away rather than in the tile.
          return Math.abs(value) >= 10_000
            ? <Tooltip key={key} content={`${countLabel(key)} ${numberText(value, 0)}`}><div data-vcr-count={key}>{tile}</div></Tooltip>
            : <div key={key} data-vcr-count={key}>{tile}</div>;
        })}
      </div>
    </section>
  );
}

/** The same counts as one compact line, for a card that has no room for the band. */
export function VcrCountsLine({ counts, className }: { counts: VcrCounts | null | undefined; className?: string }) {
  const keys = presentCounts(counts);
  if (!counts || keys.length === 0) return null;
  return (
    <p data-vcr-counts-line="" className={cn("flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-text-3", className)}>
      {keys.map((key) => (
        <span key={key} className="whitespace-nowrap">
          {countLabel(key)}
          <span data-vcr-count={key} className="ml-1 font-medium tabular-nums text-text-2">{countText(counts[key] as number)}</span>
        </span>
      ))}
    </p>
  );
}
