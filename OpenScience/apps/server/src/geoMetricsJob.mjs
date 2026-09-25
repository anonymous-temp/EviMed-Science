/**
 * From a finished round's facts to the numbers the pages read (build spec §5
 * "Metrics", plan §4.4): `evimed_geo.metrics` rows for every scope — project,
 * pool, engine, pool × engine, group, arm — computed by the domain's
 * `computeGeoMetrics` (package M, golden-equal to the owner's
 * `compute_metrics.py`), the noise band, and the net effect.
 *
 * Hidden knowledge:
 *
 * - **No formula lives here.** Every number comes from `@evimed/domain`'s GEO
 *   metrics (the owner's `metrics.yaml` as `geo/metrics.json`); this job only
 *   chooses the rows and writes the cells, each with numerator, denominator,
 *   Wilson interval, status, reason and data type exactly as computed.
 * - **A round is measured once all its answers are read.** Until every valid
 *   answer has its facts, the round waits (a spent judge budget waits too);
 *   an answer the judge gave up on is passed without facts and counted as
 *   unparsed — never as an answer that said nothing. New facts after a
 *   computation (a late judgement) recompute the round.
 * - **A paused engine is absent from its round.** The queue skips a paused
 *   engine's remaining jobs to close a round; every answer that engine gave in
 *   the round is then left out, so it reads 「未测」 everywhere rather than
 *   half-measured — its partial answers would make the questions' valid
 *   counts uneven and withdraw every pool rate of the round.
 * - **Three row families besides the cells**, with ids this platform gives
 *   what the owner's yaml names without numbering (A's `GEO_METRIC_IDS`):
 *   `NOISE` (scope project, `variant` = the metric it is the band of: M-01,
 *   M-03, M-10; value = 2 × SD across the noise round's repeats),
 *   `NET` (the net effect: scope project with `variant` M-19 for the index,
 *   scope pool with `variant` = the pool's metric per
 *   `net_effect.metrics_by_pool`; `numerator` = the pilot's change,
 *   `denominator` = the control's change, `reason` = the verdict up / down /
 *   flat, or why it is not computable), and the index itself, which stays the
 *   owner's `M-19`. All three are `derived`.
 * - **Arms exclude contaminated controls**: a control group any article has
 *   touched leaves the control arm (net_effect.control_exclusion), and the
 *   net effect is not computable with fewer than the table's minimum of
 *   clean controls, or before a round after the baseline.
 * - After a diagnostic round (baseline, weekly, single step) the sources
 *   table gets this round's citation counts per engine and pool.
 *
 * @module geoMetricsJob
 */

import { GEO_METRICS, computeGeoMetrics, netEffect, noiseBand } from "@evimed/domain";

/** Round kinds whose metrics are computed. Confirmation rounds feed the errors only. */
export const GEO_METRIC_ROUND_KINDS = Object.freeze(["baseline", "weekly", "sentinel", "post_publication", "single_step", "noise"]);
/** The ids of the computed rows the yaml does not number (package A's `GEO_METRIC_IDS`). */
export const GEO_NET_METRIC_ID = "NET";
export const GEO_NOISE_METRIC_ID = "NOISE";
const NET_ROUND_KINDS = new Set(["baseline", "weekly"]);
const SOURCE_ROUND_KINDS = new Set(["baseline", "weekly", "single_step"]);

/**
 * @typedef {object} GeoMetricsDeps
 * @property {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @property {() => Date} [now]
 * @property {number} [maxRounds]   rounds per tick (default 3)
 * @property {(round: { id: string, geoProjectId: string, kind: string }) => unknown} [onRoundMeasured]
 */

/**
 * Compute every round that is ready and has not been computed (or has new
 * facts since).
 * @param {GeoMetricsDeps} deps
 */
export async function tickMetrics(deps) {
  const { store } = deps;
  await store.ready();
  const counts = { rounds: 0, cells: 0, noise: 0, net: 0, sources: 0 };
  for (const roundId of await store.roundsToMeasure([...GEO_METRIC_ROUND_KINDS], Math.max(1, deps.maxRounds ?? 3))) {
    const measured = await measureRound(deps, roundId);
    if (!measured) continue;
    counts.rounds += 1;
    counts.cells += measured.cells;
    counts.noise += measured.noise;
    counts.net += measured.net;
    counts.sources += measured.sources;
    try {
      await deps.onRoundMeasured?.({ id: roundId, geoProjectId: measured.geoProjectId, kind: measured.kind });
    } catch { /* the numbers are written either way */ }
  }
  return counts;
}

