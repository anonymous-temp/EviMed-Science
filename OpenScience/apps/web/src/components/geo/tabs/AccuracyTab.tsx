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
import { Drawer } from "@/components/ui/Drawer";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import type { ShareSegment } from "@/components/charts/ShareBar";
import { useGeoToolbar } from "../geoFrame";
import { useGeoDiagnosis, useGeoMonitoring } from "../geoProjectData";
import { formatGeoValue, geoCellPhrase } from "../GeoCellText";
import { coverageNotice, denominatorLine, readingChange, shownDelta, tileValue } from "../geoOverviewModel";
import { engineName, GEO_ERROR_TYPE_WORDS, groupName } from "../geoText";
import { GEO_VIEW_PARAM, geoSectionId } from "../geoTabs";
import { ClaimRow } from "../spine/ClaimRow";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { GEO_CLUSTER_FILTER_PARAM, GEO_ENGINE_PARAM, useGeoDrawerAddress, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { ErrorDrawer } from "../spine/ErrorDrawer";
import {
  claimRows,
  claimRowsOfEngine,
  correctionBrief,
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
import { useOpenGeoConversation } from "../useOpenGeoConversation";
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
const PAGE = 20;
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
  const monitoring = useGeoMonitoring(geoId);
  if (diagnosis.state.kind === "loading") return <TabSkeleton />;
  if (diagnosis.state.kind === "error") return <TabError message={diagnosis.state.message} onRetry={diagnosis.reload} />;
  const diag = diagnosis.state.data;
  const fresh = monitoring.state.kind === "ready" ? monitoring.state.data.newErrors : [];
  return <Accuracy geoId={geoId} project={project} diagnosis={diag} fresh={Array.isArray(fresh) ? fresh : []} />;
}

function Accuracy({
  geoId,
  project,
  diagnosis,
  fresh,
}: {
  geoId: string;
  project: GeoProject;
  diagnosis: GeoDiagnosis;
  fresh: GeoErrorRow[];
}) {
  const denominator = denominatorLine(project, diagnosis);
  const known = new Set((Array.isArray(diagnosis.errors) ? diagnosis.errors : []).map((error) => error?.id));
  const errors = [
    ...(Array.isArray(diagnosis.errors) ? diagnosis.errors : []),
    ...fresh.filter((error) => error && error.id && !known.has(error.id)),
  ].filter((error) => error && error.id);
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
  const open = useOpenGeoConversation();
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

  const engines = enginesOf(errors);
  const engine = engineParam && engines.includes(engineParam) ? engineParam : null;
  const type = (Object.keys(GEO_ERROR_TYPE_WORDS) as GeoErrorType[]).find((key) => key === typeParam) ?? null;
  const trace = (["traced", "unattributable", "noRetrieval"] as const).find((key) => key === traceParam) ?? null;
  // The groups that have a wrong claim told in answers to their questions: a filter offers only what is there.
  const groupsWithErrors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const error of errors) {
      const group = error.questionId ? groupOf.get(error.questionId) : undefined;
      if (group) seen.set(group.id, group.name);
    }
    return [...seen.entries()].map(([value, name]) => ({ value, label: groupName(name) || "未命名问题群" }));
  }, [errors, groupOf]);
  const cluster = clusterParam && groupsWithErrors.some((entry) => entry.value === clusterParam) ? clusterParam : null;
  const questions = useMemo(() => {
    if (!cluster) return null;
    return new Set([...groupOf.entries()].filter(([, group]) => group.id === cluster).map(([id]) => id));
  }, [cluster, groupOf]);

  const filtered = useMemo(() => filterErrors(errors, { show, engine, type, trace, questions, query }), [errors, show, engine, type, trace, questions, query]);
  const claims = useMemo(() => claimRows(filtered), [filtered]);
  const everyClaim = useMemo(() => claimRows(errors), [errors]);
  const narrowed = engine !== null || type !== null || trace !== null || cluster !== null || query.trim() !== "";
  // The server counts every row; the page carries a capped list. Said only while the list is the status chip alone.
  const unlisted = narrowed ? 0 : Math.max(0, sizes[show] - filtered.length);
  const sections = useMemo(
    () => (view === "engines" ? enginesOf(filtered).map((name) => ({ engine: name, claims: claimRowsOfEngine(filtered, name) })) : []),
    [view, filtered],
  );
  const flat = useMemo(
    () => (view === "engines" ? sections.flatMap((section) => section.claims.map((claim) => ({ engine: section.engine, claim }))) : claims.map((claim) => ({ engine: null as string | null, claim }))),
    [view, sections, claims],
  );
  const { visible, remaining, more } = useShowMore(flat, { first: PAGE, step: PAGE, resetKey: `${view}|${show}|${engine}|${type}|${trace}|${cluster}|${query.trim()}` });

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
      ...(type ? [{ kind: "toggle" as const, label: `类型：${GEO_ERROR_TYPE_WORDS[type]} ×`, pressed: true, onChange: () => setTypeParam(null) }] : []),
      ...(trace ? [{ kind: "toggle" as const, label: `出处：${ERROR_TRACE_WORDS[trace]} ×`, pressed: true, onChange: () => setTraceParam(null) }] : []),
    ],
    search: { label: "搜索说法", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
    onClear: narrowed ? clearAll : undefined,
    summary: `${claims.length} 条说法 · ${filtered.length} 条讲错`,
  } : null);

  const product = project.product?.brandName || project.product?.genericName || project.name;
  const abilities = project.access?.abilities;
  const canRun = !abilities || abilities.includes("run");
  const correctClaim = (claim: ClaimModel) => {
    setBusyClaim(claim.key);
    // A request about one wrong statement opens a fresh conversation: the project's latest may be a strategy run's own session
    // (r19-geos hand-off §9.5c).
    void open({ projectId: project.projectId, sessionId: null }, correctionBrief(claim, product)).finally(() => setBusyClaim(null));
  };
  const opened = drawer.error ? everyClaim.find((claim) => claim.key === drawer.error) ?? null : null;

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
  const headingNote = unlisted > 0 ? `这里列出了 ${filtered.length} 条讲错，还有 ${unlisted} 条没有列出。` : null;

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
        composition={composition}
        compositionTitle={correct.numerator != null && wrongOurs.numerator != null
          // Counted by answer, beside a rate counted by statement: the heading says which.
          ? `按回答计，讲错我方 ${wrongOurs.numerator.toLocaleString("zh-CN")} 次、讲对 ${correct.numerator.toLocaleString("zh-CN")} 次`
          : "这一轮的回答里我方出现在哪些位置"}
        denominator={denominator}
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
            count={`${claims.length} 条说法`}
            level="section"
          >
            {flat.length === 0 ? (
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
              </div>
            )}
            {headingNote && <p className="pt-2 text-caption text-text-3">{headingNote}</p>}
          </Section>
        </div>
      )}

      {drawer.error && opened && (
        <ErrorDrawer geoId={geoId} project={project} claim={opened} actions={everyAction} groupOf={groupOf} onClose={drawer.close} />
      )}
      {drawer.error && !opened && (
        <ErrorDrawerGone onClose={drawer.close} />
      )}
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
    open: rows.filter((error) => error.status === "open").length,
    working: rows.filter((error) => error.status === "acting" || error.status === "awaiting_remeasure").length,
    closed: rows.filter((error) => error.status === "closed").length,
    severe: rows.filter(isSevereError).length,
  };
}

/** A link to a claim the list no longer holds (the round moved on, or it was closed and trimmed): said, and the way back. */
function ErrorDrawerGone({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="这条说法已经不在清单里了" onClose={onClose}>
      <Note action={<Button variant="secondary" size="sm" onClick={onClose}>回到清单</Button>}>
        新的一轮测量里没有再测到它，或者它已经关闭。
      </Note>
    </Drawer>
  );
}
