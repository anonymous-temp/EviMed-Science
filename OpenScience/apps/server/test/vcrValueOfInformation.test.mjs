// The trial tab's card for the value of information of a decision (in-silico round 2, R35): the engine's real results (tests/numeric N140 holds their numbers
// to closed forms, Strong et al. 2014 and the voi package) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { presentValueOfInformation, vcrVoiSubjectId } from "../src/vcrValueOfInformation.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-voi/${name}.json`, import.meta.url), "utf8"));
const cardOf = (name, extra = {}) => {
  const result = { id: `res_${name}`, version: 1, kind: "decision_voi", createdAt: "2026-11-09T10:00:00Z", reviewState: "ai_set", ...fixture(name), ...extra };
  const [card] = presentValueOfInformation({ allResults: [result], stale: [] }, { nodeOf: () => "node" });
  return card;
};
/** The sentences and labels of a card, flattened: every string leaf under a key that carries words (a key, an id or a package name would show as ascii with dots or underscores). */
const WORD_KEYS = new Set(["title", "question", "lead", "label", "value", "limited", "chosen", "from", "to"]);
const words = (node, key = "") => (typeof node === "string" ? (WORD_KEYS.has(key) ? [node] : []) : Array.isArray(node) ? node.flatMap((each) => words(each, key)) : node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => words(each, k)) : []);
const BACK_OFFICE = /evidence\.|decision\.|\bvoi\b|\bmgcv\b|job_|diagnostics|hash|seed|evimed|_[a-z]+_/i;

test("the kind is a result of its own, read on the trial tab, filed under the decision it was asked on", () => {
  assert.equal(VCR_JOB_METHODS.decision_voi, "decision.value_of_information");
  assert.equal(vcrResultKindFor("decision_voi"), "decision_voi");
  assert.ok(VCR_RESULT_KINDS.includes("decision_voi"));
  assert.equal(VCR_RESULT_KIND_TABS.decision_voi, "trial");
  const scenario = { source: "two_arm_continuous", utility: "success_probability" };
  assert.match(vcrVoiSubjectId(scenario), /^voi:/);
  assert.equal(vcrVoiSubjectId(scenario), vcrVoiSubjectId(structuredClone(scenario)));
  assert.notEqual(vcrVoiSubjectId(scenario), vcrVoiSubjectId({ ...scenario, utility: "net_benefit" }), "another utility is another result");
});

test("the card ranks the inputs as the engine did, shows every number with its error, and names the next step without recommending it", () => {
  const card = cardOf("two-arm");
  assert.equal(card.form, "value_of_information");
  const values = card.inputs.map((row) => row.evppi.value);
  assert.deepEqual(values, [...values].sort((a, b) => b - a), "largest EVPPI first");
  assert.deepEqual(card.inputs.map((row) => row.rank), card.inputs.map((_, i) => i + 1));
  assert.ok(card.inputs.every((row) => row.evppi.source === "synthetic"));
  assert.ok(card.inputs[0].evppi.mcse > 0, "the leading number carries its error");
  assert.equal(card.inputs.find((row) => !row.group).label, "药物效应", "the best single input leads the single inputs");
  assert.ok(card.inputs.some((row) => row.group && row.label === "药物效应 + 结局的标准差"), "a stated group is a row of its own");
  assert.equal(card.options.filter((o) => o.chosen).length, 1);
  assert.equal(card.headline.find((l) => l.key === "voi_probability_wrong_decision").value.unit, "%");
  assert.match(card.lead, /^按这张表，最值得先弄清的是“药物效应”/);
  assert.match(card.lead, /由你决定。$/);
  assert.equal(card.studies.length, 2);
  assert.ok(card.studies.every((s) => s.ceiling && s.evsi.value <= s.ceiling.value + 4 * s.evsi.mcse), "a study is worth no more than learning what it observes");
  assert.ok(card.studies[1].evsi.value > card.studies[0].evsi.value, "a larger study is worth more");
  assert.ok(!words(card).some((w) => BACK_OFFICE.test(w)), words(card).filter((w) => BACK_OFFICE.test(w)).join(" | "));
});

test("an input with no distribution gets the decisions at its three values and where the choice flips, and no EVPPI row and no probability", () => {
  const card = cardOf("range");
  assert.equal(card.thresholds.length, 1);
  const [row] = card.thresholds;
  assert.equal(row.label, "药物效应");
  assert.deepEqual(row.stated, { optimistic: 2, base: 1.2, pessimistic: 0.2 });
  // the option's own label stays, and beside it what it is in people; a trial of nobody is “不做试验” (review P2-7)
  assert.equal(row.decisions.optimistic, "n300（每组 300 人）");
  assert.equal(row.decisions.pessimistic, "no_trial（不做试验）");
  assert.equal(row.flips.length, 1);
  assert.ok(row.flips[0].value.value > 0.2 && row.flips[0].value.value < 2 && row.flips[0].value.mcse > 0);
  assert.ok(!card.inputs.some((input) => input.label === "药物效应"), "a range has no EVPPI");
  assert.ok(card.premises.some((p) => /没有概率分布/.test(p.value)), "the premises say the range has no distribution");
});

test("a table of draws the engine did not compute says so in the premises, and its inputs are named by the caller's own columns", () => {
  const card = cardOf("table");
  assert.ok(card.premises.some((p) => p.key === "table_source" && p.decisive && /没有重新计算/.test(p.value)));
  // the words of the person, not of the interface: no 「调用方」 and no 「引擎」 (P2-7), and a table nobody checked is not “你给的数据” (P1-1)
  assert.doesNotMatch(card.premises.map((p) => p.value).join(" "), /调用方|引擎/);
  assert.equal(card.premises.find((p) => p.key === "table_source").source, "assumed");
  assert.deepEqual(card.inputs.map((row) => row.label).sort(), ["theta", "w"]);
  assert.equal(card.studies.length, 1);
});

test("a result that is not of this kind, or has no options, is no card; a limited run says so", () => {
  const result = { id: "res_x", version: 1, kind: "design_dose", createdAt: "2026-11-09T10:00:00Z", ...fixture("two-arm") };
  assert.deepEqual(presentValueOfInformation({ allResults: [result], stale: [] }, { nodeOf: () => "n" }), []);
  const base = fixture("two-arm");
  const limited = cardOf("two-arm", { conclusion: "limited", diagnostics: { ...base.diagnostics, issues: [{ code: "cpu_budget_exhausted" }] } });
  assert.match(limited.limited, /预算在算完所有输入之前用完了/);
  assert.equal(cardOf("two-arm").limited, null);
});
