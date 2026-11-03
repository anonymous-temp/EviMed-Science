/**
 * What the trial page says of a confirmatory design (algorithm round T2-T6, 2026-11-03): the result of a `design_confirmatory` job.
 *
 * A confirmatory design is not one of the page's designs (A, B, C): it is a result of its own kind, filed under a key made of its design
 * kind and endpoint, that the conversation computes (`vcr_simulate`, kind `design_confirmatory`). The trial tab lists the current one of
 * each key as a card. This module turns the engine's result into the card's payload, and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **Every card says what question it answers.** `design.kind` has one sentence in `KIND_WORDS`, the question a person asked before
 *   they ran it ("效应没把握，中期加样，功效和平均要多少人"), not the method's name. The card opens with it.
 * - **An adaptive design is never alone.** The baselines the engine returned (the fixed design and the group-sequential design with
 *   the same looks for a re-estimation, a trial per arm for a selection, the full population for an enrichment) sit in the same table,
 *   row by row, so that what the adaptation buys, and what it costs where it does not help, is read without a second page.
 * - **Every number is a `VcrValue`** (`measureValue`): the percentage, the Monte-Carlo error of a simulated one, the source word. The
 *   cells of the per-effect table come out of the engine as measure-shaped objects for that reason.
 * - **A default the person did not state is a premise** (`premises`, the shared block 「这个结论的前提」): the engine lists what it
 *   assumed (`diagnostics.confirmatory.assumed`) and this module words each one; the null row the engine adds is one of them.
 * - **No back-office word reaches the card.** The cell names the engine uses (`stop_efficacy_2`) are labelled by `cellLabel`; a name it
 *   cannot label is left out rather than printed raw.
 *
 * @module vcrConfirmatory
 */

import { finishPremises } from "./vcrPremises.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a confirmatory result is filed under (the result's `subject_id`): the design and the endpoint. Two runs of the same design on
 * the same endpoint are versions of one result; a futility design and a re-estimation are two.
 * @param {Record<string, any>} scenario
 */
export function vcrConfirmatorySubjectId(scenario) {
  const design = String(object(scenario?.design).kind ?? "unknown");
  const endpoint = String(object(scenario?.endpoint).type ?? "count");
  return `cd:${design}:${endpoint}`;
}

/** The design kinds in the words of the page: a title, the question it answers, and what the effect on a row is. */
const KIND_WORDS = Object.freeze(/** @type {Record<string, { title: string, question: string }>} */ ({
  futility_group_sequential: { title: "中期无效性停止", question: "中期发现没戏就停，能省多少人" },
  sample_size_reestimation: { title: "样本量再估计", question: "效应没把握，中期加样，功效和平均要多少人" },
  multi_arm_selection: { title: "多臂中期选择", question: "几个剂量加一个对照，中期只留一个，比分开做省多少人，选错的概率多大" },
  enrichment: { title: "人群富集", question: "标志物阳性只占一部分，中期收窄入组，功效如何" },
  count_endpoint: { title: "计数终点的样本量", question: "每年发作次数这类计数终点，需要多少人" },
}));
const ENDPOINT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ continuous: "连续型终点", binary: "二分类终点", time_to_event: "事件时间终点", count: "计数终点" }));
const EFFECT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  continuous: "均值差", binary: "率差", time_to_event: "风险比", count: "率比",
}));
const ROLE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ null: "无效应", planned: "计划的效应", assumed: "设想的效应" }));
const SPENDING_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  obrien_fleming: "O'Brien-Fleming 型", pocock: "Pocock 型", hwang_shih_decani: "Hwang-Shih-DeCani 型", kim_demets: "Kim-DeMets 型",
}));
const SELECTION_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ best: "只留中期估计最好的", rbest: "留最好的几个", epsilon: "留与最好的相差不大的", all: "都留" }));

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/**
 * The label of a cell or a headline number the engine named. `null` for a name this page does not word.
 * @param {string} name @returns {string | null}
 */
