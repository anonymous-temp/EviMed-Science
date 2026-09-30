import { heavyWorkAdmission } from "./heavyWorkAdmission.mjs";
/**
 * 「虚拟临研」's deterministic work: the job queue in front of `vcr-engine`
 * (build plan 2026-09-28 §11.4, integration contract 2026-09-29 §3).
 *
 * A job is not a run. It does not take the study's one run slot, it is not
 * dispatched to a kernel, and a two-hour simulation never blocks the
 * researcher's conversation — that division is the one thing 「循证 GEO」 said
 * was most worth copying here (attachment E §2.2): the steps that *think* run
 * as AI runs, the steps that *compute* run as platform jobs.
 *
 * Hidden knowledge:
 *
 * - **A job is frozen, never referenced.** Every assumption value, population
 *   version, snapshot hash, method version, seed and replicate count is
 *   copied into the row at enqueue. Re-reading an assumption at run time would
 *   make a result unreproducible the moment anyone edits one, which is exactly
 *   the moment reproducibility matters (AC-04).
 * - **The engine is given a job only after three checks, in this order.** What a
 *   caller sent is checked as a caller's (`validateCallerInputs`: patient-level
 *   data is named `{ kind: "snapshot", id }` and nothing more); every such name
 *   is resolved by the data plane for the acting principal into the engine's
 *   own inputs, with a location and a sha256 only the control plane writes; and
 *   the job that results is checked as the engine will check it
 *   (`validateEngineJob`, which reads the per-method scenario schemas). A
 *   scenario the engine cannot read is refused here with the field named, not
 *   queued to fail three minutes later.
 * - **The seed is derived from the scenario, not drawn.** Two enqueues of the
 *   same frozen scenario ask for the same numbers, and a rerun after a restart
 *   is the same run rather than a second sample. A caller that wants a second
 *   independent sample says so with its own seed.
 * - **The idempotency key names what was computed, not only who asked.** It
 *   carries the scenario's hash and the inputs' hash, so the same question
 *   asked twice is one job and a changed assumption or a corrected snapshot is
 *   a new one — under the old key the second enqueue would have returned the
 *   first job's stale result.
 * - **Over budget stops, everything else does not** (plan §10.1: 人只在三处停).
 *   A job whose CPU-second ceiling would take the study past its budget is
 *   written `awaiting_budget` and waits for one confirmation; it is not
 *   refused, not silently shrunk, and nothing else in the study waits for it.
 * - **Cancel is final** (AC-38): the row moves to `canceled` in the same
 *   statement that records the request, the engine is told afterwards on a
 *   best-effort basis, and nothing a still-running worker does afterwards can
 *   move the row again — every write of a running job is conditioned on the
 *   row still being `running` and still leased to that worker, and the
 *   execution, the result and the row's own move commit together or not at all.
 *   What the engine had computed when the cancel reached it is fetched later and
 *   kept as a `limited` partial result (`recoverCanceled`).
 * - **Failure keeps what was computed** (principle 19, AC-19): a `failed` or
 *   `canceled` result that carries measures is recorded only when it says
 *   `conclusion: "limited"` — the engine's rule for a run cut short by its CPU
 *   budget or a cancel — and is then a result marked `partial`. A failed job
 *   never writes a zero, and a failed result that claims to be complete is not
 *   believed.
 * - **What a result was filed under is the object it was queued for.** A trial
 *   scenario's result and another scenario's result of the same kind are two
 *   current results, not one superseding the other; the enqueuer names the
 *   subject, and stages of one object (`analytic`, `simulation`, `assurance`)
 *   fold into that subject's current result rather than replace it.
 * - **A result is held against the job it answers.** The engine echoes what it
 *   ran; the echo must equal what was frozen, and the output hash is recomputed
 *   from the numbers here. A result nobody can tie to this job is refused
 *   (`vcr_engine_result_mismatch`), and the engine's own values go into the
 *   execution row.
 * - **What a result may be used for comes from what it used, never from what the
 *   engine says about itself.** The method's own credibility tier (the domain's
 *   table) and the library row of the model a patient set named decide the
 *   ceiling of the result's intended use (`intendedUseCeilingFor`).
 * - **A step's output can be the next step's input, through the data plane.**
 *   The engine's work volume is not the control plane's, so a table the next
 *   job needs (a generated population, a reconstruction's pseudo-patients) is
 *   fetched by name, checked against the sha256 the result lists and filed
 *   under `derived/<study>/<job>/`; the next job names it as `derived` and this
 *   file turns that into a location and a hash the engine will open. Only the
 *   orchestrator may name a derived table, and only synthetic and reconstructed
 *   ones: a patient-level table reaches the engine by grant and snapshot alone.
 * - **`matching.evaluate` does not go to the engine.** Criterion evaluation is
 *   Kleene three-valued logic over structured facts — code, not statistics —
 *   and it runs in the control plane through an injected local executor (the
 *   matching package's). The queue is the same so the study reads one ledger.
 *
 * @module vcrJobs
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_JOB_STATES,
  canonicalScenarioJson, knownErrorCodeMessage, validateCallerInputs, validateEngineJob, vcrLocationIsValid, vcrReplicateFloorFor, vcrResultOutputPayload,
} from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";
import { jobSummaryFromRow, resultFromRow } from "./vcrStore.mjs";
import { HttpError } from "./security.mjs";
import { VcrEngineError, vcrComputedOutputHash, vcrResultEchoIssues } from "./vcrEngineClient.mjs";
import { assertDataPlaneRoot } from "./vcrDataPlane.mjs";

/** States a job may still move out of. */
export const VCR_JOB_OPEN_STATES = Object.freeze(["queued", "running", "awaiting_budget"]);
/** States nothing moves out of. */
export const VCR_JOB_TERMINAL_STATES = Object.freeze(["succeeded", "failed", "canceled"]);
/** How long a claimed job may run before another worker may take it. */
export const VCR_JOB_DEFAULT_LEASE_MS = 900_000;
/** Attempts before a job stops retrying on a failure that waiting could clear. */
export const VCR_JOB_MAX_ATTEMPTS = 3;
/** How many times a job is submitted again because the engine lost it (a restart). */
export const VCR_JOB_MAX_RESUBMITS = 2;
/** What the access judgment is told a job reads the data for. */
export const VCR_JOB_PURPOSE = "vcr";
/** How long after a cancel the engine's partial result is still looked for. */
export const VCR_CANCEL_RECOVERY_MINUTES = 15;

/** The persisted control-plane result, including every stage's diagnostics.
 * This identity is distinct from the engine's signed canonical output payload.
 * @param {any} result */
export function vcrRecordedResultHash(result) {
  return createHash("sha256").update(canonicalScenarioJson({
    id: result.id, version: result.version, executionId: result.executionId,
    output: JSON.parse(vcrResultOutputPayload(result)), diagnostics: result.diagnostics ?? {},
  })).digest("hex");
}

/** The value source of each table a job may hand on, by the method that wrote it. */
export const VCR_DERIVED_SOURCES = Object.freeze({
  "population.scenario": "synthetic", "population.literature": "synthetic", "population.synthpop": "synthetic",
  "patients.continuous": "synthetic", "patients.binary": "synthetic", "patients.time_to_event": "synthetic",
  "evidence.reconstruct_km": "reconstructed",
});

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_job_failed");
/** @param {unknown} value */
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

/** The sha256 of a scenario's canonical bytes — the same bytes the engine hashes. @param {unknown} scenario */
export function vcrScenarioHash(scenario) {
  return createHash("sha256").update(canonicalScenarioJson(scenario ?? {})).digest("hex");
}

/**
 * The seed a scenario gets when the caller does not name one: the first 31
 * bits of its own hash. Deterministic, inside the protocol's range, and it
 * makes 「同一个冻结场景 = 同一次运行」 true without a counter anyone keeps.
 * @param {string} scenarioHash
 */
export function vcrSeedFor(scenarioHash) {
  return Number.parseInt(String(scenarioHash).slice(0, 8), 16) % 2_147_483_647;
}

/**
 * What the idempotency key of a job is made of: the caller's own key (or the
 * kind, when it named none), the study, the scenario's hash and the inputs'
 * hash. Anything that changes what is computed changes the key — and so does
 * the study: the queue's uniqueness is per account, and one account's two
 * studies asking the same question (a default `vcr_simulate` scenario, say) are
 * two jobs, not the first study's job handed to the second.
 * @param {{ key?: string | null, kind: string, studyId: string, scenarioHash: string, inputs: readonly unknown[], seed: number }} parts
 */
export function vcrIdempotencyKey({ key, kind, studyId, scenarioHash, inputs, seed }) {
  const inputsHash = sha256(canonicalScenarioJson(inputs));
  const head = (key == null || key === "" ? `vcr-job:${kind}` : String(key)).slice(0, 110);
  return `${head}:t${sha256(studyId).slice(0, 16)}:s${scenarioHash.slice(0, 16)}:i${inputsHash.slice(0, 16)}:r${seed}`;
}

/**
 * How many replicates a job needs: the domain's floor for the scenario (20,000
 * under the null, 5,000 under an alternative, raised to the precision asked for,
 * on the worst truth of a grid), raised again to what the caller asked for.
 * @param {string} kind @param {Record<string, any>} scenario @param {number | null} asked
 * @returns {number | null} null for a method that has no replicates
 */
