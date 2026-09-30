/**
 * Outcome sealing: making 「事先规定」 provable (build plan 2026-09-28 §6.5,
 * AC-32).
 *
 * The question every externally-controlled or confirmatory analysis is asked
 * is whether anybody looked at the outcomes before choosing the data and
 * fixing the plan. Nobody can answer it afterwards from memory, so the
 * platform records the order while it is happening: the instant the analysis
 * plan was frozen, its hash, and the instant an outcome field was first read.
 * The study package prints both, and their order is the evidence.
 *
 * Hidden knowledge:
 *
 * - **Sealing is automatic, not an approval** (§6.5). The AI freezes the plan
 *   as part of its own work; there is no extra click, and nothing is blocked.
 *   Under an exploratory intended use nothing is sealed at all — the package
 *   simply says, in so many words, that the plan was written after the
 *   outcomes were seen.
 * - **The hash is over the plan, not over the study.** It covers exactly what
 *   would have to stay the same for the freeze to mean anything: the estimand,
 *   the endpoint, the population and comparator definitions, the analysis
 *   method and the assumption versions. A later edit to any of them is a new
 *   freeze with a new hash and a new time, and the old one is kept — a seal
 *   that could be overwritten would prove nothing.
 * - **The first read is what is recorded, not every read.** `recordOutcomeAccess`
 *   is idempotent on the first timestamp: a second read does not move it, and
 *   the fields are accumulated so the package can name what was opened.
 * - **The seal decides readability, the data plane enforces it.** This module
 *   answers `readable(...)` and `vcrEffectiveSeal(...)`; the data plane and the
 *   access judge are what actually refuse the columns, because that is where the
 *   rows are — and both ask the same function, so a seal that lifted for one
 *   lifted for the other. A seal that only lived here would be a note, not a
 *   control.
 * - **The two timestamps are written under a row lock.** `outcome_seal` is one
 *   JSON value on the study row, and two runs finishing together used to read it,
 *   each add their half and write it back: the later write won and the earlier
 *   one's timestamp — the one the package cover prints — was gone. Every change
 *   is now one transaction that locks the study row, reads the seal it will
 *   change, and writes it (`mutateSeal`); the first outcome read is therefore
 *   the first one whatever the interleaving, and a retried freeze cannot move
 *   the plan's time. A store without a transaction (a unit-test double) gets the
 *   read-then-write form and says nothing more than the double can.
 * - **The seal lifts as of the instant the plan froze, not as of the instant the
 *   lift ran.** `sealed_until` is set to `planFrozenAt`, so a judgment at any
 *   later moment finds it lifted and one before it finds it standing — and a lift
 *   that failed (the plane down, the process killed) is finished by the next read,
 *   which reconciles the snapshot with the study rather than trusting the last
 *   thing that ran.
 * - A study whose plan is frozen and whose outcomes were never read is the
 *   normal, good case: `ordered: true`, `outcomeFirstReadAt: null`.
 *
 * @module vcrSeal
 */

import { createHash } from "node:crypto";

import { VCR_INTENDED_USES, canonicalScenarioJson } from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";

/** Intended uses under which outcome fields are sealed until the plan is frozen (§6.5). */
export const VCR_SEALED_USES = Object.freeze(["specified_analysis", "submission_preparation"]);

/** The fields of an analysis plan that the freeze hash covers. */
export const VCR_PLAN_FIELDS = Object.freeze([
  "estimand", "endpoint", "population", "comparator", "analysis", "assumptions", "sensitivity", "intendedUse",
]);

/** What a package's cover says when no seal was required. */
export const VCR_SEAL_EXPLORATORY_NOTE = "探索性分析：分析计划在接触结局数据之后制定，未做结局封存。";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/** Whether this intended use seals outcomes at all. @param {string} intendedUse */
export function vcrSealRequired(intendedUse) {
  return VCR_SEALED_USES.includes(String(intendedUse));
}

/**
 * The hash of an analysis plan: canonical bytes over the plan's own fields
 * only, so an unrelated edit elsewhere in the study does not read as a
 * changed plan.
 * @param {Record<string, any>} plan
 */
export function vcrPlanHash(plan) {
  /** @type {Record<string, any>} */
  const covered = {};
  for (const field of VCR_PLAN_FIELDS) if (object(plan)[field] !== undefined) covered[field] = object(plan)[field];
  return createHash("sha256").update(canonicalScenarioJson(covered)).digest("hex");
}

