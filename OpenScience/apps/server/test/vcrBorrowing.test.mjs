// The comparison page's card of a dynamic borrowing (algorithm round C10-C12) and the result page's block of a spline survival fit (C13): the engine's
// real results (tests/numeric N91-N95 hold their numbers to references) read into the payloads the pages show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { presentBorrowing, borrowingPremises } from "../src/vcrBorrowing.mjs";
import { presentSplineFit, presentSplineFits } from "../src/vcrSplineFit.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { vcrResultKindFor, vcrJobObjectKind } from "../src/vcrJobs.mjs";
import { measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-borrowing/${name}.json`, import.meta.url), "utf8"));
const value = (result, tab = "comparator") => (measure) => measureValue(measure, { kind: "comparator", result, tab, staleMark: null });
const card = (name) => { const result = fixture(name); return presentBorrowing(result, value(result)); };
/** Every string of a payload, with the key it sits under: a back-office word would show as ascii with underscores or a dot. */
const strings = (node, key = "") => {
  if (typeof node === "string") return [[key, node]];
  if (Array.isArray(node)) return node.flatMap((each) => strings(each, key));
  return node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => strings(each, k)) : [];
};
const WORDS = new Set(["question", "kindWord", "label", "note", "differenceWords", "driftWords", "delta", "value", "timeWords", "tauWords", "longestFollowUp"]);

test("a borrowing is a comparator job: filed under the comparator kind, an object of its own", () => {
  assert.equal(VCR_JOB_METHODS.borrowing_prior, "comparator.borrowing");
  assert.equal(vcrResultKindFor("borrowing_prior"), "comparator");
  assert.equal(vcrJobObjectKind("borrowing_prior"), "comparator");
});

test("the card opens with the question of its prior and shows the rows beside no borrowing and full borrowing", () => {
  const power = card("power-binary");
  assert.equal(power.question, "外部对照每个人只按一部分算时，结论如何？");
  assert.deepEqual(power.posterior.map((row) => row.which), ["none", "chosen", "full"]);
  assert.deepEqual(power.posterior.map((row) => row.label), ["不借用", "固定折扣（幂先验）", "全部借用（折扣 1）"]);
  const chosen = power.posterior[1];
  assert.equal(Math.round(chosen.weight.value * 10) / 10, 30, "a discount of 0.3 reads 30%");
  assert.ok(chosen.probabilityBetter.value > 85 && chosen.probabilityBetter.value < 95, "Pr(better) is a percentage");
  assert.equal(chosen.mean.unit, "%", "a rate is a percentage");
  assert.ok(chosen.lower.value < chosen.mean.value && chosen.mean.value < chosen.upper.value);
  assert.equal(power.conflict, null, "a fixed discount has no conflict table");
  const sam = card("sam-binary");
  assert.equal(sam.question, "借用多少由数据决定时，结果如何？");
  assert.equal(sam.conflict.rows.length, 7);
  assert.equal(sam.conflict.rows.find((row) => row.difference === 0).differenceWords, "与历史一致");
  const elastic = card("elastic-binary");
  assert.equal(elastic.question, "数据与历史冲突时，怎样换算成借用程度？");
  assert.equal(elastic.posterior.length, 0, "no current data: the analysis is not on the card");
});

test("the operating characteristics carry exact numbers, with and without borrowing, and no Monte-Carlo error", () => {
  const sam = card("sam-binary");
  const rows = sam.operatingCharacteristics.rows;
  assert.equal(rows.length, 5);
  for (const row of rows) {
    for (const cell of [row.none.typeOneError, row.chosen.typeOneError, row.chosen.power, row.none.power]) {
      assert.equal(cell.unit, "%");
      assert.equal(cell.mcse ?? null, null, "an exact number shows no error");
      assert.equal(cell.source, "calculated");
    }
  }
  const atZero = rows.find((row) => row.drift === 0);
  assert.equal(atZero.driftWords, "与历史一致");
  assert.ok(rows.find((row) => row.drift === 0.1).chosen.typeOneError.value > rows.find((row) => row.drift === 0).chosen.typeOneError.value, "the type I error rises when the control rate drifts up");
  assert.ok(sam.operatingCharacteristics.note.includes("穷举"));
});

test("a mean is read as itself, not as a percentage", () => {
  const mean = card("elastic-mean");
  const chosen = mean.posterior[1];
  assert.notEqual(chosen.mean.unit, "%");
  assert.ok(chosen.mean.value > 10 && chosen.mean.value < 11.5);
  assert.equal(mean.elastic.function, "step");
});

test("no payload sentence carries a back-office word, and the premises say values (three to five decisive)", () => {
  for (const name of ["power-binary", "sam-binary", "elastic-binary", "elastic-mean"]) {
    const result = fixture(name);
    const payload = presentBorrowing(result, value(result));
    const premises = vcrPremises("comparator", { route: "hybrid_control", diagnostics: result.diagnostics, measures: {}, applicability: null, targetTrial: null, covariates: [], anchored: null });
    for (const [key, text] of [...strings(payload), ...strings(premises)]) {
      if (!WORDS.has(key)) continue;
      assert.ok(!/[a-z]+_[a-z]+|comparator|borrowing|engine|R\/|\.R\b|pkg|SAMprior|RBesT/.test(text), `${name}: ${key}: ${text}`);
    }
    const decisive = premises.filter((row) => row.decisive);
    assert.ok(decisive.length >= 3 && decisive.length <= 5, `${name}: ${decisive.length} decisive premises`);
    assert.ok(premises.every((row) => row.value && row.label), `${name}: every premise has a value`);
    assert.ok(!premises.some((row) => row.key === "borrowedHistory"), "a borrowing does not claim a checked source it never had");
  }
  const elastic = borrowingPremises(fixture("elastic-binary").diagnostics.borrowing);
  const fn = elastic.find((row) => row.key === "borrowingFunction");
  assert.ok(fn.value.includes("函数的选择没有数据能证明"), fn.value);
  assert.equal(fn.source, "default", "the percentiles were not stated: a default");
  const power = borrowingPremises(fixture("power-binary").diagnostics.borrowing);
  assert.ok(power.find((row) => row.key === "borrowingPrior").value.includes("0.3"));
});

test("a spline fit reads: the median, the restricted mean, the survival with how far beyond the data each lies, and three decisive premises", () => {
  const result = fixture("spline-fit");
  const block = presentSplineFit({ ...result, diagnostics: { ...result.diagnostics, timeUnit: "months" } }, value(result, "patients"));
  assert.equal(block.question, "风险曲线不单调时，长期生存和 RMST 是多少？");
  assert.ok(block.median.value > 8 && block.median.value < 12);
  assert.equal(block.rmst.tauWords, "60个月");
  assert.equal(block.curve.length, 3);
  assert.deepEqual(block.curve.map((point) => point.beyondData), [false, false, true]);
  assert.ok(block.curve[2].timesLongestFollowUp > 1.9 && block.curve[2].timesLongestFollowUp < 2.2);
  assert.equal(block.curve[2].survival.unit, "%");
  assert.equal(block.specifications.length, 4);
  assert.equal(block.specifications.filter((spec) => spec.selected).length, 1);
  const keys = block.premises.map((row) => row.key);
  assert.deepEqual(keys, ["splineBeyond", "splineKnots", "splineTail"]);
  assert.ok(block.premises[0].value.includes("倍") && block.premises[0].value.includes("外推"));
  assert.ok(block.premises[1].value.includes("0 到 3 个结点"));
  for (const [key, text] of strings(block)) {
    if (!WORDS.has(key) && key !== "label") continue;
    assert.ok(!/[a-z]+_[a-z]+|spline|flexsurv|optim|delta/.test(text), `${key}: ${text}`);
  }
  assert.equal(presentSplineFit({ diagnostics: { model: { distribution: { kind: "weibull" } } } }, value({})), null, "a parametric fit has no spline block");
});

test("a spline fit made from a conversation is on the patients tab, with its premises (review RF2 P1-5)", () => {
  assert.equal(VCR_RESULT_KIND_TABS.model_fit, "patients", "the entry to a fit opens the tab that holds it, not the overview");
  const result = { ...fixture("spline-fit"), id: "res_fit", version: 1, kind: "model_fit", createdAt: "2026-11-04T00:00:00Z" };
  result.diagnostics = { ...result.diagnostics, timeUnit: "months" };
  const cards = presentSplineFits({ allResults: [result, { ...result, id: "res_old", supersededBy: "res_fit" }, { ...result, id: "res_w", kind: "comparator" }], stale: [] }, { nodeOf: (row) => `result:${row.id}` });
  assert.deepEqual(cards.map((card) => card.id), ["res_fit"], "the current fit of the kind, and nothing superseded or of another kind");
  assert.deepEqual(cards[0].premises.map((row) => row.key), ["splineBeyond", "splineKnots", "splineTail"]);
  assert.ok(cards[0].premises[0].value.includes("倍") && cards[0].premises[0].value.includes("外推"), "how far beyond the data the number lies is beside it");
  const weibull = { ...result, id: "res_w2", diagnostics: { model: { distribution: { kind: "weibull" } } } };
  assert.deepEqual(presentSplineFits({ allResults: [weibull], stale: [] }, { nodeOf: (row) => `result:${row.id}` }), [], "a parametric fit has no spline card");
});
