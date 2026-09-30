/**
 * 「虚拟临研」's first human stop: a coordinator confirms one patient, by name,
 * before anyone outside the platform is contacted (build plan 2026-09-28 §10.1,
 * AC-18) — and the referral ledger's moves around it.
 *
 * Hidden knowledge:
 *
 * - **The stop is one transaction.** The referral row is locked for the
 *   `(id, study)` asked for, the caller's roles are read again inside that
 *   transaction, the policy decides, and the approval, the moves, their events
 *   and the audit rows commit together or not at all. Deciding on a copy read
 *   before the lock is how two coordinators both read `candidate` and both
 *   write `contacted`; deciding on roles read at the door is how a member
 *   removed a moment ago still contacts a patient.
 * - **`approvedBy` is the session's account id and only that.** It is never a
 *   field of the request: a body that could name the approver would let anyone
 *   pass the stop as somebody else, which is what the store used to allow by
 *   accepting `contactApprovedBy` in a transition's patch (CS-29). The policy
 *   (`vcrRecruit.mjs`) reads the approver off the locked row; the store writes
 *   it from `approveContact` alone; the schema refuses a contact state without
 *   one (`vcr_referrals_contact_needs_approval`).
 * - **A confirmation carries the patient through 「可联系」.** The coordinator's
 *   click on a candidate is the decision that this person may be contacted, so
 *   a `candidate` or `needs_evidence` referral is moved to `contactable` and on
 *   to `contacted` in that one act, each move with its own event under the
 *   coordinator's name. A referral already in a contact state answers as it
 *   is — a double click and a retry write nothing more.
 * - **A refusal is written before it is thrown.** The transaction rolls back
 *   whatever it had begun, and the refusal is then recorded as its own audit
 *   row, so the ledger answers 「谁试过联系谁、被谁拦下」 as well as 「谁联系了
 *   谁」. The codes are the policy's own; the HTTP status of each is fixed here.
 * - **One person may hold several roles**, and the union is what is judged
 *   (`vcrMembers.mjs`): the study lead who is also a site member is refused a
 *   site's move on a referral of another site by the site-scoped role and
 *   still contacts patients by the lead's. A refusal that names what would
 *   have to change beats one that only says a role could not.
 *
 * @module vcrContact
 */

import { VCR_CONTACT_STATES, VCR_REFERRAL_STATES, roleAllows } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { decideContactApproval, decideReferralTransition, isSiteScopedRole } from "./vcrRecruit.mjs";

/**
 * Every refusal this module answers with, and the HTTP status it is answered
 * at. The policy's codes are returned as values (`vcrRecruit.mjs`); the status
 * belongs to the transport, so it is decided here and only here.
 */
export const VCR_CONTACT_REFUSAL_STATUS = Object.freeze({
  vcr_referral_not_found: 404,
  vcr_site_not_found: 404,
  vcr_contact_role_forbidden: 403,
  vcr_referral_role_forbidden: 403,
  vcr_contact_not_approved: 403,
  vcr_contact_approval_not_per_person: 400,
  vcr_referral_state_unknown: 400,
  vcr_screen_failure_needs_criterion: 400,
  vcr_enrollment_needs_date: 400,
  vcr_referral_transition_invalid: 409,
});

/** Codes that say only that the role could not act; a more specific refusal from another role is the better answer. */
const ROLE_ONLY_REFUSALS = Object.freeze(["vcr_referral_role_forbidden", "vcr_contact_role_forbidden"]);

/** @param {{ code?: string, message?: string }} refusal */
function refusalError(refusal) {
  const code = String(refusal?.code ?? "vcr_referral_transition_invalid");
  const status = /** @type {Record<string, number>} */ (VCR_CONTACT_REFUSAL_STATUS)[code] ?? 409;
  return new HttpError(status, code, String(refusal?.message ?? code));
}

/** A refusal thrown inside a transaction so that it rolls back; caught by the act that opened it. */
class Refused extends Error {
  /** @param {{ code?: string, message?: string }} refusal */
  constructor(refusal) {
    super(String(refusal?.code ?? "refused"));
    this.refusal = refusal;
  }
}

/**
 * The first role of the caller's that lets `decide` through, or the most
 * informative refusal of the roles that did not.
 * @template {{ ok: boolean, code?: string }} T
 * @param {readonly string[]} roles @param {(role: string) => T} decide
 * @returns {T | { ok: false, code: string, message: string }}
 */
