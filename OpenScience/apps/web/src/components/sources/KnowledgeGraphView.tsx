import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Crosshair, MessageSquare } from "lucide-react";
import { MapChart } from "@/components/charts/MapChart";
import { mapPalette } from "@/components/charts/map/palette";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { Tag } from "@/components/ui/Tag";
import { useColorScheme } from "@/lib/colorScheme";
import { readerPath, type KnowledgeListState } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import { getKnowledgeGraph, type KnowledgeGraph } from "@/lib/sourceClient";
import {
  evidenceOf, foldId, hueOfTypes, isFold, isThin, linesBetween, listedMarks, modelOf, neighbourhood, overview, searchHits, withoutIndexLines, type GraphMark,
} from "./knowledgeGraph";
import { isHub, knowledgeGraphOption } from "./knowledgeGraphOption";
import { conversationReferences, knowledgeConversationDraft } from "./knowledgeView";
import { useCompactScreen, useKnowledgeConversation } from "./useKnowledgeConversation";

const CANVAS_HEIGHT = 560;
const CANVAS_HEIGHT_COMPACT = 440;
/** How many marks the list under the picture shows before it asks to show more. */
const LIST_STEP = 60;

type Loaded = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; graph: KnowledgeGraph };

/** The words under the picture that say what its shapes and colours are. */
function Legend({ kind, hues, kinds, anyStale }: { kind: "wiki" | "kg"; hues: Map<string, string>; kinds: Map<string, string>; anyStale: boolean }) {
  return (
    <div role="group" aria-label="图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-3">
      <span>{kind === "wiki" ? "■ 页面" : "● 实体"}</span>
      <span>⬢ 每一类的中心</span>
      {[...hues].map(([type, colour]) => (
        <span key={type} className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colour }} />{kinds.get(type) ?? type}
        </span>
      ))}
      {kinds.size > hues.size && <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-text-3" />其他</span>}
      {anyStale && <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-warn" />依据的资料有变化</span>}
      <span>圆点越大，连线越多</span>
    </div>
  );
}

/**
 * The knowledge graph of a project (`GET /api/knowledge-pages/graph`), drawn in the memory map's picture: either the pages and
 * the links between them or the entities and their relations. The overview holds 150 marks at most — the rest of a kind is one
 * folded mark, pressed to unfold — so a large graph is never a hairball. A mark opens its file in the reader; a line shows the
 * documents its relation was read from; a mark taken into focus shows its neighbourhood, one to three steps wide. The page's
 * toolbar's search names the marks it matches. The picture is a card — its heading says what is in it, its legend names only what is
 * drawn, and a focus's reach is in the card's header, where the controls of a chart belong — and under it is the same graph as a
 * list, which is also what a screen reader is given. Too little to draw is the list alone.
 */
