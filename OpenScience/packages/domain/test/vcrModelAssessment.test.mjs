import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_ASSESSMENT_ROWS,
  VCR_EXPORT_KINDS,
  VCR_EXPORT_KIND_LABELS_ZH,
  VCR_HOSTED_MODEL_INTERFACES,
  VCR_MODEL_DOCUMENT_KINDS,
  VCR_MODEL_DOCUMENT_SECTIONS,
  VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH,
  VCR_MODEL_DOCUMENT_TITLES_ZH,
  VCR_MODEL_INTERFACES,
  VCR_RATINGS,
  normalizeVcrAssessment,
  vcrAssessmentGroups,
  vcrAssessmentIssues,
  vcrAssessmentRows,
  vcrEventHistoryScopeIssues,
  vcrModelCardIssues,
  vcrModelDocumentTakesProse,
  vcrModelInterfaceOf,
  vcrModelRisk,
} from "../index.mjs";

/** A complete planning-stage record. */
const complete = () => ({
  key: "survival_projection",
  modelName: "literature-weibull", modelVersion: "1.0.0",
  questionOfInterest: "试验组相对外部对照的生存获益是否足以支持关键试验设计",
  contextOfUse: "用文献模型生成外部对照的事件时间分布，作为单臂试验的比较基准",
  influence: "medium", influenceJustification: "模型结果与随机试验数据一起使用，不是唯一依据",
  consequence: "high", consequenceJustification: "错误地判断获益会让一项无效疗法进入关键试验",
  riskJustification: "后果为高而影响力为中，风险随后果",
  impact: "low", impactJustification: "加权外部对照是监管上已讨论过的做法",
  technicalCriteria: [{ criterion: "校准斜率落在预先设定的区间内", rationale: "与模型风险相称" }],
  appropriateness: "文献模型覆盖研究的人群与终点",
});

test("model risk follows M15's one stated principle and invents no matrix", () => {
  // Both low is low, both high is high (the two sentences M15 states outright).
  assert.deepEqual(vcrModelRisk("low", "low"), { risk: "low", rule: "both_low" });
  assert.deepEqual(vcrModelRisk("high", "high"), { risk: "high", rule: "both_high" });
  assert.deepEqual(vcrModelRisk("medium", "medium"), { risk: "medium", rule: "both_medium" });
  // When they differ, the more influential of the two drives it, and the record names which.
  assert.deepEqual(vcrModelRisk("medium", "high"), { risk: "high", rule: "driven_by_consequence" });
  assert.deepEqual(vcrModelRisk("high", "low"), { risk: "high", rule: "driven_by_influence" });
  assert.deepEqual(vcrModelRisk("low", "medium"), { risk: "medium", rule: "driven_by_consequence" });
  assert.deepEqual(vcrModelRisk("medium", "low"), { risk: "medium", rule: "driven_by_influence" });
  // Every one of the nine combinations answers one of the three ratings and one named rule.
  for (const influence of VCR_RATINGS) {
    for (const consequence of VCR_RATINGS) {
      const answer = vcrModelRisk(influence, consequence);
      assert.ok(answer && VCR_RATINGS.includes(answer.risk), `${influence}/${consequence}`);
      assert.equal(VCR_RATINGS.indexOf(answer.risk), Math.max(VCR_RATINGS.indexOf(influence), VCR_RATINGS.indexOf(consequence)));
    }
  }
  // A word that is not a rating gives no risk: the platform does not guess one.
  assert.equal(vcrModelRisk("none", "high"), null);
  assert.equal(vcrModelRisk(undefined, "low"), null);
  assert.equal(vcrModelRisk("", ""), null);
});

