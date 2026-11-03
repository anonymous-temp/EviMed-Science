/**
 * What the trial page says of a dose-finding design (algorithm round T7, T15, 2026-11-03): the result of a `design_dose` job.
 *
 * A dose-finding result is not one of the page's designs (A, B, C) and belongs to no object of the study: it is a result of its own kind,
 * filed under the designs it compares and the toxicity curve (or the response rates) it was asked on, that the conversation computes
 * (`vcr_simulate`, kind `design_dose`). The trial tab lists the current one of each key as a card. This module turns the engine's result
 * into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The card is a comparison whenever the person asked for one.** The engine runs the designs on the same curve with the same random
 *   numbers (`diagnostics.doseFinding.designs`) and returns the paired difference of the design asked about against each of the others,
 *   with the error of the differences. The card puts the designs side by side in one table, then the differences, then the dose-by-dose
 *   allocation: "which one picks the right dose more often, and how many more people are given too much" is read without a second page.
 * - **The right dose is a convention and the card says which.** The true MTD is the dose whose true toxicity is closest to the target;
 *   "above the MTD" counts the patients treated at higher doses. Both are premises of the card, as is what BOIN is (the local design with
 *   a non-informative prior; combinations and late-onset toxicity are not in it). Nothing on the card says that a design is qualified or
 *   endorsed by anyone.
 * - **Every number is a `VcrValue`** (`measureValue`): the percentage, the Monte-Carlo error of a simulated one, the source word. A
 *   randomised selection is exact and its numbers carry no error.
 * - **A default the person did not state is a premise** (`premises`, the shared block 「这个结论的前提」): the engine lists what it
 *   assumed and this module words each one.
 * - **No back-office word reaches the card.** A cell name the engine uses (`select_dose_3`) is labelled by `cellLabel`; a name it cannot
 *   label is left out rather than printed raw.
 *
 * @module vcrDoseFinding
 */

import { createHash } from "node:crypto";
import { finishPremises } from "./vcrPremises.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a dose-finding result is filed under (the result's `subject_id`): the designs it is about and the curve (or the response
 * rates and the margin) it was asked on. The same question asked again is the next version of one result; another curve, or another set
 * of designs, is another result.
 * @param {Record<string, any>} scenario
 */
export function vcrDoseSubjectId(scenario) {
  const design = object(scenario?.design);
  const truth = object(scenario?.truth);
  const kinds = [String(design.kind ?? "unknown"), ...list(design.compare).map(String)].sort();
  const basis = design.kind === "randomized_selection"
    ? [truth.responseScenarios ?? null, design.margin ?? null]
    : [truth.toxicity ?? null, design.targetToxicity ?? null];
  return `dose:${kinds.join("+")}:${createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 10)}`;
}

const DESIGN_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ three_plus_three: "3+3", boin: "BOIN", keyboard: "Keyboard", crm: "CRM" }));
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} fraction */
const percent = (fraction) => `${plain(fraction * 100)}%`;

/**
 * The label of a cell or a headline number the engine named. `null` for a name this page does not word.
 * @param {string} name @returns {string | null}
 */
export function cellLabel(name) {
  const fixed = /** @type {Record<string, string>} */ ({
    correct_dose_probability: "选对最大耐受剂量的概率", select_above_mtd_probability: "选到比最大耐受剂量更高的剂量的概率",
    select_below_mtd_probability: "选到比最大耐受剂量更低的剂量的概率", select_none_probability: "没有选出任何剂量的概率（因毒性过高提前终止）",
    expected_sample_size: "期望样本量", expected_dlt: "出现毒性反应的患者数（平均）", patients_above_mtd: "超过最大耐受剂量的患者数（平均）",
    patients_at_mtd: "在最大耐受剂量上的患者数（平均）", patients_below_mtd: "低于最大耐受剂量的患者数（平均）",
    per_arm: "每个剂量的患者数", total_patients: "患者总数", required_per_arm: "每个剂量所需患者数", worst_correct_selection_probability: "各情形里选对的概率的最小值",
  });
  if (fixed[name]) return fixed[name];
  let hit = /^select_dose_(\d+)$/.exec(name);
  if (hit) return `选中第 ${hit[1]} 剂量的概率`;
  hit = /^patients_dose_(\d+)$/.exec(name);
  if (hit) return `第 ${hit[1]} 剂量的患者数（平均）`;
  return null;
}

/**
 * A probability that no trial in the batch contradicted (0 events, or a size that was the same in every trial) has an error of exactly 0,
 * which is the formula's degenerate answer and not a claim of perfect precision: it is shown with no error rather than with "±0".
 * @param {Record<string, any>} measure @param {{ result: Record<string, any>, staleMark: any }} context
 */
