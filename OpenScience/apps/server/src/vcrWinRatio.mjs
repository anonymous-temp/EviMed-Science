/**
 * What the trial page says of a hierarchical composite endpoint compared by win ratio (algorithm round T9, 2026-11-03): the result of a
 * `design_win_ratio` job.
 *
 * A win-ratio result is not one of the page's designs (A, B, C) and belongs to no object of the study: it is a result of its own kind, filed
 * under the scenario it was asked on, that the conversation computes (`vcr_simulate`, kind `design_win_ratio`). The trial tab lists the
 * current one of each key as a card. This module turns the engine's result into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The card answers one question in two forms.** With a size, "how likely does the test find the effect, and how many pairs end in a tie";
 *   with a power wanted, "how many people per arm for that likelihood". The size form carries the size as its headline and says that the
 *   power at it was simulated (the last run of the search, with its error), not read off a formula.
 * - **Ties are the first thing a reader of a win ratio asks about**, so the table by level shows where the pairs were decided and how many
 *   were still tied after each level; the headline carries the win difference beside the ratio (a ratio alone hides a large share of ties).
 * - **Every number is a `VcrValue`** (`measureValue`): the percentage, the Monte-Carlo error, the source word. The win ratio carries the
 *   range one trial of this size shows, which is not its error: the card words them apart.
 * - **A default the person did not state is a premise** (`premises`, the block 「这个结论的前提」): the engine lists what it assumed and
 *   this module words each one; the decisive five are the follow-up, the three levels' effects and the correlation between levels.
 * - **No back-office word reaches the card.** A cell name the engine uses is labelled by `cellLabel`; one it cannot label is left out.
 *
 * @module vcrWinRatio
 */

import { finishPremises } from "./vcrPremises.mjs";
import { vcrScenarioKey } from "./vcrScenarioKey.mjs";
import { personWord } from "./vcrPersonStated.mjs";
import { list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";

/**
 * The key a win-ratio result is filed under (the result's `subject_id`): the scenario it was asked on. The same question asked again is the
 * next version of one result; another effect, another follow-up or another size is another result.
 * @param {Record<string, any>} scenario
 */
export function vcrWinRatioSubjectId(scenario) {
  return `wr:${vcrScenarioKey(scenario)}`;
}

const LEVEL_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ death: "死亡", events: "事件次数", score: "评分" }));
const UNIT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ days: "天", weeks: "周", months: "个月", years: "年" }));
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
    power: "判出有效的把握（检验功效）", type_one_error: "没有真实效应时误判有效的概率",
    win_ratio: "胜率比（赢的对数 ÷ 输的对数）", win_difference: "净胜率（赢的对数占比 − 输的对数占比）", win_odds: "胜算比（平局各算一半）",
    win_proportion: "赢的对数占比", loss_proportion: "输的对数占比", tie_proportion: "平局的对数占比", required_per_arm: "每组所需患者数",
  });
  return fixed[name] ?? null;
}

/**
 * The same error of exactly zero would read as a claim of perfect precision; it is shown with no error.
 * @param {Record<string, any>} measure @param {{ result: Record<string, any>, staleMark: any }} context
 */
const shown = (measure, { result, staleMark }) => measureValue(measure?.mcse === 0 ? { ...measure, mcse: undefined } : measure, { kind: "design_win_ratio", result, tab: "trial", staleMark });

