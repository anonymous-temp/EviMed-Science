import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getGeoQuestions,
  unmeasureGeoQuestion,
  type GeoClusterRow,
  type GeoPool,
  type GeoProject,
  type GeoQuestion,
  type GeoQuestionGroup,
  type GeoQuestions,
} from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List, ListHeader, ListRow, type ListCell, type ListColumn } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { useGeoFrame, useGeoToolbar } from "../geoFrame";
import { useSharedGeoLoad } from "../geoProjectData";
import { geoDestinationPath, geoQuestionsView, GEO_VIEW_PARAM, type GeoQuestionsView } from "../geoTabs";
import { GEO_POOL_KINDS, GEO_POOLS, groupName, monthDay, platformName } from "../geoText";
import { clusterName, groupsByStage, groupTally, mentionText } from "../spine/clusterModel";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { ClusterLink } from "../spine/ClusterLink";
import { GEO_CLUSTER_FILTER_PARAM, useGeoDrawerAddress } from "../spine/drawerParams";
import { useGeoClusters } from "../spine/spineData";
import { answerPath } from "./geoTabText";
import { StepPending, TabError, TabSkeleton } from "./geoTabKit";
import { JourneyTab } from "./JourneyTab";
import { ShowMore, useShowMore } from "./showMore";

type PoolFilter = "all" | GeoPool;
type SortKey = "mention" | "wrong" | "actions" | "articles";

const KIND_WORDS: Readonly<Record<GeoQuestion["kind"], string>> = Object.freeze({
  typical: "典型问句",
  real: "真实问法",
  label_safety: "说明书安全题",
  client: "客户提供",
});

/** Questions listed before 「显示更多」 in the list of every question, and how many each press adds. */
const QUESTIONS_SHOWN = 30;

const VIEW_OPTIONS: ReadonlyArray<FilterOption<GeoQuestionsView>> = [
  { value: "pools", label: "按问句池" },
  { value: "journey", label: "按旅程" },
  { value: "all", label: "全部问句" },
];

const COLUMNS: ReadonlyArray<ListColumn & { key: SortKey }> = [
  { key: "mention", label: "被提到", sortable: true },
  { key: "wrong", label: "讲错", sortable: true },
  { key: "actions", label: "行动", sortable: true },
  { key: "articles", label: "稿件", sortable: true },
];

/**
 * 问题与回答 — what people ask AI, and what the engines answer (R19, audit C §2.3; plan §5.4). The question group is its object:
 * a row is one group — its name, its stage, how many questions and real phrasings, and four counts that each open what they
 * count — and a row opens the group's drawer, where the questions are with what every engine's latest answer did.
 *
 * Three views, one switch in the band: the groups under their **pools** (存量 · 增量 · 泛增量 · 风险监测, one vocabulary), under the
 * **journey** the person goes through (the emotion curve and the stages the run drew, then the groups in the stage they belong
 * to — by the stage's number where the run wrote one, else by its words), and **every question** in one list. The filters are the
 * band's; the groups' own numbers are counts and never a rate the platform withheld.
 *
 * A locked question set is versioned: an older version can be looked at (its groups carry no counts: the numbers are the
 * current set's), and removing a question writes a new one.
 */