export function vcrReplicatesForJob(kind, scenario, asked) {
  if (kind === "design_simulation") return Math.max(vcrReplicateFloorFor(scenario), Number.isInteger(asked) ? Number(asked) : 0);
  if (kind === "design_grid") {
    const truths = list(scenario?.truths).filter((truth) => truth && typeof truth === "object");
    const worst = Math.max(...(truths.length ? truths : [{}]).map((cell) => vcrReplicateFloorFor({
      ...scenario, truth: { ...object(scenario?.truth), ...cell } })));
    return Math.max(worst, Number.isInteger(asked) ? Number(asked) : 0);
  }
  return Number.isInteger(asked) && Number(asked) > 0 ? Number(asked) : null;
}

/**
 * The columns of a table a scenario reads, for the access judgment and the
 * seal: every column a scenario names by key or by a row rule. Empty when the
 * scenario names none (a profile reads the whole table).
 * @param {unknown} scenario
 * @returns {string[]}
 */
export function vcrScenarioColumns(scenario) {
  const out = new Set();
  const COLUMN_KEYS = new Set(["treatmentColumn", "outcomeColumn", "weightColumn", "idColumn", "tstrOutcome", "column", "outcome", "target"]);
  const LIST_KEYS = new Set(["covariates", "predictors", "on"]);
  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      if (COLUMN_KEYS.has(key) && typeof value === "string") out.add(value);
      else if (LIST_KEYS.has(key) && Array.isArray(value)) for (const item of value) if (typeof item === "string") out.add(item);
      else if (key === "targets" && value && typeof value === "object") for (const name of Object.keys(value)) out.add(name);
      else walk(value, depth + 1);
    }
  };
  walk(scenario, 0);
  return [...out].filter((name) => /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(name));
}

/** Job kinds whose work is heavy enough to be the study's budget question. */
const HEAVY_KINDS = new Set(["design_simulation", "design_grid", "synthesize_population", "generate_patients",
  "generate_patients_continuous", "generate_patients_binary"]);

/** Weakest first: the worst of two conclusions is the later one. */
const ORDER_OF_CONCLUSIONS = ["estimable", "limited", "not_estimable"];

/**
 * A later stage of one object folded into the object's current result: the
 * measures of both (the later stage wins a name they share), the worst of the
 * conclusions, and a record of which job made which part. The result stays
 * one row per version — a new version each time a stage lands — so a page that
 * reads an object's result reads all its stages at once.
 *
 * **A number carried over from before a change is said to be old.** When the
 * object was marked stale (an assumption moved, a method changed) the stages
 * that landed before the mark computed the world as it was. A stage this
 * recomputation will run again (`planned`) has its measures carried marked
 * `stale: true` until its own new numbers replace them; a stage it will not run
 * again (a design whose effect card lost its distribution has no assurance any
 * more) has its measures dropped and named in `diagnostics.notRerun`, so an old
 * number is never left standing beside new ones as if it were current.
 *
 * @param {ReturnType<typeof resultFromRow> | null} prior
 * @param {{ conclusion: string | null, notEstimableRule: string | null, counts: Record<string, any>, measures: any[],
 *   diagnostics: Record<string, any>, tables: any[] }} incoming
 * @param {{ stage: string, jobId: string, method: string, methodVersion: string, at?: string | null }} stage
 * @param {{ staleSince?: string | null, planned?: readonly string[] | null }} [change]
 *   `staleSince`: when the object was marked stale and not yet recomputed;
 *   `planned`: the stages the recomputation runs (null: not known — carried, never dropped).
 */
export function vcrMergeStageResult(prior, incoming, stage, { staleSince = null, planned = null } = {}) {
  const entry = { ...stage, conclusion: incoming.conclusion, measures: incoming.measures.map((measure) => String(object(measure).name)) };
  const stageResult = { ...stage, stale: false, conclusion: incoming.conclusion, counts: incoming.counts,
    measures: incoming.measures, diagnostics: incoming.diagnostics, tables: incoming.tables };
  if (!prior) return { ...incoming, diagnostics: { ...incoming.diagnostics, stages: [entry], stageResults: { [stage.stage]: stageResult } } };

  const before = list(object(prior.diagnostics).stages).map(object).filter((each) => each.stage !== stage.stage);
  const since = staleSince ? Date.parse(staleSince) : Number.NaN;
  /** Stages that landed before the change: their numbers describe the world as it was. */
  const old = Number.isFinite(since) ? before.filter((each) => typeof each.at === "string" && Date.parse(each.at) < since) : [];
  const rerun = planned == null ? null : new Set(planned.map(String));
  const dropped = rerun ? old.filter((each) => !rerun.has(String(each.stage))) : [];
  const carried = old.filter((each) => !dropped.includes(each));
  const current = before.filter((each) => !old.includes(each));

  const namesOf = (/** @type {Record<string, any>[]} */ entries) => new Set(entries.flatMap((each) => list(each.measures).map(String)));
  const currentNames = namesOf([...current, entry]);
  const carriedNames = namesOf(carried);
  const droppedNames = namesOf(dropped);

  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const measure of list(prior.measures)) {
    const name = String(object(measure).name);
    if (currentNames.has(name)) byName.set(name, measure);
    else if (carriedNames.has(name)) byName.set(name, { ...object(measure), stale: true });
    else if (!droppedNames.has(name)) byName.set(name, measure);
  }
  for (const measure of incoming.measures) byName.set(String(object(measure).name), measure);

  const counts = { ...object(prior.counts) };
  for (const [key, value] of Object.entries(object(incoming.counts))) if (value !== null && value !== undefined) counts[key] = value;
  const kept = [...current, ...carried];
  const keptNames = new Set(kept.map((each) => String(each.stage)));
  const stageResults = Object.fromEntries(Object.entries(object(object(prior.diagnostics).stageResults))
    .filter(([name]) => keptNames.has(name)).map(([name, value]) => [name, { ...object(value), stale: carried.some((each) => each.stage === name) }]));
  stageResults[stage.stage] = stageResult;
  const conclusions = kept.length ? [incoming.conclusion, ...kept.map((each) => each.conclusion)] : [prior.conclusion, incoming.conclusion];
  const worst = conclusions.filter(Boolean)
    .sort((a, b) => ORDER_OF_CONCLUSIONS.indexOf(String(b)) - ORDER_OF_CONCLUSIONS.indexOf(String(a)))[0] ?? incoming.conclusion;
  const tables = new Map(list(prior.tables).map((table) => [String(object(table).name), table]));
  for (const table of incoming.tables) tables.set(String(object(table).name), table);
  // What an earlier merge of this cycle dropped stays said, until the stage itself runs again.
  const notRerun = [...list(object(prior.diagnostics).notRerun).map(object).filter((each) => each.stage !== stage.stage),
    ...dropped.map((each) => ({ stage: String(each.stage), measures: list(each.measures).map(String) }))];
  /** @type {Record<string, any>} */
  const diagnostics = { ...prior.diagnostics, ...incoming.diagnostics, stages: [...current, ...carried, entry], stageResults };
  if (notRerun.length) diagnostics.notRerun = notRerun;
  else delete diagnostics.notRerun;
  return {
    conclusion: worst ?? null,
    notEstimableRule: incoming.notEstimableRule ?? prior.notEstimableRule ?? null,
    counts,
    measures: [...byName.values()],
    diagnostics,
    tables: [...tables.values()],
  };
}