const shown = (measure, { result, staleMark }) => measureValue(measure?.mcse === 0 ? { ...measure, mcse: undefined } : measure, { kind: "design_dose", result, tab: "trial", staleMark });

/** @param {string} key @param {unknown} raw */
function assumptionRow(key, raw) {
  const pct = (/** @type {any} */ v) => percent(Number(v));
  const words = /** @type {Record<string, (v: any) => [string, string]>} */ ({
    "design.targetToxicity": (v) => ["目标毒性率", pct(v)],
    "design.cohortSize": (v) => ["每组入组人数", `${plain(Number(v))} 人`],
    "design.maxPatients": (v) => ["最多入组人数", `${plain(Number(v))} 人`],
    "design.startDose": (v) => ["起始剂量", `第 ${plain(Number(v))} 剂量`],
    "design.boin.safeRate": (v) => ["BOIN 认为安全的毒性率", pct(v)],
    "design.boin.toxicRate": (v) => ["BOIN 认为过毒的毒性率", pct(v)],
    "design.boin.eliminationCutoff": (v) => ["BOIN 停用过毒剂量的把握", pct(v)],
    "design.keyboard.margin": (v) => ["Keyboard 目标区间的半宽", pct(v)],
    "design.keyboard.eliminationCutoff": (v) => ["Keyboard 停用过毒剂量的把握", pct(v)],
    "design.crm.skeleton": (v) => ["CRM 的先验毒性骨架（各剂量的先验猜测）", list(v).map((p) => pct(p)).join(" / ")],
    "design.crm.priorVariance": (v) => ["CRM 参数的先验方差", plain(Number(v))],
    "design.crm.restrictEscalation": (v) => ["CRM 的升级限制", v === true ? "一次最多升一级，上一组毒性率达到目标时不升级" : "不限制"],
    "design.targetProbability": (v) => ["要求选对的概率", pct(v)],
    "design.maxPerArm": (v) => ["搜索样本量的上限", `每个剂量 ${plain(Number(v))} 人`],
    "trials": (v) => ["每种设计模拟的试验次数", plain(Number(v))],
  });
  const make = words[key];
  if (make) {
    const [label, value] = make(raw);
    return { key: `dose:${key}`, label, value, source: "default", decisive: false, reason: null };
  }
  const methods = /** @type {Record<string, [string, string]>} */ ({
    "truth.mtd": ["“选对”的含义", "毒性最接近目标的那个剂量（并列时取较低的）为真正的最大耐受剂量；超过它的剂量算超量"],
    "method.three_plus_three": ["3+3 的规则", "每组 3 人；0/3 升级，1/3 再入 3 人（共 6 人中不超过 1 例才升级），出现 2 例及以上则该剂量算超量，退回较低剂量并以 6 人确认；人数由规则决定"],
    "method.keyboard": ["Keyboard 的规则", "均匀先验；按毒性率落在哪一段区间的把握最大决定升、降或留，最后用保序回归选剂量"],
    "method.crm": ["CRM 的规则", "幂模型；参数的后验均值用数值积分得到；总人数固定，不因毒性过高提前终止"],
  });
  const method = methods[key];
  if (method) return { key: `dose:${key}`, label: method[0], value: method[1], source: "default", decisive: false, reason: null };
  return null;
}

/**
 * @param {Record<string, any>} dose the engine's `diagnostics.doseFinding`
 * @param {string[]} kinds
 */