export function QuestionsTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const [version, setVersion] = useState<number | null>(null);
  const questions = useSharedGeoLoad<GeoQuestions>(`questions:${geoId}:${version ?? "latest"}`, () => getGeoQuestions(geoId, version));
  const clusters = useGeoClusters(geoId);
  const [params, setParams] = useSearchParams();
  const view = geoQuestionsView(params.get(GEO_VIEW_PARAM));
  const switcher = {
    kind: "chips" as const,
    label: "视图",
    options: VIEW_OPTIONS,
    value: view,
    onChange: (next: string) => setParams((previous) => {
      const copy = new URLSearchParams(previous);
      if (next === "pools") copy.delete(GEO_VIEW_PARAM); else copy.set(GEO_VIEW_PARAM, next);
      return copy;
    }, { replace: true }),
  };
  const rows = clusters.state.kind === "ready" ? clusters.state.data.groups : [];

  // The journey is a page of its own kind: the emotion curve and the stages, then the groups in them.
  if (view === "journey") {
    return (
      <div data-geo-tab="questions" className="flex flex-col gap-8">
        <JourneyTab geoId={geoId} project={project} toolbar={{ filters: [switcher] }} />
        <StageGroups rows={rows} loading={clusters.state.kind === "loading"} />
        <ClusterDrawerHost geoId={geoId} project={project} />
      </div>
    );
  }
  if (questions.state.kind === "loading") return <TabSkeleton />;
  if (questions.state.kind === "error") return <TabError message={questions.state.message} onRetry={questions.reload} />;
  const data = questions.state.data;
  const groups = Array.isArray(data?.groups) ? data.groups.filter((group) => group && group.id) : [];
  if (groups.length === 0) return <StepPending geoId={geoId} project={project} step="questions" />;
  return (
    <QuestionPage
      geoId={geoId}
      project={project}
      view={view}
      switcher={switcher}
      data={data}
      groups={groups}
      rows={rows}
      onVersion={setVersion}
      onChanged={() => {
        // A removal writes a new set: show the newest one, and read every group of it again.
        setVersion(null);
        questions.reload();
        clusters.reload();
      }}
    />
  );
}

