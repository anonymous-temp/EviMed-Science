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
  VCR_DATA_TIERS, VCR_EXPORT_KINDS, VCR_INTENDED_USES, VCR_REVIEW_KINDS, VCR_STALE_REASONS, VCR_STEPS,
  VCR_STEP_STATUSES, VCR_STUDY_STATUSES, intendedUseCeiling, lineageNode, missingModelEvidence, useWithin,
} from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

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

/** A study's step record, all seven present. @param {unknown} value */
export function normalizedVcrSteps(value) {
  const raw = object(value);
  /** @type {Record<string, { status: string, requested: boolean, runId: string | null, jobId: string | null, updatedAt: string | null, note: string | null }>} */
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
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

export { comparatorFromRow, criterionFromRow, jobSummaryFromRow, patientSetFromRow, populationFromRow, resultFromRow, scenarioFromRow };

/**
 * The study side of `evimed_vcr`. The data plane (A), the evidence side (C)
 * and the matching side (E) keep their own stores against the same schema, so
 * no package migrates a table another one reads.
 */
export class VcrStore extends VcrStoreBase {
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

  /** The study of a control-plane project, for the runtime gateway. @param {string} userId @param {string} projectId */
  async studyByControlProject(userId, projectId) {
    const row = await this.one(`SELECT s.* FROM ${VCR_SCHEMA}.studies s
      WHERE s.project_id = $1 AND s.deleted_at IS NULL
        AND (s.user_id = $2 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m WHERE m.study_id = s.id AND m.user_id = $2))`,
    [String(projectId), String(userId)]);
    return vcrStudyFromRow(row);
  }

  /** Every study the account may see, newest first. @param {string} userId */
  async listStudies(userId) {
    const rows = await this.rows(`SELECT s.* FROM ${VCR_SCHEMA}.studies s
      WHERE s.deleted_at IS NULL
        AND (s.user_id = $1 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m WHERE m.study_id = s.id AND m.user_id = $1))
      ORDER BY s.updated_at DESC LIMIT 500`, [String(userId)]);
    return rows.map(vcrStudyFromRow);
  }

  /** Every active study, for the orchestrator's tick. @param {number} limit */
  async activeStudies(limit = 200) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.studies
      WHERE deleted_at IS NULL AND status = 'active' ORDER BY updated_at ASC LIMIT $1`, [limit]);
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
    return this.transaction(async (client) => {
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.studies (id, user_id, project_id, name, question, data_tier, intended_use, budget)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
      [id, userId, String(input.projectId), String(input.name ?? VCR_DEFAULT_STUDY_NAME), String(input.question ?? ""),
        dataTier, intendedUse, JSON.stringify(input.budget ?? {})])).rows[0];
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
    for (const key of ["status", "requested", "runId", "jobId", "note"]) {
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
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "study_definitions", "study_id = $1", [input.studyId]);
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
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.assumptions
        (id, study_id, user_id, key, version, name, endpoint, unit, point_value, distribution, sensitivity, source_kind,
         value_source, pooling_method, pooling, evidence_ids, applicability, review_state, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16::text[], $17::jsonb, $18, $19)
        RETURNING *`,
      [vcrId("assumption"), input.studyId, String(input.userId), String(input.key), version, String(input.name ?? input.key),
        input.endpoint ?? null, input.unit ?? null, input.pointValue ?? null, JSON.stringify(input.distribution ?? {}),
        JSON.stringify(input.sensitivity ?? {}), String(input.sourceKind ?? "expert_set"), String(input.valueSource ?? "assumed"),
        input.poolingMethod ?? null, JSON.stringify(input.pooling ?? {}), list(input.evidenceIds).map(String),
        JSON.stringify(input.applicability ?? {}), input.reviewState ?? "ai_set", String(input.note ?? "")])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.assumption.save",
        object: String(row.id), detail: { key: String(input.key), version } });
      return assumptionFromRow(row);
    });
  }

  /** The current version of every assumption key. @param {string} studyId */
  async assumptions(studyId) {
    const rows = await this.rows(`SELECT DISTINCT ON (key) * FROM ${VCR_SCHEMA}.assumptions
      WHERE study_id = $1 ORDER BY key, version DESC`, [studyId]);
    return rows.map(assumptionFromRow);
  }

  /** Every version of one key, newest first. @param {string} studyId @param {string} key */
  async assumptionVersions(studyId, key) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.assumptions WHERE study_id = $1 AND key = $2
      ORDER BY version DESC LIMIT 100`, [studyId, String(key)]);
    return rows.map(assumptionFromRow);
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
   * referenced.
   * @param {Record<string, any>} input
   */
  async recordExecution(input) {
    const row = await this.one(`INSERT INTO ${VCR_SCHEMA}.executions
      (id, job_id, study_id, user_id, method, method_version, scenario_hash, inputs, environment, seed, replicates, output_hash, receipt,
       cpu_seconds, started_at, finished_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16) RETURNING *`,
    [vcrId("execution"), String(input.jobId), String(input.studyId), String(input.userId), String(input.method),
      String(input.methodVersion ?? ""), String(input.scenarioHash ?? ""), JSON.stringify(input.inputs ?? []),
      JSON.stringify(input.environment ?? {}), Number(input.seed ?? 0), input.replicates ?? null, input.outputHash ?? null,
      JSON.stringify(input.receipt ?? {}), input.cpuSeconds ?? null, input.startedAt ?? null, input.finishedAt ?? null]);
    return row ? { id: String(row.id), jobId: String(row.job_id), studyId: String(row.study_id), method: String(row.method),
      methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""), inputs: list(row.inputs),
      environment: object(row.environment), seed: Number(row.seed ?? 0), replicates: num(row.replicates),
      outputHash: text(row.output_hash), receipt: object(row.receipt), cpuSeconds: num(row.cpu_seconds),
      startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), createdAt: iso(row.created_at) } : null;
  }

  /**
   * Register a result. Supersedes the previous result of the same kind and
   * subject rather than replacing it, and derives the intended use the result
   * may claim from the model tiers it used (plan §8.2, AC-34) — never
   * withholding it, only labelling it down with the reason.
   *
   * @param {{ studyId: string, userId: string, kind: string, subjectId?: string | null, executionId?: string | null,
   *   conclusion?: string | null, notEstimableRule?: string | null, counts?: Record<string, any>, measures?: unknown[],
   *   diagnostics?: Record<string, any>, tables?: unknown[], models?: Array<{ tier?: string, risk?: string, evidence?: string[], name?: string }>,
   *   requestedUse?: string }} input
   */
  async recordResult(input) {
    const models = list(input.models);
    const ceiling = intendedUseCeiling(models.map((model) => String(model?.tier ?? "scenario")));
    const requested = VCR_INTENDED_USES.includes(String(input.requestedUse)) ? String(input.requestedUse) : "exploratory";
    /** @type {Array<{ model: string, risk: string, missing: readonly string[] }>} */
    const shortfalls = [];
    for (const model of models) {
      const missing = missingModelEvidence(String(model?.risk ?? "none"), list(model?.evidence).map(String));
      if (missing.length) shortfalls.push({ model: String(model?.name ?? "model"), risk: String(model?.risk ?? "none"), missing });
    }
    // A model whose own evidence is short of its risk cannot carry more than
    // the tier ceiling either: the two rules of §8.2 meet here, and the lower
    // of them decides.
    const evidenceCeiling = shortfalls.length ? VCR_INTENDED_USES[Math.max(0, VCR_INTENDED_USES.indexOf(ceiling) - 1)] : ceiling;
    const intendedUse = useWithin(requested, evidenceCeiling) ? requested : evidenceCeiling;
    const downgrade = intendedUse === requested ? null : {
      requested, ceiling: evidenceCeiling, reason: shortfalls.length ? "model_evidence_missing" : "model_tier_ceiling",
      models: models.map((model) => ({ name: String(model?.name ?? "model"), tier: String(model?.tier ?? "scenario"), risk: String(model?.risk ?? "none") })),
      missingEvidence: shortfalls,
    };
    return this.transaction(async (client) => {
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
        JSON.stringify({ ...object(input.diagnostics), ...(models.length ? { modelsUsed: models } : {}) }),
        JSON.stringify(input.tables ?? []),
        intendedUse, downgrade == null ? null : JSON.stringify(downgrade)])).rows[0];
      await client.query(`UPDATE ${VCR_SCHEMA}.results SET superseded_by = $1
        WHERE study_id = $2 AND kind = $3 AND subject_id IS NOT DISTINCT FROM $4 AND id <> $1 AND superseded_by IS NULL`,
      [id, input.studyId, String(input.kind), input.subjectId ?? null]);
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.result.record", object: id,
        detail: { kind: String(input.kind), version, conclusion: input.conclusion ?? null, intendedUse, downgraded: Boolean(downgrade) } });
      return resultFromRow(row);
    });
  }

  /** @param {string} studyId @param {string} id */
  async result(studyId, id) {
    return resultFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.results WHERE study_id = $1 AND id = $2`, [studyId, id]));
  }

  /** Current results (nothing superseded), newest first. @param {string} studyId @param {string | null} [kind] */
  async results(studyId, kind = null) {
    const rows = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.results
      WHERE study_id = $1 AND superseded_by IS NULL AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at DESC LIMIT 200`, [studyId, kind]);
    return rows.map(resultFromRow);
  }

  /** Every result of a study including superseded ones (the package's history). @param {string} studyId */
  async allResults(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.results WHERE study_id = $1 ORDER BY created_at DESC LIMIT 500`, [studyId]))
      .map(resultFromRow);
  }

  // --- forecasts (AC-23) ---------------------------------------------------------------

  /**
   * A prediction registered before the outcome it predicts. The hash is over
   * the prediction as it was at registration, and a change is a new version —
   * never an edit, or the timestamp would prove nothing.
   * @param {{ studyId: string, userId: string, kind: string, prediction: Record<string, any>, public?: boolean }} input
   */
  async registerForecast(input) {
    return this.transaction(async (client) => {
      const version = await this.nextVersion(client, "forecasts", "study_id = $1 AND kind = $2", [input.studyId, String(input.kind)]);
      const payloadHash = vcrHash({ studyId: input.studyId, kind: String(input.kind), version, prediction: input.prediction ?? {} });
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.forecasts (id, study_id, user_id, kind, version, prediction, payload_hash, public)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
      [vcrId("forecast"), input.studyId, String(input.userId), String(input.kind), version, JSON.stringify(input.prediction ?? {}),
        payloadHash, input.public === true])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.forecast.register",
        object: String(row.id), detail: { kind: String(input.kind), version, payloadHash } });
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

  /** @param {any} row */
  #reviewFromRow(row) {
    if (!row) return null;
    return { id: String(row.id), studyId: String(row.study_id), kind: String(row.kind), nodes: list(row.nodes).map(String),
      state: String(row.state), reviewer: String(row.reviewer), note: String(row.note ?? ""), changes: list(row.changes),
      createdAt: iso(row.created_at) };
  }

  /** @param {string} studyId */
  async reviews(studyId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.reviews WHERE study_id = $1 ORDER BY created_at DESC LIMIT 200`, [studyId]))
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

  /** @param {{ studyId: string, userId: string, kind: string, cover?: Record<string, any> }} input */
  async createExport(input) {
    if (!VCR_EXPORT_KINDS.includes(String(input.kind))) throw new TypeError(`createExport: unknown kind ${JSON.stringify(input.kind)}`);
    return this.transaction(async (client) => {
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.exports (id, study_id, user_id, kind, cover)
        VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [vcrId("export"), input.studyId, String(input.userId), String(input.kind), JSON.stringify(input.cover ?? {})])).rows[0];
      await this.audit({ client, studyId: input.studyId, userId: String(input.userId), action: "vcr.export.create",
        object: String(row.id), detail: { kind: String(input.kind) } });
      return this.#exportFromRow(row);
    });
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

  /** @param {Record<string, any>} input */
  async saveModel(input) {
    const row = await this.one(`INSERT INTO ${VCR_SCHEMA}.models (id, user_id, study_id, name, version, tier, risk, endpoint_type, card,
        applicability, validation, evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::text[])
      ON CONFLICT (name, version) DO UPDATE SET card = EXCLUDED.card, applicability = EXCLUDED.applicability,
        validation = EXCLUDED.validation, evidence = EXCLUDED.evidence RETURNING *`,
    [vcrId("model"), input.userId ?? null, input.studyId ?? null, String(input.name), String(input.version), String(input.tier),
      String(input.risk ?? "none"), input.endpointType ?? null, JSON.stringify(input.card ?? {}),
      JSON.stringify(input.applicability ?? {}), JSON.stringify(input.validation ?? {}), list(input.evidence).map(String)]);
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
      ON CONFLICT (method, version) DO UPDATE SET endpoints = EXCLUDED.endpoints, assumptions = EXCLUDED.assumptions,
        numeric_tests = EXCLUDED.numeric_tests, cross_checks = EXCLUDED.cross_checks RETURNING *`,
    [vcrId("method"), String(input.method), String(input.version), list(input.endpoints).map(String),
      JSON.stringify(input.assumptions ?? []), JSON.stringify(input.numericTests ?? {}), list(input.crossChecks).map(String),
      input.releasedAt ?? null]);
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
