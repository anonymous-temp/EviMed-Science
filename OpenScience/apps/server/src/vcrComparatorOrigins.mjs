/**
 * Where a comparison's control comes from, said the same way in the analysis, the result page and the export (in silico plan T13,
 * sections 3.4 and 6).
 *
 * Hidden knowledge:
 *
 * - **Five origins, ordered by how much a person was observed.** `observed` (real people's rows), `aggregate` (published summary
 *   numbers only), `reconstructed` (pseudo-individuals rebuilt from a published curve), `model_predicted` (a model's prediction for
 *   people who exist) and `simulated` (every value generated, a lab experiment's control arm included). A comparison with several
 *   inputs reads as the weakest of them, which is the order of `VCR_COMPARATOR_ORIGINS`. The engine already refuses a synthetic,
 *   predicted or assumed table where a method weighs real patients (`VCR_INDIVIDUAL_INPUT_SOURCES`); this module is what lets the
 *   page, the report and a later experiment say it too, without re-deriving it from the method name.
 * - **Origin comes from what the run recorded, never from a name.** The engine labels a result with the weakest source of the columns
 *   its method used (`diagnostics.valueSourcesUsed.weakest`), and counts reconstructed pseudo-patients and generated records apart from
 *   real patients. Where a result says none of it, the origin is `not_stated`: it is not read as observed.
 * - **A simulated control never adds an observed subject.** `observedPeople` is a count of real people and is zero for a simulated
 *   or a model-predicted control arm, whatever the table's row count; a lab experiment's arm entering a comparison keeps the origin
 *   `simulated` and the premise that its conclusion is model-conditional.
 * - **The weakest source of a weighting against a publication is the trial's own table, not the control** (review stats P1-3). A
 *   matching-adjusted indirect comparison or a simulated treatment comparison (`AGGREGATE_CONTROL_METHODS`), and any comparison on the
 *   `literature_control` route, weighs the trial's own patients against a published control: the control is the published summary
 *   (or a curve rebuilt from it) and is never observed people, however real the trial's rows are.
 * - **The export reads the comparison the design names** (review stats P1-4): the result is the comparator design's own `resultId` with
 *   the execution that wrote it, never the study's newest comparator result under another design's route.
 * - **A transportability claim needs data this analysis does not have.** Every comparison states, in one row, what an independent
 *   real external dataset would have to be before the result could be said to hold in another population. Nothing here claims it.
 * - **Pure.** The caller hands over the result's diagnostics and counts.
 *
 * @module vcrComparatorOrigins
 */

/** @typedef {import("./vcrPremises.mjs").VcrPremise} VcrPremise */
/** @typedef {Pick<VcrPremise, "key" | "label" | "value" | "source" | "decisive">} PremiseRow */

import { list, numeric, object, text } from "./vcrViewsKit.mjs";

/** The origins of a control, strongest evidence first. */
export const VCR_COMPARATOR_ORIGINS = Object.freeze(["observed", "aggregate", "reconstructed", "model_predicted", "simulated", "not_stated"]);

/** @type {Readonly<Record<string, string>>} */
export const VCR_COMPARATOR_ORIGIN_LABELS_ZH = Object.freeze({
  observed: "真实观察的人", aggregate: "已发表的汇总数", reconstructed: "按曲线重建的个体", model_predicted: "模型的预测", simulated: "完全模拟", not_stated: "没有写明",
});

const REAL = new Set(["observed", "extracted", "calculated", "imputed"]);
/** The comparisons whose control is a publication's summary numbers by construction: the trial's own rows weighted to it. */
const AGGREGATE_CONTROL_METHODS = new Set(["comparator.maic", "comparator.stc"]);

/**
 * The origin of one input from its value source (and, for a lab experiment's arm, its kind). A source this table does not hold is
 * `not_stated`.
 * @param {{ valueSource?: unknown, kind?: unknown }} input
 * @returns {string}
 */
export function comparatorInputOrigin(input) {
  const kind = String(object(input).kind ?? "");
  if (["experiment_arm", "lab_control", "virtual_control"].includes(kind)) return "simulated";
  const source = String(object(input).valueSource ?? "");
  if (REAL.has(source)) return "observed";
  if (source === "aggregate") return "aggregate";
  if (source === "reconstructed") return "reconstructed";
  if (source === "predicted") return "model_predicted";
  if (source === "synthetic" || source === "assumed") return "simulated";
  return "not_stated";
}

/** Whether a control of this origin may be counted among observed people: only an observed one. @param {string} origin */
export const originCountsAsObserved = (origin) => origin === "observed";

/**
 * The weakest of several origins (the one a combined comparison reads as).
 * @param {readonly string[]} origins
 */
export function weakestOrigin(origins) {
  return origins.reduce((worst, origin) => (VCR_COMPARATOR_ORIGINS.indexOf(origin) > VCR_COMPARATOR_ORIGINS.indexOf(worst) ? origin : worst), "observed");
}

/**
 * What the control of a result is made of, from what the run recorded.
 * @param {{ route?: string | null, method?: string | null, diagnostics?: Record<string, any>, counts?: Record<string, any> }} result
 * @returns {{ origins: string[], origin: string, observedPeople: number, reconstructedPseudoPatients: number, simulatedMembers: number, modelConditional: boolean }}
 */
