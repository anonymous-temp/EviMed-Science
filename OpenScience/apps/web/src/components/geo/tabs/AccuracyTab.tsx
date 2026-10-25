import { GeoAnalysisWorkbench } from "../GeoAnalysisWorkbench";
import { useMemo, useState } from "react";
import {
  readGeoCell,
  type GeoDiagnosis,
  type GeoErrorCounts,
  type GeoErrorRow,
  type GeoErrorType,
  type GeoProject,
} from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { Delta } from "@/components/ui/Delta";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import type { ShareSegment } from "@/components/charts/ShareBar";
import { useGeoErrorPages } from "../useGeoErrorPages";
import { geoMayConverse, useGeoToolbar } from "../geoFrame";
import { useGeoDiagnosis } from "../geoProjectData";
import { formatGeoValue, geoCellPhrase } from "../GeoCellText";
import { coverageNotice, denominatorLine, readingChange, shownDelta, tileValue } from "../geoOverviewModel";
import { engineName, GEO_ERROR_TYPE_WORDS, groupName } from "../geoText";
import { GEO_VIEW_PARAM, geoSectionId } from "../geoTabs";
import { ClaimRow } from "../spine/ClaimRow";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { GEO_CLUSTER_FILTER_PARAM, GEO_ENGINE_PARAM, useGeoDrawerAddress, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { GeoErrorGroupDrawer } from "../GeoErrorGroupDrawer";
import {
  claimRows,
  claimRowsOfEngine,
  correctionsOf,
  enginesOf,
  ERROR_SHOWS,
  ERROR_TRACE_WORDS,
  filterErrors,
  isSevereError,
  type ClaimRow as ClaimModel,
  type ErrorShow,
  type ErrorTrace,
} from "../spine/errorModel";
import { questionGroupIndex } from "../spine/clusterModel";
import { useGeoActions, useGeoQuestionSet } from "../spine/spineData";
import { useCorrectionHandoff } from "../spine/useCorrectionHandoff";
import { ErrorCharts } from "./AccuracyCharts";
import { metricName, metricUnit } from "./geoTabText";
import { TabError, TabSkeleton } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";

/**
 * 准确与安全 — the part of this product no general AI-visibility tool has
 * (appendix E §0.6): not “are we mentioned” but “is what it says about the
 * medicine true, and would a wrong answer hurt someone”.
 *
 * A data page (R19, plan T4): the accuracy rate first, drawn as what it is — how many statements were right against how many
 * were wrong —, then the four charts of what the wrong ones are made of (by answer, by severity and engine, by kind, by where
 * the engine took them from), then the list. The list is **by claim**: a claim five engines tell is one row, not five, with the
 * engines, the gravest grade, the page it was traced to and where its correction stands; a row opens the claim's drawer. The
 * charts and the list share one selection — a bar of a chart narrows the list, and the toolbar shows what it is narrowed to.
 *
 * Red belongs to the severity badge and the ✗; the sentences themselves are body text, which is the difference between a page a
 * reader works through and the wall of red the old board was. The filters are the band's toolbar; nothing under the list filters it.
 */

/** How many claims the list shows before 「显示更多」. */
/**
 * The wrong statements shown before 「显示更多」, and how many each press adds. The two pictures above the list carry fifteen rows of their
 * own (five engines, the reasons, the keys of two bars): twenty statements made 29 rows on the first screen of the owner's project, and a
 * data page's first screen holds twenty (the walk's `rows-ceiling`). The five most serious come first, as the list is sorted; the
 * heading says how many there are.
 */
const FIRST_SHOWN = 5;
const PAGE = 10;
const SAFETY_METRICS: ReadonlyArray<{ ids: readonly string[]; polarity: "up" | "down" }> = [
  { ids: ["M-11"], polarity: "up" },
  { ids: ["M-12"], polarity: "up" },
  { ids: ["M-15"], polarity: "down" },
];

type AccuracyView = "claims" | "engines";
const VIEW_OPTIONS: ReadonlyArray<FilterOption<AccuracyView>> = [
  { value: "claims", label: "按说法" },
  { value: "engines", label: "按引擎" },
];
const SHOW_LABELS: Record<Exclude<ErrorShow, "all">, string> = { severe: "严重", open: "待处理", acting: "处置中" };
const TYPE_PARAM = "type";
const TRACE_PARAM = "trace";

export function AccuracyTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const diagnosis = useGeoDiagnosis(geoId);
  const change = useGeoSearchChange();
  const refresh = () => { change({ selectionRef: null }); diagnosis.reload(); };
  if (diagnosis.state.kind === "loading") return <TabSkeleton />;
  if (diagnosis.state.kind === "error") return <TabError message={diagnosis.state.message} onRetry={refresh} />;
  const diag = diagnosis.state.data;
  return <><Accuracy geoId={geoId} project={project} diagnosis={diag} refresh={refresh} /><GeoAnalysisWorkbench embedded geoId={geoId} project={project} initialView="V12"/></>;
}

