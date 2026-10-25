/** Deterministic selected readings. Domain metrics own all arithmetic and membership. */
import { createHash } from "node:crypto";
import {
  GEO_METRIC_LABELS_ZH,
  GEO_METRIC_UNITS,
  documentExportDigest,
} from "@evimed/domain";
import {
  GEO_SCOPE_FIELDS,
  readGeoSelection,
  withGeoReadTransaction,
  geoReadScopeInput,
  geoReadPage,
  geoDailyReadings,
  geoRoundReadings,
} from "./geoReadScope.mjs";
import {
  GEO_COVERAGE_VIEWS,
  buildGeoCoverageAnalysis,
} from "./geoAnalysisCoverage.mjs";
import { GEO_ANALYSIS_DESCRIPTOR_FIELDS, GEO_ANALYSIS_REGISTRY, normalizeGeoAnalysisView } from "./geoAnalysisRegistry.mjs";
import { buildGeoRecommendationAnalysis } from "./geoAnalysisRecommendations.mjs";
import { buildGeoExecutionAnalysis, readGeoExecutionContext } from "./geoAnalysisExecution.mjs";
import { buildGeoMetricAnalysis, buildGeoComparisonAnalysis, buildGeoRivalAnalysis } from "./geoAnalysisMetrics.mjs";
export { normalizeGeoAnalysisView } from "./geoAnalysisRegistry.mjs";
import { buildGeoSourceAnalysis, selectedSourceDomains, readGeoSourceAnnotations, readGeoOpportunityLinks } from "./geoAnalysisSources.mjs";
import { buildGeoEvidenceAnalysis, readGeoEvidenceContext } from "./geoAnalysisEvidence.mjs";
import { buildGeoSupportAnalysis, readGeoSupportContext } from "./geoAnalysisSupport.mjs";
import { HttpError } from "./security.mjs";

const hash = (value) =>
  createHash("sha256").update(documentExportDigest(value)).digest("hex");
const invalid = (message) =>
  new HttpError(400, "geo_read_filter_invalid", message);
export const GEO_ANALYSIS_FIELDS = Object.freeze([
  ...GEO_ANALYSIS_DESCRIPTOR_FIELDS,
  "rowKey",
  "columnKey",
  "expectedDigest",
  "limit",
  "offset",
]);
const metricKey = (cell) =>
  documentExportDigest([
    cell.metricId,
    cell.scope,
    cell.engine,
    cell.groupId,
    cell.pool,
    cell.variant,
    cell.rival,
    cell.arm,
  ]);
const reading = (cell) => ({
  value: cell?.value ?? null,
  state:
    !cell || cell.status === "absent"
      ? "no_data"
      : cell.status === "ok"
        ? "known"
        : cell.status === "insufficient"
          ? "insufficient"
          : [
                "not_adjudicated",
                "judgement_incomplete",
                "not_extracted",
              ].includes(cell.reason)
            ? "unjudged"
            : ["not_applicable", "inclusion_surface"].includes(cell.reason)
              ? "not_applicable"
              : "unknown",
  metric: cell ?? null,
  members: cell?.members ?? null,
  links: [],
});
const plain = (value, state = "known") => ({
  value,
  state,
  metric: null,
  members: null,
  links: [],
});
/** Build all admitted rows before pagination. readAt is informational and never participates in identity.
 * @param {any} selected @param {any} request @param {any} [context]
 */