function decideAcross(roles, decide) {
  /** @type {T | null} */
  let best = null;
  for (const role of roles) {
    const decision = decide(role);
    if (decision.ok) return decision;
    const generic = ROLE_ONLY_REFUSALS.includes(String(best?.code));
    if (!best || (generic && !ROLE_ONLY_REFUSALS.includes(String(decision.code)))) best = decision;
  }
  return best ?? { ok: false, code: "vcr_referral_role_forbidden", message: "当前账号在本研究中没有角色。" };
}

/** @param {string} value */
const text = (value) => String(value ?? "").trim();

/**
 * The caller's roles in this study, and the site a site-scoped role belongs to,
 * read now. The owner is a `lead` without a member row.
 * @param {any} client @param {string} studyId @param {string} userId
 */
async function actorOf(client, studyId, userId) {
  const study = (await client.query(`SELECT user_id FROM ${VCR_SCHEMA}.studies WHERE id = $1 AND deleted_at IS NULL`, [studyId])).rows[0];
  if (!study) return { roles: /** @type {string[]} */ ([]), siteId: null, ownerId: null };
  const members = (await client.query(`SELECT role, detail FROM ${VCR_SCHEMA}.members WHERE study_id = $1 AND user_id = $2`, [studyId, userId])).rows;
  const roles = [...new Set([...(String(study.user_id) === userId ? ["lead"] : []), ...members.map((row) => String(row.role))])];
  const siteMember = members.find((row) => isSiteScopedRole(String(row.role)));
  const siteId = typeof siteMember?.detail?.siteId === "string" ? siteMember.detail.siteId : null;
  return { roles, siteId, ownerId: String(study.user_id) };
}

