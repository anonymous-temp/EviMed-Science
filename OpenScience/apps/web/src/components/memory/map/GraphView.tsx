import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { MapChart } from "@/components/charts/MapChart";
import { useReducedMotion } from "@/components/charts/echartsBase";
import { chainOption, graphOption } from "@/components/charts/map/graphOption";
import { layoutGraph } from "@/components/charts/map/layout";
import { mapPalette } from "@/components/charts/map/palette";
import { existingAt, replayStops, type NarrowedMap } from "./mapModel";

/** What the reader can press on the canvas, in one place: a mark is opened, a double press centres the map on it. */
export interface GraphActions {
  onOpen: (node: MapNode) => void;
  onFocus: (node: MapNode) => void;
}

const GRAPH_HEIGHT = 520;

/** The words under the picture that say what its shapes and colours are (spec §2: every encoding is in a legend). */
function Legend() {
  return (
    <div role="group" aria-label="图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-3">
      <span><span aria-hidden="true" className="text-accent">●</span> 现行</span>
      <span><span aria-hidden="true" className="text-warn">●</span> 需要看一眼</span>
      <span><span aria-hidden="true" className="text-text-3">●</span> 已被替代</span>
      <span aria-hidden="true">·</span>
      <span>● 记忆</span><span>◆ 决定与纠正</span><span>■ 资料</span><span>▲ 做法</span><span>⬢ 你、项目与折叠的一组</span>
    </div>
  );
}

/**
 * The relation graph with its replay: the marks as laid out once for the whole document (so narrowing or replaying never moves a
 * mark), the picture the library draws from them, and under it the legend and the slider that grows the map from its first day.
 * Played, it adds the marks in the order they began, which is the nearest thing the map has to the sense of having built something.
 */
export function GraphView({ doc, narrowed, selected, actions, chain }: {
  doc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  selected: string | null;
  actions: GraphActions;
  /** The source chain of the focused memory, in place of the graph. */
  chain: { root: MapNode; rests: Array<{ node: MapNode; state: import("@/lib/memoryMapClient").MapEdge["state"] }>; replaced: MapNode[] } | null;
}) {
  const scheme = useColorScheme();
  const reduced = useReducedMotion();
  const positions = useMemo(() => layoutGraph(doc.nodes.map((node) => ({
    id: node.id, type: node.type, home: node.projectId ?? (node.type === "project" ? node.id.slice("project:".length) : null), weight: node.weight ?? 0,
  })), doc.edges), [doc.nodes, doc.edges]);

  const stops = useMemo(() => replayStops(narrowed.nodes), [narrowed.nodes]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const moment = cursor === null ? null : stops[Math.min(cursor, stops.length - 1)] ?? null;
  const shown = useMemo(() => existingAt(narrowed, moment), [narrowed, moment]);

  // Played, the slider advances one stop at a time; a reader who asked for less motion steps it by hand.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!playing) return undefined;
    timer.current = setInterval(() => {
      setCursor((held) => {
        const next = (held ?? -1) + 1;
        if (next >= stops.length - 1) setPlaying(false);
        return Math.min(next, Math.max(0, stops.length - 1));
      });
    }, Math.max(60, Math.min(260, 6000 / Math.max(1, stops.length))));
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [playing, stops.length]);
  useEffect(() => { setCursor(null); setPlaying(false); }, [stops.length]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const option = useMemo(() => (chain
    ? chainOption({ ...chain, palette: mapPalette() })
    : graphOption({ nodes: shown.nodes, edges: shown.edges, positions, hits: narrowed.hits, selected, palette: mapPalette() })), [chain, shown, positions, narrowed.hits, selected, scheme]);

  const byId = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node])), [doc.nodes]);
  const nodeOf = (params: { name?: string; data?: { id?: string; name?: string } }) => byId.get(String(params?.data?.id ?? params?.name ?? params?.data?.name ?? ""));
  const on = {
    click: (params: { name?: string; data?: { id?: string } }) => { const node = nodeOf(params); if (node) actions.onOpen(node); },
    dblclick: (params: { name?: string; data?: { id?: string } }) => { const node = nodeOf(params); if (node) actions.onFocus(node); },
  };

  const count = shown.nodes.filter((node) => node.type === "memory" && node.state !== "replaced").length;
  return (
    <div className="space-y-2">
      <MapChart
        kind={chain ? "source-chain" : "relations"} option={option} height={chain ? 360 : GRAPH_HEIGHT} on={on}
        label={chain ? `这条记忆依据的资料链，共 ${chain.rests.length} 项。` : `记忆、资料和项目之间的关系图，共 ${shown.nodes.length} 个标记，列表在下方。`}
        unpainted={`${shown.nodes.length} 个标记、${shown.edges.length} 条连线。`}
      />
      {!chain && <Legend />}
      {!chain && stops.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 text-ui text-text-2">
          <Button
            size="sm" variant="secondary"
            onClick={() => { if (playing) setPlaying(false); else { setCursor(reduced ? stops.length - 1 : 0); setPlaying(!reduced); } }}
          >
            {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {playing ? "暂停" : "回放它是怎么长出来的"}
          </Button>
          <input
            type="range" min={0} max={stops.length - 1} step={1} value={cursor ?? stops.length - 1} aria-label="回放到哪一天"
            onChange={(event) => { setPlaying(false); const next = Number(event.target.value); setCursor(next >= stops.length - 1 ? null : next); }}
            className="min-w-40 flex-1 accent-accent"
          />
          <span className="tabular-nums text-text-3">{moment ? `${formatDay(moment)} · ${count} 件记忆` : `现在 · ${count} 件记忆`}</span>
        </div>
      )}
      {!chain && doc.truncated.nodes > 0 && <p className="text-caption text-text-3">{`还有 ${doc.truncated.nodes} 个标记折叠在“一组”里，点一组可以展开。`}</p>}
    </div>
  );
}
