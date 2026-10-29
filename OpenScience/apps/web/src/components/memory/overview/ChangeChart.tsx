import { useMemo } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { growthOption } from "@/components/charts/map/growthOption";
import { mapPalette } from "@/components/charts/map/palette";
import { ChartCard } from "@/components/ui/ChartCard";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import { growthLabel, type ChangeEvent, type Growth } from "./memoryOverviewModel";

/** How tall the chart is: a header's room, and a lane's. */
const AXIS = 44;
const LANE = 34;

/**
 * 「变化」: what the capsule gained and lost, on one chart — the page's picture of how it grew, and what it lost. A dot for each change up to
 * thirty, in a lane for each kind that has any (记下 ●, 学会 ▲, 资料 ■, 收下 ◆, 忘记 ✕); weekly counts after that. Its heading is the word and,
 * at its end, the range the toolbar chose in words.
 *
 * A dot opens what it is (a memory's or a method's drawer, the pack's, the forgotten list, the knowledge base); a weekly cell selects its week —
 * the table under the chart narrows to it, and pressing the cell again lets go. The chart and the table are one selection, and the same changes
 * are the table's rows, which is what a reader without a canvas gets.
 */
export function ChangeChart({ state, growth, events, timeZone, words, selectedWeek, onOpenEvent, onSelectWeek, onRetry, errorMessage, emptyText }: {
  state: "loading" | "error" | "content";
  growth: Growth | null;
  events: readonly ChangeEvent[];
  timeZone: string;
  /** The range, said as a heading's end: 「近 30 天」. */
  words: string;
  selectedWeek: string | null;
  onOpenEvent: (event: ChangeEvent) => void;
  /** A weekly cell was pressed: its Monday. */
  onSelectWeek: (start: string) => void;
  onRetry: () => void;
  errorMessage?: string;
  /** What the chart says when nothing changed inside what is selected. */
  emptyText: string;
}) {
  const scheme = useColorScheme();
  const option = useMemo(() => (growth && growth.shape !== "none"
    ? growthOption({ growth, events, timeZone, palette: mapPalette(), formatDay: (day) => formatDay(day), selectedWeek }) : null),
    // The palette is read from the live document, so a flip of the theme is a reason to build the option again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [growth, events, timeZone, selectedWeek, scheme]);
  const content = growth && growth.shape !== "none" ? growth : null;
  return (
    <ChartCard
      title="变化" meta={words}
      state={state === "content" && !content ? "empty" : state} emptyText={emptyText} errorMessage={errorMessage} onRetry={onRetry} height={176}
    >
      {content && (
        <MapChart
          kind="growth" option={option} height={AXIS + content.lanes.length * LANE}
          on={{
            click: (params: { data?: { event?: number; value?: number[] } }) => {
              const dot = params?.data?.event;
              if (typeof dot === "number") { const picked = events[dot]; if (picked) onOpenEvent(picked); return; }
              const cell = params?.data?.value?.[0];
              const week = typeof cell === "number" ? content.weeks[cell] : undefined;
              if (week) onSelectWeek(week.start);
            },
          }}
          label={growthLabel(content, words)}
          unpainted={`变化，${words}。`}
        />
      )}
    </ChartCard>
  );
}