test("the record derives its risk and never takes one from the writer", () => {
  const shown = normalizeVcrAssessment({ ...complete(), risk: "low", riskRule: "both_low" });
  assert.equal(shown.risk, "high", "a typed risk is ignored; the two ratings decide");
  assert.equal(shown.riskRule, "driven_by_consequence");
  assert.deepEqual(normalizeVcrAssessment({ ...complete(), influence: "extreme" }).influence, "", "an unknown rating is dropped, not repaired");
  assert.equal(normalizeVcrAssessment({ ...complete(), influence: "extreme" }).risk, null, "so no risk is derived from it");
  const criteria = normalizeVcrAssessment({ technicalCriteria: ["  覆盖率  不低于预设  ", { criterion: "", rationale: "x" }, { criterion: "校准", rationale: "  理由 " }] }).technicalCriteria;
  assert.deepEqual(criteria, [{ criterion: "覆盖率 不低于预设", rationale: "" }, { criterion: "校准", rationale: "理由" }]);
});

test("a complete planning record has nothing to report; every gap is a notice with its field", () => {
  assert.deepEqual(vcrAssessmentIssues(complete(), "planning"), []);
  const empty = vcrAssessmentIssues({}, "planning");
  assert.deepEqual(empty.map((issue) => issue.field).sort(), [
    "appropriateness", "consequence", "contextOfUse", "impact", "influence", "questionOfInterest", "technicalCriteria",
  ]);
  // A rating with no reason is a different notice from a missing rating (M15: justification is essential).
  const noReason = vcrAssessmentIssues({ ...complete(), influenceJustification: "", riskJustification: "" });
  assert.deepEqual(noReason.map((issue) => `${issue.code}:${issue.field}`).sort(), [
    "assessment_justification_missing:influence", "assessment_justification_missing:risk",
  ]);
  const wrongWord = vcrAssessmentIssues({ ...complete(), consequence: "severe" });
  assert.deepEqual(wrongWord.map((issue) => `${issue.code}:${issue.field}`), ["assessment_rating_invalid:consequence"]);
  // The submission rows are asked for only at submission.
  assert.deepEqual(vcrAssessmentIssues(complete(), "submission").map((issue) => issue.field), ["evaluation", "outcome"]);
  assert.deepEqual(vcrAssessmentIssues({ ...complete(), evaluation: "已评价", outcome: "可作为证据" }, "submission"), []);
});

test("the table rows are M15's, in its order, and the risk row says why", () => {
  assert.deepEqual(VCR_ASSESSMENT_ROWS.map((row) => row.m15), ["2.1.1", "2.1.2", "2.1.3", "2.1.4", "2.1.5", "2.1.6", "2.2.1", "2.2.2", "2.2.3", "2.2.4"]);
  const planning = vcrAssessmentRows(complete(), "planning");
  assert.deepEqual(planning.map((row) => row.key), ["questionOfInterest", "contextOfUse", "influence", "consequence", "risk", "impact", "technicalCriteria", "appropriateness"]);
  assert.deepEqual(vcrAssessmentRows(complete(), "submission").slice(-2).map((row) => row.key), ["evaluation", "outcome"]);
  const risk = planning.find((row) => row.key === "risk");
  assert.equal(risk?.rating, "high");
  assert.match(risk?.justification ?? "", /错误决策的后果/, "the rule's sentence is in the row");
  assert.match(risk?.justification ?? "", /后果为高而影响力为中/, "and so is the author's own reasoning");
  assert.equal(planning.find((row) => row.key === "influence")?.rating, "medium");
  assert.match(planning.find((row) => row.key === "technicalCriteria")?.entry ?? "", /校准斜率.*与模型风险相称/);
});

