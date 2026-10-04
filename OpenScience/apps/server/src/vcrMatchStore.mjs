/**
 * The business side of 「虚拟临研」 on disk: criteria, matching assessments and
 * their per-criterion judgments, sites, the referral ledger and its events, and
 * follow-up episodes (plan §7).
 *
 * Hidden knowledge:
 *
 * - **A judgment is written with its assessment or not at all.** An assessment
 *   row whose judgments failed to land would read as a finished evaluation with
 *   no criteria — and `summary` would still say 「符合」. Both go in one
 *   transaction, and re-assessing the same subject at the same instant replaces
 *   the whole set rather than merging into it.
 * - **A referral transition is decided on the locked row.** The contact gate
 *   (AC-18) is worth nothing if two coordinators can read `candidate` at the
 *   same moment and both write `contacted`. The caller hands in a guard that
 *   runs inside the transaction, after `SELECT … FOR UPDATE`, so the state the
 *   policy judged is the state that is written.
 * - **Every transition writes an event.** The ledger is the answer to 「谁在什么
 *   时候改的」, and an event that can be skipped is one that is. The event rows
 *   are also the funnel: transitions per state, per site, with timestamps, is
 *   what the accrual prior is later fitted on.
 * - **A screen failure names a criterion.** The column is a foreign key to
 *   `criteria` on purpose (plan §7.2): a free-text reason cannot be counted,
 *   and knowing which single line costs the trial its patients is the thing a
 *   sponsor pays for.
 * - **Assessments are never deleted or overwritten by a newer protocol
 *   version.** A revision makes new rows against the new version id; the old
 *   assessment stays readable (AC-05). That is why `protocol_version_id` is
 *   part of the natural key rather than a mutable column.
 *
 * @module vcrMatchStore
 */

import { createHash, randomUUID } from "node:crypto";