/**
 * The seal as a reader sees it, from a study's stored `outcome_seal`.
 * @param {{ intendedUse?: string, outcomeSeal?: Record<string, any> }} study
 */
export function vcrSealState(study) {
  const seal = object(study?.outcomeSeal);
  const required = vcrSealRequired(String(study?.intendedUse ?? "exploratory"));
  const planFrozenAt = typeof seal.planFrozenAt === "string" ? seal.planFrozenAt : null;
  const outcomeFirstReadAt = typeof seal.outcomeFirstReadAt === "string" ? seal.outcomeFirstReadAt : null;
  const frozen = planFrozenAt ? Date.parse(planFrozenAt) : Number.NaN;
  const read = outcomeFirstReadAt ? Date.parse(outcomeFirstReadAt) : Number.NaN;
  // The order holds when the plan was frozen and either nothing has been read
  // yet or the first read came after the freeze. With no freeze at all under a
  // sealed use, the order is not established — which is a fact the package
  // states, not a refusal.
  const ordered = Boolean(planFrozenAt) && (!outcomeFirstReadAt || (Number.isFinite(frozen) && Number.isFinite(read) && read >= frozen));
  return {
    required,
    planFrozenAt,
    planHash: typeof seal.planHash === "string" ? seal.planHash : null,
    planVersion: Number(seal.planVersion ?? 0) || 0,
    outcomeFirstReadAt,
    outcomeFieldsRead: list(seal.outcomeFieldsRead).map(String),
    sealedFields: list(seal.sealedFields).map(String),
    ordered,
    // Everything the page and the package cover need, in one sentence.
    note: !required ? VCR_SEAL_EXPLORATORY_NOTE
      : !planFrozenAt ? "分析计划尚未冻结：结局字段仍处于封存状态。"
        : !outcomeFirstReadAt ? `分析计划于 ${planFrozenAt} 冻结，结局字段尚未被读取。`
          : `分析计划于 ${planFrozenAt} 冻结，结局字段于 ${outcomeFirstReadAt} 首次读取。`,
    history: list(seal.history),
  };
}

/**
 * May outcome fields be read right now?
 * @param {{ intendedUse?: string, outcomeSeal?: Record<string, any> }} study
 */
export function vcrOutcomeReadable(study) {
  const state = vcrSealState(study);
  if (!state.required) return { readable: true, reason: "not_sealed" };
  if (!state.planFrozenAt) return { readable: false, reason: "plan_not_frozen" };
  return { readable: true, reason: "plan_frozen" };
}

/**
 * The columns of a snapshot's field map that are outcomes: a time-to-event pair,
 * or a measurement the map calls an outcome.
 * @param {readonly { columnName?: string, column?: string, role?: string, outcome?: boolean }[]} fieldMaps
 * @returns {string[]}
 */
export function vcrOutcomeColumns(fieldMaps) {
  return [...new Set((fieldMaps ?? [])
    .filter((map) => map.role === "outcome_time" || map.role === "outcome_event" || map.outcome === true)
    .map((map) => String(map.columnName ?? map.column ?? ""))
    .filter(Boolean))].sort();
}

/**
 * Which columns of a snapshot are sealed at `now`, decided from the study as it
 * stands — the one function the access judge and the data plane both ask.
 *
 * - A confirmatory use whose plan is not frozen (or is frozen in the future,
 *   which a clock never says but a corrupted row might): the outcome columns and
 *   whatever the snapshot already holds sealed.
 * - A confirmatory use whose plan is frozen at or before `now`: nothing. The
 *   freeze is the lift, whether or not the lift has been written to the snapshot.
 * - Any other use: only a seal with a date still ahead of it. An open-ended seal
 *   left by an earlier confirmatory use does not outlive the use that asked for it.
 *
 * @param {{ study?: { intendedUse?: string, outcomeSeal?: Record<string, any> } | null,
 *   snapshot?: { sealedFields?: readonly string[], sealedUntil?: string | null } | null,
 *   outcomeColumns?: readonly string[], now?: number }} input
 * @returns {{ sealed: Set<string>, reason: "plan_not_frozen" | "plan_frozen" | "held_until" | "not_sealed" }}
 */