export function cellLabel(name) {
  const fixed = /** @type {Record<string, string>} */ ({
    power: "功效（拒绝零假设的概率）", type_one_error: "I 类错误（无效应时仍拒绝的概率）", expected_sample_size: "期望样本量", expected_events: "期望事件数",
    expected_patients: "期望入组人数", expected_sample_size_h0: "无效应时的期望样本量", expected_events_h0: "无效应时的期望事件数",
    futility_stop_probability: "中途因无效停止的概率", futility_stop_probability_h0: "无效应时中途停止的概率", early_stop_probability: "中期就达标而停止的概率",
    increase_probability: "中期加样的概率", correct_selection_probability: "选中真正最好的臂的概率", selected_subset: "保留标志物阳性亚组的概率",
    selected_full: "保留全人群的概率", reject_subset: "亚组结论成立的概率", reject_full: "全人群结论成立的概率",
    required_total: "固定设计所需样本量", required_events: "固定设计所需事件数", required_treatment: "试验组所需样本量", required_control: "对照组所需样本量",
    max_patients: "最多患者数", max_events: "最多事件数", planned_total: "计划样本量", planned_events: "计划事件数", separate_trials_size: "每臂各做一个试验的总例数",
  });
  if (fixed[name]) return fixed[name];
  let hit = /^stop_efficacy_(\d+)$/.exec(name);
  if (hit) return `第 ${hit[1]} 次分析达标而停止的概率`;
  hit = /^stop_futility_(\d+)$/.exec(name);
  if (hit) return `第 ${hit[1]} 次分析因无效而停止的概率`;
  hit = /^selected_arm_(\d+)$/.exec(name);
  if (hit) return `第 ${hit[1]} 臂被保留的概率`;
  hit = /^reject_arm_(\d+)$/.exec(name);
  if (hit) return `第 ${hit[1]} 臂的结论成立的概率`;
  return null;
}

/**
 * One number of the result as the page shows it.
 * @param {Record<string, any>} measure @param {{ result: Record<string, any>, staleMark: any }} context
 */
function shownValue(measure, { result, staleMark }) {
  return measureValue(measure, { kind: "design_confirmatory", result, tab: "trial", staleMark });
}

/** A number the engine computed without a simulation, as a `calculated` measure of the given name (the baselines' power and sizes). @param {string} name @param {unknown} number */
const calculated = (name, number) => (numeric(number) === null ? null : { name, value: Number(number), simulated: false, source: "calculated" });

/** The effect of a row in words: one number, a list per arm, or a subset and the rest. @param {Record<string, any>} row @param {string} endpoint */
function effectText(row, endpoint) {
  const effect = row.effect;
  const word = EFFECT_WORDS[endpoint] ?? "效应";
  if (Array.isArray(effect)) return `${effect.map((each) => plain(Number(each))).join(" / ")}（各臂的${word}）`;
  if (effect && typeof effect === "object") return `亚组 ${plain(Number(effect.subset))}，其余 ${plain(Number(effect.rest))}（${word}）`;
  return numeric(effect) === null ? "—" : `${word} ${plain(Number(effect))}`;
}

