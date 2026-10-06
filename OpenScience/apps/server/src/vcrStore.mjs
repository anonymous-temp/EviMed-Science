/**
 * 「虚拟临研」's own rows: studies and their definitions, protocols and
 * criteria, populations, patient sets, comparator designs, trial scenarios and
 * grids, executions and results, forecasts, lineage, stale marks, reviews,
 * decisions and exports (build plan 2026-09-28 §11.3).
 *
 * Hidden knowledge:
 *
 * - **Ownership is resolved once, by the study.** `getStudy(userId, id)` and
 *   `studyByControlProject(userId, projectId)` are the only lookups that take
 *   an account; every other method takes the study id the caller already
 *   resolved. A caller that skips the lookup has skipped the tenancy check,
 *   and a study has members, so the lookup is `owner OR member` — the reason
 *   `user_id` alone is never the predicate outside deletion (`vcrStoreBase`).
 * - **A version is a new row, never an edit.** A definition, a protocol, an
 *   assumption key, a population, a patient set, a comparator design, a trial
 *   scenario and a grid all write the next version under the row lock
 *   (`nextVersion`). That is what makes `vcrLineage`'s nodes — `population:pop_x@3`
 *   — mean something: a result points at the version it ran, and editing an
 *   input leaves the result pointing at what it actually used (plan §3.4).
 * - **Results are immutable and superseded, never updated** (plan §3.4). A
 *   recomputation writes a new row and stamps `superseded_by` on the old one,
 *   so a stale result keeps its numbers and its page (plan §6.3, AC-16) — the
 *   whole reason staleness is a state and not a deletion.
 * - **A result's intended use is derived at registration**, from the tiers of
 *   the models it used (`intendedUseCeiling`): a result never claims a use its
 *   weakest model cannot carry, and when it is lowered it says so in
 *   `use_downgrade` rather than being withheld (plan §8.2, AC-34).
 * - **`ai_set` is the default review state everywhere** (plan §10.2): a value
 *   the AI set is in force the moment it is written, carrying its label. A
 *   review is a countersignature on named version nodes, and `reviewStateFor`
 *   in the domain decides whether it still holds.
 * - Every write that changes what a reader would see writes an audit row in
 *   the same transaction (`VcrStoreBase.audit`).
 *
 * @module vcrStore
 */

import { createHash } from "node:crypto";

import {
  VCR_DATA_TIERS, VCR_EXPORT_KINDS, VCR_INTENDED_USES, VCR_MEMBER_ROLES, VCR_REVIEW_KINDS, VCR_STALE_REASONS, VCR_STEPS,
  STEP_WAITING_ALLOWANCE, VCR_STEP_STATUSES, VCR_STUDY_STATUSES, intendedUseCeiling, intendedUseCeilingDetail, lineageNode, missingModelEvidence,
  normalizeVcrAssessment, roleAllows, useWithin,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_COMPARISON_RESULT_KIND, VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";
import { withReviewState } from "./vcrViewsKit.mjs";

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);
/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * What a `results` row is about. Free text in the schema on purpose (a new
 * method must not need a migration), listed here so the read models and the
 * orchestrator agree on the words they file and look up.
 */
export const VCR_RESULT_KINDS = Object.freeze([
  "population", "patient_set", "comparator", "trial_scenario", "design_grid",
  "matching", "accrual_forecast", "evidence_pool", "snapshot_profile",
]);

/** Which lineage node kind each research object is. */
export const VCR_OBJECT_NODE_KINDS = Object.freeze({
  population: "population", patient_set: "patient_set", comparator: "comparator_design",
  trial_scenario: "trial_scenario", design_grid: "design_grid",
});

/** The name a new study and its control-plane project carry before the AI names them. */
export const VCR_DEFAULT_STUDY_NAME = "新虚拟临研研究";

/**
 * The roles whose holder may see a study at all. Derived from the domain's
 * ability table, never listed again: a `site` account holds only referral
 * abilities, so it is a member of the study without the study being one of the
 * pages it may read (build contract §3.1 of the repair: per-operation reads).
 */
export const VCR_READING_ROLES = Object.freeze(VCR_MEMBER_ROLES.filter((role) => roleAllows(role, "read")));

/** A study's step record, all seven present. @param {unknown} value */
export function normalizedVcrSteps(value) {
  const raw = object(value);
  /** @type {Record<string, { status: string, requested: boolean, runId: string | null, jobId: string | null, updatedAt: string | null, note: string | null, waiting: string | null }>} */
  const steps = {};
  for (const step of VCR_STEPS) {
    const entry = object(raw[step]);
    const status = VCR_STEP_STATUSES.includes(entry.status) ? String(entry.status) : "none";
    steps[step] = {
      status,
      requested: entry.requested === true,
      runId: text(entry.runId),
      jobId: text(entry.jobId),
      updatedAt: text(entry.updatedAt),
      note: text(entry.note),
      // What a queued step is waiting on when its start was refused: the allowance (`STEP_WAITING_ALLOWANCE`).
      waiting: STEP_WAITING_ALLOWANCE.includes(entry.waiting) ? String(entry.waiting) : null,
    };
  }
  return steps;
}

/** @param {any} row */
export function vcrStudyFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: String(row.project_id),
    name: String(row.name ?? ""),
    question: String(row.question ?? ""),
    dataTier: String(row.data_tier ?? "T0"),
    intendedUse: String(row.intended_use ?? "exploratory"),
    status: String(row.status ?? "active"),
    steps: normalizedVcrSteps(row.steps),
    budget: object(row.budget),
    outcomeSeal: object(row.outcome_seal),
    // What the study is about, by the shared entity vocabulary (`entityVocabulary.mjs`); none until it could be tagged.
    entityKeys: Array.isArray(row.entity_keys) ? row.entity_keys.map(String) : [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The texts of a study's tagging beyond its name and question: the strings of
 * its definition's PICO (population, conditions, interventions, comparator,
 * outcome — whatever the definition states), bounded.
 * @param {unknown} value @param {number} [depth] @returns {string[]}
 */
function stringLeaves(value, depth = 0) {
  if (typeof value === "string") return value.trim() ? [value.slice(0, 2_000)] : [];
  if (depth >= 3 || !value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => stringLeaves(item, depth + 1)).slice(0, 40);
}

/** The sha256 of a canonical JSON value, as every hash in this module is taken. @param {unknown} value */
export function vcrHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");
}

/** @param {any} row */
function resultFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    studyId: String(row.study_id),
    executionId: text(row.execution_id),
    kind: String(row.kind),
    subjectId: text(row.subject_id),
    version: Number(row.version ?? 1),
    conclusion: text(row.conclusion),
    notEstimableRule: text(row.not_estimable_rule),
    counts: object(row.counts),
    measures: list(row.measures),
    diagnostics: object(row.diagnostics),
    tables: list(row.tables),
    intendedUse: text(row.intended_use),
    useDowngrade: row.use_downgrade == null ? null : object(row.use_downgrade),
    reviewState: String(row.review_state ?? "ai_set"),
    supersededBy: text(row.superseded_by),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function assumptionFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), key: String(row.key), version: Number(row.version),
    name: String(row.name ?? ""), endpoint: text(row.endpoint), unit: text(row.unit), pointValue: num(row.point_value),
    distribution: object(row.distribution), sensitivity: object(row.sensitivity), sourceKind: String(row.source_kind),
    valueSource: String(row.value_source ?? "assumed"), poolingMethod: text(row.pooling_method), pooling: object(row.pooling),
    evidenceIds: list(row.evidence_ids).map(String), applicability: object(row.applicability),
    reviewState: String(row.review_state ?? "ai_set"), note: String(row.note ?? ""), createdAt: iso(row.created_at),
    afterFreeze: row.after_freeze === true,
  };
}

/** @param {any} row */
function populationFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), version: Number(row.version), name: String(row.name ?? ""),
    kind: String(row.kind), definition: object(row.definition), snapshotId: text(row.snapshot_id),
    counts: object(row.counts), waterfall: list(row.waterfall), profile: object(row.profile), quality: object(row.quality),
    allowedUses: list(row.allowed_uses).map(String), resultId: text(row.result_id), reviewState: String(row.review_state ?? "ai_set"),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function patientSetFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), populationId: text(row.population_id), version: Number(row.version),
    name: String(row.name ?? ""), modelId: text(row.model_id), modelVersion: text(row.model_version),
    scenario: object(row.scenario), counts: object(row.counts), twinLabel: text(row.twin_label), resultId: text(row.result_id),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function comparatorFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), version: Number(row.version), route: String(row.route),
    estimand: String(row.estimand ?? "ATT"), targetTrial: object(row.target_trial), configuration: object(row.configuration),
    conclusion: text(row.conclusion), gapList: list(row.gap_list), resultId: text(row.result_id),
    reviewState: String(row.review_state ?? "ai_set"), createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function scenarioFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), version: Number(row.version), label: String(row.label ?? ""),
    design: String(row.design), endpointType: String(row.endpoint_type), configuration: object(row.configuration),
    assumptionIds: list(row.assumption_ids).map(String), comparatorId: text(row.comparator_id), resultId: text(row.result_id),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function jobSummaryFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), kind: String(row.kind), method: String(row.method),
    methodVersion: String(row.method_version ?? ""), state: String(row.state), scenarioHash: String(row.scenario_hash ?? ""),
    progress: object(row.progress), checkpoint: object(row.checkpoint), cancelRequested: row.cancel_requested === true,
    cpuSecondsLimit: num(row.cpu_seconds_limit), cpuSecondsUsed: num(row.cpu_seconds_used), budgetCny: num(row.budget_cny),
    attempts: Number(row.attempts ?? 0), maxAttempts: Number(row.max_attempts ?? 3), runId: text(row.run_id),
    error: row.error == null ? null : object(row.error), seed: row.seed == null ? null : Number(row.seed),
    replicates: row.replicates == null ? null : Number(row.replicates),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), finishedAt: iso(row.finished_at),
  };
}