export function comparatorOrigins({ route = null, method = null, diagnostics = {}, counts = {} } = {}) {
  const found = object(diagnostics);
  const held = object(counts);
  const weakest = String(object(found.valueSourcesUsed).weakest ?? found.valueSource ?? "");
  const pseudo = numeric(held.reconstructedPseudoPatients) ?? 0;
  const generated = numeric(held.generatedRecords) ?? 0;
  const real = numeric(held.realPatients) ?? 0;
  /** @type {Set<string>} */ const origins = new Set();
  const applied = method === "model.prognostic_apply" || route === "model_comparator";
  if (applied) {
    // a model's prediction for people who exist, or for people it generated itself
    origins.add(weakest === "synthetic" || weakest === "assumed" || (!REAL.has(weakest) && generated > 0 && real === 0) ? "simulated" : "model_predicted");
  } else {
    // the control is a publication's: what the run's own sources say is about the trial's patients, never about the control
    const published = route === "literature_control" || AGGREGATE_CONTROL_METHODS.has(String(method ?? ""));
    if (pseudo > 0 || weakest === "reconstructed") origins.add("reconstructed");
    else if (published) origins.add("aggregate");
    if (weakest === "aggregate") origins.add("aggregate");
    if (!published && (REAL.has(weakest) || (route === "external_control" && real > 0))) origins.add("observed");
    if (weakest === "synthetic") origins.add("simulated");
  }
  if (!origins.size) origins.add("not_stated");
  const ordered = VCR_COMPARATOR_ORIGINS.filter((origin) => origins.has(origin));
  const origin = weakestOrigin(ordered);
  return {
    origins: ordered, origin,
    // only an observed control (or the observed half of a hybrid) is made of people; a simulated or predicted arm adds none (review stats P2-11)
    observedPeople: origins.has("observed") ? real : 0,
    reconstructedPseudoPatients: pseudo,
    simulatedMembers: origin === "simulated" ? generated : 0,
    modelConditional: ordered.some((entry) => entry === "model_predicted" || entry === "simulated"),
  };
}

/** @type {Readonly<Record<string, Omit<PremiseRow, "key">>>} */
const ORIGIN_PREMISES = Object.freeze({
  aggregate: { label: "对照组的数据", decisive: true, source: "literature",
    value: "对照组只有已发表的汇总数（均值、率或曲线），没有个体数据，所以只能比较汇总数能比较的部分，不能按人调整。" },
  reconstructed: { label: "对照组的数据", decisive: true, source: "literature",
    value: "对照组的个体数据是按发表的生存曲线重建的伪个体，不是真实观察到的人；样本量按重建的数据算，不当作真实患者数。" },
  model_predicted: { label: "对照组的数据", decisive: true, source: "assumed",
    value: "对照组是模型对这些人的预测，不是观察到的对照；比较的是治疗组相对模型预测的差异，不是随机对照下的疗效。" },
  simulated: { label: "对照组的数据", decisive: true, source: "assumed",
    value: "对照组完全由模拟生成，没有一个真实观察到的人；它不增加真实患者数，结论只在所设的模型假设下成立。" },
  not_stated: { label: "对照组的数据", decisive: false, source: "default",
    value: "这次计算没有写明对照组数据是真实观察还是别的来源，所以不把它当作真实观察到的人。" },
});

/**
 * The origin of a comparator's control as premises of the one block: what the control is made of. An observed control has no origin row.
 * No row talks about another population: no result of this page claims one, and a sentence that no result turns on is a disclaimer.
 * @param {ReturnType<typeof comparatorOrigins>} origins
 * @returns {PremiseRow[]}
 */
export function comparatorOriginPremises(origins) {
  /** @type {PremiseRow[]} */
  const rows = [];
  for (const origin of origins.origins) {
    const premise = ORIGIN_PREMISES[origin];
    if (!premise) continue;
    const pseudo = origin === "reconstructed" && origins.reconstructedPseudoPatients > 0 ? `（共 ${origins.reconstructedPseudoPatients} 个）` : "";
    rows.push({ key: `origin:${origin}`, ...premise, value: premise.value.replace("伪个体，", `伪个体${pseudo}，`) });
  }
  return rows;
}

/**
 * The origin block of an export: the same facts as the page, keyed for a template or a person reading the file. The counts name
 * what each number counts, so a simulated control's rows are never read as patients.
 * @param {{ results?: readonly Record<string, any>[], comparator?: Record<string, any> | null, executions?: ReadonlyMap<string, Record<string, any>> | null }} input
 * @returns {{ origin: string, origins: string[], label: string, observedPeople: number, reconstructedPseudoPatients: number, simulatedMembers: number, modelConditional: boolean } | null}
 */
export function comparatorOriginsOfReport({ results = [], comparator = null, executions = null } = {}) {
  const named = text(object(comparator).resultId);
  // the design's own comparison; a design that has not run has no control to describe
  const result = comparator
    ? (named ? list(results).map(object).find((row) => row.id === named && row.kind === "comparator") ?? null : null)
    : list(results).map(object).find((row) => row.kind === "comparator") ?? null;
  if (!result) return null;
  const execution = result?.executionId && executions ? executions.get(String(result.executionId)) : null;
  const found = comparatorOrigins({ route: text(object(comparator).route), method: text(object(execution).method), diagnostics: object(result?.diagnostics), counts: object(result?.counts) });
  return { ...found, label: VCR_COMPARATOR_ORIGIN_LABELS_ZH[found.origin] };
}
