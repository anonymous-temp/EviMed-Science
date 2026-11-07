/**
 * What a population version is for: where its people came from, which model it is bound to and so what can be computed with it
 * (in silico plan T07, sections 3.1 and 6).
 *
 * Hidden knowledge:
 *
 * - **A binding is a patient set.** A patient set already names the population version it was made from and the model library row
 *   (id and version) it was computed with, and the write door resolves that model to exactly one version. So no new object, column
 *   or migration holds a binding: this module reads the ones the study already has. A population with no patient set is a valid
 *   descriptive object, and the page says so instead of hiding it.
 * - **Origin and readiness are metadata of two different questions.** Origin (`literature_constrained`, `built_in`, `data_derived`,
 *   or `observed` for a cohort of real people) says where the people came from. Readiness (`descriptive_only`,
 *   `transition_model_bound`, `intervention_mapping_available`) says what a computation may do with them, read from what the model
 *   declares it can execute. Neither says how far the model was validated: that is the domain's use check
 *   (`vcrModelApplicabilityAssessment`, `modelUsePremises`) and reaches the page as sentences of the same premises block, so the
 *   two are never one badge.
 * - **Changing the model or the population invalidates only what read it.** A patient set is stale when the library no longer holds
 *   its model version (`model_missing`), holds a newer version of it (`model_changed`), or when it was made from an earlier version
 *   of the population than the one now current (`population_changed`). The comparison is by identity, so a result of another model
 *   or of an unrelated population is never touched, and a historical result stays readable under its own version.
 * - **Realizations are not people.** Several virtual realizations of one patient share a parent key; `realizationAccounting`
 *   counts members and parents apart and the observed-people count is only ever a real cohort's, never a virtual member's.
 * - **Pure.** Nothing is read from a store; the page hands over what it already holds.
 *
 * @module vcrPopulationBinding
 */

/** @typedef {import("./vcrPremises.mjs").VcrPremise} VcrPremise */
/** @typedef {Pick<VcrPremise, "key" | "label" | "value" | "source" | "decisive">} PremiseRow */

import { vcrModelApplicabilityAssessment } from "./vcrModelApplicability.mjs";
import { list, numeric, object, text } from "./vcrViewsKit.mjs";

/** Where a population's people came from (closed). */
export const VCR_POPULATION_ORIGINS = Object.freeze(["observed", "literature_constrained", "built_in", "data_derived"]);

/** What a computation may do with a population, weakest first (closed). */
export const VCR_POPULATION_READINESS = Object.freeze(["descriptive_only", "transition_model_bound", "intervention_mapping_available"]);

/** @type {Readonly<Record<string, string>>} */
export const VCR_POPULATION_ORIGIN_LABELS_ZH = Object.freeze({
  observed: "真实患者队列", literature_constrained: "文献约束的虚拟人群", built_in: "按设定生成的虚拟人群", data_derived: "由授权数据生成的虚拟人群",
});

/**
 * The origin of a population version from its kind. An unknown kind has no origin: nothing is guessed about where it came from.
 * @param {Record<string, any> | null | undefined} population
 * @returns {string | null}
 */
export function populationOrigin(population) {
  const kind = String(object(population).kind ?? "");
  return ({ real: "observed", literature: "literature_constrained", scenario: "built_in", empirical_synthetic: "data_derived" })[/** @type {"real"} */ (kind)] ?? null;
}

/**
 * What a model row can do, from what its card declares it can execute. A card that declares nothing and has no known call shape is
 * descriptive only: an unstated ability is not claimed.
 * @param {Record<string, any> | null | undefined} model
 * @returns {string}
 */
export function modelReadiness(model) {
  const card = object(object(model).card);
  if (!model || card.executable === false) return "descriptive_only";
  const modes = card.executableModes;
  if (Array.isArray(modes)) {
    if (modes.includes("intervention_comparison")) return "intervention_mapping_available";
    return modes.length ? "transition_model_bound" : "descriptive_only";
  }
  return ["baseline_to_outcome", "event_history_to_trajectories"].includes(String(card.interfaceShape)) ? "transition_model_bound" : "descriptive_only";
}

/** The model row a patient set names, by id or name and, when the set names one, version. @param {Record<string, any>} set @param {readonly Record<string, any>[]} models */
function modelOfSet(set, models) {
  const key = text(set.modelId);
  if (!key) return { found: null, newer: false, named: false };
  const named = models.filter((model) => model.id === key || model.name === key);
  const version = text(set.modelVersion);
  const found = named.find((model) => !version || String(model.version) === version) ?? null;
  // a newer row of the same model name than the version the set was computed with
  const newer = found ? named.some((model) => model.name === found.name && String(model.version) !== String(found.version) && Date.parse(String(model.createdAt ?? "")) > Date.parse(String(found.createdAt ?? ""))) : false;
  return { found, newer, named: true };
}