function QuestionPage({
  geoId,
  project,
  view,
  switcher,
  data,
  groups,
  rows,
  onVersion,
  onChanged,
}: {
  geoId: string;
  project: GeoProject;
  view: GeoQuestionsView;
  switcher: { kind: "chips"; label: string; options: ReadonlyArray<FilterOption<GeoQuestionsView>>; value: GeoQuestionsView; onChange: (value: string) => void };
  data: GeoQuestions;
  groups: GeoQuestionGroup[];
  rows: readonly GeoClusterRow[];
  onVersion: (version: number | null) => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const drawer = useGeoDrawerAddress();
  const frame = useGeoFrame();
  const [pool, setPool] = useState<PoolFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean } | null>(null);
  const needle = query.trim().toLowerCase();
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const pools = GEO_POOLS.filter((key) => groups.some((group) => group.pool === key));
  const options: FilterOption<PoolFilter>[] = [
    { value: "all", label: "全部" },
    ...pools.map((key) => ({ value: key, label: GEO_POOL_KINDS[key] })),
  ];
  const sets = Array.isArray(data.sets) ? data.sets.filter((set) => set && typeof set.version === "number") : [];
  const latest = sets.reduce<number | null>((top, set) => (top === null || set.version > top ? set.version : top), null);
  const current = data.version ?? latest;
  const editable = current === latest;
  const shownPools = pool === "all" || !pools.includes(pool as GeoPool) ? pools : [pool as GeoPool];

  const matches = useMemo(() => new Map(groups.map((group) => [group.id, matchGroup(group, needle)])), [groups, needle]);
  const found = groups.filter((group) => matches.get(group.id) && shownPools.includes(group.pool));
  const counts = useMemo(() => {
    const questions = groups.flatMap((group) => list(group.questions));
    return { groups: groups.length, measured: questions.filter((question) => question.isMeasured).length };
  }, [groups]);
  const matchedQuestions = found.reduce((sum, group) => sum + (matches.get(group.id)?.count ?? 0), 0);

  useGeoToolbar({
    filters: [
      switcher,
      { kind: "chips", label: "问句池", options, value: pools.includes(pool as GeoPool) ? pool : "all", onChange: (value) => setPool(value as PoolFilter) },
      ...(sets.length > 1 ? [{
        kind: "select" as const,
        label: "问句版本",
        options: [...sets].sort((a, b) => b.version - a.version).map((set) => ({
          value: String(set.version),
          label: [`第 ${set.version} 版`, set.lockedAt ? `${monthDay(set.lockedAt)}锁定` : null].filter(Boolean).join(" · "),
        })),
        value: current === null ? null : String(current),
        onChange: (value: string | null) => onVersion(value === null || Number(value) === latest ? null : Number(value)),
      }] : []),
    ],
    search: { label: "搜索问题", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
    summary: needle ? `匹配 ${matchedQuestions} 个问题` : `${counts.groups} 个问题群 · ${counts.measured} 问`,
  });

  const remove = (id: string) => {
    void unmeasureGeoQuestion(geoId, id)
      .then(() => {
        toast.success("已移出，之后的测量不再问这一句。");
        // A removal writes a new set and moves every count taken over the old one: the project's reads are stale (read once, behind
        // the page). Without a project above, the two this page holds are read again.
        if (frame) frame.data.invalidate(); else onChanged();
        onVersion(null);
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一句无法移出，请稍后重试。" })));
  };
  const go = (path: string) => () => navigate(path);
  const sortBy = (key: string) => setSort((now) => (now?.key === key ? { key: now.key, descending: !now.descending } : { key: key as SortKey, descending: true }));
  const order = (inPool: GeoQuestionGroup[]): GeoQuestionGroup[] => {
    if (!sort) return inPool;
    const value = (group: GeoQuestionGroup): number => {
      const row = rowById.get(group.id);
      if (!row) return 0;
      if (sort.key === "mention") return groupTally(row).mentioned;
      if (sort.key === "wrong") return groupTally(row).wrong;
      return sort.key === "actions" ? row.actions.total : row.articles.total;
    };
    return [...inPool].sort((a, b) => (sort.descending ? value(b) - value(a) : value(a) - value(b)));
  };

  if (view === "all") {
    return (
      <div data-geo-tab="questions" className="flex flex-col gap-6">
        <EveryQuestion
          geoId={geoId}
          groups={found}
          needle={needle}
          rowById={rowById}
          editable={editable}
          onRemove={remove}
          resetKey={`${pool}|${needle}`}
        />
        <ClusterDrawerHost geoId={geoId} project={project} />
      </div>
    );
  }

  return (
    <div data-geo-tab="questions" className="flex flex-col gap-6">
      {needle && found.length === 0 && (
        <p className="py-10 text-center text-ui text-text-3">{`没有包含“${query.trim()}”的问题。`}</p>
      )}
      {shownPools.map((key) => {
        const inPool = order(found.filter((group) => group.pool === key));
        if (inPool.length === 0) return null;
        return (
          <Section key={key} title={GEO_POOL_KINDS[key]} count={`${inPool.length} 个`} level="sub" className="mt-0">
            <ListHeader label="按数字排序" columns={COLUMNS} sort={sort ?? undefined} onSort={sortBy} className="mb-1" />
            <List label={`${GEO_POOL_KINDS[key]}的问题群`} divided>
              {inPool.map((group) => {
                const row = rowById.get(group.id) ?? null;
                const match = matches.get(group.id)!;
                return (
                  <GroupRow
                    key={group.id}
                    group={group}
                    row={row}
                    match={match}
                    selected={drawer.group === group.id}
                    onOpen={() => drawer.open({ group: group.id })}
                    onActions={go(geoDestinationPath(geoId, { tab: "actions" }, { [GEO_CLUSTER_FILTER_PARAM]: group.id }))}
                    onErrors={go(geoDestinationPath(geoId, { tab: "accuracy" }, { [GEO_CLUSTER_FILTER_PARAM]: group.id }))}
                  />
                );
              })}
            </List>
          </Section>
        );
      })}
      <ClusterDrawerHost geoId={geoId} project={project} />
    </div>
  );
}

/* ------------------------------------------------------------- one group */

/** What of a group a search leaves: nothing (no match), or the questions that matched. */
interface GroupMatch {
  /** The questions the search hit; empty without a search. */
  hits: GeoQuestion[];
  /** The group is named for what the reader typed: they asked for the topic, and every question stays. */
  topic: boolean;
  /** How many questions the group puts in front of the reader. */
  count: number;
}

function matchGroup(group: GeoQuestionGroup, needle: string): GroupMatch | null {
  const questions = list(group.questions);
  if (!needle) return { hits: [], topic: true, count: questions.filter((question) => question.isMeasured).length };
  const hit = (text: string | null | undefined) => (text ?? "").toLowerCase().includes(needle);
  const topic = hit(groupName(group.name)) || hit(group.name);
  const typical = (group.typicalQuestion ?? "").trim();
  const hits = topic ? questions : questions.filter((question) => hit(question.text));
  // The group's typical question stands for itself when no measured question carries it.
  const typicalHit = hit(typical) && !questions.some((question) => question.text.trim() === typical);
  if (!topic && hits.length === 0 && !typicalHit) return null;
  return { hits, topic, count: hits.length + (typicalHit ? 1 : 0) };
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function GroupRow({
  group,
  row,
  match,
  selected,
  onOpen,
  onActions,
  onErrors,
}: {
  group: GeoQuestionGroup;
  row: GeoClusterRow | null;
  match: GroupMatch;
  selected: boolean;
  onOpen: () => void;
  onActions: () => void;
  onErrors: () => void;
}) {
  const questions = list(group.questions);
  const measured = questions.filter((question) => question.isMeasured).length;
  const real = questions.filter((question) => question.kind === "real").length;
  const meta = [group.journeyStage || null, `${measured} 问`, `${real} 条原话`].filter(Boolean).join(" · ");
  // The cells are the current set's: a group of an older version has no counts to draw.
  const columns: ListCell[] | undefined = row ? (() => {
    const reading = mentionText(row);
    const tally = groupTally(row);
    return [
      { key: "mention", label: "被提到", value: reading.counts === "—" ? "—" : <>{reading.counts}{reading.rate && <span className="ml-1 text-text-3">{reading.rate}</span>}</>, onOpen },
      {
        key: "wrong",
        label: "讲错",
        value: String(row.errors.open > 0 ? row.errors.open : tally.wrong),
        ...((row.errors.open > 0 || tally.wrong > 0) ? { tone: "danger" as const, onOpen: onErrors } : {}),
      },
      { key: "actions", label: "行动", value: String(row.actions.total), ...(row.actions.total > 0 ? { onOpen: onActions } : {}) },
      { key: "articles", label: "稿件", value: String(row.articles.total), ...(row.articles.total > 0 ? { onOpen: onActions } : {}) },
    ];
  })() : undefined;
  const matched = !match.topic && match.hits.length > 0 ? match.hits.slice(0, 2).map((question) => question.text).join("；") : null;
  return (
    <ListRow
      title={clusterName({ name: group.name })}
      titleProps={{ "data-geo-group": group.id }}
      onOpen={onOpen}
      selected={selected}
      meta={(
        <span className="flex flex-col">
          <span>{meta}</span>
          {matched && <span className="text-text-2">{`匹配：${matched}`}</span>}
        </span>
      )}
      trailing={group.isControl ? <Tag title="只监测、不写稿：给它写稿会让它退出对照组">对照组</Tag> : undefined}
      columns={columns}
    />
  );
}

/* --------------------------------------------------------- every question */

function EveryQuestion({
  geoId,
  groups,
  needle,
  rowById,
  editable,
  onRemove,
  resetKey,
}: {
  geoId: string;
  groups: readonly GeoQuestionGroup[];
  needle: string;
  rowById: ReadonlyMap<string, GeoClusterRow>;
  editable: boolean;
  onRemove: (id: string) => void;
  resetKey: string;
}) {
  const all = useMemo(() => groups.flatMap((group) => list(group.questions)
    .filter((question) => !needle || question.text.toLowerCase().includes(needle) || groupName(group.name).toLowerCase().includes(needle))
    .map((question) => ({ question, group }))), [groups, needle]);
  const { visible, remaining, more } = useShowMore(all, { first: QUESTIONS_SHOWN, step: QUESTIONS_SHOWN, resetKey });
  if (all.length === 0) {
    return <p className="py-10 text-center text-ui text-text-3">{needle ? "没有符合的问题。" : "还没有问题。"}</p>;
  }
  return (
    <section aria-label="全部问句" data-geo-all-questions="">
      <List label="全部问句" divided>
        {visible.map(({ question, group }) => {
          const answered = Array.isArray(question.answers) ? question.answers.find((answer) => answer?.snapshotId) : null;
          const row = rowById.get(group.id) ?? null;
          return (
            <ListRow
              key={question.id}
              title={<span className="max-w-measure">{question.text}{answered && <span className="sr-only">，看回答</span>}</span>}
              titleProps={{ "data-geo-question": question.id }}
              to={answered ? answerPath(geoId, answered.snapshotId) : undefined}
              meta={(
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <ClusterLink groupId={group.id} className="relative z-sticky">{row ? clusterName(row) : groupName(group.name)}</ClusterLink>
                  <span>{[KIND_WORDS[question.kind] ?? null, platformName(question.platform), question.isMeasured ? null : "不在测量里"].filter(Boolean).join(" · ")}</span>
                </span>
              )}
              trailing={answered ? <span aria-hidden="true" className="max-sm:hidden">看回答</span> : undefined}
              menu={editable && question.isMeasured
                ? <Menu label={`“${question.text}”的操作`} items={[{ label: "移出测量问句", onSelect: () => onRemove(question.id) }]} />
                : undefined}
            />
          );
        })}
      </List>
      <ShowMore remaining={remaining} unit="个问题" onMore={more} />
    </section>
  );
}

/* ------------------------------------------------------- the journey view */

/**
 * The groups in the stage they belong to (R19, audit C §2.3 「按旅程」): a column for each stage of the journey, in its order, and
 * in it the groups that ask there — by the stage's number where the run wrote one, by its words where not. The number a group's
 * name carries is the same counts as everywhere: how many answers named us, how many misstated us.
 */
function StageGroups({ rows, loading }: { rows: readonly GeoClusterRow[]; loading: boolean }) {
  const stages = useMemo(() => groupsByStage(rows), [rows]);
  if (loading && rows.length === 0) return null;
  if (stages.length === 0) return null;
  return (
    <Section title="各阶段的问题群" count={`${rows.length} 个`} level="sub" className="mt-0">
      <div data-geo-stage-groups="" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {stages.map((stage) => (
          <div key={stage.key} data-geo-stage={stage.key} className="min-w-0 rounded-card border border-border p-3">
            <p className="mb-2 flex items-baseline gap-2 text-ui text-text">
              {stage.no !== null && <span className="text-caption tabular-nums text-text-3">{stage.no}</span>}
              <span className="min-w-0 truncate">{stage.name}</span>
              <span className="ml-auto shrink-0 text-caption tabular-nums text-text-3">{`${stage.groups.length} 个`}</span>
            </p>
            <ul aria-label={`${stage.name}的问题群`} className="flex flex-col divide-y divide-faint">
              {stage.groups.map((group) => {
                const reading = mentionText(group);
                const wrong = groupTally(group).wrong;
                return (
                  <li key={group.id} className="flex items-baseline gap-2 py-1.5 text-ui">
                    <ClusterLink groupId={group.id} className="min-w-0 flex-1 truncate">{clusterName(group)}</ClusterLink>
                    {group.isControl && <Tag>对照组</Tag>}
                    <span className="shrink-0 text-caption tabular-nums text-text-2">{reading.counts}</span>
                    {wrong > 0 && <span className="shrink-0 text-caption tabular-nums text-danger">{`讲错 ${wrong}`}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
