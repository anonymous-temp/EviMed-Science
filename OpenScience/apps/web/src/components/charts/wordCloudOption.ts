import type { EChartsCoreOption } from "echarts/core";
import { escapeTooltip } from "./echartsBase";
import type { MapPalette } from "./map/palette";

/**
 * The topic cloud's option. A word is a topic: its size is the number of memories in it — the same number the ranking beside the
 * cloud prints, so no size is a guess — and its colour is its trend (the brand blue when it grew in the last 30 days, a quiet grey
 * when it held, a lighter grey when it shrank), never a random colour. Nothing is rotated: a Chinese word turned on its side is
 * harder to read, and a cloud that cannot be read is a decoration. A reader's chosen topic is the heavier word.
 */

/** The most words a cloud draws. */
export const CLOUD_WORDS = 40;

export interface CloudTopic {
  id: string;
  label: string;
  weight: number;
  trend: number;
}

export function wordColour(topic: Pick<CloudTopic, "trend">, selected: boolean, palette: MapPalette): string {
  if (selected || topic.trend > 0) return palette.current;
  return topic.trend < 0 ? palette.textFaint : palette.text;
}

/** What hovering a word says. */
export function wordTooltip(topic: CloudTopic): string {
  const trend = topic.trend > 0 ? ` · 近 30 天 +${topic.trend}` : topic.trend < 0 ? ` · 近 30 天 ${topic.trend}` : "";
  return `<div style="max-width:240px;white-space:normal"><strong>${escapeTooltip(topic.label)}</strong></div><div>${topic.weight} 条记忆${escapeTooltip(trend)}</div>`;
}

export function wordCloudOption(topics: readonly CloudTopic[], { selected, palette, fontFamily }: { selected: string | null; palette: MapPalette; fontFamily: string }): EChartsCoreOption {
  const words = [...topics].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id)).slice(0, CLOUD_WORDS);
  const byLabel = new Map(words.map((topic) => [topic.label, topic]));
  return {
    animation: false,
    tooltip: {
      confine: true,
      formatter: (params: { name?: string }) => {
        const topic = byLabel.get(String(params.name));
        return topic ? wordTooltip(topic) : "";
      },
    },
    series: [{
      type: "wordCloud", shape: "circle", left: "center", top: "center", width: "96%", height: "94%",
      sizeRange: [15, 44], rotationRange: [0, 0], rotationStep: 0, gridSize: 16, drawOutOfBound: false, layoutAnimation: false,
      textStyle: { fontFamily, fontWeight: 500 },
      emphasis: { textStyle: { fontWeight: 700 } },
      data: words.map((topic) => ({
        name: topic.label, value: topic.weight, id: topic.id,
        textStyle: { color: wordColour(topic, topic.id === selected, palette), fontWeight: topic.id === selected ? 800 : 500 },
      })),
    }],
  };
}