/** @param {Record<string, any>} wr the engine's `diagnostics.winRatio` */
function premisesOf(wr, record) {
  const model = object(wr.model);
  const unit = UNIT_WORDS[String(model.timeUnit ?? "months")] ?? "个时间单位";
  const keys = new Set(list(wr.assumed).map((entry) => String(object(entry).key)));
  // 「你给的数据」 is a number in the person's own message (or a table they supplied): a number the model chose is 「假设」 (`personWord`), and a result
  // from before the record was kept reads as it read.
  const stated = (/** @type {string} */ key) => (keys.has(key) ? "default" : personWord(record, key, "given"));
  const death = object(model.death);
  const events = object(model.events);
  const score = object(model.score);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  const followup = numeric(model.followup);
  if (followup !== null) rows.push({ key: "followup", label: "每个人的随访时间", value: `${plain(followup)} ${unit}（死亡或中途退出的人除外）`, source: personWord(record, "design.followup", "given"), decisive: true });
  const risk = numeric(death.controlRisk);
  const median = numeric(death.controlMedian);
  const hr = numeric(death.hazardRatio);
  if (hr !== null) rows.push({ key: "death", label: "死亡层", value: `${risk !== null ? `对照组随访期内有 ${percent(risk)} 的人死亡` : `对照组中位生存 ${plain(median ?? 0)} ${unit}`}；试验组的死亡风险是对照组的 ${plain(hr)} 倍`, source: personWord(record, ["truth.death.hazardRatio", risk !== null ? "truth.death.controlRisk" : "truth.death.controlMedian"], "assumed"), decisive: true });
  if (numeric(events.rateRatio) !== null) {
    rows.push({ key: "events", label: "事件次数层", value: `对照组每人每${unit.replace("个", "")} ${plain(Number(events.controlRate))} 次，试验组是对照组的 ${plain(Number(events.rateRatio))} 倍；人与人之间的差异（过度离散）${plain(Number(events.overdispersion))}${keys.has("truth.events.overdispersion") ? "（未指定，取默认）" : ""}`, source: personWord(record, ["truth.events.controlRate", "truth.events.rateRatio", "truth.events.overdispersion"], "assumed"), decisive: true });
  }
  if (numeric(score.shift) !== null) {
    const threshold = numeric(score.threshold) ?? 0;
    rows.push({ key: "score", label: "评分层", value: `试验组比对照组高 ${plain(Number(score.shift))}（标准差 ${plain(Number(score.sd))}）${threshold > 0 ? `；两人相差不超过 ${plain(threshold)} 算平局` : "；差多少都算分出胜负"}`, source: personWord(record, ["truth.score.shift", "truth.score.sd", ...(threshold > 0 ? ["truth.score.threshold"] : [])], "assumed"), decisive: true });
  }
  const rho = numeric(model.correlation);
  if (rho !== null) rows.push({ key: "level_link", label: "三层之间的关联", value: `任意两层的相关 ${plain(rho)}（病情重的人在每一层上都更差）`, source: stated("truth.correlation"), decisive: true });
  const dropout = numeric(model.dropoutAnnual);
  if (dropout !== null && dropout > 0) rows.push({ key: "dropout", label: "中途退出", value: `每年 ${percent(dropout)} 的人退出随访`, source: personWord(record, "design.dropoutAnnual", "given"), decisive: false });
  rows.push({ key: "test", label: "检验方法", value: "Finkelstein-Schoenfeld 置换检验：赢的对数减输的对数，方差由把两组标签打乱得到", source: "default", decisive: false });
  rows.push({ key: "pairs", label: "怎样比较两个人", value: "先比死亡（只在对方仍在随访时才分胜负），再比两人都被观察到的时段内的事件次数（少者胜），最后比期末评分；每一层只处理上一层没分出胜负的对", source: "default", decisive: false });
  const trials = list(wr.assumed).map(object).find((entry) => entry.key === "trials");
  if (trials) rows.push({ key: "trials", label: "模拟的试验次数", value: plain(Number(trials.value)), source: "default", decisive: false });
  const cap = list(wr.assumed).map(object).find((entry) => entry.key === "design.maxPerArm");
  if (cap) rows.push({ key: "cap", label: "搜索样本量的上限", value: `每组 ${plain(Number(cap.value))} 人`, source: "default", decisive: false });
  return finishPremises(rows, record);
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function cardOf(result, staleMark) {
  const wr = object(object(result.diagnostics).winRatio);
  const context = { result, staleMark };
  const cells = object(wr.cells);
  const levels = list(wr.levels).map(String);
  if (!levels.length) return null;
  const search = wr.search ? object(wr.search) : null;
  const model = object(wr.model);
  const headline = list(result.measures).map(object).map((measure) => ({ key: String(measure.name), label: cellLabel(String(measure.name)), value: measure }))
    .filter((entry) => entry.label).map((entry) => ({ key: entry.key, label: String(entry.label), value: shown(entry.value, context) }));
  const trialsDone = numeric(wr.trials);
  const trialsAsked = numeric(wr.trialsRequested);
  const verified = search === null || search.verified !== false;
  const limited = !verified
    ? "预算在核对这个人数之前用完了，这里的人数是用先导模拟推算的，没有再模拟一次验证功效。"
    : result.conclusion === "limited" || list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
      ? `只模拟完了一部分试验（${trialsDone ?? "?"} 次，原定 ${trialsAsked ?? "?"} 次），数字按已完成的给出。` : null;
  const byLevel = list(wr.byLevel).map(object).map((row, index) => {
    const rowCells = object(row.cells);
    return { key: String(row.level), label: `第 ${index + 1} 层：${LEVEL_WORDS[String(row.level)] ?? String(row.level)}`,
      cells: { win_proportion: rowCells.win_proportion ? shown(rowCells.win_proportion, context) : null, loss_proportion: rowCells.loss_proportion ? shown(rowCells.loss_proportion, context) : null,
        tie_proportion: rowCells.tie_proportion ? shown(rowCells.tie_proportion, context) : null } };
  });
  const total = { key: "total", label: "合计",
    cells: { win_proportion: cells.win_proportion ? shown(cells.win_proportion, context) : null, loss_proportion: cells.loss_proportion ? shown(cells.loss_proportion, context) : null,
      tie_proportion: cells.tie_proportion ? shown(cells.tie_proportion, context) : null } };
  const perArm = numeric(search?.perArm);
  const powerWanted = numeric(search?.powerWanted);
  const sized = search !== null && perArm !== null;
  const wordsOfLevels = levels.map((key) => LEVEL_WORDS[key] ?? key).join("、");
  return {
    id: String(result.id), version: Number(result.version), form: "win_ratio",
    title: `${wordsOfLevels}的分层比较（胜率比）`,
    question: sized
      ? `要有 ${powerWanted === null ? "?" : percent(powerWanted)} 的把握判出有效，每组需要多少人；这时平局占多少`
      : "这么多人的试验，判出有效的把握有多大；比较的对子里平局占多少",
    levels: levels.map((key) => ({ key, label: LEVEL_WORDS[key] ?? key })),
    headline,
    size: sized ? { perArm, total: perArm * 2, powerWanted: powerWanted === null ? null : powerWanted * 100, verified } : null,
    arms: sized ? { treat: perArm, control: perArm } : { treat: numeric(model.nTreat), control: numeric(model.nControl) },
    table: {
      columns: [{ key: "win_proportion", label: "试验组赢的对数占比" }, { key: "loss_proportion", label: "对照组赢的对数占比" }, { key: "tie_proportion", label: "到这一层仍未分出胜负的对数占比" }],
      rows: [...byLevel, total],
    },
    trials: trialsDone, premises: premisesOf(wr, object(result.diagnostics).personStated), limited,
  };
}

/**
 * The cards of the trial tab for the win-ratio results the study holds now, newest first.
 * @param {Record<string, any>} bundle the trial tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentWinRatioDesigns(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "design_win_ratio" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)))).filter(Boolean);
}
