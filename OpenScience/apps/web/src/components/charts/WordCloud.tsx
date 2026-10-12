import { useEffect, useMemo, useState } from "react";
import { useColorScheme } from "@/lib/colorScheme";
import { canPaintChart, useEChart } from "./echartsBase";
import "./map/register";
import { mapPalette } from "./map/palette";
import { wordCloudOption, type CloudTopic } from "./wordCloudOption";

/**
 * The one place the word-cloud series is registered. It is a small plugin (about 6 KB gzipped) whose peer range still says
 * ECharts 5 (`pnpm.peerDependencyRules` allows 6 for it), pinned exactly in package.json, and kept behind this file so it can be
 * swapped for another layout without a page noticing. It is loaded when a cloud is first wanted and only where a canvas can be
 * painted — the plugin refuses to load without one, which a test and a printed page do not have — so the topics view is the only
 * part of the map that ever downloads it.
 */
function useWordCloudPlugin(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canPaintChart()) return undefined;
    let cancelled = false;
    void import("echarts-wordcloud").then(() => { if (!cancelled) setReady(true); }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  return ready;
}

/**
 * The topic cloud. A word opens its topic (`onChoose`); the ranking beside it carries every number the sizes stand for and is
 * what a screen reader is given, so the canvas is a picture of it and not the only way in.
 */
export function WordCloud({ topics, selected, onChoose, label, height = 340 }: {
  topics: readonly CloudTopic[];
  selected: string | null;
  onChoose: (id: string) => void;
  label: string;
  height?: number;
}) {
  const scheme = useColorScheme();
  const ready = useWordCloudPlugin();
  // The palette is read from the live document, so a theme flip is a reason to build the option again.
  const option = useMemo(() => (!ready || topics.length === 0 ? null : wordCloudOption(topics, {
    selected, palette: mapPalette(), fontFamily: typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily || "sans-serif",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [topics, selected, scheme, ready]);
  const host = useEChart(option, { on: { click: (params: { data?: { id?: string } }) => { if (params?.data?.id) onChoose(params.data.id); } } });
  return (
    <figure data-chart="topic-cloud" data-chart-words={topics.length} className="m-0 min-w-0">
      <div ref={host} role="img" aria-label={label} style={{ height }} className="w-full" />
      {!canPaintChart() && <figcaption className="text-caption text-text-3">{topics.length} 个主题。</figcaption>}
    </figure>
  );
}