test("one assessment table per question of interest, whichever models answer it", () => {
  const groups = vcrAssessmentGroups([
    complete(),
    { ...complete(), key: "second_model", modelName: "scenario-b", questionOfInterest: "试验组相对外部对照的生存获益是否足以支持关键试验设计 " },
    { ...complete(), key: "other_question", questionOfInterest: "入组需要多久" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].records.map((record) => record.key), ["survival_projection", "second_model"], "the same question, spelled with other whitespace, is one table");
  assert.deepEqual(groups[1].records.map((record) => record.key), ["other_question"]);
});

test("the two documents are exports with their names in full, and their prose sections are inside their structure", () => {
  assert.deepEqual([...VCR_MODEL_DOCUMENT_KINDS], ["model_analysis_plan", "model_analysis_report"]);
  for (const kind of VCR_MODEL_DOCUMENT_KINDS) assert.ok(VCR_EXPORT_KINDS.includes(kind), `${kind} is an export kind`);
  assert.equal(VCR_EXPORT_KIND_LABELS_ZH.model_analysis_plan, "模型分析计划");
  assert.equal(VCR_EXPORT_KIND_LABELS_ZH.model_analysis_report, "模型分析报告");
  assert.deepEqual({ ...VCR_MODEL_DOCUMENT_TITLES_ZH }, { model_analysis_plan: "模型分析计划", model_analysis_report: "模型分析报告" });
  // None of the identifiers is the abbreviation the engine's meta-analytic-predictive prior owns.
  for (const kind of VCR_EXPORT_KINDS) assert.ok(!/^(map|mar)$/i.test(kind), kind);
  // M15 §4.1: introduction, objectives, data, methods. Appendix 2: the eight sections of the report.
  assert.deepEqual([...VCR_MODEL_DOCUMENT_SECTIONS.model_analysis_plan.sections], ["introduction", "objectives", "data", "methods"]);
  assert.deepEqual([...VCR_MODEL_DOCUMENT_SECTIONS.model_analysis_report.sections],
    ["executive_summary", "introduction", "objectives", "data_methods", "results", "discussion", "conclusions", "appendices"]);
  for (const kind of /** @type {const} */ (["model_analysis_plan", "model_analysis_report"])) {
    const { sections, prose } = VCR_MODEL_DOCUMENT_SECTIONS[kind];
    for (const section of sections) assert.ok(/** @type {Record<string, string>} */ (VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH)[section], `${section} has a label`);
    for (const section of prose) assert.ok(sections.includes(section), `${section} is one of ${kind}'s sections`);
  }
  // The platform owns the appendices: a run may not write words there.
  assert.equal(vcrModelDocumentTakesProse("model_analysis_report", "appendices"), false);
  assert.equal(vcrModelDocumentTakesProse("model_analysis_report", "discussion"), true);
  assert.equal(vcrModelDocumentTakesProse("model_analysis_plan", "results"), false, "the plan has no results section");
  assert.equal(vcrModelDocumentTakesProse("study_package", "introduction"), false, "no other kind takes these sections");
});

/** A complete event-history card. */
const eventHistory = () => ({
  name: "event-model", version: "2.1.0", tier: "data", risk: "medium", endpointType: "time_to_event",
  card: {
    interfaceShape: "event_history_to_trajectories",
    inputs: ["诊断事件", "处方事件", "检验事件"],
    outputs: "每份历史生成 N 条未来事件轨迹：它们是预测分布的独立抽样，不是对某个人将发生什么的预报；对轨迹的汇总附蒙特卡洛误差。",
    history: { eventTypes: ["diagnosis", "prescription", "lab"], fields: ["subject", "event_type", "time"], minEvents: 3 },
    trajectories: { default: 100, max: 1000, absorbing: ["death"] },
    knownLimits: ["对罕见事件的校准较差"],
  },
  applicability: { population: "成人 2 型糖尿病，含中国人群", region: "中国", eventTypes: ["hospitalization", "death"], horizon: { max: 24, unit: "months" } },
  validation: { temporal: "截止时点之后才可见的数据上做过时间外验证", predictionIntervalCoverage: "已测" },
});

test("the second interface shape is a contract: a complete card has nothing missing, and each gap is named", () => {
  assert.deepEqual([...VCR_MODEL_INTERFACES], ["baseline_to_outcome", "event_history_to_trajectories"]);
  assert.equal(vcrModelInterfaceOf(eventHistory()), "event_history_to_trajectories");
  assert.deepEqual(vcrModelCardIssues(eventHistory()), []);
  const bare = { ...eventHistory(), card: { interfaceShape: "event_history_to_trajectories" }, applicability: {}, validation: {}, version: "" };
  const missing = vcrModelCardIssues(bare).map((issue) => issue.field);
  assert.deepEqual(missing.sort(), [
    "applicability.eventTypes", "applicability.horizon", "applicability.population", "card.history.eventTypes", "card.history.fields",
    "card.inputs", "card.knownLimits", "card.outputs", "card.trajectories.absorbing", "card.trajectories.max", "validation", "version",
  ]);
  // One at a time, so a field cannot hide behind another.
  const without = (/** @type {(model: any) => void} */ strip) => { const model = JSON.parse(JSON.stringify(eventHistory())); strip(model); return vcrModelCardIssues(model).map((issue) => issue.field); };
  assert.deepEqual(without((model) => { delete model.applicability.horizon; }), ["applicability.horizon"]);
  assert.deepEqual(without((model) => { model.applicability.horizon = { max: 24, unit: "fortnights" }; }), ["applicability.horizon"], "a horizon in a unit nobody defined is not a horizon");
  assert.deepEqual(without((model) => { model.card.trajectories.max = 0; }), ["card.trajectories.max"]);
  assert.deepEqual(without((model) => { model.validation = { declaredEvidence: ["external_validation"] }; }), ["validation"], "a declaration is not a validation");
});

test("a card with no shape is the first shape and is asked for nothing new; an unknown shape is named", () => {
  const old = { name: "reference-binary", version: "1.0.0", card: { interface: "vcr-engine patients.binary" }, applicability: { endpoints: ["binary"] } };
  assert.equal(vcrModelInterfaceOf(old), "baseline_to_outcome");
  assert.deepEqual(vcrModelCardIssues(old), []);
  assert.equal(vcrModelInterfaceOf({ card: { interfaceShape: "baseline_to_outcome" } }), "baseline_to_outcome");
  assert.equal(vcrModelInterfaceOf({ card: { interfaceShape: "quantum" } }), null);
  assert.deepEqual(vcrModelCardIssues({ card: { interfaceShape: "quantum" } }).map((issue) => issue.code), ["interface_unknown"]);
});

test("only the first shape is hosted: this module defines the second, it does not run it", () => {
  assert.deepEqual([...VCR_HOSTED_MODEL_INTERFACES], ["baseline_to_outcome"]);
});

test("the scope check holds what a study asks against the horizon, the events and the trajectory count the card declares", () => {
  const model = eventHistory();
  assert.deepEqual(vcrEventHistoryScopeIssues(model, { horizon: { value: 18, unit: "months" }, eventTypes: ["death"], trajectories: 500 }), []);
  // 2 years is 24 months: exactly the limit, in another unit, is inside it.
  assert.deepEqual(vcrEventHistoryScopeIssues(model, { horizon: { value: 2, unit: "years" } }), []);
  const far = vcrEventHistoryScopeIssues(model, { horizon: { value: 3, unit: "years" } });
  assert.deepEqual(far.map((issue) => issue.code), ["horizon_exceeded"]);
  assert.match(far[0].text, /3 years.*24 months/);
  assert.deepEqual(vcrEventHistoryScopeIssues(model, { horizon: { value: 1, unit: "fortnights" } }).map((issue) => issue.code), ["horizon_unit_unknown"]);
  assert.deepEqual(vcrEventHistoryScopeIssues(model, { eventTypes: ["death", "stroke"] }).map((issue) => issue.code), ["event_type_not_covered"]);
  assert.deepEqual(vcrEventHistoryScopeIssues(model, { trajectories: 5000 }).map((issue) => issue.code), ["trajectory_count_exceeded"]);
  // What the study does not state is not checked, and a model of the first shape has no scope of this kind.
  assert.deepEqual(vcrEventHistoryScopeIssues(model, {}), []);
  assert.deepEqual(vcrEventHistoryScopeIssues({ card: {}, applicability: { horizon: { max: 1, unit: "days" } } }, { horizon: { value: 9, unit: "years" } }), []);
});
