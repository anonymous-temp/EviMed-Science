/**
 * What is going on in a 虚拟临床研究 study right now, what comes next, and what each step found — the study page's own words about
 * its work, computed once on the server so that a button, a strip and a sentence cannot disagree (R3, 2026-10-14).
 *
 * Hidden knowledge:
 *
 * - **Starting work does not move the person.** A press of 「生成虚拟患者」 answers that the request was taken and what is queued
 *   behind what; the page then reads `activity` every few seconds while there is any, and the result appears where it belongs. There
 *   is no session in any of this: the run's own session is the AI-run record's, and the study's conversation is the study's.
 * - **`queued` and `running` are different things.** A step that is queued is waiting for something named (`waitingFor`: another
 *   step's run, the research allowance, a run that covers no step); a step that is running is in the run `activity.run` describes or
 *   under a job of its own (`activity.jobs`). Neither is a percentage: a run has an odometer, never a fuel gauge.
 * - **Everything is read, nothing is estimated.** The run's phase and counts are what the ledger has observed of its tool calls; the
 *   jobs' done/total are the engine's; a step's one number is a count or a range of the study's own results.
 * - **The strip lingers a few seconds after the last thing ends** (`ACTIVITY_TAIL_MS`), carrying `last`, so a page that polls
 *   sees the end of a run once instead of a strip that vanishes between two reads.
 *
 * @module vcrStudyStatus
 */

import { VCR_RUN_PLACEMENTS, VCR_STEPS, VCR_STEP_NEEDS, VCR_JOB_KIND_STEPS, vcrVisibleQuestion } from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";

/** How long after the last run ended the study still reports `activity`, with that run as `last`. */
export const VCR_ACTIVITY_TAIL_MS = 20_000;

/** The claim of a run that was never recorded as running goes stale after this many minutes (the orchestrator's rule). */
const STALE_CLAIM_MINUTES = 10;

