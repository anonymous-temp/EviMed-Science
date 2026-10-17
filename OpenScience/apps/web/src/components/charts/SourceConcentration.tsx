import { cn } from "@/lib/cn";
import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";

/**
 * How concentrated the engines' citations are (R19, audit C A.5 信源 row): the share of all citations the busiest sites hold, and
 * how many sites are cited once. Two bars over two different wholes, each said in its own words — a citation is not a site:
 *
 *  - the citations: the top sites' share and the rest's;
 *  - the sites: those cited once, a few times, and often.
 *
 * It is counts of the latest round's answers; the conclusion sentence is the card's title and is built by `concentrationFacts`,
 * which is where the arithmetic is, so it can be tested without a canvas.
 */

export interface ConcentrationFacts {
  /** Sites cited at least once, and every citation they received. */
  sites: number;
  citations: number;
  /** The busiest `top` sites' citations, and `top` itself (a list shorter than it is its own whole). */
  top: number;
  topCitations: number;
  /** Sites by how often they were cited: once, two to four times, five or more. */
  once: number;
  few: number;
  many: number;
}

/** The facts from a list of per-site citation counts (any order, zeros and nothings ignored). */
export function concentrationFacts(counts: ReadonlyArray<number>, top = 15): ConcentrationFacts {
  const cited = counts.filter((count) => Number.isFinite(count) && count > 0).sort((left, right) => right - left);
  const citations = cited.reduce((sum, count) => sum + count, 0);
  return {
    sites: cited.length,
    citations,
    top: Math.min(top, cited.length),
    topCitations: cited.slice(0, top).reduce((sum, count) => sum + count, 0),
    once: cited.filter((count) => count === 1).length,
    few: cited.filter((count) => count >= 2 && count <= 4).length,
    many: cited.filter((count) => count >= 5).length,
  };
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * The card's conclusion: 「前 15 个站占了 31% 的引用」. How many sites were cited once is a fact of the legend under the second bar
 * (「只被引用 1 次 628 个」), not a second sentence of the title: the title says one thing.
 */
export function concentrationTitle(facts: ConcentrationFacts): string {
  if (facts.sites === 0) return "这一轮还没有回答引用任何站点";
  return `前 ${facts.top} 个站占了 ${percent(facts.topCitations, facts.citations)}% 的引用`;
}

export function SourceConcentration({ facts, className }: { facts: ConcentrationFacts; className?: string }) {
  if (facts.sites === 0) return null;
  const rest = facts.citations - facts.topCitations;
  const citationSegments: ShareSegment[] = [
    { key: "top", label: `前 ${facts.top} 个站`, value: facts.topCitations, tone: "own" },
    ...(rest > 0 ? [{ key: "rest", label: "其余的站", value: rest, tone: "quiet" as const }] : []),
  ];
  const siteSegments: ShareSegment[] = [
    { key: "once", label: "只被引用 1 次", value: facts.once, tone: "rival-3" },
    { key: "few", label: "2–4 次", value: facts.few, tone: "rival-2" },
    { key: "many", label: "5 次及以上", value: facts.many, tone: "rival-1" },
  ];
  return (
    <div data-source-concentration="" className={cn("flex flex-col gap-4", className)}>
      <div>
        <p className="mb-1 text-caption text-text-3">{`${facts.citations.toLocaleString("zh-CN")} 次引用`}</p>
        <ShareBar label="引用的集中度" segments={citationSegments} format={(value) => `${Math.round(value)} 次`} />
      </div>
      <div>
        <p className="mb-1 text-caption text-text-3">{`${facts.sites.toLocaleString("zh-CN")} 个站`}</p>
        <ShareBar label="站点被引用的次数" segments={siteSegments} format={(value) => `${Math.round(value)} 个`} />
      </div>
    </div>
  );
}
