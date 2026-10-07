/**
 * Which research object a computation belongs to (R10, 2026-10-07).
 *
 * A result is filed under the object it was computed for: a design's numbers under that trial scenario, a generated
 * population's under that population. The orchestrator always knew this — it queues a job for an object it holds and says so
 * in the job's detail. A computation a conversation queues through `vcr_simulate` did not: its results carried no subject,
 * `recordResult` supersedes by (kind, subject), and `NULL IS NOT DISTINCT FROM NULL` made three designs' results three versions
 * of one — the later one replaced the earlier ones and the trial tab showed designs with no numbers (live, 2026-10-07).
 *
 * Hidden knowledge:
 *
 * - **A job that computes an object names it.** `resolveJobSubject` is the one place that says which: the id the caller gave, or —
 *   when it gave none and exactly one object fits the scenario it states — that object. A caller that gave none and fits several
 *   (or none) is refused by name with what the study holds, so the next call can name one. It is never guessed among several.
 * - **What fits a trial scenario is its design.** The kind of design, the endpoint and the allocation share are what tell two
 *   designs apart in a conversation ("2:1 fixed", "1:1 fixed", "1:1 group sequential"); the label is the model's own words.
 * - **A stage is a part of an object's result**, not a result of its own: a design's analytic size, its simulated power and its
 *   assurance are three jobs and one result (`vcrMergeStageResult`), so a conversation's jobs carry the same stage names the
 *   orchestrator's do.
 * - **The backfill is the same matcher**, run over the results the old path left without a subject.
 *
 * @module vcrSubjects
 */

import { lineageNode } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SUBJECT_KINDS, vcrJobObjectKind } from "./vcrJobs.mjs";
import { VCR_OBJECT_NODE_KINDS } from "./vcrStore.mjs";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export { VCR_SUBJECT_KINDS, vcrJobObjectKind };

/** What a reader of the page calls each kind of object, in the sentences a run is refused with. */
const OBJECT_WORDS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "人群", patient_set: "虚拟患者集", comparator: "对照设计", trial_scenario: "试验方案", design_grid: "设计网格",
}));
/** The `what` each kind of object is written with. */
const WRITE_WHAT = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "population", patient_set: "patient_set", comparator: "comparator", trial_scenario: "trial_scenario", design_grid: "design_grid",
}));
/** The step an object belongs to (the orchestrator's `item.step`). */
const STEP_OF = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "population", patient_set: "patients", comparator: "comparator", trial_scenario: "trial", design_grid: "trial",
}));
/** The tab a finished object's result opens. */
export const VCR_SUBJECT_TABS = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "population", patient_set: "patients", comparator: "comparator", trial_scenario: "trial", design_grid: "trial",
}));

/**
 * The tables of a generated population or virtual patients a computation is asked to keep in the data plane: what the next job reads
 * and what the researcher downloads (`vcrRecords.mjs`). The programme names the same ones for the objects it queues itself.
 */
export const VCR_KEPT_TABLES = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  generate_population: ["population"], literature_population: ["population"], synthesize_population: ["synthetic-population"],
  generate_patients: ["virtual-patients"], generate_patients_continuous: ["virtual-patients"], generate_patients_binary: ["virtual-patients"],
}));

/** The population `kind` each population job computes: a job for another kind is not about this population. */
const POPULATION_KIND_OF_JOB = Object.freeze(/** @type {Record<string, string>} */ ({
  build_cohort: "real", generate_population: "scenario", literature_population: "literature", synthesize_population: "empirical_synthetic",
}));

/**
 * The stage of an object's result a job is: a trial scenario's analytic, simulation and assurance, a comparator's primary analysis
 * and the extra analyses declared beside it. The words are the orchestrator's own (`vcrBuildStages`), so a conversation's job
 * and the orchestrator's land in the same place.
 * @param {string} kind a job kind @param {string} objectKind
 * @returns {string | null}
 */
