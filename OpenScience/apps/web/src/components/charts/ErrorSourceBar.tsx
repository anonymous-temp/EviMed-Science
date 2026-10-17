import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";

/**
 * Where the wrong statements came from (R19, audit C A.5 诊断 row): of the errors an engine tells about the product, how many can be
 * traced to a page the engine cited (and so corrected at the page), how many the engine did not tie to any cited page, and how many
 * answers cited nothing at all. A bar over one whole — the errors — in counts.
 *
 * Read from the trace each error already carries (`citedSource.basis` and `.attribute`); the counting is `errorSourceCounts`
 * in `components/geo/spine/errorModel.ts`. With `onSelect` each legend entry narrows the list beside the chart to its errors.
 */
export interface ErrorSourceCounts {
  traced: number;
  unattributable: number;
  noRetrieval: number;
}

/** The three, as the page says them: short enough for a legend, whole enough to stand alone on a row. */
export const ERROR_SOURCE_WORDS: Readonly<Record<keyof ErrorSourceCounts, string>> = Object.freeze({
  traced: "能追到被引用的页面",
  unattributable: "没有对应到某个被引用的页面",
  noRetrieval: "这条回答没有引用任何来源",
});

export function ErrorSourceBar({
  counts,
  selected,
  onSelect,
  className,
}: {
  counts: ErrorSourceCounts;
  selected?: keyof ErrorSourceCounts | null;
  onSelect?: (key: keyof ErrorSourceCounts | null) => void;
  className?: string;
}) {
  const segments: ShareSegment[] = [
    { key: "traced", label: ERROR_SOURCE_WORDS.traced, value: counts.traced, tone: "own" },
    { key: "unattributable", label: ERROR_SOURCE_WORDS.unattributable, value: counts.unattributable, tone: "rival-1" },
    { key: "noRetrieval", label: ERROR_SOURCE_WORDS.noRetrieval, value: counts.noRetrieval, tone: "quiet" },
  ];
  return (
    <ShareBar
      label="讲错的说法的出处"
      segments={segments}
      format={(value) => `${Math.round(value)} 条`}
      selected={selected ?? null}
      onSelect={onSelect ? (key) => onSelect(key as keyof ErrorSourceCounts | null) : undefined}
      className={className}
    />
  );
}