function Accuracy({
  geoId,
  project,
  diagnosis,
  refresh,
}: {
  geoId: string;
  project: GeoProject;
  diagnosis: GeoDiagnosis;
  refresh: () => void;
}) {
  const denominator = denominatorLine(project, diagnosis);
  const errors = useMemo(() => Array.isArray(diagnosis.errors) ? diagnosis.errors : [], [diagnosis.errors]);
  const counts = errorTotals(diagnosis, errors);
  const accuracy = project.overview.metrics.find((metric) => metric.key === "accuracy") ?? null;
  // The accuracy rate's change is stated by the one rule: where its two readings were measured over different things there is no
  // arrow, and the band says so once.
  const accuracyChange = readingChange(accuracy?.trend);
  const modes = diagnosis.failureModes ?? null;
  const correct = readGeoCell(modes?.correct);
  const wrongOurs = readGeoCell(modes?.wrongOurs);
  const omitted = readGeoCell(modes?.omitted);
  const wrongRival = readGeoCell(modes?.wrongCompetitor);
  const partial = readGeoCell(modes?.partial);
  const unknown = readGeoCell(modes?.unknown);
  const refused = readGeoCell(modes?.refused);

  const tiles = [
    {
      key: "accuracy",
      label: "事实准确率",
      ...tileValue(accuracy?.cell, "percent"),
      // The accuracy rate has no measured band: its change is stated as a change, by the one rule.
      delta: accuracy ? shownDelta(accuracyChange) : null,
      note: accuracy?.target != null ? `目标 ${formatGeoValue(accuracy.target, "percent")}` : null,
      hint: accuracy ? geoCellPhrase(accuracy.cell, "percent") : undefined as string | undefined,
      polarity: "up" as const,
      tone: "default" as const,
      lead: true,
    },
    {
      key: "severe",
      label: "严重讲错",
      value: String(counts.severe),
      unit: "条" as string | undefined,
      placeholder: false,
      hint: undefined as string | undefined,
      delta: null,
      // No second number beneath it: every open error, of every grade, is a chip of the list below.
      note: null as string | null,
      polarity: "down" as const,
      tone: counts.severe > 0 ? "safety" as const : "default" as const,
      lead: false,
    },
    ...SAFETY_METRICS.flatMap(({ ids, polarity }) => {
      const row = (Array.isArray(diagnosis.more) ? diagnosis.more : []).find((item) => item && ids.includes(item.metricId));
      if (!row) return [];
      const cell = readGeoCell(row.cell);
      const unit = metricUnit(row.metricId);
      return [{
        key: row.metricId,
        label: metricName(row.metricId) ?? row.name,
        ...tileValue(cell, unit),
        delta: null,
        note: polarity === "down" ? "越低越好" : null,
        hint: geoCellPhrase(cell, unit) as string | undefined,
        polarity,
        tone: "default" as const,
        lead: false,
      }];
    }),
  ];

  const composition: ShareSegment[] = [
    { key: "correct", label: "讲对我方", value: correct.numerator ?? 0, tone: "own" },
    { key: "omitted", label: "漏提我方", value: omitted.numerator ?? 0, tone: "quiet" },
    { key: "wrongOurs", label: "讲错我方", value: wrongOurs.numerator ?? 0, tone: "s3" },
    { key: "wrongRival", label: "讲错竞品", value: wrongRival.numerator ?? 0, tone: "s1" },
    { key: "partial", label: "部分可判定", value: partial.numerator ?? 0, tone: "rival-2" },
    { key: "unknown", label: "尚无法判定", value: unknown.numerator ?? 0, tone: "rival-3" },
    { key: "refused", label: "明确拒答", value: refused.numerator ?? 0, tone: "quiet" },
  ];

  // ---- the selection the charts and the list share, kept in the address so the way back from an answer returns to the list as it was
  const [engineParam, setEngineParam] = useGeoSearchParam(GEO_ENGINE_PARAM);
  const [typeParam, setTypeParam] = useGeoSearchParam(TYPE_PARAM);
  const [traceParam, setTraceParam] = useGeoSearchParam(TRACE_PARAM);
  const [clusterParam, setClusterParam] = useGeoSearchParam(GEO_CLUSTER_FILTER_PARAM);
  const [showParam, setShowParam] = useGeoSearchParam("show");
  const [viewParam, setViewParam] = useGeoSearchParam(GEO_VIEW_PARAM);
  const change = useGeoSearchChange();
  const [query, setQuery] = useState("");
  const drawer = useGeoDrawerAddress();
  const handoff = useCorrectionHandoff(geoId, project);
  const [busyClaim, setBusyClaim] = useState<string | null>(null);

  const actions = useGeoActions(geoId);
  const questionSet = useGeoQuestionSet(geoId);
  const groupOf = useMemo(() => questionGroupIndex(questionSet.state.kind === "ready" ? questionSet.state.data?.groups : []), [questionSet.state]);
  // The actions say where a claim's correction stands; a page that cannot read them still lists the claims.
  const everyAction = useMemo(() => (actions.state.kind === "ready" && Array.isArray(actions.state.data?.actions) ? actions.state.data.actions : []), [actions.state]);

  const view: AccuracyView = viewParam === "engines" ? "engines" : "claims";
  const sizes: Record<ErrorShow, number> = { severe: counts.severe, open: counts.open, acting: counts.working, all: counts.total };
  const showOptions: FilterOption<ErrorShow>[] = [
    ...(["severe", "open", "acting"] as const).filter((key) => sizes[key] > 0).map((key) => ({ value: key, label: SHOW_LABELS[key], count: sizes[key] })),
    { value: "all", label: "全部", count: sizes.all },
  ];
  const wanted = ERROR_SHOWS.find((key) => key === showParam);
  const show: ErrorShow = wanted && showOptions.some((option) => option.value === wanted) ? wanted : counts.severe > 0 ? "severe" : "all";

  const engines = diagnosis.selection?.engines ?? project.engines;
  const engine = engineParam && engines.includes(engineParam) ? engineParam : null;
  const type = typeParam === "unknown" ? "unknown" : (Object.keys(GEO_ERROR_TYPE_WORDS) as GeoErrorType[]).find((key) => key === typeParam) ?? null;
  const trace = (["traced", "unattributable", "noRetrieval"] as const).find((key) => key === traceParam) ?? null;
  // The groups that have a wrong claim told in answers to their questions: a filter offers only what is there.
  const groupsWithErrors = useMemo(() => [...new Map([...groupOf.values()].map(group => [group.id, { value: group.id, label: groupName(group.name) || "未命名问题群" }])).values()], [groupOf]);
  const cluster = clusterParam && groupsWithErrors.some((entry) => entry.value === clusterParam) ? clusterParam : null;
  const pages = useGeoErrorPages(geoId, diagnosis, {
    ...(show === "all" ? {} : { errorJudgmentState: "active" }),
    ...(show === "severe" ? { errorSeverities: ["S3", "S4"], errorStatuses: ["open", "acting", "awaiting_remeasure"] }
      : show === "open" ? { errorStatuses: ["open"] } : show === "acting" ? { errorStatuses: ["acting", "awaiting_remeasure"] } : {}),
    ...(type ? { errorTypes: [type] } : {}), ...(trace ? { errorTrace: trace } : {}), errorSearch: query.trim(),
  }, refresh);
  const filtered = useMemo(() => filterErrors(pages.data?.errors ?? [], { show, engine, type, trace, query, questions: cluster ? new Set([...groupOf.entries()].filter(([, group]) => group.id === cluster).map(([id]) => id)) : null }), [pages.data, show, engine, type, trace, query, cluster, groupOf]);
  const claims = useMemo(() => claimRows(filtered), [filtered]);
  const narrowed = engine !== null || type !== null || trace !== null || cluster !== null || query.trim() !== "";
  // The server counts every row; the page carries a capped list. Said only while the list is the status chip alone.
  const total = pages.data?.errorPage?.total ?? null;
  const sections = useMemo(
    () => (view === "engines" ? enginesOf(filtered).map((name) => ({ engine: name, claims: claimRowsOfEngine(filtered, name) })) : []),
    [view, filtered],
  );
  const flat = useMemo(
    () => (view === "engines" ? sections.flatMap((section) => section.claims.map((claim) => ({ engine: section.engine, claim }))) : claims.map((claim) => ({ engine: null as string | null, claim }))),
    [view, sections, claims],
  );
  const { visible, remaining, more } = useShowMore(flat, { first: FIRST_SHOWN, step: PAGE, resetKey: `${view}|${show}|${engine}|${type}|${trace}|${cluster}|${query.trim()}` });

  const clearAll = () => {
    change({ [GEO_ENGINE_PARAM]: null, [TYPE_PARAM]: null, [TRACE_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null });
    setQuery("");
  };
  const hasErrors = counts.total > 0 || errors.length > 0;
  useGeoToolbar(hasErrors ? {
    filters: [
      { kind: "chips", label: "视图", options: VIEW_OPTIONS, value: view, onChange: (value) => setViewParam(value === "claims" ? null : value) },
      { kind: "chips", label: "处置状态", options: showOptions, value: show, onChange: (value) => setShowParam(value) },
      ...(engines.length > 1 ? [{
        kind: "select" as const,
        label: "引擎",
        allLabel: "全部引擎",
        options: engines.map((name) => ({ value: name, label: engineName(name) })),
        value: engine,
        onChange: setEngineParam,
      }] : []),
      ...(groupsWithErrors.length > 1 ? [{
        kind: "select" as const,
        label: "问题群",
        allLabel: "全部问题群",
        options: groupsWithErrors,
        value: cluster,
        onChange: setClusterParam,
      }] : []),
      ...(type ? [{ kind: "toggle" as const, label: `类型：${type === "unknown" ? "未知" : GEO_ERROR_TYPE_WORDS[type]} ×`, pressed: true, onChange: () => setTypeParam(null) }] : []),
      ...(trace ? [{ kind: "toggle" as const, label: `出处：${ERROR_TRACE_WORDS[trace]} ×`, pressed: true, onChange: () => setTraceParam(null) }] : []),
    ],
    search: { label: "搜索说法", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
    onClear: narrowed ? clearAll : undefined,
    summary: total == null ? "正在读取讲错清单" : `共 ${total} 条讲错 · 已读取 ${filtered.length} 条，归为 ${claims.length} 条说法`,
  } : null);

  const product = project.product?.brandName || project.product?.genericName || project.name;
  // Writing a correction opens the conversation with staged context, which needs run and edit (`geoMayConverse`).
  const canRun = geoMayConverse(project);
  const correctClaim = (claim: ClaimModel) => {
    setBusyClaim(claim.key);
    void handoff(claim, product).finally(() => setBusyClaim(null));
  };

  const rowOf = (claim: ClaimModel, showEngines: boolean) => (
    <ClaimRow
      key={`${claim.key}:${showEngines ? "all" : claim.engines.join(",")}`}
      claim={claim}
      showEngines={showEngines}
      corrections={correctionsOf(claim, everyAction)}
      selected={drawer.error === claim.key}
      canRun={canRun}
      busy={busyClaim === claim.key}
      onOpen={() => drawer.open({ error: claim.key })}
      onCorrect={() => correctClaim(claim)}
    />
  );


  return (
    <div data-geo-tab="accuracy" className="flex flex-col gap-6">
      <StatBand label="准确与安全" footnote={[denominator, coverageNotice(accuracyChange)].filter(Boolean).join(" · ") || null} columns={Math.min(5, Math.max(2, tiles.length)) as 2 | 3 | 4 | 5}>
        {tiles.map((tile) => (
          <StatTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            hint={tile.hint}
            lead={tile.lead}
            tone={tile.tone}
            placeholder={tile.placeholder}
            delta={<Delta value={tile.delta} unit="point" polarity={tile.polarity} tone={tile.tone === "safety" ? "safety" : "default"} />}
            note={tile.note}
          />
        ))}
      </StatBand>

      <ErrorCharts
        errors={errors}
        summary={pages.data?.activeErrorSummary ?? diagnosis.activeErrorSummary ?? pages.data?.errorSummary ?? diagnosis.scopeErrorSummary ?? diagnosis.errorSummary}
        composition={composition}
        compositionTitle={correct.numerator != null && wrongOurs.numerator != null
          // Composition is answer-level, with assessment uncertainty visible beside it.
          ? `按回答计，讲错我方 ${wrongOurs.numerator.toLocaleString("zh-CN")} 次、讲对 ${correct.numerator.toLocaleString("zh-CN")} 次`
          : "这一轮的回答里我方出现在哪些位置"}
        denominator={denominator}
        historical={accuracy?.cell.methodVersion === null}
        selection={{
          engine,
          type,
          trace,
          onEngine: setEngineParam,
          onType: (next) => setTypeParam(next),
          onTrace: (next: ErrorTrace | null) => setTraceParam(next),
        }}
      />

      {hasErrors && (
        // The block the rail's 「诊断」 and a 「需要你」 row scroll to (`GEO_TAB_SECTIONS`).
        <div id={geoSectionId("errors")}>
          <Section
            title={view === "claims" ? "讲错清单，按严重度排序" : "讲错清单，按引擎"}
            count={total == null ? undefined : `共 ${total} 条讲错 · 本页 ${claims.length} 条说法`}
            level="section"
          >
            {pages.error && <Note action={<Button variant="secondary" size="sm" onClick={pages.retry}>{pages.stale ? "刷新范围" : "重试"}</Button>}>{pages.stale ? "判定或测量范围已经变化，请刷新后继续。" : pages.error}</Note>}
            {pages.loading && !pages.data ? <TabSkeleton /> : flat.length === 0 ? (
              <Note action={narrowed ? <Button variant="secondary" size="sm" onClick={clearAll}>清除筛选</Button> : undefined}>
                {narrowed ? "没有符合的说法。" : "这一类里没有讲错。"}
              </Note>
            ) : (
              <div data-geo-error-list="">
                {view === "claims" ? (
                  <List label="讲错的说法" divided>
                    {visible.map(({ claim }) => rowOf(claim, true))}
                  </List>
                ) : (
                  sections.map((section) => {
                    const mine = visible.filter((entry) => entry.engine === section.engine);
                    if (mine.length === 0) return null;
                    return (
                      <Section key={section.engine} title={engineName(section.engine)} count={`${section.claims.length} 条说法`} level="sub" className="mt-4 first:mt-0">
                        <List label={`${engineName(section.engine)}讲错的说法`} divided>
                          {mine.map(({ claim }) => rowOf(claim, false))}
                        </List>
                      </Section>
                    );
                  })
                )}
                <ShowMore remaining={remaining} unit="条说法" onMore={more} />
                {remaining === 0 && pages.data?.errorPage?.more && <Button variant="secondary" size="sm" loading={pages.loading} onClick={pages.more}>读取更多讲错</Button>}
              </div>
            )}

          </Section>
        </div>
      )}

      {drawer.error && <GeoErrorGroupDrawer geoId={geoId} project={project} fingerprint={drawer.error}
        selectionRef={diagnosis.selection?.reference} actions={everyAction} groupOf={groupOf} onClose={drawer.close} onRefreshScope={refresh}/>}
      <ClusterDrawerHost geoId={geoId} project={project} />
    </div>
  );
}

/**
 * The project's errors by status, from the server's count over every row when it sent one (the list it carries is capped), else
 * from the rows in hand. `working` is everything being handled: acted on, or waiting for the remeasure that confirms it.
 */
export function errorTotals(diagnosis: GeoDiagnosis, rows: readonly GeoErrorRow[]): { total: number; open: number; working: number; closed: number; severe: number } {
  const counted: GeoErrorCounts | undefined = diagnosis.errorCounts;
  if (counted && typeof counted.total === "number") {
    return { total: counted.total, open: counted.open, working: counted.acting + counted.awaiting_remeasure, closed: counted.closed, severe: counted.severe };
  }
  return {
    total: rows.length,
    open: rows.filter((error) => error.judgmentState !== "withdrawn" && error.status === "open").length,
    working: rows.filter((error) => error.judgmentState !== "withdrawn" && (error.status === "acting" || error.status === "awaiting_remeasure")).length,
    closed: rows.filter((error) => error.judgmentState !== "withdrawn" && error.status === "closed").length,
    severe: rows.filter(isSevereError).length,
  };
}