export function vcrJobStage(kind, objectKind) {
  if (objectKind === "trial_scenario") {
    return /** @type {Record<string, string>} */ ({ design_analytic: "analytic", design_simulation: "simulation", assurance: "assurance" })[kind] ?? null;
  }
  if (objectKind === "comparator") {
    return /** @type {Record<string, string>} */ ({ rmst: "rmst", maic_time_to_event_comparator: "maic",
      negative_control_comparator: "negative_control", tipping_point: "tipping_point" })[kind] ?? "primary";
  }
  return null;
}

/**
 * The share of patients a design gives the treatment arm, however it is written: `allocation` is the treatment fraction, and a
 * design that states the two sizes states it too.
 * @param {Record<string, any>} design
 * @returns {number | null}
 */
export function vcrDesignShare(design) {
  const allocation = finite(design.allocation);
  if (allocation !== null && allocation > 0 && allocation < 1) return allocation;
  const treated = finite(design.nTreat);
  const control = finite(design.nControl);
  if (treated !== null && control !== null && treated + control > 0) return treated / (treated + control);
  return null;
}

/**
 * How a job's frozen scenario reads against one trial scenario: the design kind, the endpoint and the allocation share must
 * agree where both say one, and the count of agreeing numbers in the design and the truth breaks a tie.
 * @param {Record<string, any>} jobScenario @param {{ design: string, endpointType: string, configuration: Record<string, any> }} row
 * @returns {{ fits: boolean, agreeing: number }}
 */
export function vcrTrialScenarioFit(jobScenario, row) {
  const scenario = object(jobScenario);
  const design = object(scenario.design);
  const kind = typeof design.kind === "string" ? design.kind : null;
  if (kind !== null && kind !== row.design) return { fits: false, agreeing: 0 };
  const endpoint = typeof object(scenario.endpoint).type === "string" ? object(scenario.endpoint).type : null;
  if (endpoint !== null && endpoint !== row.endpointType) return { fits: false, agreeing: 0 };
  const own = object(row.configuration);
  const share = vcrDesignShare(design);
  const ownShare = vcrDesignShare(object(own.design));
  if (share !== null && ownShare !== null && Math.abs(share - ownShare) > 0.005) return { fits: false, agreeing: 0 };
  let agreeing = 0;
  for (const part of ["design", "truth"]) {
    const ours = object(own[part]);
    const theirs = object(scenario[part]);
    for (const [key, value] of Object.entries(theirs)) {
      if (typeof value === "number" && finite(ours[key]) !== null && Math.abs(Number(ours[key]) - value) <= 1e-9 * Math.max(1, Math.abs(value))) agreeing += 1;
      else if (Array.isArray(value) && Array.isArray(ours[key]) && JSON.stringify(value) === JSON.stringify(ours[key])) agreeing += 1;
    }
  }
  return { fits: true, agreeing };
}

/**
 * The trial scenarios a job scenario fits, best first: none when it fits none, one when it fits one design, and several only when
 * they fit equally well (the caller treats that as ambiguous).
 * @param {Record<string, any>} jobScenario @param {ReadonlyArray<Record<string, any>>} rows the current row of each design
 */
export function vcrMatchTrialScenarios(jobScenario, rows) {
  const scored = rows.map((row) => ({ row, ...vcrTrialScenarioFit(jobScenario, /** @type {any} */ (row)) })).filter((entry) => entry.fits);
  const best = Math.max(0, ...scored.map((entry) => entry.agreeing));
  return scored.filter((entry) => entry.agreeing === best).map((entry) => entry.row);
}

/**
 * Every version of every object of one kind, newest first. A design grid has one row per version too, but only the newest is read.
 * @param {any} store @param {string} studyId @param {string} objectKind
 * @returns {Promise<any[]>}
 */
async function objectRows(store, studyId, objectKind) {
  switch (objectKind) {
    case "population": return list(await store.populations(studyId, 200));
    case "patient_set": return list(await store.patientSets(studyId, 200));
    case "comparator": return list(await store.comparatorDesigns(studyId, 200));
    case "trial_scenario": return list(await store.trialScenarios(studyId, 200));
    case "design_grid": { const grid = await store.latestDesignGrid(studyId); return grid ? [grid] : []; }
    default: return [];
  }
}

