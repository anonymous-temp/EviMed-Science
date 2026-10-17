import { useMemo } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { activityOption } from "@/components/charts/map/activityOption";
import { mapPalette } from "@/components/charts/map/palette";
import { ChartCard } from "@/components/ui/ChartCard";
import { useColorScheme } from "@/lib/colorScheme";
import type { MemoryMap } from "@/lib/memoryMapClient";

/** The six steps of the calendar's hue, as classes Tailwind can see. */
const HEAT = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4", "bg-heat-5"] as const;

/**
 * 「活跃」: the last year as a calendar (spec §2, V5). A day is a button: it narrows the map to that day, and the list under the
 * calendar says what was remembered then. Nothing here counts days in a row, and a quiet day is the page's own grey, not a gap.
 * The card's heading is what the calendar adds up to, its legend the scale (少 → 多), and the zone the days are counted in is its
 * footnote; a day that was chosen is let go of from the card's header.
 */
export function ActivityView({ doc, range, onDay }: { doc: Pick<MemoryMap, "buckets" | "scope">; range: string; onDay: (day: string | null) => void }) {
  const scheme = useColorScheme();
  const today = doc.scope.range.to;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const option = useMemo(() => activityOption({ series: doc.buckets.series, today, palette: mapPalette() }), [doc.buckets.series, today, scheme]);
  const total = doc.buckets.series.reduce((sum, day) => sum + day.memory + day.run + day.method + day.feedback, 0);
  const chosen = /^(\d{4}-\d{2}-\d{2})\.\.\1$/u.exec(range)?.[1] ?? null;
  const days = doc.buckets.series.length;
  if (days === 0) return <ChartCard level={2} title="近一年的活跃" state="empty" emptyText="一年里还没有记录，和 EviMed 聊几次之后，这里会有颜色。" />;
  return (
    <ChartCard
      level={2}
      title={`近一年有 ${days} 天有记录，共 ${total} 件`}
      meta={chosen ? <button type="button" onClick={() => onDay(null)} className="rounded px-1 text-accent hover:underline">{`看的是 ${chosen}，看全部`}</button> : undefined}
      legend={<span className="inline-flex items-center gap-1 text-caption text-text-3" aria-hidden="true">少{HEAT.map((step) => <span key={step} className={`inline-block h-3 w-3 rounded-tag ${step}`} />)}多</span>}
    >
      <MapChart
        kind="activity" option={option} height={196}
        on={{ click: (params: { value?: [string, number] }) => { const day = params?.value?.[0]; if (day) onDay(day === chosen ? null : day); } }}
        label={`近一年的活跃日历，共 ${days} 天有记录，当天记下的事在下方。`}
        unpainted={`${days} 天有记录。`}
      />
      <span className="sr-only">{`按你的时区（${doc.scope.timeZone}）计日`}</span>
    </ChartCard>
  );
}