/** A criterion as every reader of it sees it. @param {any} row */
function criterionFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), protocolVersionId: String(row.protocol_version_id),
    ordinal: Number(row.ordinal), kind: String(row.kind), criterionType: String(row.criterion_type),
    requirement: object(row.requirement), sourceText: String(row.source_text ?? ""), sourceLocator: object(row.source_locator),
    evidenceNeeded: list(row.evidence_needed), reviewState: String(row.review_state ?? "ai_set"), createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function modelAssessmentFromRow(row) {
  if (!row) return null;
  return { ...normalizeVcrAssessment({ ...object(row.record), key: String(row.key) }), id: String(row.id), studyId: String(row.study_id),
    version: Number(row.version), createdAt: iso(row.created_at), by: String(row.saved_by ?? "") || null };
}

/** @param {any} row */
function modelPlanVersionFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), studyId: String(row.study_id), version: Number(row.version), content: object(row.content),
    contentHash: String(row.content_hash), sealPlanVersion: Number(row.seal_plan_version ?? 0), sealPlanHash: String(row.seal_plan_hash ?? ""),
    frozenAt: /** @type {string} */ (iso(row.frozen_at)), frozenBy: String(row.frozen_by ?? ""), outcomeFirstReadAt: iso(row.outcome_first_read_at),
    changes: list(row.changes), issues: list(row.issues), createdAt: iso(row.created_at),
  };
}

export { comparatorFromRow, criterionFromRow, jobSummaryFromRow, patientSetFromRow, populationFromRow, resultFromRow, scenarioFromRow };

/**
 * The study side of `evimed_vcr`. The data plane (A), the evidence side (C)
 * and the matching side (E) keep their own stores against the same schema, so
 * no package migrates a table another one reads.
 */
export class VcrStore extends VcrStoreBase {
  /**
   * @param {{ database: any, statementTimeoutMs?: number, entityVocabulary?: { tag: (input: { texts: string[] }) => Promise<string[] | null> } | null }} options
   *   `entityVocabulary` tags a study; without it, or while it cannot tag, a study has no keys.
   */
  constructor({ entityVocabulary = null, ...options }) {
    super(options);
    this.entityVocabulary = entityVocabulary;
  }

