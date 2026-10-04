// One study's records, as the model analysis documents are built from them: the inputs the plan is generated
// from, the saved results the report tabulates and a frozen version of the plan. Shared by the unit suite, the
// document-export suite and the integration suite so they all describe the same study.
import { buildModelAnalysis, buildModelPlanContent, modelPlanContentHash } from "../src/vcrModelDocuments.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { VCR_REFERENCE_MODELS } from "../src/vcrService.mjs";

export const FROZEN_AT = "2026-10-04T08:00:00.000Z";

/** @type {Record<string, any>} */
export const study = {
  id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201 外部对照", question: "单臂试验能否借助外部对照？",
  dataTier: "T0", intendedUse: "specified_analysis", status: "active", outcomeSeal: {},
};

/** The catalogue's time-to-event reference simulator, as the library row a study reads. */
export const referenceModel = (() => {
  const reference = /** @type {any} */ (VCR_REFERENCE_MODELS.find((model) => model.name === "reference-time-to-event"));
  return { id: "mdl_ref", ...reference, evidence: [...reference.evidence], studyId: null, missingEvidence: [] };
})();

/** A complete assessment record for the reference simulator. @param {Record<string, any>} [more] */
export const assessment = (more = {}) => ({
  key: "survival_projection", version: 1, modelName: "reference-time-to-event", modelVersion: "1.0.0",
  questionOfInterest: "外部对照的生存基准能否用于单臂试验的比较",
  contextOfUse: "用情景模型生成对照臂的事件时间分布，作为单臂试验的比较基准",
  influence: "medium", influenceJustification: "模型结果与文献对照一起使用，不是唯一依据",
  consequence: "high", consequenceJustification: "错误的基准会让一项无效疗法进入关键试验",
  riskJustification: "后果为高而影响力为中，风险随后果",
  impact: "low", impactJustification: "加权外部对照是监管上已讨论过的做法",
  technicalCriteria: [{ criterion: "重建的曲线通过质控", rationale: "与模型风险相称" }],
  appropriateness: "情景模型覆盖研究的终点",
  evaluation: "", outcome: "",
  ...more,
});

/** The records a plan is generated from. @param {Record<string, any>} [more] */
export function modelInputs(more = {}) {
  return {
    study,
    definition: { version: 2, endpointType: "time_to_event", estimand: { kind: "ATT" }, pico: { population: "二线 NSCLC 成人" } },
    assumptions: [{
      key: "control_median", name: "对照组中位生存", version: 1, unit: "months", pointValue: 12, distribution: { kind: "normal" },
      sourceKind: "literature", valueSource: "extracted", evidenceIds: ["evd_1"], poolingMethod: "random_effects_dl", reviewState: "ai_set",
    }],
    populations: [{ id: "pop_1", kind: "scenario", version: 1, name: "场景人群", snapshotId: null, resultId: "res_pop",
      definition: { population: { variables: [{ name: "age", min: 30, max: 90 }] } } }],
    patientSets: [{ id: "pts_1", version: 1, name: "对照患者集", modelId: "reference-time-to-event", modelVersion: "1.0.0",
      scenario: { endpoint: { type: "time_to_event" } }, resultId: "res_pts" }],
    comparators: [{ id: "cmp_1", version: 1, route: "literature_control", estimand: "ATT",
      configuration: { method: "maic", endpoint: { type: "time_to_event" } }, resultId: "res_cmp" }],
    scenarios: [{ id: "scn_1", version: 1, label: "方案 A", design: "two_arm_fixed", endpointType: "time_to_event",
      assumptionIds: ["control_median"], resultId: "res_scn" }],
    models: [referenceModel],
    assessments: [assessment()],
    ...more,
  };
}

/** The study's saved results: an estimable comparison, a simulated design and one the engine declared not estimable. */
export function resultRows() {
  return [
    { id: "res_cmp", kind: "comparator", conclusion: "estimable", counts: { realPatients: 240, events: 110, effectiveSampleSize: 180 },
      measures: [{ name: "rmst_difference", value: 1.8, unit: "months", simulated: false, interval: { low: 0.4, high: 3.1, kind: "confidence", level: 0.95 } }],
      intendedUse: "design_support", useDowngrade: { requested: "specified_analysis", ceiling: "design_support", reason: "model_tier_ceiling", missingEvidence: [] } },
    { id: "res_scn", kind: "trial_scenario", conclusion: "estimable", counts: { generatedRecords: 20000 },
      measures: [{ name: "power", value: 0.812, simulated: true, mcse: 0.0027 }], intendedUse: "exploratory", useDowngrade: null },
    { id: "res_pts", kind: "patient_set", conclusion: "not_estimable", notEstimableRule: "entropy_balance_infeasible", counts: {},
      measures: [{ name: "hazard_ratio", value: null }], intendedUse: null, useDowngrade: null },
  ];
}

/** A frozen version of the plan built from `inputs`, as the store hands one back. @param {Record<string, any>} inputs @param {Record<string, any>} [more] */
export function frozenVersion(inputs, more = {}) {
  const content = buildModelPlanContent(inputs);
  return {
    version: 1, frozenAt: FROZEN_AT, frozenBy: "orchestrator", contentHash: modelPlanContentHash(content),
    sealPlanVersion: 1, sealPlanHash: "b".repeat(64), outcomeFirstReadAt: null, changes: [], issues: [], content, ...more,
  };
}

/**
 * The report model of an export of one of the two documents.
 * @param {{ inputs?: Record<string, any>, versions?: Array<Record<string, any>>, results?: Array<Record<string, any>> }} [options]
 */
export function reportModelFor({ inputs = modelInputs(), versions = [], results = resultRows() } = {}) {
  const modelAnalysis = buildModelAnalysis({ inputs, results, versions });
  return vcrReportModel({ study, definition: inputs.definition, assumptions: inputs.assumptions, results, models: [], modelAnalysis });
}