export class VcrJobs {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, config?: Record<string, any>, engine?: any,
   *   localExecutors?: Record<string, (input: { job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown> }) => Promise<any>>,
   *   notifier?: { budgetConfirm?: (study: any, job: any) => Promise<unknown> } | null,
   *   dataPlane?: { resolveEngineInputs: (input: Record<string, any>) => Promise<Array<Record<string, any>>> } | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   *   `localExecutors` is keyed by method id (`matching.evaluate` is the
   *   matching package's); anything not named there goes to the engine.
   *   `dataPlane` is the piece that turns a snapshot a caller named into the
   *   files an engine may open (`resolveEngineInputs`).
   */
  constructor({ store, config = {}, engine = null, localExecutors = {}, notifier = null, dataPlane = null,
    now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("The VCR job queue needs the VCR store.");
    this.store = store;
    this.config = config;
    this.engine = engine;
    this.localExecutors = localExecutors ?? {};
    this.notifier = notifier;
    this.dataPlane = dataPlane;
    this.now = now;
    this.report = report;
    this.owner = `vcr-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.counters = { enqueued: 0, deduplicated: 0, claimed: 0, dispatched: 0, succeeded: 0, failed: 0, canceled: 0,
      awaitingBudget: 0, partial: 0, resubmitted: 0, exhausted: 0, mismatched: 0, tablesStored: 0 };
    /** @type {string | null} */
    this.lastError = null;
    /** @type {Array<(outcome: Record<string, any>) => Promise<unknown> | unknown>} */
    this.finishHooks = [];
    /** @type {any[]} rows failed by the claim for having no attempts left, until the worker has told the orchestrator */
    this.reaped = [];
  }

  get maxConcurrent() { return Math.max(1, Number(this.config.vcrMaxConcurrentJobs ?? 1)); }
  get jobCpuSeconds() { return Math.max(10, Number(this.config.vcrJobCpuSeconds ?? 600)); }
  get leaseMs() { return Math.max(60_000, Number(this.config.vcrLeaseMs ?? VCR_JOB_DEFAULT_LEASE_MS)); }

  /**
   * Register something to run once a job has finished (or been cancelled) and
   * its rows have committed (the matching package persists a `match_criteria`
   * job's assessments here; the orchestrator hears of cancels). A hook that
   * throws is reported and never undoes the job.
   * @param {(outcome: Record<string, any>) => Promise<unknown> | unknown} hook
   */
  addFinishHook(hook) {
    this.finishHooks.push(hook);
    return this;
  }

  // --- budget -----------------------------------------------------------------------

  /**
   * A study's compute budget in CPU-seconds: the deployment's default, plus
   * whatever a person has confirmed on top of it. Used is what finished jobs
   * spent; committed is what open jobs may still spend.
   * @param {string} studyId
   */
  async budgetOf(studyId) {
    const study = await this.store.studyById(studyId);
    const confirmed = Number(object(study?.budget).cpuSecondsConfirmed ?? 0);
    const limitSeconds = Math.max(0, Number(this.config.vcrStudyCpuBudget ?? 7_200)) + (Number.isFinite(confirmed) ? confirmed : 0);
    const row = await this.store.one(`SELECT
        COALESCE(SUM(cpu_seconds_used), 0)::numeric AS used,
        COALESCE(SUM(CASE WHEN state IN ('queued', 'running') THEN cpu_seconds_limit ELSE 0 END), 0)::numeric AS committed,
        COUNT(*) FILTER (WHERE state = 'awaiting_budget')::integer AS awaiting
      FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1`, [studyId]);
    const used = Number(row?.used ?? 0);
    const committed = Number(row?.committed ?? 0);
    return {
      limitSeconds, usedSeconds: used, committedSeconds: committed,
      remainingSeconds: Math.max(0, limitSeconds - used - committed),
      awaitingBudget: Number(row?.awaiting ?? 0),
    };
  }

  // --- enqueue ----------------------------------------------------------------------

  /**
   * Freeze a scenario into a job row.
   *
   * `inputs` are what a caller names: lineage references (`{ kind:
   * "assumption", id: "asm@3" }`) and patient-level data as `{ kind:
   * "snapshot", id }`. `derived` (`[{ resultId, table }]`) and `internal` are the
   * orchestrator's alone: a table an earlier job of this study wrote and the
   * control plane filed in the data plane, handed to the next job — so no route
   * and no gateway can hand an engine a file it chose. The acting principal is
   * `principal`, else `userId`.
   *
   * @param {{ studyId: string, userId: string, principal?: string, kind: string, scenario?: Record<string, any>, inputs?: unknown[],
   *   derived?: Array<{ resultId: string, table: string }>, seed?: number | null, replicates?: number | null, cpuSecondsLimit?: number | null, idempotencyKey?: string | null,
   *   runId?: string | null, maxAttempts?: number, detail?: Record<string, any>, internal?: boolean }} input
   * @returns {Promise<{ job: any, created: boolean }>}
   */
  async enqueue(input) {
    const kind = String(input.kind);
    if (!VCR_JOB_KINDS.includes(kind)) {
      throw new HttpError(400, "vcr_job_kind_invalid", `kind must be one of: ${VCR_JOB_KINDS.join(", ")}.`);
    }
    const studyId = String(input.studyId);
    const method = /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[kind];
    const methodVersion = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method]?.version ?? "";
    const scenario = object(input.scenario);
    const principal = String(input.principal ?? input.userId);

    // 1. what a caller may send
    const asked = list(input.inputs);
    // A patient-level kind must name the snapshot it is granted — unless the orchestrator
    // hands it a table an earlier job of this study wrote (pseudo-patients, a generated
    // population), which is the control plane's own file and needs no grant.
    // A method the control plane computes itself (criterion evaluation) reads the study's own
    // fact ledger server-side and takes no snapshot, though the domain files its kind under the
    // patient-level ones: its input is a frozen as-of, a protocol id and a token of the facts.
    const runsLocally = typeof this.localExecutors[method] === "function";
    const callerIssues = [...validateCallerInputs(asked, { kind: (input.internal === true && list(input.derived).length) || runsLocally ? undefined : kind })];
    if (list(input.derived).length && input.internal !== true) {
      callerIssues.push({ code: "input_location_forbidden", field: "derived", detail: "Only the orchestrator hands one job's table to the next." });
    }
    if (callerIssues.length) throw this.#invalid("vcr_job_scenario_invalid", callerIssues);

    // 2. what the control plane makes of it
    const inputs = [
      ...await this.#resolveInputs({ studyId, principal, kind, method, scenario, asked }),
      ...await Promise.all(list(input.derived).map((entry) => this.#resolveDerived(studyId, object(entry)))),
    ];

    const scenarioHash = vcrScenarioHash(scenario);
    const seed = Number.isInteger(input.seed) ? Number(input.seed) : vcrSeedFor(scenarioHash);
    const replicates = vcrReplicatesForJob(kind, scenario, Number.isInteger(input.replicates) ? Number(input.replicates) : null);
    const cpuSecondsLimit = Math.min(this.jobCpuSeconds,
      Math.max(1, Number(input.cpuSecondsLimit ?? this.jobCpuSeconds)));
    const id = vcrId("job");
    const job = {
      jobId: id, studyId, kind, method, methodVersion,
      protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, seed, replicates, cpuSecondsLimit, inputs, scenario,
    };

    // 3. what the engine will check (a locally computed method has no engine to read a table)
    const issues = validateEngineJob(job).filter((issue) => !(runsLocally && issue.code === "patient_input_required"));
    if (issues.length) throw this.#invalid("vcr_job_scenario_invalid", issues);

    const budget = await this.budgetOf(studyId);
    const overBudget = cpuSecondsLimit > budget.remainingSeconds;
    const state = overBudget ? "awaiting_budget" : "queued";

    const key = vcrIdempotencyKey({ key: input.idempotencyKey ?? null, kind, studyId, scenarioHash, inputs, seed });
    const row = await this.store.one(`INSERT INTO ${VCR_SCHEMA}.jobs
      (id, study_id, user_id, kind, method, method_version, state, scenario, scenario_hash, inputs, seed, replicates,
       cpu_seconds_limit, max_attempts, run_id, idempotency_key, checkpoint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17::jsonb)
      ON CONFLICT (user_id, idempotency_key) DO UPDATE SET updated_at = now()
      RETURNING *, (xmax = 0) AS inserted`,
    [id, studyId, String(input.userId), kind, method, methodVersion, state, JSON.stringify(scenario), scenarioHash,
      JSON.stringify(inputs), seed, replicates, cpuSecondsLimit,
      Math.max(1, Number(input.maxAttempts ?? VCR_JOB_MAX_ATTEMPTS)), input.runId ?? null, key,
      JSON.stringify({ ...object(input.detail), cost: HEAVY_KINDS.has(kind) ? "heavy" : "light" })]);
    const created = row?.inserted === true;
    if (created) {
      this.counters.enqueued += 1;
      if (overBudget) this.counters.awaitingBudget += 1;
      await this.store.audit({ studyId, userId: String(input.userId), action: "vcr.job.enqueue",
        object: String(row.id), detail: { kind, method, state, cpuSecondsLimit, scenarioHash } });
      if (overBudget && this.notifier?.budgetConfirm) {
        const study = await this.store.studyById(studyId);
        if (study) await this.notifier.budgetConfirm(study, jobSummaryFromRow(row)).catch(() => null);
      }
    } else {
      this.counters.deduplicated += 1;
    }
    return { job: jobSummaryFromRow(row), created };
  }

  /** @param {string} code @param {readonly { code: string, field: string, detail?: string }[]} issues */
  #invalid(code, issues) {
    const error = new HttpError(400, code,
      `作业不符合引擎协议：${issues.slice(0, 6).map((issue) => `${issue.field || issue.code}（${issue.code}）`).join("、")}。`);
    /** @type {any} */ (error).issues = issues.slice(0, 20);
    return error;
  }

  /**
   * Every input the engine will receive: lineage references as they are, a
   * snapshot resolved by the data plane into the tables the engine may open, a
   * derived table resolved from the result that wrote it.
   * @param {{ studyId: string, principal: string, kind: string, method: string, scenario: Record<string, any>, asked: unknown[] }} input
   */
  async #resolveInputs({ studyId, principal, kind, method, scenario, asked }) {
    /** @type {Array<Record<string, any>>} */
    const out = [];
    for (const raw of asked) {
      const entry = object(raw);
      if (entry.kind === "snapshot") {
        if (typeof this.dataPlane?.resolveEngineInputs !== "function") {
          throw new HttpError(503, "vcr_data_plane_not_configured", "本部署没有接入数据平面，患者级数据的计算暂不可用；T0 档的步骤不受影响。");
        }
        const fields = vcrScenarioColumns(scenario);
        const resolved = await this.dataPlane.resolveEngineInputs({
          studyId, snapshotId: String(entry.id), principal, purpose: VCR_JOB_PURPOSE, kind, method,
          endpointType: object(scenario.endpoint).type ?? null, ...(fields.length ? { fields } : {}),
        });
        out.push(...list(resolved).map((item) => ({ ...object(item) })));
      } else {
        out.push({ ...entry });
      }
    }
    return out;
  }

  /**
   * A table one job wrote, as the next job's input: found through the result
   * that lists it, checked against the sha256 the result carries, and given the
   * value source the method that wrote it earns.
   * @param {string} studyId @param {Record<string, any>} entry
   */
  async #resolveDerived(studyId, entry) {
    const { resultId, table } = entry;
    const result = typeof resultId === "string" ? await this.store.result(studyId, resultId) : null;
    const listed = list(result?.tables).map(object).find((candidate) => candidate.name === table);
    const location = String(listed?.location ?? "");
    const hash = String(listed?.sha256 ?? "");
    if (!result || !listed || !location.startsWith("derived/") || !vcrLocationIsValid(location) || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new HttpError(409, "vcr_derived_table_missing", "上一步的输出表没有存入数据平面：这一步需要它，暂时算不了。");
    }
    const execution = result.executionId
      ? await this.store.one(`SELECT method FROM ${VCR_SCHEMA}.executions WHERE id = $1`, [result.executionId]) : null;
    const source = /** @type {Record<string, string>} */ (VCR_DERIVED_SOURCES)[String(execution?.method ?? "")];
    if (!source) throw new HttpError(400, "vcr_derived_table_unsupported", "这张表不能作为另一项计算的输入。");
    const root = assertDataPlaneRoot(String(this.config.vcrDataPlaneDir ?? ""));
    const file = path.resolve(root, location);
    if (!file.startsWith(`${root}${path.sep}`)) throw new HttpError(409, "vcr_derived_table_missing", "输出表的位置不在数据平面里。");
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes || sha256Bytes(bytes) !== hash) {
      throw new HttpError(409, "vcr_derived_table_missing", "上一步的输出表丢失或已被改动：这一步暂时算不了。");
    }
    // The engine reads it as a raw table of the value source the method that
    // wrote it earns; it is not an analysis table of a snapshot.
    return { kind: "snapshot_file", id: `${resultId}:${table}`, location, hash, valueSource: source };
  }

  /** @param {string} studyId @param {number} [limit] */
  async listForStudy(studyId, limit = 50) {
    return this.store.jobs(studyId, limit);
  }

  /** @param {string} studyId @param {string} jobId */
  async get(studyId, jobId) {
    return this.store.job(studyId, jobId);
  }

  /**
   * What a job produced, whatever state it ended in: a finished job's result, a
   * failed job's partial one, and the partial result of a job that was cancelled
   * once the engine has reported it stopped (`recoverCanceled`). Null while there
   * is nothing.
   * @param {string} studyId @param {string} jobId
   */
  async resultOf(studyId, jobId) {
    return this.store.resultOfJob(studyId, jobId);
  }

  /** The whole row, engine job id included, for the worker. @param {string} jobId */
  async #row(jobId) {
    return this.store.one(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [jobId]);
  }

  // --- claim and lease ----------------------------------------------------------------

  /**
   * Take up to `limit` queued jobs, honouring the deployment's global
   * concurrency. `FOR UPDATE SKIP LOCKED`, so two control planes never take the
   * same row, and an advisory lock around the count-and-claim so two of them
   * never *count* the same free slot either. A job of a paused study waits; a
   * job another worker held that has run out of attempts is failed by name
   * rather than run again.
   * @param {{ workerId?: string, leaseMs?: number, limit?: number }} [options]
   */
  async claim({ workerId = this.owner, leaseMs = this.leaseMs, limit = 1 } = {}) {
    await this.reconcileStoppedEngineWork();
    const rows = await this.store.transaction(async (client) => {
      const interrupted = (await client.query(`SELECT id FROM ${VCR_SCHEMA}.jobs WHERE state='queued'
        AND checkpoint ? 'engineJobId' AND COALESCE(checkpoint->>'engineStopped','false') <> 'true'
        ORDER BY created_at LIMIT 1`)).rows[0];
      const resumingId = interrupted ? String(interrupted.id) : null;
      if (!(await heavyWorkAdmission(client, "compute", resumingId))) return [];
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-job-claim'))");
      const exhausted = await client.query(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = 'failed', lease_owner = NULL, lease_until = NULL, finished_at = now(), updated_at = now(),
            error = jsonb_build_object('code', 'vcr_job_attempts_exhausted', 'attempts', attempts,
              'message', '这项计算已经试了最大次数，没有做成。')
        WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until < now() AND attempts >= max_attempts RETURNING *`);
      for (const row of exhausted.rows) this.reaped.push(row);
      const running = Number((await client.query(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.jobs
        WHERE state = 'running' AND (lease_until IS NULL OR lease_until > now())`)).rows[0]?.n ?? 0);
      const free = Math.max(0, this.maxConcurrent - running);
      if (!free) return [];
      const take = Math.min(free, Math.max(1, limit));
      const picked = await client.query(`SELECT j.id FROM ${VCR_SCHEMA}.jobs j
        JOIN ${VCR_SCHEMA}.studies s ON s.id = j.study_id AND s.deleted_at IS NULL AND s.status = 'active'
        WHERE ($2::text IS NULL OR j.id=$2) AND ((j.state = 'queued' AND j.run_after <= now())
           OR (j.state = 'running' AND j.lease_until IS NOT NULL AND j.lease_until < now() AND j.attempts < j.max_attempts))
        ORDER BY CASE WHEN j.state='running' OR j.checkpoint ? 'engineJobId' THEN 0 ELSE 1 END,
          j.run_after, j.created_at LIMIT $1 FOR UPDATE OF j SKIP LOCKED`, [take, resumingId]);
      if (!picked.rows.length) return [];
      const ids = picked.rows.map((/** @type {any} */ row) => String(row.id));
      const claimed = await client.query(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = 'running', lease_owner = $2, lease_until = now() + make_interval(secs => $3),
            attempts = attempts + 1, updated_at = now()
        WHERE id = ANY($1::text[]) RETURNING *`, [ids, workerId, Math.round(leaseMs / 1000)]);
      return claimed.rows;
    });
    this.counters.claimed += rows.length;
    this.counters.exhausted += this.reaped.length;
    return rows.map((row) => ({ ...jobSummaryFromRow(row), leaseOwner: String(row.lease_owner) }));
  }

  /** Physical termination is proved by the engine, never by lease expiry. */
  async reconcileStoppedEngineWork() {
    if (!this.engine?.configured?.()) return;
    const rows = await this.store.rows(`SELECT id, checkpoint FROM ${VCR_SCHEMA}.jobs
      WHERE state IN ('failed','canceled') AND checkpoint ? 'engineJobId'
        AND COALESCE(checkpoint->>'engineStopped','false') <> 'true' ORDER BY updated_at LIMIT 5`);
    for (const row of rows) {
      try {
        const engineJobId = String(object(row.checkpoint).engineJobId);
        await this.engine.cancel?.(engineJobId);
        const status = await this.engine.status(engineJobId);
        if (["succeeded", "failed", "canceled", "not_estimable"].includes(status.state)) {
          await this.store.query(`UPDATE ${VCR_SCHEMA}.jobs SET checkpoint = checkpoint || '{"engineStopped":true}'::jsonb
            WHERE id=$1 AND state IN ('failed','canceled')`, [String(row.id)]);
        }
      } catch { /* Unknown physical state retains its admission slot. */ }
    }
  }

  /** The jobs the last claims failed for want of attempts, once each. */
  takeReaped() {
    const rows = this.reaped.splice(0);
    return rows.map(jobSummaryFromRow);
  }

  /** Hold a claimed job's lease while it runs. @param {string} jobId @param {number} [leaseMs] */
  async renew(jobId, leaseMs = this.leaseMs) {
    return this.store.query(`UPDATE ${VCR_SCHEMA}.jobs SET lease_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE id = $1 AND state = 'running'`, [jobId, Math.round(leaseMs / 1000)]);
  }

  /**
   * How far along, and the lease renewed with it: progress is what tells a
   * study that a job that died in its first minute is not one still working.
   * @param {string} jobId @param {{ done?: number, total?: number, note?: string }} progress
   * @param {string | null} [leaseOwner] @param {number | null} [leaseAttempt]
   */
  async progress(jobId, progress, leaseOwner = null, leaseAttempt = null) {
    const value = {
      done: Math.max(0, Number(progress?.done ?? 0)),
      total: Math.max(0, Number(progress?.total ?? 0)),
      ...(progress?.note ? { note: String(progress.note).slice(0, 200) } : {}),
      at: this.now().toISOString(),
    };
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET progress = $2::jsonb, lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND state = 'running' AND ($4::text IS NULL OR lease_owner=$4)
        AND ($5::integer IS NULL OR attempts=$5) RETURNING *`, [jobId, JSON.stringify(value), Math.round(this.leaseMs / 1000), leaseOwner, leaseAttempt]);
    return jobSummaryFromRow(row);
  }

  /**
   * What the queue keeps about a running job beside the engine's own restart
   * point: the engine's job id and when it was submitted. (The engine resumes a
   * simulation from its own checkpoint file when the same job id is submitted
   * again; nothing here is sent to it.) Only a job still running is touched.
   * @param {string} jobId @param {Record<string, any>} checkpoint
   * @param {string | null} [leaseOwner] @param {number | null} [leaseAttempt]
   */
  async checkpoint(jobId, checkpoint, leaseOwner = null, leaseAttempt = null) {
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET checkpoint = checkpoint || $2::jsonb, lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND state = 'running' AND ($4::text IS NULL OR lease_owner=$4)
        AND ($5::integer IS NULL OR attempts=$5) RETURNING *`, [jobId, JSON.stringify(object(checkpoint)), Math.round(this.leaseMs / 1000), leaseOwner, leaseAttempt]);
    return jobSummaryFromRow(row);
  }