/**
 * The bindings of one population version: each patient set made from it, with the model it names, what that model can do and
 * whether the binding still holds. Sets made from another version of the study's populations are not this version's bindings; they
 * are reported separately as `earlier` when the population has since changed, so the page can say which results need a recompute.
 *
 * @param {Record<string, any> | null | undefined} population the version being read
 * @param {{ patientSets?: readonly Record<string, any>[], models?: readonly Record<string, any>[], populations?: readonly Record<string, any>[],
 *   endpointType?: string | null }} context
 * @returns {{ bindings: Array<Record<string, any>>, earlier: Array<Record<string, any>> }}
 */
export function bindingsOfPopulation(population, { patientSets = [], models = [], populations = [], endpointType = null } = {}) {
  const current = object(population);
  const lineage = new Set(list(populations).map((row) => String(object(row).id)));
  /** @type {Array<Record<string, any>>} */ const bindings = [];
  /** @type {Array<Record<string, any>>} */ const earlier = [];
  for (const raw of list(patientSets)) {
    const set = object(raw);
    if (!text(set.populationId) || !text(set.modelId)) continue;
    const { found, newer, named } = modelOfSet(set, list(models));
    const readiness = modelReadiness(found);
    const base = {
      patientSetId: String(set.id), patientSetVersion: Number(set.version) || 1, resultId: text(set.resultId),
      model: found ? { name: String(found.name ?? set.modelId), version: String(found.version ?? ""), title: text(object(found.card).title) ?? String(found.name ?? set.modelId) } : named ? { name: String(set.modelId), version: text(set.modelVersion) ?? "", title: String(set.modelId) } : null,
      readiness: found ? readiness : "descriptive_only",
      useContext: { endpoint: text(object(set.scenario).endpoint) ?? text(endpointType), horizon: object(set.scenario).horizon ?? null },
    };
    if (String(set.populationId) === String(current.id)) {
      bindings.push({ ...base, state: !found ? "model_missing" : newer ? "model_changed" : "current" });
    } else if (lineage.has(String(set.populationId))) {
      earlier.push({ ...base, state: "population_changed" });
    }
  }
  return { bindings, earlier };
}

/**
 * Members as accounting, never as people: virtual members, the observed people behind a real cohort, and how many members the
 * generator had to draw again to meet a stated limit.
 * @param {{ kind?: string, counts?: Record<string, any>, diagnostics?: Record<string, any> }} input
 */
export function memberAccounting({ kind = "", counts = {}, diagnostics = {} } = {}) {
  const held = object(counts);
  const enforcement = object(diagnostics.constraintEnforcement);
  const violations = list(diagnostics.constraintViolations).map(object);
  const virtual = kind === "real" ? null : numeric(held.generatedRecords);
  return {
    observedPeople: kind === "real" ? numeric(held.realPatients) : null,
    virtualMembers: virtual,
    redrawn: numeric(enforcement.rowsRedrawn),
    stillBreaking: violations.length ? Math.max(0, ...violations.map((row) => numeric(row.violations) ?? 0)) : null,
  };
}

/**
 * Members and the parents they realize. Realizations of one parent count once as a person and as many times as members.
 * @param {ReadonlyArray<Record<string, any>>} rows @param {string} parentKey the column naming the parent (a pseudonymous key)
 * @returns {{ members: number, parents: number }}
 */
export function realizationAccounting(rows, parentKey) {
  const parents = new Set();
  for (const row of rows) { const key = object(row)[parentKey]; if (key != null && key !== "") parents.add(String(key)); }
  return { members: rows.length, parents: parents.size };
}

/** @type {Readonly<Record<string, (title: string) => string>>} */
const READINESS_TEXT = Object.freeze({
  descriptive_only: () => "这批虚拟人目前只描述了人群本身（各变量的分布和相互关系），还没有和任何能往后推演的模型绑定；不能直接拿来比较治疗。",
  transition_model_bound: (title) => `已绑定模型“${title}”：可以按它推演每个人往后的变化；这个模型没有可以放入治疗的输入，所以不能用它比较治疗。`,
  intervention_mapping_available: (title) => `已绑定模型“${title}”：可以把你给定的治疗安排放进去做模型推演；结果表示在该安排下可能怎样变化，不是疗效的证明。`,
});

/** @type {Readonly<Record<string, string>>} */
const ORIGIN_TEXT = Object.freeze({
  literature_constrained: "这批虚拟人的分布来自文献里的汇总数，不是真实患者；同一个人的多次虚拟实现不算多个真实的人。",
  built_in: "这批虚拟人按设定的变量分布生成，不是任何真实患者；同一个人的多次虚拟实现不算多个真实的人。",
  data_derived: "这批虚拟人由授权的真实患者数据生成，每一条记录都是合成的，不是真实的人；真实患者数以数据本身为准。",
});

