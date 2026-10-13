import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useColorScheme } from "@/lib/colorScheme";
import { formatDay } from "@/lib/format";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { MapChart } from "@/components/charts/MapChart";
import { useReducedMotion } from "@/components/charts/echartsBase";
import { chainOption, edgeWords, graphOption, isHideableEdge } from "@/components/charts/map/graphOption";
import { layoutGraph } from "@/components/charts/map/layout";
import { mapPalette } from "@/components/charts/map/palette";
import { existingAt, replayStops, type NarrowedMap } from "./mapModel";

/** What the reader can press on the canvas, in one place: a mark is opened, a double press centres the map on it. */
export interface GraphActions {
  onOpen: (node: MapNode) => void;
  onFocus: (node: MapNode) => void;
}

const GRAPH_HEIGHT = 560;

/** Whether the page is a phone's width, kept current: the picture is drawn in smaller marks there. */
function useCompact(): boolean {
  const query = "(max-width: 639px)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

/**
 * The words under the picture that say what its shapes and colours are (spec §2: every encoding is in a legend) — and only the ones
 * the picture has. An account that has replaced nothing has no grey mark, and a legend that named one would be describing a picture
 * it is not looking at.
 */
export function Legend({ nodes }: { nodes: readonly MapNode[] }) {
  const things = nodes.filter((node) => node.type !== "you" && node.type !== "project");
  const has = (test: (node: MapNode) => boolean) => nodes.some(test);
  const states = [
    { tone: "text-accent", word: "现行", shown: things.some((node) => (node.state ?? "current") === "current") },
    { tone: "text-warn", word: "需要看一眼", shown: things.some((node) => node.state === "check") },
    { tone: "text-text-3", word: "已被替代", shown: things.some((node) => node.state === "replaced") },
  ].filter((entry) => entry.shown);
  const decided = (node: MapNode) => node.type === "memory" && (node.subtype === "decision" || node.subtype === "correction");
  const shapes = [
    { word: "● 记忆", shown: has((node) => node.type === "memory" && !decided(node)) },
    { word: "◆ 决定与纠正", shown: has(decided) },
    { word: "■ 资料与知识页", shown: has((node) => node.type === "document" || node.type === "page") },
    { word: "▲ 做法", shown: has((node) => node.type === "method") },
    { word: "▢ 论文与其他来源", shown: has((node) => node.type === "reference") },
    { word: "○ 知识库里的概念", shown: has((node) => node.type === "entity") },
    { word: "⬢ 你、项目与折叠的一组", shown: has((node) => node.type === "you" || node.type === "project" || node.type === "cluster") },
  ].filter((entry) => entry.shown);
  return (
    <div role="group" aria-label="图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-3">
      {states.map((entry) => <span key={entry.word}><span aria-hidden="true" className={entry.tone}>●</span> {entry.word}</span>)}
      {states.length > 0 && shapes.length > 0 && <span aria-hidden="true">·</span>}
      {shapes.map((entry) => <span key={entry.word}>{entry.word}</span>)}
    </div>
  );
}

/**
 * The relation graph with its replay: the marks as laid out once for the whole document (so narrowing or replaying never moves a
 * mark), the picture the library draws from them, and under it the legend and the slider that grows the map from its first day.
 * Played, it adds the marks in the order they began, which is the nearest thing the map has to the sense of having built something.
 */
export function GraphView({ doc, narrowed, selected, actions, chain, focused, onHideEdge }: {
  doc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  selected: string | null;
  actions: GraphActions;
  /** The map is centred on one mark or one group, so what is left out is outside its reach and not folded. */
  focused: boolean;
  /** 「这条关联不对」 on a line: it stays out of this person's map. Absent where the page cannot keep that word. */
  onHideEdge?: (edge: MapEdge) => Promise<void>;
  /** The source chain of the focused memory, in place of the graph. */
  chain: { root: MapNode; rests: Array<{ node: MapNode; state: import("@/lib/memoryMapClient").MapEdge["state"] }>; replaced: MapNode[] } | null;
}) {
  const scheme = useColorScheme();
  const reduced = useReducedMotion();
  const compact = useCompact();
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

  const option = useMemo(() => (chain
    ? chainOption({ ...chain, palette: mapPalette() })
    : graphOption({ nodes: shown.nodes, edges: shown.edges, positions, hits: narrowed.hits, selected, palette: mapPalette(), compact }
  // The palette is read from the live document, so a theme flip is a reason to build the option again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [chain, shown, positions, narrowed.hits, selected, scheme, compact]);

  const byId = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node])), [doc.nodes]);
  // A line pressed on the canvas, read out below it with the one thing the researcher may say about it.
  const edgeById = useMemo(() => new Map((doc.edges as MapEdge[]).filter((edge) => edge.id).map((edge) => [edge.id as string, edge])), [doc.edges]);
  const [pickedEdge, setPickedEdge] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const picked = pickedEdge ? edgeById.get(pickedEdge) ?? null : null;
  const nodeOf = (params: { name?: string; data?: { id?: string; name?: string } }) => byId.get(String(params?.data?.id ?? params?.name ?? params?.data?.name ?? ""));
  const on = {
    click: (params: { name?: string; dataType?: string; data?: { id?: string; edgeId?: string | null } }) => {
      if (params?.dataType === "edge") {
        const edge = params.data?.edgeId ? edgeById.get(params.data.edgeId) : undefined;
        if (edge && onHideEdge) setPickedEdge(edge.id ?? null);
        return;
      }
      setPickedEdge(null);
      const node = nodeOf(params);
      if (node) actions.onOpen(node);
    },
    dblclick: (params: { name?: string; data?: { id?: string } }) => { const node = nodeOf(params); if (node) actions.onFocus(node); },
  };

  const count = shown.nodes.filter((node) => node.type === "memory" && node.state !== "replaced").length;
  return (
    <div className="space-y-2">
      <MapChart
        kind={chain ? "source-chain" : "relations"} option={option} height={chain ? 360 : compact ? 440 : GRAPH_HEIGHT} on={on}
        label={chain ? `这条记忆依据的资料链，共 ${chain.rests.length} 项。` : `记忆、资料和项目之间的关系图，共 ${shown.nodes.length} 个标记，列表在下方。`}
        unpainted={`${shown.nodes.length} 个标记、${shown.edges.length} 条连线。`}
      />
      {!chain && <Legend nodes={shown.nodes} />}
      {!chain && picked && onHideEdge && isHideableEdge(picked, byId.get(picked.from), byId.get(picked.to)) && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-2">
          <span>{edgeWords(picked, byId.get(picked.from)?.label ?? "", byId.get(picked.to)?.label ?? "")}</span>
          <Button
            size="sm" variant="secondary" loading={hiding}
            onClick={() => { setHiding(true); void onHideEdge(picked).then(() => setPickedEdge(null)).finally(() => setHiding(false)); }}
          >
            这条关联不对
          </Button>
          <button type="button" onClick={() => setPickedEdge(null)} className="rounded px-1 text-accent hover:underline">知道了</button>
        </div>
      )}
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
      {!chain && doc.truncated.nodes > 0 && (
        <p className="text-caption text-text-3">{focused ? `还有 ${doc.truncated.nodes} 个标记不在这个范围里。` : `还有 ${doc.truncated.nodes} 个标记折叠在“一组”里，点一组可以展开。`}</p>
      )}
    </div>
  );
}
