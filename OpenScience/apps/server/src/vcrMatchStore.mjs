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

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** @param {any} row */
const criterionOf = (row) => (row ? {
  id: row.id,
  studyId: row.study_id,
  protocolVersionId: row.protocol_version_id,
  ordinal: Number(row.ordinal),
  kind: row.kind,
  criterionType: row.criterion_type,
  requirement: row.requirement ?? {},
  applicability: row.requirement?.applicability ?? null,
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
   * Write the structured criteria of one protocol version. Idempotent on
   * `(protocol_version_id, ordinal)`: re-running the structuring step on the
   * same version replaces line 7 rather than adding a second one.
   * @param {{ studyId: string, protocolVersionId: string, userId: string, criteria: readonly any[] }} input
   */
  async saveCriteria({ studyId, protocolVersionId, userId, criteria }) {
    return this.transaction(async (client) => {
      /** @type {any[]} */
      const saved = [];
      for (const [index, criterion] of (criteria ?? []).entries()) {
        const ordinal = Number.isInteger(criterion?.ordinal) ? criterion.ordinal : index + 1;
        const result = await client.query(
          `INSERT INTO ${VCR_SCHEMA}.criteria
             (id, study_id, protocol_version_id, user_id, ordinal, kind, criterion_type,
              requirement, source_text, source_locator, evidence_needed, review_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12)
           ON CONFLICT (protocol_version_id, ordinal) DO UPDATE SET
             kind = EXCLUDED.kind, criterion_type = EXCLUDED.criterion_type,
             requirement = EXCLUDED.requirement, source_text = EXCLUDED.source_text,
             source_locator = EXCLUDED.source_locator, evidence_needed = EXCLUDED.evidence_needed,
             review_state = EXCLUDED.review_state
           RETURNING *`,
          [criterion?.id ?? vcrId("criterion"), studyId, protocolVersionId, userId, ordinal,
            criterion?.kind === "exclusion" ? "exclusion" : "inclusion", criterion?.criterionType ?? "other",
            JSON.stringify(criterion?.requirement ?? {}), String(criterion?.sourceText ?? ""),
            JSON.stringify(criterion?.sourceLocator ?? {}), JSON.stringify(criterion?.evidenceNeeded ?? []),
            criterion?.reviewState ?? "ai_set"],
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

  /** @param {{ studyId: string, protocolVersionId?: string|null }} input */
  async listCriteria({ studyId, protocolVersionId = null }) {
    const rows = protocolVersionId
      ? await this.rows(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE study_id = $1 AND protocol_version_id = $2 ORDER BY ordinal`,
        [studyId, protocolVersionId])
      : await this.rows(`SELECT * FROM ${VCR_SCHEMA}.criteria WHERE study_id = $1 ORDER BY protocol_version_id, ordinal`, [studyId]);
    return rows.map(criterionOf);
  }

  // ---------------------------------------------------------- assessments

  /**
   * Persist one assessment and all of its judgments in one transaction.
   * @param {{ assessment: any, userId: string }} input
   */
  async saveAssessment({ assessment, userId }) {
    return this.transaction(async (client) => {
      const id = assessment?.id ?? vcrId("assessment");
      const saved = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.matching_assessments
           (id, study_id, protocol_version_id, user_id, subject_key, direction, as_of, summary, counts, priority, evidence_gaps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
         ON CONFLICT (study_id, protocol_version_id, subject_key, as_of) DO UPDATE SET
           summary = EXCLUDED.summary, counts = EXCLUDED.counts,
           priority = EXCLUDED.priority, evidence_gaps = EXCLUDED.evidence_gaps
         RETURNING *`,
        [id, assessment.studyId, assessment.protocolVersionId ?? null, userId, assessment.subjectKey,
          assessment.direction ?? "trial_to_patient", assessment.asOf, assessment.summary,
          JSON.stringify(assessment.counts ?? {}),
          assessment.priority ? JSON.stringify(assessment.priority) : null,
          JSON.stringify(assessment.evidenceGaps ?? [])],
      );
      const row = saved.rows[0];
      // Replace, never merge: a criterion dropped from the protocol must not
      // survive as a judgment nobody can trace to a line of the protocol.
      await client.query(`DELETE FROM ${VCR_SCHEMA}.criterion_judgments WHERE assessment_id = $1`, [row.id]);
      for (const judgment of assessment.judgments ?? []) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.criterion_judgments
             (id, assessment_id, criterion_id, user_id, state, applicable, decided_by, evidence, recheck_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
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

  /** @param {string} id */
  async getAssessment(id) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.matching_assessments WHERE id = $1`, [id]);
    if (!row) return null;
    const judgments = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.criterion_judgments WHERE assessment_id = $1 ORDER BY created_at, id`, [id]);
    return { ...assessmentOf(row), judgments: judgments.map(judgmentOf) };
  }

  /** @param {{ studyId: string, summary?: string|null, subjectKey?: string|null, limit?: number }} input */
  async listAssessments({ studyId, summary = null, subjectKey = null, limit = 200 }) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.matching_assessments
        WHERE study_id = $1 AND ($2::text IS NULL OR summary = $2) AND ($3::text IS NULL OR subject_key = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [studyId, summary, subjectKey, Math.max(1, Math.min(1000, Number(limit) || 200))]);
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
   * A coordinator's re-judgment of one criterion.
   *
   * It does not overwrite the state: the platform's answer and the human's
   * answer are both kept, because the pair is the evaluation case (plan §7.5).
   * @param {{ assessmentId: string, criterionId: string, state: string, by: string, note?: string, userId: string, studyId?: string }} input
   */
  async overrideJudgment({ assessmentId, criterionId, state, by, note = "", userId, studyId = null }) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.criterion_judgments
            SET override_state = $3, overridden_by = $4, override_note = $5
          WHERE assessment_id = $1 AND criterion_id = $2 RETURNING *`,
        [assessmentId, criterionId, state, by, note]);
      if (!result.rowCount) return null;
      await this.audit({
        client, studyId, userId, actor: by, action: "vcr.judgment.override",
        object: `${assessmentId}:${criterionId}`, detail: { state, note },
      });
      return judgmentOf(result.rows[0]);
    });
  }

  /** Countersign an assessment (plan §10.2: a signature, not a gate). */
  async reviewAssessment({ id, reviewedBy, userId, studyId = null }) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.matching_assessments SET reviewed_by = $2, reviewed_at = now() WHERE id = $1 RETURNING *`,
        [id, reviewedBy]);
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

  // --------------------------------------------------------------- sites

  /** @param {{ site: any, userId: string }} input */
  async upsertSite({ site, userId }) {
    return this.transaction(async (client) => {
      const id = site?.id ?? vcrId("site");
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.sites
           (id, study_id, user_id, name, capability, capacity, competing, contacts, activated_on, accrual_prior, verified_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, capability = EXCLUDED.capability, capacity = EXCLUDED.capacity,
           competing = EXCLUDED.competing, contacts = EXCLUDED.contacts, activated_on = EXCLUDED.activated_on,
           accrual_prior = EXCLUDED.accrual_prior, verified_at = EXCLUDED.verified_at, updated_at = now()
         RETURNING *`,
        [id, site?.studyId ?? null, userId, String(site?.name ?? ""),
          JSON.stringify(site?.capability ?? {}), JSON.stringify(site?.capacity ?? {}),
          JSON.stringify(site?.competing ?? []), JSON.stringify(site?.contacts ?? []),
          site?.activatedOn ?? null, JSON.stringify(site?.accrualPrior ?? {}), site?.verifiedAt ?? null]);
      await this.audit({
        client, studyId: site?.studyId ?? null, userId, actor: "control-plane",
        action: "vcr.site.upsert", object: id, detail: { name: site?.name ?? "" },
      });
      return siteOf(result.rows[0]);
    });
  }

  /** @param {string} studyId */
  async listSites(studyId) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.sites WHERE study_id = $1 OR study_id IS NULL ORDER BY name`, [studyId]);
    return rows.map(siteOf);
  }

  /** @param {string} id */
  async getSite(id) {
    return siteOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.sites WHERE id = $1`, [id]));
  }

  // ----------------------------------------------------------- referrals

  /** @param {{ referral: any, userId: string }} input */
  async createReferral({ referral, userId }) {
    return this.transaction(async (client) => {
      const id = referral?.id ?? vcrId("referral");
      const result = await client.query(
        `INSERT INTO ${VCR_SCHEMA}.referrals (id, study_id, assessment_id, site_id, user_id, subject_key, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (study_id, subject_key) DO UPDATE SET
           assessment_id = COALESCE(EXCLUDED.assessment_id, ${VCR_SCHEMA}.referrals.assessment_id),
           site_id = COALESCE(EXCLUDED.site_id, ${VCR_SCHEMA}.referrals.site_id),
           updated_at = now()
         RETURNING *`,
        [id, referral.studyId, referral.assessmentId ?? null, referral.siteId ?? null, userId,
          referral.subjectKey, referral.state ?? "candidate"]);
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

  /** @param {string} id */
  async getReferral(id) {
    return referralOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1`, [id]));
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
   * Move a referral, with the decision made on the locked row.
   *
   * `guard(referral)` returns `{ ok: true, patch? }` or `{ ok: false, code,
   * message }`. It runs after the row is locked and before anything is written,
   * which is what makes the contact gate hold against two coordinators clicking
   * at once.
   *
   * @param {{ referralId: string, to: string, actor: string, userId: string, note?: string,
   *   guard: (referral: any) => { ok: boolean, code?: string, message?: string, patch?: Record<string, any> } }} input
   */
  async transitionReferral({ referralId, to, actor, userId, note = "", guard }) {
    return this.transaction(async (client) => {
      const locked = await client.query(`SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1 FOR UPDATE`, [referralId]);
      const current = referralOf(locked.rows[0]);
      if (!current) return { ok: false, code: "vcr_referral_not_found", message: "找不到这条转诊记录。" };
      const decision = guard(current);
      if (!decision?.ok) {
        await this.audit({
          client, studyId: current.studyId, userId, actor, action: "vcr.referral.transition",
          object: referralId, outcome: "refused", reason: decision?.code ?? "refused",
          detail: { from: current.state, to },
        });
        return { ok: false, code: decision?.code ?? "vcr_referral_transition_refused", message: decision?.message ?? "", referral: current };
      }
      const patch = decision.patch ?? {};
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.referrals SET
           state = $2,
           site_id = COALESCE($3, site_id),
           contact_approved_by = COALESCE($4, contact_approved_by),
           contact_approved_at = CASE WHEN $4 IS NULL THEN contact_approved_at ELSE now() END,
           screen_fail_criterion_id = COALESCE($5, screen_fail_criterion_id),
           screen_fail_reason = COALESCE($6, screen_fail_reason),
           enrolled_on = COALESCE($7, enrolled_on),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [referralId, to, patch.siteId ?? null, patch.contactApprovedBy ?? null,
          patch.screenFailCriterionId ?? null, patch.screenFailReason ?? null, patch.enrolledOn ?? null]);
      await client.query(
        `INSERT INTO ${VCR_SCHEMA}.referral_events (id, referral_id, user_id, from_state, to_state, actor, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [vcrId("event"), referralId, userId, current.state, to, actor, note]);
      await this.audit({
        client, studyId: current.studyId, userId, actor, action: "vcr.referral.transition",
        object: referralId, detail: { from: current.state, to },
      });
      return { ok: true, referral: referralOf(result.rows[0]) };
    });
  }

  /**
   * The per-person contact confirmation (plan §10.1, AC-18). Kept apart from
   * the transition so the approval is its own audited act with its own
   * timestamp and its own name on it.
   * @param {{ referralId: string, approvedBy: string, userId: string, note?: string }} input
   */
  async approveContact({ referralId, approvedBy, userId, note = "" }) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${VCR_SCHEMA}.referrals SET contact_approved_by = $2, contact_approved_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`, [referralId, approvedBy]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      await this.audit({
        client, studyId: row.study_id, userId, actor: approvedBy,
        action: "vcr.referral.contact_approved", object: referralId, detail: { note },
      });
      return referralOf(row);
    });
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