function premisesOfFinding(dose, kinds) {
  const given = object(dose.given);
  const curve = object(dose.curve);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  const tox = list(curve.toxicity).map(Number);
  if (tox.length) rows.push({ key: "curve", label: `各剂量的真实毒性率（共 ${tox.length} 个剂量）`, value: tox.map((p) => percent(p)).join(" / "), source: "assumed", decisive: true });
  const target = numeric(curve.target);
  if (target !== null) rows.push({ key: "target", label: "目标毒性率", value: percent(target), source: numeric(given.targetToxicity) === null ? "default" : "given", decisive: true });
  const assumed = list(dose.assumed).map(object);
  const keys = new Set(assumed.map((entry) => String(entry.key)));
  const maxPatients = assumed.find((entry) => entry.key === "design.maxPatients");
  const cohort = assumed.find((entry) => entry.key === "design.cohortSize");
  if (kinds.some((kind) => kind !== "three_plus_three")) {
    rows.push({ key: "size", label: "入组人数与每组人数", value: `最多 ${plain(Number(maxPatients?.value ?? given.maxPatients))} 人，每组 ${plain(Number(cohort?.value ?? given.cohortSize))} 人（3+3 的人数由规则决定）`,
      source: keys.has("design.maxPatients") ? "default" : "given", decisive: true });
  }
  if (kinds.includes("crm")) {
    const skeleton = assumed.find((entry) => entry.key === "design.crm.skeleton");
    if (skeleton) rows.push({ key: "skeleton", label: "CRM 的先验毒性骨架（对结果影响很大）", value: list(skeleton.value).map((p) => percent(Number(p))).join(" / "), source: "default", decisive: true });
  }
  if (kinds.includes("boin")) {
    rows.push({ key: "boin", label: "BOIN 的版本", value: "只实现局部（local）边界、无信息先验的 BOIN；联合用药和迟发毒性不在其中", source: "default", decisive: true });
  }
  for (const entry of assumed) {
    const row = assumptionRow(String(entry.key), entry.value);
    if (row && row.key !== "dose:design.crm.skeleton" && row.key !== "dose:design.targetToxicity") rows.push(row);
  }
  return finishPremises(rows);
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function dosePayload(result, staleMark) {
  const dose = object(object(result.diagnostics).doseFinding);
  const context = { result, staleMark };
  const curve = object(dose.curve);
  const designs = list(dose.designs).map(object);
  const kinds = designs.map((design) => String(design.kind));
  const asked = designs.find((design) => design.role === "asked") ?? designs[0];
  if (!asked) return null;
  const labelOf = (/** @type {string} */ kind) => DESIGN_WORDS[kind] ?? kind;
  const compared = kinds.length > 1;
  const columns = [
    { key: "correct_dose_probability", label: "选对最大耐受剂量的概率" }, { key: "patients_above_mtd", label: "超过最大耐受剂量的患者数（平均）" },
    { key: "expected_sample_size", label: "期望样本量" }, { key: "expected_dlt", label: "出现毒性反应的患者数（平均）" },
    { key: "select_above_mtd_probability", label: "选到更高剂量的概率" }, { key: "select_none_probability", label: "没有选出剂量的概率" },
  ];
  const rows = designs.map((design) => {
    const cells = object(design.cells);
    return { kind: String(design.kind), label: labelOf(String(design.kind)), role: String(design.role), cells: Object.fromEntries(columns.map((column) => [column.key, cells[column.key] ? shown(cells[column.key], context) : null])) };
  });
  const differenceColumns = [
    { key: "correct_dose_probability", label: "选对概率之差（百分点）" }, { key: "patients_above_mtd", label: "超量患者数之差" },
    { key: "expected_sample_size", label: "期望样本量之差" }, { key: "expected_dlt", label: "毒性反应患者数之差" },
  ];
  const differences = list(dose.differences).map(object).map((entry) => {
    const cells = object(entry.cells);
    return { kind: String(entry.kind), label: `${labelOf(String(entry.kind))} 比 ${labelOf(String(entry.against))}`,
      cells: Object.fromEntries(differenceColumns.map((column) => [column.key, cells[column.key] ? shown(cells[column.key], context) : null])) };
  });
  const doses = list(curve.toxicity).map((toxicity, index) => ({ dose: index + 1, toxicity: Number(toxicity) * 100, mtd: index + 1 === Number(curve.mtd) }));
  const perDose = designs.map((design) => {
    const cells = object(design.cells);
    return { kind: String(design.kind), label: labelOf(String(design.kind)),
      select: doses.map((entry) => (cells[`select_dose_${entry.dose}`] ? shown(cells[`select_dose_${entry.dose}`], context) : null)),
      patients: doses.map((entry) => (cells[`patients_dose_${entry.dose}`] ? shown(cells[`patients_dose_${entry.dose}`], context) : null)) };
  });
  const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
    .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shown(entry.value, context) }));
  const trialsDone = numeric(dose.trials);
  const trialsAsked = numeric(dose.trialsRequested);
  const limited = result.conclusion === "limited" || list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
    ? `只模拟完了一部分试验（${trialsDone ?? "?"} 次，原定 ${trialsAsked ?? "?"} 次），数字按已完成的给出。` : null;
  return {
    id: String(result.id), version: Number(result.version), form: "dose_finding", design: String(asked.kind),
    title: compared ? `${labelOf(kinds[0])} 与 ${kinds.slice(1).map(labelOf).join("、")} 的对比` : `${labelOf(String(asked.kind))} 的运行特征`,
    question: compared ? "在这条毒性曲线下，几种设计选对最大耐受剂量的概率、超量给药的人数差多少" : "在这条毒性曲线下，这种设计选对最大耐受剂量的概率、超量给药的人数是多少",
    trials: trialsDone, askedLabel: labelOf(String(asked.kind)), target: numeric(curve.target) === null ? null : Number(curve.target) * 100, doses, headline,
    table: { columns, rows }, differences: differences.length ? { columns: differenceColumns, rows: differences, note: "各设计用同一批患者的耐受性模拟，差值的误差按逐次试验的差值计算。" } : null,
    perDose, premises: premisesOfFinding(dose, kinds), limited, selection: null,
  };
}

