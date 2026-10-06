import { DEFAULT_MODULE_EVOLUTION_POLICIES } from "./defaultModuleEvolutionPolicies.mjs";
import { validateModuleEvolutionPolicy } from "./moduleEvolutionPolicies.mjs";

export const MODULE_EVOLUTION_IDS = Object.freeze(["tools", "frontier", "geo", "autopilot", "sources", "evidence", "memory", "runtime"]);
export const MODULE_CONFIRMATION_MINIMUM = Object.freeze({ frontier: 30, geo: 30, autopilot: 20, runtime: 10 });

/** An evaluator must execute the declared batch and return individually measured units.
 * No configured evaluator means unavailable, never a synthetic pass.
 * @param {{enabled?: Record<string, boolean>, policies?: any, defaults?: Record<string, any>, runners?: Record<string, (input: any) => Promise<any>>,
 * propose?: (moduleId: string, mission: any) => Promise<any>, publish?: (moduleId: string, candidate: any, result: any) => Promise<any>}} dependencies */
export function createModuleEvolutionAdapters({ enabled = {}, policies, defaults = DEFAULT_MODULE_EVOLUTION_POLICIES, runners = {}, propose, publish } = {}) {
  return Object.fromEntries(MODULE_EVOLUTION_IDS.map((moduleId) => [moduleId, {
    moduleId, evaluatorVersion:`module-${moduleId}-first-answer-v1`, enabled: enabled[moduleId] === true,
    async propose(mission) {
      if (!enabled[moduleId] || !propose) return { status: "unavailable", reason: "module_proposer_unavailable" };
      const baseline = policies ? await policies.resolve(moduleId, defaults[moduleId] ?? {}) : {revisionId: "code-default",policy: structuredClone(defaults[moduleId] ?? {})};
      return propose(moduleId, {...mission, baseline});
    },
    async prepare(candidate) {
      if (!enabled[moduleId]) return { status: "unavailable", reason: "module_disabled" };
      if (["frontier", "geo", "autopilot"].includes(moduleId) && !validateModuleEvolutionPolicy(moduleId, candidate.policy))
        return { status: "invalid", reason: "module_policy_invalid" };
      if (!["frontier","geo","autopilot"].includes(moduleId))return {status:"invalid",reason:"code-change-requires-reviewed-release-pr"};
      const baseline = policies ? await policies.resolve(moduleId, defaults[moduleId] ?? {}) : {revisionId:"code-default",policy:structuredClone(defaults[moduleId] ?? {})};
      const policy = {...baseline.policy,...candidate.policy};
      const changed = Object.keys(policy).filter((field) => JSON.stringify(policy[field]) !== JSON.stringify(baseline.policy[field]));
      if (["frontier","geo","autopilot"].includes(moduleId) && changed.length !== 1)
        return {status:"invalid",reason:"candidate_must_change_one_component"};
      if(candidate.proposal?.components?.length!==1 || candidate.proposal.components[0]!==changed[0])return {status:"invalid",reason:"declared_component_mismatch"};
      return { status: "prepared", candidate: {...structuredClone(candidate),policy}, baseline };
    },
    async smoke(input) {
      if (!enabled[moduleId] || !runners[moduleId] || !Array.isArray(input.batch) || input.batch.length < 2 || input.batch.length > 4)
        return {status:"unavailable",reason:"known_correct_smoke_missing"};
      const measured = await runners[moduleId]({...input,pool:"development",moduleId});
      return {status:"measured",passed:measured.units?.length === input.batch.length && measured.units.every((unit)=>unit.score === 1),result:measured};
    },
    async evaluate(input) {
      if (!enabled[moduleId] || !runners[moduleId]) return { status: "unavailable", reason: "module_evaluator_unavailable" };
      const batch = input.batch;
      const minimum = MODULE_CONFIRMATION_MINIMUM[moduleId] ?? 1;
      if (input.pool === "confirmation" && (!Array.isArray(batch) || batch.length < minimum))
        return { status: "unavailable", reason: "confirmation_batch_incomplete", minimum };
      const measured = await runners[moduleId]({ ...input, moduleId });
      if (!measured || !Array.isArray(measured.units) || !measured.units.length
        || measured.units.some((unit) => typeof unit.id !== "string" || !Number.isFinite(unit.score) || !unit.sourceHash))
        return { status: "unavailable", reason: "measurement_invalid" };
      if (input.pool === "confirmation" && (measured.pool !== "confirmation" || measured.units.length < minimum))
        return { status: "unavailable", reason: "confirmation_not_measured" };
      return { ...measured, status: "measured", moduleId };
    },
    async publish(candidate, result) {
      if (!enabled[moduleId] || !publish || result?.status !== "measured" || result?.pool !== "confirmation" || result?.accepted !== true)
        return { status: "unavailable", reason: "reviewed_activation_required" };
      return publish(moduleId, candidate, result);
    },
  }]));
}

/** Preserve the complete interference identity in a round's existing JSON surface.
 * Unknown engine versions are explicit strata, never guessed from an assistant's name.
 * @param {any} surface @param {string[]} engines */
export function geoInterventionIdentity(surface, engines) {
  const input = surface?.intervention ?? {};
  return {
    policyRevisionId: input.policyRevisionId ?? null, contentRevision: input.contentRevision ?? null, strategyRevision: input.strategyRevision ?? null,
    questionSetVersion: input.questionSetVersion ?? null,
    engines: engines.map((engine) => ({ engine, observedVersion: input.engineVersions?.[engine] ?? "unknown" })),
    placements: Array.isArray(input.placements) ? input.placements : [], channels: Array.isArray(input.channels) ? input.channels : [],
    sourceRevision: input.sourceRevision ?? null,
  };
}

/** Visibility attribution requires stable intervention identity; correctness is primary.
 * @param {any} baseline @param {any} candidate */
export function geoPolicyComparison(baseline, candidate) {
  const correctnessPreserved = Number.isFinite(candidate.correctness) && Number.isFinite(baseline.correctness)
    && candidate.correctness >= baseline.correctness && candidate.importantRiskOmissions === 0;
  const confounders = (identity) => ({ questionSetVersion: identity?.questionSetVersion, engines: identity?.engines,
    placements: identity?.placements, channels: identity?.channels, sourceRevision: identity?.sourceRevision });
  // Content and strategy are the intended treatment; sources, assistants and placements are confounders.
  const attributable = JSON.stringify(confounders(baseline.intervention)) === JSON.stringify(confounders(candidate.intervention))
    && !(candidate.intervention?.engines ?? []).some((engine) => engine.observedVersion === "unknown");
  return { correctnessPreserved, visibilityAttributable: attributable,
    visibilityGain: attributable ? candidate.visibility - baseline.visibility : null };
}