  // --- cancel and budget --------------------------------------------------------------

  /**
   * Cancel now. The row moves in the same statement that records the request;
   * the engine is told afterwards and a failure to reach it does not un-cancel
   * anything (AC-38). What the engine had computed is fetched later
   * (`recoverCanceled`).
   * @param {string} studyId @param {string} jobId @param {{ actor?: string }} [options]
   */
  async cancel(studyId, jobId, { actor = "" } = {}) {
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET state = 'canceled', cancel_requested = true, finished_at = now(), updated_at = now(),
          lease_owner = NULL, lease_until = NULL,
          error = COALESCE(error, '{}'::jsonb) || jsonb_build_object('code', 'vcr_job_canceled', 'actor', $3::text)
      WHERE study_id = $1 AND id = $2 AND state = ANY($4::text[]) RETURNING *`,
    [studyId, jobId, String(actor), [...VCR_JOB_OPEN_STATES]]);
    if (!row) {
      const existing = await this.store.job(studyId, jobId);
      if (!existing) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
      return { job: existing, canceled: false };
    }
    this.counters.canceled += 1;
    await this.store.audit({ studyId, userId: String(row.user_id), actor, action: "vcr.job.cancel", object: jobId,
      detail: { keptCheckpoint: Object.keys(object(row.checkpoint)).length > 0 } });
    const engineJobId = object(row.checkpoint).engineJobId;
    if (engineJobId && this.engine?.cancel) await this.engine.cancel(String(engineJobId)).catch(() => null);
    const job = jobSummaryFromRow(row);
    // Whoever cancelled, the module that owns the object hears of it: a cancelled
    // job must not leave its step reading 「进行中」 for ever.
    for (const hook of this.finishHooks) {
      try { await hook({ action: "finished", state: "canceled", job, result: null, canceled: true }); } catch (error) { this.report(codeOf(error)); }
    }
    return { job, canceled: true };
  }

  /**
   * The second human stop, cleared: the confirmed CPU-seconds are added to the
   * study's budget and every job waiting on it is released in one go — a
   * person confirms a study's compute once, not once per job (plan §10.1).
   * @param {string} studyId @param {{ actor: string, cpuSeconds?: number, jobId?: string | null }} input
   */
  async confirmBudget(studyId, input) {
    const study = await this.store.studyById(studyId);
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    const waiting = await this.store.rows(`SELECT id, cpu_seconds_limit FROM ${VCR_SCHEMA}.jobs
      WHERE study_id = $1 AND state = 'awaiting_budget'${input.jobId ? " AND id = $2" : ""}
      ORDER BY created_at`, input.jobId ? [studyId, String(input.jobId)] : [studyId]);
    const needed = waiting.reduce((total, row) => total + Number(row.cpu_seconds_limit ?? 0), 0);
    const grant = Math.max(needed, Math.max(0, Number(input.cpuSeconds ?? 0)));
    const budget = object(study.budget);
    const confirmed = Number(budget.cpuSecondsConfirmed ?? 0) + grant;
    await this.store.updateStudy(studyId, {
      budget: { ...budget, cpuSecondsConfirmed: confirmed, lastConfirmedAt: this.now().toISOString(), lastConfirmedBy: String(input.actor) },
    }, String(input.actor));
    const released = waiting.length
      ? await this.store.rows(`UPDATE ${VCR_SCHEMA}.jobs SET state = 'queued', run_after = now(), updated_at = now()
          WHERE id = ANY($1::text[]) AND state = 'awaiting_budget' RETURNING *`, [waiting.map((row) => String(row.id))])
      : [];
    await this.store.audit({ studyId, userId: study.userId, actor: String(input.actor), action: "vcr.job.budget_confirm",
      object: studyId, detail: { grantedCpuSeconds: grant, released: released.length } });
    return { released: released.map(jobSummaryFromRow), budget: await this.budgetOf(studyId) };
  }

  // --- running one job ------------------------------------------------------------------

  /**
   * Move a claimed job one step: submit it if it has not been submitted,
   * otherwise read where it got to and finish it when it is done. Answers
   * what it did, so the worker can count.
   * @param {any} job a row shape from {@link claim}
   */
  async advance(job) {
    const row = await this.#row(job.id);
    if (!row || row.state !== "running") return { action: "skipped", state: row?.state ?? "gone" };
    const owner = String(row.lease_owner ?? "");
    if (owner !== String(job.leaseOwner ?? this.owner)
      || Number(job.attempts ?? row.attempts) !== Number(row.attempts)) return { action: "skipped", state: "lease_changed" };
    const frozen = this.#engineJob(row);
    const local = this.localExecutors[String(row.method)];
    if (local) return this.#runLocal(row, frozen, local, owner);
    if (!this.engine?.configured?.()) {
      return this.finish(String(row.id), { status: "failed", leaseOwner: owner, leaseAttempt: Number(row.attempts), error: { code: "engine_unavailable",
        message: "计算引擎未接入本部署，这一步暂不可用。" } });
    }
    const engineJobId = object(row.checkpoint).engineJobId;
    if (!engineJobId) return this.#submit(row, frozen, owner);
    try {
      const status = await this.engine.status(String(engineJobId));
      if (status.progress) await this.progress(String(row.id), status.progress, owner, Number(row.attempts));
      if (["queued", "running", "canceling"].includes(status.state)) return { action: "waiting", state: status.state, progress: status.progress };
      let answer;
      try {
        answer = await this.engine.result(String(engineJobId));
      } catch (error) {
        // The engine ended the job without a result of its own to give: a crash,
        // a CPU limit, a memory limit. Its fixed code says which; nothing retries
        // a job that killed its own process.
        if (status.error && ["vcr_engine_rejected", "vcr_engine_not_found"].includes(codeOf(error))) {
          return this.finish(String(row.id), { status: "failed", leaseOwner: owner, leaseAttempt: Number(row.attempts), cpuSeconds: Number(status.cpuSeconds ?? 0), error: {
            code: "vcr_job_failed", engineError: String(status.error), message: ENGINE_ERROR_MESSAGES[String(status.error)] ?? "引擎没有做成这项计算。" } });
        }
        throw error;
      }
      return await this.#settle(row, answer, status, owner);
    } catch (error) {
      if (codeOf(error) === "vcr_engine_not_found") return this.#resubmit(row, frozen, owner);
      return this.#fail(row, error, owner);
    }
  }

  /**
   * Hand a result over for recording: the engine's refusal as a failure with its
   * own reason, anything else after it has been held against the frozen job.
   * @param {any} row @param {{ result: Record<string, any>, signed?: boolean, refused?: boolean }} answer
   * @param {Record<string, any>} status @param {string} owner
   */
  async #settle(row, answer, status, owner) {
    const result = object(answer.result);
    const cpuSeconds = Number(result?.manifest?.cpuSeconds ?? status?.cpuSeconds ?? 0);
    if (answer.refused === true) {
      return this.finish(String(row.id), { status: "failed", leaseOwner: owner, leaseAttempt: Number(row.attempts), cpuSeconds,
        error: vcrErrorFromIssues(result) ?? { code: "vcr_job_failed", message: "引擎拒绝了这项作业。" } });
    }
    this.#verify(row, result);
    const tables = await this.#storeTables(row, result);
    const ended = String(result.status);
    return this.finish(String(row.id), {
      status: ended, result: { ...result, tables }, signed: answer.signed === true, cpuSeconds, leaseOwner: owner, leaseAttempt: Number(row.attempts),
      verifiedStage: JSON.parse(vcrResultOutputPayload(result)),
      outputHash: vcrComputedOutputHash(result),
      // A run the engine refused or stopped says why in its issues: the reason it
      // names is the job's own error, not a bare 「failed」 (a partial result
      // that a spent CPU budget cut short keeps its numbers *and* says so).
      ...(ended === "succeeded" || ended === "not_estimable" ? {} : { error: vcrErrorFromIssues(result) }),
    });
  }

  /**
   * The result held against the job it answers: the echoed identity must be the
   * frozen one, and the hash the engine wrote must be the hash of what it said.
   * (The engine client checks the signature; this check does not depend on it,
   * so a transport that skips it is still held to the frozen job.)
   * @param {any} row @param {Record<string, any>} result
   */
  #verify(row, result) {
    const differ = vcrResultEchoIssues({
      method: String(row.method), methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""),
      seed: Number(row.seed ?? 0), replicates: row.replicates == null ? null : Number(row.replicates),
    }, result);
    if (differ.length) {
      this.counters.mismatched += 1;
      throw new VcrEngineError("vcr_engine_result_mismatch", `引擎返回的结果和提交的作业对不上：${differ.join("、")}。`, { detail: { fields: differ } });
    }
    const written = result?.manifest?.outputHash;
    if (written != null && String(written) !== vcrComputedOutputHash(result)) {
      throw new VcrEngineError("vcr_engine_result_invalid", "引擎结果里的输出哈希和结果本身对不上：这份结果不予采信。", { detail: { reason: "output_hash_mismatch" } });
    }
  }

  /**
   * Submit a job. The engine's answer that it already has this job (a submit
   * whose reply was lost) is the job being there.
   * @param {any} row @param {Record<string, any>} frozen @param {string} owner
   */
  async #submit(row, frozen, owner, resubmit = false) {
    const intent = await this.checkpoint(String(row.id), {
      engineJobId: String(row.id), engineStopped: false,
      submissionIntent: { scenarioHash: String(row.scenario_hash), methodVersion: String(row.method_version),
        at: this.now().toISOString(), attempt: Number(row.attempts) },
      ...(resubmit ? { resubmits: Number(object(row.checkpoint).resubmits ?? 0) + 1 } : {}),
    }, owner, Number(row.attempts));
    if (!intent) return { action: "skipped", state: "changed" };
    try {
      let accepted;
      try {
        accepted = await this.engine.submit(frozen);
      } catch (error) {
        if (String(/** @type {any} */ (error)?.detail) === "job_already_submitted") {
          accepted = { jobId: String(row.id), accepted: true };
        } else throw error;
      }
      if (accepted.jobId !== String(row.id)) throw new VcrEngineError("vcr_engine_response_invalid", "引擎接收的作业身份与提交的身份不一致。");
      const stored = await this.checkpoint(String(row.id), { submittedAt: this.now().toISOString() }, owner, Number(row.attempts));
      if (!stored) {
        const current = await this.#row(String(row.id));
        if (current?.state === "canceled" || current?.state === "failed") await this.engine.cancel(String(row.id)).catch(() => null);
        return { action: "skipped", state: "changed" };
      }
      if (resubmit) this.counters.resubmitted += 1;
      else this.counters.dispatched += 1;
      return { action: resubmit ? "resubmitted" : "submitted", engineJobId: accepted.jobId };
    } catch (error) {
      // A lost response cannot prove that the engine refused this identity.
      // Poll it under the same lease and keep physical admission occupied.
      const stored = await this.checkpoint(String(row.id), { submissionError: codeOf(error) }, owner, Number(row.attempts));
      this.lastError = codeOf(error);
      this.report(this.lastError);
      if (!stored) {
        const current = await this.#row(String(row.id));
        if (current?.state === "canceled" || current?.state === "failed") await this.engine.cancel(String(row.id)).catch(() => null);
        return { action: "skipped", state: "changed" };
      }
      return { action: "waiting", state: "submission_uncertain", code: codeOf(error) };
    }
  }

  /**
   * The engine no longer knows this job: it restarted, and its queue was in
   * memory. The job is submitted again under the same id — the engine keeps a
   * simulation's checkpoint in the job's own directory and resumes from it — a
   * bounded number of times.
   * @param {any} row @param {Record<string, any>} frozen @param {string} owner
   */
  async #resubmit(row, frozen, owner) {
    const tries = Number(object(row.checkpoint).resubmits ?? 0);
    if (tries >= VCR_JOB_MAX_RESUBMITS) {
      return this.finish(String(row.id), { status: "failed", leaseOwner: owner, leaseAttempt: Number(row.attempts), error: { code: "vcr_engine_not_found",
        message: "引擎反复找不到这项作业，没有做成；可以重新计算。" } });
    }
    return this.#submit(row, frozen, owner, true);
  }

  /**
   * A method the control plane computes itself (`matching.evaluate`). The
   * executor gets the same frozen job the engine would, so the two paths
   * cannot drift in what a result was computed from.
   * @param {any} row @param {Record<string, any>} frozen @param {Function} executor @param {string} owner
   */
  async #runLocal(row, frozen, executor, owner) {
    const startedAt = this.now().toISOString();
    try {
      const result = await executor({
        job: { ...frozen, scenarioHash: String(row.scenario_hash ?? "") },
        onProgress: (/** @type {any} */ progress) => this.progress(String(row.id), progress ?? {}, owner, Number(row.attempts)),
      });
      return this.finish(String(row.id), {
        status: String(result?.status ?? "succeeded"),
        result: { ...object(result), jobId: frozen.jobId, scenarioHash: String(row.scenario_hash ?? "") },
        signed: false,
        local: true,
        verifiedStage: JSON.parse(vcrResultOutputPayload(result)),
        outputHash: vcrComputedOutputHash(result),
        startedAt,
        leaseOwner: owner, leaseAttempt: Number(row.attempts),
        cpuSeconds: Number(result?.manifest?.cpuSeconds ?? 0),
      });
    } catch (error) {
      return this.#fail(row, error, owner);
    }
  }

  /** The job as the engine protocol carries it. @param {any} row */
  #engineJob(row) {
    return {
      jobId: String(row.id), studyId: String(row.study_id), kind: String(row.kind), method: String(row.method),
      methodVersion: String(row.method_version ?? ""), protocolVersion: VCR_ENGINE_PROTOCOL_VERSION,
      seed: Number(row.seed ?? 0), replicates: row.replicates == null ? null : Number(row.replicates),
      cpuSecondsLimit: Number(row.cpu_seconds_limit ?? this.jobCpuSeconds),
      inputs: list(row.inputs), scenario: object(row.scenario),
    };
  }

  /**
   * A failure. Retryable and with tries left goes back to the queue with a
   * back-off; anything else is final — and either way what was computed stays,
   * because what was computed was computed (principle 19). A job that was
   * cancelled, or that another worker now holds, is not touched.
   * @param {any} row @param {unknown} error @param {string} owner
   */
  async #fail(row, error, owner) {
    const code = codeOf(error);
    const retryable = /** @type {any} */ (error)?.retryable === true;
    const attempts = Number(row.attempts ?? 0);
    this.lastError = code;
    this.report(code);
    if (retryable && object(row.checkpoint).engineJobId) {
      const held = await this.checkpoint(String(row.id), { transportError: code }, owner, Number(row.attempts));
      return held ? { action: "waiting", state: "engine_unreachable", code } : { action: "skipped", state: "changed" };
    }
    if (retryable && attempts < Number(row.max_attempts ?? VCR_JOB_MAX_ATTEMPTS)) {
      const backoffSeconds = Math.min(600, 15 * 2 ** Math.max(0, attempts - 1));
      const requeued = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = 'queued', lease_owner = NULL, lease_until = NULL, run_after = now() + make_interval(secs => $2),
            error = jsonb_build_object('code', $3::text, 'message', $4::text, 'attempt', $5::integer), updated_at = now()
        WHERE id = $1 AND state = 'running' AND lease_owner = $6 RETURNING *`,
      [String(row.id), backoffSeconds, code, String(/** @type {any} */ (error)?.message ?? "").slice(0, 400), attempts, owner]);
      return requeued ? { action: "requeued", code, job: jobSummaryFromRow(requeued) } : { action: "skipped", state: "changed" };
    }
    return this.finish(String(row.id), {
      status: "failed", leaseOwner: owner, leaseAttempt: Number(row.attempts),
      error: { code, message: String(/** @type {any} */ (error)?.message ?? "").slice(0, 400),
        ...(Array.isArray(/** @type {any} */ (error)?.detail) ? { issues: /** @type {any} */ (error).detail.slice(0, 10) } : {}) },
    });
  }

  /**
   * File the tables the next step needs (the enqueuer named them in
   * `checkpoint.keepTables`) in the data plane, under `derived/<study>/<job>/`,
   * and return the result's table list with each stored one's location. A
   * table that cannot be stored is left out of the list, never half-listed: the
   * step that needs it says so.
   * @param {any} row @param {Record<string, any>} result
   */
  async #storeTables(row, result) {
    const tables = list(result.tables).map((table) => ({ ...object(table) }));
    const keep = new Set(list(object(row.checkpoint).keepTables).map(String));
    const engineJobId = object(row.checkpoint).engineJobId;
    if (!keep.size || !engineJobId || typeof this.engine?.downloadTable !== "function"
      || !String(this.config.vcrDataPlaneDir ?? "").trim()) return tables;
    const root = assertDataPlaneRoot(String(this.config.vcrDataPlaneDir));
    for (const table of tables) {
      if (!keep.has(String(table.name)) || !/^[a-f0-9]{64}$/.test(String(table.sha256))) continue;
      const relative = `derived/${row.study_id}/${row.id}/${table.name}.csv`;
      if (!vcrLocationIsValid(relative)) continue;
      const destination = path.join(root, relative);
      // What is filed here is what the engine's own next job opens, and the engine
      // runs as another user with the data plane mounted read-only: an owner-only
      // file (the mode a patient-level file rightly has) is one it cannot read, and
      // the step that needs it fails with a permission error nobody can trace to
      // its cause. What a job is asked to keep (`keepTables`, named only by the
      // orchestrator and the recruitment forecast) is a generated population, a
      // reconstruction's pseudo-patients or a forecast's probabilities — never a row
      // of a real person, which reaches the engine by grant and snapshot alone — and
      // that is why this subtree, and only this one, is readable by the engine's user.
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: DERIVED_DIRECTORY_MODE });
      for (const directory of derivedDirectories(root, relative)) await fs.chmod(directory, DERIVED_DIRECTORY_MODE);
      const present = await fs.readFile(destination).then((bytes) => sha256Bytes(bytes) === table.sha256).catch(() => false);
      if (!present) {
        await this.engine.downloadTable(String(engineJobId), String(table.name), { destination, sha256: String(table.sha256),
          maxBytes: Number(this.config.vcrDerivedTableMaxBytes ?? 256 * 1024 * 1024), mode: DERIVED_FILE_MODE });
        this.counters.tablesStored += 1;
      }
      await fs.chmod(destination, DERIVED_FILE_MODE);
      table.location = relative;
    }
    return tables;
  }

  /**
   * Which models a result used, for its intended use: the credibility tier the
   * method carries on its own, and the library row of the model a patient set
   * named. Never read from the engine's own account of itself.
   * @param {any} row
   */
  async #usedModels(row) {
    const tier = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[String(row.method)]?.modelTier ?? null;
    const detail = object(row.checkpoint);
    /** @type {any[]} */
    const models = [];
    if (detail.modelId) {
      const library = await this.store.models(String(row.user_id));
      const found = library.find((model) => (model.id === detail.modelId || model.name === detail.modelId)
        && (!detail.modelVersion || model.version === detail.modelVersion));
      models.push(found
        ? { name: found.name, tier: found.tier, risk: found.risk, evidence: found.evidence }
        // A model the library does not hold has earned nothing: the weakest tier, an unknown (so highest) risk, no evidence.
        : { name: String(detail.modelId), tier: "scenario", risk: "unknown", evidence: [] });
    }
    return { tiers: tier ? [tier] : [], models };
  }

  /**
   * Record what a job produced and close it. A `succeeded` or `not_estimable`
   * result becomes an execution row and a result row; a `failed` or `canceled`
   * one that carries measures **and says `limited`** becomes a result marked
   * partial, so the study keeps what was computed and says what it is. Anything
   * else records the failure and nothing more.
   *
   * The execution, the result and the job row commit together, and the job row
   * is only moved if it is still `running` and still this worker's: a job that
   * was cancelled meanwhile stays cancelled and nothing of the late result is
   * kept (AC-38).
   *
   * @param {string} jobId
   * @param {{ status: string, result?: Record<string, any> | null, error?: Record<string, any> | null, signed?: boolean,
   *   local?: boolean, verifiedStage?: Record<string, any>, cpuSeconds?: number, startedAt?: string | null, leaseOwner?: string | null, leaseAttempt?: number | null, outputHash?: string | null }} outcome
   */
  async finish(jobId, outcome) {
    const row = await this.#row(jobId);
    if (!row) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
    const status = VCR_JOB_STATES.includes(String(outcome.status)) || outcome.status === "not_estimable"
      ? String(outcome.status) : "failed";
    const result = object(outcome.result);
    const measures = list(result.measures);
    const complete = status === "succeeded" || status === "not_estimable";
    const partial = !complete && measures.length > 0 && result.conclusion === "limited";
    const state = complete ? "succeeded" : (status === "canceled" ? "canceled" : "failed");
    const record = complete || partial;
    const { tiers, models } = record ? await this.#usedModels(row) : { tiers: [], models: [] };
    const study = record ? await this.store.studyById(String(row.study_id)) : null;
    const detail = object(row.checkpoint);
    const kind = String(detail.resultKind || this.#resultKind(String(row.kind)));
    const subjectId = detail.subjectId == null ? null : String(detail.subjectId);
    const leaseOwner = outcome.leaseOwner ?? null;
    const leaseAttempt = outcome.leaseAttempt ?? null;

    const outcomeOf = await this.store.transaction(async (client) => {
      const locked = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE id = $1 FOR UPDATE`, [jobId])).rows[0];
      if (!locked || locked.state !== "running" || (leaseOwner && String(locked.lease_owner ?? "") !== leaseOwner)
        || (leaseAttempt != null && Number(locked.attempts) !== leaseAttempt)) {
        return { skipped: true, state: String(locked?.state ?? "gone") };
      }
      /** @type {any} */
      let execution = null;
      /** @type {any} */
      let recorded = null;
      if (record) {
        execution = await this.store.recordExecution({
          jobId, studyId: String(row.study_id), userId: String(row.user_id), method: String(row.method),
          methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""),
          inputs: list(row.inputs), environment: object(result.manifest),
          // The engine's own account of what it ran, held equal to the frozen job
          // above; on a run that stopped early these are what actually ran.
          seed: Number(result.seed ?? row.seed ?? 0),
          replicates: result.replicates === undefined ? (row.replicates == null ? null : Number(row.replicates)) : result.replicates,
          outputHash: outcome.outputHash ?? result?.manifest?.outputHash ?? null,
          receipt: { signed: outcome.signed === true, local: outcome.local === true, status,
            ...(outcome.verifiedStage ? { stageVerified: true, stageOutput: outcome.verifiedStage } : {}),
            ...(detail.engineJobId ? { engineJobId: String(detail.engineJobId) } : {}), ...(partial ? { partial: true } : {}) },
          cpuSeconds: Number(outcome.cpuSeconds ?? result?.manifest?.cpuSeconds ?? 0),
          startedAt: outcome.startedAt ?? result?.manifest?.startedAt ?? null,
          finishedAt: result?.manifest?.finishedAt ?? this.now().toISOString(),
        }, { client });
        // A summary of numbers somebody typed is not a summary of evidence: when the
        // orchestrator froze this job on inputs no verified extraction backs
        // (`inputsAssumed`, a hybrid control's historical counts), the engine's
        // `aggregate` is not the word for what those numbers are — they are `assumed`.
        const assumedInputs = detail.inputsAssumed === true;
        const sourced = assumedInputs
          ? measures.map((measure) => (object(measure).source === "aggregate" ? { ...object(measure), source: "assumed" } : measure))
          : measures;
        /** @type {any} */
        const incoming = {
          conclusion: complete ? (status === "not_estimable" ? "not_estimable" : (result.conclusion ?? "estimable")) : "limited",
          notEstimableRule: result.notEstimableRule ?? null,
          counts: object(result.counts), measures: sourced,
          diagnostics: { ...object(result.diagnostics), ...(partial ? { partial: true, ...(status === "canceled" ? { canceled: true } : {}) } : {}),
            ...(assumedInputs ? { inputsAssumed: true } : {}) },
          tables: list(result.tables),
        };
        let filed = incoming;
        if (detail.stage) {
          // One subject, one current result: a later stage folds into it, serialised
          // so two stages finishing together cannot each miss the other's measures.
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-vcr-result:${row.study_id}:${kind}:${subjectId ?? ""}`]);
          const prior = resultFromRow((await client.query(`SELECT * FROM ${VCR_SCHEMA}.results
            WHERE study_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3 AND superseded_by IS NULL
            ORDER BY version DESC LIMIT 1`, [String(row.study_id), kind, subjectId])).rows[0]);
          // When the object was last marked stale, on the database's own clock (the
          // clock every job row is stamped with). A stage is old when its job was
          // frozen before that mark, whenever it landed: it computed the world as
          // it was.
          const marked = detail.node
            ? (await client.query(`SELECT marked_at FROM ${VCR_SCHEMA}.stale_marks
              WHERE study_id = $1 AND node = $2 AND cleared_at IS NULL`, [String(row.study_id), String(detail.node)])).rows[0] : null;
          filed = vcrMergeStageResult(prior, incoming, {
            stage: String(detail.stage), jobId, method: String(row.method), methodVersion: String(row.method_version ?? ""),
            at: row.created_at ? new Date(row.created_at).toISOString() : null,
          }, { staleSince: marked?.marked_at ? new Date(marked.marked_at).toISOString() : null,
            planned: Array.isArray(detail.plannedStages) ? detail.plannedStages.map(String) : null });
        }
        // A result made of several stages is only as credible as the weakest of them:
        // the tiers and models the earlier stages used are carried into this one.
        const carried = list(object(filed.diagnostics).modelsUsed).map(object);
        recorded = await this.store.recordResult({
          studyId: String(row.study_id), userId: String(row.user_id), executionId: execution?.id ?? null, kind, subjectId,
          conclusion: filed.conclusion, notEstimableRule: filed.notEstimableRule, counts: filed.counts, measures: filed.measures,
          diagnostics: filed.diagnostics, tables: filed.tables,
          tiers: [...new Set([...tiers, ...carried.filter((entry) => entry.name === "method").map((entry) => String(entry.tier))])],
          models: [...models, ...carried.filter((entry) => entry.name !== "method")],
          supersedesSubjects: list(detail.supersedes).map(String), requestedUse: study?.intendedUse ?? "exploratory",
        }, { client });
        if (outcome.verifiedStage) {
          const proof = { recordedResultId: recorded.id, recordedResultVersion: recorded.version,
            recordedResultHash: vcrRecordedResultHash(recorded) };
          const updated = (await client.query(`UPDATE ${VCR_SCHEMA}.executions SET receipt=receipt || $2::jsonb WHERE id=$1 RETURNING receipt`,
            [execution.id, JSON.stringify(proof)])).rows[0];
          execution.receipt = updated.receipt;
        }
      }
      const finished = (await client.query(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = $2, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now(),
            cpu_seconds_used = GREATEST(cpu_seconds_used, $3::numeric),
            error = $4::jsonb
        WHERE id = $1 AND state = 'running' RETURNING *`,
      [jobId, state, Number(outcome.cpuSeconds ?? 0),
        outcome.error == null && !partial ? null : JSON.stringify({ ...object(outcome.error), ...(partial ? { partial: true } : {}) })])).rows[0];
      await this.store.audit({ client, studyId: String(row.study_id), userId: String(row.user_id), action: "vcr.job.finish", object: jobId,
        outcome: state === "succeeded" ? "ok" : state,
        reason: outcome.error ? String(object(outcome.error).code ?? "") : "",
        detail: { kind: String(row.kind), resultId: recorded?.id ?? null, partial, signed: outcome.signed === true } });
      return { finished, execution, recorded };
    });
    if (/** @type {any} */ (outcomeOf).skipped) return { action: "skipped", state: /** @type {any} */ (outcomeOf).state };

    const { finished, execution, recorded } = /** @type {any} */ (outcomeOf);
    if (state === "succeeded") this.counters.succeeded += 1;
    else if (state === "failed") this.counters.failed += 1;
    if (partial) this.counters.partial += 1;
    const done = { action: "finished", state, job: jobSummaryFromRow(finished), result: recorded, execution, partial,
      engineResult: result, error: outcome.error ?? null };
    for (const hook of this.finishHooks) {
      try { await hook(done); } catch (error) { this.report(codeOf(error)); }
    }
    return done;
  }

  /**
   * Keep what the engine had computed when a job was cancelled. The cancel is
   * final at once; the engine finishes the batch it is in and writes a result
   * that says `canceled` and — if any batch completed — carries those batches'
   * measures as `limited`. This looks for that result after the fact, records it
   * as a partial result under the cancelled job and leaves the job's state alone.
   * Called by the worker; bounded to the minutes after the cancel.
   * @param {{ limit?: number }} [options]
   */
  async recoverCanceled({ limit = 5 } = {}) {
    if (!this.engine?.configured?.()) return [];
    const rows = await this.store.rows(`SELECT * FROM ${VCR_SCHEMA}.jobs
      WHERE state = 'canceled' AND checkpoint ? 'engineJobId' AND NOT (checkpoint ? 'partialChecked')
        AND finished_at IS NOT NULL ORDER BY finished_at LIMIT $1`, [limit]);
    /** @type {any[]} */
    const recovered = [];
    for (const row of rows) {
      const expired = Date.parse(String(row.finished_at)) < this.now().getTime() - VCR_CANCEL_RECOVERY_MINUTES * 60_000;
      const mark = async (/** @type {string} */ how) => this.store.query(`UPDATE ${VCR_SCHEMA}.jobs
        SET checkpoint = checkpoint || jsonb_build_object('partialChecked', $2::text) WHERE id = $1`, [String(row.id), how]);
      try {
        const status = await this.engine.status(String(object(row.checkpoint).engineJobId));
        if (["queued", "running", "canceling"].includes(status.state)) {
          if (expired) await mark("expired");
          continue;
        }
        const answer = await this.engine.result(String(object(row.checkpoint).engineJobId));
        const result = object(answer.result);
        if (answer.refused !== true) {
          this.#verify(row, result);
          const measures = list(result.measures);
          if (measures.length && result.conclusion === "limited" && String(result.status) !== "succeeded") {
            const kept = await this.#recordAfterCancel(row, result, answer.signed === true);
            if (kept) recovered.push(kept);
          }
        }
        await mark("done");
      } catch (error) {
        // A restarted engine has forgotten the job and a hostile one signs
        // nothing: neither is worth asking again. A busy one might be.
        if (!/** @type {any} */ (error)?.retryable || expired) await mark(codeOf(error));
      }
    }
    return recovered;
  }

  /**
   * The partial result of a job that was cancelled, recorded under it.
   * @param {any} row @param {Record<string, any>} result @param {boolean} signed
   */
  async #recordAfterCancel(row, result, signed) {
    const { tiers, models } = await this.#usedModels(row);
    const study = await this.store.studyById(String(row.study_id));
    const detail = object(row.checkpoint);
    const kind = String(detail.resultKind || this.#resultKind(String(row.kind)));
    const subjectId = detail.subjectId == null ? null : String(detail.subjectId);
    return this.store.transaction(async (client) => {
      const locked = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE id = $1 FOR UPDATE`, [String(row.id)])).rows[0];
      const has = await client.query(`SELECT 1 FROM ${VCR_SCHEMA}.executions WHERE job_id = $1`, [String(row.id)]);
      if (!locked || locked.state !== "canceled" || has.rowCount) return null;
      const execution = await this.store.recordExecution({
        jobId: String(row.id), studyId: String(row.study_id), userId: String(row.user_id), method: String(row.method),
        methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""), inputs: list(row.inputs),
        environment: object(result.manifest), seed: Number(result.seed ?? row.seed ?? 0), replicates: result.replicates ?? null,
        outputHash: result?.manifest?.outputHash ?? null, receipt: { signed, canceled: true, partial: true, status: "canceled",
          stageVerified: true, stageOutput: JSON.parse(vcrResultOutputPayload(result)) },
        cpuSeconds: Number(result?.manifest?.cpuSeconds ?? 0), startedAt: result?.manifest?.startedAt ?? null,
        finishedAt: result?.manifest?.finishedAt ?? this.now().toISOString(),
      }, { client });
      const recorded = await this.store.recordResult({
        studyId: String(row.study_id), userId: String(row.user_id), executionId: execution?.id ?? null, kind, subjectId,
        conclusion: "limited", counts: object(result.counts), measures: list(result.measures),
        diagnostics: { ...object(result.diagnostics), partial: true, canceled: true }, tables: list(result.tables),
        tiers, models, supersedesSubjects: list(detail.supersedes).map(String), requestedUse: study?.intendedUse ?? "exploratory",
      }, { client });
      const proof = { recordedResultId: recorded.id, recordedResultVersion: recorded.version, recordedResultHash: vcrRecordedResultHash(recorded) };
      const updated = (await client.query(`UPDATE ${VCR_SCHEMA}.executions SET receipt=receipt || $2::jsonb WHERE id=$1 RETURNING receipt`,
        [execution.id, JSON.stringify(proof)])).rows[0];
      execution.receipt = updated.receipt;
      await client.query(`UPDATE ${VCR_SCHEMA}.jobs SET error = COALESCE(error, '{}'::jsonb) || jsonb_build_object('partial', true),
        cpu_seconds_used = GREATEST(cpu_seconds_used, $2::numeric) WHERE id = $1`, [String(row.id), Number(result?.manifest?.cpuSeconds ?? 0)]);
      this.counters.partial += 1;
      return { job: jobSummaryFromRow(locked), result: recorded, execution };
    });
  }

  /** Which `results.kind` a job kind files under. @param {string} kind */
  #resultKind(kind) {
    if (["build_cohort", "generate_population", "literature_population", "synthesize_population", "population_quality"].includes(kind)) return "population";
    if (["generate_patients", "generate_patients_continuous", "generate_patients_binary"].includes(kind)) return "patient_set";
    if (["weight_comparator", "propensity_weight_comparator", "maic_comparator", "rmst", "map_prior", "evalue", "procova"].includes(kind)) return "comparator";
    if (["design_analytic", "design_simulation", "assurance"].includes(kind)) return "trial_scenario";
    if (kind === "design_grid") return "design_grid";
    if (kind === "match_criteria") return "matching";
    if (kind === "accrual_forecast") return "accrual_forecast";
    if (["pool_evidence", "reconstruct_km"].includes(kind)) return "evidence_pool";
    return "snapshot_profile";
  }

  /** What the worker's status line says. */
  status() {
    return {
      engine: this.engine?.configured?.() ? "wired" : "missing",
      localExecutors: Object.keys(this.localExecutors),
      maxConcurrent: this.maxConcurrent,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }
}

