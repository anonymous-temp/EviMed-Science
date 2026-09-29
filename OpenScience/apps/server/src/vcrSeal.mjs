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
 *   answers `readable(...)`; the data plane (package A) is what actually
 *   refuses the columns, because that is where the rows are. A seal that only
 *   lived here would be a note, not a control.
 * - A study whose plan is frozen and whose outcomes were never read is the
 *   normal, good case: `ordered: true`, `outcomeFirstReadAt: null`.
 *
 * @module vcrSeal
 */

import { createHash } from "node:crypto";

import { VCR_INTENDED_USES, canonicalScenarioJson } from "@evimed/domain";

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
 * @param {{ store: { studyById: (id: string) => Promise<any>, updateStudy: (id: string, patch: any, actor?: string) => Promise<any>,
 *   audit?: (entry: Record<string, any>) => Promise<unknown> },
 *   dataPlane?: { sealFields?: (input: { studyId: string, fields: readonly string[], until?: string | null }) => Promise<unknown> } | null,
 *   audit?: (event: string, status: string, details: Record<string, any>) => unknown,
 *   now?: () => Date }} dependencies
 *   `dataPlane` is package A's: it is what actually withholds the columns, and
 *   without it the seal is recorded and reported as a note, never as a claim
 *   that the rows were withheld.
 */
export function createVcrSeal({ store, dataPlane = null, audit = () => {}, now = () => new Date() }) {
  if (!store) throw new TypeError("The VCR seal needs the VCR store.");

  return {
    /**
     * Freeze an analysis plan: the time, the hash, and the outcome fields the
     * data plane should withhold until it is frozen. Idempotent on an
     * unchanged plan — freezing the same bytes again keeps the first time, so
     * a retried run cannot move the timestamp forward.
     * @param {{ studyId: string, plan: Record<string, any>, sealedFields?: readonly string[], actor?: string }} input
     */
    async freezePlan(input) {
      const study = await store.studyById(String(input.studyId));
      if (!study) return null;
      const state = vcrSealState(study);
      const planHash = vcrPlanHash(input.plan ?? {});
      const at = now().toISOString();
      const sealedFields = [...new Set(list(input.sealedFields).map(String))];
      if (state.planHash === planHash && state.planFrozenAt) {
        return { ...state, unchanged: true };
      }
      const seal = {
        ...object(study.outcomeSeal),
        planFrozenAt: at,
        planHash,
        planVersion: state.planVersion + 1,
        sealedFields: sealedFields.length ? sealedFields : state.sealedFields,
        history: [...list(object(study.outcomeSeal).history), ...(state.planFrozenAt
          ? [{ planFrozenAt: state.planFrozenAt, planHash: state.planHash, planVersion: state.planVersion }] : [])].slice(-20),
      };
      const updated = await store.updateStudy(String(input.studyId), { outcomeSeal: seal }, String(input.actor ?? ""));
      if (sealedFields.length && dataPlane?.sealFields) {
        await dataPlane.sealFields({ studyId: String(input.studyId), fields: sealedFields, until: null }).catch(() => null);
      }
      await store.audit?.({ studyId: String(input.studyId), userId: study.userId, actor: String(input.actor ?? ""),
        action: "vcr.seal.freeze_plan", object: String(input.studyId), detail: { planHash, planVersion: seal.planVersion, sealedFields } });
      audit("vcr.seal.freeze_plan", "completed", { userId: study.userId, code: String(input.studyId), detail: planHash });
      return { ...vcrSealState(updated ?? { ...study, outcomeSeal: seal }), unchanged: false };
    },

    /**
     * An outcome field was read. Only the first read sets the timestamp; the
     * field list grows so the package can name what was opened.
     * @param {{ studyId: string, fields?: readonly string[], actor?: string, reason?: string }} input
     */
    async recordOutcomeAccess(input) {
      const study = await store.studyById(String(input.studyId));
      if (!study) return null;
      const seal = object(study.outcomeSeal);
      const fields = [...new Set([...list(seal.outcomeFieldsRead).map(String), ...list(input.fields).map(String)])].slice(0, 200);
      const first = typeof seal.outcomeFirstReadAt === "string" ? seal.outcomeFirstReadAt : now().toISOString();
      const updated = await store.updateStudy(String(input.studyId), {
        outcomeSeal: { ...seal, outcomeFirstReadAt: first, outcomeFieldsRead: fields },
      }, String(input.actor ?? ""));
      await store.audit?.({ studyId: String(input.studyId), userId: study.userId, actor: String(input.actor ?? ""),
        action: "vcr.seal.outcome_read", object: String(input.studyId),
        reason: String(input.reason ?? ""), detail: { fields: list(input.fields).map(String), first } });
      return vcrSealState(updated ?? { ...study, outcomeSeal: { ...seal, outcomeFirstReadAt: first, outcomeFieldsRead: fields } });
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
     * Whether an outcome field may be read at all, for the data plane to ask
     * before it opens a column.
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
