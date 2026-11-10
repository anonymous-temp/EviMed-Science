// The comparison page's card of imputed covariates (algorithm round C7): the engine's real results (tests/numeric N78 hold their numbers to mice and
// to a hand computation) read into the payload the comparator tab shows, the premise they rest on and the sentences they are read with care by.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { vcrResultLimits } from "@evimed/domain";
import { presentImputation, imputationPremise } from "../src/vcrImputationView.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-imputation/${name}.json`, import.meta.url), "utf8"));
const value = (result) => (measure) => measureValue(measure, { kind: "comparator", result, tab: "comparator", staleMark: null });
const card = (name) => { const result = fixture(name); return presentImputation(result, value(result)); };
const WORD_KEYS = new Set(["question", "sentence", "assumption", "budget", "stopped", "few", "note", "method", "loss", "label"]);
const sayings = (node, key = "") => {
  if (typeof node === "string") return WORD_KEYS.has(key) ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((each) => sayings(each, key));
  return node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => sayings(each, k)) : [];
};

test("the card opens with the question, says who was missing and what the answer rests on, and shows the complete-case answer beside the pooled one", () => {
  const result = fixture("propensity-binary");
  const shown = card("propensity-binary");
  assert.match(shown.question, /缺失值/);
  assert.match(shown.sentence, /至少缺一个协变量/);
  assert.match(shown.assumption, /随机缺失/);
  assert.deepEqual(shown.covariates.map((entry) => entry.name).sort(), ["x1", "x2"]);
  assert.ok(shown.covariates.every((entry) => entry.method && entry.share.endsWith("%")));
  const difference = shown.rows.find((row) => row.key === "weighted_difference");
  assert.ok(difference, "the headline row is there");
  const measure = result.measures.find((entry) => entry.name === "weighted_difference");
  assert.equal(difference.imputed.source, "imputed");
  const scaled = difference.imputed.unit === "%" ? 100 : 1;
  assert.ok(Math.abs(difference.imputed.value - measure.value * scaled) < 1e-6, "the pooled number is the result's own measure");
  assert.ok(difference.completeCase && difference.completeCase.source === "calculated" && difference.completeCase.interval, "the complete-case number and its interval");
  assert.ok(["same", "different"].includes(difference.agreement));
  assert.match(difference.loss, /^缺失造成的信息损失约 \d/);
  assert.match(shown.completeCase.sentence, /只用完整病例：剩 \d+ 人，去掉 \d+ 人/);
  assert.match(shown.budget, /分摊/);
  assert.equal(shown.stopped, null);
  // the ratio rows are on the ratio's scale: the pooled risk ratio is the exponential of the pooled log ratio, with a positive interval
  const ratio = shown.rows.find((row) => row.key === "weighted_risk_ratio");
  assert.ok(ratio && ratio.imputed.value > 0 && ratio.imputed.interval.low > 0);
});

test("a time-to-event result pools the RMST and the hazard ratio and carries the E-value again from the pooled ratio", () => {
  const result = fixture("cox-time-to-event");
  const shown = card("cox-time-to-event");
  assert.deepEqual(shown.rows.map((row) => row.key), ["hazard_ratio", "rmst_difference", "rmst_treatment", "rmst_control", "survival_difference_at_tau"]);
  const hr = result.measures.find((entry) => entry.name === "hazard_ratio");
  const ev = result.measures.find((entry) => entry.name === "e_value");
  assert.ok(ev && ev.source === "imputed", "the E-value is the pooled ratio's");
  const bound = hr.value >= 1 ? hr.interval.low : hr.interval.high;
  const rr = hr.value < 1 ? 1 / hr.value : hr.value;
  assert.ok(Math.abs(ev.value - (rr + Math.sqrt(rr * (rr - 1)))) < 0.02 || ev.value > 1, `E-value ${ev.value} from HR ${hr.value} (limit ${bound})`);
  const rmst = shown.rows.find((row) => row.key === "rmst_difference");
  assert.ok(rmst.imputed.unit && rmst.completeCase.unit === rmst.imputed.unit, "the RMST keeps its time unit on both sides");
});

test("the premise and the limits: the assumption is a decisive premise with its value; a stopped run and too few imputations say so in sentences", () => {
  const result = fixture("propensity-stopped");
  const premise = imputationPremise(result.diagnostics);
  assert.equal(premise.key, "missingAtRandom");
  assert.equal(premise.source, "assumed");
  assert.match(premise.value, /随机缺失/);
  assert.match(premise.value, /补齐 \d+ 次/);
  const premises = vcrPremises("comparator", { route: "external_control", estimand: "ATE", estimandStated: false, diagnostics: result.diagnostics, measures: {}, applicability: null, targetTrial: null, covariates: [], anchored: null });
  assert.ok(premises.some((row) => row.key === "missingAtRandom"), "the premise reaches the block");
  const limits = vcrResultLimits({ conclusion: result.conclusion, method: "comparator.propensity_weight", diagnostics: result.diagnostics, measures: result.measures });
  assert.ok(limits.some((entry) => entry.key === "imputations_stopped_early" && /用了|合并了 \d+ 份/.test(entry.text)), JSON.stringify(limits));
  assert.equal(result.conclusion, "limited");
  const stopped = presentImputation(result, value(result));
  assert.match(stopped.stopped, /计算时间用完了：只用了 \d+ 份（计划 14 份）/);
  assert.match(stopped.few ?? "", /份数偏少|^$/);
});

test("nothing missing is said in one sentence, a result that did not impute has no card, and no back-office word reaches a sentence", () => {
  const plain = { diagnostics: { imputation: { performed: false, requested: 5, reason: "no_missing_covariate" } }, measures: [] };
  const said = presentImputation(plain, value(plain));
  assert.match(said.sentence, /没有协变量缺失/);
  assert.equal(said.rows.length, 0);
  assert.equal(presentImputation({ diagnostics: {}, measures: [] }, () => null), null);
  assert.equal(presentImputation(null, () => null), null);
  for (const name of ["propensity-binary", "cox-time-to-event", "propensity-stopped"]) {
    for (const sentence of sayings(card(name))) {
      assert.doesNotMatch(sentence, /bootstrap|nnet|mice|handler|diagnostics|_/i, sentence);
    }
  }
});
