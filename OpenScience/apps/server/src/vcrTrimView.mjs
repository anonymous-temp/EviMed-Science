/**
 * What the comparison page says of a propensity trimming (algorithm round C14, 2026-11-03): who was removed, and who the estimate is
 * therefore about.
 *
 * The EU HTA guideline (6.2) calls the balanced population that is left "ultimately the target population". A result that trimmed
 * says so in its first sentence, how many were removed in each arm and what the removed were like beside the kept; the engine writes the
 * numbers (`diagnostics.trim`) and this is the only place that words them.
 *
 * @module vcrTrimView
 */

import { list, numeric, object } from "./vcrViewsKit.mjs";

/** @param {number} value */
const plain = (value) => String(Number(value.toPrecision(3)));

/**
 * @param {unknown} trim the result's `diagnostics.trim`
 * @returns {{ rule: string, lower: number | null, upper: number | null, removed: number, kept: number, sentence: string,
 *   arms: Array<{ arm: string, n: number, kept: number, removed: number, share: string }>,
 *   covariates: Array<{ covariate: string, treated: { kept: string, removed: string }, control: { kept: string, removed: string } }> } | null}
 */
export function presentTrim(trim) {
  const record = object(trim);
  if (!Object.keys(record).length) return null;
  const lower = numeric(record.lower);
  const upper = numeric(record.upper);
  const arms = list(record.arms).map(object);
  const find = (/** @type {string} */ name) => arms.find((entry) => entry.arm === name) ?? {};
  const treated = object(find("treated"));
  const control = object(find("control"));
  const removed = Number(record.removedTotal ?? 0);
  const rule = record.rule === "crump" ? "crump" : "fixed";
  const bounds = lower !== null && upper !== null ? `倾向评分低于 ${plain(lower)} 或高于 ${plain(upper)}` : "没有可比的对象";
  const sentence = removed > 0
    ? `已按${rule === "crump" ? "最优修剪规则（Crump）" : "你设定的界值"}去掉没有可比对象的人（${bounds}）：试验组 ${Number(treated.removed ?? 0)} 例、对照组 ${Number(control.removed ?? 0)} 例。结论只适用于留下的人，不再是全部试验人群。`
    : `修剪规则（${bounds}）没有去掉任何人，结论仍适用于全部人群。`;
  /** @param {unknown} v @param {boolean} binary */
  const say = (v, binary) => (numeric(v) === null ? "—" : binary ? `${plain(Number(v) * 100)}%` : plain(Number(v)));
  /** @type {Map<string, any>} */
  const byCovariate = new Map();
  for (const row of list(record.baseline).map(object)) {
    const key = String(row.covariate ?? "");
    if (!key) continue;
    const entry = byCovariate.get(key) ?? { covariate: key, treated: { kept: "—", removed: "—" }, control: { kept: "—", removed: "—" } };
    const side = row.arm === "treated" ? entry.treated : entry.control;
    side.kept = say(row.kept, row.binary === true);
    side.removed = say(row.removed, row.binary === true);
    byCovariate.set(key, entry);
  }
  return {
    rule, lower, upper, removed, kept: Number(record.keptTotal ?? 0), sentence,
    arms: arms.map((entry) => ({
      arm: entry.arm === "treated" ? "试验组" : "对照组", n: Number(entry.n ?? 0), kept: Number(entry.kept ?? 0), removed: Number(entry.removed ?? 0),
      share: numeric(entry.removedShare) === null ? "—" : `${plain(Number(entry.removedShare) * 100)}%`,
    })),
    covariates: removed > 0 ? [...byCovariate.values()] : [],
  };
}