/** @param {any} row */
const referralView = (row) => (row ? {
  id: row.id, studyId: row.study_id, assessmentId: row.assessment_id ?? null, siteId: row.site_id ?? null,
  subjectKey: row.subject_key, state: row.state, contactApprovedBy: row.contact_approved_by ?? null,
  contactApprovedAt: row.contact_approved_at ?? null, screenFailCriterionId: row.screen_fail_criterion_id ?? null,
  screenFailReason: row.screen_fail_reason ?? null, enrolledOn: row.enrolled_on ?? null,
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null);

/**
 * The referral ledger's acts, over the matching store.
 * @param {{ store: import("./vcrMatchStore.mjs").VcrMatchStore }} parts
 */
export function createVcrContact({ store }) {
  if (!store) throw new TypeError("The contact stop needs the matching store.");

  /**
   * Record a refusal that rolled its act back.
   * @param {any} study @param {string} actor @param {string} referralId @param {string} action
   * @param {{ code?: string }} refusal @param {Record<string, unknown>} detail
   */
  async function recordRefusal(study, actor, referralId, action, refusal, detail) {
    await store.audit({
      studyId: study.id, userId: String(study.userId), actor, action, object: referralId,
      outcome: "refused", reason: String(refusal?.code ?? "refused"), detail,
    }).catch(() => {});
  }

  return {
    /**
     * Confirm one patient for contact, by the caller's name.
     *
     * @param {{ id: string | number }} user the session's account
     * @param {{ id: string, userId: string }} study the study, already resolved for this caller
     * @param {string} referralId
     * @param {{ note?: string, reason?: string }} [input]
     */
    async contactReferral(user, study, referralId, input = {}) {
      const actor = String(user.id);
      const note = [text(input.reason), text(input.note)].filter(Boolean).join("\n").slice(0, 1_500);
      try {
        return await store.transaction(async (client) => {
          const locked = (await client.query(
            `SELECT * FROM ${VCR_SCHEMA}.referrals WHERE id = $1 AND study_id = $2 FOR UPDATE`, [referralId, study.id])).rows[0];
          if (!locked) throw new Refused({ code: "vcr_referral_not_found", message: "找不到这条转诊记录。" });
          const { roles, siteId } = await actorOf(client, study.id, actor);
          const referral = /** @type {any} */ (referralView(locked));
          if (!roles.length) throw new Refused({ code: "vcr_contact_role_forbidden", message: "当前账号在本研究中没有联系患者的权限。" });

          // Already contacted with a name on it: the same answer, nothing written.
          if (VCR_CONTACT_STATES.includes(referral.state) && referral.contactApprovedBy) {
            return { ok: true, referral, alreadyContacted: true };
          }
          const approval = decideContactApproval({ referralId, approvedBy: actor, role: roles });
          if (!approval.ok) throw new Refused(/** @type {any} */ (approval));

          // What the policy says of the whole path, on a copy carrying the
          // approval it is about to be given, before anything is written.
          const hops = referral.state === "contactable" ? ["contacted"] : ["contactable", "contacted"];
          /** @type {any} */
          let simulated = { ...referral, contactApprovedBy: actor };
          for (const to of hops) {
            const decision = decideAcross(roles, (role) => decideReferralTransition({ referral: simulated, to, role, actorSiteId: siteId }));
            if (!decision.ok) throw new Refused(/** @type {any} */ (decision));
            simulated = { ...simulated, state: to };
          }

          const approved = await store.approveContact({
            referralId, studyId: study.id, approvedBy: actor, userId: String(study.userId), note, client,
          });
          /** @type {any} */
          let current = approved;
          for (const to of hops) {
            const moved = await store.transitionReferral({
              referralId, studyId: study.id, to, actor, userId: String(study.userId), note, client,
              guard: (row) => decideAcross(roles, (role) => decideReferralTransition({ referral: row, to, role, actorSiteId: siteId })),
            });
            if (!moved.ok) throw new Refused(moved);
            current = moved.referral;
          }
          await store.audit({
            client, studyId: study.id, userId: String(study.userId), actor, action: "vcr.referral.contact",
            object: referralId, detail: { from: referral.state, to: "contacted", approvedBy: actor },
          });
          return { ok: true, referral: current, alreadyContacted: false };
        });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        await recordRefusal(study, actor, referralId, "vcr.referral.contact", error.refusal, {});
        throw refusalError(error.refusal);
      }
    },

    /**
     * One move on the ledger. A move into a contact state is refused unless a
     * person has already confirmed this referral (`contactReferral`); a site
     * moves only its own referrals.
     *
     * @param {{ id: string | number }} user
     * @param {{ id: string, userId: string }} study
     * @param {string} referralId
     * @param {{ to?: unknown, note?: string, siteId?: string | null, screenFailCriterionId?: string | null,
     *   screenFailReason?: string | null, enrolledOn?: string | null }} input
     */
    async transitionReferral(user, study, referralId, input) {
      const actor = String(user.id);
      const to = String(input?.to ?? "");
      if (!VCR_REFERRAL_STATES.includes(to)) {
        throw refusalError({ code: "vcr_referral_state_unknown", message: `未知的转诊状态「${to}」。` });
      }
      /** @type {Record<string, any>} */
      const patch = {};
      if (input.siteId) patch.siteId = String(input.siteId);
      if (input.screenFailCriterionId) patch.screenFailCriterionId = String(input.screenFailCriterionId);
      if (input.screenFailReason) patch.screenFailReason = String(input.screenFailReason).slice(0, 500);
      if (input.enrolledOn) patch.enrolledOn = String(input.enrolledOn);
      const note = text(input.note).slice(0, 1_000);
      try {
        return await store.transaction(async (client) => {
          const { roles, siteId } = await actorOf(client, study.id, actor);
          if (!roles.length) throw new Refused({ code: "vcr_referral_role_forbidden", message: "当前账号在本研究中没有角色。" });
          /** @type {string[]} */
          let notices = [];
          const moved = await store.transitionReferral({
            referralId, studyId: study.id, to, actor, userId: String(study.userId), note, client,
            guard: (row) => {
              const decision = decideAcross(roles, (role) => decideReferralTransition({ referral: row, to, role, patch, actorSiteId: siteId }));
              if (decision.ok) notices = /** @type {any} */ (decision).notices ?? [];
              return decision;
            },
          });
          if (!moved.ok) throw new Refused(moved);
          return { ok: true, referral: moved.referral, notices };
        });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        await recordRefusal(study, actor, referralId, "vcr.referral.transition", error.refusal, { to });
        throw refusalError(error.refusal);
      }
    },

    /**
     * The referrals this caller may read: every one for a role that reads the
     * study, and only its own site's for a site-scoped role.
     *
     * @param {{ id: string | number }} user
     * @param {{ id: string }} study
     * @param {{ state?: string | null }} [filter]
     */
    async listReferrals(user, study, filter = {}) {
      const { roles, siteId } = await store.transaction((client) => actorOf(client, study.id, String(user.id)));
      const state = filter.state && VCR_REFERRAL_STATES.includes(filter.state) ? filter.state : null;
      if (roles.some((role) => roleAllows(role, "read"))) {
        return { referrals: await store.listReferrals({ studyId: study.id, state }) };
      }
      if (roles.some((role) => roleAllows(role, "read_referrals"))) {
        // A site-scoped account without a site sees nothing rather than everything.
        return { referrals: siteId ? await store.listReferrals({ studyId: study.id, state, siteId }) : [] };
      }
      throw new HttpError(403, "vcr_forbidden", "你在这个研究里没有读取转诊的权限。");
    },
  };
}
