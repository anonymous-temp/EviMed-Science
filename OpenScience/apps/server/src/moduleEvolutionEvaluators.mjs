import { FrontierEditor, FRONTIER_EDIT_INSTRUCTIONS, FRONTIER_SCREEN_INSTRUCTIONS } from "./frontierEditor.mjs";
import { createModuleEvolutionPolicies } from "./moduleEvolutionPolicies.mjs";
import { quantityTokens } from "./geoJudge.mjs";
import { geoSpecifiedInfoAccuracy, FRONTIER_LANES } from "@evimed/domain";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AutopilotPlanner, buildPlannerContext, eligibleTaskTypes, plannerInstructions } from "./autopilotNextAction.mjs";

const expandVariants = (cases) => cases.flatMap((item) => [{...item,groupId:item.id}, ...(item.equivalentVariant ? [{...item,...item.equivalentVariant,id:`${item.id}:equivalent`,sourceHash:item.sourceHash,groupId:item.id,equivalentVariant:null}] : [])]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Executable wrappers use the same production classes as the existing CLI harnesses.
 * Injected model instances must carry the evolution metering identity; this never reads keys.
 * Historical cases are development only. Fresh confirmation batches must be supplied explicitly.
 * @param {{planner?: any, editor?: any, judgeFrontier?: any, geoJudge?: any, generateGeo?: any, geo?: any, sources?: any, evidence?: any, memory?: any, runtime?: any, tools?: any}} dependencies */
export function createModuleEvolutionEvaluators({ planner, editor, judgeFrontier, geoJudge, generateGeo, ...delegates } = {}) {
  /** @type {Record<string, any>} */
  const runners = { ...delegates };
  if (planner) runners.autopilot = async (input) => {
    const revision = input.arm === "baseline" ? (input.baseline ?? input.candidate) : input.candidate;
    const activePlanner = revision?.policy ? new AutopilotPlanner(planner.config, { usageLedger: planner.usageLedger,
      callModel: planner.callModel, fetchImpl: planner.fetchImpl, now: planner.now,
      policies: createModuleEvolutionPolicies({readPolicy: async () => ({revisionId: revision.revisionId ?? revision.id, policy: revision.policy})}) }) : planner;
    const cases = input.batch ?? JSON.parse(await readFile(new URL("../../../evals/autopilot-next-action/cases.json", import.meta.url), "utf8")).cases;
    const units = [];
    for (const item of expandVariants(cases)) {
      const runUnit = async () => {
      const agenda = { id: "agenda-evolution-eval", projectId: input.projectId, payload: { ...item.agenda, taskTypeState: {} } };
      const eligible = eligibleTaskTypes(agenda.payload);
      const context = buildPlannerContext({ agenda, progress: item.progress, eligible, date: item.date ?? "2026-10-04",
        trigger: item.trigger ?? "scheduled", note: item.note ?? null, reducedPriority: false,
        stopAllowed: item.stopAllowed, pauseAllowed: item.pauseAllowed === true });
      const decision = await activePlanner.decide({ userId: input.userId, projectId: input.projectId, episodeId: `${input.missionId}:${item.id}`,
        context, eligible, stopAllowed: item.stopAllowed, pauseAllowed: item.pauseAllowed === true, purpose: "evolution" });
      const score = item.expect.some((expected) => Object.entries(expected).every(([key, value]) => decision[key] === value)) ? 1 : 0;
      return { id: item.id, groupId: item.groupId ?? item.id, score, sourceHash: item.sourceHash ?? digest({ agenda: item.agenda, progress: item.progress }), executionInputHash:digest(context),
        policyRevisionId: decision.policyRevisionId, contextBytes: Buffer.byteLength(JSON.stringify(context))+Buffer.byteLength(plannerInstructions(context,revision?.policy?.plannerInstructions)), decision };
      };
      units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id, runUnit) : runUnit()));
    }
    return { pool: input.batch ? input.pool : "development", units, evaluatorVersion: "autopilot-prefix-v1", evidenceTier:"model",deterministicChecksPassed:true, policyHash: revision?.policy ? digest(revision.policy) : null, model: planner.model };
  };
  if (editor) runners.frontier = async (input) => {
    if (["confirmation","audit"].includes(input.pool) && !judgeFrontier) return {pool:"confirmation",units:[],reason:"source_fidelity_judge_unavailable"};
    const revision = input.arm === "baseline" ? (input.baseline ?? input.candidate) : input.candidate;
    const activeEditor = revision?.policy ? new FrontierEditor(editor.config, { usageLedger: editor.usageLedger, owner: editor.owner,
      callModel: editor.callModel, fetchImpl: editor.fetchImpl,
      policies: createModuleEvolutionPolicies({readPolicy: async () => ({revisionId: revision.revisionId ?? revision.id, policy: revision.policy})}) }) : editor;
    const cases = input.batch ?? JSON.parse(await readFile(new URL("../../../evals/frontier-editing/cases.json", import.meta.url), "utf8")).lane;
    const units = [];
    for (const item of expandVariants(cases)) {
      const runUnit = async () => {
      const allowedLanes = item.allowedLanes ?? [...FRONTIER_LANES];
      const confirmation = ["confirmation","audit"].includes(input.pool);
      const screened = confirmation ? null : await activeEditor.screen([{ key: "1", ...item.screen, allowedLanes }]);
      const screenLane = screened?.verdicts.get("1")?.lane ?? item.edit?.defaults?.lane ?? null;
      const edited = await activeEditor.edit({ ...item.edit, allowedLanes, defaults: { lane: screenLane } }, { singleAttempt: confirmation });
      const correctLane = item.expect ? item.expect.includes(edited.output?.lane) : Array.isArray(item.expect_not) && !item.expect_not.includes(edited.output?.lane);
      const fidelity = judgeFrontier ? await judgeFrontier({ ...input, item, original: edited.modelInput, output: edited.output, singleAttempt: true }) : null;
      const numbersCorrect = edited.numbers && edited.numbers.missing.length === 0 && edited.numbers.unitMismatches.length === 0;
      return { id: item.id, groupId: item.groupId ?? item.id, score: !item.abstentionExpected && correctLane && numbersCorrect && (!fidelity || fidelity.supported === true) && ["passed", "repaired"].includes(edited.verification) ? 1 : 0,
        sourceHash: item.sourceHash ?? edited.modelInputSha256, executionInputHash:edited.modelInputSha256, policyRevisionId: edited.editorVersion,
        slices: { lane: correctLane, numbers: Boolean(numbersCorrect), sourceFidelity: fidelity?.supported ?? null, verification: edited.verification }, contextBytes: Buffer.byteLength(edited.modelInput)+Buffer.byteLength(revision?.policy?.editInstructions??FRONTIER_EDIT_INSTRUCTIONS)+(confirmation?0:Buffer.byteLength(revision?.policy?.screenInstructions??FRONTIER_SCREEN_INSTRUCTIONS)) };
      };
      units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id, runUnit) : runUnit()));
    }
    return { pool: input.batch ? input.pool : "development", units, evaluatorVersion: "frontier-source-v1", evidenceTier: "model", deterministicChecksPassed: units.every(unit=>unit.slices?.numbers === true), checkScope: "source-fidelity-and-numeric", policyHash: revision?.policy ? digest(revision.policy) : null, model: editor.model };
  };
  if (geoJudge && generateGeo) runners.geo = async (input) => {
    if (!Array.isArray(input.batch) || !input.batch.length) return { pool: "development", units: [] };
    const units = [];
    for (const item of expandVariants(input.batch)) {
      const runUnit = async () => {
      const generated = await generateGeo({ ...input, item, policy: (input.arm === "baseline" ? (input.baseline ?? input.candidate) : input.candidate)?.policy, singleAttempt: true });
      const answer = generated.text;
      const judged = await geoJudge.judge({ ...item, answer, claims: item.claims, competitors: item.competitors ?? [], careFlags: item.careFlags ?? [],
        question: typeof item.question === "string" ? { text: item.question } : item.question,
        owner: {userId: input.userId, projectId: input.projectId}, purpose: "evolution", missionId: input.missionId });
      const reference = new Set(item.claims.flatMap((claim) => [...quantityTokens(claim.quote)]));
      const unsupported = [...quantityTokens(answer)].filter((token) => !reference.has(token));
      const accuracy = geoSpecifiedInfoAccuracy(judged.statements);
      const omitted = judged.checks.omittedSafety.length;
      return { id: item.id, groupId: item.groupId ?? item.id, sourceHash: item.sourceHash ?? digest(item.claims), executionInputHash:digest({claims:item.claims,question:item.question}),
        score: item.abstentionExpected ? (judged.refusal === true && unsupported.length === 0 && !judged.checks.offLabel.length && !judged.dropped.length ? 1 : 0) : accuracy.rate === null || unsupported.length || omitted || judged.checks.offLabel.length || judged.dropped.length ? 0 : accuracy.rate,
        slices: { correctness: accuracy.rate, importantRiskOmissions: omitted, unsupportedNumbers: unsupported.length,
          offLabel: judged.checks.offLabel.length,abstentionObserved:judged.refusal === true }, costCny: generated.costCny ?? null,
        policyRevisionId: input.candidate?.revisionId ?? null, contextBytes: generated.contextBytes ?? null };
      };
      units.push(await (input.checkpointUnit ? input.checkpointUnit(item.id, runUnit) : runUnit()));
    }
    return {pool: input.pool, units, evaluatorVersion: "geo-card-source-v1", evidenceTier: "model", deterministicChecksPassed: units.every(unit=>unit.slices?.unsupportedNumbers === 0), checkScope: "card-fidelity-and-numeric", model: geoJudge.model};
  };
  return runners;
}
