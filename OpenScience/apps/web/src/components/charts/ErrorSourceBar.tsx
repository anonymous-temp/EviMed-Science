import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";

/**
 * Where the wrong statements came from (R19, audit C A.5 诊断 row): of the errors an engine tells about the product, how many can be
 * traced to a page the engine cited (and so corrected at the page), how many the engine did not tie to any cited page, and how many
 * answers cited nothing at all. A bar over one whole — the errors — in counts.
 *
 * Read from the trace each error already carries (`citedSource.basis` and `.attribute`); the counting is `errorSourceCounts`
 * in `components/geo/spine/errorModel.ts`.
 */
export interface ErrorSourceCounts {
  traced: number;
  unattributable: number;
  noRetrieval: number;
}

export function ErrorSourceBar({ counts, className }: { counts: ErrorSourceCounts; className?: string }) {
  const segments: ShareSegment[] = [
    { key: "traced", label: "能追到被引用的页面", value: counts.traced, tone: "own" },
    { key: "unattributable", label: "没有对应到某个被引用的页面", value: counts.unattributable, tone: "rival-1" },
    { key: "noRetrieval", label: "这条回答没有引用任何来源", value: counts.noRetrieval, tone: "quiet" },
  ];
  return <ShareBar label="讲错的说法的出处" segments={segments} format={(value) => `${Math.round(value)} 条`} className={className} />;
}