/** @param {string} key @param {unknown} raw */
function assumptionRow(key, raw) {
  const words = /** @type {Record<string, (v: any) => [string, string]>} */ ({
    "analysis.alpha": (v) => ["显著性水平（单侧）", `${plain(Number(v) * 100)}%`],
    "analysis.power": (v) => ["目标功效", `${plain(Number(v) * 100)}%`],
    "design.spending": (v) => ["期中分析的 α 消耗", SPENDING_WORDS[String(v)] ?? String(v)],
    "design.allocation": (v) => ["试验组所占比例", `${plain(Number(v) * 100)}%`],
    "design.futility": () => ["无效性边界", "β 消耗（O'Brien-Fleming 型），不具约束力"],
    "design.futility.spending": (v) => ["无效性边界的 β 消耗", SPENDING_WORDS[String(v)] ?? String(v)],
    "design.futility.binding": (v) => ["无效性边界是否具约束力", v === true ? "具约束力" : "不具约束力"],
    "design.conditionalPower": (v) => ["再估计的目标条件功效", `${plain(Number(v) * 100)}%`],
    "design.eventDriven": () => ["事件时间终点的模拟方式", "按计划的事件数直接模拟各组的对数秩统计量，假定比例风险、各组对照风险相同；不模拟入组、随访和脱落"],
    "design.maxSampleSizeFactor": (v) => ["样本量最多可增加到计划的", `${plain(Number(v))} 倍`],
    "design.plannedSize": (v) => ["计划样本量", `${plain(Number(v))}（取同样分析次数的成组序贯设计的样本量）`],
    "design.selection.rule": (v) => ["中期的选择规则", SELECTION_WORDS[String(v)] ?? String(v)],
    "design.intersectionTest": (v) => ["交集假设的检验", String(v) === "simes" ? "Simes" : String(v) === "bonferroni" ? "Bonferroni" : "Dunnett"],
    "truth.sd": (v) => ["结局的标准差", plain(Number(v))],
    "truth.exposureTime": (v) => ["每位患者的暴露时间", plain(Number(v))],
    "truth.effects": () => ["零假设一行", "没有列出无效应时，补上一行，用来显示 I 类错误"],
    "truth.effectScenarios": () => ["零假设一行", "没有列出各臂都无效应的情形时，补上一行，用来显示 I 类错误"],
    "truth.subsetEffects": () => ["零假设一行", "没有列出两组都无效应的情形时，补上一行，用来显示 I 类错误"],
  });
  const make = words[key];
  if (!make) return null;
  const [label, shown] = make(raw);
  return { key: `confirmatory:${key}`, label, value: shown, source: "default", decisive: false, reason: null };
}

/**
 * The premises of a card: the values the answer turns on that the scenario states (the planned effect, the control level), then what
 * the engine took because nothing said otherwise.
 * @param {Record<string, any>} confirmatory the engine's `diagnostics.confirmatory` (`given` is what the scenario stated)
 */
function premisesOf(confirmatory) {
  const endpoint = String(confirmatory.endpoint ?? "");
  const given = object(confirmatory.given);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  const planned = numeric(given.plannedEffect);
  if (planned !== null) rows.push({ key: "effect", label: `计划的效应（${EFFECT_WORDS[endpoint] ?? "效应"}）`, value: plain(planned), source: "assumed", decisive: true });
  const scenarios = numeric(given.effectScenarios);
  if (scenarios) rows.push({ key: "effect", label: "设想的效应情形", value: `${scenarios} 种，每种给出各臂的${EFFECT_WORDS[endpoint] ?? "效应"}`, source: "assumed", decisive: true });
  const subsets = numeric(given.subsetScenarios);
  if (subsets) rows.push({ key: "effect", label: "设想的效应情形", value: `${subsets} 种，给出亚组和其余人群的${EFFECT_WORDS[endpoint] ?? "效应"}`, source: "assumed", decisive: true });
  if (numeric(given.rateRatio) !== null) rows.push({ key: "effect", label: "率比", value: plain(Number(given.rateRatio)), source: "assumed", decisive: true });
  if (numeric(given.controlRate) !== null) rows.push({ key: "control", label: "对照组事件率", value: `${plain(Number(given.controlRate) * 100)}%`, source: "assumed", decisive: true });
  if (numeric(given.controlMedian) !== null) rows.push({ key: "control", label: "对照组中位时间", value: plain(Number(given.controlMedian)), source: "assumed", decisive: true });
  if (numeric(given.controlEventRate) !== null) rows.push({ key: "control", label: "对照组事件率（每患者每单位时间）", value: plain(Number(given.controlEventRate)), source: "assumed", decisive: true });
  if (numeric(given.overdispersion) !== null) rows.push({ key: "overdispersion", label: "过度离散", value: `${plain(Number(given.overdispersion))}（0 表示泊松）`, source: "assumed", decisive: true });
  if (numeric(given.subsetPrevalence) !== null) rows.push({ key: "prevalence", label: "标志物阳性所占比例", value: `${plain(Number(given.subsetPrevalence) * 100)}%`, source: "assumed", decisive: true });
  const dropout = numeric(given.dropoutAnnual);
  if (dropout !== null) rows.push({ key: "dropout", label: "每年脱落率", value: `${plain(dropout * 100)}%`, source: "assumed", decisive: false });
  const zone = object(given.promisingZone);
  if (numeric(zone.lower) !== null && numeric(zone.upper) !== null) {
    rows.push({ key: "zone", label: "只在中期条件功效落在这个区间时加样", value: `${plain(Number(zone.lower) * 100)}% 到 ${plain(Number(zone.upper) * 100)}%（区间之外按原计划样本量继续）`, source: "assumed", decisive: true });
  }
  for (const entry of list(confirmatory.assumed).map(object)) {
    const row = assumptionRow(String(entry.key), entry.value);
    if (row) rows.push(row);
  }
  return finishPremises(rows);
}

