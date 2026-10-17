import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getGeoCluster, getGeoSources, type GeoAction, type GeoClusterView, type GeoSourceRow, type GeoProject } from "@/lib/geoClient";
import { BarList } from "@/components/charts/BarList";
import { concentrationFacts, concentrationTitle, SourceConcentration } from "@/components/charts/SourceConcentration";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid } from "@/components/ui/ChartGrid";
import { Disclosure } from "@/components/ui/Disclosure";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List, ListHeader, ListRow, type ListColumn } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { useGeoToolbar } from "../geoFrame";
import { useSharedGeoLoad } from "../geoProjectData";
import { engineName, GEO_SOURCE_LAYER_WORDS, zh } from "../geoText";
import { GEO_VIEW_PARAM, geoDestinationPath } from "../geoTabs";
import { clusterName } from "../spine/clusterModel";
import { ClusterLink } from "../spine/ClusterLink";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { GEO_CLUSTER_FILTER_PARAM, GEO_ENGINE_PARAM, GEO_SOURCE_PARAM, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { routeWord, unavailableWords } from "../spine/actionModel";
import {
  candidatesOf,
  conditionsVerified,
  domainsOfGroup,
  groupsOfDomain,
  isPlaceable,
  kindCounts,
  kindOf,
  OTHER_KIND,
  type Candidate,
} from "../spine/sourceModel";
import { useGeoActions, useGeoClusters } from "../spine/spineData";
import { sourceKindWord, yuan } from "./geoTabText";
import { StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { GeoSourceDrawer } from "./GeoSourceDrawer";
import { ShowMore, useShowMore } from "./showMore";

/** Sources listed before 「显示更多」, and how many each press adds. */
const SOURCES_SHOWN = 30;

type Only = "wrong" | "mentions" | "own" | "placeable" | "verified";

const ONLY_OPTIONS: ReadonlyArray<FilterOption<Only>> = [
  { value: "placeable", label: "可投放" },
  { value: "verified", label: "三条件已核验" },
  { value: "wrong", label: "讲错过我方" },
  { value: "mentions", label: "提到过我方" },
  { value: "own", label: "自有渠道" },
];

type SourcesView = "cited" | "placeable";
const VIEW_OPTIONS: ReadonlyArray<FilterOption<SourcesView>> = [
  { value: "cited", label: "AI 引用谁" },
  { value: "placeable", label: "可投放" },
];

type SortKey = "cited" | "wrong" | "mentions";

/** The three numbers of a row, named as the header names them. */
const COLUMNS: ReadonlyArray<ListColumn & { key: SortKey }> = [
  { key: "cited", label: "被引用", sortable: true },
  { key: "wrong", label: "讲错的回答", sortable: true },
  { key: "mentions", label: "提到你", sortable: true },
];

const KIND_PARAM = "kind";

/**
 * 信源 (plan §3.5, mockup g08; R13 E-15; R19 audit C §2.3): two questions on one page, switched in the band.
 *
 * **AI 引用谁** — who the engines cite, as one list. A row is the site — its name, its kind, its domain — and three numbers that
 * are all counts of the latest round's answers: how many cited the site, how many of those misstated us, how many of those named
 * us. Above the list two pictures of the same sites: the kinds of site by the answers that cite them (a bar is a filter of the
 * list), and how concentrated the citations are (the busiest fifteen sites' share; how many sites were cited once is the legend's
 * fact). The headers sort by the numbers; the red one is a button that opens what it counts. A row opens the site's drawer: what
 * an article there needs and costs first, the question groups it serves, then the answers behind the three numbers.
 *
 * **可投放** — where an article could go: each place the actions send articles to, once, with its layer, the engines that cite
 * it, the groups it serves, its price and whether an order could be placed there now. Those are the market's own ranking, carried
 * by the actions; nothing is worked out again here. The strategy that used to sit under the list lives on 方案.
 *
 * The choices — the view, the engine, the kind of site, the group a site is related to, and the search — are the band's toolbar,
 * and the open site is `?source=<domain>`, so a link from a group or a wrong claim lands on it.
 */
export function SourcesTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`sources:${geoId}`, () => getGeoSources(geoId));
  const actions = useGeoActions(geoId);
  const clusters = useGeoClusters(geoId);
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const sources = (Array.isArray(data?.sources) ? data.sources : []).filter((source) => source && source.domain);
  if (sources.length === 0) return <StepPending geoId={geoId} project={project} step="sources" />;
  const linkless = (Array.isArray(data?.linklessEngines) ? data.linklessEngines : []).filter(Boolean);
  const everyAction = actions.state.kind === "ready" && Array.isArray(actions.state.data?.actions) ? actions.state.data.actions : [];
  const groups = clusters.state.kind === "ready" && Array.isArray(clusters.state.data?.groups) ? clusters.state.data.groups : [];
  return (
    <div data-geo-tab="sources" className="flex flex-col gap-6">
      <SourceList geoId={geoId} project={project} sources={sources} engines={project.engines} actions={everyAction} groups={groups} />
      {/* An engine whose citations had no link is not missing from the list
          by accident: it is said, not dropped (G8). */}
      {linkless.length > 0 && (
        <p data-geo-linkless="" className="text-caption text-text-3">
          {zh`${linkless.map(engineName).join("、")}的引用只有标题、没有链接，引用了哪些信源测不出`}
        </p>
      )}
      <ClusterDrawerHost geoId={geoId} project={project} />
    </div>
  );
}