  /**
   * The entity keys of a study from its name, its question and its definition's
   * PICO, or null where there is no vocabulary or it cannot tag. Read outside
   * any transaction: tagging may read the glossary on another connection.
   * @param {{ name: string, question: string }} study @param {Record<string, any> | null | undefined} pico
   */
  async #entityKeys(study, pico) {
    return (await this.entityVocabulary?.tag({ texts: [study.name, study.question, ...stringLeaves(pico ?? {})] })) ?? null;
  }

  /**
   * Tag the studies that carry no entity keys yet, `limit` at a time, from
   * each one's own name, question and latest definition; `userId` narrows a
   * pass to one account's studies. A study edited meanwhile was tagged by the
   * edit, and is left.
   * @param {{ userId?: string | null, limit?: number }} [options]
   * @returns {Promise<{ tagged: number }>}
   */
  async backfillEntityKeys({ userId = null, limit = 100 } = {}) {
    if (!this.entityVocabulary) return { tagged: 0 };
    const rows = await this.rows(`SELECT id, name, question FROM ${VCR_SCHEMA}.studies
      WHERE entity_keys IS NULL AND deleted_at IS NULL AND ($1::text IS NULL OR user_id = $1::text) ORDER BY id LIMIT $2`,
    [userId, Math.max(1, Math.min(500, Math.trunc(limit) || 100))]);
    let tagged = 0;
    for (const row of rows) {
      const keys = await this.#entityKeys({ name: String(row.name), question: String(row.question) }, (await this.latestDefinition(String(row.id)))?.pico);
      if (!keys) break;
      const result = await this.query(`UPDATE ${VCR_SCHEMA}.studies SET entity_keys = $2::text[] WHERE id = $1 AND entity_keys IS NULL AND deleted_at IS NULL`, [row.id, keys]);
      tagged += result.rowCount ?? 0;
    }
    return { tagged };
  }

  /** Read every report input at one PostgreSQL snapshot. @param {(store:VcrStore) => Promise<any>} operation */
  async reportSnapshot(operation) {
    await this.ready();
    return this.database.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = new VcrStore({ database: this.database });
      snapshot.transaction = async (read) => read(client);
      return operation(snapshot);
    });
  }

  // --- studies ------------------------------------------------------------------

  /**
   * A study the account may see: its own, or one it is a member of. The one
   * lookup that takes an account.
   * @param {string} userId @param {string} id
   */
  async getStudy(userId, id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    const row = await this.one(`SELECT s.* FROM ${VCR_SCHEMA}.studies s
      WHERE s.id = $1 AND s.deleted_at IS NULL
        AND (s.user_id = $2 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m WHERE m.study_id = s.id AND m.user_id = $2))`, [id, String(userId)]);
    return vcrStudyFromRow(row);
  }

  /** The study of a control-plane project, for the runtime gateway. @param {string} userId @param {string} projectId @param {any} [client] */
  async studyByControlProject(userId, projectId, client = null) {
    const sql = `SELECT s.* FROM ${VCR_SCHEMA}.studies s
      WHERE s.project_id = $1 AND s.deleted_at IS NULL
        AND (s.user_id = $2 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m WHERE m.study_id = s.id AND m.user_id = $2))
      ORDER BY (s.user_id = $2) DESC, s.id${client ? " FOR SHARE OF s" : ""}`;
    const values = [String(projectId), String(userId)];
    const rows = client ? (await client.query(sql, values)).rows : await this.rows(sql, values);
    const owned = rows.find(row => row.user_id === String(userId));
    return vcrStudyFromRow(owned ?? (rows.length === 1 ? rows[0] : null));
  }

  /**
   * Every study the account may read, newest first: its own, and those where a
   * role that carries `read` was given to it. A member who holds only
   * referral abilities (`site`) has the study's referrals and nothing else, so
   * the study's name, question and headline are not in its list.
   * @param {string} userId
   */
  async listStudies(userId) {
    const rows = await this.rows(`SELECT s.* FROM ${VCR_SCHEMA}.studies s
      WHERE s.deleted_at IS NULL
        AND (s.user_id = $1 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m
          WHERE m.study_id = s.id AND m.user_id = $1 AND m.role = ANY($2::text[])))
      ORDER BY s.updated_at DESC LIMIT 500`, [String(userId), [...VCR_READING_ROLES]]);
    return rows.map(vcrStudyFromRow);
  }

  /** Where the last tick stopped: studies are walked in id order, a page at a time, and the walk wraps. */
  #activeCursor = "";

  /**
   * The next page of active studies, for the orchestrator's tick.
   *
   * A tick that always took the first 200 by `updated_at` starved every study
   * after the 200th: an advance that changes nothing does not touch
   * `updated_at`, so the same 200 came back every time (review 2026-09-29,
   * CS-42). The walk is by id — stable while studies come and go — from where
   * the last call stopped; a short page means the end was reached, and the next
   * call starts again from the beginning, so every active study is visited
   * within ceil(N / limit) ticks.
   * @param {number} limit
   */
  async activeStudies(limit = 200) {
    const size = Math.max(1, Math.min(1_000, Number(limit) || 200));
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.studies
      WHERE deleted_at IS NULL AND status = 'active' AND id > $1 ORDER BY id ASC LIMIT $2`, [this.#activeCursor, size]);
    this.#activeCursor = rows.length < size ? "" : String(rows[rows.length - 1].id);
    return rows.map(vcrStudyFromRow);
  }

  /** @param {string} id */
  async studyById(id) {
    return vcrStudyFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.studies WHERE id = $1 AND deleted_at IS NULL`, [id]));
  }

  /**
   * A new study: one row beside an ordinary project, plus the owner's `lead`
   * membership, so 「谁能看」 is one predicate from the first second.
   * @param {{ userId: string, projectId: string, name?: string, question?: string, dataTier?: string,
   *   intendedUse?: string, budget?: Record<string, any> }} input
   */
  async createStudy(input) {
    const userId = String(input.userId);
    const id = vcrId("study");
    const dataTier = VCR_DATA_TIERS.includes(String(input.dataTier)) ? String(input.dataTier) : "T0";
    const intendedUse = VCR_INTENDED_USES.includes(String(input.intendedUse)) ? String(input.intendedUse) : "exploratory";
    const name = String(input.name ?? VCR_DEFAULT_STUDY_NAME);
    const question = String(input.question ?? "");
    const entityKeys = await this.#entityKeys({ name, question }, null);
    return this.transaction(async (client) => {
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.studies (id, user_id, project_id, name, question, data_tier, intended_use, budget, entity_keys)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[]) RETURNING *`,
      [id, userId, String(input.projectId), name, question,
        dataTier, intendedUse, JSON.stringify(input.budget ?? {}), entityKeys])).rows[0];
      await client.query(`INSERT INTO ${VCR_SCHEMA}.members (study_id, user_id, role, invited_by)
        VALUES ($1, $2, 'lead', $2) ON CONFLICT DO NOTHING`, [id, userId]);
      await this.audit({ client, studyId: id, userId, actor: userId, action: "vcr.study.create", object: id,
        detail: { projectId: String(input.projectId), dataTier, intendedUse } });
      return vcrStudyFromRow(row);
    });
  }

  /**
   * Name, question, data tier, intended use, budget, status.
   * @param {string} studyId @param {Record<string, any>} patch @param {string} actor
   */
  async updateStudy(studyId, patch, actor = "") {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [studyId];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.name !== undefined) put("name", String(patch.name));
    if (patch.question !== undefined) put("question", String(patch.question));
    if (this.entityVocabulary && (patch.name !== undefined || patch.question !== undefined)) {
      // The keys describe the name and question they were made from: new ones, or none until they can be made.
      const current = await this.studyById(studyId);
      if (current) {
        put("entity_keys", await this.#entityKeys({ name: String(patch.name ?? current.name), question: String(patch.question ?? current.question) },
          (await this.latestDefinition(studyId))?.pico), "::text[]");
      }
    }
    if (patch.dataTier !== undefined) put("data_tier", String(patch.dataTier));
    if (patch.intendedUse !== undefined) put("intended_use", String(patch.intendedUse));
    if (patch.status !== undefined) put("status", String(patch.status));
    if (patch.budget !== undefined) put("budget", JSON.stringify(patch.budget), "::jsonb");
    if (patch.outcomeSeal !== undefined) put("outcome_seal", JSON.stringify(patch.outcomeSeal), "::jsonb");
    if (!sets.length) return this.studyById(studyId);
    return this.transaction(async (client) => {
      const row = (await client.query(`UPDATE ${VCR_SCHEMA}.studies SET ${[...sets, "updated_at = now()"].join(", ")}
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`, values)).rows[0];
      if (row) {
        await this.audit({ client, studyId, userId: String(row.user_id), actor, action: "vcr.study.update", object: studyId,
          detail: { fields: Object.keys(patch) } });
      }
      return vcrStudyFromRow(row);
    });
  }

  /** Hidden from 虚拟临研; the project's conversations and files stay. @param {string} studyId @param {string} actor */
  async softDeleteStudy(studyId, actor = "") {
    return this.transaction(async (client) => {
      const row = (await client.query(`UPDATE ${VCR_SCHEMA}.studies SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [studyId])).rows[0];
      if (row) {
        await this.audit({ client, studyId, userId: String(row.user_id), actor, action: "vcr.study.delete", object: studyId });
      }
      return vcrStudyFromRow(row);
    });
  }

  /**
   * One step's record. Merged into `steps`, never replacing it, so two
   * packages writing different steps do not overwrite each other.
   * @param {string} studyId @param {string} step @param {{ status?: string, requested?: boolean, runId?: string | null,
   *   jobId?: string | null, note?: string | null }} fields
   */
  async setStep(studyId, step, fields) {
    if (!VCR_STEPS.includes(step)) throw new TypeError(`setStep: unknown step ${JSON.stringify(step)}`);
    if (fields.status !== undefined && !VCR_STEP_STATUSES.includes(String(fields.status))) {
      throw new TypeError(`setStep: unknown status ${JSON.stringify(fields.status)}`);
    }
    /** @type {Record<string, any>} */
    const entry = { updatedAt: new Date().toISOString() };
    for (const key of ["status", "requested", "runId", "jobId", "note", "waiting"]) {
      if (fields[/** @type {keyof typeof fields} */ (key)] !== undefined) entry[key] = fields[/** @type {keyof typeof fields} */ (key)];
    }
    const row = await this.one(`UPDATE ${VCR_SCHEMA}.studies
      SET steps = jsonb_set(COALESCE(steps, '{}'::jsonb), ARRAY[$2::text],
            COALESCE(steps -> $2, '{}'::jsonb) || $3::jsonb, true), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [studyId, step, JSON.stringify(entry)]);
    return vcrStudyFromRow(row);
  }

  /** Every member of a study, for the page and for access decisions. @param {string} studyId */
  async members(studyId) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.members WHERE study_id = $1 ORDER BY created_at, user_id, role`, [studyId]);
    return rows.map((row) => ({ studyId: String(row.study_id), userId: String(row.user_id), role: String(row.role),
      invitedBy: text(row.invited_by), detail: object(row.detail), createdAt: iso(row.created_at) }));
  }

  /** The roles one account holds in one study (empty = not a member). @param {string} studyId @param {string} userId */
  async rolesOf(studyId, userId) {
    const rows = await this.rows(`SELECT role FROM ${VCR_SCHEMA}.members WHERE study_id = $1 AND user_id = $2`, [studyId, String(userId)]);
    return rows.map((row) => String(row.role));
  }

  // --- definition, protocol, criteria -------------------------------------------

  /**
   * The research question as an object. A new version every time; nothing
   * downstream is rewritten (AC-05).
   * @param {{ studyId: string, userId: string, pico?: Record<string, any>, estimand?: Record<string, any>,
   *   endpointType?: string | null, intendedUse?: string, fieldSources?: Record<string, any>, reviewState?: string }} input
   */
  async saveDefinition(input) {
    // The definition names the disease and the treatment: the study is tagged again from it.
    const study = this.entityVocabulary ? await this.studyById(input.studyId) : null;
    const entityKeys = study ? await this.#entityKeys(study, input.pico) : null;
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "study_definitions", "study_id = $1", [input.studyId]);
      if (study) await client.query(`UPDATE ${VCR_SCHEMA}.studies SET entity_keys = $2::text[] WHERE id = $1`, [input.studyId, entityKeys]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.study_definitions
        (id, study_id, user_id, version, pico, estimand, endpoint_type, intended_use, field_sources, review_state)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10) RETURNING *`,
      [vcrId("definition"), input.studyId, String(input.userId), version, JSON.stringify(input.pico ?? {}),
        JSON.stringify(input.estimand ?? {}), input.endpointType ?? null,
        VCR_INTENDED_USES.includes(String(input.intendedUse)) ? String(input.intendedUse) : "exploratory",
        JSON.stringify(input.fieldSources ?? {}), input.reviewState ?? "ai_set"])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.definition.save",
        object: String(row.id), detail: { version } });
      return this.#definitionFromRow(row);
    });
  }

  /** @param {any} row */
  #definitionFromRow(row) {
    if (!row) return null;
    return {
      id: String(row.id), studyId: String(row.study_id), version: Number(row.version), pico: object(row.pico),
      estimand: object(row.estimand), endpointType: text(row.endpoint_type), intendedUse: String(row.intended_use ?? "exploratory"),
      fieldSources: object(row.field_sources), reviewState: String(row.review_state ?? "ai_set"), createdAt: iso(row.created_at),
    };
  }

  /** @param {string} studyId */
  async latestDefinition(studyId) {
    return this.#definitionFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.study_definitions
      WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]));
  }

  /** @param {string} studyId */
  async definitionVersions(studyId) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.study_definitions WHERE study_id = $1 ORDER BY version DESC LIMIT 50`, [studyId]);
    return rows.map((row) => this.#definitionFromRow(row));
  }

  /**
   * A protocol version. Its criteria are written with it, in one transaction:
   * a protocol whose criteria half-landed would make an assessment reference a
   * version that never fully existed.
   * @param {{ studyId: string, userId: string, title?: string, sourceRef?: string | null, usdm?: Record<string, any>,
   *   criteria?: Array<Record<string, any>> }} input
   */
  async saveProtocolVersion(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "protocol_versions", "study_id = $1", [input.studyId]);
      const id = vcrId("protocol");
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.protocol_versions (id, study_id, user_id, version, title, source_ref, usdm)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [id, input.studyId, String(input.userId), version, String(input.title ?? ""), input.sourceRef ?? null,
        JSON.stringify(input.usdm ?? {})])).rows[0];
      const criteria = [];
      let ordinal = 0;
      for (const item of list(input.criteria)) {
        ordinal += 1;
        criteria.push((await client.query(`INSERT INTO ${VCR_SCHEMA}.criteria
          (id, study_id, protocol_version_id, user_id, ordinal, kind, criterion_type, requirement, source_text, source_locator, evidence_needed, review_state)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12) RETURNING *`,
        [vcrId("criterion"), input.studyId, id, String(input.userId), ordinal, String(item.kind ?? "inclusion"),
          String(item.criterionType ?? "other"), JSON.stringify(item.requirement ?? {}), String(item.sourceText ?? ""),
          JSON.stringify(item.sourceLocator ?? {}), JSON.stringify(item.evidenceNeeded ?? []), item.reviewState ?? "ai_set"])).rows[0]);
      }
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.protocol.save", object: id,
        detail: { version, criteria: criteria.length } });
      return { id, studyId: input.studyId, version, title: String(row.title ?? ""), sourceRef: text(row.source_ref),
        usdm: object(row.usdm), frozenAt: iso(row.frozen_at), createdAt: iso(row.created_at),
        criteria: criteria.map(criterionFromRow) };
    });
  }

  /** @param {string} studyId */
  async latestProtocolVersion(studyId) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.protocol_versions WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]);
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), version: Number(row.version), title: String(row.title ?? ""),
      sourceRef: text(row.source_ref), usdm: object(row.usdm), frozenAt: iso(row.frozen_at), createdAt: iso(row.created_at) };
  }

  /** @param {string} protocolVersionId */
  async criteria(protocolVersionId) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE protocol_version_id = $1 ORDER BY ordinal`, [protocolVersionId]);
    return rows.map(criterionFromRow);
  }

  /** @param {string} protocolVersionId @param {string} actor */
  async freezeProtocolVersion(protocolVersionId, actor = "") {
    return this.transaction(async (client) => {
      const row = (await client.query(`UPDATE ${VCR_SCHEMA}.protocol_versions SET frozen_at = COALESCE(frozen_at, now())
        WHERE id = $1 RETURNING *`, [protocolVersionId])).rows[0];
      if (row) {
        await this.audit({ client, studyId: String(row.study_id), userId: String(row.user_id), actor,
          action: "vcr.protocol.freeze", object: protocolVersionId });
      }
      return row ? { id: String(row.id), frozenAt: iso(row.frozen_at) } : null;
    });
  }

  // --- assumptions ---------------------------------------------------------------

  /**
   * One assumption card, one version. An edit is the next version under the
   * same key, which is what `recomputePlan` traverses from.
   * @param {Record<string, any>} input
   */
  async saveAssumption(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "assumptions", "study_id = $1 AND key = $2", [input.studyId, String(input.key)]);
      // A card written without a distribution keeps the one it had — as long as the edit
      // leaves the number where it was: a note or a unit changed is not a new belief. An edit
      // that moves the number takes the old distribution with it (it was centred on the value
      // that is gone), so the card says it has none and the assurance that integrated over it
      // is not computed again — never a stale prior silently standing behind a new value.
      // `distribution: {}` says 「none」 in as many words.
      let distribution = input.distribution;
      if (distribution === undefined && version > 1) {
        // The card the study has: a version written after the freeze is beside it, not what an edit starts from.
        const previous = (await client.query(`SELECT point_value, distribution FROM ${VCR_SCHEMA}.assumptions
          WHERE study_id = $1 AND key = $2 AND NOT after_freeze ORDER BY version DESC LIMIT 1`, [input.studyId, String(input.key)])).rows[0];
        const sameValue = input.pointValue === undefined || input.pointValue === null
          ? previous?.point_value == null : Number(previous?.point_value) === Number(input.pointValue);
        distribution = previous && sameValue ? object(previous.distribution) : {};
      }
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.assumptions
        (id, study_id, user_id, key, version, name, endpoint, unit, point_value, distribution, sensitivity, source_kind,
         value_source, pooling_method, pooling, evidence_ids, applicability, review_state, note, after_freeze)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16::text[], $17::jsonb, $18, $19, $20)
        RETURNING *`,
      [vcrId("assumption"), input.studyId, String(input.userId), String(input.key), version, String(input.name ?? input.key),
        input.endpoint ?? null, input.unit ?? null, input.pointValue ?? null, JSON.stringify(distribution ?? {}),
        JSON.stringify(input.sensitivity ?? {}), String(input.sourceKind ?? "expert_set"), String(input.valueSource ?? "assumed"),
        input.poolingMethod ?? null, JSON.stringify(input.pooling ?? {}), list(input.evidenceIds).map(String),
        JSON.stringify(input.applicability ?? {}), input.reviewState ?? "ai_set", String(input.note ?? ""), input.afterFreeze === true])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.assumption.save",
        object: String(row.id), detail: { key: String(input.key), version, ...(input.afterFreeze === true ? { afterFreeze: true } : {}) } });
      return assumptionFromRow(row);
    });
  }

  /**
   * The current version of every assumption key, each with the review state its
   * countersignatures give it — 已复核 with who signed, when and which version, or
   * 复核后有变更 when only an earlier version was signed (AC-33). A card is what a
   * page shows and what a run reads, so the state is derived here, once.
   * @param {string} studyId
   */
  async assumptions(studyId) {
    const [rows, reviews] = await Promise.all([this.rows(`SELECT DISTINCT ON (key) * FROM ${VCR_SCHEMA}.assumptions
      WHERE study_id = $1 AND NOT after_freeze ORDER BY key, version DESC`, [studyId]), this.reviews(studyId)]);
    return rows.map((row) => this.#assumptionWithReview(assumptionFromRow(row), reviews));
  }

  /** Every version of one key, newest first — the ones written after the plan froze included, each marked. @param {string} studyId @param {string} key */
  async assumptionVersions(studyId, key) {
    const [rows, reviews] = await Promise.all([this.rows(`SELECT * FROM ${VCR_SCHEMA}.assumptions WHERE study_id = $1 AND key = $2
      ORDER BY version DESC LIMIT 100`, [studyId, String(key)]), this.reviews(studyId)]);
    return rows.map((row) => this.#assumptionWithReview(assumptionFromRow(row), reviews));
  }

  /** @param {any} card @param {any[]} reviews */
  #assumptionWithReview(card, reviews) {
    if (!card || !reviews.length) return card;
    let node;
    try { node = lineageNode("assumption", card.key, card.version); } catch { return card; }
    return withReviewState(card, node, reviews);
  }

  // --- research objects -------------------------------------------------------------

  /** @param {Record<string, any>} input */
  async savePopulation(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "populations", "study_id = $1", [input.studyId]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.populations
        (id, study_id, user_id, version, name, kind, definition, snapshot_id, counts, waterfall, profile, quality, allowed_uses, review_state)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::text[], $14) RETURNING *`,
      [vcrId("population"), input.studyId, String(input.userId), version, String(input.name ?? ""), String(input.kind ?? "scenario"),
        JSON.stringify(input.definition ?? {}), input.snapshotId ?? null, JSON.stringify(input.counts ?? {}),
        JSON.stringify(input.waterfall ?? []), JSON.stringify(input.profile ?? {}), JSON.stringify(input.quality ?? {}),
        list(input.allowedUses).map(String), input.reviewState ?? "ai_set"])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.population.save",
        object: String(row.id), detail: { version, kind: String(input.kind ?? "scenario") } });
      return populationFromRow(row);
    });
  }

  /** @param {string} studyId */
  async latestPopulation(studyId) {
    return populationFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.populations WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]));
  }

  /** @param {string} studyId @param {number} [limit] */
  async populations(studyId, limit = 50) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.populations WHERE study_id = $1 ORDER BY version DESC LIMIT $2`, [studyId, limit]))
      .map(populationFromRow);
  }

  /** @param {Record<string, any>} input */
  async savePatientSet(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "patient_sets", "study_id = $1", [input.studyId]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.patient_sets
        (id, study_id, population_id, user_id, version, name, model_id, model_version, scenario, counts, twin_label)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11) RETURNING *`,
      [vcrId("patientSet"), input.studyId, input.populationId ?? null, String(input.userId), version, String(input.name ?? ""),
        input.modelId ?? null, input.modelVersion ?? null, JSON.stringify(input.scenario ?? {}), JSON.stringify(input.counts ?? {}),
        input.twinLabel ?? null])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.patient_set.save",
        object: String(row.id), detail: { version } });
      return patientSetFromRow(row);
    });
  }

  /** @param {string} studyId */
  async latestPatientSet(studyId) {
    return patientSetFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.patient_sets WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]));
  }

  /** @param {string} studyId @param {number} [limit] */
  async patientSets(studyId, limit = 50) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.patient_sets WHERE study_id = $1 ORDER BY version DESC LIMIT $2`, [studyId, limit]))
      .map(patientSetFromRow);
  }

  /** @param {Record<string, any>} input */
  async saveComparatorDesign(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "comparator_designs", "study_id = $1", [input.studyId]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.comparator_designs
        (id, study_id, user_id, version, route, estimand, target_trial, configuration, conclusion, gap_list, review_state)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11) RETURNING *`,
      [vcrId("comparator"), input.studyId, String(input.userId), version, String(input.route), String(input.estimand ?? "ATT"),
        JSON.stringify(input.targetTrial ?? {}), JSON.stringify(input.configuration ?? {}), input.conclusion ?? null,
        JSON.stringify(input.gapList ?? []), input.reviewState ?? "ai_set"])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.comparator.save",
        object: String(row.id), detail: { version, route: String(input.route) } });
      return comparatorFromRow(row);
    });
  }

  /** @param {string} studyId */
  async latestComparatorDesign(studyId) {
    return comparatorFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.comparator_designs WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]));
  }

  /** @param {string} studyId @param {number} [limit] */
  async comparatorDesigns(studyId, limit = 50) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.comparator_designs WHERE study_id = $1 ORDER BY version DESC LIMIT $2`, [studyId, limit]))
      .map(comparatorFromRow);
  }

  /** @param {Record<string, any>} input */
  async saveTrialScenario(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "trial_scenarios", "study_id = $1", [input.studyId]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.trial_scenarios
        (id, study_id, user_id, version, label, design, endpoint_type, configuration, assumption_ids, comparator_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10) RETURNING *`,
      [vcrId("scenario"), input.studyId, String(input.userId), version, String(input.label ?? ""), String(input.design),
        String(input.endpointType), JSON.stringify(input.configuration ?? {}), list(input.assumptionIds).map(String),
        input.comparatorId ?? null])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.trial_scenario.save",
        object: String(row.id), detail: { version, design: String(input.design) } });
      return scenarioFromRow(row);
    });
  }

  /** @param {string} studyId @param {number} [limit] */
  async trialScenarios(studyId, limit = 60) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.trial_scenarios WHERE study_id = $1 ORDER BY version DESC, label LIMIT $2`,
      [studyId, limit])).map(scenarioFromRow);
  }

  /** @param {Record<string, any>} input */
  async saveDesignGrid(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "design_grids", "study_id = $1", [input.studyId]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.design_grids
        (id, study_id, user_id, version, dimensions, truth_scenarios, comparison_goal, cells)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) RETURNING *`,
      [vcrId("grid"), input.studyId, String(input.userId), version, JSON.stringify(input.dimensions ?? {}),
        JSON.stringify(input.truthScenarios ?? []), input.comparisonGoal == null ? null : JSON.stringify(input.comparisonGoal),
        JSON.stringify(input.cells ?? [])])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.design_grid.save",
        object: String(row.id), detail: { version } });
      return { id: String(row.id), studyId: String(row.study_id), version: Number(row.version), dimensions: object(row.dimensions),
        truthScenarios: list(row.truth_scenarios), comparisonGoal: row.comparison_goal == null ? null : object(row.comparison_goal),
        cells: list(row.cells), createdAt: iso(row.created_at) };
    });
  }

  /** @param {string} studyId */
  async latestDesignGrid(studyId) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.design_grids WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]);
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), version: Number(row.version), dimensions: object(row.dimensions),
      truthScenarios: list(row.truth_scenarios), comparisonGoal: row.comparison_goal == null ? null : object(row.comparison_goal),
      cells: list(row.cells), createdAt: iso(row.created_at) };
  }

  /**
   * The computed cells of a design grid, filled from the engine's own result:
   * a run may write a grid's dimensions and truth scenarios, never the numbers
   * in its cells.
   * @param {string} id @param {readonly unknown[]} cells
   */
  async attachGridCells(id, cells) {
    return this.one(`UPDATE ${VCR_SCHEMA}.design_grids SET cells = $2::jsonb WHERE id = $1 RETURNING id`, [id, JSON.stringify(list(cells))]);
  }

  /**
   * Point a research object at the result it produced. The only in-place
   * update on these rows, and the one the orchestrator reads a step's
   * completion from.
   * @param {string} table @param {string} id @param {string} resultId @param {{ conclusion?: string | null, gapList?: unknown[] }} [extra]
   */
  async attachResult(table, id, resultId, extra = {}) {
    if (!["populations", "patient_sets", "comparator_designs", "trial_scenarios"].includes(table)) {
      throw new TypeError(`attachResult: ${JSON.stringify(table)} does not carry a result`);
    }
    const sets = ["result_id = $2"];
    /** @type {unknown[]} */
    const values = [id, resultId];
    if (table === "comparator_designs" && extra.conclusion !== undefined) {
      values.push(extra.conclusion);
      sets.push(`conclusion = $${values.length}`);
    }
    if (table === "comparator_designs" && extra.gapList !== undefined) {
      values.push(JSON.stringify(extra.gapList));
      sets.push(`gap_list = $${values.length}::jsonb`);
    }
    return this.one(`UPDATE ${VCR_SCHEMA}.${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, values);
  }

  // --- executions and results --------------------------------------------------------

  /**
   * What a finished job actually ran. Immutable: this is what AC-04
   * reproduces from, so its inputs and environment are copied, never
   * referenced. `client` is the caller's transaction when the execution has to
   * commit or roll back together with the result and the job row.
   * @param {Record<string, any>} input @param {{ client?: any }} [options]
   */
  async recordExecution(input, { client = null } = {}) {
    const sql = `INSERT INTO ${VCR_SCHEMA}.executions
      (id, job_id, study_id, user_id, method, method_version, scenario_hash, inputs, environment, seed, replicates, output_hash, receipt,
       cpu_seconds, started_at, finished_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16) RETURNING *`;
    const values = [vcrId("execution"), String(input.jobId), String(input.studyId), String(input.userId), String(input.method),
      String(input.methodVersion ?? ""), String(input.scenarioHash ?? ""), JSON.stringify(input.inputs ?? []),
      JSON.stringify(input.environment ?? {}), Number(input.seed ?? 0), input.replicates ?? null, input.outputHash ?? null,
      JSON.stringify(input.receipt ?? {}), input.cpuSeconds ?? null, input.startedAt ?? null, input.finishedAt ?? null];
    const row = client ? (await client.query(sql, values)).rows[0] : await this.one(sql, values);
    return row ? { id: String(row.id), jobId: String(row.job_id), studyId: String(row.study_id), method: String(row.method),
      methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""), inputs: list(row.inputs),
      environment: object(row.environment), seed: Number(row.seed ?? 0), replicates: num(row.replicates),
      outputHash: text(row.output_hash), receipt: object(row.receipt), cpuSeconds: num(row.cpu_seconds),
      startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), createdAt: iso(row.created_at) } : null;
  }

  /**
   * Register a result. Supersedes the previous result of the same kind and
   * subject rather than replacing it, and derives the intended use the result
   * may claim from the models it used (plan §8.2, AC-34) — never withholding
   * it, only labelling it down with the reason.
   *
   * What a result used is the caller's to say and never the engine's: `tiers`
   * are the credibility tiers the method itself carries (the domain's table)
   * and `models` are the model rows the job named (a patient set's model, read
   * from the library). An engine that described its own model could lift its own
   * result's ceiling, which is why `recordResult` reads neither from a result.
   *
   * @param {{ studyId: string, userId: string, kind: string, subjectId?: string | null, executionId?: string | null,
   *   conclusion?: string | null, notEstimableRule?: string | null, counts?: Record<string, any>, measures?: unknown[],
   *   diagnostics?: Record<string, any>, tables?: unknown[], tiers?: string[],
   *   models?: Array<{ tier?: string, risk?: string, evidence?: string[], name?: string }>,
   *   supersedesSubjects?: string[], requestedUse?: string }} input
   *   `supersedesSubjects` are earlier versions of the same object — a new version of a labelled trial
   *   scenario is a new row with its own id, and the result of the version it replaces is no longer current.
   * @param {{ client?: any }} [options] the caller's transaction, when the result has to land with other rows
   */
  async recordResult(input, { client: outer = null } = {}) {
    const models = list(input.models);
    const tiers = [...list(input.tiers).map(String), ...models.map((model) => String(model?.tier ?? "scenario"))];
    const requested = VCR_INTENDED_USES.includes(String(input.requestedUse)) ? String(input.requestedUse) : "exploratory";
    const detail = intendedUseCeilingDetail({ tiers: list(input.tiers).map(String), models });
    /** @type {Array<{ model: string, risk: string, missing: readonly string[] }>} */
    const shortfalls = [];
    for (const model of models) {
      const missing = missingModelEvidence(String(model?.risk ?? "none"), list(model?.evidence).map(String));
      if (missing.length) shortfalls.push({ model: String(model?.name ?? "model"), risk: String(model?.risk ?? "none"), missing });
    }
    // The ceiling is the domain's: each model's own is the lowest of its tier's,
    // its declared risk's and what its held evidence supports, and the weakest
    // decides (`intendedUseCeilingFor`). A model short of its evidence is
    // reported by name, whichever of the three set the limit.
    const ceiling = detail.ceiling;
    const intendedUse = useWithin(requested, ceiling) ? requested : ceiling;
    const evidenceLimited = detail.limitedBy.some((entry) => entry.cause === "evidence");
    const downgrade = intendedUse === requested ? null : {
      requested, ceiling, reason: evidenceLimited || shortfalls.length ? "model_evidence_missing" : "model_tier_ceiling",
      models: [...list(input.tiers).map((tier) => ({ name: "method", tier: String(tier), risk: "none" })),
        ...models.map((model) => ({ name: String(model?.name ?? "model"), tier: String(model?.tier ?? "scenario"), risk: String(model?.risk ?? "none") }))],
      missingEvidence: shortfalls,
    };
    /** @param {any} client */
    const write = async (client) => {
      const version = await this.nextVersion(client, "results", "study_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3",
        [input.studyId, input.kind, input.subjectId ?? null]);
      const id = vcrId("result");
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.results
        (id, study_id, execution_id, user_id, kind, subject_id, version, conclusion, not_estimable_rule, counts, measures, diagnostics,
         tables, intended_use, use_downgrade)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb) RETURNING *`,
      [id, input.studyId, input.executionId ?? null, String(input.userId), String(input.kind), input.subjectId ?? null, version,
        input.conclusion ?? null, input.notEstimableRule ?? null, JSON.stringify(input.counts ?? {}),
        JSON.stringify(input.measures ?? []),
        // The models a result used travel with it whether or not they lowered
        // its use: a page that read the tiers only off a downgrade would read
        // a result that needed no downgrade as having used no model at all.
        JSON.stringify({ ...object(input.diagnostics), ...(tiers.length ? { modelsUsed: [
          ...list(input.tiers).map((tier) => ({ name: "method", tier: String(tier), risk: "none" })), ...models] } : {}) }),
        JSON.stringify(input.tables ?? []),
        intendedUse, downgrade == null ? null : JSON.stringify(downgrade)])).rows[0];
      await client.query(`UPDATE ${VCR_SCHEMA}.results SET superseded_by = $1
        WHERE study_id = $2 AND kind = $3 AND id <> $1 AND superseded_by IS NULL
          AND (subject_id IS NOT DISTINCT FROM $4 OR subject_id = ANY($5::text[]))`,
      [id, input.studyId, String(input.kind), input.subjectId ?? null, list(input.supersedesSubjects).map(String)]);
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.result.record", object: id,
        detail: { kind: String(input.kind), version, conclusion: input.conclusion ?? null, intendedUse, downgraded: Boolean(downgrade) } });
      return resultFromRow(row);
    };
    return outer ? write(outer) : this.transaction(write);
  }

  /**
   * The current (not superseded) result of one kind and subject, or null: what
   * a later stage of the same object folds its own measures into.
   * @param {string} studyId @param {string} kind @param {string | null} subjectId
   */
  async currentResultOf(studyId, kind, subjectId) {
    return resultFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.results
      WHERE study_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3 AND superseded_by IS NULL
      ORDER BY version DESC LIMIT 1`, [studyId, kind, subjectId ?? null]));
  }

  /**
   * The lineage nodes of every result of one kind and subject — the current one
   * and every one it superseded — so a recomputation can clear the stale marks
   * of the results its successor replaced (plan §6.3).
   * @param {string} studyId @param {string} kind @param {string | null} subjectId
   * @returns {Promise<string[]>}
   */
  async resultNodesOf(studyId, kind, subjectId) {
    const rows = await this.rows(`SELECT id, version FROM ${VCR_SCHEMA}.results
      WHERE study_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3`, [studyId, kind, subjectId ?? null]);
    return rows.map((row) => lineageNode("result", String(row.id), Number(row.version)));
  }

  /**
   * The result one job produced, found through the execution it wrote — a
   * finished job's, a failed one's partial one, and the partial result of a
   * cancelled job that the engine kept and the queue fetched afterwards. Never
   * 「the newest result of this study」, which would hand a job somebody else's
   * numbers under its own id.
   * @param {string} studyId @param {string} jobId
   */
  async resultOfJob(studyId, jobId) {
    return resultFromRow(await this.one(`SELECT r.* FROM ${VCR_SCHEMA}.results r JOIN ${VCR_SCHEMA}.executions e ON e.id = r.execution_id
      WHERE r.study_id = $1 AND e.job_id = $2 ORDER BY r.created_at DESC, r.version DESC LIMIT 1`, [studyId, jobId]));
  }

  /** @param {string} studyId @param {string} id */
  async result(studyId, id) {
    return resultFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.results WHERE study_id = $1 AND id = $2`, [studyId, id]));
  }

  /** Current results (nothing superseded), newest first. @param {string} studyId @param {string | null} [kind] */
  async results(studyId, kind = null) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.results
      WHERE study_id = $1 AND superseded_by IS NULL AND ($2::text IS NULL OR kind = $2) AND kind <> $3
      ORDER BY created_at DESC LIMIT 200`, [studyId, kind, VCR_COMPARISON_RESULT_KIND]);
    return rows.map(resultFromRow);
  }

  /** Every result of a study including superseded ones (the package's history). @param {string} studyId */
  async allResults(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.results WHERE study_id = $1 AND kind <> $2 ORDER BY created_at DESC LIMIT 500`,
      [studyId, VCR_COMPARISON_RESULT_KIND])).map(resultFromRow);
  }

  // --- forecasts (AC-23) ---------------------------------------------------------------

  /**
   * A prediction registered before the outcome it predicts. The hash is over
   * the prediction **and the instant it was registered**, and a change is a new
   * version — never an edit, or the timestamp would prove nothing: the same
   * numbers registered a month later are a different claim and hash differently.
   * @param {{ studyId: string, userId: string, kind: string, prediction: Record<string, any>, public?: boolean, at?: Date }} input
   */
  async registerForecast(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "forecasts", "study_id = $1 AND kind = $2", [input.studyId, String(input.kind)]);
      const createdAt = (input.at ?? new Date()).toISOString();
      const payloadHash = vcrHash({ studyId: input.studyId, kind: String(input.kind), version, prediction: input.prediction ?? {}, createdAt });
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.forecasts (id, study_id, user_id, kind, version, prediction, payload_hash, public, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz) RETURNING *`,
      [vcrId("forecast"), input.studyId, String(input.userId), String(input.kind), version, JSON.stringify(input.prediction ?? {}),
        payloadHash, input.public === true, createdAt])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.forecast.register",
        object: String(row.id), detail: { kind: String(input.kind), version, payloadHash, createdAt } });
      return this.#forecastFromRow(row);
    });
  }

  /** @param {any} row */
  #forecastFromRow(row) {
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), kind: String(row.kind), version: Number(row.version),
      prediction: object(row.prediction), payloadHash: String(row.payload_hash ?? ""), public: row.public === true,
      actual: row.actual == null ? null : object(row.actual), comparedAt: iso(row.compared_at), createdAt: iso(row.created_at) };
  }

  /** The actual, compared against the registered prediction. @param {string} forecastId @param {Record<string, any>} actual */
  async compareForecast(forecastId, actual) {
    return this.#forecastFromRow(await this.one(`UPDATE ${VCR_SCHEMA}.forecasts SET actual = $2::jsonb, compared_at = now()
      WHERE id = $1 RETURNING *`, [forecastId, JSON.stringify(actual ?? {})]));
  }

  /** @param {string} studyId */
  async forecasts(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.forecasts WHERE study_id = $1 ORDER BY created_at DESC LIMIT 100`, [studyId]))
      .map((row) => this.#forecastFromRow(row));
  }

  // --- lineage and staleness (plan §6.3) --------------------------------------------------

  /**
   * Lineage edges. Written with the object that depends on them, so an edge
   * never points at a version that does not exist yet.
   * @param {string} studyId @param {readonly { from: string, to: string, cost?: string }[]} edges
   */
  async addEdges(studyId, edges) {
    const rows = list(edges).filter((edge) => edge?.from && edge?.to);
    if (!rows.length) return 0;
    let written = 0;
    for (const edge of rows) {
      const result = await this.query(`INSERT INTO ${VCR_SCHEMA}.dependencies (study_id, from_node, to_node, cost)
        VALUES ($1, $2, $3, $4) ON CONFLICT (study_id, from_node, to_node) DO NOTHING`,
      [studyId, String(edge.from), String(edge.to), edge.cost === "heavy" ? "heavy" : "light"]);
      written += result?.rowCount ?? 0;
    }
    return written;
  }

  /** @param {string} studyId @returns {Promise<Array<{ from: string, to: string, cost: "light" | "heavy" }>>} */
  async edges(studyId) {
    const rows = await this.rows(`SELECT from_node, to_node, cost FROM ${VCR_SCHEMA}.dependencies WHERE study_id = $1 LIMIT 20000`, [studyId]);
    return rows.map((row) => ({
      from: String(row.from_node), to: String(row.to_node),
      cost: /** @type {"light" | "heavy"} */ (row.cost === "heavy" ? "heavy" : "light"),
    }));
  }

  /**
   * Mark nodes stale. Never deletes or hides a result (plan §6.3): the mark
   * carries the reason, and the result keeps its numbers and its page.
   * @param {string} studyId @param {readonly string[]} nodes @param {string} reason @param {Record<string, any>} [detail]
   */
  async markStale(studyId, nodes, reason, detail = {}) {
    if (!VCR_STALE_REASONS.includes(reason)) throw new TypeError(`markStale: unknown reason ${JSON.stringify(reason)}`);
    let marked = 0;
    for (const node of list(nodes).map(String)) {
      const result = await this.query(`INSERT INTO ${VCR_SCHEMA}.stale_marks (study_id, node, reason, detail)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (study_id, node) DO UPDATE SET reason = EXCLUDED.reason, detail = stale_marks.detail || EXCLUDED.detail,
          marked_at = now(), cleared_at = NULL`, [studyId, node, reason, JSON.stringify(detail)]);
      marked += result?.rowCount ?? 0;
    }
    return marked;
  }

  /** @param {string} studyId @param {string} node @param {string | null} jobId */
  async noteRecomputeJob(studyId, node, jobId) {
    return this.query(`UPDATE ${VCR_SCHEMA}.stale_marks SET queued_job_id = $3 WHERE study_id = $1 AND node = $2`, [studyId, node, jobId]);
  }

  /** @param {string} studyId @param {readonly string[]} nodes */
  async clearStale(studyId, nodes) {
    return this.query(`UPDATE ${VCR_SCHEMA}.stale_marks SET cleared_at = now()
      WHERE study_id = $1 AND node = ANY($2::text[]) AND cleared_at IS NULL`, [studyId, list(nodes).map(String)]);
  }

  /** Open stale marks. @param {string} studyId */
  async staleMarks(studyId) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.stale_marks WHERE study_id = $1 AND cleared_at IS NULL
      ORDER BY marked_at DESC LIMIT 500`, [studyId]);
    return rows.map((row) => ({ node: String(row.node), reason: String(row.reason), detail: object(row.detail),
      queuedJobId: text(row.queued_job_id), markedAt: iso(row.marked_at) }));
  }

  // --- reviews, decisions, exports ---------------------------------------------------------

  /**
   * A countersignature on named version nodes. Never a gate (plan §10.2): it
   * changes what the cover of a package says, not whether it may be exported.
   * @param {{ studyId: string, userId: string, kind: string, nodes: readonly string[], reviewer: string,
   *   note?: string, changes?: unknown[] }} input
   */
  async addReview(input) {
    if (!VCR_REVIEW_KINDS.includes(String(input.kind))) throw new TypeError(`addReview: unknown kind ${JSON.stringify(input.kind)}`);
    return this.transaction(async (client) => {
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.reviews (id, study_id, user_id, kind, nodes, state, reviewer, note, changes)
        VALUES ($1, $2, $3, $4, $5::text[], 'reviewed', $6, $7, $8::jsonb) RETURNING *`,
      [vcrId("review"), input.studyId, String(input.userId), String(input.kind), list(input.nodes).map(String),
        String(input.reviewer), String(input.note ?? ""), JSON.stringify(input.changes ?? [])])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), actor: String(input.reviewer),
        action: "vcr.review.add", object: String(row.id), detail: { kind: String(input.kind), nodes: list(input.nodes).length } });
      return this.#reviewFromRow(row);
    });
  }

  /** Trusted review worker only. Public human review routes cannot set provenance.
   * @param {any} record @param {{client?:any}} [options] */
  async saveAiReview(record, { client = null } = {}) {
    if (!['clinical', 'statistical'].includes(record.role) || !record.reviewId || !record.nodes?.length) throw new TypeError('Invalid trusted AI review.');
    const write = async handle => {
      const study = (await handle.query('SELECT user_id FROM evimed_vcr.studies WHERE id=$1 AND deleted_at IS NULL', [record.studyId])).rows[0];
      if (!study) return null;
      const provenance = { subjectRef: record.subjectRef, platformReviewId: record.reviewId, inputDigest: record.inputDigest, configuration: record.configuration,
        configurationDigest: record.configurationDigest, model: record.model, usage: record.usage, usageKnown: Object.keys(record.usage ?? {}).length > 0, cost: record.cost,
        error: record.error, deterministic: record.deterministic, findings: record.findings, finishedAt: record.finishedAt };
      const row = (await handle.query(`INSERT INTO evimed_vcr.reviews(id,study_id,user_id,kind,nodes,state,reviewer,reviewer_kind,status,platform_review_id,provenance)
        VALUES ($1,$2,$3,$4,$5::text[],'ai_set','','ai',$6,$1,$7::jsonb)
        ON CONFLICT(platform_review_id) WHERE platform_review_id IS NOT NULL DO UPDATE SET status=excluded.status,provenance=excluded.provenance
        RETURNING *`, [record.reviewId, record.studyId, study.user_id, record.role, record.nodes, record.status, JSON.stringify(provenance)])).rows[0];
      await this.audit({ client: handle, studyId: record.studyId, userId: study.user_id, actor: 'ai-review-service', action: 'vcr.review.ai', object: record.reviewId,
        detail: { role: record.role, status: record.status, model: record.model, inputDigest: record.inputDigest, nodes: record.nodes.length } });
      return this.#reviewFromRow(row);
    };
    return client ? write(client) : this.transaction(write);
  }

  /** @param {any} row */
  #reviewFromRow(row) {
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), kind: String(row.kind), nodes: list(row.nodes).map(String),
      state: String(row.state), reviewer: String(row.reviewer), note: String(row.note ?? ""), changes: list(row.changes),
      reviewerName: text(row.reviewer_name), reviewerKind: String(row.reviewer_kind ?? 'human'), status: String(row.status ?? 'done'),
      platformReviewId: text(row.platform_review_id), provenance: object(row.provenance),
      createdAt: iso(row.created_at) };
  }

  /** @param {string} studyId */
  async reviews(studyId) {
    return (await this.rows(`SELECT r.*,u.name AS reviewer_name FROM ${VCR_SCHEMA}.reviews r LEFT JOIN evimed_control.users u ON r.reviewer_kind='human' AND u.id=r.reviewer WHERE r.study_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [studyId]))
      .map((row) => this.#reviewFromRow(row));
  }

  /** @param {{ studyId: string, userId: string, question: string, chosen?: Record<string, any>, alternatives?: unknown[],
   *   rationale?: string, decidedBy?: string }} input */
  async addDecision(input) {
    return this.transaction(async (client) => {
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.decisions (id, study_id, user_id, question, chosen, alternatives, rationale, decided_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING *`,
      [vcrId("decision"), input.studyId, String(input.userId), String(input.question), JSON.stringify(input.chosen ?? {}),
        JSON.stringify(input.alternatives ?? []), String(input.rationale ?? ""), String(input.decidedBy ?? "")])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.decision.add", object: String(row.id) });
      return this.#decisionFromRow(row);
    });
  }

  /** @param {any} row */
  #decisionFromRow(row) {
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), question: String(row.question), chosen: object(row.chosen),
      alternatives: list(row.alternatives), rationale: String(row.rationale ?? ""), decidedBy: String(row.decided_by ?? ""),
      createdAt: iso(row.created_at) };
  }

  /** @param {string} studyId */
  async decisions(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.decisions WHERE study_id = $1 ORDER BY created_at DESC LIMIT 200`, [studyId]))
      .map((row) => this.#decisionFromRow(row));
  }

  // --- model assessments and frozen model analysis plans (ICH M15) ---------------------------

  /**
   * One assessment record, one version: an edit is the next version under the
   * same key, so a frozen plan's copy of the record never moves. The record is
   * stored as the domain normalizes it — ratings outside the three words are
   * dropped to empty, the model risk is derived from the two ratings — and the
   * caller's own `risk` is not read.
   * @param {{ studyId: string, userId: string, actor?: string, record: Record<string, any> }} input
   */
  async saveModelAssessment(input) {
    const record = normalizeVcrAssessment(input.record);
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "model_assessments", "study_id = $1 AND key = $2", [input.studyId, record.key]);
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.model_assessments
        (id, study_id, user_id, key, version, model_name, model_version, risk, record, saved_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
      [vcrId("modelAssessment"), input.studyId, String(input.userId), record.key, version, record.modelName, record.modelVersion,
        record.risk, JSON.stringify(record), String(input.actor ?? "")])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), actor: String(input.actor ?? ""),
        action: "vcr.model_assessment.save", object: String(row.id), detail: { key: record.key, version, risk: record.risk } });
      return modelAssessmentFromRow(row);
    });
  }

  /** The current version of every assessment key. @param {string} studyId */
  async modelAssessments(studyId) {
    return (await this.rows(`SELECT DISTINCT ON (key) * FROM ${VCR_SCHEMA}.model_assessments
      WHERE study_id = $1 ORDER BY key, version DESC`, [studyId])).map((row) => modelAssessmentFromRow(row));
  }

  /**
   * Freeze a model analysis plan: the next version when its content differs
   * from the latest frozen one, nothing when it does not. Under the study row's
   * lock, so two freezes arriving together make one version; the previous
   * content is read inside it so `diff` says exactly what changed against the
   * version this one follows.
   * @param {{ studyId: string, userId: string, content: Record<string, any>, contentHash: string, frozenAt: string, frozenBy: string,
   *   sealPlanVersion?: number, sealPlanHash?: string, outcomeFirstReadAt?: string | null, issues?: unknown[],
   *   diff: (previous: Record<string, any>) => unknown[] }} input
   * @returns {Promise<{ created: boolean, plan: NonNullable<ReturnType<typeof modelPlanVersionFromRow>> }>}
   */
  async freezeModelPlanVersion(input) {
    return this.transaction(async (client) => {
      await client.query(`SELECT 1 FROM ${VCR_SCHEMA}.studies WHERE id = $1 FOR UPDATE`, [input.studyId]);
      const latest = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.model_plan_versions WHERE study_id = $1
        ORDER BY version DESC LIMIT 1`, [input.studyId])).rows[0];
      if (latest && String(latest.content_hash) === input.contentHash) {
        return { created: false, plan: /** @type {any} */ (modelPlanVersionFromRow(latest)) };
      }
      const version = Number(latest?.version ?? 0) + 1;
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.model_plan_versions
        (id, study_id, user_id, version, content, content_hash, seal_plan_version, seal_plan_hash, frozen_at, frozen_by,
         outcome_first_read_at, changes, issues)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb) RETURNING *`,
      [vcrId("modelPlan"), input.studyId, String(input.userId), version, JSON.stringify(input.content), input.contentHash,
        Number(input.sealPlanVersion ?? 0), String(input.sealPlanHash ?? ""), input.frozenAt, String(input.frozenBy ?? ""),
        input.outcomeFirstReadAt ?? null, JSON.stringify(latest ? input.diff(object(latest.content)) : []),
        JSON.stringify(input.issues ?? [])])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), actor: String(input.frozenBy ?? ""),
        action: "vcr.model_plan.freeze", object: String(row.id), detail: { version, contentHash: input.contentHash } });
      return { created: true, plan: /** @type {any} */ (modelPlanVersionFromRow(row)) };
    });
  }

  /** Every frozen version of the study's model analysis plan, newest first. @param {string} studyId */
  async modelPlanVersions(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.model_plan_versions WHERE study_id = $1
      ORDER BY version DESC LIMIT 50`, [studyId])).map((row) => modelPlanVersionFromRow(row));
  }

  /** @param {{ studyId: string, userId: string, kind: string, cover?: Record<string, any> }} input
   * @param {{client?:any}} [options] */
  async createExport(input, { client = null } = {}) {
    if (!VCR_EXPORT_KINDS.includes(String(input.kind))) throw new TypeError(`createExport: unknown kind ${JSON.stringify(input.kind)}`);
    const write = async (handle) => {
      const row = (await handle.query(`INSERT INTO ${VCR_SCHEMA}.exports (id, study_id, user_id, kind, cover)
        VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [vcrId("export"), input.studyId, String(input.userId), String(input.kind), JSON.stringify(input.cover ?? {})])).rows[0];
      await this.audit({ client: handle, studyId: input.studyId, userId: String(input.userId), action: "vcr.export.create",
        object: String(row.id), detail: { kind: String(input.kind) } });
      return this.#exportFromRow(row);
    };
    return client ? write(client) : this.transaction(write);
  }

  /** @param {any} row */
  #exportFromRow(row) {
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), kind: String(row.kind), state: String(row.state),
      runId: text(row.run_id), location: text(row.location), sha256: text(row.sha256), cover: object(row.cover),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  /** @param {string} studyId @param {string} id */
  async exportRow(studyId, id) {
    return this.#exportFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.exports WHERE study_id = $1 AND id = $2`, [studyId, id]));
  }

  /** @param {string} studyId */
  async exports(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.exports WHERE study_id = $1 ORDER BY created_at DESC LIMIT 50`, [studyId]))
      .map((row) => this.#exportFromRow(row));
  }

  /** Pending conversions are not hidden behind the recent-export page limit.
   * @param {string} studyId */
  async pendingReviewExports(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.exports WHERE study_id=$1
      AND cover->'reviewDocumentRefresh'->>'state'='pending' ORDER BY created_at ASC LIMIT 50`, [studyId]))
      .map(row => this.#exportFromRow(row));
  }

  /** Preserve concurrent sections; trusted refreshes may recheck proof on this transaction's connection.
   * @param {string} id @param {(cover:any,snapshot:VcrStore)=>any|Promise<any>} update */
  async updateExportCover(id, update) {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.exports WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) return null;
      const snapshot = new VcrStore({ database: this.database });
      snapshot.transaction = async read => read(client);
      const cover = await update(object(row.cover), snapshot);
      return this.#exportFromRow((await client.query(`UPDATE ${VCR_SCHEMA}.exports SET cover=$2::jsonb, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(cover)])).rows[0]);
    });
  }

  /** @param {string} id @param {{ state?: string, runId?: string | null, location?: string | null, sha256?: string | null, cover?: Record<string, any> }} patch */
  async updateExport(id, patch) {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [id];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.state !== undefined) put("state", String(patch.state));
    if (patch.runId !== undefined) put("run_id", patch.runId);
    if (patch.location !== undefined) put("location", patch.location);
    if (patch.sha256 !== undefined) put("sha256", patch.sha256);
    if (patch.cover !== undefined) put("cover", JSON.stringify(patch.cover), "::jsonb");
    if (!sets.length) return null;
    return this.#exportFromRow(await this.one(`UPDATE ${VCR_SCHEMA}.exports SET ${[...sets, "updated_at = now()"].join(", ")}
      WHERE id = $1 RETURNING *`, values));
  }

  // --- the shared model and method library (plan §8.2) ----------------------------------

  /** Models a study may use: the platform's and this account's. @param {string | null} userId */
  async models(userId = null) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.models
      WHERE retired_at IS NULL AND (user_id IS NULL OR user_id = $1) ORDER BY name, version DESC LIMIT 500`, [userId]);
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), version: String(row.version), tier: String(row.tier), risk: String(row.risk ?? "none"),
      endpointType: text(row.endpoint_type), card: object(row.card), applicability: object(row.applicability),
      validation: object(row.validation), evidence: list(row.evidence).map(String), studyId: text(row.study_id),
      createdAt: iso(row.created_at),
      // What the model's own evidence is short of, for its declared risk. The
      // page shows it beside the tier; nothing is blocked by it (§8.2).
      missingEvidence: missingModelEvidence(String(row.risk ?? "none"), list(row.evidence).map(String)),
      useCeiling: intendedUseCeiling([String(row.tier)]),
    }));
  }

  /**
   * One model row, in one of two scopes that never meet.
   *
   * **Platform rows** (no `userId`) are what the catalogue seeds, and only they
   * are upserted — the seed is the one writer of a platform model.
   * **User-owned rows** are insert-only within their owner: the same
   * `(owner, name, version)` again, or a name and version the platform already
   * holds, is `409 vcr_model_exists` and nothing is written or handed back.
   * Until 2026-09-29 the upsert was keyed on `(name, version)` alone, so any
   * account adopting a model called `reference-binary 1.0.0` rewrote the
   * platform's card and evidence for every reader (CS-3).
   *
   * **The evidence a user-owned row lists is a declaration, not a
   * certificate.** What certifies a model for its risk is
   * `missingModelEvidence` reading `evidence`, and a run — or any caller — that
   * could write that list could lift its own model's ceiling. So the list a
   * caller supplies is kept under `validation.declaredEvidence`, where a page
   * can show it as claimed, and `evidence` stays empty until something that
   * verified it writes it.
   * @param {Record<string, any>} input
   */
  async saveModel(input) {
    const owner = input.userId == null ? null : String(input.userId);
    const evidence = list(input.evidence).map(String);
    const validation = object(input.validation);
    const values = [vcrId("model"), owner, input.studyId ?? null, String(input.name), String(input.version), String(input.tier),
      String(input.risk ?? "none"), input.endpointType ?? null, JSON.stringify(input.card ?? {}),
      JSON.stringify(input.applicability ?? {}),
      JSON.stringify(owner === null ? validation : { ...validation, declaredEvidence: evidence }),
      owner === null ? evidence : []];
    const columns = `(id, user_id, study_id, name, version, tier, risk, endpoint_type, card, applicability, validation, evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::text[])`;
    let row;
    if (owner === null) {
      row = await this.one(`INSERT INTO ${VCR_SCHEMA}.models ${columns}
        ON CONFLICT ((COALESCE(user_id, '')), name, version) DO UPDATE SET card = EXCLUDED.card,
          applicability = EXCLUDED.applicability, validation = EXCLUDED.validation, evidence = EXCLUDED.evidence RETURNING *`, values);
    } else {
      const exists = () => new HttpError(409, "vcr_model_exists", "已经有同名同版本的模型：请换一个名字或版本号。");
      row = await this.transaction(async (client) => {
        const taken = await client.query(`SELECT 1 FROM ${VCR_SCHEMA}.models
          WHERE name = $1 AND version = $2 AND (user_id IS NULL OR user_id = $3)`, [values[3], values[4], owner]);
        if (taken.rowCount) throw exists();
        try {
          return (await client.query(`INSERT INTO ${VCR_SCHEMA}.models ${columns} RETURNING *`, values)).rows[0];
        } catch (error) {
          if (/** @type {any} */ (error)?.code === "23505") throw exists();
          throw error;
        }
      });
    }
    return row ? { id: String(row.id), name: String(row.name), version: String(row.version), tier: String(row.tier) } : null;
  }

  /** The method catalogue, as the engine publishes it. */
  async methods() {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.methods ORDER BY method, version DESC LIMIT 500`);
    return rows.map((row) => ({ id: String(row.id), method: String(row.method), version: String(row.version),
      endpoints: list(row.endpoints).map(String), assumptions: list(row.assumptions), numericTests: object(row.numeric_tests),
      crossChecks: list(row.cross_checks).map(String), releasedAt: iso(row.released_at) }));
  }

  /** @param {Record<string, any>} input */
  async saveMethod(input) {
    const row = await this.one(`INSERT INTO ${VCR_SCHEMA}.methods (id, method, version, endpoints, assumptions, numeric_tests, cross_checks, released_at)
      VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6::jsonb, $7::text[], $8)
      ON CONFLICT (method, version) DO UPDATE SET endpoints = EXCLUDED.endpoints,
        assumptions = CASE WHEN $9 THEN EXCLUDED.assumptions ELSE methods.assumptions END,
        numeric_tests = CASE WHEN $10 THEN EXCLUDED.numeric_tests ELSE methods.numeric_tests END,
        cross_checks = EXCLUDED.cross_checks RETURNING *`,
    [vcrId("method"), String(input.method), String(input.version), list(input.endpoints).map(String),
      JSON.stringify(input.assumptions ?? []), JSON.stringify(input.numericTests ?? {}), list(input.crossChecks).map(String),
      input.releasedAt ?? null, Object.hasOwn(input, 'assumptions'), Object.hasOwn(input, 'numericTests')]);
    return row ? { id: String(row.id), method: String(row.method), version: String(row.version) } : null;
  }

  // --- jobs, read-only here (vcrJobs.mjs owns the writes) ----------------------------------

  /** @param {string} studyId @param {number} [limit] */
  async jobs(studyId, limit = 50) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1 ORDER BY created_at DESC LIMIT $2`, [studyId, limit]))
      .map(jobSummaryFromRow);
  }

  /** @param {string} studyId @param {string} id */
  async job(studyId, id) {
    return jobSummaryFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1 AND id = $2`, [studyId, id]));
  }

  // --- the lineage node of a row ------------------------------------------------------------

  /**
   * The lineage node of one research object, so every package spells it the
   * same way.
   * @param {string} kind one of {@link VCR_OBJECT_NODE_KINDS}'s keys
   * @param {{ id: string, version: number }} row
   */
  static node(kind, row) {
    const nodeKind = /** @type {Record<string, string>} */ (VCR_OBJECT_NODE_KINDS)[kind] ?? kind;
    return lineageNode(nodeKind, String(row.id), Number(row.version));
  }
}

/** The lineage node of one research object (the free function form). @param {string} kind @param {{ id: string, version: number }} row */
export function vcrObjectNode(kind, row) {
  return VcrStore.node(kind, row);
}

/** Every study status a route may set. Re-exported so the routes need one import. */
export { VCR_STUDY_STATUSES };
