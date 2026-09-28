import { useMemo } from "react";
import { TrendChart } from "@/components/charts/TrendChart";
import { ChartCard } from "@/components/ui/ChartCard";
import type { MemoryGrowth } from "@/lib/memoryClient";
import { growthCount, growthView } from "./growthModel";

/**
 * 「成长」: how much of the researcher the capsule has come to hold, over time,
 * above the list it counts — the owner's timeline of change and growth
 * (2026-08-23), and the page's one chart.
 *
 * It is the product's one trend chart (`TrendChart`, spec §32.2: a trend is a
 * line), in the brand, with the sentence it proves as its heading and at most
 * three moments on it. It draws nothing until the capsule has a history of two
 * weeks or two months: before that the list is the whole page, which is what
 * every peer's memory page is (research 2026-09-28). A read that fails leaves
 * the page as it was without the chart — the list is what the page is for.
 */
export function CapsuleGrowth({ growth, className }: { growth: MemoryGrowth | null | undefined; className?: string }) {
  const view = useMemo(() => growthView(growth), [growth]);
  if (!view) return null;
  return (
    <ChartCard title={view.title} className={className}>
      <div data-capsule-growth="">
        <TrendChart input={view.input} label={view.title} format={growthCount} height={160} integer unpainted={view.title} />
      </div>
    </ChartCard>
  );
}