/** The row's three numbers for the engine the page is narrowed to (`all`: the whole round). */
export interface SourceCounts {
  cited: number;
  wrong: number;
  mentions: number;
}

export function sourceCounts(source: GeoSourceRow, engine: string): SourceCounts {
  const cited = source.cited && typeof source.cited === "object" ? source.cited : {};
  if (engine === "all") {
    return {
      cited: Object.values(cited).reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0),
      wrong: source.wrongOurs,
      mentions: source.mentionsOurs,
    };
  }
  return {
    cited: typeof cited[engine] === "number" ? cited[engine] : 0,
    wrong: source.wrongOursByEngine ? source.wrongOursByEngine[engine] ?? 0 : source.wrongOurs,
    mentions: source.mentionsOursByEngine ? source.mentionsOursByEngine[engine] ?? 0 : source.mentionsOurs,
  };
}

function matchesOnly(source: GeoSourceRow, counts: SourceCounts, only: Only | null): boolean {
  if (only === "wrong") return counts.wrong > 0;
  if (only === "mentions") return counts.mentions > 0;
  if (only === "own") return source.layer === "owned";
  if (only === "placeable") return isPlaceable(source);
  if (only === "verified") return conditionsVerified(source);
  return true;
}

interface Opened {
  key: string;
  /** The engine filter when it was opened: the drawer lists the answers the row counted. */
  engine: string;
  focus: "wrong" | null;
}

/** The domains a group is related to: those its actions send articles to, and the sites cited most in answers to its questions. */
function useRelatedDomains(geoId: string, cluster: string | null, actions: readonly GeoAction[]): ReadonlySet<string> | null {
  const detail = useSharedGeoLoad<GeoClusterView | null>(`cluster:${geoId}:${cluster ?? "-"}`, () => (cluster ? getGeoCluster(geoId, cluster) : Promise.resolve(null)));
  return useMemo(() => {
    if (!cluster) return null;
    const domains = domainsOfGroup(actions, cluster);
    if (detail.state.kind === "ready" && detail.state.data) for (const source of detail.state.data.sources ?? []) domains.add(source.domain);
    return domains;
  }, [cluster, actions, detail.state]);
}