/**
 * @typedef {{ questionId?: string | null, engine: string, repeatIndex?: number | null, status: string, askedAt?: string | null, facts?: object | null }} BalanceRow
 */

/**
 * One answer per job, and the questions answered on every engine that
 * answered anything in the round.
 *
 * - `deduped`: every row, with at most one in-denominator answer (a judged
 *   valid answer, or a refusal) per question × engine × repeat — the latest.
 *   Suspect and failed asks are kept: they are the valid-rate's denominator.
 * - `rows`: `deduped` restricted to the questions that have such an answer on
 *   every engine for every repeat — the balanced set the cross-engine scopes
 *   are computed on.
 * @template {BalanceRow} T
 * @param {T[]} rows
 */
export function balanceRows(rows) {
  const answered = (/** @type {T} */ row) => (row.status === "valid" && Boolean(row.facts)) || row.status === "refusal";
  const key = (/** @type {T} */ row) => `${row.questionId}\u0000${row.engine}\u0000${row.repeatIndex ?? 0}`;
  /** @type {Map<string, T>} */
  const latest = new Map();
  for (const row of rows) {
    if (!answered(row) || !row.questionId) continue;
    const previous = latest.get(key(row));
    if (!previous || String(row.askedAt ?? "") >= String(previous.askedAt ?? "")) latest.set(key(row), row);
  }
  const deduped = rows.filter((row) => !answered(row) || !row.questionId || latest.get(key(row)) === row);
  const engines = [...new Set([...latest.values()].map((row) => row.engine))].sort();
  const repeats = [...new Set(rows.map((row) => row.repeatIndex ?? 0))];
  const questions = [...new Set(rows.map((row) => row.questionId).filter((id) => typeof id === "string"))];
  const complete = new Set(questions.filter((questionId) => engines.every((engine) => repeats.every((repeat) =>
    latest.has(`${questionId}\u0000${engine}\u0000${repeat}`)))));
  return {
    deduped,
    rows: deduped.filter((row) => row.questionId && complete.has(row.questionId)),
    engines,
    questions: questions.length,
    kept: complete.size,
    dropped: questions.filter((questionId) => !complete.has(/** @type {string} */ (questionId))),
  };
}

/** @param {string} metricId @param {{ value: number | null, measured: boolean, reason: string | null }} band @param {number} snapshots */
function noiseRow(metricId, band, snapshots) {
  return {
    scope: "project", metricId: GEO_NOISE_METRIC_ID, variant: metricId, value: band.value, numerator: null, denominator: null,
    ciLow: null, ciHigh: null, status: band.measured ? "ok" : "not_measurable", reason: band.reason, dataType: "derived", snapshotCount: snapshots,
  };
}

/**
 * Compute one round and write its rows.
 * @param {GeoMetricsDeps} deps @param {string} roundId
 * @returns {Promise<{ geoProjectId: string, kind: string, cells: number, noise: number, net: number, sources: number, balanceDropped: number } | null>}
 */