export function vcrEffectiveSeal({ study, snapshot, outcomeColumns = [], now = Date.now() }) {
  const stored = new Set(snapshot?.sealedFields ?? []);
  const until = snapshot?.sealedUntil ? Date.parse(snapshot.sealedUntil) : Number.NaN;
  const required = vcrSealRequired(String(study?.intendedUse ?? "exploratory"));
  const frozenText = study?.outcomeSeal?.planFrozenAt;
  const frozen = typeof frozenText === "string" ? Date.parse(frozenText) : Number.NaN;
  if (required) {
    if (!Number.isFinite(frozen) || frozen > now) return { sealed: new Set([...stored, ...outcomeColumns]), reason: "plan_not_frozen" };
    return { sealed: new Set(), reason: "plan_frozen" };
  }
  if (stored.size && Number.isFinite(until) && until > now) return { sealed: stored, reason: "held_until" };
  return { sealed: new Set(), reason: "not_sealed" };
}

/**
 * Change a study's seal under a lock. `compute` gets the study as it stands and
 * answers the seal to write (or `null` to write nothing) and what to hand back.
 *
 * @template T
 * @param {any} store the VCR store: with a transaction the change is atomic, without one (a test double) it is read-then-write
 * @param {string} studyId
 * @param {string} actor
 * @param {(study: any) => { seal: Record<string, any> | null, result: T, audit?: Record<string, any> | null }} compute
 * @returns {Promise<T | null>} `null` when there is no such study
 */
