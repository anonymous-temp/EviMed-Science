import { useCallback, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Brain, X } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { dayIn } from "@/components/charts/map/zone";
import { MapDrawer } from "@/components/memory/map/MapDrawer";
import { derivedTopics, narrowMap } from "@/components/memory/map/mapModel";
import { useStarAllowed } from "@/components/memory/map/star/starSupport";
import { useMemoryMap } from "@/components/memory/map/useMemoryMap";
import { MemoryFrame, memoryTabAddress } from "@/components/memory/MemoryFrame";
import { headerControls, MemoryHeaderDrawers, type HeaderDrawer } from "@/components/memory/MemoryHeaderActions";
import { ChangeChart } from "@/components/memory/overview/ChangeChart";
import { ChangesTable } from "@/components/memory/overview/ChangesTable";
import { ExplorePanel } from "@/components/memory/overview/ExplorePanel";
import {
  changeEvents, changeRows, chosenExplore, exploreViews, growthOf, knowledgeCount, lastChangeDay, lookTableRows, narrowChanges, needsLook,
  overviewHeadline, RANGE_OPTIONS, rangeFrom, rangeWords, readable, receivedCounts, recentCount, rememberedCount, withinRange,
  type ChangeRow,
} from "@/components/memory/overview/memoryOverviewModel";
import { useOverviewSelection } from "@/components/memory/overview/useOverviewSelection";
import { PackDrawer } from "@/components/memory/ReceivedTab";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { Button } from "@/components/ui/Button";
import { ChartGrid } from "@/components/ui/ChartGrid";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import type { ToolbarFilter, ToolbarProps } from "@/components/ui/Toolbar";
import { webErrorMessage } from "@/lib/apiClient";
import { formatDay } from "@/lib/format";
import { knowledgeNodeAddress } from "@/lib/knowledgeNav";
import { fetchReceivedCapsules } from "@/lib/memoryClient";
import { useMemoryMapFeature } from "@/lib/memoryMapFeature";
import { hideMapEdge, MAP_INCLUDE_DASHBOARD, type MapEdge, type MapNode } from "@/lib/memoryMapClient";
import { listAllMethods } from "@/lib/methodsClient";
import { measurement, type MetricReading } from "@/lib/measurement";
import { useProjectLabels } from "@/lib/projectNames";
import { toast } from "@/lib/toast";
import { useNarrow } from "@/lib/useMediaQuery";

/** Where each number of the headline and each tile leads: the list it counts. */
const SELF = memoryTabAddress("self");
const METHODS = memoryTabAddress("methods");
const RECEIVED = memoryTabAddress("received");

/**
 * 「总览」: the capsule as one data page (DESIGN.md template T4), where `/app/memory` lands, beside the memory frame's left column. In the band,
 * one toolbar row — the range, only what needs a look, and the search — that narrows everything below it together; then one sentence whose numbers
 * each open the list they count; 「记忆星图」, the page's one brand moment, wherever a real GPU and a wide screen can hold it; four tiles that are each a door to a list (关于你, 做法, 收到的, and 知识 in the knowledge base); 「变化」, what the
 * capsule gained and lost over time; 「关系与主题」 when there is enough to see; and the table behind the charts, 「最近变化」, whose rows open the
 * same drawers the marks do. There is no 项目 tile since 2026-10-28: a project is a label on a memory, and its memories are counted in 关于你.
 *
 * The map was a tab of its own until 2026-10-27: it was a dashboard, and a dashboard that is not the landing is a page nobody finds. Its relation
 * graph and topics are the lower panel here, its time, activity and dimension views are gone (the chart and the table say what happened), and
 * `/app/memory/map` goes to this page with what it can carry over (`MemoryMapRedirect`).
 *
 * Every part reads and fails on its own: the map's document answers for the memories and the documents (and says which of its
 * sources failed, so a number whose source failed says so instead of drawing zero), the learned methods and the packs received each have a read of
 * their own. The sentence names only what was read. An account with no memory and no learned method has no sentence, no chart and no table: one
 * recipe with one button, under the tiles.
 */