/**
 * The page's read of a population version's origin, readiness and bindings. `readiness` is the strongest of the bindings that still
 * hold; a stale binding does not count towards it.
 *
 * @param {Record<string, any> | null | undefined} population
 * @param {Parameters<typeof bindingsOfPopulation>[1] & { diagnostics?: Record<string, any>, counts?: Record<string, any> }} context
 */
export function populationBindingView(population, context = {}) {
  const origin = populationOrigin(population);
  const { bindings, earlier } = bindingsOfPopulation(population, context);
  const holding = bindings.filter((binding) => binding.state === "current");
  const readiness = holding.reduce((best, binding) => (VCR_POPULATION_READINESS.indexOf(binding.readiness) > VCR_POPULATION_READINESS.indexOf(best) ? binding.readiness : best), "descriptive_only");
  const strongest = holding.find((binding) => binding.readiness === readiness) ?? null;
  return {
    origin, originLabel: origin ? VCR_POPULATION_ORIGIN_LABELS_ZH[origin] : null,
    readiness, bound: strongest ? strongest.model : null,
    bindings, earlier,
    members: memberAccounting({ kind: String(object(population).kind ?? ""), counts: context.counts, diagnostics: context.diagnostics }),
  };
}

/**
 * The binding as premises of the one 「这个结论的前提」 block: what the people are, what a computation may do with them, which
 * results no longer follow from what they were computed on, and how many members were drawn again. Sentences, each with its value.
 * A real cohort has no origin sentence: its people are the data.
 * @param {ReturnType<typeof populationBindingView>} view
 * @returns {PremiseRow[]}
 */
export function populationBindingPremises(view) {
  /** @type {PremiseRow[]} */
  const rows = [];
  if (view.origin && ORIGIN_TEXT[view.origin]) {
    rows.push({ key: "binding:origin", label: "这批人从哪里来", value: ORIGIN_TEXT[view.origin], decisive: false,
      source: view.origin === "literature_constrained" ? "literature" : view.origin === "data_derived" ? "given" : "assumed" });
  }
  if (view.origin && view.origin !== "observed") {
    const title = view.bound?.title ?? "";
    rows.push({ key: "binding:readiness", label: "能用来做什么", value: READINESS_TEXT[view.readiness](title), decisive: true, source: "default" });
  }
  const stale = view.bindings.filter((binding) => binding.state !== "current");
  const gone = stale.filter((binding) => binding.state === "model_missing").length;
  const changed = stale.length - gone;
  if (stale.length) {
    rows.push({ key: "binding:stale_model", label: "模型有变动", decisive: true, source: "default",
      value: `${changed ? `${changed} 个用这批人算出的结果用的是模型的旧版本` : ""}${changed && gone ? "，" : ""}${gone ? `${gone} 个结果用的模型已不在模型库里` : ""}；结果仍按当时的版本保留，需要时重新计算。` });
  }
  if (view.earlier.length) {
    rows.push({ key: "binding:stale_population", label: "人群有变动", decisive: true, source: "default",
      value: `${view.earlier.length} 个结果是按这批人的更早版本算的，没有随人群更新；它们仍可查看，需要时重新计算。` });
  }
  const redrawn = view.members.redrawn;
  if (redrawn !== null && redrawn > 0) {
    rows.push({ key: "binding:members", label: "不合限定的记录", decisive: false, source: "default",
      value: `生成时有 ${redrawn} 条记录违反设定的限定，已重新抽取；最后${view.members.stillBreaking ? `仍有 ${view.members.stillBreaking} 条违反` : "没有记录违反限定"}。` });
  }
  return rows;
}

/**
 * The premises of the use every bound model is held to, as the domain's use check reads them for the context each binding states
 * (its endpoint). A code found for several models is said once. Empty for a population with no binding that still holds.
 * @param {ReturnType<typeof populationBindingView>} view
 * @param {readonly Record<string, any>[]} models
 * @returns {Array<{ code: string, field: string }>}
 */
export function bindingUseFindings(view, models) {
  /** @type {Map<string, { code: string, field: string }>} */
  const found = new Map();
  for (const binding of view.bindings) {
    if (binding.state !== "current" || !binding.model) continue;
    const model = list(models).find((row) => row.name === binding.model.name && String(row.version) === binding.model.version);
    if (!model) continue;
    const { premises } = vcrModelApplicabilityAssessment(model, { endpointType: binding.useContext.endpoint, variables: new Map(), mode: "conditional_forecast",
      ...(binding.useContext.endpoint ? { endpoint: binding.useContext.endpoint } : {}) });
    for (const premise of premises) if (!found.has(premise.code)) found.set(premise.code, premise);
  }
  return [...found.values()];
}
