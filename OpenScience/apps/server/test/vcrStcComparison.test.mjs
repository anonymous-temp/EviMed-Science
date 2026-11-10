// The comparison page's card of a simulated treatment comparison (review RF2 P1-2): the engine's real results (tests/numeric N73 hold their numbers
// to references) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { presentStcComparison } from "../src/vcrStcComparison.mjs";
import { measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-bias-analysis/${name}.json`, import.meta.url), "utf8"));
const card = (name) => {
  const result = fixture(name);
  return presentStcComparison(result, (measure) => measureValue(measure, { kind: "comparator", result, tab: "comparator", staleMark: null }));
};
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

test("an anchored comparison puts the indirect estimate first, with its interval and its ratio form, then the marginal and the conditional effect", () => {
  const result = fixture("stc-anchored");
  const anchored = card("stc-anchored");
  assert.equal(anchored.anchored, true);
  assert.match(anchored.question, /放到对方试验的人群上，我们的治疗和对方的治疗相比，差多少/);
  assert.equal(anchored.scale, "对数比值比（log OR）");
  const engine = result.measures.find((measure) => measure.name === "indirect_estimate");
  assert.ok(Math.abs(anchored.estimate.value - engine.value) < 1e-7, "the number is the engine's, rounded for the page");
  assert.ok(anchored.estimate.interval.low < anchored.estimate.value && anchored.estimate.value < anchored.estimate.interval.high);
  assert.equal(anchored.ratioLabel, "比值比（OR）");
  assert.ok(Math.abs(anchored.ratio.value - Math.exp(engine.value)) < 1e-6, "the ratio form is the exponential of the estimate");
  assert.ok(anchored.ratio.interval.low < anchored.ratio.value && anchored.ratio.value < anchored.ratio.interval.high);
  assert.deepEqual(anchored.rows.map((row) => row.key), ["marginal", "aggregate", "conditional"]);
  const [marginal, aggregate, conditional] = anchored.rows;
  assert.ok(Math.abs(marginal.value.value - result.measures.find((measure) => measure.name === "marginal_contrast_ipd").value) < 1e-7);
  assert.ok(Math.abs(aggregate.value.value - result.diagnostics.aggregate.linkScaleEstimate) < 1e-12);
  assert.equal(aggregate.value.source, "aggregate", "the other trial's figure is the person's summary number");
  assert.ok(Math.abs(conditional.value.value - result.measures.find((measure) => measure.name === "conditional_contrast_ipd").value) < 1e-7);
  assert.match(conditional.note, /不是边际效应/, "the conditional effect is set apart, not subtracted");
  assert.match(anchored.sentence, /针对的是对方试验的人群/);
});

test("an unanchored comparison compares two outcome levels and says it is not an effect; the levels are rates", () => {
  const unanchored = card("stc-unanchored");
  assert.equal(unanchored.anchored, false);
  assert.match(unanchored.sentence, /不是治疗效应/);
  assert.deepEqual(unanchored.rows.map((row) => row.key), ["expected", "aggregate"]);
  assert.equal(unanchored.rows[0].value.unit, "%", "a logit-link level is a probability");
  assert.ok(unanchored.rows[0].value.value > 50 && unanchored.rows[0].value.value < 52, "0.515 shown as a percentage");
  assert.equal(unanchored.rows.some((row) => row.key === "conditional"), false);
});

test("the share of the other trial's population outside the person's data is one sentence, and only when there is one", () => {
  const anchored = card("stc-anchored");
  assert.match(anchored.outside, /^对方人群里约有 1\.1% 的人，“x1”超出了我们数据的范围，这部分是外推。$/);
  const result = fixture("stc-anchored");
  result.diagnostics.extrapolation.shareOutsideIpdRange = { x1: 0, x2: 0 };
  assert.equal(presentStcComparison(result, (measure) => measureValue(measure, { kind: "comparator", result, tab: "comparator", staleMark: null })).outside, null);
});

test("a result of another method, or with no estimate, has no card; no back-office word reaches a sentence", () => {
  assert.equal(presentStcComparison(fixture("trim-weighting"), () => null), null);
  assert.equal(presentStcComparison(null, () => null), null);
  assert.equal(presentStcComparison({ ...fixture("stc-anchored"), measures: [] }, () => null), null);
  for (const name of ["stc-anchored", "stc-unanchored"]) {
    const words = strings({ ...card(name), estimate: null, ratio: null, rows: card(name).rows.map((row) => [row.label, row.note]) }).join(" ");
    for (const banned of [/g_computation/, /logit/, /identity/, /\bstc\b/i, /comparator\./, /indirect_estimate/, /\bIPD\b/, /\bAgD\b/]) assert.doesNotMatch(words, banned);
  }
});