/** @param {Record<string, any>} result @param {any} staleMark */
function selectionPayload(result, staleMark) {
  const selection = object(object(result.diagnostics).doseSelection);
  const context = { result, staleMark };
  const scenarios = list(selection.scenarios).map(object);
  const doses = Number(selection.doses ?? 0);
  const rows = scenarios.map((row, index) => {
    const cells = object(row.cells);
    return { label: `情形 ${index + 1}`, rates: list(row.rates).map((rate) => Number(rate) * 100), rightDose: numeric(row.rightDose),
      correct: cells.correct_dose_probability ? shown(cells.correct_dose_probability, context) : null,
      select: Array.from({ length: doses }, (_, j) => (cells[`select_dose_${j + 1}`] ? shown(cells[`select_dose_${j + 1}`], context) : null)) };
  });
  const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
    .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shown(entry.value, context) }));
  const margin = numeric(selection.margin);
  const target = numeric(selection.targetProbability);
  const first = numeric(selection.requiredFirst);
  const stable = numeric(selection.requiredStable);
  const given = object(selection.given);
  /** @type {Array<Record<string, any>>} */
  const premises = [
    { key: "rates", label: "各情形里各剂量的真实缓解率", value: scenarios.map((row) => list(row.rates).map((rate) => percent(Number(rate))).join(" / ")).join("；"), source: "assumed", decisive: true },
  ];
  if (margin !== null) premises.push({ key: "margin", label: "选更高剂量的条件", value: `更高剂量的观察缓解率至少比候选剂量高 ${percent(margin)}（即至少多 ${plain(Number(selection.cutoffResponses ?? 0))} 例），否则留在较低剂量；从最低剂量依次比较`, source: "given", decisive: true });
  premises.push({ key: "right", label: "“选对”的含义", value: "真实缓解率与最好的相差不到上述差值的剂量中最低的那个", source: "default", decisive: true });
  if (target !== null) premises.push({ key: "probability", label: "要求选对的概率", value: percent(target), source: numeric(given.targetProbability) === null ? "default" : "given", decisive: true });
  const size = numeric(selection.perArm);
  const note = first !== null && stable !== null && stable > first
    ? `第一次达到的人数是每个剂量 ${plain(first)} 人；按整数个数判定，概率会随人数上下起伏，从每个剂量 ${plain(stable)} 人起此后每个人数都达到要求。`
    : first !== null ? `每个剂量 ${plain(first)} 人起此后每个人数都达到要求。` : null;
  return {
    id: String(result.id), version: Number(result.version), form: "dose_selection", design: "randomized_selection",
    title: "随机分组的剂量选择", question: "每个剂量各多少人，才有把握选到更低而不差的剂量",
    trials: null, askedLabel: "", target: null, doses: [], headline, table: null, differences: null, perDose: [],
    premises: finishPremises(premises),
    limited: first === null && size !== null && numeric(selection.targetProbability) !== null && result.conclusion === "limited"
      ? `在搜索上限内没有哪个人数能让每个情形都达到 ${percent(Number(selection.targetProbability))}，下表是每个剂量 ${plain(size)} 人时的结果。` : null,
    selection: { perArm: size, totalPatients: size === null ? null : size * doses, doses, margin: margin === null ? null : margin * 100, targetProbability: target === null ? null : target * 100, requiredFirst: first, requiredStable: stable, note, scenarios: rows },
  };
}

/**
 * The cards of the trial tab for the dose-finding results the study holds now, newest first.
 * @param {Record<string, any>} bundle the trial tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentDoseDesigns(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "design_dose" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => {
    const staleMark = markFor(bundle.stale ?? [], nodeOf(result));
    const diagnostics = object(result.diagnostics);
    if (diagnostics.doseSelection) return selectionPayload(result, staleMark);
    if (diagnostics.doseFinding) return dosePayload(result, staleMark);
    return null;
  }).filter(Boolean);
}