/** The longest a step's one-line finding may be, in characters: a step bar has no room for a sentence. */
export const VCR_STEP_NOTE_MAX = 12;

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @returns {string | null} */
const text = (value) => (typeof value === "string" && value.trim() ? value : null);
/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** @param {unknown} value @returns {string | null} */
const iso = (value) => {
  if (!value) return null;
  const at = new Date(/** @type {any} */ (value)).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
/** @param {number} value */
const grouped = (value) => Math.round(value).toLocaleString("en-US");

// --- the runs of a study, read from its marks ---------------------------------------------------------------------------

/**
 * The run a study's one run slot holds right now and the last one that ended, from the schedule marks.
 * @param {{ one: (sql: string, values?: unknown[]) => Promise<any> }} store
 * @param {string} studyId
 * @returns {Promise<{ flight: Record<string, any> | null, last: Record<string, any> | null }>}
 */
export async function readRunMarks(store, studyId) {
  const [flight, last] = await Promise.all([
    store.one(`SELECT key, state, step, run_id, session_id, dispatch_id, detail, created_at, updated_at FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run' AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2)))
      ORDER BY updated_at DESC LIMIT 1`, [studyId, STALE_CLAIM_MINUTES]),
    store.one(`SELECT key, state, step, run_id, detail, done_at, updated_at FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run' AND state IN ('done', 'failed') ORDER BY COALESCE(done_at, updated_at) DESC LIMIT 1`, [studyId]),
  ]);
  return { flight: flight ?? null, last: last ?? null };
}

/** The steps a run mark covers, in the study's order. @param {Record<string, any> | null | undefined} mark */
function scopeOf(mark) {
  const covered = new Set(list(object(mark?.detail).scope).map((entry) => String(object(entry).step ?? entry)));
  return VCR_STEPS.filter((step) => covered.has(step));
}

// --- the queue ---------------------------------------------------------------------------------------------------------

/**
 * The steps that are asked for and wait, each with what it waits for: the research allowance (`allowance`, `simulated_allowance`),
 * the run that is out (its first step's key, or `run` when it covers no step), or the step whose output it needs. A step that is
 * in the run that is out is not queued: it is running.
 *
 * @param {{ steps?: Record<string, any> | null, flight?: { steps: readonly string[] } | null }} input
 * @returns {Array<{ step: string, waitingFor: string | null }>}
 */
export function vcrQueueOf({ steps, flight = null }) {
  const status = (/** @type {string} */ step) => String(steps?.[step]?.status ?? "none");
  const out = new Set(flight?.steps ?? []);
  /** @type {Array<{ step: string, waitingFor: string | null }>} */
  const queue = [];
  for (const step of VCR_STEPS) {
    if (status(step) !== "queued" || out.has(step)) continue;
    const waiting = steps?.[step]?.waiting;
    let waitingFor = null;
    if (waiting === "allowance" || waiting === "simulated_allowance") waitingFor = waiting;
    else if (flight) waitingFor = flight.steps[0] ?? "run";
    else {
      const needs = /** @type {Record<string, readonly string[]>} */ (VCR_STEP_NEEDS)[step] ?? [];
      waitingFor = needs.find((need) => ["queued", "running"].includes(status(need))) ?? null;
    }
    queue.push({ step, waitingFor });
  }
  return queue;
}

// --- the activity ------------------------------------------------------------------------------------------------------

/**
 * The counts a run's observed tool calls add up to, only where there is one: searches, sources kept, full texts read, claims and
 * how many are checked, the plan's deliverables and how many are done. Nothing here is a share of something unknown.
 * @param {Record<string, any> | null | undefined} progress the ledger's `RunProgress`
 */
function countsOf(progress) {
  const phases = object(progress?.phaseCounts);
  const sources = object(progress?.sources);
  const claims = object(progress?.claims);
  const deliverables = list(progress?.deliverables).map(object);
  /** @type {Record<string, number>} */
  const counts = {};
  const put = (/** @type {string} */ key, /** @type {unknown} */ value) => { const n = finite(value); if (n !== null && n > 0) counts[key] = Math.floor(n); };
  put("search", phases.search);
  put("included", sources.included);
  put("fullText", sources.fullText);
  put("claims", claims.total);
  if (counts.claims) counts.claimsVerified = Math.min(counts.claims, Math.max(0, Math.floor(finite(claims.verified) ?? 0)));
  if (deliverables.length) {
    counts.deliverables = deliverables.length;
    counts.deliverablesDone = deliverables.filter((item) => ["accepted", "delivered"].includes(String(item.status))).length;
  }
  return counts;
}

/**
 * @param {Record<string, any>} mark a run mark @param {Record<string, any> | null} ledger what the run ledger holds of the run
 */
function runView(mark, ledger) {
  const detail = object(mark.detail);
  const steps = scopeOf(mark);
  // Where it took place is recorded when the run is sent. A mark that is only claimed (the run is being sent) or that predates the
  // record has none, and says nothing of the project rather than that it is held — the 423 of a prompt that is refused says it.
  const placement = VCR_RUN_PLACEMENTS.includes(detail.placement) ? /** @type {"open-runtime" | "bounded"} */ (detail.placement) : null;
  const progress = object(ledger?.progress);
  return {
    id: text(mark.run_id),
    step: steps[0] ?? null,
    steps,
    // The person's sentence for it, kept with the run when it went out; derived when an older mark has none.
    label: text(detail.question) ?? vcrVisibleQuestion({ purpose: String(detail.purpose ?? ""), steps, exportKind: text(detail.kind), subjectKey: text(detail.subjectKey) }),
    phase: text(progress.currentPhase),
    counts: countsOf(ledger?.progress),
    startedAt: iso(ledger?.startedAt) ?? iso(mark.created_at),
    placement,
    // A bounded runtime holds the project's own conversation while it works; the study's open runtime never does.
    locked: placement === "bounded",
  };
}

/** @param {Record<string, any>} job */
function jobView(job) {
  const progress = object(job.progress);
  const done = finite(progress.done);
  const total = finite(progress.total);
  const node = String(object(job.checkpoint).node ?? "");
  const nodeStep = { population: "population", patient_set: "patients", comparator_design: "comparator", trial_scenario: "trial", design_grid: "trial" };
  const byNode = /** @type {Record<string, string>} */ (nodeStep)[node.split(":")[0]] ?? null;
  return {
    id: String(job.id),
    kind: String(job.kind),
    state: String(job.state),
    step: byNode ?? /** @type {Record<string, string>} */ (VCR_JOB_KIND_STEPS)[String(job.kind)] ?? null,
    done: done !== null && total !== null && total > 0 ? done : null,
    total: done !== null && total !== null && total > 0 ? total : null,
  };
}

/**
 * The study's activity: the run that is out, the steps that wait and for what, the engine jobs that are open, and — for a few
 * seconds after something ended — what ended. `null` when nothing is going on, which is what a page that polls stops on.
 *
 * @param {{ now: Date, steps?: Record<string, any> | null, flight?: Record<string, any> | null, last?: Record<string, any> | null,
 *   ledger?: Record<string, any> | null, jobs?: readonly Record<string, any>[], tailMs?: number }} input
 *   `flight` and `last` are run marks (`readRunMarks`); `ledger` is the run ledger's record of the flight's run
 * @returns {{ run: ReturnType<typeof runView> | null, queue: Array<{ step: string, waitingFor: string | null }>,
 *   jobs: Array<ReturnType<typeof jobView>>, last: { step: string | null, endedAt: string, outcome: string } | null } | null}
 */
export function buildVcrActivity({ now, steps, flight = null, last = null, ledger = null, jobs = [], tailMs = VCR_ACTIVITY_TAIL_MS }) {
  const run = flight ? runView(flight, ledger) : null;
  const queue = vcrQueueOf({ steps, flight: run ? { steps: run.steps } : null });
  const open = jobs.filter((job) => ["queued", "running", "awaiting_budget"].includes(String(job.state))).map(jobView);
  const endedAt = last ? iso(last.done_at ?? last.updated_at) : null;
  // Within the tail, and not in the future: a run that ended "later than now" is a clock disagreeing, not something just over.
  const age = endedAt === null ? Infinity : now.getTime() - Date.parse(endedAt);
  const recent = age <= tailMs && age > -5_000;
  if (!run && !queue.length && !open.length && !recent) return null;
  const detail = object(last?.detail);
  const status = String(detail.runStatus ?? "");
  const outcome = status === "succeeded" ? "succeeded" : detail.canceled === true || status === "canceled" || status === "cancelled" ? "canceled" : "failed";
  return {
    run,
    queue,
    jobs: open,
    last: recent && last ? { step: scopeOf(last)[0] ?? null, endedAt: /** @type {string} */ (endedAt), outcome } : null,
  };
}

// --- one finding per step ---------------------------------------------------------------------------------------------

/**
 * The power or success assurance of the designs still in the running, as a range: the number a person compares designs on.
 * @param {readonly Record<string, any>[]} designs
 * @returns {string | null}
 */
function designRange(designs) {
  const live = designs.filter((design) => !design.dominated);
  const pick = (/** @type {string} */ key) => live.map((design) => finite(object(design.measures?.[key]).value)).filter((value) => value !== null);
  const assurance = pick("assurance");
  const power = pick("power");
  const shown = assurance.length ? assurance : power;
  if (!shown.length) return null;
  const label = assurance.length ? "成功把握" : "功效";
  const low = Math.round(Math.min(...shown));
  const high = Math.round(Math.max(...shown));
  return `${label} ${low === high ? `${low}%` : `${low}–${high}%`}`;
}

/** The people a result stands for: the records it generated, else the real patients it counted. @param {unknown} counts @returns {number | null} */
function recordsOf(counts) {
  const row = object(counts);
  const generated = finite(row.generatedRecords);
  return generated !== null && generated > 0 ? generated : finite(row.realPatients);
}

/**
 * One short finding per step, with its one number, from what the study already holds: the platform's own counts and results. A step
 * with nothing to say is absent. Pure, over the rows `VcrService` gathered (`bundle`) and the designs its presenter built.
 *
 * @param {Record<string, any>} bundle @param {readonly Record<string, any>[]} designs
 * @returns {Record<string, { note: string | null, stale: boolean }>}
 */
export function vcrStepSummaries(bundle, designs) {
  const study = object(bundle.study);
  const steps = object(study.steps);
  const results = list(bundle.allResults ?? bundle.results);
  const resultOf = (/** @type {string | null | undefined} */ id) => (id ? results.find((entry) => entry.id === id) ?? null : null);
  /** @type {Record<string, string | null>} */
  const notes = {};
  const population = list(bundle.populations)[0] ?? null;
  const patientSet = list(bundle.patientSets)[0] ?? null;
  const comparators = list(bundle.comparators);
  const assumptions = list(bundle.assumptions);
  const criteria = list(bundle.criteria);

  if (bundle.definition) notes.definition = `v${Number(bundle.definition.version) || 1}`;
  if (assumptions.length) notes.evidence = `${assumptions.length} 张假设卡`;
  if (population) {
    const records = recordsOf(resultOf(population.resultId)?.counts) ?? recordsOf(population.counts);
    if (records !== null && records > 0) notes.population = `${grouped(records)} 名`;
  }
  if (patientSet) {
    const records = recordsOf(resultOf(patientSet.resultId)?.counts) ?? recordsOf(patientSet.counts);
    if (records !== null && records > 0) notes.patients = `${grouped(records)} 名`;
  }
  if (comparators.length) {
    const answered = comparators.map((design) => resultOf(design.resultId)).filter(Boolean);
    const estimable = answered.filter((result) => result.conclusion !== "not_estimable").length;
    if (answered.length) notes.comparator = estimable ? `${estimable} 条可估计` : "不可估计";
  }
  if (designs.length) notes.trial = designRange(designs) ?? `${designs.length} 个方案`;
  if (criteria.length) notes.matching = `${criteria.length} 条入排标准`;

  /** @type {Record<string, { note: string | null, stale: boolean }>} */
  const out = {};
  for (const step of VCR_STEPS) {
    const note = notes[step] && [...notes[step]].length <= VCR_STEP_NOTE_MAX ? notes[step] : null;
    const stale = steps[step]?.status === "stale";
    if (note || stale) out[step] = { note, stale };
  }
  return out;
}