import { correctionHash, correctionPartition } from "./vcrCorrectionCases.mjs";
import { publicMatchingProvenance } from "./vcrMatching.mjs";
import { VCR_CRITERION_STATES, VCR_REFERRAL_STATES } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** A fact's id: `fac_` and the tail of a uuid, like every id of the module (the base's table has no row for it). */
const factId = () => `fac_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

/** The states a referral is created in. Anything else has to be reached by a transition a person made. */
const VCR_REFERRAL_ENTRY_STATES = Object.freeze(["candidate", "needs_evidence"]);

/** The states before contact, the only ones a per-person confirmation may be recorded in. */
const VCR_REFERRAL_APPROVABLE_STATES = Object.freeze(["candidate", "needs_evidence", "contactable"]);

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

/** @param {any} row */
const factOf = (row) => (row ? {
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
} : null);

/** @param {any} row */
const siteOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  name: row.name,
  capability: row.capability ?? {},
  capacity: row.capacity ?? {},
  competing: row.competing ?? [],
  contacts: row.contacts ?? [],
  activatedOn: row.activated_on ?? null,
  accrualPrior: row.accrual_prior ?? {},
  verifiedAt: row.verified_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null);

/** @param {any} row */
const referralOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  assessmentId: row.assessment_id ?? null,
  siteId: row.site_id ?? null,
  subjectKey: row.subject_key,
  state: row.state,
  contactApprovedBy: row.contact_approved_by ?? null,
  contactApprovedAt: row.contact_approved_at ?? null,
  screenFailCriterionId: row.screen_fail_criterion_id ?? null,
  screenFailReason: row.screen_fail_reason ?? null,
  enrolledOn: row.enrolled_on ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
  createdAt: row.created_at,
} : null);

/** Matching, referral and follow-up rows. One store, extended from the module's shared base. */
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
      await this.audit({
        client, studyId, userId, actor: "control-plane", action: "vcr.protocol.save", object: id,
        detail: { version, criteria: saved.length },
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
           (id, study_id, protocol_version_id, user_id, subject_key, direction, as_of, summary, counts, priority, evidence_gaps, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
         ON CONFLICT (study_id, protocol_version_id, subject_key, as_of) DO UPDATE SET
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
          JSON.stringify(assessment.evidenceGaps ?? []), JSON.stringify(assessment.provenance ?? {})],
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
   * by the instant it was made as of — which is what a page, a referral and a
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

  /** The newest assessment of one subject, which is what a referral points at. */
  async latestAssessment({ studyId, subjectKey }) {
    const row = await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1 AND subject_key = $2
        ORDER BY as_of DESC, created_at DESC LIMIT 1`, [studyId, subjectKey]);
    return assessmentOf(row);
  }

  /**
   * How many subjects each summary holds, over **every** subject of the study
   * (the newest assessment of each), never over a page of them: a tally of the
   * first hundred reports a smaller cohort than there is.
   * @param {string} studyId
   */
  async assessmentTallies(studyId) {
    const rows = await this.rows(
      `SELECT summary, count(*)::int AS total FROM (SELECT DISTINCT ON (subject_key) summary FROM ${VCR_SCHEMA}.matching_assessments
         WHERE study_id = $1 ORDER BY subject_key, as_of DESC, created_at DESC) latest GROUP BY summary`, [studyId]);
    /** @type {Record<string, number>} */
    const tallies = {};
    for (const row of rows) tallies[String(row.summary)] = Number(row.total);
    return tallies;
  }

  /**
   * Every subject's pseudonymous key with its newest summary — a page's worth,
   * ordered by key. @param {string} studyId
   */
  async subjectSummaries(studyId) {
    const rows = await this.rows(
      `SELECT DISTINCT ON (subject_key) subject_key, summary FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1
        ORDER BY subject_key, as_of DESC, created_at DESC LIMIT 5000`, [studyId]);
    return rows.map((row) => ({ subjectKey: String(row.subject_key), summary: String(row.summary) }));
  }

  /**
   * What the study's subjects are missing, counted: for each (variable, reason)
   * how many subjects' newest assessment lists it — the aggregate of the gaps, not
   * the gaps of any one person. @param {string} studyId
   */
  async evidenceGapCounts(studyId) {
    const rows = await this.rows(
      `WITH latest AS (SELECT DISTINCT ON (subject_key) id, evidence_gaps FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1
          ORDER BY subject_key, as_of DESC, created_at DESC)
       SELECT g->>'variable' AS variable, g->>'reason' AS reason, count(*)::int AS n
         FROM latest, jsonb_array_elements(latest.evidence_gaps) g GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 100`, [studyId]);
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
    const facts = (await this.rows('SELECT * FROM evimed_vcr.matching_facts WHERE study_id=$1 AND id=ANY($2::text[]) ORDER BY array_position($2::text[],id)', [item.studyId,item.facts.map(row=>row.id)])).map(factOf);
    const language = (await this.rows('SELECT * FROM evimed_vcr.language_judgments WHERE study_id=$1 AND id=ANY($2::text[]) ORDER BY array_position($2::text[],id)', [item.studyId,item.language.map(row=>row.id)])).map(row=>this.correctionLanguage(row));
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

  // ---------------------------------------------------------------- facts

  /**
   * One located fact of one patient. The fact key is the sha256 of what makes it
   * *that* fact — the subject, the variable, the polarity, the value and the
   * span it was read from — so a run that writes the same reading twice writes it
   * once; the first `visible_at` stands.
   * @param {{ studyId: string, userId: string, fact: any }} input
   */
  async saveFact({ studyId, userId, fact }) {
    const key = createHash("sha256").update(JSON.stringify([
      fact.subjectKey, fact.variable, fact.polarity, fact.value ?? null, fact.unit ?? null,
      fact.source?.documentId ?? null, fact.source?.start ?? null, fact.source?.end ?? null, fact.occurredAt ?? null, fact.source?.vocabularyVersion ?? null,
    ])).digest("hex");
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.matching_facts
           (id, study_id, user_id, subject_key, fact_key, variable, value, unit, polarity, occurred_at, recorded_at, visible_at,
            surface, date_surface, source, extracted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
         ON CONFLICT (study_id, fact_key) DO UPDATE SET fact_key = EXCLUDED.fact_key RETURNING *, (xmax = 0) AS inserted`,
        [factId(), studyId, userId, fact.subjectKey, key, fact.variable, JSON.stringify(fact.value ?? null), fact.unit ?? null,
          fact.polarity ?? "affirmed", fact.occurredAt ?? null, fact.recordedAt ?? null, fact.visibleAt,
          String(fact.surface ?? ""), fact.dateSurface ?? null, fact.source ? JSON.stringify(fact.source) : null, fact.extractedBy ?? "model"]);
      const row = inserted.rows[0];
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
        ORDER BY subject_key, visible_at, id`, [studyId, subjectKey, visibleBy]);
    return rows.map(factOf);
  }

  /** The subjects that have facts, with how many. @param {string} studyId */
  async factSubjects(studyId) {
    const rows = await this.rows(
      `SELECT subject_key, count(*)::int AS facts FROM ${VCR_SCHEMA}.matching_facts WHERE study_id = $1 GROUP BY subject_key ORDER BY subject_key`, [studyId]);
    return rows.map((row) => ({ subjectKey: String(row.subject_key), facts: Number(row.facts) }));
  }

  /**
   * The answer to a language-only criterion, with its anchored quotes. Each
   * answer is its own row; the newest per (subject, criterion key) is the one
   * evaluated.
   * @param {{ studyId: string, userId: string, subjectKey: string, criterionKey: string, state: string, evidence: readonly any[] }} input
   */
  async saveLanguageJudgment({ studyId, userId, subjectKey, criterionKey, state, evidence }) {
    return this.transaction(async (client) => {
      const visibleAt = (evidence ?? []).map((/** @type {any} */ item) => Date.parse(item?.visibleAt ?? "")).filter(Number.isFinite);
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.language_judgments (id, study_id, user_id, subject_key, criterion_key, state, evidence, visible_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
        [vcrId("judgment"), studyId, userId, subjectKey, criterionKey, state, JSON.stringify(evidence ?? []),
          new Date(visibleAt.length ? Math.max(...visibleAt) : Date.now()).toISOString()]);
      await this.audit({ client, studyId, userId, actor: "runtime", action: "vcr.language_judgment.save", object: result.rows[0].id,
        detail: { subjectKey, criterionKey, state } });
      return { id: String(result.rows[0].id), subjectKey, criterionKey, state };
    });
  }

  /**
   * The newest answer per (subject, criterion key), visible by `visibleBy`.
   * @param {{ studyId: string, visibleBy?: string | null }} input
   * @returns {Promise<Map<string, Record<string, any>>>} subjectKey → { criterionKey → { state, evidence } }
   */
  async latestLanguageJudgments({ studyId, visibleBy = null }) {
    const rows = await this.rows(
      `SELECT DISTINCT ON (subject_key, criterion_key) id, subject_key, criterion_key, state, evidence
         FROM ${VCR_SCHEMA}.language_judgments
        WHERE study_id = $1 AND ($2::timestamptz IS NULL OR visible_at <= $2)
        ORDER BY subject_key, criterion_key, created_at DESC, id DESC`, [studyId, visibleBy]);
    /** @type {Map<string, Record<string, any>>} */
    const bySubject = new Map();
    for (const row of rows) {
      const entry = bySubject.get(String(row.subject_key)) ?? {};
      entry[String(row.criterion_key)] = { id: row.id, state: row.state, evidence: row.evidence ?? [] };
      bySubject.set(String(row.subject_key), entry);
    }
    return bySubject;
  }

  // --------------------------------------------------------------- sites

  /**
   * A site profile of one study. A site always belongs to a study: the
   * `study_id IS NULL` rows the old list included were readable by every
   * account, and the `ON CONFLICT (id)` update let any account overwrite
   * another's site by naming its id (review 2026-09-29, CS-35). Now the id is
   * only ever updated inside the study that holds it, and only by the account
   * that owns that study; naming a site of another study, or a study that is not
   * the caller's, answers `null`, the same as one that does not exist.
   * @param {{ site: any, userId: string }} input
   */
  async upsertSite({ site, userId }) {
    const studyId = String(site?.studyId ?? "").trim();
    if (!studyId) throw new TypeError("A site belongs to a study: site.studyId is required.");
    return this.transaction(async (client) => {
      const owned = await client.query(
        `SELECT 1 FROM ${VCR_SCHEMA}.studies WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [studyId, userId]);
      if (!owned.rowCount) return null;
      const id = site?.id ?? vcrId("site");
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.sites
           (id, study_id, user_id, name, capability, capacity, competing, contacts, activated_on, accrual_prior, verified_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, capability = EXCLUDED.capability, capacity = EXCLUDED.capacity,
           competing = EXCLUDED.competing, contacts = EXCLUDED.contacts, activated_on = EXCLUDED.activated_on,
           accrual_prior = EXCLUDED.accrual_prior, verified_at = EXCLUDED.verified_at, updated_at = now()
         WHERE ${VCR_SCHEMA}.sites.study_id = EXCLUDED.study_id
         RETURNING *`,
        [id, studyId, userId, String(site?.name ?? ""),
          JSON.stringify(site?.capability ?? {}), JSON.stringify(site?.capacity ?? {}),
          JSON.stringify(site?.competing ?? []), JSON.stringify(site?.contacts ?? []),
          site?.activatedOn ?? null, JSON.stringify(site?.accrualPrior ?? {}), site?.verifiedAt ?? null]);
      if (!result.rows[0]) return null;
      await this.audit({
        client, studyId, userId, actor: "control-plane",
        action: "vcr.site.upsert", object: id, detail: { name: site?.name ?? "" },
      });
      return siteOf(result.rows[0]);
    });
  }

  /** The sites of one study, and no other. @param {string} studyId */
  async listSites(studyId) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.sites WHERE study_id = $1 ORDER BY name`, [studyId]);
    return rows.map(siteOf);
  }

  /** @param {string} id @param {string | null} [studyId] with one, a site of another study is not found */
  async getSite(id, studyId = null) {
    return siteOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.sites WHERE id = $1 AND ($2::text IS NULL OR study_id = $2)`, [id, studyId]));
  }

  // ----------------------------------------------------------- referrals

  /**
   * A new referral, always at the start of the ledger.
   *
   * The state is `candidate` or `needs_evidence` and nothing else: what the
   * caller says is honoured only when it is one of those two. A referral is
   * created from an assessment by the control plane, and a contact state is
   * reached only by the transition a coordinator makes (AC-18) — an insert
   * that could name `contacted` would be a way around that stop. A subject with
   * a live referral in the study gets that one back, unchanged in state; only
   * `screen_failed` is terminal, so a second attempt after one is a new row.
   * The site and the assessment it names must belong to the same study.
   * @param {{ referral: any, userId: string }} input
   */
  async createReferral({ referral, userId }) {
    const state = VCR_REFERRAL_ENTRY_STATES.includes(referral?.state) ? referral.state : "candidate";
    return this.transaction(async (client) => {
      const id = referral?.id ?? vcrId("referral");
      if (referral.siteId) {
        const site = await client.query(`SELECT 1 FROM ${VCR_SCHEMA}.sites WHERE id = $1 AND study_id = $2`, [referral.siteId, referral.studyId]);
        if (!site.rowCount) throw new HttpError(400, "vcr_payload_invalid", "The referral's site is not a site of this study.");
      }
      if (referral.assessmentId) {
        const assessment = await client.query(
          `SELECT 1 FROM ${VCR_SCHEMA}.matching_assessments WHERE id = $1 AND study_id = $2`, [referral.assessmentId, referral.studyId]);
        if (!assessment.rowCount) throw new HttpError(400, "vcr_payload_invalid", "The referral's assessment is not an assessment of this study.");
      }
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.referrals (id, study_id, assessment_id, site_id, user_id, subject_key, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (study_id, subject_key) WHERE state <> 'screen_failed' DO UPDATE SET
           assessment_id = COALESCE(EXCLUDED.assessment_id, ${VCR_SCHEMA}.referrals.assessment_id),
           site_id = COALESCE(EXCLUDED.site_id, ${VCR_SCHEMA}.referrals.site_id),
           updated_at = now()
         RETURNING *`,
        [id, referral.studyId, referral.assessmentId ?? null, referral.siteId ?? null, userId,
          referral.subjectKey, state]);
      const row = result.rows[0];
      if (row.id === id) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.referral_events (id, referral_id, user_id, from_state, to_state, actor, note)
           VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
          [vcrId("event"), row.id, userId, row.state, String(referral.actor ?? ""), String(referral.note ?? "")]);
      }
      await this.audit({
        client, studyId: referral.studyId, userId, actor: String(referral.actor ?? "control-plane"),
        action: "vcr.referral.create", object: row.id, detail: { subjectKey: referral.subjectKey },
      });
      return referralOf(row);
    });
  }

  /** @param {string} id @param {string | null} [studyId] with one, a referral of another study is not found */
  async getReferral(id, studyId = null) {
    return referralOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1 AND ($2::text IS NULL OR study_id = $2)`, [id, studyId]));
  }

  /**
   * How far each referral of a study ever got, from its events: a patient who
   * was contacted and then withdrew is a patient who was contacted, and the
   * funnel that counted only where they stand now would lose every one of them
   * from the steps they passed (plan §7.2: every number has its denominator).
   * @param {string} studyId
   * @returns {Promise<Map<string, string>>} referral id → the furthest state it reached, `withdrawn` and `screen_failed` aside
   */
  async referralProgress(studyId) {
    const order = VCR_REFERRAL_STATES.filter((state) => state !== "withdrawn" && state !== "screen_failed");
    const rows = await this.rows(
      `SELECT e.referral_id, max(array_position($2::text[], e.to_state)) AS reached
         FROM ${VCR_SCHEMA}.referral_events e JOIN ${VCR_SCHEMA}.referrals r ON r.id = e.referral_id
        WHERE r.study_id = $1 GROUP BY e.referral_id`, [studyId, order]);
    /** @type {Map<string, string>} */
    const progress = new Map();
    for (const row of rows) if (row.reached != null) progress.set(String(row.referral_id), order[Number(row.reached) - 1]);
    return progress;
  }

  /** @param {{ studyId: string, state?: string|null, siteId?: string|null, limit?: number }} input */
  async listReferrals({ studyId, state = null, siteId = null, limit = 500 }) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.referrals
        WHERE study_id = $1 AND ($2::text IS NULL OR state = $2) AND ($3::text IS NULL OR site_id = $3)
        ORDER BY updated_at DESC LIMIT $4`,
      [studyId, state, siteId, Math.max(1, Math.min(5000, Number(limit) || 500))]);
    return rows.map(referralOf);
  }

  /** @param {string} referralId */
  async listReferralEvents(referralId) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.referral_events WHERE referral_id = $1 ORDER BY occurred_at, id`, [referralId]);
    return rows.map((row) => ({
      id: row.id, referralId: row.referral_id, fromState: row.from_state, toState: row.to_state,
      actor: row.actor, note: row.note, occurredAt: row.occurred_at,
    }));
  }

  /**
   * Move a referral of one study, with the decision made on the locked row.
   *
   * `guard(referral)` returns `{ ok: true, patch? }` or `{ ok: false, code,
   * message }`. It runs after the row is locked and before anything is written,
   * which is what makes the contact gate hold against two coordinators clicking
   * at once. The row is found by `(id, study_id)`: an id from another study is
   * not found, whoever asks.
   *
   * **This never writes who approved a contact.** `contact_approved_by` is
   * written by `approveContact` alone, from a session's user id; a patch that
   * carried it (the guard's, or a caller's) would let anyone name an approver
   * for a stop they never made (review 2026-09-29, CS-29). Pass `client` to run
   * inside the caller's transaction — the contact route does, so the approval,
   * the move and their events commit together or not at all.
   *
   * @param {{ referralId: string, studyId: string, to: string, actor: string, userId: string, note?: string, client?: any,
   *   guard: (referral: any) => { ok: boolean, code?: string, message?: string, patch?: Record<string, any> } }} input
   */
  async transitionReferral({ referralId, studyId, to, actor, userId, note = "", guard, client = null }) {
    if (!studyId) throw new TypeError("A referral is moved inside its study: studyId is required.");
    const work = async (/** @type {any} */ c) => {
      const locked = await c.query(`SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1 AND study_id = $2 FOR UPDATE`, [referralId, studyId]);
      const current = referralOf(locked.rows[0]);
      if (!current) return { ok: false, code: "vcr_referral_not_found", message: "找不到这条转诊记录。" };
      /** @type {(code: string | undefined, message: string | undefined) => Promise<any>} */
      const refuse = async (code, message) => {
        await this.audit({
          client: c, studyId: current.studyId, userId, actor, action: "vcr.referral.transition",
          object: referralId, outcome: "refused", reason: code ?? "refused",
          detail: { from: current.state, to },
        });
        return { ok: false, code: code ?? "vcr_referral_transition_refused", message: message ?? "", referral: current };
      };
      const decision = guard(current);
      if (!decision?.ok) return refuse(decision?.code, decision?.message);
      const patch = decision.patch ?? {};
      // A patch may name a site and a criterion, and each must be this
      // study's: the columns are foreign keys, which only prove the row exists.
      if (patch.siteId) {
        const site = await c.query(`SELECT 1 FROM ${VCR_SCHEMA}.sites WHERE id = $1 AND study_id = $2`, [patch.siteId, studyId]);
        if (!site.rowCount) return refuse("vcr_site_not_found", "这个中心不属于本研究。");
      }
      if (patch.screenFailCriterionId) {
        const criterion = await c.query(`SELECT 1 FROM ${VCR_SCHEMA}.criteria WHERE id = $1 AND study_id = $2`, [patch.screenFailCriterionId, studyId]);
        if (!criterion.rowCount) return refuse("vcr_screen_failure_needs_criterion", "筛选失败必须挂到本研究具体的入排条件上。");
      }
      const result = await c.query(
        `UPDATE ${VCR_SCHEMA}.referrals SET
           state = $3,
           site_id = COALESCE($4, site_id),
           screen_fail_criterion_id = COALESCE($5, screen_fail_criterion_id),
           screen_fail_reason = COALESCE($6, screen_fail_reason),
           enrolled_on = COALESCE($7, enrolled_on),
           updated_at = now()
         WHERE id = $1 AND study_id = $2 RETURNING *`,
        [referralId, studyId, to, patch.siteId ?? null,
          patch.screenFailCriterionId ?? null, patch.screenFailReason ?? null, patch.enrolledOn ?? null]);
      // `clock_timestamp()`, not the column's `now()`: two moves in one
      // transaction (a confirmation carries a candidate through 「可联系」 to
      // 「已联系」) would share the transaction's time and the ledger would list
      // them in id order, which is random.
      await c.query(
        `INSERT INTO ${VCR_SCHEMA}.referral_events (id, referral_id, user_id, from_state, to_state, actor, note, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
        [vcrId("event"), referralId, userId, current.state, to, actor, note]);
      await this.audit({
        client: c, studyId: current.studyId, userId, actor, action: "vcr.referral.transition",
        object: referralId, detail: { from: current.state, to },
      });
      return { ok: true, referral: referralOf(result.rows[0]) };
    };
    return client ? work(client) : this.transaction(work);
  }

  /**
   * The per-person contact confirmation (plan §10.1, AC-18). Kept apart from
   * the transition so the approval is its own audited act with its own
   * timestamp and its own name on it.
   *
   * Scoped to one study, guarded by state and idempotent. A referral of another
   * study is not found (`null`); one that is past the pre-contact states and has
   * no approval on it is refused — an approval recorded on a withdrawn or
   * failed referral would be a name on nothing; one that already carries an
   * approval is returned as it is, so a double click, a retry and a second
   * coordinator neither move the timestamp nor replace the first name.
   *
   * @param {{ referralId: string, studyId: string, approvedBy: string, userId: string, note?: string, client?: any }} input
   * @returns {Promise<ReturnType<typeof referralOf> | null>}
   */
  async approveContact({ referralId, studyId, approvedBy, userId, note = "", client = null }) {
    if (!studyId) throw new TypeError("A contact is approved inside its study: studyId is required.");
    const name = String(approvedBy ?? "").trim();
    if (!name) throw new TypeError("A contact approval carries the approver's name.");
    const work = async (/** @type {any} */ c) => {
      const locked = (await c.query(
        `SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1 AND study_id = $2 FOR UPDATE`, [referralId, studyId])).rows[0];
      if (!locked) return null;
      if (locked.contact_approved_by) return referralOf(locked);
      if (!VCR_REFERRAL_APPROVABLE_STATES.includes(locked.state)) {
        throw new HttpError(409, "vcr_referral_transition_invalid", `「${locked.state}」的转诊不能再记录联系确认。`);
      }
      const row = (await c.query(
        `UPDATE ${VCR_SCHEMA}.referrals SET contact_approved_by = $3, contact_approved_at = now(), updated_at = now()
          WHERE id = $1 AND study_id = $2 RETURNING *`, [referralId, studyId, name])).rows[0];
      await this.audit({
        client: c, studyId, userId, actor: name,
        // The coordinator's note is free text about a candidate; it is on the referral's
        // event row, which goes with the study, and an audit row outlives it.
        action: "vcr.referral.contact_approved", object: referralId, detail: { noted: String(note ?? "").trim() !== "" },
      });
      return referralOf(row);
    };
    return client ? work(client) : this.transaction(work);
  }

  /** Screen failures grouped by the criterion they were hung on (plan §7.2). */
  async screenFailureCounts(studyId) {
    const rows = await this.rows(
      `SELECT r.screen_fail_criterion_id AS criterion_id, c.ordinal, c.kind, c.criterion_type, c.source_text,
              count(*)::int AS failures
         FROM ${VCR_SCHEMA}.referrals r
         LEFT JOIN ${VCR_SCHEMA}.criteria c ON c.id = r.screen_fail_criterion_id
        WHERE r.study_id = $1 AND r.state = 'screen_failed'
        GROUP BY 1, 2, 3, 4, 5 ORDER BY failures DESC`, [studyId]);
    return rows.map((row) => ({
      criterionId: row.criterion_id, ordinal: row.ordinal ?? null, kind: row.kind ?? null,
      criterionType: row.criterion_type ?? null, sourceText: row.source_text ?? "", failures: Number(row.failures),
    }));
  }

  /** Enrolment events with their dates and sites — the actual series a forecast is checked against. */
  async enrollmentTimeline(studyId) {
    const rows = await this.rows(
      `SELECT subject_key, site_id, enrolled_on FROM ${VCR_SCHEMA}.referrals
        WHERE study_id = $1 AND state = 'enrolled' AND enrolled_on IS NOT NULL ORDER BY enrolled_on`, [studyId]);
    return rows.map((row) => ({ subjectKey: row.subject_key, siteId: row.site_id ?? null, enrolledOn: row.enrolled_on }));
  }

  /** Per-site counts of every referral state — the funnel a site card shows, with its denominator. */
  async siteFunnel(studyId) {
    const rows = await this.rows(
      `SELECT site_id, state, count(*)::int AS total FROM ${VCR_SCHEMA}.referrals
        WHERE study_id = $1 GROUP BY 1, 2`, [studyId]);
    /** @type {Map<string, any>} */
    const bySite = new Map();
    for (const row of rows) {
      const key = row.site_id ?? "";
      const entry = bySite.get(key) ?? { siteId: row.site_id ?? null, states: {}, total: 0 };
      entry.states[row.state] = Number(row.total);
      entry.total += Number(row.total);
      bySite.set(key, entry);
    }
    return [...bySite.values()];
  }

  // ------------------------------------------------------------ follow-up

  /** @param {{ episode: any, userId: string }} input */
  async saveFollowupEpisode({ episode, userId }) {
    return this.transaction(async (client) => {
      const id = episode?.id ?? vcrId("episode");
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.followup_episodes
           (id, study_id, user_id, subject_key, kind, window_start, window_end, observations, restricted, exit_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING *`,
        [id, episode.studyId, userId, episode.subjectKey, episode.kind,
          episode.windowStart ?? null, episode.windowEnd ?? null,
          JSON.stringify(episode.observations ?? []), JSON.stringify(episode.restricted ?? {}),
          episode.exitReason ?? null]);
      await this.audit({
        client, studyId: episode.studyId, userId, actor: "control-plane", action: "vcr.followup.save",
        object: id, detail: { subjectKey: episode.subjectKey, kind: episode.kind },
      });
      return episodeOf(result.rows[0]);
    });
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
