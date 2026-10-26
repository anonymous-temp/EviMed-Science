/**
 * The business side of 「虚拟临床研究」 on disk: criteria, matching assessments and
 * their per-criterion judgments and historical follow-up episodes.
 *
 * Hidden knowledge:
 *
 * - **A judgment is written with its assessment or not at all.** An assessment
 *   row whose judgments failed to land would read as a finished evaluation with
 *   no criteria — and `summary` would still say 「符合」. Both go in one
 *   transaction, and re-assessing the same subject at the same instant replaces
 *   the whole set rather than merging into it.
 * - **Assessments are never deleted or overwritten by a newer protocol
 *   version.** A revision makes new rows against the new version id; the old
 *   assessment stays readable (AC-05). That is why `protocol_version_id` is
 *   part of the natural key rather than a mutable column.
 *
 * @module vcrMatchStore
 */

import { createHash, randomUUID } from "node:crypto";

import { correctionHash, correctionPartition } from "./vcrCorrectionCases.mjs";
import { publicMatchingProvenance, languageKeysOf, matchingInputDigest } from "./vcrMatching.mjs";
import { languageCriterionHash, languageInput, verifyMatchingSnapshot } from "./vcrMatchingSnapshot.mjs";
import { VCR_CRITERION_STATES, clinicalFactIssues, clinicalFactPolarity } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA, matchingManifestDigestSql } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";
import { carryScheduleForward } from "./vcrSchedule.mjs";

