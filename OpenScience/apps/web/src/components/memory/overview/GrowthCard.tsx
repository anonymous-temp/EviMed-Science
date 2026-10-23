import { useMemo } from "react";
import { MapChart } from "@/components/charts/MapChart";
import { growthOption } from "@/components/charts/map/growthOption";
import { mapPalette } from "@/components/charts/map/palette";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MapOpen } from "@/lib/memoryMapClient";
import { OverviewCard, Recipe, RecipeButton, type CardState } from "./OverviewCard";
import { LANE_WORDS, partAddress, type Growth, type GrowthEvent } from "./memoryOverviewModel";

/** How tall the strip is: a header's room, and a lane's. */
const AXIS = 44;
const LANE = 34;

/**
 * 成长: what the capsule gained since the first day, on one strip — the capsule's story, and the first card because it is what the owner asked
 * to see grow (V4). A dot for each gain up to thirty, in a lane for each kind that has any (记下 ●, 学会 ▲, 资料 ■, 收下 ◆); weekly counts after
 * that. Its heading is the sentence the strip proves — 「自 9 月 22 日起，记下 18 件、学会 3 种做法、放进 47 份资料」 — and what is replaced or
 * forgotten is not on it: that is the map's 时间 view, one link away.
 *
 * It is the one canvas of the page, so the walk's picture budget is one; the same gains are the rows of the cards below, which is what a
 * reader without a canvas gets. A dot opens what it is: a memory's or a method's drawer; a gain that is one of a count (a document added
 * that day, a pack taken in) opens the part it belongs to.
 */
export function GrowthCard({ state, growth, events, timeZone, onRetry, onOpen, onChat, errorMessage }: {
  state: CardState;
  growth: Growth | null;
  events: readonly GrowthEvent[];
  timeZone: string;
  onRetry: () => void;
  /** A dot opened: its drawer or page, or the part's address. */
  onOpen: (open: MapOpen | null, event: GrowthEvent) => void;
  onChat: () => void;
  errorMessage?: string;
}) {
  const scheme = useColorScheme();
  const option = useMemo(() => (growth && growth.shape !== "none" ? growthOption({ growth, events, timeZone, palette: mapPalette(), formatDay: (day) => formatDay(day) }) : null),
    // The palette is read from the live document, so a flip of the theme is a reason to build the option again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [growth, events, timeZone, scheme]);
  const content = growth && growth.shape !== "none" ? growth : null;
  const title = content?.title ?? "成长";
  return (
    <OverviewCard
      part="growth" title={title} count={content?.total ?? null} shape="strip" state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("growth"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry} height={176}
    >
      {content ? (
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
        <Recipe action={<RecipeButton onPress={onChat}>去对话</RecipeButton>}>记下的事、学会的做法和放进来的资料，每多一件，这里就多一个点。</Recipe>
      )}
    </OverviewCard>
  );
}