async function mutateSeal(store, studyId, actor, compute) {
  if (typeof store.transaction === "function") {
    return store.transaction(async (/** @type {any} */ client) => {
      const found = (await client.query(
        `SELECT id, user_id, intended_use, outcome_seal FROM ${store.schema ?? VCR_SCHEMA}.studies WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [studyId])).rows[0];
      if (!found) return null;
      const study = { id: String(found.id), userId: String(found.user_id), intendedUse: String(found.intended_use), outcomeSeal: object(found.outcome_seal) };
      const { seal, result, audit } = compute(study);
      if (seal) {
        await client.query(`UPDATE ${store.schema ?? VCR_SCHEMA}.studies SET outcome_seal = $2::jsonb, updated_at = now() WHERE id = $1`,
          [studyId, JSON.stringify(seal)]);
      }
      if (audit && typeof store.audit === "function") {
        await store.audit({ client, studyId, userId: study.userId, actor, object: studyId, ...audit });
      }
      return result;
    });
  }
  const study = await store.studyById(studyId);
  if (!study) return null;
  const { seal, result, audit } = compute(study);
  if (seal) await store.updateStudy(studyId, { outcomeSeal: seal }, actor);
  if (audit) await store.audit?.({ studyId, userId: study.userId, actor, object: studyId, ...audit });
  return result;
}

/**
 * @param {{ store: any,
 *   dataPlane?: { liftStudySeal?: (input: { studyId: string, at: string, actor?: string, reason?: string }) => Promise<any[]> } | null,
 *   audit?: (event: string, status: string, details: Record<string, any>) => unknown,
 *   now?: () => Date }} dependencies
 *   `store` is the VCR store (`studyById`, `updateStudy`, `audit`, and a
 *   `transaction` when it is the real one). `dataPlane` is what actually
 *   withholds the columns; it is asked to lift, per study, as of the freeze
 *   instant. Without it the seal is recorded and reported as a note, never as a
 *   claim that rows were withheld.
 */
export function createVcrSeal({ store, dataPlane = null, audit = () => {}, now = () => new Date() }) {
  if (!store) throw new TypeError("The VCR seal needs the VCR store.");

  return {
    /**
     * Freeze an analysis plan: the time, the hash, and the lift of the seal on
     * every snapshot of the study as of that time. Idempotent on an unchanged
     * plan — freezing the same bytes again keeps the first time, so a retried run
     * cannot move the timestamp forward — but the lift is asked for again, so a
     * lift that failed the first time is finished by the retry.
     * @param {{ studyId: string, plan: Record<string, any>, sealedFields?: readonly string[], actor?: string }} input
     */
    async freezePlan(input) {
      const studyId = String(input.studyId);
      const actor = String(input.actor ?? "");
      const planHash = vcrPlanHash(input.plan ?? {});
      const at = now().toISOString();
      const named = [...new Set(list(input.sealedFields).map(String))];
      const outcome = await mutateSeal(store, studyId, actor, (study) => {
        const state = vcrSealState(study);
        if (state.planHash === planHash && state.planFrozenAt) {
          return { seal: null, result: { study, unchanged: true, planFrozenAt: state.planFrozenAt, planHash, planVersion: state.planVersion }, audit: null };
        }
        const seal = {
          ...object(study.outcomeSeal),
          planFrozenAt: at,
          planHash,
          planVersion: state.planVersion + 1,
          sealedFields: named.length ? named : state.sealedFields,
          history: [...list(object(study.outcomeSeal).history), ...(state.planFrozenAt
            ? [{ planFrozenAt: state.planFrozenAt, planHash: state.planHash, planVersion: state.planVersion }] : [])].slice(-20),
        };
        return {
          seal,
          result: { study: { ...study, outcomeSeal: seal }, unchanged: false, planFrozenAt: at, planHash, planVersion: seal.planVersion },
          audit: { action: "vcr.seal.freeze_plan", detail: { planHash, planVersion: seal.planVersion, sealedFields: seal.sealedFields } },
        };
      });
      if (!outcome) return null;
      /** @type {any[]} */
      let lifted = [];
      if (dataPlane?.liftStudySeal) {
        try {
          lifted = await dataPlane.liftStudySeal({ studyId, at: outcome.planFrozenAt, actor: actor || "platform", reason: "分析计划冻结，结局字段封存解除" });
        } catch (error) {
          // The freeze stands. The next read reconciles the snapshot with the
          // study (`vcrEffectiveSeal`), so the seal is not left holding — but
          // a failed lift is a fact somebody may need, and it is recorded.
          await store.audit?.({ studyId, userId: outcome.study.userId, actor, action: "vcr.seal.lift_failed", object: studyId,
            outcome: "failed", reason: String(/** @type {any} */ (error)?.code ?? "lift_failed") }).catch(() => null);
        }
      }
      if (!outcome.unchanged) audit("vcr.seal.freeze_plan", "completed", { userId: outcome.study.userId, code: studyId, detail: planHash });
      const sealedNow = [...new Set(lifted.flatMap((snapshot) => list(snapshot?.sealedFields).map(String)))].sort();
      return { ...vcrSealState(outcome.study), unchanged: outcome.unchanged, lifted: lifted.length, liftedFields: sealedNow };
    },

    /**
     * An outcome field was read. Only the first read sets the timestamp; the
     * field list grows so the package can name what was opened. Atomic: two reads
     * at once leave the earlier of the two as the first.
     * @param {{ studyId: string, fields?: readonly string[], actor?: string, reason?: string }} input
     */
    async recordOutcomeAccess(input) {
      const studyId = String(input.studyId);
      const actor = String(input.actor ?? "");
      const moment = now().toISOString();
      const named = list(input.fields).map(String);
      const result = await mutateSeal(store, studyId, actor, (study) => {
        const seal = object(study.outcomeSeal);
        const fields = [...new Set([...list(seal.outcomeFieldsRead).map(String), ...named])].sort().slice(0, 200);
        const first = typeof seal.outcomeFirstReadAt === "string" ? seal.outcomeFirstReadAt : moment;
        const next = { ...seal, outcomeFirstReadAt: first, outcomeFieldsRead: fields };
        const unchanged = seal.outcomeFirstReadAt === first && list(seal.outcomeFieldsRead).length === fields.length;
        return {
          seal: unchanged ? null : next,
          result: { ...study, outcomeSeal: next },
          audit: { action: "vcr.seal.outcome_read", reason: String(input.reason ?? ""), detail: { fields: named, first } },
        };
      });
      return result ? vcrSealState(result) : null;
    },

    /**
     * The two timestamps the study package prints, and whether their order is
     * what a reviewer needs to see.
     * @param {string | { id?: string, intendedUse?: string, outcomeSeal?: Record<string, any> }} study
     */
    async sealState(study) {
      const row = typeof study === "string" ? await store.studyById(study) : study;
      return row ? vcrSealState(row) : null;
    },

    /**
     * Whether an outcome field may be read at all, for a caller to ask before it
     * opens a column.
     * @param {string} studyId
     */
    async readable(studyId) {
      const study = await store.studyById(String(studyId));
      return study ? vcrOutcomeReadable(study) : { readable: false, reason: "study_not_found" };
    },
  };
}

/** Re-exported so a caller needs one import to decide a use's seal. */
export { VCR_INTENDED_USES };
