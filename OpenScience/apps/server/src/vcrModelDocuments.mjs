/**
 * The 模型分析计划 and the 模型分析报告 of a 「虚拟临研」 study (ICH M15 §4,
 * Appendix 2): what the platform writes of them, and the moment it freezes the
 * first.
 *
 * Hidden knowledge:
 *
 * - **The structure, the tables and every number are the platform's; a run
 *   writes the words between them.** The plan is generated from the study's own
 *   records — the definition, the models and their cards, the assessment
 *   records, the assumptions and the evidence behind them, the planned methods
 *   and the scenarios — and the report from the same records plus the saved
 *   results. A run supplies prose for the sections that need an author
 *   (`VCR_MODEL_DOCUMENT_SECTIONS`), through the `vcr-package` capability and the
 *   report write every export already uses. Nothing it writes can replace a
 *   table.
 * - **Every number in the report is rendered from a saved result by the module's
 *   renderer (`vcrRender.mjs`).** A results table is a template of
 *   `{{n:modelAnalysis.results[i].measures[j]|…}}` references into the
 *   report model, resolved by the same code that resolves a run's prose; this
 *   file never formats a result itself. A result the engine declared not
 *   estimable is printed as 「不可估计」 with the rule that triggered it, never as a
 *   blank or a zero, and a reference that does not resolve prints 「未计算」 the way
 *   it does everywhere. The numbers the plan itself carries — an assumption's
 *   value, a model's stated limits — are the records' own text, written by the
 *   platform from the rows and not typed into prose.
 * - **Frozen means a row and a trigger, not a flag.** A plan version is a content
 *   hash, the instant, and who froze it, written at the moment `vcrSeal` freezes
 *   the analysis plan — before a sealed outcome is opened — and a version is
 *   never edited (the table refuses an UPDATE). Freezing the same content again
 *   is a no-op, so a retried run cannot move the time; changed content is the
 *   next version with a list of what changed against the one before.
 * - **Prose is outside the hash.** The words a run writes for a section are
 *   written after the freeze, in the export run; the hash covers the structure
 *   and the registers, which is what a reader needs to be sure did not move. The
 *   document says so rather than implying the prose was frozen.
 * - **The report names the plan it reports against and lists every deviation.**
 *   The deviations are a deterministic diff of the frozen content against the
 *   records as they stand now; the run is asked to justify each in the
 *   discussion (M15 Appendix 2). A study with no frozen plan says so, and then
 *   there is nothing to deviate from — the same plain sentence the package
 *   cover prints for an exploratory analysis.
 * - **Nothing here withholds.** Gaps are printed as 「未填写」 and 「未计算」; a
 *   missing assessment is a row that says it is missing; a failed freeze is
 *   logged and the analysis plan's own freeze stands.
 * - **The documents carry ICH's attribution** and say they are not a statistical
 *   analysis plan.
 *
 * @module vcrModelDocuments
 */

import { createHash } from "node:crypto";

import {
  VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH, VCR_COMPARATOR_ROUTE_LABELS_ZH, VCR_CONCLUSION_LABELS_ZH, VCR_COUNT_KEYS, VCR_ENDPOINT_TYPE_LABELS_ZH,
  VCR_ESTIMAND_LABELS_ZH, VCR_INTENDED_USE_LABELS_ZH, VCR_MODEL_DOCUMENT_ATTRIBUTION_ZH, VCR_MODEL_DOCUMENT_SECTIONS,
  VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH, VCR_MODEL_INTERFACE_LABELS_ZH, VCR_MODEL_RISK_EVIDENCE,
  VCR_MODEL_RISK_LABELS_ZH, VCR_MODEL_TIER_LABELS_ZH, VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_RATING_LABELS_ZH, VCR_TRIAL_DESIGN_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH, canonicalScenarioJson, missingModelEvidence, normalizeVcrAssessment, vcrAssessmentGroups, vcrAssessmentIssues,
  vcrAssessmentRows, vcrModelInterfaceOf,
} from "@evimed/domain";

import { vcrModelApplicabilityIssues, vcrPopulationVariables } from "./vcrModelApplicability.mjs";
import { renderVcrNumbers } from "./vcrRender.mjs";
import { evidenceLabel, list, measureValue, measureLabel, numeric, object, text, VALIDATION_LABELS } from "./vcrViewsKit.mjs";

/** The shape of the frozen content, so a reader of an old row knows what it holds. */
export const VCR_MODEL_PLAN_CONTENT_SCHEMA = 1;

/** The kinds of result a model analysis report tabulates (a match or a profile is not a model result). */
const REPORTED_RESULT_KINDS = Object.freeze(["population", "patient_set", "comparator", "trial_scenario", "accrual_forecast", "evidence_pool", "design_grid"]);
const RESULT_KIND_LABELS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "人群", patient_set: "虚拟患者集", comparator: "对照", trial_scenario: "试验方案", accrual_forecast: "入组预测",
  evidence_pool: "证据汇总", design_grid: "方案网格",
}));

/** What a diff entry's section is called. */
const SECTION_LABELS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  study: "研究", definition: "研究定义", data: "数据", models: "模型", assessments: "评估记录", assumptions: "假设", methods: "方法", scenarios: "情景",
}));
const FIELD_LABELS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  question: "研究问题", intendedUse: "预期用途", dataTier: "数据档位", endpointType: "终点类型", estimand: "估计目标", pico: "PICO",
  tier: "层级", declaredRisk: "声明的风险", interfaceShape: "接口形状", value: "取值", unit: "单位", distribution: "分布", sourceKind: "来源类别",
  valueSource: "取值来源", evidenceIds: "证据", pooling: "合并方法", route: "路线", method: "方法", endpoint: "终点", settings: "设置项",
  design: "设计", endpointTypeLabel: "终点", assumptions: "引用的假设", questionOfInterest: "关注的问题", contextOfUse: "使用情境", influence: "模型影响力",
  consequence: "错误决策的后果", impact: "模型冲击", risk: "模型风险", technicalCriteria: "技术标准", appropriateness: "适当性",
  influenceJustification: "影响力的理由", consequenceJustification: "后果的理由", riskJustification: "风险的理由", impactJustification: "冲击的理由",
  modelName: "模型", modelVersion: "模型版本", snapshotId: "数据快照", model: "所用模型", name: "名称",
}));

// ---------------------------------------------------------------------------
// Reading the records
// ---------------------------------------------------------------------------

/**
 * Everything the plan is generated from, read once.
 * @param {any} store the VCR store (or a snapshot of it)
 * @param {Record<string, any>} study
 */
export async function readModelAnalysisInputs(store, study) {
  const [definition, assumptions, populations, patientSets, comparators, scenarios, models, assessments] = await Promise.all([
    store.latestDefinition(study.id), store.assumptions(study.id), store.populations(study.id, 50), store.patientSets(study.id, 50),
    store.comparatorDesigns(study.id, 50), store.trialScenarios(study.id, 60), store.models(study.userId), store.modelAssessments(study.id),
  ]);
  return { study, definition, assumptions, populations, patientSets, comparators, scenarios, models, assessments };
}

/**
 * The newest version of each thing, by an identity that survives a new version.
 * @template T @param {readonly T[]} rows @param {(row: T) => string} identity
 * @returns {T[]}
 */
function latestBy(rows, identity) {
  /** @type {Map<string, T>} */
  const newest = new Map();
  for (const row of rows ?? []) {
    const key = identity(row);
    const held = newest.get(key);
    if (!held || Number(/** @type {any} */ (row).version ?? 0) > Number(/** @type {any} */ (held).version ?? 0)) newest.set(key, row);
  }
  return [...newest.values()];
}