export async function measureRound(deps, roundId) {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const round = await store.round(roundId);
  if (!round) return null;
  const project = await store.project(round.geoProjectId);
  if (!project) return null;
  const rows = await store.roundFactRows(roundId);
  const out = { geoProjectId: project.id, kind: round.kind, cells: 0, noise: 0, net: 0, sources: 0, balanceDropped: 0 };

  if (round.kind === "noise") {
    const noise = GEO_METRICS.platform.noise_band_metric_ids.map((metricId) => noiseRow(metricId, noiseBand(rows, { metricId }), rows.length));
    await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: noise });
    out.noise = noise.length;
    return out;
  }

  const skipped = new Set(await store.roundSkippedEngines(roundId));
  const kept = rows.filter((row) => !skipped.has(row.engine));
  const context = await store.projectContext(project.id);
  const contaminated = new Set(await store.contaminatedControlGroups(project.id));
  /** @type {Map<string, boolean>} */
  const groups = new Map();
  for (const row of kept) if (row.groupId) groups.set(row.groupId, row.isControl);
  const options = {
    engines: round.engines.length ? round.engines : project.engines,
    competitors: project.competitors.map((competitor) => String(competitor?.brandName || competitor?.genericName || "")).filter(Boolean),
    owned: context?.owned ?? {},
    arms: {
      pilot: [...groups].filter(([, control]) => !control).map(([id]) => id),
      control: [...groups].filter(([id, control]) => control && !contaminated.has(id)).map(([id]) => id),
    },
  };
  // Per engine, every answer counts. Across engines (project, pool, group,
  // arm) only questions answered on every engine: one failed ask would
  // otherwise give its question fewer valid answers than the rest, and the
  // domain withdraws the whole pool's rates as uneven_denominators.
  const balance = balanceRows(kept);
  const perEngine = computeGeoMetrics(/** @type {any[]} */ (balance.deduped), { ...options, scopes: ["engine", "pool_engine"] });
  const across = computeGeoMetrics(/** @type {any[]} */ (balance.rows), { ...options, scopes: ["project", "pool", "group", "arm"] });
  const cells = [...across.cells, ...perEngine.cells];
  await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: cells });
  await store.noteRoundBalance(roundId, { questions: balance.questions, kept: balance.kept, dropped: balance.dropped.length,
    droppedQuestionIds: balance.dropped.slice(0, 50), engines: balance.engines });
  out.cells = cells.length;
  out.balanceDropped = balance.dropped.length;
  const arms = options.arms;

  if (NET_ROUND_KINDS.has(round.kind)) {
    const net = await netEffectRows(store, { project, round, controlGroups: arms.control.length });
    await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: net, replace: { metricId: GEO_NET_METRIC_ID } });
    out.net = net.length;
  }
  if (SOURCE_ROUND_KINDS.has(round.kind)) {
    out.sources = await store.refreshSourceCitations({ roundId, geoProjectId: project.id, userId: project.userId, now });
  }
  return out;
}

/**
 * The net effect of every metric the owner's table names per pool, and of the
 * index, from the project's comparable rounds (same question set, baseline and
 * weekly), as `NET` rows.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @param {{ project: { id: string }, round: { setVersion: number | null, sampleDate: string | null }, controlGroups: number }} input
 */
async function netEffectRows(store, { project, round, controlGroups }) {
  const baselineDate = await store.baselineDate(project.id, round.setVersion);
  const noiseIds = new Set(GEO_METRICS.platform.noise_band_metric_ids);
  const rows = [];
  for (const [pool, metricIds] of Object.entries(GEO_METRICS.net_effect.metrics_by_pool)) {
    const index = pool === "index";
    for (const metricId of metricIds) {
      const series = await store.armSeries({ geoProjectId: project.id, setVersion: round.setVersion, metricId, pool: index ? null : pool });
      const noise = noiseIds.has(metricId) ? await store.latestNoiseBand(project.id, metricId) : null;
      const where = { scope: index ? "project" : "pool", pool: index ? null : pool, metricId: GEO_NET_METRIC_ID, variant: metricId, dataType: "derived",
        ciLow: null, ciHigh: null, snapshotCount: null };
      // With nothing after the baseline window there is no change to compare.
      if (!baselineDate || !round.sampleDate || round.sampleDate <= baselineDate) {
        rows.push({ ...where, value: null, numerator: null, denominator: null, status: "not_measurable", reason: "no_follow_up" });
        continue;
      }
      const effect = netEffect(series.pilot, series.control, { noise, baselineDate, controlGroupCount: controlGroups });
      rows.push(effect.status === "computed"
        ? { ...where, value: effect.value ?? null, numerator: effect.pilotChange ?? null, denominator: effect.controlChange ?? null, status: "ok",
          reason: effect.verdict ?? null }
        : { ...where, value: null, numerator: null, denominator: null, status: "not_measurable",
          reason: (effect.missing ?? []).some((entry) => entry.reason === "too_few_control_groups") ? "too_few_control_groups" : "not_computable" });
    }
  }
  return rows;
}