/** A fact's id: `fac_` and the tail of a uuid, like every id of the module (the base's table has no row for it). */
const factId = () => `fac_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

/**
 * The outcomes recorded by every batch of one candidate denominator (the batches whose manifests differ only by offset), oldest
 * first: one equality on the stored digest, through the study-and-digest index (vcr_matching_inputs_digest_idx), and no manifest is read.
 */
export const MATCHING_BATCHES_SQL = `SELECT outcomes FROM ${VCR_SCHEMA}.matching_inputs WHERE study_id=$1 AND manifest_digest=$2 ORDER BY created_at,id`;

/**
 * A criterion as the evaluator reads it: the requirement and, beside it, the
 * applicability — a criterion that does not apply is not an unknown (plan §7.1),
 * so it is a field of its own, in its own column, and never a key inside the
 * requirement (which the domain's grammar would refuse on the way back in).
 * @param {any} row
 */
const criterionOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  protocolVersionId: row.protocol_version_id,
  ordinal: Number(row.ordinal),
  kind: row.kind,
  criterionType: row.criterion_type,
  requirement: row.requirement ?? {},
  applicability: row.applicability ?? null,
  sourceText: row.source_text ?? "",
  sourceLocator: row.source_locator ?? {},
  evidenceNeeded: row.evidence_needed ?? [],
  reviewState: row.review_state,
  createdAt: row.created_at,
} : null);

/** @param {any} row */
const assessmentOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  protocolVersionId: row.protocol_version_id,
  subjectKey: row.subject_key,
  direction: row.direction,
  asOf: row.as_of,
  summary: row.summary,
  counts: row.counts ?? {},
  provenance: publicMatchingProvenance(row.provenance ?? {}),
  priority: row.priority ?? null,
  evidenceGaps: row.evidence_gaps ?? [],
  reviewedBy: row.reviewed_by ?? null,
  reviewedAt: row.reviewed_at ?? null,
  createdAt: row.created_at,
} : null);

/** @param {any} row */
const judgmentOf = (row) => (row ? {
  id: row.id,
  assessmentId: row.assessment_id,
  criterionId: row.criterion_id,
  state: row.state,
  applicable: row.applicable,
  decidedBy: row.decided_by,
  evidence: row.evidence ?? [],
  recheckAt: row.recheck_at ?? null,
  overriddenBy: row.overridden_by ?? null,
  overrideState: row.override_state ?? null,
  overrideNote: row.override_note ?? null,
} : null);

/** A fact as the evaluator, the freeze and the page read it. A withdrawn fact keeps its structure and its words are gone (`withdrawn`
 * also keeps the digest it had, so a frozen evaluation that referred to it still verifies).
 * @param {any} row */
export const factOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  subjectKey: row.subject_key,
  variable: row.variable,
  value: row.value ?? null,
  unit: row.unit ?? null,
  polarity: row.polarity,
  occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
  recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
  visibleAt: row.visible_at ? new Date(row.visible_at).toISOString() : null,
  surface: row.surface ?? "",
  dateSurface: row.date_surface ?? null,
  source: row.source ?? null,
  extractedBy: row.extracted_by,
  ...(row.provenance ? { provenance: row.provenance } : {}),
  ...(row.clinical ? { clinical: row.clinical, createdAt: new Date(row.created_at).toISOString() } : {}),
  ...(row.withdrawn ? { withdrawn: row.withdrawn } : {}),
} : null);

/** @param {any} row */
const episodeOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  subjectKey: row.subject_key,
  kind: row.kind,
  windowStart: row.window_start ?? null,
  windowEnd: row.window_end ?? null,
  observations: row.observations ?? [],
  restricted: row.restricted ?? {},
  exitReason: row.exit_reason ?? null,
  exitDate: row.exit_date ?? null,
  legacyExitDate: row.legacy_exit_date ?? null,
  createdAt: row.created_at,
} : null);

/** Scientific matching and historical follow-up rows. One store, extended from the module's shared base. */
export class VcrMatchStore extends VcrStoreBase {
  // ------------------------------------------------------------- criteria

  /**
   * A protocol version and its criteria in one transaction: a version whose
   * criteria half-landed would make an assessment name a protocol that never
   * fully existed. The version number is allocated under a lock on the study, so
   * two writers never collide on it.
   * @param {{ studyId: string, userId: string, title?: string, sourceRef?: string | null, usdm?: Record<string, any>, criteria: readonly any[] }} input
   */
  async saveProtocolVersion({ studyId, userId, title = "", sourceRef = null, usdm = {}, criteria }) {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-protocol:${studyId}`]);
      const version = await this.nextVersion(client, "protocol_versions", "study_id = $1", [studyId]);
      const id = vcrId("protocol");
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.protocol_versions (id, study_id, user_id, version, title, source_ref, usdm)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
        [id, studyId, userId, version, String(title ?? ""), sourceRef, JSON.stringify(usdm ?? {})])).rows[0];
      const saved = [];
      for (const [index, criterion] of (criteria ?? []).entries()) {
        saved.push(criterionOf((await client.query(
          `INSERT INTO ${VCR_SCHEMA}.criteria
             (id, study_id, protocol_version_id, user_id, ordinal, kind, criterion_type,
              requirement, applicability, source_text, source_locator, evidence_needed, review_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13) RETURNING *`,
          [vcrId("criterion"), studyId, id, userId, index + 1, criterion?.kind === "exclusion" ? "exclusion" : "inclusion",
            criterion?.criterionType ?? "other", JSON.stringify(criterion?.requirement ?? {}),
            criterion?.applicability ? JSON.stringify(criterion.applicability) : null, String(criterion?.sourceText ?? ""),
            JSON.stringify(criterion?.sourceLocator ?? {}), JSON.stringify(criterion?.evidenceNeeded ?? []),
            criterion?.reviewState ?? "ai_set"])).rows[0]));
      }
      // The version starts with the visit schedule the one before it had.
      const carried = await carryScheduleForward(client, { studyId, userId, protocolVersionId: id });
      await this.audit({
        client, studyId, userId, actor: "control-plane", action: "vcr.protocol.save", object: id,
        detail: { version, criteria: saved.length, schedule: carried },
      });
      return { id, studyId, version, title: String(row.title ?? ""), sourceRef: row.source_ref ?? null, usdm: row.usdm ?? {},
        frozenAt: row.frozen_at ?? null, createdAt: row.created_at, criteria: saved };
    });
  }

  /**
   * Write the structured criteria of one protocol version. Idempotent on
   * `(protocol_version_id, ordinal)`: re-running the structuring step on the
   * same version replaces line 7 rather than adding a second one.
   * @param {{ studyId: string, protocolVersionId: string, userId: string, criteria: readonly any[] }} input
   */
  async saveCriteria({ studyId, protocolVersionId, userId, criteria }) {
    return this.transaction(async (client) => {
      const owned = await client.query(
        `SELECT 1 FROM ${VCR_SCHEMA}.protocol_versions WHERE id = $1 AND study_id = $2`, [protocolVersionId, studyId]);
      if (!owned.rowCount) throw new HttpError(404, "vcr_protocol_version_not_found", "This protocol version is not this study's.");
      /** @type {any[]} */
      const saved = [];
      for (const [index, criterion] of (criteria ?? []).entries()) {
        const ordinal = Number.isInteger(criterion?.ordinal) ? criterion.ordinal : index + 1;
        const result = await client.query(
          `INSERT INTO ${VCR_SCHEMA}.criteria
             (id, study_id, protocol_version_id, user_id, ordinal, kind, criterion_type,
              requirement, applicability, source_text, source_locator, evidence_needed, review_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13)
           ON CONFLICT (protocol_version_id, ordinal) DO UPDATE SET
             kind = EXCLUDED.kind, criterion_type = EXCLUDED.criterion_type,
             requirement = EXCLUDED.requirement, applicability = EXCLUDED.applicability, source_text = EXCLUDED.source_text,
             source_locator = EXCLUDED.source_locator, evidence_needed = EXCLUDED.evidence_needed,
             review_state = EXCLUDED.review_state
           RETURNING *`,
          [criterion?.id ?? vcrId("criterion"), studyId, protocolVersionId, userId, ordinal,
            criterion?.kind === "exclusion" ? "exclusion" : "inclusion", criterion?.criterionType ?? "other",
            JSON.stringify(criterion?.requirement ?? {}), criterion?.applicability ? JSON.stringify(criterion.applicability) : null,
            String(criterion?.sourceText ?? ""), JSON.stringify(criterion?.sourceLocator ?? {}),
            JSON.stringify(criterion?.evidenceNeeded ?? []), criterion?.reviewState ?? "ai_set"],
        );
        saved.push(criterionOf(result.rows[0]));
      }
      await this.audit({
        client, studyId, userId, actor: "control-plane", action: "vcr.criteria.save",
        object: protocolVersionId, detail: { count: saved.length },
      });
      return saved;
    });
  }

  /**
   * The criteria of one protocol version — the **latest** when none is named. A
   * study has many versions and a criterion list that mixed them would evaluate
   * a patient against the old line 3 and the new one at once; `allVersions`
   * says the mixture is what is wanted.
   * @param {{ studyId: string, protocolVersionId?: string|null, allVersions?: boolean }} input
   */
  async listCriteria({ studyId, protocolVersionId = null, allVersions = false }) {
    if (allVersions) {
      return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE study_id = $1 ORDER BY protocol_version_id, ordinal`, [studyId])).map(criterionOf);
    }
    const rows = protocolVersionId
      ? await this.rows(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE study_id = $1 AND protocol_version_id = $2 ORDER BY ordinal`,
        [studyId, protocolVersionId])
      : await this.rows(`SELECT c.* FROM ${VCR_SCHEMA}.criteria c
          WHERE c.study_id = $1 AND c.protocol_version_id = (SELECT id FROM ${VCR_SCHEMA}.protocol_versions
            WHERE study_id = $1 ORDER BY version DESC LIMIT 1) ORDER BY c.ordinal`, [studyId]);
    return rows.map(criterionOf);
  }

  /** @param {string} studyId @param {string|null} [id] */
  async protocols(studyId, id = null) {
    return (await this.rows(`SELECT id,version,title,source_ref FROM ${VCR_SCHEMA}.protocol_versions
      WHERE study_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY version DESC LIMIT 200`, [studyId,id]))
      .map(row => ({ id: row.id, version: Number(row.version), title: row.title ?? '', sourceRef: row.source_ref ?? null }));
  }

  /** The newest protocol version of a study. @param {string} studyId */
  async latestProtocol(studyId) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.protocol_versions WHERE study_id = $1 ORDER BY version DESC LIMIT 1`, [studyId]);
    return row ? { id: row.id, studyId: row.study_id, version: Number(row.version), title: row.title ?? "", sourceRef: row.source_ref ?? null } : null;
  }

  // ---------------------------------------------------------- assessments

  /**
   * Persist one assessment and all of its judgments in one transaction.
   *
   * Re-saving the assessment of the same subject at the same instant replaces
   * what the platform computed and **keeps what a person did**: a coordinator's
   * override of a criterion survives (the pair — the platform's answer and the
   * human's — is the evaluation case, plan §7.5), a criterion dropped from the
   * protocol takes its judgment with it, and the countersignature stays only if
   * the summary it signed is still the summary.
   * @param {{ assessment: any, userId: string }} input
   */
  async saveAssessment({ assessment, userId }) {
    return this.transaction(async (client) => {
      const id = assessment?.id ?? vcrId("assessment");
      const saved = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.matching_assessments
           (id, study_id, protocol_version_id, user_id, subject_key, direction, as_of, summary, counts, priority, evidence_gaps, provenance, input_snapshot_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)
         ON CONFLICT (study_id, protocol_version_id, subject_key, as_of, input_snapshot_id) DO UPDATE SET
           reviewed_by = CASE WHEN ${VCR_SCHEMA}.matching_assessments.summary = EXCLUDED.summary
             THEN ${VCR_SCHEMA}.matching_assessments.reviewed_by END,
           reviewed_at = CASE WHEN ${VCR_SCHEMA}.matching_assessments.summary = EXCLUDED.summary
             THEN ${VCR_SCHEMA}.matching_assessments.reviewed_at END,
           summary = EXCLUDED.summary, counts = EXCLUDED.counts,
           priority = EXCLUDED.priority, evidence_gaps = EXCLUDED.evidence_gaps, provenance = EXCLUDED.provenance
         RETURNING *`,
        [id, assessment.studyId, assessment.protocolVersionId ?? null, userId, assessment.subjectKey,
          assessment.direction ?? "trial_to_patient", assessment.asOf, assessment.summary,
          JSON.stringify(assessment.counts ?? {}),
          assessment.priority ? JSON.stringify(assessment.priority) : null,
          JSON.stringify(assessment.evidenceGaps ?? []), JSON.stringify(assessment.provenance ?? {}), assessment.provenance?.inputSnapshotId ?? "legacy"],
      );
      const row = saved.rows[0];
      const kept = (assessment.judgments ?? []).map((/** @type {any} */ judgment) => String(judgment.criterionId));
      await client.query(
        `DELETE FROM ${VCR_SCHEMA}.criterion_judgments WHERE assessment_id = $1 AND NOT (criterion_id = ANY($2::text[]))`,
        [row.id, kept]);
      for (const judgment of assessment.judgments ?? []) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.criterion_judgments
             (id, assessment_id, criterion_id, user_id, state, applicable, decided_by, evidence, recheck_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (assessment_id, criterion_id) DO UPDATE SET
             state = EXCLUDED.state, applicable = EXCLUDED.applicable, decided_by = EXCLUDED.decided_by,
             evidence = EXCLUDED.evidence, recheck_at = EXCLUDED.recheck_at`,
          [vcrId("judgment"), row.id, judgment.criterionId, userId, judgment.state,
            judgment.applicable !== false, judgment.decidedBy ?? "code",
            JSON.stringify(judgment.evidence ?? []), judgment.recheckAt ?? null],
        );
      }
      await this.audit({
        client, studyId: assessment.studyId, userId, actor: "control-plane", action: "vcr.assessment.save",
        object: row.id, detail: { subjectKey: assessment.subjectKey, summary: assessment.summary, asOf: assessment.asOf },
      });
      return { ...assessmentOf(row), judgments: assessment.judgments ?? [] };
    });
  }

  /**
   * One assessment with its judgments. With a `studyId` an assessment of another
   * study is not found, whoever asks.
   * @param {string} id @param {string | null} [studyId]
   */
  async getAssessment(id, studyId = null) {
    const row = await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.matching_assessments WHERE id = $1 AND ($2::text IS NULL OR study_id = $2)`, [id, studyId]);
    if (!row) return null;
    const judgments = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.criterion_judgments WHERE assessment_id = $1 ORDER BY created_at, id`, [id]);
    return { ...assessmentOf(row), judgments: judgments.map(judgmentOf) };
  }

  /**
   * Assessments, newest first. `latestOnly` keeps one per subject — the newest
   * by the instant it was made as of — which is what a page and a
   * funnel are about; without it every assessment ever made is listed.
   * @param {{ studyId: string, summary?: string|null, subjectKey?: string|null, limit?: number, offset?: number, latestOnly?: boolean }} input
   */
  async listAssessments({ studyId, summary = null, subjectKey = null, limit = 200, offset = 0, latestOnly = false }) {
    const values = [studyId, summary, subjectKey, Math.max(1, Math.min(1000, Number(limit) || 200)), Math.max(0, Number(offset) || 0)];
    const rows = latestOnly
      ? await this.rows(
        `SELECT * FROM (SELECT DISTINCT ON (subject_key) * FROM ${VCR_SCHEMA}.matching_assessments
            WHERE study_id = $1 AND ($3::text IS NULL OR subject_key = $3)
            ORDER BY subject_key, as_of DESC, created_at DESC) latest
          WHERE ($2::text IS NULL OR summary = $2) ORDER BY as_of DESC, subject_key LIMIT $4 OFFSET $5`, values)
      : await this.rows(
        `SELECT * FROM ${VCR_SCHEMA}.matching_assessments
          WHERE study_id = $1 AND ($2::text IS NULL OR summary = $2) AND ($3::text IS NULL OR subject_key = $3)
          ORDER BY created_at DESC LIMIT $4 OFFSET $5`, values);
    return rows.map(assessmentOf);
  }

  /** The newest assessment of one subject, used by scientific matching views. */
  async latestAssessment({ studyId, subjectKey, protocolVersionId = null }) {
    const row = await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1 AND subject_key = $2 AND ($3::text IS NULL OR protocol_version_id=$3)
        ORDER BY as_of DESC, created_at DESC LIMIT 1`, [studyId, subjectKey, protocolVersionId]);
    return assessmentOf(row);
  }

  /**
   * How many subjects each summary holds, over **every** subject of the study
   * (the newest assessment of each), never over a page of them: a tally of the
   * first hundred reports a smaller cohort than there is.
   * @param {string} studyId
   */
  async assessmentTallies(studyId, protocolVersionId = null) {
    const rows = await this.rows(
      `SELECT summary, count(*)::int AS total FROM (SELECT DISTINCT ON (subject_key) summary FROM ${VCR_SCHEMA}.matching_assessments
         WHERE study_id = $1 AND ($2::text IS NULL OR protocol_version_id = $2)
           AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id = $1 AND w.subject_key = matching_assessments.subject_key)
         ORDER BY subject_key, as_of DESC, created_at DESC) latest GROUP BY summary`, [studyId, protocolVersionId]);
    /** @type {Record<string, number>} */
    const tallies = {};
    for (const row of rows) tallies[String(row.summary)] = Number(row.total);
    return tallies;
  }

  /**
   * Every subject's pseudonymous key with its newest summary — a page's worth,
   * ordered by key. @param {string} studyId
   */
  async subjectSummaries(studyId, protocolVersionId = null) {
    const rows = await this.rows(
      `SELECT DISTINCT ON (subject_key) subject_key, summary FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1 AND ($2::text IS NULL OR protocol_version_id = $2)
        ORDER BY subject_key, as_of DESC, created_at DESC LIMIT 5000`, [studyId, protocolVersionId]);
    return rows.map((row) => ({ subjectKey: String(row.subject_key), summary: String(row.summary) }));
  }

  /**
   * What the study's subjects are missing, counted: for each (variable, reason)
   * how many subjects' newest assessment lists it — the aggregate of the gaps, not
   * the gaps of any one person. @param {string} studyId
   */
  async evidenceGapCounts(studyId, protocolVersionId = null) {
    const rows = await this.rows(
      `WITH latest AS (SELECT DISTINCT ON (subject_key) id, evidence_gaps FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1 AND ($2::text IS NULL OR protocol_version_id = $2)
          ORDER BY subject_key, as_of DESC, created_at DESC)
       SELECT g->>'variable' AS variable, g->>'reason' AS reason, count(*)::int AS n
         FROM latest, jsonb_array_elements(latest.evidence_gaps) g GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 100`, [studyId, protocolVersionId]);
    return rows.map((row) => ({ variable: String(row.variable ?? ""), reason: String(row.reason ?? ""), n: Number(row.n) }));
  }

  /**
   * The criterion funnel over every subject's newest assessment: for each
   * criterion, how many subjects it left satisfied, ruled out, unknown or
   * deferred, and for how many it was the **only** line ruling them out — the
   * single figure that says which line costs the trial its patients (plan §7.4).
   * Computed in the database over the complete data, so a limit is never what the
   * answer depends on.
   * @param {string} studyId @param {string | null} [protocolVersionId]
   */
  async criterionFunnelRows(studyId, protocolVersionId = null) {
    const rows = await this.rows(
      `WITH latest AS (
         SELECT DISTINCT ON (subject_key) id FROM ${VCR_SCHEMA}.matching_assessments
          WHERE study_id = $1 AND ($2::text IS NULL OR protocol_version_id = $2)
          ORDER BY subject_key, as_of DESC, created_at DESC),
       failing AS (
         SELECT assessment_id, count(*) AS n FROM ${VCR_SCHEMA}.criterion_judgments
          WHERE applicable AND state = 'not_satisfied' AND assessment_id IN (SELECT id FROM latest) GROUP BY assessment_id)
       SELECT c.id AS criterion_id, c.ordinal, c.kind, c.criterion_type,
              count(*) FILTER (WHERE NOT j.applicable)::int AS not_applicable,
              count(*) FILTER (WHERE j.applicable AND j.state = 'satisfied')::int AS satisfied,
              count(*) FILTER (WHERE j.applicable AND j.state = 'not_satisfied')::int AS not_satisfied,
              count(*) FILTER (WHERE j.applicable AND j.state = 'unknown')::int AS unknown,
              count(*) FILTER (WHERE j.applicable AND j.state = 'pending_recheck')::int AS pending_recheck,
              count(*) FILTER (WHERE j.applicable AND j.state = 'not_satisfied' AND f.n = 1)::int AS sole_reason
         FROM ${VCR_SCHEMA}.criterion_judgments j
         JOIN ${VCR_SCHEMA}.criteria c ON c.id = j.criterion_id AND c.study_id = $1
         LEFT JOIN failing f ON f.assessment_id = j.assessment_id
        WHERE j.assessment_id IN (SELECT id FROM latest)
        GROUP BY c.id, c.ordinal, c.kind, c.criterion_type
        ORDER BY sole_reason DESC, not_satisfied DESC, c.ordinal`, [studyId, protocolVersionId]);
    return rows.map((row) => ({
      criterionId: String(row.criterion_id), ordinal: Number(row.ordinal), kind: String(row.kind), criterionType: String(row.criterion_type),
      satisfied: Number(row.satisfied), not_satisfied: Number(row.not_satisfied), unknown: Number(row.unknown),
      pending_recheck: Number(row.pending_recheck), notApplicable: Number(row.not_applicable), soleReason: Number(row.sole_reason),
    }));
  }

  /**
   * A coordinator's re-judgment of one criterion, of one assessment of this
   * study (an assessment of another study is not found).
   *
   * It does not overwrite the state: the platform's answer and the human's
   * answer are both kept, because the pair is the evaluation case (plan §7.5).
   * @param {{ assessmentId: string, criterionId: string, state: string, by: string, note?: string, userId: string, studyId: string }} input
   */
  async overrideJudgment({ assessmentId, criterionId, state, by, note = "", userId, studyId }) {
    if (!studyId) throw new TypeError("A judgment is overridden inside its study: studyId is required.");
    if (!VCR_CRITERION_STATES.includes(String(state))) {
      throw new HttpError(400, "vcr_write_value_invalid", `state must be one of: ${VCR_CRITERION_STATES.join(", ")}.`);
    }
    return this.transaction(async (client) => {
      const assessment = (await client.query('SELECT * FROM evimed_vcr.matching_assessments WHERE id=$1 AND study_id=$2 FOR UPDATE', [assessmentId, studyId])).rows[0];
      if (!assessment) return null;
      const previous = (await client.query('SELECT * FROM evimed_vcr.criterion_judgments WHERE assessment_id=$1 AND criterion_id=$2 FOR UPDATE', [assessmentId, criterionId])).rows[0];
      if (!previous) return null;
      const evaluationCase = await this.captureCorrectionCase(client, assessment, previous, { state, by });
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.criterion_judgments j
            SET override_state = $3, overridden_by = $4, override_note = $5
           FROM ${VCR_SCHEMA}.matching_assessments a
          WHERE j.assessment_id = $1 AND j.criterion_id = $2 AND a.id = j.assessment_id AND a.study_id = $6 RETURNING j.*`,
        [assessmentId, criterionId, state, by, note, studyId]);
      if (!result.rowCount) return null;
      await this.audit({
        client, studyId, userId, actor: by, action: "vcr.judgment.override",
        // The reviewer's note is free text about one person and lives on the judgment
        // row (`override_note`), which goes with the study; an audit row outlives it.
        object: `${assessmentId}:${criterionId}`, detail: { state, noted: String(note ?? "").trim() !== "", evaluationCase },
      });
      return judgmentOf(result.rows[0]);
    });
  }

  /** Freeze references before the assessment's next evaluation can overwrite the original judgment.
   * @param {any} client @param {any} assessment @param {any} previous @param {{state:string,by:string}} correction */
  async captureCorrectionCase(client, assessment, previous, { state, by }) {
    const criterion = criterionOf((await client.query('SELECT * FROM evimed_vcr.criteria WHERE id=$1 AND study_id=$2', [previous.criterion_id, assessment.study_id])).rows[0]);
    const factIds = assessment.provenance?.inputFactIds ?? [];
    const languageIds = assessment.provenance?.inputLanguageIds ?? [];
    const facts = (await client.query('SELECT * FROM evimed_vcr.matching_facts WHERE study_id=$1 AND subject_key=$2 AND visible_at<=$3 AND id=ANY($4::text[]) ORDER BY array_position($4::text[],id) LIMIT 257',
      [assessment.study_id, assessment.subject_key, assessment.as_of, factIds])).rows.map(factOf);
    const language = (await client.query(`SELECT * FROM evimed_vcr.language_judgments WHERE study_id=$1 AND subject_key=$2 AND visible_at<=$3 AND id=ANY($4::text[])
      ORDER BY array_position($4::text[],id) LIMIT 101`, [assessment.study_id,assessment.subject_key,assessment.as_of,languageIds])).rows.map(row => this.correctionLanguage(row));
    const documentIds = [...new Set([...facts.map(fact => fact.source?.documentId), ...language.flatMap(row => row.evidence.map(item => item.documentId))].filter(Boolean))];
    const documents = (await client.query('SELECT id,source_id,sha256 FROM evimed_vcr.source_files WHERE study_id=$1 AND id=ANY($2::text[])', [assessment.study_id,documentIds])).rows
      .map(row => ({ id: row.id, sourceId: row.source_id, sha256: row.sha256 })).sort((a, b) => a.id.localeCompare(b.id));
    // Different assessments of one subject can be corrected concurrently. Keep
    // the opaque group identity stable as well as the deterministic partition.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-correction-group:${assessment.study_id}:${assessment.subject_key}`]);
    const prior = (await client.query(`SELECT a.detail#>>'{evaluationCase,groupId}' AS group_id FROM evimed_vcr.audit a
      JOIN evimed_vcr.matching_assessments m ON m.id=a.detail#>>'{evaluationCase,assessmentId}'
      WHERE a.study_id=$1 AND a.action='vcr.judgment.override' AND m.subject_key=$2 ORDER BY a.id LIMIT 1`, [assessment.study_id,assessment.subject_key])).rows[0];
    const unavailable = !criterion || !assessment.provenance?.vocabularyVersion ? 'case_version_missing'
      : !assessment.provenance?.inputReferencesComplete || facts.length !== factIds.length || language.length !== languageIds.length ? 'case_references_missing'
      : correctionHash(criterion) !== assessment.provenance.inputCriterionHashes?.[criterion.id]
        || facts.some(row => correctionHash(row) !== assessment.provenance.inputFactHashes?.[row.id])
        || language.some(row => correctionHash({ id: row.id, state: row.state, evidence: row.evidence }) !== assessment.provenance.inputLanguageHashes?.[row.id]) ? 'case_inputs_changed'
      : facts.length > 256 || language.length > 100 || documentIds.length > 20 ? 'case_input_limit' : documents.length !== documentIds.length ? 'case_document_missing' : null;
    const factRefs = facts.slice(0,256).map(row => ({ id: row.id, hash: correctionHash(row) }));
    const languageRefs = language.slice(0,100).map(row => ({ id: row.id, hash: correctionHash(row) }));
    const ruleHash = correctionHash(criterion);
    const inputDigest = correctionHash({ assessmentId: assessment.id, criterionId: previous.criterion_id, ruleHash, facts: factRefs, language: languageRefs, documents });
    return { caseId: `case_${randomUUID().replaceAll('-', '')}`, inputDigest, studyId: assessment.study_id, assessmentId: assessment.id, criterionId: previous.criterion_id,
      protocolVersionId: assessment.protocol_version_id, asOf: new Date(assessment.as_of).toISOString(), originalState: previous.state, expectedState: state,
      reviewerId: by, capturedAt: new Date().toISOString(), groupId: prior?.group_id ?? `group_${randomUUID().replaceAll('-', '')}`,
      partition: correctionPartition(assessment.study_id, assessment.subject_key), subjectDigest: correctionHash({ studyId: assessment.study_id, subjectKey: assessment.subject_key }),
      vocabularyVersion: assessment.provenance?.vocabularyVersion ?? null, criterion, ruleHash,
      facts: factRefs, language: languageRefs,
      documents, ...(unavailable ? { unavailable } : {}) };
  }
  /** @param {any} row */
  correctionLanguage(row) { return { id: row.id, subjectKey: row.subject_key, criterionKey: row.criterion_key, state: row.state,
    evidence: row.evidence ?? [], visibleAt: new Date(row.visible_at).toISOString() }; }
  /** @param {{studyId:string,after?:string,limit?:number}} request */
  async correctionCases({ studyId, after='0', limit=100 }) {
    const rows = await this.rows(`WITH latest AS (
      SELECT DISTINCT ON (detail#>>'{evaluationCase,inputDigest}') id,detail->'evaluationCase' AS item FROM evimed_vcr.audit
      WHERE study_id=$1 AND action='vcr.judgment.override' AND detail#>>'{evaluationCase,inputDigest}' IS NOT NULL
        AND COALESCE(detail#>>'{evaluationCase,unavailable}','')=''
      ORDER BY detail#>>'{evaluationCase,inputDigest}',id DESC)
      SELECT id::text,item FROM latest WHERE id>$2::bigint ORDER BY latest.id LIMIT $3`, [studyId,after,limit+1]);
    const legacy = await this.one(`SELECT count(*)::int AS count FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.judgment.override'
      AND (detail->'evaluationCase' IS NULL OR COALESCE(detail#>>'{evaluationCase,unavailable}','')<>'')`, [studyId]);
    const page = rows.slice(0,limit);
    return { items: page.map(row => row.item), more: rows.length>limit, nextCursor: page.at(-1)?.id ?? null, legacyUnfrozen: legacy.count };
  }
  /** @param {string} studyId @param {string[]} ids */
  async correctionCasesById(studyId, ids) {
    return (await this.rows(`SELECT detail->'evaluationCase' AS item FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.judgment.override'
      AND detail#>>'{evaluationCase,caseId}'=ANY($2::text[]) ORDER BY array_position($2::text[],detail#>>'{evaluationCase,caseId}')`, [studyId,ids])).map(row => row.item);
  }
  /** @param {any} item */
  async correctionInputs(item) {
    const factRows = await this.rows('SELECT * FROM evimed_vcr.matching_facts WHERE study_id=$1 AND id=ANY($2::text[]) ORDER BY array_position($2::text[],id)', [item.studyId,item.facts.map(row=>row.id)]);
    const languageRows = await this.rows('SELECT * FROM evimed_vcr.language_judgments WHERE study_id=$1 AND id=ANY($2::text[]) ORDER BY array_position($2::text[],id)', [item.studyId,item.language.map(row=>row.id)]);
    // A case whose source was withdrawn has no text to replay: it reads as withdrawn, which is not a changed input.
    if (factRows.some(row => row.withdrawn) || languageRows.some(row => row.withdrawn)) throw new HttpError(410,'vcr_document_withdrawn','This case rests on a source that was withdrawn.');
    const facts = factRows.map(factOf);
    const language = languageRows.map(row=>this.correctionLanguage(row));
    if (facts.length!==item.facts.length || language.length!==item.language.length || facts.some((row,index)=>correctionHash(row)!==item.facts[index].hash)
      || language.some((row,index)=>correctionHash(row)!==item.language[index].hash)) throw new HttpError(409,'vcr_evaluation_input_changed','A frozen case input changed.');
    return { facts, modelJudgments: Object.fromEntries(language.map(row=>[row.criterionKey,{state:row.state,evidence:row.evidence}])) };
  }
  /** @param {string} studyId @param {string} datasetId */
  async evaluationDataset(studyId,datasetId) {
    return (await this.one("SELECT detail->'manifest' AS manifest FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.evaluation.dataset' AND object=$2 ORDER BY id LIMIT 1", [studyId,datasetId]))?.manifest ?? null;
  }

  /**
   * Countersign an assessment of this study (plan §10.2: a signature, not a gate).
   * @param {{ id: string, reviewedBy: string, userId: string, studyId: string }} input
   */
  async reviewAssessment({ id, reviewedBy, userId, studyId }) {
    if (!studyId) throw new TypeError("An assessment is reviewed inside its study: studyId is required.");
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.matching_assessments SET reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND study_id = $3 RETURNING *`,
        [id, reviewedBy, studyId]);
      if (!result.rowCount) return null;
      await this.audit({ client, studyId, userId, actor: reviewedBy, action: "vcr.assessment.review", object: id });
      return assessmentOf(result.rows[0]);
    });
  }

  /** Every judgment a human changed, with the platform's own answer beside it — the evaluation set. */
  async overriddenJudgments({ studyId, limit = 500 }) {
    const rows = await this.rows(
      `SELECT j.*, a.subject_key, a.study_id, c.criterion_type, c.kind AS criterion_kind
         FROM ${VCR_SCHEMA}.criterion_judgments j
         JOIN ${VCR_SCHEMA}.matching_assessments a ON a.id = j.assessment_id
         LEFT JOIN ${VCR_SCHEMA}.criteria c ON c.id = j.criterion_id
        WHERE a.study_id = $1 AND j.override_state IS NOT NULL
        ORDER BY j.created_at DESC LIMIT $2`,
      [studyId, Math.max(1, Math.min(2000, Number(limit) || 500))]);
    return rows.map((row) => ({
      ...judgmentOf(row),
      subjectKey: row.subject_key,
      criterionType: row.criterion_type ?? "other",
      criterionKind: row.criterion_kind ?? "inclusion",
    }));
  }

  /**
   * The judgments whose deferral date has come, across the study's newest
   * assessments: what the recheck loop re-evaluates.
   * @param {{ studyId?: string | null, now?: Date, limit?: number }} [input]
   */
  async dueRecheckSubjects({ studyId = null, now = new Date(), limit = 200 } = {}) {
    const rows = await this.rows(
      `SELECT DISTINCT a.study_id, a.subject_key, min(j.recheck_at) AS due
         FROM ${VCR_SCHEMA}.criterion_judgments j
         JOIN ${VCR_SCHEMA}.matching_assessments a ON a.id = j.assessment_id
         JOIN ${VCR_SCHEMA}.studies s ON s.id = a.study_id AND s.deleted_at IS NULL AND s.status = 'active'
        WHERE j.state = 'pending_recheck' AND j.recheck_at IS NOT NULL AND j.recheck_at <= $2
          AND ($1::text IS NULL OR a.study_id = $1)
          AND a.id = (SELECT id FROM ${VCR_SCHEMA}.matching_assessments l WHERE l.study_id = a.study_id AND l.subject_key = a.subject_key
                       ORDER BY l.as_of DESC, l.created_at DESC LIMIT 1)
        GROUP BY a.study_id, a.subject_key ORDER BY due LIMIT $3`,
      [studyId, now.toISOString(), Math.max(1, Math.min(1000, limit))]);
    return rows.map((row) => ({ studyId: String(row.study_id), subjectKey: String(row.subject_key), due: row.due }));
  }

  /** Platform-issued usage references, never a model's self-description.
   * A run may make several calls before a write: this is a bounded run-window association.
   * @param {any} study @param {string|null} runId */
  async producerContext(study, runId) {
    const base = { schema: 1, runId, association: 'run_requests_before_write', skillDigest: null, requests: [] };
    if (!runId) return { ...base, status: 'unknown' };
    if (!(await this.one("SELECT to_regclass('evimed_usage.model_requests') AS relation"))?.relation) return { ...base, status: 'ledger_unavailable' };
    const rows = await this.rows(`SELECT id,model,observed_model,request_fingerprint,provider_request_id,status
      FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 AND run_id=$3
      ORDER BY created_at DESC,id DESC LIMIT 101`, [study.userId, study.projectId, runId]);
    return { ...base, status: rows.length ? 'recorded' : 'pending', truncated: rows.length > 100,
      requests: rows.slice(0,100).map(row => ({ id: row.id, requestedModel: row.model, observedModel: row.observed_model ?? null,
        requestHash: row.request_fingerprint, providerRequestId: row.provider_request_id ?? null, status: row.status })) };
  }

  /** @param {any} client @param {string} studyId @param {string} targetId @param {any} provenance */
  async saveProducer(client, studyId, targetId, provenance) {
    if (!provenance) return;
    const hash = matchingInputDigest(provenance);
    await client.query(`INSERT INTO ${VCR_SCHEMA}.matching_producers(study_id,target_id,producer_hash,provenance)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`, [studyId, targetId, hash, JSON.stringify(provenance)]);
  }

  /** @param {string} studyId @param {string[]} ids */
  async producers(studyId, ids) {
    return this.rows(`SELECT target_id AS "targetId",provenance,created_at AS "createdAt" FROM ${VCR_SCHEMA}.matching_producers
      WHERE study_id=$1 AND target_id=ANY($2::text[]) ORDER BY created_at`, [studyId, ids]);
  }

  // ---------------------------------------------------------------- facts

  /**
   * One located fact of one patient. The fact key is the sha256 of what makes it
   * *that* fact — the subject, the variable, the polarity, the value and the
   * span it was read from — so a run that writes the same reading twice writes it
   * once; the first `visible_at` stands.
   * @param {{ studyId: string, userId: string, fact: any }} input
   */
  async saveFact({ studyId, userId, fact }) {
    if (clinicalFactIssues(fact.clinical).length) throw new HttpError(400, 'vcr_clinical_fact_invalid', 'Clinical metadata is invalid.');
    const key = createHash("sha256").update(JSON.stringify([
      fact.subjectKey, fact.variable, fact.polarity, fact.value ?? null, fact.unit ?? null,
      fact.source?.documentId ?? null, fact.source?.start ?? null, fact.source?.end ?? null, fact.occurredAt ?? null, fact.source?.vocabularyVersion ?? null, ...(fact.clinical ? [fact.clinical] : []),
    ])).digest("hex");
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.matching_facts
           (id, study_id, user_id, subject_key, fact_key, variable, value, unit, polarity, occurred_at, recorded_at, visible_at,
            surface, date_surface, source, extracted_by, provenance, clinical)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18::jsonb)
         ON CONFLICT (study_id, fact_key) DO UPDATE SET fact_key = EXCLUDED.fact_key RETURNING *, (xmax = 0) AS inserted`,
        [factId(), studyId, userId, fact.subjectKey, key, fact.variable, JSON.stringify(fact.value ?? null), fact.unit ?? null,
          clinicalFactPolarity(fact), fact.occurredAt ?? null, fact.recordedAt ?? null, fact.visibleAt,
          String(fact.surface ?? ""), fact.dateSurface ?? null, fact.source ? JSON.stringify(fact.source) : null, fact.extractedBy ?? "model",
          fact.provenance ? JSON.stringify(fact.provenance) : null, fact.clinical ? JSON.stringify(fact.clinical) : null]);
      const row = inserted.rows[0];
      await this.saveProducer(client, studyId, row.id, fact.provenance);
      if (row.inserted) {
        await this.audit({ client, studyId, userId, actor: "runtime", action: "vcr.fact.save", object: row.id,
          detail: { subjectKey: fact.subjectKey, variable: fact.variable } });
      }
      return factOf(row);
    });
  }

  /**
   * The facts of a study: every subject's, or one subject's. The evaluator asks
   * with the instant it replays and `visibleBy` keeps out what the platform could
   * not yet see — a fact recorded on Tuesday about Monday was not knowable on
   * Monday (AC-15).
   * @param {{ studyId: string, subjectKey?: string | null, visibleBy?: string | null }} input
   */
  async listFacts({ studyId, subjectKey = null, visibleBy = null }) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.matching_facts
        WHERE study_id = $1 AND ($2::text IS NULL OR subject_key = $2) AND ($3::timestamptz IS NULL OR visible_at <= $3)
          AND withdrawn IS NULL
        ORDER BY subject_key, visible_at, id`, [studyId, subjectKey, visibleBy]);
    return rows.map(factOf);
  }

  /** The subjects that have facts, with how many. @param {string} studyId */
  /**
   * Whether the study's ledger already holds this subject: an assessment (every row of the subject table has one once an
   * evaluation ran) or a recorded fact (which is anchored in one of the subject's own documents).
   * @param {string} studyId @param {string} subjectKey @returns {Promise<boolean>}
   */
  async holdsSubject(studyId, subjectKey) {
    // A subject whose consent was withdrawn is nobody the study holds: nothing more is written about them.
    const rows = await this.rows(
      `SELECT ((EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1 AND subject_key = $2)
            OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.matching_facts WHERE study_id = $1 AND subject_key = $2))
            AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals WHERE study_id = $1 AND subject_key = $2)) AS held`, [studyId, subjectKey]);
    return rows[0]?.held === true;
  }

  async factSubjects(studyId) {
    const rows = await this.rows(
      `SELECT subject_key, count(*)::int AS facts FROM ${VCR_SCHEMA}.matching_facts WHERE study_id = $1 AND withdrawn IS NULL GROUP BY subject_key ORDER BY subject_key`, [studyId]);
    return rows.map((row) => ({ subjectKey: String(row.subject_key), facts: Number(row.facts) }));
  }

  /** Includes uploaded charts even when extraction produced no facts.
   * @param {{studyId:string, visibleBy?:string|null}} input */
  async candidateSubjects({ studyId, visibleBy = null }) {
    // A subject whose consent was withdrawn is nobody's candidate, whatever else the study still holds of them, and a document
    // whose text was erased makes nobody a candidate.
    const rows = await this.rows(`SELECT subject_key FROM (
      SELECT subject_key FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND withdrawn IS NULL AND ($2::timestamptz IS NULL OR visible_at <= $2)
      UNION SELECT subject_key FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND withdrawn IS NULL AND ($2::timestamptz IS NULL OR visible_at <= $2)
      UNION SELECT subject_key FROM ${VCR_SCHEMA}.matching_candidates WHERE study_id=$1 AND ($2::timestamptz IS NULL OR visible_at <= $2)
      UNION SELECT detail->>'subjectKey' AS subject_key FROM ${VCR_SCHEMA}.source_files
        WHERE study_id=$1 AND role='document' AND erased_at IS NULL AND detail->>'subjectKey' IS NOT NULL
        AND ($2::timestamptz IS NULL OR COALESCE(NULLIF(detail->>'visibleAt','')::timestamptz,created_at) <= $2)
      ) roster WHERE NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=$1 AND w.subject_key=roster.subject_key)
      ORDER BY subject_key`, [studyId, visibleBy]);
    return rows.map(row => String(row.subject_key));
  }

  /** The subjects whose consent was withdrawn: the roster leaves them out, and a continued batch counts them unavailable.
   * @param {string} studyId @returns {Promise<Set<string>>} */
  async withdrawnSubjects(studyId) {
    return new Set((await this.rows(`SELECT subject_key FROM ${VCR_SCHEMA}.subject_withdrawals WHERE study_id=$1`, [studyId])).map(row => String(row.subject_key)));
  }

  /** @param {{id:string,payload:any}} snapshot */
  async saveMatchingSnapshot(snapshot) {
    verifyMatchingSnapshot(snapshot.payload, snapshot.payload.studyId, snapshot.id);
    await this.query(`INSERT INTO ${VCR_SCHEMA}.matching_inputs (study_id,id,manifest,manifest_digest) VALUES ($1,$2,$3::jsonb,${matchingManifestDigestSql("$3::jsonb")})
      ON CONFLICT (study_id,id) DO NOTHING`, [snapshot.payload.studyId, snapshot.id, JSON.stringify(snapshot.payload)]);
    return snapshot.id;
  }

  /** @param {string} studyId @param {string} id */
  async matchingSnapshot(studyId, id) {
    const row = await this.one(`SELECT manifest FROM ${VCR_SCHEMA}.matching_inputs WHERE study_id=$1 AND id=$2`, [studyId, id]);
    return verifyMatchingSnapshot(row?.manifest, studyId, id);
  }

  /** Keep every requested subject accounted for without placing patient keys in engine results.
   * @param {string} studyId @param {string} id @param {Record<string, any>} outcomes */
  async recordMatchingOutcomes(studyId, id, outcomes) {
    await this.rows(`UPDATE ${VCR_SCHEMA}.matching_inputs SET outcomes=outcomes || $3::jsonb WHERE study_id=$1 AND id=$2`, [studyId,id,JSON.stringify(outcomes)]);
  }

  /** Protected, study-scoped roster; a subject outside a completed batch remains pending.
   * @param {string} studyId @param {string} id */
  async matchingProgress(studyId, id) {
    const row = await this.one(`SELECT manifest, COALESCE(manifest_digest, ${matchingManifestDigestSql("manifest")}) AS digest
      FROM ${VCR_SCHEMA}.matching_inputs WHERE study_id=$1 AND id=$2`, [studyId,id]);
    if (!row) return [];
    // Continuations have their own immutable job hash, but one candidate
    // denominator. Merge only batches whose entire input differs by offset:
    // those are the ones that share the digest of the manifest without it.
    const batches = await this.rows(MATCHING_BATCHES_SQL, [studyId,row.digest]);
    const outcomes = Object.assign({}, ...batches.map(batch => batch.outcomes ?? {}));
    return (row.manifest.subjects ?? []).map(subjectKey => ({ subjectKey, ...(outcomes[subjectKey] ?? { state:'pending' }) }));
  }

  /** @param {string} studyId @param {string} protocolVersionId */
  async latestMatchingProgress(studyId, protocolVersionId) {
    const row = await this.one(`SELECT id FROM ${VCR_SCHEMA}.matching_inputs
      WHERE study_id=$1 AND manifest->>'protocolVersionId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,[studyId,protocolVersionId]);
    if (!row) return null;
    const progress = await this.matchingProgress(studyId,row.id);
    return { inputSnapshotId: row.id, requested: progress.length,
      ...Object.fromEntries(['evaluated','pending','unavailable'].map(state=>[state,progress.filter(entry=>entry.state===state).length])) };
  }


  /**
   * The names the data tab lists a study's documents under, by every id a citation can carry: the document's own and its reviewed
   * text's. A document's stored name is derived from its content (`document-<hash>.txt`), never from the file the person uploaded.
   * @param {string} studyId @param {readonly string[]} ids @returns {Promise<Map<string, string>>}
   */
  async documentNames(studyId, ids) {
    const wanted = [...new Set(ids.map(String))].slice(0, 200);
    if (!wanted.length) return new Map();
    const rows = await this.rows(`SELECT f.id AS file_id, f.name, p.id AS projection_id FROM ${VCR_SCHEMA}.source_files f
        LEFT JOIN ${VCR_SCHEMA}.document_projections p ON p.document_id=f.id AND p.study_id=f.study_id
      WHERE f.study_id=$1 AND f.role='document' AND (f.id=ANY($2::text[]) OR p.id=ANY($2::text[]))`, [studyId, wanted]);
    /** @type {Map<string, string>} */
    const names = new Map();
    for (const row of rows) {
      names.set(String(row.file_id), String(row.name));
      if (row.projection_id) names.set(String(row.projection_id), String(row.name));
    }
    return names;
  }

  /** @param {string} studyId @param {string[]} ids */
  async matchingFactsByIds(studyId, ids) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND id=ANY($2::text[])`, [studyId, ids])).map(factOf);
  }

  /** @param {string} studyId @param {string[]} ids */
  async languageJudgmentsByIds(studyId, ids) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND id=ANY($2::text[])`, [studyId, ids])).map(row => ({
      id: row.id, subjectKey: row.subject_key, criterionKey: row.criterion_key, state: row.state, evidence: row.evidence ?? [],
      protocolVersionId: row.protocol_version_id, criterionHash: row.criterion_hash, provenance: row.provenance ?? null,
      ...(row.withdrawn ? { withdrawn: row.withdrawn } : {}),
    }));
  }

  /**
   * The answer to a language-only criterion, with its anchored quotes. Each
   * answer is its own row; the newest per (subject, criterion key) is the one
   * evaluated.
   * @param {{ studyId: string, userId: string, subjectKey: string, criterionKey: string, state: string, evidence: readonly any[], protocolVersionId?:string|null, provenance?:any }} input
   */
  async saveLanguageJudgment({ studyId, userId, subjectKey, criterionKey, state, evidence, protocolVersionId = null, provenance = null }) {
    return this.transaction(async (client) => {
      const protocol = (await client.query(`SELECT id FROM ${VCR_SCHEMA}.protocol_versions WHERE study_id=$1
        AND ($2::text IS NULL OR id=$2) ORDER BY version DESC LIMIT 1`, [studyId, protocolVersionId])).rows[0];
      if (!protocol) throw new HttpError(409, 'vcr_protocol_version_not_found', 'The protocol version is unavailable.');
      const criteria = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE study_id=$1 AND protocol_version_id=$2 ORDER BY ordinal`,
        [studyId, protocol.id])).rows.map(criterionOf).filter((/** @type {any} */ criterion) => languageKeysOf(criterion.requirement, criterion.id).includes(criterionKey));
      if (!criteria.length) throw new HttpError(409, 'vcr_criterion_malformed', 'This language key does not belong to the protocol version.');
      const criterionHash = languageCriterionHash(criteria, criterionKey);
      const visibleAt = (evidence ?? []).map((/** @type {any} */ item) => Date.parse(item?.visibleAt ?? "")).filter(Number.isFinite);
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.language_judgments (id, study_id, user_id, subject_key, criterion_key, state, evidence, visible_at, protocol_version_id, criterion_hash, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb) RETURNING *`,
        [vcrId("judgment"), studyId, userId, subjectKey, criterionKey, state, JSON.stringify(evidence ?? []),
          new Date(visibleAt.length ? Math.max(...visibleAt) : Date.now()).toISOString(), protocol.id, criterionHash,
          provenance ? JSON.stringify(provenance) : null]);
      await this.saveProducer(client, studyId, result.rows[0].id, provenance);
      await this.audit({ client, studyId, userId, actor: "runtime", action: "vcr.language_judgment.save", object: result.rows[0].id,
        detail: { subjectKey, criterionKey, state } });
      return { id: String(result.rows[0].id), subjectKey, criterionKey, state };
    });
  }

  /**
   * The newest answer per (subject, criterion key), visible by `visibleBy`.
   * @param {{ studyId: string, visibleBy?: string | null, protocolVersionId?:string|null }} input
   * @returns {Promise<Map<string, Record<string, any>>>} subjectKey → { criterionKey → { state, evidence } }
   */
  async latestLanguageJudgments({ studyId, visibleBy = null, protocolVersionId = null }) {
    const version = protocolVersionId ?? (await this.latestProtocol(studyId))?.id;
    if (!version) return new Map();
    const criteria = await this.listCriteria({ studyId, protocolVersionId: version });
    const rows = await this.rows(
      `SELECT DISTINCT ON (subject_key, criterion_key) *
         FROM ${VCR_SCHEMA}.language_judgments
        WHERE study_id = $1 AND ($2::timestamptz IS NULL OR visible_at <= $2)
          AND protocol_version_id=$3 AND withdrawn IS NULL
        ORDER BY subject_key, criterion_key, created_at DESC, id DESC`, [studyId, visibleBy, version]);
    /** @type {Map<string, Record<string, any>>} */
    const bySubject = new Map();
    for (const row of rows) {
      const bound = criteria.filter(criterion => languageKeysOf(criterion.requirement, criterion.id).includes(row.criterion_key));
      if (!bound.length || row.criterion_hash !== languageCriterionHash(bound, row.criterion_key)) continue;
      const entry = bySubject.get(String(row.subject_key)) ?? {};
      entry[String(row.criterion_key)] = languageInput({ id: row.id, state: row.state, evidence: row.evidence,
        protocolVersionId: row.protocol_version_id, criterionHash: row.criterion_hash, provenance: row.provenance });
      bySubject.set(String(row.subject_key), entry);
    }
    return bySubject;
  }

  /** The first reported exit is independent of the later observation timeline.
   * Legacy rows retain their calendar date in the database's recording timezone;
   * new rows also keep the verbatim source date and normalize window instants.
   * @param {{ studyId: string, subjectKey: string }} input
   */
  async firstTrialExit({ studyId, subjectKey }) {
    return episodeOf(await this.one(`SELECT *, window_end::date::text AS legacy_exit_date
      FROM ${VCR_SCHEMA}.followup_episodes WHERE study_id = $1 AND subject_key = $2 AND kind = 'study_specific'
      ORDER BY created_at, id LIMIT 1`, [studyId, subjectKey]));
  }

  /** @param {{ studyId: string, subjectKey?: string|null }} input */
  async listFollowupEpisodes({ studyId, subjectKey = null }) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.followup_episodes
        WHERE study_id = $1 AND ($2::text IS NULL OR subject_key = $2)
        ORDER BY window_start NULLS LAST, created_at`, [studyId, subjectKey]);
    return rows.map(episodeOf);
  }
}