export function KnowledgeGraphView({ projectId, kind, listState, version, onChange, empty }: {
  projectId: string;
  kind: "wiki" | "kg";
  listState: KnowledgeListState;
  /** What the last compile left: the graph is read again when it changes. */
  version: string;
  onChange: (patch: Partial<KnowledgeListState>) => void;
  /** What stands in the place of a graph with no marks: the recipe that says what to do about it (the page's own, not a sentence of this view's). */
  empty: ReactNode;
}) {
  const navigate = useNavigate();
  const scheme = useColorScheme();
  const compact = useCompactScreen();
  const openConversation = useKnowledgeConversation(projectId);
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [line, setLine] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded((previous) => (previous.phase === "ready" ? previous : { phase: "loading" }));
    getKnowledgeGraph(projectId, kind).then(
      (graph) => { if (active) setLoaded({ phase: "ready", graph }); },
      (failure) => { if (active) setLoaded({ phase: "error", message: `无法画出图谱：${productErrorMessage(failure)}` }); },
    );
    return () => { active = false; };
  }, [projectId, kind, version, attempt]);
  useEffect(() => { setExpanded(new Set()); setLine(null); }, [kind, projectId]);

  const graph = loaded.phase === "ready" ? loaded.graph : null;
  const model = useMemo(() => (graph ? modelOf(graph) : null), [graph]);
  const depth = listState.depth ?? 2;
  const focusMark = model && listState.focus ? model.marks.find((mark) => mark.id === listState.focus) ?? null : null;
  const scope = useMemo(() => (model && focusMark ? neighbourhood(model, focusMark.id, depth) : model), [model, focusMark, depth]);
  const view = useMemo(() => (scope ? overview(scope, { expanded }) : null), [scope, expanded]);
  const hits = useMemo(() => (scope ? searchHits(scope.marks, listState.q) : new Set<string>()), [scope, listState.q]);
  const kinds = useMemo(() => new Map((model?.marks ?? []).map((mark) => [mark.type, mark.typeLabel])), [model]);
  const thin = scope ? isThin(scope) : false;
  const rows = useMemo(() => (scope ? listedMarks(scope.marks, hits) : []), [scope, hits]);
  const { visible, remaining, more } = useShowMore(rows, { first: LIST_STEP, step: LIST_STEP, resetKey: `${kind}|${projectId}|${listState.q}|${listState.focus ?? ""}` });

  const plan = useMemo(() => (view && !thin ? knowledgeGraphOption({
    kind, marks: view.marks, lines: withoutIndexLines(view.lines, view.marks, focusMark?.id ?? null), folded: view.folded, hits, focus: focusMark?.id ?? null, hues: hueOfTypes(model?.marks ?? view.marks),
    // The palette is read from the live document, so a theme flip is a reason to build the option again.
    palette: mapPalette(), scheme, compact,
  }) : null), [view, thin, kind, hits, focusMark, scheme, compact, model]);

  const open = useCallback((mark: GraphMark) => { if (mark.sourceId) navigate(readerPath(mark.sourceId, listState)); }, [navigate, listState]);
  const marksById = useMemo(() => new Map((model?.marks ?? []).map((mark) => [mark.id, mark])), [model]);
  const on = useMemo(() => ({
    click: (params: { dataType?: string; name?: string; data?: { source?: number; target?: number } }) => {
      if (!plan) return;
      if (params.dataType === "edge") {
        const from = plan.order[Number(params.data?.source)];
        const to = plan.order[Number(params.data?.target)];
        if (from && to && !isFold(from) && !isFold(to)) setLine({ from, to });
        return;
      }
      const id = String(params.name ?? "");
      if (isFold(id)) setExpanded((held) => new Set([...held, id.slice("fold:".length)]));
      else if (!isHub(id)) { const mark = marksById.get(id); if (mark) open(mark); }
    },
  }), [plan, marksById, open]);

  const takeIntoConversation = (mark: GraphMark) => openConversation(
    knowledgeConversationDraft(mark.title, kind === "kg" ? "实体" : "页"),
    conversationReferences(mark.sourceId ? { id: mark.sourceId, title: mark.title } : null, mark.sources.map((entry) => ({ sourceId: entry.sourceId, title: entry.title }))),
  );

  if (loaded.phase === "loading") return <FilesSkeleton />;
  if (loaded.phase === "error") return <LoadError message={loaded.message} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!model || !scope || !view || !graph) return null;
  if (model.marks.length === 0) return <>{empty}</>;

  const hues = plan?.hues ?? new Map<string, string>();
  const pair = line ? linesBetween(scope.lines, line.from, line.to) : [];
  const documents = evidenceOf(pair);
  const quiet = graph.problems.length + graph.unresolved;
  const lineMarks = line ? [marksById.get(line.from), marksById.get(line.to)] : [];
  const noun = kind === "kg" ? "实体" : "页面";
  const connection = kind === "kg" ? "关系" : "链接";
  const title = focusMark
    ? `“${focusMark.title}”周围的 ${scope.marks.length} 个${noun}，${scope.lines.length} 条${connection}`
    : `${scope.marks.length} 个${noun}，${scope.lines.length} 条${connection}`;
  const focusBar = focusMark && (
    <span role="group" aria-label="聚焦" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-2">
      <span className="min-w-0 max-w-48 truncate">聚焦：<strong className="font-semibold text-text">{focusMark.title}</strong></span>
      <label className="flex items-center gap-2 text-caption text-text-3">
        范围
        <input type="range" min={1} max={3} step={1} value={depth} aria-label="聚焦范围，几步以内" className="w-24 accent-accent"
          onChange={(event) => onChange({ depth: Number(event.target.value) })} />
        <span className="tabular-nums">{depth} 步</span>
      </label>
      <Button size="sm" variant="text" onClick={() => { onChange({ focus: null, depth: null }); setLine(null); }}>取消聚焦</Button>
    </span>
  );
  return (
    <div className="space-y-4" data-knowledge-graph={kind}>
      {!thin && (
        <ChartCard
          level={2} title={title} meta={focusBar || undefined}
          legend={<Legend kind={kind} hues={hues} kinds={kinds} anyStale={view.marks.some((mark) => mark.stale.length > 0)} />}
          footnote={quiet > 0 ? `有 ${quiet} 处连线没能画出来，不影响其余的内容。` : undefined}
        >
          <div className="space-y-3">
            <MapChart kind={`knowledge-${kind}`} option={plan?.option ?? null} height={compact ? CANVAS_HEIGHT_COMPACT : CANVAS_HEIGHT} on={on}
              label={`${kind === "kg" ? "实体和关系" : "页面和链接"}的关系图，共 ${view.marks.length} 个标记，列表在下方。`}
              unpainted={`${view.marks.length} 个标记、${view.lines.length} 条连线。`} />
            {view.folded.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-3">
                <span>另有 {view.folded.reduce((sum, fold) => sum + fold.count, 0)} 个标记折叠在各自的类里：</span>
                {view.folded.map((fold) => (
                  <button key={fold.type} type="button" className="text-link underline underline-offset-2" data-fold={foldId(fold.type)}
                    onClick={() => setExpanded((held) => new Set([...held, fold.type]))}>展开 {fold.count} 个{fold.label}</button>
                ))}
              </div>
            )}
            {line && pair.length > 0 && (
              <section aria-label="连线的依据" data-knowledge-line="" className="space-y-2 rounded-card border border-border px-3 py-2 text-ui">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-text">
                    {lineMarks[0]?.title} <span className="text-text-3">与</span> {lineMarks[1]?.title}
                  </p>
                  <Button size="sm" variant="text" onClick={() => setLine(null)}>关闭</Button>
                </div>
                <ul className="space-y-1 text-text-2">
                  {pair.map((entry, index) => (
                    <li key={index}>
                      {kind === "kg"
                        ? `${marksById.get(entry.from)?.title ?? entry.from} ${entry.label || "相关"} ${marksById.get(entry.to)?.title ?? entry.to}`
                        : `“${marksById.get(entry.from)?.title ?? entry.from}” 链接到 “${marksById.get(entry.to)?.title ?? entry.to}”`}
                    </li>
                  ))}
                </ul>
                {documents.length > 0 && (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-3">
                    依据的资料：
                    {documents.map((entry) => (
                      <Link key={entry.sourceId} to={readerPath(entry.sourceId, listState)} className="text-link underline underline-offset-2">{entry.title ?? "资料"}</Link>
                    ))}
                  </p>
                )}
              </section>
            )}
          </div>
        </ChartCard>
      )}
      <div>
        <List label={hits.size > 0 ? "搜索命中的标记" : kind === "kg" ? "实体" : "页面"}>
          {visible.map((mark) => (
            <ListRow
              key={mark.id}
              title={mark.title}
              to={mark.sourceId ? readerPath(mark.sourceId, listState) : undefined}
              meta={(
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{mark.typeLabel}</span>
                  <span>{mark.degree} 条连线</span>
                  {mark.stale.length > 0 && <Tag tone="warn">依据的资料有变化</Tag>}
                </span>
              )}
              menu={(
                <Menu label={`“${mark.title}”的操作`} items={[
                  { label: "聚焦在这里", icon: Crosshair, onSelect: () => { setLine(null); onChange({ focus: mark.id, depth: listState.depth ?? 2 }); } },
                  { label: "在对话中使用", icon: MessageSquare, onSelect: () => takeIntoConversation(mark) },
                ]} />
              )}
            />
          ))}
        </List>
        <ShowMore remaining={remaining} unit="个" onMore={more} />
      </div>
    </div>
  );
}