function SourceList({
  geoId,
  project,
  sources,
  engines,
  actions,
  groups,
}: {
  geoId: string;
  project: GeoProject;
  sources: GeoSourceRow[];
  engines: string[];
  actions: readonly GeoAction[];
  groups: ReadonlyArray<{ id: string; name: string }>;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const change = useGeoSearchChange();
  const [engineParam, setEngineParam] = useGeoSearchParam(GEO_ENGINE_PARAM);
  const [clusterParam, setClusterParam] = useGeoSearchParam(GEO_CLUSTER_FILTER_PARAM);
  const [kindParam, setKindParam] = useGeoSearchParam(KIND_PARAM);
  const [onlyParam, setOnlyParam] = useGeoSearchParam("only");
  const view: SourcesView = params.get(GEO_VIEW_PARAM) === "placeable" ? "placeable" : "cited";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "cited", descending: true });
  const [opened, setOpened] = useState<Opened | null>(null);
  const addressed = params.get(GEO_SOURCE_PARAM);

  const cited = useMemo(() => new Set(sources.flatMap((source) => Object.keys(source.cited ?? {}))), [sources]);
  const listed = [...engines.filter((key) => cited.has(key)), ...[...cited].filter((key) => !engines.includes(key))];
  const options: FilterOption<string>[] = [
    { value: "all", label: "全部引擎" },
    ...listed.map((key) => ({ value: key, label: engineName(key) })),
  ];
  const current = engineParam && options.some((option) => option.value === engineParam) ? engineParam : "all";
  const only = ONLY_OPTIONS.find((option) => option.value === onlyParam)?.value ?? null;
  const cluster = clusterParam && groups.some((group) => group.id === clusterParam) ? clusterParam : null;
  const related = useRelatedDomains(geoId, cluster, actions);
  const impostors = sources.filter((source) => source.impostor);
  const needle = query.trim().toLowerCase();
  const candidates = useMemo(() => candidatesOf(actions), [actions]);

  // The sites the engines cited, for the engine in view: what both pictures are drawn from, before any other narrowing.
  const forEngine = useMemo(() => sources
    .filter((source) => !source.impostor)
    .map((source) => ({ source, counts: sourceCounts(source, current) }))
    .filter(({ counts }) => current === "all" || counts.cited > 0), [sources, current]);
  const kinds = useMemo(() => {
    const citedBy = new Map(forEngine.map((entry) => [entry.source, entry.counts.cited]));
    return kindCounts(forEngine.map((entry) => entry.source), (source) => citedBy.get(source) ?? 0);
  }, [forEngine]);
  const kind = kindParam && kinds.some((entry) => entry.key === kindParam || entry.label === kindParam) ? kindParam : null;
  const concentration = useMemo(() => concentrationFacts(forEngine.map((entry) => entry.counts.cited)), [forEngine]);

  const rows = useMemo(() => forEngine
    .filter(({ source, counts }) => matchesOnly(source, counts, only))
    .filter(({ source }) => !kind || kindOf(source).key === kind || kindOf(source).label === kind)
    .filter(({ source }) => !related || related.has(source.domain))
    .filter(({ source }) => !needle || `${source.name ?? ""} ${source.domain}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort.descending ? b.counts[sort.key] - a.counts[sort.key] : a.counts[sort.key] - b.counts[sort.key]) || b.counts.cited - a.counts.cited),
  [forEngine, only, kind, related, needle, sort]);
  const places = useMemo(() => candidates
    .filter((candidate) => !cluster || candidate.groups.some((group) => group.id === cluster))
    .filter((candidate) => !needle || `${candidate.name} ${candidate.domain ?? ""}`.toLowerCase().includes(needle)), [candidates, cluster, needle]);
  const { visible, remaining, more } = useShowMore(rows, { first: SOURCES_SHOWN, step: SOURCES_SHOWN, resetKey: `${view}|${current}|${only}|${kind}|${cluster}|${needle}|${sort.key}|${sort.descending}` });

  const activeKey = opened?.key ?? addressed;
  const drawerRow = activeKey ? sources.find((source) => source.domain === activeKey || (source.id || source.domain) === activeKey) ?? null : null;
  const openSource = (source: GeoSourceRow, engine: string, focus: "wrong" | null) => {
    setOpened({ key: source.id || source.domain, engine, focus });
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      copy.set(GEO_SOURCE_PARAM, source.domain);
      return copy;
    });
  };
  const closeSource = () => {
    setOpened(null);
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      copy.delete(GEO_SOURCE_PARAM);
      return copy;
    }, { replace: true });
  };
  // Pressing the sorted column again turns it over; another column starts from the most.
  const sortBy = (key: string) => setSort((now) => (now.key === key ? { key: now.key, descending: !now.descending } : { key: key as SortKey, descending: true }));
  const narrowed = (view === "cited" && (current !== "all" || only !== null || kind !== null)) || cluster !== null;
  const summary = view === "cited"
    ? `${needle ? "匹配 " : ""}${rows.length.toLocaleString("zh-CN")} 个信源`
    : `${needle ? "匹配 " : ""}${places.length.toLocaleString("zh-CN")} 个可投放的地方`;

  useGeoToolbar({
    filters: [
      { kind: "chips", label: "视图", options: VIEW_OPTIONS, value: view, onChange: (value) => change({ [GEO_VIEW_PARAM]: value === "cited" ? null : value }) },
      ...(view === "cited" ? [
        // A menu and not a chip for each engine: five chips are most of the band's row, and a row that wraps when a choice adds its
        // mark moves the page under it.
        { kind: "select" as const, label: "引擎", allLabel: "全部引擎", options: options.filter((option) => option.value !== "all"), value: current === "all" ? null : current, onChange: (value: string | null) => setEngineParam(value) },
        { kind: "select" as const, label: "只看", allLabel: "全部信源", options: ONLY_OPTIONS, value: only, onChange: (value: string | null) => setOnlyParam(value) },
      ] : []),
      ...(groups.length > 1 ? [{
        kind: "select" as const,
        label: "与某群相关",
        allLabel: "全部问题群",
        options: groups.map((group) => ({ value: group.id, label: clusterName(group) })),
        value: cluster,
        onChange: setClusterParam,
      }] : []),
      ...(view === "cited" && kind ? [{ kind: "toggle" as const, label: `类型：${kinds.find((entry) => entry.key === kind || entry.label === kind)?.label ?? kind} ×`, pressed: true, onChange: () => setKindParam(null) }] : []),
    ],
    onClear: narrowed ? () => change({ [GEO_ENGINE_PARAM]: null, only: null, [KIND_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null }) : undefined,
    search: { label: "搜索信源", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
    summary,
  });

  const served = drawerRow ? {
    groups: groupsOfDomain(actions, drawerRow.domain),
    candidate: candidates.find((candidate) => candidate.domain === drawerRow.domain) ?? null,
  } : null;

  return (
    <section aria-label="信源" className="flex flex-col gap-6">
      {view === "cited" && (
        <>
          <SourcePictures kinds={kinds} selected={kind} onSelect={setKindParam} facts={concentration} />
          {rows.length === 0 ? (
            <Note action={narrowed || needle ? <Button variant="secondary" size="sm" onClick={() => { change({ [GEO_ENGINE_PARAM]: null, only: null, [KIND_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null }); setQuery(""); }}>清除筛选</Button> : undefined}>
              {needle ? `没有包含“${query.trim()}”的信源。` : "没有符合的信源。"}
            </Note>
          ) : (
            <div>
              <ListHeader label="按数字排序" columns={COLUMNS} sort={sort} onSort={sortBy} />
              <List divided label="信源">
                {visible.map(({ source, counts }) => (
                  <ListRow
                    key={source.id || source.domain}
                    title={<span className="block max-w-full min-w-0 truncate">{source.name || source.domain}</span>}
                    titleProps={{ "data-geo-source": source.domain }}
                    meta={<SourceMeta source={source} />}
                    selected={drawerRow?.domain === source.domain}
                    onOpen={() => openSource(source, current, null)}
                    columns={[
                      { key: "cited", label: "被引用", value: counts.cited.toLocaleString("zh-CN") },
                      {
                        key: "wrong",
                        label: "讲错的回答",
                        value: counts.wrong.toLocaleString("zh-CN"),
                        // The one red thing on a row, and the way to the answers it counts.
                        ...(counts.wrong > 0 ? { tone: "danger" as const, onOpen: () => openSource(source, current, "wrong") } : {}),
                      },
                      { key: "mentions", label: "提到你", value: counts.mentions.toLocaleString("zh-CN") },
                    ]}
                  />
                ))}
              </List>
              <ShowMore remaining={remaining} unit="个" onMore={more} />
            </div>
          )}
          {impostors.length > 0 && (
            <Disclosure summary="冒名站">
              <ul className="flex flex-col gap-1">
                {impostors.map((source) => (
                  <li key={source.id || source.domain} className="text-ui text-text-2">
                    {source.name ? `${source.name} · ${source.domain}` : source.domain}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}
      {view === "placeable" && (
        <Placeable
          places={places}
          anyAction={actions.length > 0}
          sources={sources}
          onOpen={(source) => openSource(source, "all", null)}
          onActions={() => navigate(geoDestinationPath(geoId, { tab: "actions" }))}
        />
      )}
      {drawerRow && (
        <GeoSourceDrawer
          geoId={geoId}
          project={project}
          source={drawerRow}
          engine={opened?.engine ?? "all"}
          focus={opened?.focus ?? null}
          served={served}
          onClose={closeSource}
        />
      )}
    </section>
  );
}

/** The two pictures above the list: the kinds of site (a bar is the list's filter) and the citations' concentration. */
function SourcePictures({
  kinds,
  selected,
  onSelect,
  facts,
}: {
  kinds: ReturnType<typeof kindCounts>;
  selected: string | null;
  onSelect: (kind: string | null) => void;
  facts: ReturnType<typeof concentrationFacts>;
}) {
  if (facts.sites === 0) return null;
  // The title is about the kinds the platform could name: 「其他」 is the sites it has no kind for, and "other is cited most" says
  // nothing. A page where no site has a kind draws no kinds card, and the concentration has the row.
  const named = kinds.filter((entry) => entry.key !== OTHER_KIND && entry.label !== "其他");
  const rows = kinds.slice(0, 8).map((entry) => ({ key: entry.key, label: entry.label, value: entry.citations, unit: "次", note: `${entry.sites.toLocaleString("zh-CN")} 个站` }));
  const concentration = {
    key: "concentration",
    span: (named.length === 0 ? 2 : 1) as 1 | 2,
    node: (
      <ChartCard title={concentrationTitle(facts)}>
        <SourceConcentration facts={facts} />
      </ChartCard>
    ),
  };
  return (
    <ChartGrid
      rows={[named.length === 0 ? [concentration] : [
        {
          key: "kinds",
          node: (
            <ChartCard title={zh`${named[0].label}是被引用最多的一类，${named[0].citations.toLocaleString("zh-CN")} 次`}>
              <BarList label="各类站点被引用的次数" rows={rows} selected={selected} onSelect={onSelect} tone="rival" />
            </ChartCard>
          ),
        },
        concentration,
      ]]}
    />
  );
}

/* --------------------------------------------------------------- placeable */

/** Where a place stands for an order now, in the reader's words: the market's, the brand's own, waiting, or why not. */
function availability(candidate: Candidate): { text: string; tone: "ok" | "wait" | "no" | "plain" } {
  if (candidate.route === "own") return { text: routeWord("own") ?? "自有渠道", tone: "ok" };
  if (candidate.route === "waiting_market") return { text: routeWord("waiting_market") ?? "", tone: "wait" };
  if (candidate.available === true) return { text: "现在可以下单", tone: "ok" };
  const why = unavailableWords(candidate.unavailableBecause);
  // Refused, and said why; or the market's own and the server has not said either way, which is its name and no more.
  if (candidate.available === false || candidate.route === "not_in_market" || why.length > 0) {
    return { text: [routeWord(candidate.route), ...why].filter(Boolean).join("；") || "现在不能下单", tone: "no" };
  }
  return { text: routeWord(candidate.route) ?? "", tone: "plain" };
}

function Placeable({
  places,
  anyAction,
  sources,
  onOpen,
  onActions,
}: {
  places: readonly Candidate[];
  anyAction: boolean;
  sources: readonly GeoSourceRow[];
  onOpen: (source: GeoSourceRow) => void;
  onActions: () => void;
}) {
  if (places.length === 0) {
    return (
      <Note action={anyAction ? undefined : <Button variant="secondary" size="sm" onClick={onActions}>去看行动</Button>}>
        {anyAction ? "没有符合的投放去处。" : "推荐的投放去处跟着行动来：行动定下以后，这里会列出每条行动要去的信源。"}
      </Note>
    );
  }
  return (
    <List divided label="可投放的信源">
      {places.map((place) => {
        const row = place.domain ? sources.find((source) => source.domain === place.domain) ?? null : null;
        const state = availability(place);
        const layer = place.layer ? GEO_SOURCE_LAYER_WORDS[place.layer] : null;
        const kind = sourceKindWord(place.kind);
        return (
          <ListRow
            key={place.key}
            title={<span className="block max-w-full min-w-0 truncate">{place.name || place.domain || "自有渠道"}</span>}
            titleProps={{ "data-geo-place": place.key }}
            onOpen={row ? () => onOpen(row) : undefined}
            meta={(
              <span className="flex flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {layer && <Tag>{layer}</Tag>}
                  {kind && <Tag>{kind}</Tag>}
                  {place.domain && place.name && <span className="min-w-0 max-w-full truncate text-caption text-text-3">{place.domain}</span>}
                </span>
                <span data-geo-place-state={state.tone} className={state.tone === "no" ? "text-warn-strong" : undefined}>{state.text}</span>
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  {place.engines.length > 0 && <span>{`被 ${place.engines.map(engineName).join("、")} 引用`}</span>}
                  {place.groups.length > 0 && <span>服务</span>}
                  {place.groups.slice(0, 3).map((group) => <ClusterLink key={group.id} groupId={group.id} className="relative z-sticky">{clusterName(group)}</ClusterLink>)}
                  {place.groups.length > 3 && <span>{`等 ${place.groups.length} 个问题群`}</span>}
                </span>
              </span>
            )}
            trailing={place.price !== null ? <span className="tabular-nums text-text-2">{yuan(place.price)}</span> : undefined}
          />
        );
      })}
    </List>
  );
}

/**
 * The line under a site's name: its kind, the 「自有」 tag when it is ours, and the domain in grey. The tags are not in the row's
 * title because the title is the row's one control and a tag is never a control. The other layer words (覆盖, 锚点) are about where
 * we would place content there, which is the drawer's to say.
 */
function SourceMeta({ source }: { source: GeoSourceRow }) {
  const kind = sourceKindWord(source.kind);
  const own = source.layer === "owned" ? GEO_SOURCE_LAYER_WORDS.owned : null;
  if (!kind && !own && !source.name) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {kind && <Tag>{kind}</Tag>}
      {own && <Tag tone="accent">{own}</Tag>}
      {source.name && <span className="min-w-0 max-w-full truncate text-caption text-text-3">{source.domain}</span>}
    </span>
  );
}
