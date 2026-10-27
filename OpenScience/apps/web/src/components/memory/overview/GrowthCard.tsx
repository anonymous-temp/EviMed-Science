import { useMemo } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { growthOption } from "@/components/charts/map/growthOption";
import { mapPalette } from "@/components/charts/map/palette";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MapOpen } from "@/lib/memoryMapClient";
import { OverviewCard, Recipe, RecipeButton, type CardState } from "./OverviewCard";
import { List, ListRow } from "@/components/ui/ListRow";
import { LANE_WORDS, partAddress, type Growth, type GrowthEvent } from "./memoryOverviewModel";

/** How tall the strip is: a header's room, and a lane's. */
const AXIS = 44;
const LANE = 34;

/**
 * 成长: what the capsule gained since the first day. The compact overview variant is a five-item recent list, with the full history in
 * the map. The detailed chart has a dot for each gain up to thirty, in a lane for each kind that has any (记下 ●, 学会 ▲, 资料 ■, 收下 ◆); weekly counts after
 * that. Its heading is the sentence the strip proves — 「自 9 月 22 日起，记下 18 件、学会 3 种做法、放进 47 份资料」 — and what is replaced or
 * forgotten is not on it: that is the map's 时间 view, one link away.
 *
 * A detailed chart has a textual alternative. A dot opens what it is: a memory's or a method's drawer; a gain that is one of a count (a document added
 * that day, a pack taken in) opens the part it belongs to.
 * Component: GrowthCard; owner: H; rules: DS14, DS22.7; AT57.
 * Anatomy: Named history summary and a full-history link.
 * Variants: Compact recent list or detailed growth chart.
 * States: Actual loading/error/empty/data state; partial reads retain observed entries without claiming a complete total.
 * Hit area: Native row controls and history link.
 * Keyboard: Native row activation; detailed chart keeps its existing alternative.
 * Long content: Compact history shows five observed entries with a full-history destination.
 * Theme: Shared semantic roles and live chart palette.
 * Responsive: Compact list wraps naturally; chart retains its existing responsive canvas.
 * Verification: MemoryOverviewPage.test.tsx and growthOption tests; v3.2 rendered acceptance.
 */
export function GrowthCard({ state, growth, events, timeZone, onRetry, onOpen, onChat, errorMessage, compact = false, partial = false }: {
  state: CardState;
  growth: Growth | null;
  events: readonly GrowthEvent[];
  timeZone: string;
  onRetry: () => void;
  /** A dot opened: its drawer or page, or the part's address. */
  onOpen: (open: MapOpen | null, event: GrowthEvent) => void;
  onChat: () => void;
  errorMessage?: string;
  /** Overview summaries use a compact history list; the map owns full exploration. */
  compact?: boolean;
  /** Some event sources have not completed; available entries remain readable without a total. */
  partial?: boolean;
}) {
  const scheme = useColorScheme();
  const option = useMemo(() => (!compact && growth && growth.shape !== "none" ? growthOption({ growth, events, timeZone, palette: mapPalette(), formatDay: (day) => formatDay(day) }) : null),
    // The palette is read from the live document, so a flip of the theme is a reason to build the option again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [growth, events, timeZone, scheme, compact]);
  const content = growth && growth.shape !== "none" ? growth : null;
  const title = content?.title ?? "成长";
  const recent = [...events].reverse().slice(0, 5);
  return (
    <OverviewCard
      part="growth" title={compact ? "最近变化" : title} count={partial ? null : content?.total ?? null} shape={compact ? "rows" : "strip"} state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("growth"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry} height={176}
    >
      {content && compact ? (
        <>
          <List label="最近的记忆变化">
            {recent.map((event, index) => <ListRow key={`${event.lane}:${event.day}:${index}`} title={event.title ?? `${LANE_WORDS[event.lane]}有新增`} meta={`${formatDay(event.day)} · ${LANE_WORDS[event.lane]}`} onOpen={() => onOpen(event.open, event)} />)}
          </List>
          {partial ? <p role="status" data-layout-exception="memory-growth-partial" className="mt-2 text-caption text-text-2">仅显示已读取的变化，其他来源尚未完整读取。</p>
            : events.length > recent.length && <p role="note" data-layout-exception="memory-growth-recent" className="mt-2 text-caption text-text-2">已显示最近 {recent.length} 项，更多变化可在地图里查看。</p>}
        </>
      ) : content ? (
        <MapChart
          kind="growth" option={option} height={AXIS + content.lanes.length * LANE}
          on={{
            click: (params: { data?: { event?: number } }) => {
              const picked = typeof params?.data?.event === "number" ? events[params.data.event] : undefined;
              if (picked) onOpen(picked.open, picked);
            },
          }}
          label={`${title}。${content.lanes.map((lane) => `${LANE_WORDS[lane]} ${content.counts[lane]}`).join("，")}，明细在下面各部分里。`}
          unpainted={`${title}。`}
        />
      ) : (
        compact ? <p className="text-ui text-text-2">尚无可显示的变化记录。</p> : <Recipe action={<RecipeButton onPress={onChat}>去对话</RecipeButton>}>记下的事、学会的做法和放进来的资料，每多一件，这里就多一个点。</Recipe>
      )}
    </OverviewCard>
  );
}