/** @param {readonly string[]} values */
const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** @param {unknown} value */
const words = (value) => list(value).map((entry) => String(entry ?? "").trim()).filter(Boolean);

/**
 * A validation entry as a line, or null when it says nothing a reader can use.
 * @param {unknown} value
 */
function validationText(value) {
  if (value === true) return "已完成";
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * The models the study uses, resolved against the library: the ones its
 * assessment records name and the ones its patient sets name. A model the
 * library does not hold is listed as such, never dropped.
 * @param {Record<string, any>} inputs
 */
function usedModels(inputs) {
  const library = list(inputs.models);
  /** @param {string} ref @param {string} version */
  const find = (ref, version) => {
    const byId = library.filter((model) => model.id === ref && (!version || model.version === version));
    return (byId.length ? byId : library.filter((model) => model.name === ref && (!version || model.version === version)))[0] ?? null;
  };
  /** @type {Map<string, { model: any, name: string, version: string, usedBy: Set<string> }>} */
  const used = new Map();
  /** @param {string} ref @param {string} version @param {string} by */
  const add = (ref, version, by) => {
    if (!ref) return;
    const model = find(ref, version);
    const name = model ? String(model.name) : ref;
    const exactVersion = model ? String(model.version) : version;
    const key = `${name}@${exactVersion}`;
    const held = used.get(key) ?? { model, name, version: exactVersion, usedBy: new Set() };
    held.usedBy.add(by);
    used.set(key, held);
  };
  for (const record of list(inputs.assessments)) add(String(record.modelName ?? ""), String(record.modelVersion ?? ""), "assessment");
  for (const set of latestBy(list(inputs.patientSets), (row) => String(row.name || "set"))) add(String(set.modelId ?? ""), String(set.modelVersion ?? ""), "patient_set");
  return [...used.values()].sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The plan's content (what is hashed and frozen)
// ---------------------------------------------------------------------------

/**
 * One model as the plan lists it: its card in the order a reader needs it, the
 * evidence it holds against the risk it declares, and whether it covers this
 * study.
 * @param {{ model: any, name: string, version: string, usedBy: Set<string> }} entry
 * @param {{ endpointType: string | null, variables: Map<string, { min: number | null, max: number | null }> }} study
 */
function modelEntry({ model, name, version, usedBy }, study) {
  if (!model) return { name, version, tier: null, notInCatalogue: true, usedBy: sorted([...usedBy]) };
  const card = object(model.card);
  const applicability = object(model.applicability);
  const validation = object(model.validation);
  const held = list(model.evidence).map(String);
  return {
    name: String(model.name), version: String(model.version), tier: String(model.tier), declaredRisk: String(model.risk ?? "none"),
    interfaceShape: vcrModelInterfaceOf(model) ?? "unknown",
    type: text(card.type), provider: text(card.provider),
    inputs: words(card.inputs), outputs: text(card.outputs), missingData: text(card.missingData),
    history: Object.keys(object(card.history)).length ? object(card.history) : null,
    trajectories: Object.keys(object(card.trajectories)).length ? object(card.trajectories) : null,
    scope: {
      population: text(applicability.population), region: text(applicability.region), endpoints: words(applicability.endpoints),
      timeRange: text(applicability.timeRange), inputRange: text(applicability.inputRange), sources: words(applicability.sources),
      eventTypes: words(applicability.eventTypes), horizon: Object.keys(object(applicability.horizon)).length ? object(applicability.horizon) : null,
    },
    validation: Object.entries(validation).filter(([key]) => key !== "declaredEvidence")
      .map(([key, value]) => ({ key, value: validationText(value) })).filter((row) => row.value).sort((a, b) => (a.key < b.key ? -1 : 1)),
    knownLimits: words(card.knownLimits),
    evidence: sorted(held), declaredEvidence: sorted(words(validation.declaredEvidence)),
    missingEvidence: [...missingModelEvidence(String(model.risk ?? "none"), held)],
    applicability: vcrModelApplicabilityIssues(model, study),
    usedBy: sorted([...usedBy]),
  };
}

/**
 * The content of a model analysis plan, from the study's records. Pure and
 * deterministic: the same records give the same bytes, which is what the hash
 * is of — so nothing volatile (a review state, a timestamp, a row id) is in it.
 * @param {Record<string, any>} inputs what {@link readModelAnalysisInputs} read
 */
export function buildModelPlanContent(inputs) {
  const study = object(inputs.study);
  const definition = inputs.definition ? object(inputs.definition) : null;
  const population = latestBy(list(inputs.populations), (row) => String(row.kind))
    .sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null;
  const endpointType = text(definition?.endpointType);
  const variables = vcrPopulationVariables(population);
  const assessments = list(inputs.assessments).map((record) => normalizeVcrAssessment(record))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    schema: VCR_MODEL_PLAN_CONTENT_SCHEMA,
    study: { question: String(study.question ?? ""), intendedUse: String(study.intendedUse ?? "exploratory"), dataTier: String(study.dataTier ?? "T0") },
    definition: definition ? {
      endpointType, estimand: object(definition.estimand), pico: object(definition.pico),
    } : null,
    data: {
      populations: latestBy(list(inputs.populations), (row) => String(row.kind)).map((row) => ({
        kind: String(row.kind), name: String(row.name ?? ""), snapshotId: text(row.snapshotId),
      })).sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    },
    models: usedModels(inputs).map((entry) => modelEntry(entry, { endpointType, variables })),
    assessments,
    assumptions: list(inputs.assumptions).map((card) => ({
      key: String(card.key), name: String(card.name ?? card.key), unit: text(card.unit),
      value: numeric(card.pointValue), distribution: text(object(card.distribution).kind) ?? text(object(card.distribution).family),
      sourceKind: String(card.sourceKind ?? ""), valueSource: String(card.valueSource ?? ""),
      evidenceIds: sorted(list(card.evidenceIds).map(String)), pooling: text(card.poolingMethod),
    })).sort((a, b) => (a.key < b.key ? -1 : 1)),
    methods: [
      ...latestBy(list(inputs.comparators), (row) => String(row.route)).map((row) => ({
        object: "comparator", ref: `comparator:${row.route}`, label: /** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH)[String(row.route)] ?? String(row.route),
        route: String(row.route), estimand: String(row.estimand ?? ""),
        method: text(object(row.configuration).method), endpoint: text(object(object(row.configuration).endpoint).type),
        settings: sorted(Object.keys(object(row.configuration))),
      })),
      ...latestBy(list(inputs.patientSets), (row) => String(row.name || "set")).map((row) => ({
        object: "patient_set", ref: `patient_set:${row.name || "set"}`, label: String(row.name || "虚拟患者集"),
        model: row.modelId ? `${row.modelId}${row.modelVersion ? ` ${row.modelVersion}` : ""}` : null,
        endpoint: text(object(object(row.scenario).endpoint).type),
      })),
    ].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    scenarios: latestBy(list(inputs.scenarios), (row) => String(row.label || row.design)).map((row) => ({
      label: String(row.label || ""), design: String(row.design), endpointType: String(row.endpointType ?? ""),
      assumptions: sorted(list(row.assumptionIds).map(String)),
    })).sort((a, b) => ((a.label || a.design) < (b.label || b.design) ? -1 : 1)),
  };
}

/** The content's hash: the bytes a freeze is a freeze of. @param {Record<string, any>} content */
export function modelPlanContentHash(content) {
  return createHash("sha256").update(canonicalScenarioJson(content)).digest("hex");
}

/**
 * What a plan has not said yet — an assessment record's gaps at the planning
 * stage, a model with no assessment, a model that does not cover the study.
 * Notices only: a plan with gaps is the plan.
 * @param {Record<string, any>} content
 * @returns {Array<{ code: string, ref: string, field?: string, text: string }>}
 */
export function modelPlanIssues(content) {
  /** @type {Array<{ code: string, ref: string, field?: string, text: string }>} */
  const issues = [];
  const assessed = new Set(list(content.assessments).map((record) => `${record.modelName}@${record.modelVersion}`));
  for (const record of list(content.assessments)) {
    for (const found of vcrAssessmentIssues(record, "planning")) issues.push({ code: found.code, ref: String(record.key), field: found.field, text: found.text });
  }
  for (const model of list(content.models)) {
    const ref = `${model.name} ${model.version}`;
    if (!assessed.has(`${model.name}@${model.version}`)) issues.push({ code: "assessment_missing", ref, text: "这个模型还没有评估记录" });
    if (model.notInCatalogue) issues.push({ code: "model_not_in_catalogue", ref, text: "模型库里没有这个模型的这个版本" });
    for (const found of list(model.applicability)) issues.push({ code: String(found.code), ref, field: String(found.field), text: String(found.text) });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

/**
 * The collections of the plan, each with how an item is told from another.
 * @type {ReadonlyArray<{ path: string, section: string, identity: (item: any) => string, name: (item: any) => string }>}
 */
const COLLECTIONS = Object.freeze([
  { path: "models", section: "models", identity: (item) => `${item.name}@${item.version}`, name: (item) => `${item.name} ${item.version}` },
  { path: "assessments", section: "assessments", identity: (item) => String(item.key), name: (item) => String(item.key) },
  { path: "assumptions", section: "assumptions", identity: (item) => String(item.key), name: (item) => String(item.name || item.key) },
  { path: "methods", section: "methods", identity: (item) => String(item.ref), name: (item) => String(item.label || item.ref) },
  { path: "scenarios", section: "scenarios", identity: (item) => String(item.label || item.design), name: (item) => String(item.label || item.design) },
  { path: "data.populations", section: "data", identity: (item) => String(item.kind), name: (item) => `人群（${item.kind}）` },
]);

/** Fields the platform derives from others, never changes of their own. */
const DERIVED_FIELDS = Object.freeze(["riskRule"]);

/**
 * A value as a diff line says it: a closed word in the reader's language, anything else as it stands, cut short.
 * @param {string} field @param {unknown} value
 */
const compact = (field, value) => {
  const word = typeof value === "string" ? WORDS_BY_FIELD[field]?.[value] : undefined;
  const raw = word ?? (typeof value === "string" ? value : JSON.stringify(value ?? null));
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
};
/** The fields whose values are a closed vocabulary, with the words a reader knows them by. @type {Record<string, Record<string, string>>} */
const WORDS_BY_FIELD = Object.freeze({
  influence: VCR_RATING_LABELS_ZH, consequence: VCR_RATING_LABELS_ZH, impact: VCR_RATING_LABELS_ZH, risk: VCR_RATING_LABELS_ZH,
  intendedUse: VCR_INTENDED_USE_LABELS_ZH, tier: VCR_MODEL_TIER_LABELS_ZH, declaredRisk: VCR_MODEL_RISK_LABELS_ZH,
  endpointType: VCR_ENDPOINT_TYPE_LABELS_ZH, interfaceShape: VCR_MODEL_INTERFACE_LABELS_ZH,
});

/** @param {Record<string, any>} root @param {string} path */
const at = (root, path) => path.split(".").reduce((found, key) => (found == null ? undefined : found[key]), /** @type {any} */ (root));

/**
 * What differs between two contents, entry by entry: an item added, an item
 * removed, a field of an item that changed. Deterministic, and in the order the
 * plan lists its collections, so the same two contents always say the same
 * thing.
 * @param {Record<string, any> | null | undefined} before @param {Record<string, any>} after
 * @returns {Array<{ section: string, ref: string, change: "added" | "removed" | "changed", field: string | null, from: string | null, to: string | null, text: string }>}
 */
export function diffModelPlanContent(before, after) {
  /** @type {Array<{ section: string, ref: string, change: "added" | "removed" | "changed", field: string | null, from: string | null, to: string | null, text: string }>} */
  const changes = [];
  const was = object(before);
  const now = object(after);
  const label = (/** @type {string} */ section) => SECTION_LABELS_ZH[section] ?? section;
  const fieldWord = (/** @type {string} */ field) => FIELD_LABELS_ZH[field] ?? field;
  for (const [section, fields] of /** @type {const} */ ([["study", ["question", "intendedUse", "dataTier"]], ["definition", ["endpointType", "estimand", "pico"]]])) {
    for (const field of fields) {
      const a = compact(field, object(was[section])[field]);
      const b = compact(field, object(now[section])[field]);
      if (a !== b) changes.push({ section, ref: section, change: "changed", field, from: a, to: b, text: `${label(section)}的${fieldWord(field)}由 ${a} 改为 ${b}` });
    }
  }
  for (const collection of COLLECTIONS) {
    const old = new Map(list(at(was, collection.path)).map((item) => [collection.identity(item), item]));
    const current = new Map(list(at(now, collection.path)).map((item) => [collection.identity(item), item]));
    for (const [id, item] of current) {
      if (!old.has(id)) {
        changes.push({ section: collection.section, ref: id, change: "added", field: null, from: null, to: null, text: `${label(collection.section)}新增：${collection.name(item)}` });
        continue;
      }
      const prior = object(old.get(id));
      // A field the platform derives from others (`riskRule`) is not a change of its own: the ratings it comes from are listed.
      for (const field of sorted(Object.keys(item)).filter((name) => !DERIVED_FIELDS.includes(name))) {
        const a = compact(field, prior[field]);
        const b = compact(field, item[field]);
        if (a !== b) changes.push({ section: collection.section, ref: id, change: "changed", field, from: a, to: b, text: `${label(collection.section)}「${collection.name(item)}」的${fieldWord(field)}由 ${a} 改为 ${b}` });
      }
    }
    for (const [id, item] of old) {
      if (!current.has(id)) changes.push({ section: collection.section, ref: id, change: "removed", field: null, from: null, to: null, text: `${label(collection.section)}删去：${collection.name(item)}` });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The report model's model-analysis block
// ---------------------------------------------------------------------------

/**
 * One saved result as the report tabulates it: the engine's own measures and
 * counts under the name of the object it belongs to, so a template can reference
 * every number by path.
 * @param {Record<string, any>} inputs @param {readonly Record<string, any>[]} results
 */
function modelResultsOf(inputs, results) {
  /** @type {Map<string, string>} */
  const subjectOf = new Map();
  for (const scenario of list(inputs.scenarios)) {
    if (scenario.resultId) subjectOf.set(String(scenario.resultId), String(scenario.label || /** @type {Record<string, string>} */ (VCR_TRIAL_DESIGN_LABELS_ZH)[String(scenario.design)] || "试验方案"));
  }
  for (const design of list(inputs.comparators)) {
    if (design.resultId) subjectOf.set(String(design.resultId), /** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH)[String(design.route)] ?? "对照");
  }
  for (const population of list(inputs.populations)) if (population.resultId) subjectOf.set(String(population.resultId), `人群 v${population.version}`);
  for (const set of list(inputs.patientSets)) if (set.resultId) subjectOf.set(String(set.resultId), `虚拟患者集 v${set.version}`);
  return list(results).filter((result) => REPORTED_RESULT_KINDS.includes(String(result.kind))).map((result) => {
    const kind = String(result.kind);
    const downgrade = object(result.useDowngrade);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const key of [...VCR_COUNT_KEYS, "priorEffectiveSampleSize", "reconstructedPseudoPatients"]) {
      const value = numeric(object(result.counts)[key]);
      if (value !== null) counts[key] = value;
    }
    return {
      id: String(result.id), kind, kindLabel: RESULT_KIND_LABELS_ZH[kind] ?? kind,
      subject: subjectOf.get(String(result.id)) ?? text(result.subjectId) ?? (RESULT_KIND_LABELS_ZH[kind] ?? kind),
      conclusion: text(result.conclusion), notEstimableRule: text(result.notEstimableRule), intendedUse: text(result.intendedUse),
      useDowngrade: Object.keys(downgrade).length ? {
        requested: text(downgrade.requested), ceiling: text(downgrade.ceiling), reason: text(downgrade.reason), missingEvidence: words(list(downgrade.missingEvidence).flatMap((item) => list(object(item).missing))),
      } : null,
      counts,
      measures: list(result.measures).map((measure) => {
        const row = object(measure);
        return {
          name: String(row.name ?? ""), value: numeric(row.value), unit: text(row.unit), mcse: numeric(row.mcse),
          simulated: typeof row.simulated === "boolean" ? row.simulated : null, source: text(row.source), interval: row.interval ? object(row.interval) : null,
        };
      }),
    };
  });
}

/**
 * The `modelAnalysis` block of the report model: the plan as it stands now, the
 * frozen versions, what has deviated from the newest of them, and every saved
 * result a report tabulates. Both documents are rendered from this block and
 * from nothing else, so what a reader sees is what the export froze.
 * @param {{ inputs: Record<string, any>, results: readonly Record<string, any>[], versions: ReadonlyArray<Record<string, any>> }} input
 *   `versions` are the frozen plan versions, newest first
 */
export function buildModelAnalysis({ inputs, results, versions }) {
  const current = buildModelPlanContent(inputs);
  const newest = list(versions)[0] ?? null;
  /** @param {Record<string, any>} version */
  const summary = (version) => {
    const read = version.outcomeFirstReadAt ? Date.parse(String(version.outcomeFirstReadAt)) : Number.NaN;
    const frozen = Date.parse(String(version.frozenAt));
    return {
      version: Number(version.version), frozenAt: String(version.frozenAt), frozenBy: String(version.frozenBy ?? ""), contentHash: String(version.contentHash),
      sealPlanVersion: Number(version.sealPlanVersion ?? 0), sealPlanHash: String(version.sealPlanHash ?? ""),
      outcomeFirstReadAt: version.outcomeFirstReadAt ? String(version.outcomeFirstReadAt) : null,
      afterOutcomeRead: Number.isFinite(read) && Number.isFinite(frozen) && read < frozen,
      changes: list(version.changes), issues: list(version.issues),
    };
  };
  return {
    current,
    issues: modelPlanIssues(current),
    plan: newest ? { ...summary(newest), content: object(newest.content) } : null,
    history: list(versions).map((version) => ({ ...summary(version), changes: list(version.changes).length })),
    deviations: newest ? diffModelPlanContent(object(newest.content), current) : [],
    results: modelResultsOf(inputs, results),
  };
}

// ---------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------

/**
 * The service `vcrSeal` calls at the instant it freezes the analysis plan.
 * @param {{ store: any, now?: () => Date }} dependencies
 */
export function createVcrModelPlans({ store, now = () => new Date() }) {
  if (!store?.freezeModelPlanVersion) throw new TypeError("The model plan service needs a store that can freeze a plan version.");
  return {
    /**
     * Freeze the plan as the study's records stand now: a new version when the
     * content differs from the newest frozen one, no change when it does not.
     * @param {{ studyId: string, actor?: string, frozenAt?: string | null,
     *   seal?: { planVersion?: number, planHash?: string | null, outcomeFirstReadAt?: string | null } }} input
     */
    async freeze(input) {
      const study = await store.studyById(String(input.studyId));
      if (!study) return null;
      const content = buildModelPlanContent(await readModelAnalysisInputs(store, study));
      return store.freezeModelPlanVersion({
        studyId: study.id, userId: study.userId, content, contentHash: modelPlanContentHash(content),
        frozenAt: input.frozenAt ?? now().toISOString(), frozenBy: String(input.actor || "platform"),
        sealPlanVersion: Number(input.seal?.planVersion ?? 0), sealPlanHash: String(input.seal?.planHash ?? ""),
        outcomeFirstReadAt: input.seal?.outcomeFirstReadAt ?? null,
        issues: modelPlanIssues(content), diff: (/** @type {Record<string, any>} */ previous) => diffModelPlanContent(previous, content),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: "prose", text: string }
 *   | { type: "text", text: string }
 *   | { type: "note", text: string }
 *   | { type: "facts", title?: string, rows: Array<[string, string]> }
 *   | { type: "table", title?: string, columns: string[], rows: string[][] }
 *   | { type: "list", title?: string, items: string[] }} VcrDocumentBlock
 * @typedef {{ id: string, title: string, blocks: VcrDocumentBlock[] }} VcrDocumentSection
 */

/** The prose a run wrote for each section, rendered against the frozen model. @param {readonly Record<string, any>[]} reports @param {Record<string, any>} model */
function proseBySection(reports, model) {
  /** @type {Map<string, string>} */
  const prose = new Map();
  for (const report of list(reports)) {
    const template = String(report?.template ?? "");
    if (template.trim()) prose.set(String(report.section ?? "main"), renderVcrNumbers(template, model).text);
  }
  return prose;
}

/** One cell of a results table, rendered by the renderer from the report model. @param {string} template @param {Record<string, any>} model */
const cell = (template, model) => renderVcrNumbers(template, model).text;

/** @param {string | null | undefined} value @param {string} [fallback] */
const orDash = (value, fallback = "—") => (value && String(value).trim() ? String(value) : fallback);
/** @param {string | null | undefined} iso */
const instant = (iso) => (iso ? String(iso) : "未记录");
const NOT_FILLED = "未填写";
/** What a section says when its words have not been written: the structure around it is still the platform's. @type {VcrDocumentBlock} */
const UNWRITTEN = { type: "note", text: "本节的文字尚未撰写。" };

/** @param {Record<string, string>} labels @param {string | null | undefined} key */
const wordOf = (labels, key) => labels[String(key)] ?? String(key ?? "—");

/** The plan's version line: which freeze this document stands on. @param {Record<string, any> | null} plan @returns {Array<[string, string]>} */
function planFacts(plan) {
  if (!plan) return [["冻结状态", "尚未冻结：下面是按研究现有记录生成的草案；冻结发生在分析计划冻结的同一时刻，在接触封存的结局数据之前。"]];
  /** @type {Array<[string, string]>} */
  const facts = [
    ["计划版本", `第 ${plan.version} 版`],
    ["冻结时间", instant(plan.frozenAt)],
    ["冻结者", orDash(plan.frozenBy)],
    ["内容哈希（sha256）", plan.contentHash],
    ["对应的分析计划", plan.sealPlanVersion ? `第 ${plan.sealPlanVersion} 版${plan.sealPlanHash ? `（${String(plan.sealPlanHash).slice(0, 12)}）` : ""}` : "未记录"],
    ["冻结时的结局数据", plan.afterOutcomeRead
      ? `结局字段已于 ${plan.outcomeFirstReadAt} 首次读取，早于这次冻结：这一版不是在接触结局之前写定的。`
      : plan.outcomeFirstReadAt ? `结局字段首次读取于 ${plan.outcomeFirstReadAt}，晚于冻结。` : "结局字段在冻结时尚未被读取。"],
  ];
  return facts;
}

/** Models as a table. @param {readonly Record<string, any>[]} models */
function modelsTable(models) {
  const labelOf = (/** @type {readonly string[]} */ keys) => (keys.length ? keys.map(evidenceLabel).join("、") : "无");
  return {
    type: /** @type {const} */ ("table"), title: "所用的模型",
    columns: ["模型", "版本", "层级", "接口", "声明的风险", "适用范围", "模型卡已有的证据", "还缺的证据"],
    rows: models.map((model) => model.notInCatalogue
      ? [`${model.name}`, orDash(model.version), "模型库里没有", "—", "—", "—", "—", "—"]
      : [String(model.name), String(model.version), wordOf(VCR_MODEL_TIER_LABELS_ZH, model.tier),
        wordOf(VCR_MODEL_INTERFACE_LABELS_ZH, model.interfaceShape), wordOf(VCR_MODEL_RISK_LABELS_ZH, model.declaredRisk),
        [model.scope?.population, model.scope?.region].filter(Boolean).join("；") || "未声明",
        `${labelOf(list(model.evidence))}${list(model.declaredEvidence).length ? `（声明但未核实：${labelOf(list(model.declaredEvidence))}）` : ""}`,
        labelOf(list(model.missingEvidence))]),
  };
}

/** What each model is checked against, and what was found. @param {readonly Record<string, any>[]} models @returns {VcrDocumentBlock[]} */
function modelEvaluationBlocks(models) {
  if (!models.length) return [];
  /** @type {VcrDocumentBlock[]} */
  const blocks = [{
    type: "table", title: "模型的评价方法：验证与适用性",
    columns: ["模型", "验证（模型卡记录）", "对这项研究的适用性检查"],
    rows: models.map((model) => [
      `${model.name} ${orDash(model.version, "")}`.trim(),
      list(model.validation).map((row) => `${VALIDATION_LABELS[String(row.key)] ?? row.key}：${row.value}`).join("；") || "模型卡没有记录验证",
      list(model.applicability).length ? list(model.applicability).map((issue) => String(issue.text)).join("；") : "没有发现超出它声明范围的地方",
    ]),
  }];
  const limits = models.filter((model) => list(model.knownLimits).length);
  if (limits.length) {
    blocks.push({ type: "list", title: "模型卡写明的已知局限", items: limits.flatMap((model) => list(model.knownLimits).map((limit) => `${model.name}：${limit}`)) });
  }
  return blocks;
}

/** @param {readonly Record<string, any>[]} assumptions @returns {VcrDocumentBlock} */
function assumptionsTable(assumptions) {
  return {
    type: "table", title: "假设登记表（含证据参数及来源）", columns: ["假设", "取值", "分布", "来源", "证据"],
    rows: assumptions.map((card) => [
      String(card.name || card.key),
      card.value == null ? "未设定" : `${card.value}${card.unit ? ` ${card.unit}` : ""}`,
      orDash(card.distribution, "无"),
      [wordOf(VCR_VALUE_SOURCE_LABELS_ZH, card.valueSource), wordOf(VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH, card.sourceKind)].join("；"),
      list(card.evidenceIds).length ? `证据 ${list(card.evidenceIds).join("、")}${card.pooling ? `（合并：${card.pooling}）` : ""}` : "无",
    ]),
  };
}

/** @param {readonly Record<string, any>[]} methods @param {readonly Record<string, any>[]} scenarios @returns {VcrDocumentBlock[]} */
function methodBlocks(methods, scenarios) {
  /** @type {VcrDocumentBlock[]} */
  const blocks = [];
  if (methods.length) {
    blocks.push({
      type: "table", title: "计划使用的方法", columns: ["对象", "方法或路线", "估计目标", "终点", "所用模型"],
      rows: methods.map((method) => [
        String(method.label), orDash(method.method ?? method.route ?? (method.object === "patient_set" ? "按模型生成" : null)),
        orDash(method.estimand ? wordOf(VCR_ESTIMAND_LABELS_ZH, method.estimand) : null), orDash(method.endpoint ? wordOf(VCR_ENDPOINT_TYPE_LABELS_ZH, method.endpoint) : null),
        orDash(method.model),
      ]),
    });
  }
  if (scenarios.length) {
    blocks.push({
      type: "table", title: "模拟与情景", columns: ["情景", "设计", "终点", "引用的假设"],
      rows: scenarios.map((scenario) => [orDash(scenario.label, "（未命名）"), wordOf(VCR_TRIAL_DESIGN_LABELS_ZH, scenario.design),
        wordOf(VCR_ENDPOINT_TYPE_LABELS_ZH, scenario.endpointType), list(scenario.assumptions).length ? list(scenario.assumptions).join("、") : "无"]),
    });
  }
  return blocks;
}

/** @param {Record<string, any>} content @returns {VcrDocumentBlock[]} */
function populationBlocks(content) {
  const populations = list(content.data?.populations);
  return [{
    type: "facts", title: "数据档位",
    rows: [["数据档位", wordOf({ T0: "T0 公开资料", T1: "T1 基线与招募资料", T2: "T2 完整治疗与纵向结局", T3: "T3 随机试验个体数据" }, content.study?.dataTier)]],
  }, ...(populations.length ? [/** @type {VcrDocumentBlock} */ ({
    type: "table", title: "人群", columns: ["人群类型", "名称", "数据快照"],
    rows: populations.map((row) => [String(row.kind), orDash(row.name), orDash(row.snapshotId, "无（不来自个体数据）")]),
  })] : [])];
}

/**
 * The assessment tables of one stage: one table per record, grouped under the
 * question of interest it answers (M15 §2.1.1 asks for a table per question),
 * with the row the platform adds — what the model risk requires of the model's
 * evidence and what the card holds.
 * @param {readonly Record<string, any>[]} assessments @param {readonly Record<string, any>[]} models @param {"planning" | "submission"} stage
 * @returns {VcrDocumentBlock[]}
 */
function assessmentBlocks(assessments, models, stage) {
  if (!assessments.length) {
    return [{ type: "text", text: "研究还没有任何模型评估记录：每个所用模型的关注问题、使用情境、影响力、后果、冲击和技术标准都未填写。" }];
  }
  /** @type {VcrDocumentBlock[]} */
  const blocks = [];
  vcrAssessmentGroups(assessments).forEach((group, index) => {
    blocks.push({ type: "text", text: `**评估表 ${index + 1} 关注的问题：${group.question || NOT_FILLED}**` });
    for (const record of group.records) {
      const model = models.find((entry) => entry.name === record.modelName && (!record.modelVersion || entry.version === record.modelVersion));
      /** @type {string[][]} */
      const rows = vcrAssessmentRows(record, stage).filter((row) => row.key !== "questionOfInterest").map((row) => [
        `${row.zh}（${row.en}）`,
        row.rating ? wordOf(VCR_RATING_LABELS_ZH, row.rating) : row.rated ? NOT_FILLED : "—",
        row.rated ? orDash(row.justification, NOT_FILLED) : orDash(row.entry, NOT_FILLED),
      ]);
      if (record.risk) {
        const required = /** @type {Record<string, readonly string[]>} */ (VCR_MODEL_RISK_EVIDENCE)[record.risk] ?? [];
        const held = new Set([...list(model?.evidence), ...list(model?.declaredEvidence)].map(String));
        const missing = required.filter((item) => !held.has(item));
        rows.push(["与模型风险相称的证据（平台依据模型卡核对）", "—",
          `${wordOf(VCR_MODEL_RISK_LABELS_ZH, record.risk)}风险要求：${required.map(evidenceLabel).join("、")}；`
          + `${model ? (missing.length ? `模型卡上还缺：${missing.map(evidenceLabel).join("、")}` : "模型卡上都有") : "模型库里没有这个模型，无法核对"}。`
          + `${model && VCR_MODEL_RISK_LABELS_ZH[/** @type {keyof typeof VCR_MODEL_RISK_LABELS_ZH} */ (model.declaredRisk)] && model.declaredRisk !== record.risk
            ? `模型卡声明的风险是${wordOf(VCR_MODEL_RISK_LABELS_ZH, model.declaredRisk)}，与这项评估不同。` : ""}`]);
      }
      blocks.push({ type: "table", title: `模型：${record.modelName || "未指明"}${record.modelVersion ? ` ${record.modelVersion}` : ""}（记录 ${record.key}）`, columns: ["项目", "评级", "内容与理由"], rows });
    }
  });
  return blocks;
}

/** The intended-use line. @param {Record<string, any>} content */
const intendedUseLine = (content) => wordOf(VCR_INTENDED_USE_LABELS_ZH, content.study?.intendedUse);

/** The study and definition as facts. @param {Record<string, any>} content @returns {VcrDocumentBlock} */
function studyFacts(content) {
  const definition = object(content.definition);
  const pico = object(definition.pico);
  /** @type {Array<[string, string]>} */
  const rows = [["研究问题", orDash(content.study?.question)]];
  if (definition.endpointType) rows.push(["终点类型", wordOf(VCR_ENDPOINT_TYPE_LABELS_ZH, definition.endpointType)]);
  if (object(definition.estimand).kind) rows.push(["估计目标", wordOf(VCR_ESTIMAND_LABELS_ZH, object(definition.estimand).kind)]);
  if (text(pico.population)) rows.push(["人群", String(pico.population)]);
  rows.push(["预期用途", intendedUseLine(content)]);
  return { type: "facts", rows };
}

/** The questions the models are to answer. @param {Record<string, any>} content @returns {VcrDocumentBlock[]} */
function questionBlocks(content) {
  const groups = vcrAssessmentGroups(list(content.assessments));
  if (!groups.length) return [{ type: "text", text: "关注的问题还没有填写：每个所用模型的评估记录要写明它回答的问题。" }];
  return [{ type: "list", title: "关注的问题（question of interest）", items: groups.map((group) => `${group.question || NOT_FILLED}（${group.records.map((record) => record.modelName || "未指明模型").join("、")}）`) }];
}

/** The plan's own four sections, from one content. @param {Record<string, any>} content @param {Map<string, string>} prose @param {{ withProse: boolean }} options @returns {VcrDocumentSection[]} */
function planSections(content, prose, { withProse }) {
  const proseOf = (/** @type {string} */ id) => (!withProse ? [] : [prose.get(id) ? /** @type {VcrDocumentBlock} */ ({ type: "prose", text: String(prose.get(id)) }) : UNWRITTEN]);
  const models = list(content.models);
  return [
    { id: "introduction", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.introduction, blocks: [...proseOf("introduction"), studyFacts(content)] },
    { id: "objectives", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.objectives, blocks: [...proseOf("objectives"), ...questionBlocks(content)] },
    { id: "data", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.data, blocks: [...proseOf("data"), ...populationBlocks(content), assumptionsTable(list(content.assumptions))] },
    { id: "methods", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.methods, blocks: [
      ...proseOf("methods"), ...(models.length ? [modelsTable(models)] : [{ type: /** @type {const} */ ("text"), text: "这项研究没有登记任何需要评估的模型；所用的方法见下表。" }]),
      ...modelEvaluationBlocks(models), ...methodBlocks(list(content.methods), list(content.scenarios)),
      { type: "text", text: "**模型评估表（ICH M15 附录 1 的计划阶段各行）**" }, ...assessmentBlocks(list(content.assessments), models, "planning"),
    ] },
  ];
}

/** The deviations as a list block. @param {readonly Record<string, any>[]} deviations @param {string} title @param {string} none @returns {VcrDocumentBlock} */
function deviationBlock(deviations, title, none) {
  return deviations.length ? { type: "list", title, items: deviations.map((entry) => String(entry.text)) } : { type: "text", text: none };
}

/**
 * The 模型分析计划's sections: the freeze, then M15's four.
 * @param {Record<string, any>} model the report model (`cover.results`)
 * @param {readonly Record<string, any>[]} reports the prose a run wrote
 * @returns {VcrDocumentSection[]}
 */
export function modelPlanDocumentSections(model, reports) {
  const analysis = object(model.modelAnalysis);
  const plan = analysis.plan ? object(analysis.plan) : null;
  const content = plan ? object(plan.content) : object(analysis.current);
  const prose = proseBySection(reports, model);
  /** @type {VcrDocumentBlock[]} */
  const freeze = [{ type: "facts", rows: planFacts(plan) }];
  if (plan) {
    freeze.push(plan.changes?.length
      ? { type: "list", title: "与上一版相比的变化", items: list(plan.changes).map((entry) => String(object(entry).text)) }
      : { type: "text", text: Number(plan.version) > 1 ? "与上一版相比没有变化的记录。" : "这是第一版。" });
    freeze.push(deviationBlock(list(analysis.deviations), "冻结之后研究记录发生的变化（再次冻结时成为新的一版，这一版不变）", "冻结之后，研究记录与这一版一致，没有变化。"));
    if (list(analysis.history).length > 1) {
      freeze.push({ type: "table", title: "冻结过的版本", columns: ["版本", "冻结时间", "冻结者", "与上一版相比", "内容哈希"],
        rows: list(analysis.history).map((entry) => [`第 ${entry.version} 版`, instant(entry.frozenAt), orDash(entry.frozenBy), Number(entry.version) === 1 ? "—" : `${entry.changes} 处变化`, String(entry.contentHash).slice(0, 16)]) });
    }
    if (list(plan.issues).length) {
      freeze.push({ type: "list", title: "冻结时计划里还没有写全的地方", items: list(plan.issues).map((entry) => `${object(entry).ref}：${object(entry).text}`) });
    }
  }
  /** @type {VcrDocumentSection[]} */
  const sections = [{ id: "freeze", title: "冻结信息", blocks: [...freeze, ...(plan
    ? [/** @type {VcrDocumentBlock} */ ({ type: "note", text: "各节正文的文字是冻结之后在导出时写的，不在内容哈希的范围内；哈希覆盖的是下面的登记表、评估表、方法和情景。" })] : [])] }];
  sections.push(...planSections(content, prose, { withProse: true }));
  sections.push({ id: "attribution", title: "说明", blocks: [{ type: "note", text: VCR_MODEL_DOCUMENT_ATTRIBUTION_ZH }] });
  return sections;
}

/** One result's blocks: its conclusion, and the numbers the renderer prints. @param {Record<string, any>} result @param {number} index @param {Record<string, any>} model @returns {VcrDocumentBlock[]} */
function resultBlocks(result, index, model) {
  const base = `modelAnalysis.results[${index}]`;
  const notEstimable = result.conclusion === "not_estimable";
  /** @type {VcrDocumentBlock[]} */
  const blocks = [];
  const conclusion = result.conclusion ? wordOf(VCR_CONCLUSION_LABELS_ZH, result.conclusion) : "未记录结论";
  const rule = notEstimable && result.notEstimableRule ? `；触发的规则：${wordOf(VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, result.notEstimableRule)}` : "";
  /** @type {Array<[string, string]>} */
  const facts = [["结论", `${conclusion}${rule}`]];
  if (result.intendedUse) {
    const downgrade = object(result.useDowngrade);
    const why = /** @type {Record<string, string>} */ ({ model_evidence_missing: "模型证据不足", model_tier_ceiling: "模型层级的上限" })[String(downgrade.reason)] ?? "模型的限制";
    facts.push(["结果可标注的预期用途", `${wordOf(VCR_INTENDED_USE_LABELS_ZH, result.intendedUse)}${downgrade.reason ? `（已下调：${why}${list(downgrade.missingEvidence).length ? `，缺 ${list(downgrade.missingEvidence).map(evidenceLabel).join("、")}` : ""}）` : ""}` ]);
  }
  blocks.push({ type: "facts", title: `${result.kindLabel}：${result.subject}`, rows: facts });
  /** @type {string[][]} */
  const rows = [];
  const countRows = Object.keys(object(result.counts)).map((key) => [
    ({ realPatients: "真实患者数", events: "事件数", effectiveSampleSize: "有效样本量", generatedRecords: "生成记录数",
      priorEffectiveSampleSize: "先验有效样本量", reconstructedPseudoPatients: "重建的伪个体数" }[key] ?? key),
    cell(`{{n:${base}.counts.${key}|thousands}}`, model), "—", "—", "—"]);
  list(result.measures).forEach((measure, position) => {
    const row = object(measure);
    const path = `${base}.measures[${position}]`;
    const view = measureValue({ ...row }, { kind: String(result.kind), result: { conclusion: result.conclusion, notEstimableRule: result.notEstimableRule } });
    const precision = view.precision;
    const decimals = view.unit === "%" ? Math.min(3, (precision ?? 1) + 2) : (precision ?? 3);
    const format = decimals <= 0 ? "int" : `f${Math.min(3, decimals)}`;
    const none = row.value === null || row.value === undefined;
    const value = none
      ? (notEstimable ? "不可估计" : cell(`{{n:${path}.value|${format}}}`, model))
      : row.simulated !== false && Number.isFinite(row.mcse) ? cell(`{{n:${path}|pm}}`, model)
        : cell(`{{n:${path}.value|${row.unit === "months" || row.unit === "month" ? "months" : format}}}`, model);
    const interval = row.interval && Number.isFinite(row.interval.low) && Number.isFinite(row.interval.high) ? cell(`{{n:${path}|ci}}`, model) : "—";
    rows.push([measureLabel(String(row.name)), value, interval,
      view.unit === "%" ? "比例（0–1）" : orDash(view.unit), wordOf(VCR_VALUE_SOURCE_LABELS_ZH, view.source)]);
  });
  if (countRows.length || rows.length) {
    blocks.push({ type: "table", columns: ["指标", "数值", "区间", "单位", "来源"], rows: [...countRows, ...rows] });
  } else {
    blocks.push({ type: "text", text: notEstimable ? "这项结果被引擎判定为不可估计，没有给出任何估计值。" : "这项结果没有可列出的指标。" });
  }
  return blocks;
}

/**
 * The 模型分析报告's sections: M15's eight, with the plan it reports against and
 * its deviations.
 * @param {Record<string, any>} model the report model (`cover.results`)
 * @param {readonly Record<string, any>[]} reports the prose a run wrote
 * @returns {VcrDocumentSection[]}
 */
export function modelReportDocumentSections(model, reports) {
  const analysis = object(model.modelAnalysis);
  const plan = analysis.plan ? object(analysis.plan) : null;
  const current = object(analysis.current);
  const prose = proseBySection(reports, model);
  const proseOf = (/** @type {string} */ id) => [prose.get(id) ? /** @type {VcrDocumentBlock} */ ({ type: "prose", text: String(prose.get(id)) }) : UNWRITTEN];
  const results = list(analysis.results);
  const models = list(current.models);
  /** @type {VcrDocumentSection[]} */
  const sections = [];
  /** @type {VcrDocumentBlock} */
  const reportsAgainst = { type: "facts", title: "这份报告依据的模型分析计划", rows: plan
    ? [["计划版本", `第 ${plan.version} 版，冻结于 ${instant(plan.frozenAt)}（冻结者：${orDash(plan.frozenBy)}）`], ["内容哈希（sha256）", String(plan.contentHash)],
      ["冻结时的结局数据", plan.afterOutcomeRead ? `结局字段已于 ${plan.outcomeFirstReadAt} 首次读取，早于这次冻结` : plan.outcomeFirstReadAt ? "冻结之后才首次读取结局字段" : "冻结时尚未读取结局字段"],
      ["与计划的偏离", `${list(analysis.deviations).length} 处，列在「结果」一节`]]
    : [["计划版本", "没有冻结的模型分析计划：这项分析是在没有事先冻结计划的情况下做的，无从比较偏离。"]] };

  sections.push({ id: "executive_summary", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.executive_summary, blocks: [
    reportsAgainst, ...proseOf("executive_summary"),
    ...(results.length ? [/** @type {VcrDocumentBlock} */ ({ type: "list", title: "结果的结论状态", items: results.map((result) => `${result.kindLabel}：${result.subject}——${result.conclusion ? wordOf(VCR_CONCLUSION_LABELS_ZH, result.conclusion) : "未记录结论"}`) })] : []),
  ] });
  sections.push({ id: "introduction", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.introduction, blocks: [...proseOf("introduction"), studyFacts(current)] });
  sections.push({ id: "objectives", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.objectives, blocks: [...proseOf("objectives"), ...questionBlocks(current)] });
  sections.push({ id: "data_methods", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.data_methods, blocks: [
    ...proseOf("data_methods"), ...populationBlocks(current), assumptionsTable(list(current.assumptions)),
    ...(models.length ? [modelsTable(models)] : []), ...modelEvaluationBlocks(models), ...methodBlocks(list(current.methods), list(current.scenarios)),
    ...(list(current.assessments).some((record) => list(object(record).technicalCriteria).length)
      ? [/** @type {VcrDocumentBlock} */ ({ type: "list", title: "模型评价与结果的技术标准", items: list(current.assessments).flatMap((record) => list(object(record).technicalCriteria).map((entry) => `${object(record).modelName || object(record).key}：${object(entry).criterion}${object(entry).rationale ? `（${object(entry).rationale}）` : ""}`)) })]
      : [/** @type {VcrDocumentBlock} */ ({ type: "text", text: "技术标准还没有填写。" })]),
  ] });
  /** @type {VcrDocumentBlock[]} */
  const resultBlocksAll = results.length ? results.flatMap((result, index) => resultBlocks(result, index, model))
    : [{ type: "text", text: "研究还没有可列入报告的结果。" }];
  sections.push({ id: "results", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.results, blocks: [
    ...proseOf("results"), ...resultBlocksAll,
    deviationBlock(list(analysis.deviations), "与模型分析计划的偏离（每一处都应在讨论里说明理由）",
      plan ? `与第 ${plan.version} 版计划相比，没有偏离。` : "没有冻结的计划，无从比较偏离。"),
  ] });
  const stale = list(model.stale);
  const limits = [
    ...models.filter((entry) => list(object(entry).missingEvidence).length).map((entry) => `${object(entry).name}：模型卡上还缺 ${list(object(entry).missingEvidence).map(evidenceLabel).join("、")}`),
    ...models.flatMap((entry) => list(object(entry).applicability).map((issue) => `${object(entry).name}：${object(issue).text}`)),
    ...stale.map((mark) => `过期的结果：${object(mark).node}（${object(mark).reason}）`),
  ];
  sections.push({ id: "discussion", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.discussion, blocks: [
    ...proseOf("discussion"),
    ...(limits.length ? [/** @type {VcrDocumentBlock} */ ({ type: "list", title: "模型与数据的局限（来自模型卡、适用性检查和过期标记）", items: limits })] : []),
  ] });
  const outcomes = list(current.assessments).filter((record) => object(record).outcome);
  sections.push({ id: "conclusions", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.conclusions, blocks: [
    ...proseOf("conclusions"),
    ...(outcomes.length ? [/** @type {VcrDocumentBlock} */ ({ type: "list", title: "模型证据评估的结论（评估表的最后一行）", items: outcomes.map((record) => `${object(record).modelName || object(record).key}：${object(record).outcome}`) })] : []),
  ] });
  /** @type {VcrDocumentBlock[]} */
  const appendix = [];
  appendix.push({ type: "text", text: "**附录 A 模型分析计划**" });
  if (plan) {
    appendix.push({ type: "facts", rows: planFacts(plan) });
    planSections(object(plan.content), new Map(), { withProse: false }).forEach((section, position) => {
      appendix.push({ type: "text", text: `**A.${position + 1} ${section.title}**` }, ...section.blocks);
    });
  } else appendix.push({ type: "text", text: "没有冻结的模型分析计划。" });
  appendix.push({ type: "text", text: "**附录 B 模型评估表（含评价与结论两行）**" }, ...assessmentBlocks(list(current.assessments), models, "submission"));
  appendix.push({ type: "text", text: "**附录 C 引用与说明**" });
  const evidenceIds = sorted([...new Set(list(current.assumptions).flatMap((card) => list(object(card).evidenceIds).map(String)))]);
  appendix.push(evidenceIds.length ? { type: "list", title: "假设所依据的证据条目", items: evidenceIds } : { type: "text", text: "假设没有引用证据条目。" });
  appendix.push({ type: "note", text: VCR_MODEL_DOCUMENT_ATTRIBUTION_ZH });
  sections.push({ id: "appendices", title: VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH.appendices, blocks: appendix });
  return sections;
}

/** A cell as one line of a pipe table. @param {unknown} value */
const pipeCell = (value) => String(value ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim() || "—";

/** @param {string[]} columns @param {string[][]} rows */
function pipeTable(columns, rows) {
  return [`| ${columns.map(pipeCell).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map(pipeCell).join(" | ")} |`)].join("\n");
}

/**
 * The sections as Markdown, the form the document converter takes.
 * @param {readonly VcrDocumentSection[]} sections @param {{ numbered?: boolean }} [options]
 */
export function modelDocumentMarkdown(sections, { numbered = true } = {}) {
  /** @type {string[]} */
  const out = [];
  sections.forEach((section, index) => {
    out.push(`## ${numbered ? `${index + 1}. ` : ""}${section.title}`);
    for (const block of section.blocks) {
      switch (block.type) {
        case "prose": case "text": out.push(block.text); break;
        case "note": out.push(`*${block.text}*`); break;
        case "facts":
          if (block.title) out.push(`**${block.title}**`);
          out.push(pipeTable(["项目", "内容"], block.rows.map(([label, value]) => [label, value])));
          break;
        case "table":
          if (block.title) out.push(`**${block.title}**`);
          out.push(pipeTable(block.columns, block.rows));
          break;
        case "list":
          if (block.title) out.push(`**${block.title}**`);
          out.push(block.items.map((item) => `- ${String(item).replace(/\s*\n\s*/g, " ")}`).join("\n"));
          break;
        default: break;
      }
    }
  });
  return out.join("\n\n");
}

/** The kinds this module writes, and the section builder of each. */
const BUILDERS = Object.freeze(/** @type {Record<string, (model: Record<string, any>, reports: readonly Record<string, any>[]) => VcrDocumentSection[]>} */ ({
  model_analysis_plan: modelPlanDocumentSections,
  model_analysis_report: modelReportDocumentSections,
}));

/** Whether an export kind is one of the platform's own model documents. @param {string} kind */
export function isModelDocumentKind(kind) {
  return Object.hasOwn(BUILDERS, kind);
}

/**
 * The document of one of the two kinds from its frozen report model and the
 * prose a run wrote, as Markdown and as the sections a reader page shows. Prose
 * a run wrote under a section this document does not have is kept, after the
 * platform's sections under its own heading: what a run wrote is never dropped.
 * @param {string} kind @param {Record<string, any>} model @param {readonly Record<string, any>[]} reports
 * @returns {{ markdown: string, sections: VcrDocumentSection[] } | null} `null` for any other kind, or a model with no model-analysis block
 */
export function renderModelDocument(kind, model, reports) {
  const build = BUILDERS[kind];
  if (!build || !object(model).modelAnalysis) return null;
  const sections = build(model, reports);
  const known = new Set(/** @type {Record<string, { sections: readonly string[] }>} */ (VCR_MODEL_DOCUMENT_SECTIONS)[kind].sections);
  const extra = list(reports).filter((report) => report?.section !== "main" && !known.has(String(report?.section)) && String(report?.template ?? "").trim());
  const main = list(reports).filter((report) => report?.section === "main" && String(report?.template ?? "").trim());
  const tail = [...main.map((report) => ({ id: "main", title: "补充说明", template: report.template })),
    ...extra.map((report) => ({ id: String(report.section), title: String(report.section), template: report.template }))];
  for (const entry of tail) sections.push({ id: `extra-${entry.id}`, title: entry.title, blocks: [{ type: "prose", text: renderVcrNumbers(String(entry.template), model).text }] });
  return { markdown: modelDocumentMarkdown(sections), sections };
}

/**
 * The sections as the reader page shows them: each section's words and facts,
 * each table its own entry.
 * @param {readonly VcrDocumentSection[]} sections
 * @returns {Array<Record<string, any>>}
 */
export function modelDocumentReaderSections(sections) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  sections.forEach((section, index) => {
    const number = String(index + 1);
    const body = section.blocks.filter((block) => block.type === "prose" || block.type === "text").map((block) => /** @type {any} */ (block).text.replace(/\*\*/g, "")).join("\n\n");
    const facts = section.blocks.flatMap((block) => (block.type === "facts" ? block.rows.map(([label, value]) => ({ label, value })) : []));
    const notes = section.blocks.filter((block) => block.type === "note").map((block) => /** @type {any} */ (block).text);
    out.push({ id: section.id, number, title: section.title, body: body || null, ...(facts.length ? { facts } : {}), ...(notes.length ? { note: notes.join(" ") } : {}) });
    let more = 0;
    for (const block of section.blocks) {
      if (block.type === "table") {
        more += 1;
        out.push({ id: `${section.id}-t${more}`, number: `${number}.${more}`, title: block.title ?? section.title, table: { columns: block.columns, rows: block.rows } });
      } else if (block.type === "list") {
        more += 1;
        out.push({ id: `${section.id}-t${more}`, number: `${number}.${more}`, title: block.title ?? section.title, table: { columns: ["条目"], rows: block.items.map((item) => [item]) } });
      }
    }
  });
  return out;
}
