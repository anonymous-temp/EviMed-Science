// The 模型分析计划 and 模型分析报告 of a study: what the platform writes of them from the study's own records, what a
// frozen version is, what a deviation is, and that every number in the report is rendered from a saved result.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_EXPORT_KINDS } from "@evimed/domain";

import { canonicalVcrDocument } from "../src/vcrDocumentExport.mjs";
import {
  buildModelAnalysis, buildModelPlanContent, createVcrModelPlans, diffModelPlanContent, isModelDocumentKind, modelDocumentMarkdown,
  modelDocumentReaderSections, modelPlanContentHash, modelPlanIssues, renderModelDocument,
} from "../src/vcrModelDocuments.mjs";
import { renderVcrNumbers } from "../src/vcrRender.mjs";
import { FROZEN_AT, assessment, frozenVersion, modelInputs, referenceModel, reportModelFor, resultRows, study } from "./vcrModelDocumentFixtures.mjs";

/** The text between a section's heading and the next one. @param {string} markdown @param {string} title */
function sectionOf(markdown, title) {
  const start = markdown.search(new RegExp(`^## \\d+\\. ${title}$`, "m"));
  assert.ok(start >= 0, `the document has a 「${title}」 section`);
  const rest = markdown.slice(start + 1);
  const next = rest.search(/^## \d+\. /m);
  return markdown.slice(start, next < 0 ? undefined : start + 1 + next);
}

const introduction = { section: "introduction", template: "本研究评估外部对照能否作为单臂试验的比较基准。" };
const prose = [introduction, { section: "discussion", template: "平台列出的偏离已逐项说明。" }];

test("the plan's content is deterministic: the same records are the same bytes, and nothing volatile is in it", () => {
  const content = buildModelPlanContent(modelInputs());
  const hash = modelPlanContentHash(content);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(modelPlanContentHash(buildModelPlanContent(modelInputs())), hash);
  // The order the rows were read in is not the plan's.
  const reversed = modelInputs();
  reversed.populations.reverse(); reversed.assumptions.reverse(); reversed.models.reverse();
  assert.equal(modelPlanContentHash(buildModelPlanContent(reversed)), hash);
  // A review, a row id and a timestamp are not what the plan says.
  const volatile = modelInputs();
  volatile.assumptions[0] = { ...volatile.assumptions[0], reviewState: "reviewed", id: "asm_other", createdAt: "2026-10-05T00:00:00Z" };
  volatile.populations[0] = { ...volatile.populations[0], id: "pop_other" };
  assert.equal(modelPlanContentHash(buildModelPlanContent(volatile)), hash);
  // What it says is what moves it.
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  assert.notEqual(modelPlanContentHash(buildModelPlanContent(moved)), hash);
  const rated = modelInputs({ assessments: [assessment({ influence: "high" })] });
  assert.notEqual(modelPlanContentHash(buildModelPlanContent(rated)), hash);
});

test("the plan lists the models a study uses, once, from its assessment records and its patient sets, and says when the library lacks one", () => {
  const content = buildModelPlanContent(modelInputs());
  assert.deepEqual(content.models.map((model) => `${model.name}@${model.version}`), ["reference-time-to-event@1.0.0"], "named by both, listed once");
  assert.deepEqual(content.models[0].usedBy, ["assessment", "patient_set"]);
  assert.equal(content.models[0].interfaceShape, "baseline_to_outcome", "a card with no shape is the first call shape");
  assert.deepEqual(content.models[0].missingEvidence, [], "a scenario reference simulator at risk none lacks nothing");
  const unknown = buildModelPlanContent(modelInputs({ assessments: [assessment({ modelName: "private-model", modelVersion: "3.0.0" })], models: [referenceModel] }));
  const absent = unknown.models.find((model) => model.name === "private-model");
  assert.deepEqual([absent?.notInCatalogue, absent?.tier], [true, null]);
  assert.ok(modelPlanIssues(unknown).some((issue) => issue.code === "model_not_in_catalogue" && issue.ref === "private-model 3.0.0"));
});

test("a model of the event-history shape is carried with its scope and checked against what the study asks", () => {
  const eventHistory = {
    id: "mdl_eh", name: "event-model", version: "2.1.0", tier: "literature", risk: "low", endpointType: "time_to_event",
    card: { interfaceShape: "event_history_to_trajectories", type: "generative", inputs: ["诊断事件"], outputs: "N 条未来轨迹，是预测分布的抽样。",
      history: { eventTypes: ["diagnosis"], fields: ["subject", "event_type", "time"] }, trajectories: { max: 500, absorbing: ["death"] }, knownLimits: ["罕见事件校准较差"] },
    applicability: { population: "成人 2 型糖尿病", eventTypes: ["death"], horizon: { max: 24, unit: "months" }, endpoints: ["time_to_event"] },
    validation: { temporal: "时间外验证" }, evidence: [],
  };
  const content = buildModelPlanContent(modelInputs({ assessments: [assessment({ modelName: "event-model", modelVersion: "2.1.0" })], patientSets: [], models: [eventHistory] }));
  const [model] = content.models;
  assert.equal(model.interfaceShape, "event_history_to_trajectories");
  assert.deepEqual(model.scope.horizon, { max: 24, unit: "months" });
  assert.deepEqual(model.scope.eventTypes, ["death"]);
  assert.deepEqual(model.applicability, [], "a complete card that covers the study has nothing against it");
  const incomplete = buildModelPlanContent(modelInputs({ assessments: [assessment({ modelName: "event-model", modelVersion: "2.1.0" })], patientSets: [],
    models: [{ ...eventHistory, card: { interfaceShape: "event_history_to_trajectories" }, applicability: {}, validation: {} }] }));
  assert.ok(incomplete.models[0].applicability.some((issue) => issue.code === "interface_field_missing" && issue.field === "card.history.eventTypes"));
});

test("the plan's gaps are notices: an assessment's missing rows and a model with no assessment", () => {
  const bare = buildModelPlanContent(modelInputs({ assessments: [assessment({ influenceJustification: "", technicalCriteria: [] })] }));
  const issues = modelPlanIssues(bare);
  assert.ok(issues.some((issue) => issue.ref === "survival_projection" && issue.field === "technicalCriteria"));
  assert.ok(issues.some((issue) => issue.ref === "survival_projection" && issue.code === "assessment_justification_missing" && issue.field === "influence"));
  const none = modelPlanIssues(buildModelPlanContent(modelInputs({ assessments: [] })));
  assert.deepEqual(none.map((issue) => [issue.code, issue.ref]), [["assessment_missing", "reference-time-to-event 1.0.0"]], "the model is used and nobody assessed it");
});

test("what changed between two contents is a deterministic list: items added, removed, and the field of an item that moved", () => {
  const before = buildModelPlanContent(modelInputs());
  assert.deepEqual(diffModelPlanContent(before, before), []);
  assert.deepEqual(diffModelPlanContent(null, buildModelPlanContent(modelInputs())).filter((entry) => entry.change === "removed"), []);
  const after = buildModelPlanContent(modelInputs({
    assumptions: [{ ...modelInputs().assumptions[0], pointValue: 15 }, { key: "dropout", name: "脱落率", version: 1, unit: "%", pointValue: 5, distribution: {}, sourceKind: "expert_set", valueSource: "assumed", evidenceIds: [] }],
    assessments: [assessment({ influence: "low", consequence: "low" })],
    comparators: [],
  }));
  const changes = diffModelPlanContent(before, after);
  const texts = changes.map((entry) => entry.text);
  assert.ok(texts.includes("假设「对照组中位生存」的取值由 12 改为 15"), texts.join("\n"));
  assert.ok(texts.includes("假设新增：脱落率"));
  assert.ok(texts.includes("方法删去：文献对照"));
  assert.ok(texts.some((text) => text === "评估记录「survival_projection」的模型影响力由 中 改为 低"), "a rating that moved says which and from what");
  assert.ok(texts.some((text) => text === "评估记录「survival_projection」的模型风险由 高 改为 低"), "and so does the risk the platform derived from it");
  assert.equal(texts.some((text) => text.includes("riskRule")), false, "the rule behind a derived risk is not a change of its own");
  const first = diffModelPlanContent(before, after);
  assert.deepEqual(first, changes, "the same two contents always say the same thing");
  // A definition or an intended use that moved is a change too.
  const redefined = buildModelPlanContent(modelInputs({ study: { ...study, intendedUse: "design_support" } }));
  assert.ok(diffModelPlanContent(before, redefined).some((entry) => entry.section === "study" && entry.field === "intendedUse"));
});

test("with no frozen plan there is nothing to deviate from; with one, a deviation is exactly what changed since", () => {
  const unfrozen = buildModelAnalysis({ inputs: modelInputs(), results: resultRows(), versions: [] });
  assert.equal(unfrozen.plan, null);
  assert.deepEqual(unfrozen.deviations, []);
  assert.deepEqual(unfrozen.history, []);
  const version = frozenVersion(modelInputs());
  const unchanged = buildModelAnalysis({ inputs: modelInputs(), results: resultRows(), versions: [version] });
  assert.deepEqual(unchanged.deviations, [], "the records still say what the plan froze");
  assert.equal(unchanged.plan?.version, 1);
  assert.equal(unchanged.plan?.afterOutcomeRead, false);
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  const deviated = buildModelAnalysis({ inputs: moved, results: resultRows(), versions: [version] });
  assert.deepEqual(deviated.deviations.map((entry) => entry.text), ["假设「对照组中位生存」的取值由 12 改为 15"]);
  // A plan frozen after an outcome had been read says so.
  const late = buildModelAnalysis({ inputs: modelInputs(), results: [], versions: [frozenVersion(modelInputs(), { outcomeFirstReadAt: "2026-10-04T07:00:00.000Z" })] });
  assert.equal(late.plan?.afterOutcomeRead, true);
  const early = buildModelAnalysis({ inputs: modelInputs(), results: [], versions: [frozenVersion(modelInputs(), { outcomeFirstReadAt: "2026-10-04T09:00:00.000Z" })] });
  assert.equal(early.plan?.afterOutcomeRead, false, "an outcome first read after the freeze is the good order");
});

test("the plan document is M15's four sections around the freeze, with the platform's tables and the run's words", () => {
  const version = frozenVersion(modelInputs());
  const rendered = renderModelDocument("model_analysis_plan", reportModelFor({ versions: [version] }), [introduction]);
  assert.ok(rendered);
  const md = rendered.markdown;
  assert.deepEqual([...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => `${match[1]}.${match[2]}`),
    ["1.冻结信息", "2.引言", "3.目的", "4.数据", "5.方法", "6.说明"], "freeze, then introduction, objectives, data, methods");
  const freeze = sectionOf(md, "冻结信息");
  assert.match(freeze, /\| 计划版本 \| 第 1 版 \|/);
  assert.match(freeze, new RegExp(`\\| 冻结时间 \\| ${FROZEN_AT.replace(/\./g, "\\.")} \\|`));
  assert.match(freeze, /\| 冻结者 \| orchestrator \|/);
  assert.match(freeze, new RegExp(`\\| 内容哈希（sha256） \\| ${version.contentHash} \\|`));
  assert.match(freeze, /结局字段在冻结时尚未被读取/);
  assert.match(freeze, /不在内容哈希的范围内/, "the prose is said to be outside what was frozen");
  assert.match(sectionOf(md, "引言"), /本研究评估外部对照能否作为单臂试验的比较基准。/);
  assert.match(sectionOf(md, "目的"), /本节的文字尚未撰写。/, "a section the run wrote nothing for says so");
  const methods = sectionOf(md, "方法");
  for (const heading of ["所用的模型", "模型的评价方法：验证与适用性", "计划使用的方法", "模拟与情景", "模型评估表（ICH M15 附录 1 的计划阶段各行）"]) assert.ok(methods.includes(heading), heading);
  assert.match(methods, /模型影响力（Model influence） \| 中 \| 模型结果与文献对照一起使用/);
  assert.match(methods, /模型风险（Model risk） \| 高 \| 两项评级不同，模型风险随影响更大的一项——错误决策的后果。/);
  assert.doesNotMatch(methods, /模型与模型结果的评价（Evaluation/, "the submission rows belong to the report");
  assert.match(sectionOf(md, "说明"), /ICH M15/);
  assert.match(sectionOf(md, "说明"), /不是统计分析计划/);
  // The names are in full, and the engine's own abbreviation is nowhere in what a reader sees.
  assert.doesNotMatch(md, /\bMAP\b|\bMAR\b/);
});

test("an unfrozen plan is a draft and says it; a plan whose records moved after the freeze lists what moved and is itself unchanged", () => {
  const draft = renderModelDocument("model_analysis_plan", reportModelFor({ versions: [] }), [introduction])?.markdown ?? "";
  assert.match(sectionOf(draft, "冻结信息"), /尚未冻结：下面是按研究现有记录生成的草案/);
  assert.doesNotMatch(draft, /内容哈希/);
  const version = frozenVersion(modelInputs());
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  const md = renderModelDocument("model_analysis_plan", reportModelFor({ inputs: moved, versions: [version] }), [introduction])?.markdown ?? "";
  assert.match(sectionOf(md, "冻结信息"), /假设「对照组中位生存」的取值由 12 改为 15/);
  assert.match(sectionOf(md, "数据"), /\| 对照组中位生存 \| 12 months \|/, "the frozen version is what is shown: the record's later value is a change to be frozen next, not the plan");
});

test("a second version says what changed against the first, and the history lists both", () => {
  const first = frozenVersion(modelInputs());
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  const secondContent = buildModelPlanContent(moved);
  const second = { ...frozenVersion(moved), version: 2, frozenAt: "2026-10-05T08:00:00.000Z", sealPlanVersion: 2, content: secondContent, contentHash: modelPlanContentHash(secondContent),
    changes: diffModelPlanContent(first.content, secondContent) };
  const md = renderModelDocument("model_analysis_plan", reportModelFor({ inputs: moved, versions: [second, first] }), [])?.markdown ?? "";
  const freeze = sectionOf(md, "冻结信息");
  assert.match(freeze, /\| 计划版本 \| 第 2 版 \|/);
  assert.match(freeze, /与上一版相比的变化[\s\S]*假设「对照组中位生存」的取值由 12 改为 15/);
  assert.match(freeze, /冻结过的版本[\s\S]*第 2 版[\s\S]*第 1 版/);
});

test("the report names the plan it reports against and lists every deviation from it", () => {
  const version = frozenVersion(modelInputs());
  const moved = modelInputs();
  moved.assumptions[0] = { ...moved.assumptions[0], pointValue: 15 };
  const md = renderModelDocument("model_analysis_report", reportModelFor({ inputs: moved, versions: [version] }), prose)?.markdown ?? "";
  assert.deepEqual([...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => `${match[1]}.${match[2]}`),
    ["1.摘要", "2.引言", "3.目的", "4.数据与方法", "5.结果", "6.讨论", "7.结论", "8.附录"], "Appendix 2's eight sections, in order");
  const summary = sectionOf(md, "摘要");
  assert.match(summary, /计划版本 \| 第 1 版，冻结于 2026-10-04T08:00:00.000Z（冻结者：orchestrator）/);
  assert.ok(summary.includes(version.contentHash), "and the hash it was frozen under");
  assert.match(summary, /与计划的偏离 \| 1 处/);
  assert.match(sectionOf(md, "结果"), /与模型分析计划的偏离[\s\S]*- 假设「对照组中位生存」的取值由 12 改为 15/);
  assert.match(sectionOf(md, "附录"), /附录 A 模型分析计划[\s\S]*冻结时间/, "the plan is an appendix of the report (M15 4.2)");
  assert.match(sectionOf(md, "附录"), /附录 B 模型评估表[\s\S]*模型与模型结果的评价[\s\S]*证据评估的结论/, "with the two submission rows the plan lacks");
  // Unchanged records: no deviation, and the report says that rather than leaving the list out.
  const clean = renderModelDocument("model_analysis_report", reportModelFor({ versions: [version] }), prose)?.markdown ?? "";
  assert.match(sectionOf(clean, "结果"), /与第 1 版计划相比，没有偏离。/);
  // No frozen plan: the sentence the package cover prints for an exploratory analysis, in kind.
  const none = renderModelDocument("model_analysis_report", reportModelFor({ versions: [] }), prose)?.markdown ?? "";
  assert.match(sectionOf(none, "摘要"), /没有冻结的模型分析计划：这项分析是在没有事先冻结计划的情况下做的/);
  assert.match(sectionOf(none, "结果"), /没有冻结的计划，无从比较偏离。/);
});

test("every number in the report's results is rendered from a saved result, and a result the engine declared not estimable says so", () => {
  const md = renderModelDocument("model_analysis_report", reportModelFor({}), [])?.markdown ?? "";
  const results = sectionOf(md, "结果");
  assert.match(results, /\| 真实患者数 \| 240 \|/);
  assert.match(results, /\| 有效样本量 \| 180 \|/);
  assert.match(results, /\| 生成记录数 \| 20,000 \|/);
  assert.match(results, /\| RMST 差 \| 1\.8 个月 \| 置信区间 0\.400～3\.100 \|/);
  assert.match(results, /\| 功效 \| 0\.812（蒙特卡洛标准误 0\.0027） \|/, "a simulated measure carries its Monte-Carlo error");
  assert.match(results, /结论 \| 不可估计；触发的规则：/, "the rule that made it not estimable is named");
  assert.match(results, /\| 风险比 \| 不可估计 \|/, "a measure the engine did not estimate is a word, never a zero or a blank");
  assert.match(results, /结果可标注的预期用途 \| 研究设计支持（已下调：模型层级的上限）/);
  // The numbers are the results': change a result and the document changes with it, and the old number is gone.
  const changed = resultRows();
  changed[1] = { ...changed[1], measures: [{ name: "power", value: 0.912, simulated: true, mcse: 0.0021 }] };
  const after = sectionOf(renderModelDocument("model_analysis_report", reportModelFor({ results: changed }), [])?.markdown ?? "", "结果");
  assert.match(after, /0\.912（蒙特卡洛标准误 0\.0021）/);
  assert.doesNotMatch(after, /0\.812/);
  // A number the result does not carry is 未计算 where it stands, never an invented one.
  const missing = resultRows();
  missing[0] = { ...missing[0], measures: [{ name: "rmst_difference", value: undefined, simulated: false }] };
  assert.match(sectionOf(renderModelDocument("model_analysis_report", reportModelFor({ results: missing }), [])?.markdown ?? "", "结果"), /\| RMST 差 \| 未计算 \|/);
});

test("the report's tables are rendered by the module's own renderer: a cell is exactly what the renderer gives for its reference", () => {
  const model = reportModelFor({});
  const md = renderModelDocument("model_analysis_report", model, [])?.markdown ?? "";
  for (const [template, expected] of /** @type {Array<[string, string]>} */ ([
    ["{{n:modelAnalysis.results[1].measures[0]|pm}}", "0.812（蒙特卡洛标准误 0.0027）"],
    ["{{n:modelAnalysis.results[0].measures[0]|ci}}", "置信区间 0.400～3.100"],
    ["{{n:modelAnalysis.results[0].counts.realPatients|thousands}}", "240"],
  ])) {
    assert.equal(renderVcrNumbers(template, model).text, expected);
    assert.ok(md.includes(expected), `the document carries ${expected}`);
  }
});

test("what a run writes is kept: a section the document does not have follows the platform's, and a body with no section is a supplement", () => {
  const md = renderModelDocument("model_analysis_plan", reportModelFor({ versions: [frozenVersion(modelInputs())] }), [
    { section: "main", template: "补充说明的正文。" }, { section: "limitations", template: "局限的文字。" },
  ])?.markdown ?? "";
  assert.match(sectionOf(md, "补充说明"), /补充说明的正文。/);
  assert.match(sectionOf(md, "limitations"), /局限的文字。/);
  // Typed digits in a run's words are the renderer's to replace, in these documents as in every other.
  const typed = renderModelDocument("model_analysis_plan", reportModelFor({}), [{ section: "introduction", template: "样本量为 240 例。" }])?.markdown ?? "";
  assert.match(sectionOf(typed, "引言"), /样本量为 未计算 例。/);
});

test("a cell cannot break a table: a bar and a line break in a record's text stay inside their cell", () => {
  const nasty = modelInputs({ assessments: [assessment({ contextOfUse: "甲 | 乙\n丙" })] });
  const md = renderModelDocument("model_analysis_plan", reportModelFor({ inputs: nasty }), [])?.markdown ?? "";
  assert.match(md, /使用情境（Context of use） \| — \| 甲 \\\| 乙 丙 \|/);
});

test("the reader gets the document's own sections, each table its own entry, and the facts beside the words", () => {
  const rendered = renderModelDocument("model_analysis_report", reportModelFor({ versions: [frozenVersion(modelInputs())] }), prose);
  const sections = modelDocumentReaderSections(rendered?.sections ?? []);
  assert.equal(sections[0].title, "摘要");
  assert.equal(sections[0].number, "1");
  assert.ok(sections[0].facts.some((fact) => fact.label === "计划版本"));
  const tables = sections.filter((section) => section.table);
  assert.ok(tables.length >= 10, "the registers, the models and each result are tables of their own");
  assert.ok(tables.every((section) => section.table.rows.every((row) => row.length === section.table.columns.length)), "no row is ragged");
  assert.ok(sections.some((section) => section.title === "RMST 差" || section.table?.rows.some((row) => row[0] === "RMST 差")));
  assert.deepEqual(new Set(sections.map((section) => section.id)).size, sections.length, "ids are unique, so the contents list can link to each");
});

test("only the two model documents are rendered here; any other kind, or a model without the block, is left to the generic path", () => {
  assert.deepEqual(VCR_EXPORT_KINDS.filter(isModelDocumentKind), ["model_analysis_plan", "model_analysis_report"]);
  assert.equal(renderModelDocument("study_package", reportModelFor({}), prose), null);
  assert.equal(renderModelDocument("model_analysis_plan", { study }, prose), null, "an older export has no block to render");
  assert.match(modelDocumentMarkdown([{ id: "x", title: "表", blocks: [{ type: "table", columns: ["a"], rows: [["b"]] }] }]), /^## 1\. 表\n\n\| a \|\n\|---\|\n\| b \|$/);
});

/** The document of one kind from a cover, the way the export adapter builds it. @param {string} kind @param {Record<string, any>} model @param {any[]} reports */
const canonical = (kind, model, reports) => canonicalVcrDocument(study, { kind, cover: { results: model, reports } });

test("the exported document is the header the study's other packages carry, then the structure; its identity moves with a result", () => {
  for (const kind of ["model_analysis_plan", "model_analysis_report"]) {
    const model = reportModelFor({ versions: [frozenVersion(modelInputs())] });
    const document = canonical(kind, model, prose);
    const name = kind === "model_analysis_plan" ? "模型分析计划" : "模型分析报告";
    assert.equal(document.title, `EV-201 外部对照 — ${name}`);
    assert.ok(document.canonicalMarkdown.startsWith(`# EV-201 外部对照 — ${name}\n\n预期用途：`), "the same cover");
    assert.match(document.canonicalMarkdown, /## 复核与限制/);
    assert.match(document.canonicalMarkdown, /\n## 1\. /, "and then the structure");
    assert.match(document.revision, /^[a-f0-9]{64}$/);
    assert.equal(document.revision, canonical(kind, model, prose).revision, "the same inputs are the same document");
    assert.notEqual(document.revision, canonical(kind, model, [...prose, { section: "conclusions", template: "新的结论。" }]).revision);
  }
  const results = resultRows();
  results[1] = { ...results[1], measures: [{ name: "power", value: 0.912, simulated: true, mcse: 0.0021 }] };
  const a = canonical("model_analysis_report", reportModelFor({}), prose);
  const b = canonical("model_analysis_report", reportModelFor({ results }), prose);
  assert.notEqual(a.revision, b.revision, "a changed result is a changed document");
  assert.doesNotMatch(b.canonicalMarkdown, /0\.812/);
});

test("freezing writes the content, the instant and who, and passes what changed to the store; nothing is frozen for a study that is not there", async () => {
  /** @type {any[]} */
  const frozen = [];
  const store = {
    async studyById(/** @type {string} */ id) { return id === study.id ? study : null; },
    async latestDefinition() { return modelInputs().definition; },
    async assumptions() { return modelInputs().assumptions; },
    async populations() { return modelInputs().populations; },
    async patientSets() { return modelInputs().patientSets; },
    async comparatorDesigns() { return modelInputs().comparators; },
    async trialScenarios() { return modelInputs().scenarios; },
    async models() { return [referenceModel]; },
    async modelAssessments() { return [assessment()]; },
    async freezeModelPlanVersion(/** @type {any} */ input) { frozen.push(input); return { created: true, plan: { version: 1, contentHash: input.contentHash } }; },
  };
  const plans = createVcrModelPlans({ store, now: () => new Date(FROZEN_AT) });
  const done = await plans.freeze({ studyId: study.id, actor: "runtime", seal: { planVersion: 2, planHash: "c".repeat(64), outcomeFirstReadAt: null } });
  assert.deepEqual([done?.created, done?.plan.version], [true, 1]);
  const [call] = frozen;
  assert.equal(call.frozenAt, FROZEN_AT, "the instant is the clock's unless the caller says one");
  assert.equal(call.frozenBy, "runtime");
  assert.deepEqual([call.sealPlanVersion, call.sealPlanHash], [2, "c".repeat(64)]);
  assert.equal(call.contentHash, modelPlanContentHash(call.content));
  assert.deepEqual(call.diff(buildModelPlanContent(modelInputs())), [], "against the same content nothing changed");
  assert.equal((await plans.freeze({ studyId: "std_other", actor: "runtime" })), null);
  assert.equal((await plans.freeze({ studyId: study.id, frozenAt: "2026-10-04T07:00:00.000Z" }))?.created, true);
  assert.equal(frozen[1].frozenAt, "2026-10-04T07:00:00.000Z", "the seal's own instant, when it has one");
  assert.equal(frozen[1].frozenBy, "platform", "and a freeze nobody claims is the platform's");
});