/**
 * The object rows the study is working on now: the newest version of each design (by label), of each comparator route, and the
 * newest of the rest — the same reading the pages and the orchestrator take.
 * @param {string} objectKind @param {ReadonlyArray<Record<string, any>>} rows newest first
 */
export function vcrCurrentObjects(objectKind, rows) {
  const ordered = [...rows].sort((a, b) => Number(b.version) - Number(a.version));
  if (objectKind === "trial_scenario") return keepFirst(ordered, (row) => row.label || row.id);
  if (objectKind === "comparator") return keepFirst(ordered, (row) => row.route);
  return ordered.slice(0, 1);
}

/** @param {any[]} rows @param {(row: any) => string} keyOf */
function keepFirst(rows, keyOf) {
  const seen = new Set();
  return rows.filter((row) => { const key = keyOf(row); if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * The versions of the same object an earlier computation filed results under: what a new result of this object replaces.
 * (The orchestrator's `#lineOf`, in one place.)
 * @param {any} store @param {string} studyId @param {string} objectKind @param {Record<string, any>} row
 * @returns {Promise<string[]>}
 */
export async function vcrObjectLine(store, studyId, objectKind, row) {
  let rows = await objectRows(store, studyId, objectKind);
  if (objectKind === "comparator") rows = rows.filter((entry) => entry.route === row.route);
  else if (objectKind === "trial_scenario") rows = rows.filter((entry) => (entry.label || entry.id) === (row.label || row.id));
  return rows.filter((entry) => entry.id !== row.id && Number(entry.version) < Number(row.version)).map((entry) => String(entry.id));
}

/** A refusal the run (or the caller) can act on: the code is registered, the sentence says what to do. */
export class VcrSubjectError extends HttpError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(400, code, message);
  }
}

/** @param {string} objectKind @param {ReadonlyArray<Record<string, any>>} current */
function holdings(objectKind, current) {
  if (!current.length) return `本研究还没有${OBJECT_WORDS_ZH[objectKind]}：先用 vcr_write what="${WRITE_WHAT[objectKind]}" 写下它。`;
  const named = current.slice(0, 6).map((row) => `${row.id}（${[row.label, row.name, row.route].find((word) => typeof word === "string" && word) ?? `v${row.version}`}）`);
  return `本研究现有的${OBJECT_WORDS_ZH[objectKind]}：${named.join("、")}。`;
}

/**
 * Say which object a job computes. `null` for a job that is not about one.
 *
 * @param {{ store: any, study: { id: string }, kind: string, subjectId?: string | null, scenario?: Record<string, any> }} input
 * @returns {Promise<null | { objectKind: string, row: Record<string, any>, detail: Record<string, any> }>}
 *   `detail` is what the job carries so its result is filed under the object and lands on it: the subject, the result kind, the
 *   lineage node, the step, the stage and the versions it replaces.
 */
export async function resolveJobSubject({ store, study, kind, subjectId = null, scenario = {} }) {
  const objectKind = vcrJobObjectKind(kind);
  if (!objectKind) return null;
  const rows = await objectRows(store, study.id, objectKind);
  const current = vcrCurrentObjects(objectKind, rows);
  /** @type {Record<string, any> | undefined} */
  let row;
  if (subjectId) {
    row = rows.find((entry) => entry.id === subjectId);
    if (!row) {
      throw new VcrSubjectError("vcr_simulate_subject_unknown",
        `subjectId ${String(subjectId).slice(0, 60)} 不是本研究的${OBJECT_WORDS_ZH[objectKind]}。${holdings(objectKind, current)}`);
    }
  } else {
    // Said without an id: the one object that fits what the scenario states is the one it is about.
    const fitting = objectKind === "trial_scenario" ? vcrMatchTrialScenarios(scenario, current)
      : objectKind === "population" ? current.filter((entry) => POPULATION_KIND_OF_JOB[kind] === undefined || entry.kind === POPULATION_KIND_OF_JOB[kind])
        : current;
    if (fitting.length !== 1) {
      throw new VcrSubjectError("vcr_simulate_subject_required",
        `这项计算要说明它算的是本研究的哪一个${OBJECT_WORDS_ZH[objectKind]}：把它的 id 作为 subjectId 传进来。`
        + `${fitting.length > 1 ? "有几个都符合你写的设定，不替你选。" : ""}${holdings(objectKind, current)}`);
    }
    row = fitting[0];
  }
  const nodeKind = /** @type {Record<string, string>} */ (VCR_OBJECT_NODE_KINDS)[objectKind];
  const stage = vcrJobStage(kind, objectKind);
  return {
    objectKind, row,
    detail: {
      subjectId: String(row.id), resultKind: objectKind, node: lineageNode(/** @type {any} */ (nodeKind), String(row.id), Number(row.version)),
      step: STEP_OF[objectKind], ...(stage ? { stage } : {}), supersedes: await vcrObjectLine(store, study.id, objectKind, row),
      ...(VCR_KEPT_TABLES[kind] ? { keepTables: [...VCR_KEPT_TABLES[kind]] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The backfill: results the old path filed with no subject
// ---------------------------------------------------------------------------

/**
 * The subject a result with none belongs to, read from the job that made it. A trial scenario's result is matched on its design
 * (the allocation share, the kind of design); the other four kinds are the study's one object of that kind or nobody's.
 * @param {{ objectKind: string, job: Record<string, any> | null, rows: ReadonlyArray<Record<string, any>> }} input
 * @returns {{ subject: Record<string, any> | null, reason: string | null }}
 */
export function vcrBackfillSubjectFor({ objectKind, job, rows }) {
  const current = vcrCurrentObjects(objectKind, rows);
  if (!current.length) return { subject: null, reason: "no_object" };
  if (objectKind === "trial_scenario") {
    if (!job) return { subject: null, reason: "no_job" };
    const found = vcrMatchTrialScenarios(object(job.scenario), current);
    if (found.length === 1) return { subject: found[0], reason: null };
    return { subject: null, reason: found.length ? "ambiguous" : "no_fit" };
  }
  // The study's one object of that kind: nothing else the result could be about.
  return current.length === 1 ? { subject: current[0], reason: null } : { subject: null, reason: "ambiguous" };
}

/**
 * Give the results the old path left without a subject the object they were computed for, and undo the supersessions that
 * crossed from one object to another. Report by default; `apply` writes, in one transaction per study, and a second run
 * changes nothing.
 *
 * @param {{ store: any, studyId?: string | null, apply?: boolean, now?: () => Date }} input
 * @returns {Promise<{ apply: boolean, studies: Array<{ studyId: string, assigned: Array<{ resultId: string, kind: string, subjectId: string, label: string | null }>,
 *   unmatched: Array<{ resultId: string, kind: string, reason: string }>, unsuperseded: string[], resuperseded: string[], landed: Array<{ objectId: string, resultId: string }> }> }>}
 */
export async function backfillResultSubjects({ store, studyId = null, apply = false }) {
  const studies = studyId
    ? [{ id: studyId }]
    : await store.rows("SELECT DISTINCT study_id AS id FROM evimed_vcr.results WHERE subject_id IS NULL AND kind = ANY($1::text[])", [[...VCR_SUBJECT_KINDS]]);
  /** @type {Array<any>} */
  const reports = [];
  for (const { id } of studies) {
    reports.push(await backfillStudy({ store, studyId: String(id), apply }));
  }
  return { apply, studies: reports };
}

/** @param {{ store: any, studyId: string, apply: boolean }} input */
async function backfillStudy({ store, studyId, apply }) {
  const results = await store.rows(`SELECT r.id, r.kind, r.subject_id, r.version, r.superseded_by, r.created_at, r.execution_id, r.measures,
      j.id AS job_id, j.kind AS job_kind, j.scenario AS job_scenario
    FROM evimed_vcr.results r
    LEFT JOIN evimed_vcr.executions e ON e.id = r.execution_id
    LEFT JOIN evimed_vcr.jobs j ON j.id = e.job_id
    WHERE r.study_id = $1 AND r.kind = ANY($2::text[]) ORDER BY r.created_at, r.version`, [studyId, [...VCR_SUBJECT_KINDS]]);
  /** @type {Map<string, any[]>} */
  const objects = new Map();
  for (const kind of VCR_SUBJECT_KINDS) objects.set(kind, await objectRows(store, studyId, kind));
  /** @type {Map<string, string>} */
  const subjectOf = new Map(results.filter((row) => row.subject_id != null).map((row) => [String(row.id), String(row.subject_id)]));
  /** @type {Array<{ resultId: string, kind: string, subjectId: string, label: string | null }>} */
  const assigned = [];
  /** @type {Array<{ resultId: string, kind: string, reason: string }>} */
  const unmatched = [];
  for (const row of results.filter((entry) => entry.subject_id == null)) {
    const kind = String(row.kind);
    const found = vcrBackfillSubjectFor({ objectKind: kind, rows: objects.get(kind) ?? [],
      job: row.job_id ? { kind: row.job_kind, scenario: row.job_scenario } : null });
    if (!found.subject) { unmatched.push({ resultId: String(row.id), kind, reason: found.reason ?? "no_fit" }); continue; }
    subjectOf.set(String(row.id), String(found.subject.id));
    assigned.push({ resultId: String(row.id), kind, subjectId: String(found.subject.id), label: found.subject.label || found.subject.name || found.subject.route || null });
  }

  // Within one (kind, subject) the newest result is current and every older one is superseded by it — the rule `recordResult`
  // applies the moment a result lands. A supersession that crossed to another subject is undone by this: it is not recomputed from
  // the old pointer but from the groups.
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const row of results) {
    const subject = subjectOf.get(String(row.id));
    if (!subject) continue;
    const key = `${row.kind}\u0000${subject}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  /** @type {string[]} */
  const unsuperseded = [];
  /** @type {string[]} */
  const resuperseded = [];
  /** @type {Array<{ resultId: string, supersededBy: string | null }>} */
  const pointers = [];
  /** @type {Array<{ objectId: string, resultId: string, table: string }>} */
  const landed = [];
  // A comparator also carries its conclusion and gap list, which only the orchestrator's landing writes from a result: it is not landed here.
  const tableOf = /** @type {Record<string, string>} */ ({ population: "populations", patient_set: "patient_sets", trial_scenario: "trial_scenarios" });
  for (const [key, group] of groups) {
    const [kind, subject] = key.split("\u0000");
    const ordered = [...group].sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) || Number(a.version) - Number(b.version));
    const newest = ordered[ordered.length - 1];
    for (const row of ordered) {
      const want = row.id === newest.id ? null : String(newest.id);
      const have = row.superseded_by == null ? null : String(row.superseded_by);
      if (have === want) continue;
      pointers.push({ resultId: String(row.id), supersededBy: want });
      if (want === null) unsuperseded.push(String(row.id)); else resuperseded.push(String(row.id));
    }
    const owner = (objects.get(kind) ?? []).find((entry) => String(entry.id) === subject);
    if (owner && tableOf[kind] && owner.resultId !== newest.id) {
      landed.push({ objectId: subject, resultId: String(newest.id), table: tableOf[kind] });
    }
  }
  if (apply && (assigned.length || pointers.length || landed.length)) {
    await store.transaction(async (/** @type {any} */ client) => {
      for (const entry of assigned) {
        await client.query("UPDATE evimed_vcr.results SET subject_id = $2 WHERE id = $1 AND subject_id IS NULL", [entry.resultId, entry.subjectId]);
      }
      for (const entry of pointers) {
        await client.query("UPDATE evimed_vcr.results SET superseded_by = $2 WHERE id = $1", [entry.resultId, entry.supersededBy]);
      }
      for (const entry of landed) {
        await client.query(`UPDATE evimed_vcr.${entry.table} SET result_id = $2 WHERE id = $1`, [entry.objectId, entry.resultId]);
      }
      await store.audit({ client, studyId, userId: "system", actor: "backfill", action: "vcr.result.backfill_subject", object: studyId,
        detail: { assigned: assigned.length, repointed: pointers.length, landed: landed.length } });
    });
  }
  return { studyId, assigned, unmatched, unsuperseded, resuperseded, landed: landed.map(({ objectId, resultId }) => ({ objectId, resultId })) };
}