export function presentGeoAnalysis(selected, request, context = {}) {
  const view = normalizeGeoAnalysisView(request);
  if (["coverage", "metrics", "comparison", "rivals", "recommendations", "sources", "evidence", "execution"].includes(GEO_ANALYSIS_REGISTRY[view.viewId].family))
    return presentAggregate(selected, view, context);
  const matches = (cell) =>
    cell.scope === view.dimension &&
    (!view.metricId || cell.metricId === view.metricId) &&
    !cell.variant &&
    !cell.rival &&
    !cell.arm;
  const label = (cell) =>
    [
      GEO_METRIC_LABELS_ZH[cell.metricId] ?? cell.metricId,
      cell.engine,
      context.groups?.find((group) => group.id === cell.groupId)?.name,
    ]
      .filter(Boolean)
      .join(" · ");
  const rowOf = (
    cell,
    values,
    dimensions = /** @type {Record<string,any>} */ ({}),
  ) => ({
    key: hash([metricKey(cell), dimensions]),
    seriesKey: hash(metricKey(cell)),
    label: label(cell),
    metricId: cell.metricId,
    dimensions: {
      period: null,
      date: null,
      roundId: null,
      roundKind: null,
      roundLabel: null,
      roundOrdinal: null,
      setVersion: null,
      scope: cell.scope,
      engine: cell.engine,
      groupId: cell.groupId,
      ...dimensions,
    },
    values,
    links: [],
  });
  const rows = [];
  if (view.viewId === "V01") {
    const baselineRound = [...selected.rounds]
      .filter((round) => round.kind === "baseline")
      .sort(
        (a, b) =>
          String(a.sample_date).localeCompare(String(b.sample_date)) ||
          a.id.localeCompare(b.id),
      )[0];
    const baseline = baselineRound
      ? geoRoundReadings(selected, baselineRound.id)
      : null;
    for (const cell of selected.computed.cells.filter(matches)) {
      const previous = selected.comparison?.cells.find(
        (item) => metricKey(item) === metricKey(cell),
      )?.previous;
      const pool = cell.pool ?? "all";
      const target = context.targets?.rows?.find(
        (item) =>
          item.tier === context.tier &&
          item.metricId === cell.metricId &&
          item.pool === pool &&
          cell.scope === "project",
      )?.target;
      rows.push(
        rowOf(cell, {
          baseline: reading(
            baseline?.cells.find((item) => metricKey(item) === metricKey(cell)),
          ),
          previous: reading(previous),
          current: reading(cell),
          target: plain(
            Number.isFinite(target) ? target : null,
            Number.isFinite(target) ? "known" : "no_data",
          ),
        }),
      );
    }
  } else {
    const firstObserved = new Map();
    for (const row of selected.rows) {
      if (!firstObserved.has(row.roundId)) firstObserved.set(row.roundId, null);
      if (row.askedAt && (!firstObserved.get(row.roundId) || row.askedAt < firstObserved.get(row.roundId))) firstObserved.set(row.roundId, row.askedAt);
    }
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: selected.scope.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const observations = view.timeGrain === "round"
      ? selected.rounds.filter(round => firstObserved.has(round.id))
        .sort((a,b) => (firstObserved.get(a.id) ?? "z").localeCompare(firstObserved.get(b.id) ?? "z") || a.id.localeCompare(b.id))
        .map((round, index) => ({
          roundLabel: `第 ${index + 1} 轮`, roundOrdinal: index + 1,
          date: firstObserved.get(round.id) ? formatter.format(new Date(firstObserved.get(round.id))) : null,
          roundId: round.id, roundKind: round.kind, setVersion: round.set_version,
          result: geoRoundReadings(selected, round.id),
        }))
      : geoDailyReadings(selected);
    for (const day of observations)
      for (const cell of day.result.cells.filter(matches))
        rows.push(
          rowOf(
            cell,
            { current: reading(cell) },
            { period: view.timeGrain === "round" ? "round" : "day", date: day.date, ...(view.timeGrain === "round" ? {roundId: day.roundId, roundKind: day.roundKind, roundLabel: day.roundLabel, roundOrdinal: day.roundOrdinal, setVersion: day.setVersion} : {}) },
          ),
        );
    for (const cell of selected.computed.cells.filter(matches))
      rows.push(
        rowOf(
          cell,
          { current: reading(cell) },
          { period: "interval", date: null },
        ),
      );
    for (const comparison of selected.comparison?.cells.filter(matches) ?? []) {
      if (comparison.previous)
        rows.push(
          rowOf(
            comparison.previous,
            { current: reading(comparison.previous) },
            { period: "comparison", date: null },
          ),
        );
      rows.push(
        rowOf(
          comparison.current,
          { current: reading(comparison.current) },
          { period: "comparison_current", date: null },
        ),
      );
    }
  }
  rows.sort((a, b) => {
    if (view.timeGrain === "round") {
      const roundA = a.dimensions.period === "round";
      const roundB = b.dimensions.period === "round";
      // One canonical chronology feeds the table, chart, pages, exports and native freeze.
      // Unknown observation times already follow known times on this round axis.
      if (roundA !== roundB) return roundA ? -1 : 1;
      if (roundA) {
        const ordinal = a.dimensions.roundOrdinal - b.dimensions.roundOrdinal;
        if (ordinal) return ordinal;
      }
    }
    return documentExportDigest([
      a.dimensions.date ?? "",
      a.dimensions.period ?? "",
      a.label,
      a.key,
    ]).localeCompare(
      documentExportDigest([
        b.dimensions.date ?? "",
        b.dimensions.period ?? "",
        b.label,
        b.key,
      ]),
    );
  });
  if (rows.length > 20_000)
    throw new HttpError(
      422,
      "geo_read_filter_invalid",
      "Narrow the dates, metric or dimension to at most 20,000 analysis rows.",
    );
  const plotRows = rows.filter(row => ["day", "round"].includes(row.dimensions.period));
  const dates = [
    ...new Set(
      plotRows
        .map((row) => view.timeGrain === "round" ? `${row.dimensions.date ?? "采样时间未知"} · ${row.dimensions.roundLabel}` : row.dimensions.date),
    ),
  ];
  if (view.timeGrain !== "round") dates.sort();
  const dayRows = plotRows;
  const points = new Map(
    dayRows.map((row) => [
      documentExportDigest([row.seriesKey, view.timeGrain === "round" ? `${row.dimensions.date ?? "采样时间未知"} · ${row.dimensions.roundLabel}` : row.dimensions.date]),
      row.values.current,
    ]),
  );
  const seriesLabels = new Map(
    dayRows.map((row) => [
      row.seriesKey,
      { label: row.label, engine: row.dimensions.engine },
    ]),
  );
  const series = [...seriesLabels].map(([seriesKey, displayLabel]) => ({
    key: seriesKey,
    label: displayLabel.label,
    engine: displayLabel.engine,
    values: dates.map((date) => {
      const cell = points.get(documentExportDigest([seriesKey, date]));
      return cell?.state === "known" ? cell.value : null;
    }),
  }));
  const chart = { labels: dates, series };
  const columns = (
    view.viewId === "V01"
      ? ["baseline", "previous", "current", "target"]
      : ["current"]
  ).map((key) => ({
    key,
    label: {
      baseline: "范围内基线",
      previous: "对照实测",
      current: "所选实测",
      target: "当前目标",
    }[key],
    type: "number",
    unit: view.metricId
      ? (GEO_METRIC_UNITS[view.metricId] ?? "index")
      : "metric",
  }));
  const contextualBasis = context.targets
    ? [
        {
          kind: "targets",
          id: "targets",
          version: context.targets.version ?? null,
          digest: hash(context.targets),
          temporalBasis: "current_context",
        },
      ]
    : [];
  if (context.groups?.length)
    contextualBasis.push({
      kind: "group_labels",
      id: "groups",
      version: null,
      digest: hash(context.groups),
      temporalBasis: "current_context",
    });
  const definition = {
    metricId: view.metricId,
    unit: view.metricId
      ? (selected.computed.cells.find(matches)?.members.unit ?? "answers")
      : "derived_inputs",
    countingRule:
      "Existing domain metric; member references identify its exact input cohort.",
    denominatorRule:
      "Domain metric eligibility, deduplication and cross-engine balance.",
    methodVersion: selected.selection.methodVersion,
    dataType: view.metricId
      ? (selected.computed.cells.find(matches)?.dataType ?? "unknown")
      : "mixed",
  };
  const basis = {
    schemaVersion: 1,
    view,
    scope: selected.scope,
    selection: selected.selection,
    comparison: selected.comparison,
    definition,
    contextualBasis,
    columns,
    rows,
    chart,
  };
  const digest = hash(basis),
    page = geoReadPage({
      limit: context.limit ?? 50,
      offset: context.offset ?? 0,
    }),
    limit = context.allRows ? rows.length : page.limit,
    offset = context.allRows ? 0 : page.offset;
  return {
    ...basis,
    viewId: view.viewId,
    digest,
    availability: {
      status: rows.length ? "ready" : "empty",
      reasons: rows.length ? [] : ["no_selected_readings"],
      remedy: null,
    },
    asOf: {
      readAt: context.readAt ?? new Date().toISOString(),
      observedFrom: selected.scope.from ?? null,
      observedTo: selected.scope.to ?? null,
    },
    rows: rows.slice(offset, offset + limit),
    page: {
      total: rows.length,
      shown: Math.min(limit, Math.max(0, rows.length - offset)),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    },
    remainder:
      rows.length > offset + limit
        ? { rows: rows.length - offset - limit, value: null, members: null }
        : null,
  };
}
/** @param {any} selected @param {any} view @param {any} context */
function presentAggregate(selected, view, context) {
  const family = GEO_ANALYSIS_REGISTRY[view.viewId].family;
  const built = family === "execution" ? buildGeoExecutionAnalysis(selected, view, context) : family === "evidence" ? view.viewId === "V16" ? buildGeoSupportAnalysis(selected, view, context) : buildGeoEvidenceAnalysis(selected, view, context) : family === "sources" ? buildGeoSourceAnalysis(selected, view, context) : family === "recommendations" ? buildGeoRecommendationAnalysis(selected, view, context) : family === "metrics" ? buildGeoMetricAnalysis(selected, view, context) : family === "comparison" ? buildGeoComparisonAnalysis(selected, view, context) : family === "rivals" ? buildGeoRivalAnalysis(selected, view, context) : buildGeoCoverageAnalysis(selected, view, context);
  if (built.rows.length > 20_000) throw new HttpError(422, "geo_read_filter_invalid", "Narrow the scope to at most 20,000 analysis rows.");
  const basis = {
    schemaVersion: 1,
    view,
    scope: selected.scope,
    selection: selected.selection,
    comparison: ['comparison','rivals'].includes(family) && selected.comparison ? {...selected.comparison, cells: family === 'comparison' ? selected.comparison.cells.filter(cell=>cell.scope===view.dimension&&(!view.metricId||cell.metricId===view.metricId)&&!cell.variant&&!cell.rival&&!cell.arm) : []} : selected.comparison,
    definition: built.definition,
    contextualBasis: built.contextualBasis,
    columns: built.columns,
    rows: built.rows,
    chart: built.chart,
    availability: built.availability,
  };
  const digest = hash({ ...basis, dependencies: built.dependencies });
  for (const row of built.rows)
    for (const [columnKey, value] of Object.entries(row.values)) {
      const items = built.memberItems.get(`${row.key}:${columnKey}`);
      if (items)
        value.members = {
          selectionRef: selected.selection.reference,
          view,
          rowKey: row.key,
          columnKey,
          expectedDigest: digest,
          unit: value.memberUnit ?? value.unit,
          total: items.length,
          exact: true,
        };
    }
  const builtRows = new Map();
  for (const row of built.rows) builtRows.set(row.key, row);
  for (const cell of built.chart?.cells ?? []) {
    cell.members = builtRows.get(cell.rowKey)?.values[cell.columnKey]?.members ?? (built.memberItems.has(`${cell.rowKey}:${cell.columnKey}`) ? {selectionRef:selected.selection.reference,view,rowKey:cell.rowKey,columnKey:cell.columnKey,expectedDigest:digest,unit:cell.unit==='percent'?'answers':cell.unit,total:built.memberItems.get(`${cell.rowKey}:${cell.columnKey}`).length,exact:true} : null);
  }
  if (context.memberItems)
    for (const [key, items] of built.memberItems)
      context.memberItems.set(key, items);
  const page = geoReadPage({
      limit: context.limit ?? 50,
      offset: context.offset ?? 0,
    }),
    offset = context.allRows ? 0 : page.offset,
    limit = context.allRows ? built.rows.length : page.limit;
  const pagedRows = built.rows.slice(offset, offset + limit);
  const summarizeObjects = !context.allRows && pagedRows.some(row => Object.hasOwn(row.dimensions, "objects"));
  const visibleKeys = new Set(pagedRows.map(row=>row.key));
  return {
    ...basis,
    viewId: view.viewId,
    digest,
    asOf: {
      readAt: context.readAt ?? new Date().toISOString(),
      observedFrom: selected.selection.timeCoverage?.observedFrom ?? null,
      observedTo: selected.selection.timeCoverage?.observedTo ?? null,
    },
    rows: summarizeObjects ? pagedRows.map(row => {
      const { objects: _objects, ...dimensions } = row.dimensions;
      return { ...row, dimensions };
    }) : pagedRows,
    ...(summarizeObjects ? {rowContext:"member_details"} : {}),
    ...(!context.allRows && ["evidence","error_distribution","publication_coverage","publication_execution","error_history","business_history"].includes(built.chart?.kind) ? {chart:{...built.chart,labels:pagedRows.map(row=>row.label),
      cells:built.chart.cells.filter(cell=>visibleKeys.has(cell.rowKey))}} : {}),
    page: {
      total: built.rows.length,
      shown: Math.min(limit, Math.max(0, built.rows.length - offset)),
      nextOffset: offset + limit < built.rows.length ? offset + limit : null,
    },
    remainder: null,
  };
}
/** One authorized project and one repeatable-read snapshot for every consumer. @param {any} store @param {any} project @param {any} [input] */
export async function readGeoAnalysis(
  store,
  project,
  input = {},
  allRows = false,
  dependencies = {},
) {
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>![...GEO_SCOPE_FIELDS,...GEO_ANALYSIS_FIELDS,"view"].includes(key))
    ||input.view!=null&&GEO_ANALYSIS_DESCRIPTOR_FIELDS.some(key=>input[key]!=null))throw invalid("Use only the selected analysis scope and one supported view descriptor.");
  if (
    input.expectedDigest != null &&
    !/^[a-f0-9]{64}$/.test(input.expectedDigest)
  )
    throw invalid("Choose a valid analysis revision.");
  return withGeoReadTransaction(store, async () => {
    const view = normalizeGeoAnalysisView(
      input.view ??
        Object.fromEntries(
          GEO_ANALYSIS_DESCRIPTOR_FIELDS
            .filter((key) => input[key] != null)
            .map((key) => [key, input[key]]),
        ),
    );
    const selected = await readGeoSelection(
      store,
      project,
      geoReadScopeInput(input),
    );
    const targets =
      view.viewId === "V01" ? await store.latestTargets(project.id) : null;
    const groupIds = [
      ...new Set(
        selected.questions.map((question) => question.group_id).filter(Boolean),
      ),
    ];
    const groups =
      (view.dimension === "group" || view.viewId === "V19" && view.sourceFacet === "group" || ["V21", "V10", "V23", "V24", "V25"].includes(view.viewId))
        ? (
            await store.query(
              "SELECT id,name,set_version,journey_stage,journey_stage_no,audience,value_context FROM evimed_geo.question_groups WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id",
              [project.id, project.userId, groupIds],
            )
          ).rows
        : [];
    let jobs = [],
      snapshots = [],
      rounds = selected.rounds,
      contextQuestions = selected.questions,
      contextEngines = selected.selection.engines;
    if (GEO_COVERAGE_VIEWS.includes(view.viewId)) {
      if (selected.scope.from || selected.scope.to) {
        const scheduled = (
          await store.query(
            `SELECT r.* FROM evimed_geo.rounds r WHERE r.geo_project_id=$1 AND r.user_id=$2
          AND r.kind=ANY($3::text[]) AND ($4::text IS NULL OR coalesce(r.sample_date,(coalesce(r.started_at,r.created_at) AT TIME ZONE $6)::date)>=$4::date)
          AND ($5::text IS NULL OR coalesce(r.sample_date,(coalesce(r.started_at,r.created_at) AT TIME ZONE $6)::date)<=$5::date)
          AND ($7::text IS NULL OR r.id=$7) AND ($8::integer IS NULL OR r.set_version=$8) ORDER BY r.id LIMIT 121`,
            [
              project.id,
              project.userId,
              ["baseline", "weekly", "single_step"],
              selected.scope.from,
              selected.scope.to,
              selected.scope.timeZone,
              selected.scope.round,
              selected.scope.questionVersion,
            ],
          )
        ).rows;
        rounds = [
          ...new Map(
            [...selected.rounds, ...scheduled].map((round) => [
              round.id,
              round,
            ]),
          ).values(),
        ];
        if (rounds.length > 120)
          throw new HttpError(
            422,
            "geo_read_filter_invalid",
            "Narrow the scope to at most 120 actual and scheduled rounds.",
          );
      }
      const versions = [
        ...new Set(
          rounds
            .map((round) => Number(round.set_version))
            .filter((version) => version > 0),
        ),
      ];
      contextEngines = selected.scope.engines.length
        ? selected.scope.engines
        : !rounds.length
          ? selected.selection.engines
          : [
              ...new Set(
                rounds.flatMap((round) =>
                  round.engines?.length ? round.engines : project.engines,
                ),
              ),
            ];
      if (versions.length)
        contextQuestions = (
          await store.query(
            `SELECT q.*,coalesce(q.pool,g.pool) AS scope_pool FROM evimed_geo.questions q
        LEFT JOIN evimed_geo.question_groups g ON g.id=q.group_id AND g.geo_project_id=q.geo_project_id AND g.user_id=q.user_id
        WHERE q.geo_project_id=$1 AND q.user_id=$2 AND q.set_version=ANY($3::integer[])
        AND (cardinality($4::text[])=0 OR q.group_id=ANY($4::text[]))
        AND (cardinality($5::text[])=0 OR coalesce(q.pool,g.pool)=ANY($5::text[]))
        AND (cardinality($6::text[])=0 OR q.client_tags && $6::text[]) ORDER BY q.id LIMIT 20001`,
            [
              project.id,
              project.userId,
              versions,
              selected.scope.groupIds,
              selected.scope.pools,
              selected.scope.clientTags,
            ],
          )
        ).rows;
      if (contextQuestions.length > 20000)
        throw new HttpError(
          422,
          "geo_read_filter_invalid",
          "Narrow the selected question definitions to at most 20,000.",
        );
      jobs = (
        await store.query(
          `SELECT j.id,j.question_id,j.engine,j.round_id,j.repeat_index,j.status,j.snapshot_id,j.error_code,j.attempts,j.run_after,linked.id AS linked_snapshot_id
        FROM evimed_geo.probe_jobs j LEFT JOIN evimed_geo.snapshots linked ON linked.id=j.snapshot_id AND linked.geo_project_id=j.geo_project_id AND linked.user_id=j.user_id WHERE j.geo_project_id=$1 AND j.user_id=$2 AND j.round_id=ANY($3::text[])
        AND j.question_id=ANY($4::text[]) AND j.engine=ANY($5::text[]) ORDER BY j.id LIMIT 20001`,
          [
            project.id,
            project.userId,
            rounds.map((round) => round.id),
            contextQuestions.map((question) => question.id),
            contextEngines,
          ],
        )
      ).rows;
      if (jobs.length > 20000)
        throw new HttpError(
          422,
          "geo_read_filter_invalid",
          "Narrow the scope to at most 20,000 collection jobs.",
        );
      snapshots = (
        await store.query(
          `SELECT id,probe_job_id FROM evimed_geo.snapshots WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id`,
          [
            project.id,
            project.userId,
            selected.rows.map((row) => row.snapshotId),
          ],
        )
      ).rows;
    }
    const sources = GEO_ANALYSIS_REGISTRY[view.viewId].family === "sources" ? (await store.sourcesForDomains(project, selectedSourceDomains(selected))).map(source=>({id:source.id,domain:source.domain,name:source.name,kind:source.kind})) : [];
    const sourceAnnotations = ["V20", "V21"].includes(view.viewId) ? await readGeoSourceAnnotations(store, project, selected) : [];
    const opportunityLinks = ["V20", "V21"].includes(view.viewId) ? await readGeoOpportunityLinks(store, project, selected) : null;
    const evidence = view.viewId === "V10" ? await readGeoEvidenceContext(store, project) : null;
    const support = view.viewId === "V16" ? await readGeoSupportContext(store, project, selected, view) : null;
    const execution = GEO_ANALYSIS_REGISTRY[view.viewId].family === "execution" ? await readGeoExecutionContext(store, project, selected, view, dependencies) : null;
    if (view.viewId === "V26" && execution?.finance?.plan) {
      view.strategyVersion = execution.finance.plan.version;
      if (execution.finance.plan.basis?.targets?.version != null) view.targetVersion = execution.finance.plan.basis.targets.version;
    }
    const memberItems = new Map();
    const result = presentGeoAnalysis(selected, view, {
      targets,
      evidence,
      support,
      execution,
      sources,
      sourceAnnotations,
      opportunityLinks,
      product: project.product,
      competitors: project.competitors,
      tier: project.tier,
      groups,
      jobs,
      snapshots,
      rounds,
      questions: contextQuestions,
      engines: contextEngines,
      memberItems,
      limit: input.limit,
      offset: input.offset,
      allRows: allRows || input.rowKey != null,
    });
    if (input.expectedDigest && input.expectedDigest !== result.digest)
      throw new HttpError(
        409,
        "geo_read_filter_invalid",
        "The selected analysis changed. Refresh the view.",
      );
    if (input.rowKey != null || input.columnKey != null) {
      if (
        !input.selectionRef ||
        !input.expectedDigest ||
        !["coverage", "metrics", "comparison", "rivals", "recommendations", "sources", "evidence", "execution"].includes(GEO_ANALYSIS_REGISTRY[view.viewId].family) ||
        typeof input.rowKey !== "string" ||
        typeof input.columnKey !== "string"
      )
        throw invalid("Choose an exact aggregate member and revision.");
      const items = memberItems.get(`${input.rowKey}:${input.columnKey}`);
      if (!items)
        throw new HttpError(
          404,
          "geo_read_filter_invalid",
          "This member is outside the selected analysis.",
        );
      const { limit, offset } = geoReadPage(input),
        page = items.slice(offset, offset + limit),
        ids = [
          ...new Set(
            page.flatMap((item) => [item.snapshotId,...(item.citingAnswers??[]).map(answer=>answer.snapshotId)].filter(Boolean)),
          ),
        ];
      const originals = (
        await store.query(
          `SELECT id,answer_text,asked_at,surface,citations FROM evimed_geo.snapshots WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id`,
          [project.id, project.userId, ids],
        )
      ).rows;
      const originalsById = new Map(originals.map((row) => [row.id, row]));
      return {
        unit:
          result.rows.find((row) => row.key === input.rowKey)?.values[
            input.columnKey
          ]?.members?.unit ??
          page[0]?.unit ??
          "records",
        total: items.length,
        items: page.map(function hydrate(item) {
          const question = contextQuestions.find(candidate => candidate.id === item.questionId);
          return {
            ...item,
            ...(item.citingAnswers ? {citingAnswers:item.citingAnswers.map(hydrate)} : {}),
            question: question ? {text:question.text,originalId:question.original_id,originalRow:question.original_row_index,originalGroup:question.original_group,clientTags:question.client_tags} : null,
            ...(item.snapshotId ? {answer:originalsById.get(item.snapshotId)??null} : {}),
          };
        }),
        nextOffset: offset + limit < items.length ? offset + limit : null,
        digest: result.digest,
      };
    }
    return result;
  });
}
/** Freeze the complete table, with no formatted-value parsing or model-generated arithmetic. @param {any} view */
export function freezeGeoAnalysisDocument(view) {
  if(view.rowContext === "member_details") throw invalid("Read the full selected analysis before exporting its object details.");
  if (view.page.shown !== view.page.total)
    throw invalid("Freeze every selected row before exporting.");
  const metadataColumns = [
    "selection_ref",
    "analysis_digest",
    "data_revision",
    "scope",
    "counts",
    "method",
    "counting_rule",
    "denominator_rule",
    "contextual_basis",
  ].map((key) => ({ key, label: key, type: "text" }));
  const metadataValues = {
    selection_ref: view.selection.reference,
    analysis_digest: view.digest,
    data_revision: view.selection.dataRevision,
    scope: documentExportDigest(view.scope),
    counts: documentExportDigest(view.selection.counts),
    method: view.definition.methodVersion,
    counting_rule: view.definition.countingRule,
    denominator_rule: view.definition.denominatorRule,
    contextual_basis: documentExportDigest(view.contextualBasis),
  };
  let columns = [
    ...metadataColumns,
    { key: "key", label: "Row", type: "text" },
    { key: "label", label: "指标", type: "text" },
    { key: "metricId", label: "Metric", type: "text" },
    { key: "metric_unit", label: "指标尺度", type: "text" },
    { key: "period", label: "区间", type: "text" },
    { key: "date", label: "日期", type: "text" },
    { key: "dimensions", label: "精确分类与条件", type: "text" },
    ...view.columns.flatMap((column) => [
      { key: column.key, label: column.label, type: column.type ?? "number" },
      {
        key: `${column.key}_state`,
        label: `${column.label}状态`,
        type: "text",
      },
      {
        key: `${column.key}_numerator`,
        label: `${column.label}分子`,
        type: "number",
      },
      {
        key: `${column.key}_denominator`,
        label: `${column.label}分母`,
        type: "number",
      },
      {
        key: `${column.key}_reason`,
        label: `${column.label}说明`,
        type: "text",
      },
      {
        key: `${column.key}_unit`,
        label: `${column.label}成员单位`,
        type: "text",
      },
    ]),
  ];
  let rows = view.rows.map((row) =>
    Object.fromEntries([
      ...Object.entries(metadataValues),
      ["key", row.key],
      ["label", row.label],
      ["metricId", row.metricId],
      ["metric_unit", GEO_METRIC_UNITS[row.metricId] ?? row.dimensions.unit ?? "count"],
      ["period", row.dimensions.period ?? "selected"],
      ["date", row.dimensions.date ?? null],
      ["dimensions", documentExportDigest(row.dimensions)],
      ...view.columns.flatMap((column) => [
        [column.key, row.values[column.key].value],
        [`${column.key}_state`, row.values[column.key].state],
        [
          `${column.key}_numerator`,
          row.values[column.key].numerator ?? row.values[column.key].metric?.numerator ?? null,
        ],
        [
          `${column.key}_denominator`,
          row.values[column.key].denominator ?? row.values[column.key].metric?.denominator ?? null,
        ],
        [
          `${column.key}_reason`,
          row.values[column.key].reason ??
            row.values[column.key].metric?.reason ??
            null,
        ],
        [`${column.key}_unit`, row.values[column.key].members?.unit ?? null],
      ]),
    ]),
  );
  if (GEO_COVERAGE_VIEWS.includes(view.viewId) || columns.length > 40) {
    // Keep wide status tables within the existing 40-column offline renderer contract.
    columns = [
      ...metadataColumns,
      { key: "key", label: "Row", type: "text" },
      { key: "label", label: "对象", type: "text" },
      { key: "dimensions", label: "精确分类与条件", type: "text" },
      { key: "cells_metadata", label: "单位、原因和计数依据", type: "text" },
      ...view.columns.flatMap((column) => [
        { key: column.key, label: column.label, type: column.type ?? "number" },
        {
          key: `${column.key}_state`,
          label: `${column.label}状态`,
          type: "text",
        },
      ]),
    ];
    rows = view.rows.map((row) => ({
      ...metadataValues,
      key: row.key,
      label: row.label,
      dimensions: documentExportDigest(row.dimensions),
      cells_metadata: documentExportDigest(
        Object.fromEntries(
          view.columns.map((column) => {
            const value = row.values[column.key];
            return [
              column.key,
              {
                unit: value.unit,
                reason: value.reason ?? value.metric?.reason ?? null,
                memberUnit: value.members?.unit ?? null,
                numerator: value.numerator ?? value.metric?.numerator ?? null,
                denominator: value.denominator ?? value.metric?.denominator ?? null,
                metricId: value.metric?.metricId ?? null,
                ...(value.knownSubtotal !== undefined ? {knownSubtotal:value.knownSubtotal,unknownCandidates:value.unknownCandidates??null} : {}),
              },
            ];
          }),
        ),
      ),
      ...Object.fromEntries(
        view.columns.flatMap((column) => [
          [column.key, row.values[column.key].value],
          [`${column.key}_state`, row.values[column.key].state],
        ]),
      ),
    }));
  }
  if (columns.length > 40) {
    columns = [...metadataColumns, {key:"row_key",label:"Row",type:"text"}, {key:"label",label:"对象",type:"text"}, {key:"dimensions",label:"精确分类与条件",type:"text"}, {key:"column_key",label:"统计项",type:"text"}, {key:"column_label",label:"统计项名称",type:"text"}, {key:"value",label:"数值",type:"number"}, {key:"state",label:"状态",type:"text"}, {key:"reason",label:"原因",type:"text"}, {key:"unit",label:"单位",type:"text"}, {key:"numerator",label:"分子",type:"number"}, {key:"denominator",label:"分母",type:"number"}];
    rows = view.rows.flatMap(row => view.columns.map(column => {const value = row.values[column.key]; return {...metadataValues,row_key:row.key,label:row.label,dimensions:documentExportDigest(row.dimensions),column_key:column.key,column_label:column.label,value:value.value,state:value.state,reason:value.reason??value.metric?.reason??null,unit:value.members?.unit??value.unit??null,numerator:value.metric?.numerator??null,denominator:value.metric?.denominator??null};}));
  }
  const clean = (value) =>
    String(value ?? "未测")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const metadata = { ...view, rows: view.rows };
  const reportColumns = [
    { key: "label", label: "指标与区间" },
    ...view.columns,
  ];
  const reportReading = (row, column) => {
    const cell = row.values[column.key],
      metric = cell.metric,
      unit = cell.unit ?? GEO_METRIC_UNITS[row.metricId] ?? row.dimensions.unit ?? "count";
    const value =
      cell.value == null
        ? "未测"
        : `${cell.value}${unit === "percent" ? "%" : ""}`;
    const word =
      metric?.reason === "citations_without_links"
        ? "引用不可测"
        : metric?.status === "insufficient"
          ? "样本不足"
          : metric?.status === "absent"
            ? "未测"
            : value;
    return `${word}${word !== value && cell.value != null ? `；保留值 ${value}` : ""} (状态 ${cell.state}; 尺度 ${unit}; 原因 ${cell.reason ?? metric?.reason ?? "—"}; 分子/分母 ${cell.numerator ?? metric?.numerator ?? "—"}/${cell.denominator ?? metric?.denominator ?? "—"}; 成员单位 ${cell.members?.unit ?? "—"})`;
  };
  const reportRows = view.rows.map((row) => ({
    label: [row.label, view.viewId === "V10" ? "" : documentExportDigest(row.dimensions)]
      .filter(Boolean)
      .join(" · "),
    ...Object.fromEntries(
      view.columns.map((column) => [column.key, reportReading(row, column)]),
    ),
  }));
  let canonicalMarkdown = `# 所选数据分析\n\n${view.definition.countingRule}\n\n${view.definition.denominatorRule}\n\n范围：${clean(documentExportDigest(view.scope))}。样本：${clean(documentExportDigest(view.selection.counts))}。\n\n方法：${view.definition.methodVersion}。分析摘要：${view.digest}。目标为读取时的当前目标，对照为另选区间的实际读数。每个读数保留指标尺度、状态、不可用原因、分子/分母和成员单位。\n\n| ${reportColumns.map((column) => clean(column.label)).join(" | ")} |\n| ${reportColumns.map(() => "---").join(" | ")} |\n${reportRows.map((row) => `| ${reportColumns.map((column) => clean(row[column.key])).join(" | ")} |`).join("\n")}\n`;

  if (GEO_COVERAGE_VIEWS.includes(view.viewId) || view.columns.length > 40)
    canonicalMarkdown =
      `# 所选数据分析

${view.definition.countingRule}

范围：${clean(documentExportDigest(view.scope))}。样本：${clean(documentExportDigest(view.selection.counts))}。

方法：${view.definition.methodVersion}。分析摘要：${view.digest}。

覆盖说明：${clean(documentExportDigest(view.availability))}。采样时间与计划：${clean(documentExportDigest(view.selection.timeCoverage))}。采集与判定是两个独立轴；问题、任务、回答、陈述的单位分别保留。

` +
      view.rows
        .map(
          (row) => `## ${clean(row.label)}

分类与条件：${clean(documentExportDigest(row.dimensions))}

| 统计项 | 数值与说明 |
| --- | --- |
${view.columns.map((column) => `| ${clean(column.label)} | ${clean(reportReading(row, column))} |`).join("\n")}
`,
        )
        .join("\n");
  if (["V15","V27"].includes(view.viewId)) {
    const code=value=>`\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    canonicalMarkdown=`# ${view.viewId==="V15"?"错误观察与处理历史":"业务事件与采样观察"}\n\n范围：${clean(documentExportDigest(view.scope))}。分析摘要：${view.digest}。方法：${view.definition.methodVersion}。\n\n仅呈现已保留且符合筛选范围的记录，不补算缺失历史。任务完成、判定撤回、关闭记录与错误再次出现分开计数。业务事件使用各自时间，未知时间不定位；轮次读数汇总所选样本观察区间，标在最后一次观察，任一成员时间未知则不定位。前后关系不能推断因果或交付效果。样本关联可在多个事件重复出现，不是新增采样数。\n\n## 范围与当前上下文\n${code(view.contextualBasis)}`;
    for(const row of view.rows){
      const {objects=[],...dimensions}=row.dimensions;
      canonicalMarkdown+=`\n## ${clean(row.label)}\n\n行标识：${row.key}。${code(dimensions)}\n| 统计项 | 读数与单位 |\n| --- | --- |\n${view.columns.map(column=>`| ${clean(column.label)} | ${clean(reportReading(row,column))} |`).join("\n")}\n\n### 完整事件与保留材料\n`;
      for(const object of objects)canonicalMarkdown+=code(object);
    }
  }
  if (["V25","V26"].includes(view.viewId)) {
    const code=value=>`\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    canonicalMarkdown=`# ${view.viewId==="V25"?"项目预算与收支":"方案冻结实测、当前实测与规划目标"}\n\n范围：${clean(documentExportDigest(view.scope))}。分析摘要：${view.digest}。方法：${view.definition.methodVersion}。\n\n${view.viewId==="V25"?"金额单位为人民币 CNY；预留、释放预留、结算、退款与预算设置分别保留，累计净支出为结算减退款。历史余额使用完整账目前缀与当时最后一次预算设置；当前配置预算单列。账户充值不计入项目支出；项目整体预算与未归属问题群金额分别保留。":"方案冻结实测、目标表登记基线、当前所选实测、规划目标和费用估计分别显示。方案与目标均使用已保存的精确版本；历史成员暂不可读时仍保留冻结值与原有成员引用，不用当前数据补齐。目标与费用是假设或规划，不能当作实际支出或实现效果。"}\n\n## 上下文与版本\n${code(view.contextualBasis)}`;
    for(const row of view.rows){
      const {objects=[],...dimensions}=row.dimensions;
      canonicalMarkdown+=`\n## ${clean(row.label)}\n\n行标识：${row.key}。${code(dimensions)}\n| 统计项 | 读数与单位 |\n| --- | --- |\n${view.columns.map(column=>`| ${clean(column.label)} | ${clean(reportReading(row,column))} |`).join("\n")}\n\n### 完整关联记录\n`;
      for(const object of objects)canonicalMarkdown+=code(object);
    }
  }
  if (view.viewId === "V13") {
    const code=value=>`\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    const scopeWord=({active:"有效判定记录（含已关闭）",withdrawn:"已撤回判定记录",all:"全部记录"})[view.view.errorView]??"有效判定记录";
    canonicalMarkdown=`# 错误类型、严重程度与平台\n\n范围：${clean(documentExportDigest(view.scope))}。判定范围：${scopeWord}。\n\n分析摘要：${view.digest}。方法：${view.definition.methodVersion}。\n\n按错误记录去重，以已保存的首见、最近或关闭回答与所选采样关联。这里呈现当前判定与处置状态，不能倒推采样时的状态；重复出现、历史事件与任务次数不重复计数。有效判定记录包含已关闭记录，已撤回判定另列；这些数量不是回答错误率，也不代表处置已经改变模型回答。\n\n`;
    for(const row of view.rows){
      const {objects=[],...dimensions}=row.dimensions;
      canonicalMarkdown+=`\n## ${clean(row.label)}\n\n行标识：${row.key}。${code(dimensions)}\n| 统计项 | 错误记录数 |\n| --- | --- |\n${view.columns.map(column=>`| ${clean(column.label)} | ${row.values[column.key].value??"未知"} |`).join("\n")}\n\n### 完整记录与判定依据\n`;
      for(const object of objects)canonicalMarkdown+=code(object);
    }
  }
  if (["V23","V24"].includes(view.viewId)) {
    const code=value=>`\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    canonicalMarkdown=`# ${view.viewId==="V23"?"内容与发布覆盖":"投放与发布状态"}\n\n范围：${clean(documentExportDigest(view.scope))}。分析摘要：${view.digest}。方法：${view.definition.methodVersion}。\n\n内容、文件格式、版本、登记发布和订单分别计数；同一内容可覆盖多个人群或渠道，不能相加当作交付效果。预期渠道保留在内容版本中，实际平台与地址保留在发布记录中。自行登记不等于外部核验；当前状态与历史事件分别保留。只选采样轮次时，关联业务记录不代表该轮当时状态；投放发布计数要求已有发布状态及保留地址，其他订单见执行状态分析。日期按记录中明确的业务时间筛选，未知时间不补齐为采样时间。\n\n`;
    for(const row of view.rows){
      const {objects=[],...dimensions}=row.dimensions;
      canonicalMarkdown+=`\n## ${clean(row.label)}\n\n行标识：${row.key}。${code(dimensions)}\n| 统计项 | 记录数 |\n| --- | --- |\n${view.columns.map(column=>`| ${clean(column.label)} | ${row.values[column.key].value??"未知"} |`).join("\n")}\n\n### 完整关联记录\n`;
      for(const object of objects)canonicalMarkdown+=code(object);
    }
  }
  if (view.viewId === "V16") {
    const code=value=>`\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    const finding=view.view.evidenceKind==="findings";
    canonicalMarkdown=`# ${finding?"发现表达覆盖":"主张、适用条件与来源依据"}\n\n范围：${clean(documentExportDigest(view.scope))}。样本：${clean(documentExportDigest(view.selection.counts))}。\n\n方法：${view.definition.methodVersion}。分析摘要：${view.digest}。\n\n${finding?"统计单位为回答中的发现表达记录，保留当时的发现版本与原文；表达情况不代表医学来源支持度。部分判定中的未表达或不适用保持不确定。":"统计单位为所选回答中的陈述判定记录，按精确主张版本、适用条件和证据卡来源分行。原文核实只说明引文与所存来源匹配；正确或冲突是所存回答判定，不替代对医学结论本身的评估。依据缺失保持未知，已核实小计与待核实数量分别保留。"}\n\n来源注记属于当前记录；采样时间、判定时间、来源通知日期与平台记录时间分别保留。当前对历史回答的判定不能视为采样时的原始判定。\n\n## 上下文与版本\n${code(view.contextualBasis)}`;
    for(const [index,row] of view.rows.entries()){
      const {objects=[],...dimensions}=row.dimensions;
      canonicalMarkdown+=`\n## ${index+1}. ${clean(row.label)}\n\n行标识：${row.key}。精确身份、条件与来源：${code(dimensions)}\n\n| 统计项 | 读数 |\n| --- | --- |\n${view.columns.map(column=>{const cell=row.values[column.key];return `| ${clean(column.label)} | ${cell.value??"未知"}${cell.unknownCandidates?`；已核实小计 ${cell.knownSubtotal??0}，另有 ${cell.unknownCandidates} 条待核实`:""} |`;}).join("\n")}\n\n### 完整判定与原文依据\n`;
      for(const item of objects){
        if(item.originalAssessment)canonicalMarkdown+=`\n本回答首次保存的判定与当前判定分别保留；首次保存时间不推定为采样时间。\n`;
        canonicalMarkdown+=code(item);
      }
    }
  }
  if (view.viewId === "V10") {
    const journeyBasis = view.contextualBasis.find(basis => basis.kind === "journey_links");
    const code = value => `\n\n\`\`\`json\n${documentExportDigest(value)}\n\`\`\`\n`;
    canonicalMarkdown = `# 旅程与需求覆盖\n\n范围：${clean(documentExportDigest(view.scope))}。样本：${clean(documentExportDigest(view.selection.counts))}。\n\n方法：${view.definition.methodVersion}。分析摘要：${view.digest}。\n\n旅程上下文版本：${journeyBasis?.version ?? "未知"}。旅程标注和来源变更为读取时的上下文，采样日期与来源通知日期分别保留。各类数量有独立单位，不能相加为漏斗。依据不足时，“原文已核实主张”保留已核实小计，“待核实主张”另列；未知不计为零。\n\n## 上下文版本与依据\n${code(view.contextualBasis)}\n`;
    for (const [index, row] of view.rows.entries()) {
      const { objects = {}, ...dimensions } = row.dimensions;
      canonicalMarkdown += `## ${index + 1}. ${clean(row.label)}\n\n问题群标识：${clean(dimensions.groupId ?? "未映射")}；问题版本：${clean(dimensions.setVersion ?? "未知")}。行标识：${row.key}。\n\n精确分类与上下文：${code(dimensions)}\n\n| 统计项 | 读数与口径 |\n| --- | --- |\n${view.columns.map(column => `| ${clean(column.label)} | ${clean(reportReading(row, column))} |`).join("\n")}\n\n### 完整关联对象与来源注记\n\n以下记录与当前行的统计范围一致；主张原文核实与当前来源变更分开保留。通知日期、平台记录时间、检查时间不互相替代。\n`;
      for (const [unit, items] of Object.entries(objects)) {
        const label = view.columns.find(column => column.key === unit)?.label ?? unit;
        canonicalMarkdown += `\n#### ${clean(label)}\n`;
        // One compact object per wrapped code paragraph preserves the complete
        // typed context without an over-wide table or a silent preview limit.
        for (const item of items) canonicalMarkdown += code(item);
        if (!items.length) canonicalMarkdown += "\n无已记录对象。\n";
      }
    }
  }
  if (["V17", "V18", "V19", "V22"].includes(view.viewId)) {
      // Pandoc's existing pipe-table column widths keep source addresses readable.
      // The typed table and cover above retain every exact dimension and cell state.
      const table = (headers, widths, items) => `| ${headers.join(" | ")} |\n| ${widths.map(width => "-".repeat(width)).join(" | ")} |\n${items.map(cells => `| ${cells.map(clean).join(" | ")} |`).join("\n")}\n`;
      const count = (row, key) => { const cell = row.values[key]; return cell.state === "known" && cell.value !== null ? String(cell.value) : cell.value == null ? "未知" : `${cell.value}（${cell.reason ?? cell.state}）`; };
      const date = value => value ? new Intl.DateTimeFormat("en-CA", { timeZone: view.scope.timeZone ?? "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)) : "未知";
      const dateRange = row => { const first = date(row.dimensions.firstObserved), last = date(row.dimensions.lastObserved); return first === last ? first : `${first} 至 ${last}`; };
      const overview = `# 来源分析\n\n所选范围：${view.scope.from ?? "不限开始日期"} 至 ${view.scope.to ?? "不限结束日期"}；${view.scope.timeZone ?? "Asia/Shanghai"}。共 ${view.rows.length} 个来源${view.viewId === "V17" ? "类型" : "条目"}。\n\n有可用引用的回答中，采样时间已知 ${view.definition.knownTimeAnswers} 个、未知 ${view.definition.unknownTimeAnswers} 个。部分判定回答的可用引用仍保留，不代表回答已完成医学准确性判定。\n\n类型覆盖按不同回答去重，可重叠；回答与页面配对按回答及页面地址去重。共同出现错误或品牌提及不代表来源导致错误。日期仅表示已知的实际观察日期，未知时间不推定为零。\n\n分析版本：${view.digest}。方法：${clean(view.definition.methodVersion)}。完整范围、原始地址别名、逐轮历史、状态与精确来源标识保留在配套数据表及导出记录。\n\n`;
      if (view.viewId === "V22") {
          const words={present:"已观察引用",absent:"可观测未引用",first_observed_in_scope:"所选范围内首次",new_appearance:"新出现",no_longer_observed:"同一可比范围内未再观察到"};
          canonicalMarkdown = overview + "所选范围内首次表示当前选择中的首次观察，不代表项目开始。可观测未引用依赖采集端记录的引用列表完整性，不代表全网或模型信息已穷尽。拒答或失败中保留的链接不能建立出现；有效重复中的引用仍可观察。未引用须所有相关重复均有效且引用列表完整，并有完整计划及任务与所选回答的一一对应；缺少计划、任务或回答均保持未知。只有相同问题、版本、平台和采样方式才比较变化；未知区间留空，不拟合引用寿命。\n\n" + table(["序号与页面", "轮次与问题", "平台与版本", "观察状态", "可比变化"],[42,24,20,18,22],view.rows.map((row,index)=>[`${index+1}. ${row.dimensions.sourceKey}`,`${row.dimensions.roundLabel} · ${row.dimensions.questionId??'问题未知'}`,`${row.dimensions.engine} · v${row.dimensions.setVersion??'未知'} · ${row.dimensions.mode??'未知'}`,words[row.values.observation.value]??'未知',words[row.values.transition.value]??'未知']));
      }
      else if (view.viewId === "V19") {
          canonicalMarkdown = overview + "## 来源与平台或版本化问题群\n\n同名问题群按精确版本与群标识分别统计。每行的引用回答、回答与页面配对和页面均在该交叉范围内去重；未知或未映射群单列。\n\n" + table(["序号与来源","平台或问题群","回答","配对","页面"],[42,30,8,8,8],view.rows.map((row,index)=>[`${index+1}. ${row.dimensions.sourceKey??row.dimensions.domain}`,view.view.sourceFacet==='engine'?row.dimensions.engine:`${row.dimensions.groupName} · v${row.dimensions.setVersion??'未知'} · ${row.dimensions.groupId??'未知'}`,...['answers','pairs','pages'].map(key=>count(row,key))])) + "\n## 共同出现与采样时间\n\n" + table(["序号","轮次","同错回答","同提回答","时间已知","时间未知"],[10,10,18,18,18,18],view.rows.map((row,index)=>[index+1,...['rounds','wrong','mentions','knownTime','unknownTime'].map(key=>count(row,key))]));
      }
      else if (view.viewId === "V17") {
          canonicalMarkdown = overview + "## 来源类型覆盖\n\n" + table(["来源类型", "回答", "覆盖率（%）", "配对", "页面"], [40, 10, 12, 10, 10], view.rows.map(row => [row.label, ...["answers", "coverage", "pairs", "pages"].map(key => count(row, key))]));
      }
      else {
          canonicalMarkdown = overview + "## 引用与页面\n\n观察日期为首次至最近一次已知采样日期。\n\n" + table(["来源", "回答", "配对", "页面", "观察日期"], [48, 7, 7, 7, 24], view.rows.map((row, index) => [`${index + 1}. ${row.dimensions.sourceKey ?? row.dimensions.domain ?? row.label}`, ...["answers", "pairs", "pages"].map(key => count(row, key)), dateRange(row)])) +
              "\n## 共同出现与采样时间\n\n序号与上表来源一致。同错回答指共同出现我方错误的回答，同提回答指共同出现品牌提及的回答，均为共同出现计数。时间覆盖以回答为单位，轮次仅计实际出现的轮次。\n\n" + table(["序号", "轮次", "同错回答", "同提回答", "时间已知", "时间未知"], [10, 10, 18, 18, 18, 18], view.rows.map((row, index) => [index + 1, ...["rounds", "wrong", "mentions", "knownTime", "unknownTime"].map(key => count(row, key))]));
      }
  }
  if (["V20", "V21"].includes(view.viewId)) {
      const table = (headers, widths, items) => `| ${headers.join(" | ")} |\n| ${widths.map(width => "-".repeat(width)).join(" | ")} |\n${items.map(cells => `| ${cells.map(clean).join(" | ")} |`).join("\n")}\n`;
      const count = (row, key) => { const cell = row.values[key]; return cell.value == null ? "未知" : cell.state === "known" ? String(cell.value) : `${cell.value}（${({insufficient:"样本不足",unknown:"未知",not_applicable:"不适用"})[cell.state] ?? "需核对"}）`; };
      const overview = `# 信源关系与问题群机会分析\n\n所选范围：${view.scope.from ?? "不限开始日期"} 至 ${view.scope.to ?? "不限结束日期"}；${view.scope.timeZone ?? "Asia/Shanghai"}。分析版本：${view.digest}。方法：${clean(view.definition.methodVersion)}。\n\n当前人工注释按精确页面优先于域名解析，不推定为采样时的关系；采样时间与注释日期分别保留。完整地址、注释修订及关联对象固定在导出数据和记录中。\n\n`;
      if (view.viewId === "V20") {
          canonicalMarkdown = overview + "## 已确认信源关系\n\n引用回答按关系分别去重，回答与页面配对独立统计，不依赖品牌提及。一个回答可同时引用多种关系，回答数不构成互斥比例。\n\n" + table(["关系", "引用回答", "回答页面配对", "不同页面"], [30,20,22,20], view.rows.map(row=>[row.label,...["answers","pairs","pages"].map(key=>count(row,key))])) + "\n## 共同出现与采样覆盖\n\n错误与品牌提及仅为共同出现，不代表来源引起错误。\n\n" + table(["关系","实际轮次","同错回答","同提回答","时间已知","时间未知"],[24,14,14,14,14,14],view.rows.map(row=>[row.label,...["rounds","wrong","mentions","knownTime","unknownTime"].map(key=>count(row,key))]));
      } else {
          canonicalMarkdown = overview + `## 品牌提及与登记自有引用\n\nX 为现有 M-01；Y 为所选现有 ${view.view.ownedMetricId}，保持登记域名与地址匹配口径，与人工页面关系分别解释。两条指标的合资格分母可能不同；气泡面积仅表示实际回答样本，不表示需求规模、医学优先级或因果。未登记自有信源时 Y 保留未知，可从现有行动登记自主发布地址。\n\n` + table(["精确问题群与版本","M-01（%）",`${view.view.ownedMetricId}（%）`,"实际回答样本"],[45,18,18,20],view.rows.map(row=>[`${row.dimensions.groupName} · v${row.dimensions.setVersion??"未知"} · ${row.dimensions.groupId??"未映射"}`,...["mention","owned","sample"].map(key=>count(row,key))])) + "\n## 两条指标的合资格分母\n\n" + table(["问题群","X 分子","X 合资格分母","Y 分子","Y 合资格分母"],[38,16,22,16,22],view.rows.map(row=>[row.dimensions.groupId??"未映射",row.values.mention.numerator??"未知",row.values.mention.denominator??"未知",row.values.owned.numerator??"未知",row.values.owned.denominator??"未知"])) + "\n显式依据、来源页面和内容版本关联保留于数据表与冻结上下文。缺少关联不表示不存在；活动结论也不自动视为已核实证据。\n";
      }
  }
  // Excel limits a text cell to 32,767 characters. Keep exact large contexts in ordered typed continuation rows.
  if (["V20", "V21", "V10", "V16", "V13", "V15", "V23", "V24", "V27"].includes(view.viewId) && rows.some(row=>Object.values(row).some(value=>typeof value==="string"&&value.length>30000))) {
      columns.push(...["context_parent", "context_field", "context_part"].map(key=>({key,label:key,type:"text"})));
      const continued = [];
      for (const row of rows) {
          const main = {...row}, parts = [];
          for (const column of columns) {
              const value = main[column.key];
              if (typeof value!=="string" || value.length<=30000) continue;
              main[column.key]=null;
              const characters=Array.from(value), total=Math.ceil(characters.length/15000);
              for(let index=0;index<total;index++) parts.push({key:`${row.key}:context:${column.key}:${index+1}`,label:"精确上下文续行",context_parent:row.key,context_field:column.key,context_part:`${index+1}/${total}`,[column.key]:characters.slice(index*15000,(index+1)*15000).join("")});
          }
          continued.push(main,...parts);
          if(continued.length>20000) throw new HttpError(422,"geo_read_filter_invalid","Narrow the selected context before exporting more than 20,000 typed rows.");
      }
      rows=continued;
      canonicalMarkdown+="\nCSV 和 Excel 中过长的精确上下文按 context_parent、context_field、context_part 顺序保留为续行。续行不重复测量值；完整对象与修订固定在导出记录中。\n";
  }
  return {
    canonicalMarkdown,
    title: "所选数据分析",
    revision: view.digest,
    assets: [],
    cover: { analysis: metadata },
    typedTable: { columns, rows },
  };
}
/** The 20,000 observation bound also bounds table rows here; pages are joined only after digest parity. */
export async function freezeSelectedGeoAnalysis(store, project, input, dependencies = {}) {
  if (input.rowKey != null || input.columnKey != null)
    throw invalid("Export the analysis table, not a member page.");
  const result = await readGeoAnalysis(
    store,
    project,
    { ...input, limit: 50, offset: 0 },
    true,
    dependencies,
  );
  if (!("rows" in result)) throw invalid("An analysis table is required.");
  return result;
}