export function MemoryOverviewPage() {
  const feature = useMemoryMapFeature();
  // The dashboard reads the map's document, which a deployment that does not draw the map does not serve.
  if (feature === "loading") return <RunsSkeleton filter={false} />;
  if (feature === "off") return <Navigate to={memoryTabAddress("self")} replace />;
  return <Overview />;
}

/** A tile's reading: the number, or — when its part could not be read — the failure with its retry, never a zero. */
function reading(value: number | null, loading: boolean, failed: boolean, retry: () => void): MetricReading {
  if (value !== null) return measurement(value, "", "记忆胶囊当前汇总");
  if (loading && !failed) return { kind: "loading" };
  return { kind: "failed", error: "暂时读不到", retry };
}

function Overview() {
  const phone = useNarrow();
  const starAllowed = useStarAllowed();
  const [starLost, setStarLost] = useState(false);
  const navigate = useNavigate();
  useMemoryWritePrompt();
  const labels = useProjectLabels();
  const { selection, search, setExplore, narrow, clear, drawer } = useOverviewSelection();
  const [header, setHeader] = useState<HeaderDrawer | null>(null);
  const map = useMemoryMap({ projectId: selection.project, range: "all", focus: null, depth: 1 }, MAP_INCLUDE_DASHBOARD);
  const received = useCapsuleData(fetchReceivedCapsules);
  // The learned methods are their own read: the map folds its marks to a hundred and fifty and a method is among the first it folds (see `ReadPart`).
  const learned = useCapsuleData(() => listAllMethods("approved"));
  const reloadAll = useCallback(() => { map.reload(); received.reload(); learned.reload(); }, [map, received, learned]);
  const doc = map.doc;
  // A project's name is the shell's, else the one the capsule's own document gives it (a project the shell's list does not hold).
  const projectName = useCallback((id: string | null) => (id ? labels.get(id) ?? doc?.facets.projects.find((project) => project.id === id)?.name ?? null : null), [labels, doc]);

  // ---- what each part is, from what was read ----
  const memoriesRead = doc ? readable(doc, "memories") : false;
  const knowledgeRead = doc ? readable(doc, "knowledge") : false;
  const growthRead = doc ? readable(doc, "growth") : false;
  // 关于你 as its list draws it: the person's memories and, after them, the ones that carry a project.
  const about = doc && memoriesRead ? rememberedCount(doc) : null;
  const methodCount = learned.data ? learned.data.length : null;
  const documents = doc && knowledgeRead ? knowledgeCount(doc) : null;
  const packs = received.data ? receivedCounts(received.data) : null;

  // ---- the changes: every lane, then the selection's narrowing ----
  const timeZone = doc?.scope.timeZone ?? "UTC";
  // A day, so the string is what the memos below depend on: it moves at midnight and not at every render.
  const today = dayIn(Date.now(), timeZone);
  const events = useMemo(() => (doc && growthRead ? changeEvents(doc, received.data ?? [], learned.data ?? []) : []), [doc, growthRead, received.data, learned.data]);
  const from = rangeFrom(selection.range, today);

  // What narrows the memories (a topic, only what needs a look) is decided on the document in hand, as the map's views did.
  const ranged = useMemo(() => (doc ? withinRange(doc, from, today, timeZone) : null), [doc, from, today, timeZone]);
  const narrowed = useMemo(() => (ranged
    ? narrowMap(ranged, { topic: selection.topic, look: selection.look, q: selection.q })
    : null), [ranged, selection.topic, selection.look, selection.q]);
  const memoryIds = useMemo(() => (narrowed && (selection.topic || selection.look)
    ? new Set(narrowed.nodes.filter((node) => node.type === "memory").map((node) => node.id)) : null), [narrowed, selection.topic, selection.look]);
  const shown = useMemo(() => narrowChanges(events, { from, today, week: selection.week, query: selection.q, only: memoryIds }), [events, from, today, selection.week, selection.q, memoryIds]);
  const growth = useMemo(() => (doc ? growthOf(shown, today) : null), [doc, shown, today]);

  const look = useMemo(() => (doc ? needsLook(doc) : null), [doc]);
  const rows: ChangeRow[] = useMemo(() => {
    if (selection.look && look) return lookTableRows(look.rows.filter((row) => !memoryIds || memoryIds.has(row.id)), selection.q);
    return changeRows(shown, { projectName, formatDay: (day) => formatDay(day) });
  }, [selection.look, selection.q, look, memoryIds, shown, projectName]);

  const empty = doc !== null && memoriesRead && about === 0 && methodCount === 0;

  // ---- the headline ----
  const headline = overviewHeadline({
    about, methods: methodCount,
    last: (() => { const day = lastChangeDay(events); return day ? formatDay(day) : null; })(),
  }, { about: SELF, methods: METHODS });

  // ---- the mark a press on the graph or the drawer opens ----
  const open = useCallback((target: ChangeRow["target"]) => {
    if (target.kind === "drawer") {
      if (target.open.kind === "page") navigate(target.open.href);
      else drawer.open(`${target.open.kind}:${target.open.id}`);
    }
    else if (target.kind === "pack") drawer.open(`pack:${target.id}`);
    else if (target.kind === "forgotten") setHeader({ kind: "forgotten" });
    else navigate("/app/files");
  }, [drawer, navigate]);
  const openNode = useCallback((node: MapNode) => {
    if (node.open?.kind === "record" || node.open?.kind === "entry" || node.open?.kind === "method") drawer.open(`${node.open.kind}:${node.open.id}`);
    else if (node.open?.kind === "page") navigate(node.open.href);
    else if (node.type === "entity" || node.type === "page") {
      const address = knowledgeNodeAddress(node.id, doc?.scope.projectId ?? selection.project);
      if (address) navigate(address);
    // A project's memories are the last group of 关于你.
    } else if (node.type === "project" || node.type === "cluster") navigate(SELF);
  }, [drawer, navigate, doc, selection.project]);
  /** 「这条关联不对」: the line stays out of this person's map; the toast takes it back. */
  const hideEdge = useCallback(async (edge: MapEdge) => {
    if (!edge.id) return;
    const id = edge.id;
    try {
      await hideMapEdge(id, true);
      toast.success("已隐藏这条关联", {
        action: { label: "撤销", onClick: () => void hideMapEdge(id, false).then(map.reload, (error) => toast.error(webErrorMessage(error, { fallback: "没有撤销成功，请重试。" }))) },
      });
      map.reload();
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "没有隐藏成功，请重试。" }));
    }
  }, [map]);

  // ---- the toolbar: the range, what needs a look, the marks that let go, the search ----
  const madeTopics = useMemo(() => (doc ? derivedTopics(doc, (id) => projectName(id)) : []), [doc, projectName]);
  const topics = doc && doc.facets.topics.length > 0 ? doc.facets.topics : madeTopics;
  const topicName = selection.topic ? [...(doc?.facets.topics ?? []), ...madeTopics].find((topic) => topic.id === selection.topic)?.label ?? null : null;
  const filters: ToolbarFilter[] = [
    // 全部 is no chip: nothing pressed is all of it, a pressed chip lets go when it is pressed again, and 「清除筛选」 is the way back too.
    { kind: "chips", label: "时间范围", options: RANGE_OPTIONS.filter((option) => option.value !== "all").map((option) => ({ value: option.value, label: option.label })), value: selection.range === "all" ? "" : selection.range, neutral: "", onChange: (range) => narrow({ range: range === "30d" || range === "90d" ? range : "all" }) },
  ];
  // A chip for nothing is a filter that empties the page: only when something needs a look, or the page is already narrowed to it, so it can be let go.
  if ((look?.count ?? 0) > 0 || selection.look) filters.push({ kind: "toggle", label: `只看需要看一眼 ${look?.count ?? 0}`, pressed: selection.look, onChange: (next) => narrow({ look: next }) });
  if (selection.week) filters.push({ kind: "toggle", label: `这一周：${formatDay(selection.week)}起`, pressed: true, icon: X, iconEnd: true, onChange: () => narrow({ week: null }) });
  if (topicName) filters.push({ kind: "toggle", label: `主题：${topicName}`, pressed: true, icon: X, iconEnd: true, onChange: () => narrow({ topic: null }) });
  if (selection.project) filters.push({ kind: "toggle", label: `项目：${projectName(selection.project) ?? "未归入项目"}`, pressed: true, icon: X, iconEnd: true, onChange: () => narrow({ project: null }) });
  const toolbar: ToolbarProps = {
    label: "总览的范围与筛选", filters, onClear: clear,
    search: { label: "搜索记忆", value: search.draft, maxLength: 80, onChange: search.setDraft, onClear: search.clear, inputProps: search.composition },
  };

  // ---- the page ----
  const failed = map.failed && !doc;
  const formerlyOf = useCallback((recordId: string) => (doc?.nodes ?? [])
    .filter((node) => node.state === "replaced" && node.open?.kind === "record" && node.open.id === recordId)
    .map((node) => ({ id: node.id.slice("memory:".length), text: node.label, until: node.until ?? null })), [doc]);
  // Any drawer a mark can open lights that mark: a memory, a note of the capsule's or a method.
  const selectedMark = (() => {
    const [kind, ...rest] = (drawer.value ?? "").split(":");
    const id = rest.join(":");
    if (!id || !["record", "entry", "method"].includes(kind)) return null;
    return doc?.nodes.find((node) => node.open?.kind === kind && "id" in node.open && node.open.id === id && node.state !== "replaced")?.id ?? null;
  })();
  const partial = doc && doc.missing.length > 0 ? doc.missing : [];
  // The star map where a real GPU and a wide screen can hold it, and it leads the page; on a phone the relation graph is drawn too small to follow a line, so the
  // topics, which are a list beside their words, are the first view there. A picture that lost its context goes the way of a browser that never had one.
  const starUsable = starAllowed && !starLost;
  const views = doc && memoriesRead ? exploreViews(doc, { star: starUsable }) : [];
  const explore = doc ? chosenExplore(views, selection.explore, doc, { phone }) : null;
  const recent = (test?: (event: (typeof events)[number]) => boolean) => recentCount(events, today, test);
  const loadingMap = !doc && !map.failed;
  const retry = map.reload;
  const note = (value: number) => (value > 0 ? `近 30 天 +${value}` : undefined);

  const tiles = (
    <StatBand label="记忆胶囊的四个数字" columns={4} separate dense>
      <StatTile
        whole dense label="关于你" reading={reading(about, loadingMap, failed, retry)} to={SELF}
        note={about !== null && growthRead ? note(recent((event) => event.lane === "noted")) : undefined}
      />
      <StatTile
        whole dense label="做法" reading={reading(methodCount, !learned.data && !learned.failed, learned.failed, learned.reload)} to={METHODS}
        note={methodCount !== null ? note(recent((event) => event.lane === "learned")) : undefined}
      />
      <StatTile
        whole dense label="收到的" reading={reading(packs ? packs.enabled : null, !received.data && !received.failed, received.failed, received.reload)} to={RECEIVED}
        note={packs ? `共 ${packs.all} 个` : undefined}
      />
      <StatTile whole dense leaves label="知识" reading={reading(documents, loadingMap, failed, retry)} to="/app/files" />
    </StatBand>
  );

  const explorePanel = explore && ranged && narrowed && doc ? { key: "explore", span: 2 as const, node: (
    <ExplorePanel
      explore={explore} views={views} onExplore={setExplore} doc={ranged} layoutDoc={doc} narrowed={narrowed} actions={{ onOpen: openNode, onFocus: () => undefined }}
      selectedMark={selectedMark}
      topics={topics} topic={selection.topic} grouping={map.grouping} topicsStatus={doc.status.topics}
      onChooseTopic={(topic) => narrow({ topic })} onHideEdge={hideEdge} onChanged={map.reload} onStarUnavailable={() => setStarLost(true)}
    />
  ) } : null;
  const changes = doc && !empty && growthRead && growth ? { key: "changes", span: 2 as const, node: (
    <ChangeChart
      state="content" growth={growth} events={shown} timeZone={timeZone} words={rangeWords(selection.range)} selectedWeek={selection.week}
      emptyText={events.length === 0 ? "还没有变化。" : "这个范围里没有变化。"} onRetry={reloadAll}
      onOpenEvent={(event) => {
        if (event.lane === "received") open({ kind: "pack", id: event.id.slice("pack:".length) });
        else if (event.lane === "forgotten") open({ kind: "forgotten" });
        else if (event.lane === "documents") open({ kind: "files" });
        else if (event.open) open({ kind: "drawer", open: event.open });
      }}
      onSelectWeek={(start) => narrow({ week: selection.week === start ? null : start })}
    />
  ) } : null;
  // The sky leads the page when there is one, above the tiles, wherever the reader has switched to, so the switch does not move the card under them. Else the page tells
  // what changed first and the picture stands under that, as it did before there was a sky.
  const leads = views.includes("star");
  const gridRows = (leads ? [changes] : [changes, explorePanel]).filter((row) => row !== null);
  const grid = doc && !empty && gridRows.length > 0 && <ChartGrid rows={gridRows.map((row) => [row])} />;

  const table = doc && !empty && growthRead && (
    rows.length > 0
      ? <ChangesTable title={selection.look ? "需要看一眼" : "最近变化"} rows={rows} label={selection.look ? "需要看一眼的记忆" : "最近变化"} onOpen={open} />
      : events.length > 0 && (
        <EmptyState
          icon={Brain} title="这里没有符合的变化" description="换个范围或关键词试试。"
          action={<Button variant="secondary" onClick={clear}>清除筛选</Button>}
        />
      )
  );

  const pack = drawer.value?.startsWith("pack:") ? received.data?.find((item) => `pack:${item.id}` === drawer.value) ?? null : null;
  const tabCounts = { self: about ?? undefined, methods: methodCount ?? undefined, received: packs?.enabled };
  return (
    <MemoryFrame
      tab="overview" overview counts={tabCounts} toolbar={toolbar}
      controls={headerControls({ onChanged: reloadAll, onDrawer: setHeader })}
      headline={headline ? { parts: headline, id: "memory-overview-headline" } : undefined}
    >
      <div className="space-y-6">
        {failed && <LoadError message="暂时读不到记忆。" onRetry={map.reload} />}
        {partial.length > 0 && <LoadError message="有一部分记忆没有读到，对应的数字先不显示。" onRetry={map.reload} />}
        {leads && !empty && explorePanel && <ChartGrid rows={[[explorePanel]]} />}
        {tiles}
        {empty && (
          <EmptyState
            icon={Brain} title="还没有记下关于你的事。" description="在对话里说“记住…”，或把其他 AI 记住的内容搬过来。"
            action={<Button variant="secondary" onClick={() => setHeader({ kind: "import" })}>从其他 AI 导入</Button>}
          />
        )}
        {doc && !empty && !growthRead && <LoadError message="暂时读不到变化。" onRetry={reloadAll} />}
        {grid}
        {table}
      </div>
      {drawer.value && !pack && !drawer.value.startsWith("pack:") && (
        <MapDrawer
          open={drawer.value} formerlyOf={formerlyOf} projectName={projectName} onClose={drawer.close} onChanged={reloadAll}
          onOpenRecord={(id) => drawer.open(`record:${id}`)} canOpenRecord={() => true}
        />
      )}
      {pack && <PackDrawer pack={pack} onClose={drawer.close} />}
      <MemoryHeaderDrawers drawer={header} onDrawer={setHeader} onChanged={reloadAll} />
    </MemoryFrame>
  );
}
