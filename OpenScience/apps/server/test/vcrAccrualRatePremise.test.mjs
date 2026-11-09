// 「每月入组 20 人」 (plan R12): the rate reads 你给的数据 and the duration code derived from it reads 由你给的数据算出, pointing at the rate.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_PREMISE_SOURCES, VCR_PREMISE_SOURCE_LABELS_ZH, vcrNormalizeScenarioKeys } from "@evimed/domain";
import { vcrPersonStated } from "../src/vcrPersonStated.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";

const human = (/** @type {string} */ text) => ({ sessionId: "sess_1", messageSeq: 3, text });
const scenario = vcrNormalizeScenarioKeys("design.simulate", {
  design: { kind: "two_arm_fixed", nTreat: 300, nControl: 300 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 12 },
  analysis: { alpha: 0.025, sided: 1 }, accrual: { rate: 20, followup: 24 }, timeUnit: "months",
}).scenario;
const rows = (/** @type {any} */ personStated) => vcrPremises("trial", { endpointType: "time_to_event", designKind: "two_arm_fixed", configuration: scenario,
  diagnostics: {}, cards: [], bound: [], appliedDefaults: [], personStated });
const row = (/** @type {any[]} */ list, /** @type {string} */ key) => list.find((entry) => entry.key === key);

test("the person's own rate is theirs; the duration is derived from it and says so", () => {
  const said = rows(vcrPersonStated(scenario, [human("两臂生存期试验，每组 300 人，每月入组 20 人，入组完后再随访 24 个月，HR 0.75")]));
  assert.equal(row(said, "accrualRate").source, "given");
  assert.equal(row(said, "accrualRate").value, "每月 20 人");
  assert.equal(row(said, "accrual").source, "derived");
  assert.equal(row(said, "accrual").value, "30 个月");
  assert.equal(row(said, "accrual").from, "accrualRate", "the derived row points at its parent");
  assert.match(row(said, "accrual").reason, /每月 20 人/);
  assert.equal(row(said, "followup").source, "given");
  assert.equal(VCR_PREMISE_SOURCE_LABELS_ZH.derived, "由你给的数据算出");
  for (const entry of said) assert.ok(VCR_PREMISE_SOURCES.includes(entry.source), entry.key);
});

test("a rate the model chose is an assumption, and so is the duration that follows from it", () => {
  const assumed = rows(vcrPersonStated(scenario, [human("帮我看看这个设计")]));
  assert.equal(row(assumed, "accrualRate").source, "assumed");
  assert.equal(row(assumed, "accrual").source, "assumed", "a derived value never reads stronger than its parent");
  assert.equal(row(assumed, "accrual").from, "accrualRate");
  assert.equal(row(rows(null), "accrual").source, "assumed");
});

test("a scenario with no rate reads as it always read: one row for the accrual and the follow-up", () => {
  const plain = vcrPremises("trial", { endpointType: "time_to_event", designKind: "two_arm_fixed", diagnostics: {}, cards: [], bound: [], appliedDefaults: [], personStated: null,
    configuration: { ...scenario, accrual: { duration: 12, followup: 12 } } });
  assert.equal(row(plain, "accrual").value, "入组 12 个月，随访 12 个月");
  assert.equal(row(plain, "accrualRate"), undefined);
  assert.equal("from" in row(plain, "accrual"), false);
});

test("review P2-12: the duration is 由你给的数据算出 only when the group sizes were the person's too, and a single-arm design says one group", () => {
  const rateOnly = rows(vcrPersonStated(scenario, [human("每月入组 20 人，入组完后再随访 24 个月")]));
  assert.equal(row(rateOnly, "accrualRate").source, "given");
  assert.equal(row(rateOnly, "accrual").source, "assumed", "the sizes were the model's: a quotient of a given rate and an assumed size is an assumption");
  assert.match(row(rateOnly, "accrual").reason, /两组的计划人数/);
  const single = { ...scenario, design: { kind: "single_arm", nTreat: 300 } };
  const one = vcrPremises("trial", { endpointType: "time_to_event", designKind: "single_arm", configuration: single, diagnostics: {}, cards: [], bound: [], appliedDefaults: [],
    personStated: vcrPersonStated(single, [human("单臂试验 300 人，每月入组 20 人，入组完后随访 24 个月")]) });
  assert.match(row(one, "accrual").reason, /这一组的计划人数/);
  assert.equal(row(one, "accrual").source, "derived");
});
