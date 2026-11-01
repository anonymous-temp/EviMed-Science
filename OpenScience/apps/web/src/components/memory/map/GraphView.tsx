import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EChartsType } from "echarts/core";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { useColorScheme } from "@/lib/colorScheme";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { MapChart } from "@/components/charts/MapChart";
import { edgeWords, graphOption, isHideableEdge } from "@/components/charts/map/graphOption";
import { layoutGraph } from "@/components/charts/map/layout";
import { mapPalette } from "@/components/charts/map/palette";
import { relationTitle, type NarrowedMap } from "./mapModel";

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

const decided = (node: MapNode) => node.type === "memory" && (node.subtype === "decision" || node.subtype === "correction");
/** The shapes of the picture, what each is called and which marks it is. The structure holds the picture together and cannot be pressed away. */
const LEGEND_SHAPES: ReadonlyArray<{ word: string; test: (node: MapNode) => boolean; structure?: boolean }> = [
  { word: "● 记忆", test: (node) => node.type === "memory" && !decided(node) },
  { word: "◆ 决定与纠正", test: decided },
  { word: "■ 资料与知识页", test: (node) => node.type === "document" || node.type === "page" },
  { word: "▲ 做法", test: (node) => node.type === "method" },
  { word: "▢ 论文与其他来源", test: (node) => node.type === "reference" },
  { word: "○ 知识库里的概念", test: (node) => node.type === "entity" },
  { word: "⬢ 你、项目与折叠的一组", test: (node) => node.type === "you" || node.type === "project" || node.type === "cluster", structure: true },
];

/**
 * The words under the picture that say what its shapes and colours are (spec §2: every encoding is in a legend) — and only the ones
 * the picture has. An account that has replaced nothing has no grey mark, and a legend that named one would be describing a picture
 * it is not looking at. Each shape says how many it holds, and a press hides it.
 */
export function Legend({ nodes, hidden, onToggle }: {
  nodes: readonly MapNode[];
  /** The shapes pressed away. */
  hidden: ReadonlySet<string>;
  onToggle: (shape: string) => void;
}) {
  const things = nodes.filter((node) => node.type !== "you" && node.type !== "project");
  const count = (test: (node: MapNode) => boolean) => nodes.filter(test).length;
  const states = [
    { tone: "text-accent", word: "现行", shown: things.some((node) => (node.state ?? "current") === "current") },
    { tone: "text-warn", word: "需要看一眼", shown: things.some((node) => node.state === "check") },
    { tone: "text-text-3", word: "已被替代", shown: things.some((node) => node.state === "replaced") },
  ].filter((entry) => entry.shown);
  const shapes = LEGEND_SHAPES.map((shape) => ({ ...shape, count: count(shape.test) })).filter((shape) => shape.count > 0);
  return (
    <div role="group" aria-label="图例，按一下隐藏这一类" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui text-text-3">
      {states.map((entry) => <span key={entry.word}><span aria-hidden="true" className={entry.tone}>●</span> {entry.word}</span>)}
      {states.length > 0 && shapes.length > 0 && <span aria-hidden="true">·</span>}
      {shapes.map((shape) => (
        shape.structure
          ? <span key={shape.word}>{shape.word} {shape.count}</span>
          : <button key={shape.word} type="button" aria-pressed={!hidden.has(shape.word)} onClick={() => onToggle(shape.word)} className={`transition-colors duration-fast hover:text-text ${hidden.has(shape.word) ? "opacity-disabled" : ""}`}>{shape.word} {shape.count}</button>
      ))}
    </div>
  );
}

/**
 * The relation graph, in one card: the marks as laid out once for the whole document (so narrowing never moves a mark) and the picture the
 * library draws from them. The card's heading says what it holds, its legend names only the shapes and colours in it, and `meta` is where the
 * page puts the switch to the topics. A line pressed on the canvas is read out below it with the one thing the researcher may say about it.
 */
export function GraphView({ doc, narrowed, selected, actions, onHideEdge, meta }: {
  doc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  selected: string | null;
  actions: GraphActions;
  /** 「这条关联不对」 on a line: it stays out of this person's map. Absent where the page cannot keep that word. */
  onHideEdge?: (edge: MapEdge) => Promise<void>;
  /** At the heading's end: the switch between the graph and the topics. */
  meta?: ReactNode;
}) {
  const scheme = useColorScheme();
  const compact = useCompact();
  const positions = useMemo(() => layoutGraph(doc.nodes.map((node) => ({
    id: node.id, type: node.type, home: node.projectId ?? (node.type === "project" ? node.id.slice("project:".length) : null), weight: node.weight ?? 0,
  })), doc.edges), [doc.nodes, doc.edges]);

  // What the legend has pressed away is this card's own, and the rest of the page does not narrow with it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggleShape = (word: string) => setHidden((held) => {
    const next = new Set(held);
    if (next.has(word)) next.delete(word); else next.add(word);
    return next;
  });
  const drawn = useMemo(() => {
    if (!hidden.size) return narrowed;
    const away = LEGEND_SHAPES.filter((shape) => hidden.has(shape.word));
    const nodes = narrowed.nodes.filter((node) => !away.some((shape) => shape.test(node)));
    const kept = new Set(nodes.map((node) => node.id));
    return { ...narrowed, nodes, edges: narrowed.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) };
  }, [narrowed, hidden]);
  const option = useMemo(() => graphOption({ nodes: drawn.nodes, edges: drawn.edges, positions, hits: drawn.hits, selected, palette: mapPalette(), compact }),
    // The palette is read from the live document, so a theme flip is a reason to build the option again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawn, positions, selected, scheme, compact]);
  const chart = useRef<EChartsType | null>(null);
  /** 回正: back to the picture as it first stood, after the reader has dragged and zoomed it. */
  const home = () => { if (option) chart.current?.setOption(option, { notMerge: true }); };

  const byId = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node])), [doc.nodes]);
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

  return (
    <ChartCard
      title={relationTitle(narrowed.nodes)}
      legend={<Legend nodes={narrowed.nodes} hidden={hidden} onToggle={toggleShape} />}
      meta={<div className="flex items-center gap-2"><Button size="sm" variant="text" onClick={home}>回正</Button>{meta}</div>}
      footnote={doc.truncated.nodes > 0 ? `还有 ${doc.truncated.nodes} 个标记折叠在“一组”里，点一组可以打开它的列表。` : undefined}
    >
      <div className="space-y-2">
        <MapChart
          kind="relations" option={option} chart={chart} height={compact ? 440 : GRAPH_HEIGHT} on={on}
          label={`记忆、资料和项目之间的关系图，共 ${drawn.nodes.length} 个标记，列表在下方。`}
          unpainted={`${drawn.nodes.length} 个标记、${drawn.edges.length} 条连线。`}
        />
        {picked && onHideEdge && isHideableEdge(picked, byId.get(picked.from), byId.get(picked.to)) && (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-2">
            <span>{edgeWords(picked, byId.get(picked.from)?.label ?? "", byId.get(picked.to)?.label ?? "")}</span>
            <Button
              size="sm" variant="secondary" loading={hiding}
              onClick={() => { setHiding(true); void onHideEdge(picked).then(() => setPickedEdge(null)).finally(() => setHiding(false)); }}
            >
              这条关联不对
            </Button>
            <Button size="sm" variant="text" onClick={() => setPickedEdge(null)}>知道了</Button>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
