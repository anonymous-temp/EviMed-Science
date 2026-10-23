import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { Brain } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { AskMenu } from "@/components/memory/AskMenu";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { ActivityView } from "@/components/memory/map/ActivityView";
import { DimsView } from "@/components/memory/map/DimsView";
import { GraphView } from "@/components/memory/map/GraphView";
import { MapDrawer } from "@/components/memory/map/MapDrawer";
import { mapToolbar } from "@/components/memory/map/mapToolbar";
import { MemoryFrame } from "@/components/memory/MemoryFrame";
import { MemoryHeaderActions } from "@/components/memory/MemoryHeaderActions";
import { MarkList, type MarkLine } from "@/components/memory/map/MarkList";
import { TimeView } from "@/components/memory/map/TimeView";
import { TopicsView } from "@/components/memory/map/TopicsView";
import { derivedTopics, headline, headlineParts, isThin, markRows, narrowMap, STRUCTURE } from "@/components/memory/map/mapModel";
import { useMapSelection } from "@/components/memory/map/useMapSelection";
import { useMemoryMap } from "@/components/memory/map/useMemoryMap";
import { OTHER_PROJECT, projectScopeGroups } from "@/components/memory/memoryItems";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { useProjectChoices } from "@/components/memory/useProjectChoices";
import { webErrorMessage } from "@/lib/apiClient";
import { formatDay } from "@/lib/format";
import { knowledgeNodeAddress } from "@/lib/knowledgeNav";
import { hideMapEdge, type MapEdge, type MapEvent, type MapNode } from "@/lib/memoryMapClient";
import { useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";

/** What a part that could not be read is called, for the one line that says so. */
const MISSING_NAMES: Record<string, string> = {
  records: "记忆", "native-memory": "记忆", documents: "资料", methods: "做法", runs: "对话", activity: "近期动态", topics: "主题", "knowledge-graph": "知识关系", feedback: "修改记录",
};

const CHANGE_WORDS: Record<string, string> = {
  created: "记下", updated: "改动", superseded: "被后来的说法替代", archived: "忘记", restored: "恢复", confirmed: "确认", status: "状态变化",
  learned: "学会", approved: "开始生效", retired: "停用",
};

/** 「就这个提问」 for the marks a question can be about: a memory, a learned method, a document. */
function askFor(node: MapNode, title: string) {
  const projectId = node.projectId && node.projectId !== OTHER_PROJECT ? node.projectId : null;
  if (node.type === "memory") return <AskMenu kind="memory" text={title} projectId={projectId} />;
  if (node.type === "method") return <AskMenu kind="method" text={title} />;
  if (node.type === "document") return <AskMenu kind="document" text={title} projectId={projectId} />;
  return undefined;
}

/** An event of the time and activity views as a line of the list under them. */
function eventLine(event: MapEvent, node: MapNode | undefined, open: (node: MapNode) => void): MarkLine {
  return {
    id: event.id,
    title: event.text || node?.label || "一件记下的事",
    kind: [CHANGE_WORDS[event.change] ?? event.change, formatDay(event.at)].filter(Boolean).join(" · "),
    note: null,
    node: { type: event.type === "method" ? "method" : "memory", subtype: event.kind ?? null, state: event.change === "superseded" ? "replaced" : "current" },
    onOpen: node ? () => open(node) : undefined,
  };
}

/**
 * 「记忆地图」 (2026-10-12): what EviMed remembers and knows about the researcher, drawn so it can be explored, understood and
 * corrected — a formal product requirement, and a data page (DESIGN.md 「页面结构」: one view at a time over one selection, and a
 * mark opens the record's own drawer). It is the last tab of 记忆胶囊 (2026-10-14): the page is titled as that page and carries its tab
 * bar, which is how a person who looks for their memory finds the map.
 *
 * 记忆胶囊's frame (`MemoryFrame`) is the page's: the same title, the same four tabs, one column. Under the tabs, one toolbar row —
 * five views (关系, 主题, 维度, 时间, 活跃) over one selection kept in the address, what narrows them all, and the search; the project
 * is the header's. One sentence over the picture says what it proves, with a number that opens what it counts; the picture is a card
 * with its legend and, for the relations, its replay in its header. Under the canvas the same marks are a list, which is also the
 * text of the page. Every mark opens the memory page's own drawer, so what a mark shows can be edited, corrected or forgotten where
 * it is read. With too little to draw there is no chart: the sentence, three numbers and the list.
 *
 * Reads `GET /api/memory/map` once for the project, range and focus, and the views switch over the document in hand.
 */
export function MemoryMapPage() {
  const navigate = useNavigate();
  const { selection, search, setView, narrow, clear, drawer } = useMapSelection();
  const { doc, status, failed, loading, grouping, reload } = useMemoryMap({ projectId: selection.project, range: selection.range, focus: selection.focus, depth: selection.depth });
  // 「刚记住了 … 撤销」: the landing is a visit to the capsule like any tab's.
  useMemoryWritePrompt();
  const projects = useProjectStore((state) => state.projects);
  const labels = useProjectLabels();
  const projectName = useCallback((id: string | null) => (id ? labels.get(id) ?? projects.find((project) => project.id === id)?.name ?? null : null), [labels, projects]);

  const narrowed = useMemo(() => (doc ? narrowMap(doc, { ...selection, q: selection.q }) : null), [doc, selection]);
  const byId = useMemo(() => new Map((doc?.nodes ?? []).map((node) => [node.id, node])), [doc]);
  // A focus is a few marks round one: a picture of them is the point, however few. What is too little to draw is the whole map.
  const thin = doc ? !doc.scope.focus && isThin(doc) : false;
  const choices = useProjectChoices();

  /** What pressing a mark does: the record's drawer, a page of its own, or — for a mark that is a group — narrow the map to it. */
  const openNode = useCallback((node: MapNode) => {
    if (node.open?.kind === "record") drawer.open(`record:${node.open.id}`);
    else if (node.open?.kind === "entry") drawer.open(`entry:${node.open.id}`);
    else if (node.open?.kind === "method") drawer.open(`method:${node.open.id}`);
    else if (node.open?.kind === "page") navigate(node.open.href);
    else if (node.type === "entity" || node.type === "page") {
      // An entity or a page of the project's knowledge graph opens in the knowledge base's reader; a double press still centres the map on it.
      const address = knowledgeNodeAddress(node.id, doc?.scope.projectId ?? selection.project);
      if (address) navigate(address); else narrow({ focus: node.id });
    }
    else if (node.type === "project") narrow({ project: node.projectId && node.projectId !== "__other" ? node.projectId : null });
    else if (node.type === "you") clear();
    else narrow({ focus: node.id });
  }, [drawer, navigate, narrow, clear, doc, selection.project]);
  /** 「这条关联不对」: the line stays out of this person's map; the toast takes it back. */
  const hideEdge = useCallback(async (edge: MapEdge) => {
    if (!edge.id) return;
    const id = edge.id;
    try {
      await hideMapEdge(id, true);
      toast.success("已隐藏这条关联", {
        action: { label: "撤销", onClick: () => void hideMapEdge(id, false).then(reload, (error) => toast.error(webErrorMessage(error, { fallback: "没有撤销成功，请重试。" }))) },
      });
      reload();
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "没有隐藏成功，请重试。" }));
    }
  }, [reload]);
  const focusNode = useCallback((node: MapNode) => { if (!STRUCTURE.has(node.type)) narrow({ focus: node.id }); }, [narrow]);

  // The model's topics once it has grouped; before that — and below the number of memories it takes — the kinds and projects the memories
  // already name, so a small capsule has topics to read instead of an empty card.
  const madeTopics = useMemo(() => (doc ? derivedTopics(doc, (id) => projectName(id)) : []), [doc, projectName]);
  const topics = doc && doc.facets.topics.length > 0 ? doc.facets.topics : madeTopics;
  const topicName = selection.topic ? [...(doc?.facets.topics ?? []), ...madeTopics].find((topic) => topic.id === selection.topic)?.label ?? null : null;
  const aspectName = selection.dimension ? doc?.facets.dimensions.flatMap((dimension) => dimension.axes).find((axis) => axis.id === selection.dimension)?.label ?? null : null;
  const focusLabel = selection.focus ? byId.get(selection.focus)?.label ?? (selection.focus.startsWith("cluster:") ? "一组标记" : "这个标记") : null;

  const chain = useMemo(() => {
    if (!doc || !selection.chain || !selection.focus?.startsWith("memory:")) return null;
    const root = byId.get(selection.focus);
    if (!root) return null;
    const rests = doc.edges.filter((edge) => edge.from === root.id && edge.type === "rests-on")
      .flatMap((edge) => { const node = byId.get(edge.to); return node ? [{ node, state: edge.state }] : []; });
    const replaced = doc.edges.filter((edge) => edge.from === root.id && edge.type === "replaces").flatMap((edge) => { const node = byId.get(edge.to); return node ? [node] : []; });
    return { root, rests, replaced };
  }, [doc, selection.chain, selection.focus, byId]);

  const lines: MarkLine[] = useMemo(() => {
    if (!doc || !narrowed) return [];
    const open = (node: MapNode) => openNode(node);
    if (selection.view === "time" || selection.view === "activity") {
      const kept = narrowed.narrowed ? new Set(narrowed.nodes.map((node) => node.id)) : null;
      return doc.events.filter((event) => !kept || kept.has(event.ref)).slice(0, 200).map((event) => eventLine(event, byId.get(event.ref), open));
    }
    const only = selection.q.trim() ? narrowed.hits : null;
    return markRows(narrowed.nodes, { only, formatDay }).map((row) => ({
      id: row.id, title: row.title, kind: row.kind, note: row.note, node: row.node,
      to: row.open?.kind === "page" ? row.open.href : undefined,
      onOpen: row.open?.kind === "page" ? undefined : () => open(row.node),
      menu: askFor(row.node, row.title),
    }));
  }, [doc, narrowed, selection.view, selection.q, byId, openNode]);

  const sentence = doc && (doc.summary.memories > 0 || (!failed && doc.missing.length === 0))
    ? headlineParts(headline(doc), () => narrow({ look: true })) : null;
  const toolbar = mapToolbar({ selection, doc, topicName, aspectName, focusLabel, onView: setView, onNarrow: narrow, onClear: clear, search });
  const showListFor = selection.view !== "topics" || Boolean(selection.topic);
  const listLabel = selection.view === "time" || selection.view === "activity" ? "记下的事" : selection.view === "topics" ? `主题“${topicName ?? ""}”的记忆` : "标记";

  const body = () => {
    if (!doc || !narrowed) return null;
    if (selection.view === "graph") {
      if (thin) {
        // The existing read-error panel owns the retry. Unknown inputs must not become zero-valued summary tiles.
        if (failed || doc.missing.length > 0) return null;
        return (
          <div className="space-y-4">
            <StatBand label="三个数字" columns={3}>
              <StatTile label="记忆" value={doc.summary.memories} to={doc.summary.memories > 0 ? "/app/memory?tab=self" : undefined} />
              <StatTile label="资料" value={doc.summary.documents} to={doc.summary.documents > 0 ? "/app/files" : undefined} />
              <StatTile label="需要看一眼" value={doc.summary.needsLook} onOpen={doc.summary.needsLook > 0 ? () => narrow({ look: true }) : undefined} />
            </StatBand>
            <Note action={<Button size="sm" variant="secondary" onClick={() => navigate("/app/chat")}>去对话</Button>}>再多聊几次，这里会长出你的地图。</Note>
          </div>
        );
      }
      return <GraphView doc={doc} narrowed={narrowed} selected={selection.focus ?? (drawer.value?.startsWith("record:") ? `memory:${drawer.value.slice(7)}` : null)} actions={{ onOpen: openNode, onFocus: focusNode }} chain={chain} focused={Boolean(doc.scope.focus)} onHideEdge={hideEdge} />;
    }
    if (selection.view === "topics") {
      return (
        <TopicsView
          topics={topics} selected={selection.topic} grouping={grouping} status={doc.status.topics}
          onChoose={(topic) => narrow({ topic })} onChanged={reload}
        />
      );
    }
    if (selection.view === "dims") return <DimsView dimensions={doc.facets.dimensions} selected={selection.dimension} onAxis={(dimension) => narrow({ dimension })} />;
    if (selection.view === "time") {
      return <TimeView doc={doc} range={selection.range} projectName={(id) => projectName(id) ?? "其他"} onRange={(range) => narrow({ range })} onOpen={(ref) => { const node = byId.get(ref); if (node) openNode(node); }} />;
    }
    return <ActivityView doc={doc} range={selection.range} onDay={(day) => narrow({ range: day ? `${day}..${day}` : "all" })} />;
  };

  const empty = doc !== null && !failed && doc.missing.length === 0 && doc.summary.memories === 0 && doc.nodes.length === 0
    && doc.events.length === 0 && doc.facets.dimensions.every((dimension) => dimension.total === 0 && dimension.previousTotal === 0)
    && !selection.project && selection.range === "all" && !loading;
  return (
    <MemoryFrame
      tab="map" map documentTitle="记忆地图"
      scope={choices.length > 0 ? { label: "项目", groups: projectScopeGroups(choices), value: selection.project, onChange: (project) => narrow({ project }), allLabel: "全部项目" } : undefined}
      toolbar={toolbar}
      actions={(
        <MemoryHeaderActions
          native={doc?.engine === "native"}
          // 「本项目」 is the project the map is narrowed to; with every project shown it is the shell's own.
          projectId={selection.project === OTHER_PROJECT ? null : selection.project ?? undefined}
          onChanged={reload}
        />
      )}
      headline={sentence ? { parts: sentence, id: "memory-map-headline" } : undefined}
    >
      {failed && !doc && <LoadError message="暂时读不到记忆地图。" onRetry={reload} />}
      {!doc && !failed && <RunsSkeleton filter={false} />}
      {doc && narrowed && (
        <div className="space-y-5">
          {(failed || doc.missing.length > 0) && (
            <LoadError
              message={failed ? "这次没有读到最新的内容。" : `有一部分没有读到：${[...new Set(doc.missing.map((name) => MISSING_NAMES[name] ?? "部分内容"))].join("、")}。`}
              onRetry={reload}
            />
          )}
          {empty ? (
            <EmptyState icon={Brain} title="还没有记住什么" description="和 EviMed 聊几次，它记住的内容会在这里连成一张图。" action={<Button onClick={() => navigate("/app/chat")}>去对话</Button>} />
          ) : (
            <div aria-busy={loading || status === "loading"} className={loading ? "opacity-70 transition-opacity" : undefined}>{body()}</div>
          )}
          {!empty && showListFor && <MarkList lines={lines} label={listLabel} empty={selection.q.trim() ? "没有找到。" : "这里没有标记。"} />}
        </div>
      )}
      {drawer.value && (
        <MapDrawer
          open={drawer.value} projectName={projectName} onClose={drawer.close} onChanged={reload}
          onOpenRecord={(id) => drawer.open(`record:${id}`)} canOpenRecord={() => true}
        />
      )}
    </MemoryFrame>
  );
}