/**
 * The job error a result's own issues make: the first issue's code, field and
 * sentence, and every issue kept (up to ten) beside it. The engine refuses a
 * job in its result — `diagnostics.issues` with the code, the field and the
 * reason (`rule_column_unknown`, `scenario_value_invalid`, `cpu_budget_exhausted`) —
 * and a queue that read only the status word recorded a failed job with no
 * reason, so the study page and the run's own status answer said 「failed」
 * and nothing more.
 * @param {Record<string, any>} result
 * @returns {{ code: string, field?: string, message: string, issues: Array<{ code: string, field: string | null, detail: string }> } | null}
 */
export function vcrErrorFromIssues(result) {
  const issues = list(object(object(result).diagnostics).issues).map(object).filter((issue) => typeof issue.code === "string" && issue.code);
  if (!issues.length) return null;
  const first = issues[0];
  const detail = String(first.detail ?? first.message ?? "").slice(0, 400);
  // The domain holds a sentence for every code the engine raises; the engine's own detail names the column or field.
  const said = knownErrorCodeMessage(String(first.code));
  return {
    code: String(first.code),
    ...(typeof first.field === "string" && first.field ? { field: first.field } : {}),
    message: said ? (detail ? `${said}（${detail}）` : said) : (detail || "引擎拒绝了这项作业。"),
    issues: issues.slice(0, 10).map((issue) => ({ code: String(issue.code), field: typeof issue.field === "string" ? issue.field : null,
      detail: String(issue.detail ?? issue.message ?? "").slice(0, 400) })),
  };
}