/**
 * @typedef {{ key: string, cell: string | null, label: string, group?: string, baseline?: string, name?: string }} ConfirmatoryColumn
 */

/**
 * The columns of the per-effect table of a design kind, in order: `cell` is the engine's cell name (null for a baseline's column, which
 * names the `baseline` path in the row), `group` who the column is read under.
 * @param {string} kind @param {Record<string, any>} confirmatory @returns {ConfirmatoryColumn[]}
 */
function columnsFor(kind, confirmatory) {
  const events = confirmatory.unit === "events";
  const size = events ? "expected_events" : "expected_sample_size";
  switch (kind) {
    case "futility_group_sequential":
      return [{ key: "power", cell: "power", label: "功效 / I 类错误" }, { key: size, cell: size, label: events ? "期望事件数" : "期望样本量" },
        { key: "futility_stop_probability", cell: "futility_stop_probability", label: "中途因无效停止的概率" }];
    case "sample_size_reestimation":
      return [{ key: "power", cell: "power", label: "功效 / I 类错误", group: "本设计" }, { key: size, cell: size, label: events ? "期望事件数" : "期望样本量", group: "本设计" },
        { key: "increase_probability", cell: "increase_probability", label: "中期加样的概率", group: "本设计" },
        { key: "fixed_power", cell: null, label: "功效 / I 类错误", group: "固定设计", baseline: "fixed.power" },
        { key: "gs_power", cell: null, label: "功效 / I 类错误", group: "成组序贯", baseline: "groupSequential.power" },
        { key: "gs_size", cell: null, label: events ? "期望事件数" : "期望样本量", group: "成组序贯", baseline: "groupSequential.expectedSize", name: size }];
    case "multi_arm_selection":
      return [{ key: "power", cell: "power", label: "功效 / I 类错误", group: "本设计" }, { key: size, cell: size, label: events ? "期望事件数" : "期望样本量", group: "本设计" },
        { key: "correct_selection_probability", cell: "correct_selection_probability", label: "选中最好臂的概率", group: "本设计" },
        ...Array.from({ length: Number(object(confirmatory.plan).arms ?? 0) }, (_, index) => ({ key: `selected_arm_${index + 1}`, cell: `selected_arm_${index + 1}`, label: `第 ${index + 1} 臂被保留`, group: "本设计" })),
        { key: "fixed_power", cell: null, label: "功效 / I 类错误", group: "最好的臂单独做试验", baseline: "fixed.power" }];
    case "enrichment":
      return [{ key: "power", cell: "power", label: "功效 / I 类错误", group: "本设计" }, { key: size, cell: size, label: events ? "期望事件数" : "期望样本量", group: "本设计" },
        { key: "selected_subset", cell: "selected_subset", label: "保留亚组的概率", group: "本设计" },
        { key: "fixed_power", cell: null, label: "功效 / I 类错误", group: "不做中期、全人群固定设计", baseline: "fixed.power" }];
    default: return [];
  }
}

/** @param {Record<string, any>} path @param {string} dotted */
const pick = (path, dotted) => dotted.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), /** @type {any} */ (path));

