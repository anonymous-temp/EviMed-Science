// The patients tab's card for a drug given after a perpetrator of CYP3A4 (in-silico round 2, R38): the engine's real results (tests/numeric N160 holds
// their numbers to the authors' own simulation and to deSolve) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_RESULT_KIND_TABS, validateEngineJob } from "@evimed/domain";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { presentPbpkInteractions, vcrPbpkSubjectId } from "../src/vcrPbpk.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-pbpk/${name}.json`, import.meta.url), "utf8"));
const cardOf = (name, extra = {}) => {
  const result = { id: `res_${name}`, version: 1, kind: "pk_interaction", createdAt: "2026-11-09T10:00:00Z", reviewState: "ai_set", ...fixture(name), ...extra };
  const [card] = presentPbpkInteractions({ allResults: [result], stale: [] }, { nodeOf: () => "node" });
  return card;
};
const WORD_KEYS = new Set(["title", "question", "lead", "label", "value", "limited", "citation"]);
const words = (node, key = "") => (typeof node === "string" ? (WORD_KEYS.has(key) ? [node] : []) : Array.isArray(node) ? node.flatMap((each) => words(each, key)) : node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => words(each, k)) : []);
const BACK_OFFICE = /pk\.|pbpk_|job_|diagnostics|hash|seed|evimed|mrgsolve|\.cpp|_[a-z]+_|deSolve|Metrum/i;

test("the kind is a result of its own, read on the patients tab, filed under the regimen it was asked on", () => {
  assert.equal(VCR_JOB_METHODS.pk_interaction, "pk.interaction");
  assert.ok(VCR_JOB_KINDS.includes("pk_interaction"));
  assert.equal(vcrResultKindFor("pk_interaction"), "pk_interaction");
  assert.ok(VCR_RESULT_KINDS.includes("pk_interaction"));
  assert.equal(VCR_RESULT_KIND_TABS.pk_interaction, "patients");
  const scenario = { victim: { drug: "midazolam", doseMg: 3 }, perpetrator: { drug: "rifampicin", doseMg: 75, doses: 7 } };
  assert.match(vcrPbpkSubjectId(scenario), /^pk:/);
  assert.equal(vcrPbpkSubjectId(scenario), vcrPbpkSubjectId(structuredClone(scenario)));
  assert.notEqual(vcrPbpkSubjectId(scenario), vcrPbpkSubjectId({ ...scenario, perpetrator: { ...scenario.perpetrator, doseMg: 600 } }), "another dose is another result");
});

test("a perpetrator or a victim the published model does not carry is refused by name, never run with a stand-in", () => {
  const job = (scenario) => ({ jobId: "job_1", studyId: "std_1", protocolVersion: 1, seed: 1, cpuSecondsLimit: 600, inputs: [{ kind: "assumption", id: "asm_1@1" }], kind: "pk_interaction", method: "pk.interaction", methodVersion: "1.0.0", scenario });
  const good = { victim: { drug: "midazolam", doseMg: 3 }, perpetrator: { drug: "rifampicin", doseMg: 75, doses: 7 } };
  assert.deepEqual(validateEngineJob(job(good)), []);
  assert.deepEqual(validateEngineJob(job({ ...good, perpetrator: { ...good.perpetrator, drug: "ketoconazole" } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.perpetrator.drug"]);
  assert.deepEqual(validateEngineJob(job({ ...good, victim: { ...good.victim, drug: "tacrolimus" } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.victim.drug"]);
});

test("the card says what the ratio is, shows the curves and every number with its unit, and states whose values these are", () => {
  const card = cardOf("oral-7-days");
  assert.equal(card.form, "pbpk_interaction");
  assert.equal(card.victim, "咪达唑仑");
  assert.equal(card.route, "oral");
  const ratio = card.headline.find((line) => line.key === "auc_ratio");
  assert.ok(ratio.value.value > 0.24 && ratio.value.value < 0.25, "the area over 48 h; the authors' own 10 h window gives 0.277 (N160a)");
  assert.equal(ratio.value.unit, "倍");
  assert.equal(card.headline.find((line) => line.key === "victim_auc_alone").value.unit, "ng·h/mL");
  assert.match(card.lead, /^合用后，咪达唑仑的曲线下面积降到单用时的 24\.\d%/);
  assert.match(card.lead, /典型健康成人/);
  assert.equal(card.series.length, 2);
  assert.ok(card.series[1].ours && card.series[0].points.length === card.table.length && card.table.length >= 10);
  assert.ok(card.series[0].points[0].y === 0 && card.series[0].points.every((p) => Number.isFinite(p.y)));
  assert.ok(card.table.every((row) => row.alone.unit === "ng/mL" && row.alone.source === "calculated"));
  const decisive = card.premises.filter((p) => p.decisive).map((p) => p.key);
  assert.deepEqual(decisive, ["pbpk_model", "pbpk_person", "pbpk_regimen"], "3 decisive premises, no outside-the-fit row for a request inside it");
  assert.ok(card.premises.length > decisive.length, "the rest is folded");
  assert.match(card.premises.find((p) => p.key === "pbpk_person").value, /80 kg/);
  assert.match(card.premises.find((p) => p.key === "pbpk_regimen").value, /利福平 75 mg，每 24 小时一次，共 7 次；咪达唑仑口服 3 mg，在最后一次利福平后 12 小时给药/);
  assert.ok(card.premises.some((p) => p.key === "assumed_weightKg" && p.source === "default"), "the 80 kg the engine took is a stated default");
  assert.ok(!words(card).some((w) => BACK_OFFICE.test(w)), words(card).filter((w) => BACK_OFFICE.test(w)).join(" | "));
});

test("a request outside the doses the authors fitted runs, and says so as a premise", () => {
  const card = cardOf("iv-outside-fit");
  assert.equal(card.route, "iv");
  const outside = card.premises.filter((p) => p.key.startsWith("pbpk_outside_"));
  assert.deepEqual(outside.map((p) => p.key).sort(), ["pbpk_outside_perpetrator_dose", "pbpk_outside_victim_dose"]);
  assert.ok(outside.every((p) => p.decisive && /外推/.test(p.value)));
  assert.match(card.premises.find((p) => p.key === "pbpk_regimen").value, /静脉滴注 0\.5 小时/);
  assert.match(card.premises.find((p) => p.key === "pbpk_person").value, /70 kg/);
  assert.ok(card.premises.filter((p) => p.decisive).length <= 5);
});

test("a result of another kind, or a superseded one, makes no card", () => {
  const base = { id: "r", version: 1, createdAt: "2026-11-09T10:00:00Z", ...fixture("oral-7-days") };
  assert.deepEqual(presentPbpkInteractions({ allResults: [{ ...base, kind: "decision_voi" }], stale: [] }, { nodeOf: () => "n" }), []);
  assert.deepEqual(presentPbpkInteractions({ allResults: [{ ...base, kind: "pk_interaction", supersededBy: "x" }], stale: [] }, { nodeOf: () => "n" }), []);
});