/** What the engine's own fixed job errors mean, for a reader. */
const ENGINE_ERROR_MESSAGES = Object.freeze(/** @type {Record<string, string>} */ ({
  engine_crashed: "计算进程异常退出，没有做成。",
  cpu_limit_exceeded: "计算用尽了这项作业的 CPU 上限，被引擎终止；提高上限后可以重新计算。",
  memory_limit_exceeded: "计算用尽了内存，被引擎终止；缩小规模后可以重新计算。",
  spawn_failed: "计算进程没能启动。",
  result_unreadable: "引擎没能写出可读的结果。",
  canceled: "计算已被取消。",
}));

/** Directories and files of the derived (synthetic, reconstructed) tables: readable by the engine's own user. */
export const DERIVED_DIRECTORY_MODE = 0o755;
export const DERIVED_FILE_MODE = 0o644;

/**
 * The directories `derived/<study>/<job>/<file>` sits in, outermost first, as
 * paths under the data-plane root — the ones the engine's user has to be able to
 * walk through to reach the file.
 * @param {string} root @param {string} relative
 */
function derivedDirectories(root, relative) {
  const parts = relative.split("/").slice(0, -1);
  return parts.map((_part, index) => path.join(root, ...parts.slice(0, index + 1)));
}

/** @param {Buffer} bytes */
function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