/**
 * The cards of the trial tab for the confirmatory results the study holds now, newest first.
 * @param {Record<string, any>} bundle the trial tab's bundle (`results`, `allResults`, `stale`, `jobs`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentConfirmatoryDesigns(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "design_confirmatory" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => {
    const confirmatory = object(object(result.diagnostics).confirmatory);
    const design = String(confirmatory.kind ?? "");
    const words = KIND_WORDS[design];
    if (!words) return null;
    const staleMark = markFor(bundle.stale ?? [], nodeOf(result));
    const context = { result, staleMark };
    const events = confirmatory.unit === "events";
    const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
      .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shownValue(entry.value, context) }));
    const columns = columnsFor(design, confirmatory);
    const effects = list(confirmatory.effects).map(object);
    const rows = effects.map((row) => {
      const role = String(row.role ?? "assumed");
      const cells = object(row.cells);
      /** @type {Record<string, any>} */
      const shown = {};
      for (const column of columns) {
        let measure = null;
        if (column.cell) {
          measure = cells[column.cell === "power" && role === "null" ? "type_one_error" : column.cell] ?? null;
        } else if (column.baseline) {
          const number = pick(row, column.baseline);
          const name = column.name ?? (column.baseline.endsWith("power") ? (role === "null" ? "type_one_error" : "power") : "expected_sample_size");
          measure = calculated(name, number);
        }
        shown[column.key] = measure ? shownValue(measure, context) : null;
      }
      return { role, label: ROLE_WORDS[role] ?? "效应", effect: effectText(row, String(confirmatory.endpoint)), iterations: numeric(row.iterations), cells: shown };
    });
    const looks = list(confirmatory.looks).map(object).map((look) => {
      const planned = effects.find((row) => row.role === "planned");
      const nullRow = effects.find((row) => row.role === "null");
      const k = Number(look.look);
      const cell = (/** @type {any} */ row, /** @type {string} */ name) => (row && object(row.cells)[name] ? shownValue(object(row.cells)[name], context) : null);
      return { look: k, informationRate: numeric(look.informationRate), size: numeric(look.size), efficacyBound: numeric(look.efficacyBound), futilityBound: numeric(look.futilityBound),
        efficacyStop: cell(planned, `stop_efficacy_${k}`), futilityStop: cell(planned, `stop_futility_${k}`), nullFutilityStop: cell(nullRow, `stop_futility_${k}`) };
    });
    const baselines = [];
    const base = object(confirmatory.baselines);
    const unit = events ? "个事件" : "例";
    if (numeric(object(base.fixed).size) !== null) baselines.push({ key: "fixed", label: events ? "固定设计所需事件数" : "固定设计所需样本量", text: `${plain(Number(object(base.fixed).size))} ${unit}` });
    if (numeric(object(base.groupSequential).maxSize) !== null) baselines.push({ key: "groupSequential", label: "同样分析次数的成组序贯设计最多", text: `${plain(Number(object(base.groupSequential).maxSize))} ${unit}` });
    if (numeric(object(base.fixedMultiArm).size) !== null) baselines.push({ key: "fixedMultiArm", label: "所有臂都做到最后", text: `${plain(Number(object(base.fixedMultiArm).size))} 例` });
    if (numeric(object(base.separateTrials).size) !== null) baselines.push({ key: "separateTrials", label: "每个剂量各做一个双臂试验", text: `${plain(Number(object(base.separateTrials).size))} 例` });
    if (numeric(object(base.fixedFullPopulation).size) !== null) baselines.push({ key: "fixedFullPopulation", label: "不做中期、全人群固定设计", text: `${plain(Number(object(base.fixedFullPopulation).size))} 例` });
    const limited = result.conclusion === "limited" || object(result.diagnostics).canceled === true || list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
      ? `只算完了一部分模拟（${list(confirmatory.iterations).map(Number).filter(Number.isFinite).join(" / ")} 次，每行各自的次数见表），数字按已算完的给出。` : null;
    return {
      id: String(result.id), version: Number(result.version), design, title: words.title, question: words.question, endpoint: ENDPOINT_WORDS[String(confirmatory.endpoint)] ?? "",
      unit: events ? "events" : "patients", headline, premises: premisesOf(confirmatory), looks, baselines, limited,
      table: rows.length ? { columns: columns.map(({ key, label, group }) => ({ key, label, group: group ?? null })), rows } : null,
    };
  }).filter(Boolean);
}
