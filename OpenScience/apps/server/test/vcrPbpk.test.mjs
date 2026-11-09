// The patients tab's card for a drug given after a perpetrator of CYP3A4 (in-silico round 2, R38): the engine's real results (tests/numeric N160 and N180
// hold their numbers to the authors' own simulation, the paper's table and deSolve) read into the payload the page shows.
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
  const job = (scenario) => ({ jobId: "job_1", studyId: "std_1", protocolVersion: 1, seed: 1, cpuSecondsLimit: 600, inputs: [{ kind: "assumption", id: "asm_1@1" }], kind: "pk_interaction", method: "pk.interaction", methodVersion: "1.2.0", scenario });
  const good = { victim: { drug: "midazolam", doseMg: 3 }, perpetrator: { drug: "rifampicin", doseMg: 75, doses: 7 } };
  assert.deepEqual(validateEngineJob(job(good)), []);
  assert.deepEqual(validateEngineJob(job({ ...good, perpetrator: { ...good.perpetrator, drug: "itraconazole" } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.perpetrator.drug"]);
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
  assert.match(card.lead, /^合用后，咪达唑仑的曲线下面积是单用时的 0\.242 倍（下降）/, "the lead says the ratio the headline says, in the same form (review P2-15)");
  assert.doesNotMatch(card.lead, /24\.\d%/);
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

test("the ketoconazole model is carried and the inhibitors with no model are refused by name", () => {
  const job = (scenario) => ({ jobId: "job_1", studyId: "std_1", protocolVersion: 1, seed: 1, cpuSecondsLimit: 600, inputs: [{ kind: "assumption", id: "asm_1@1" }], kind: "pk_interaction", method: "pk.interaction", methodVersion: "1.2.0", scenario });
  const ktz = { victim: { drug: "midazolam", doseMg: 1, route: "iv" }, perpetrator: { drug: "ketoconazole", doseMg: 200, doses: 6, gapH: 0 } };
  assert.deepEqual(validateEngineJob(job(ktz)), []);
  assert.deepEqual(validateEngineJob(job({ ...ktz, perpetrator: { ...ktz.perpetrator, inhibition: "noncompetitive" } })), []);
  assert.deepEqual(validateEngineJob(job({ ...ktz, perpetrator: { ...ktz.perpetrator, inhibition: "irreversible" } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.perpetrator.inhibition"]);
  for (const drug of ["itraconazole", "erythromycin", "diltiazem"]) {
    assert.deepEqual(validateEngineJob(job({ ...ktz, perpetrator: { ...ktz.perpetrator, drug } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.perpetrator.drug"], drug);
  }
  assert.ok(validateEngineJob(job({ ...ktz, perpetrator: { ...ktz.perpetrator, drug: "rifampicin", inhibition: "mixed" } })).length > 0, "an inhibition model on an inducer is not a field of it");
});

test("the ketoconazole card names the inhibition model, shows no enzyme-activity line and keeps the unused weight out of the person's premises", () => {
  const card = cardOf("ketoconazole-iv-validation");
  assert.equal(card.perpetrator, "酮康唑");
  assert.equal(card.route, "iv");
  assert.equal(card.weightKg, null);
  assert.ok(!card.headline.some((line) => /cyp3a4/.test(line.key)), "nothing is induced, so no enzyme-activity line");
  const ratio = card.headline.find((line) => line.key === "auc_ratio").value.value;
  assert.ok(ratio > 2.45 && ratio < 2.55, "the mixed model prints 2.5 in the paper's Table 4");
  assert.match(card.lead, /^合用后，咪达唑仑的曲线下面积是单用时的 2\.\d+ 倍/);
  assert.doesNotMatch(card.lead, /酶被诱导/);
  assert.match(card.citation, /Quinney/);
  const decisive = card.premises.filter((p) => p.decisive).map((p) => p.key);
  assert.deepEqual(decisive, ["pbpk_model", "pbpk_person", "pbpk_regimen", "pbpk_inhibition"], "the request is the paper's own validation design: no outside row");
  assert.match(card.premises.find((p) => p.key === "pbpk_inhibition").value, /^混合抑制。.*4\.5（竞争性）、2\.0（非竞争性）、2\.5（混合）.*3\.1/);
  assert.match(card.premises.find((p) => p.key === "pbpk_person").value, /体重不是输入/);
  assert.match(card.premises.find((p) => p.key === "pbpk_scope").value, /没有时间依赖性抑制/);
  assert.ok(!words(card).some((w) => BACK_OFFICE.test(w) || /NaN|undefined|null/.test(w)), words(card).filter((w) => BACK_OFFICE.test(w) || /NaN|undefined|null/.test(w)).join(" | "));
});

test("an oral dose and a dose the paper did not validate run and are said to be extrapolations", () => {
  const card = cardOf("ketoconazole-oral-outside");
  assert.equal(card.route, "oral");
  const outside = card.premises.filter((p) => p.key.startsWith("pbpk_outside_")).map((p) => p.key).sort();
  assert.deepEqual(outside, ["pbpk_outside_perpetrator_dose", "pbpk_outside_victim_route"]);
  assert.match(card.premises.find((p) => p.key === "pbpk_outside_victim_route").value, /口服是模型的外推/);
  assert.match(card.premises.find((p) => p.key === "pbpk_inhibition").value, /^竞争性抑制/);
  assert.ok(card.premises.filter((p) => p.decisive).length <= 6);
  assert.ok(card.premises.some((p) => p.key === "assumed_weightKg" && /没有用到/.test(p.value)), "a stated weight is not an input of this model, and the page says so");
});

test("clarithromycin is carried as an assembled perpetrator with a named set of in-vitro constants, and an unknown set is refused", () => {
  const job = (scenario) => ({ jobId: "job_1", studyId: "std_1", protocolVersion: 1, seed: 1, cpuSecondsLimit: 600, inputs: [{ kind: "assumption", id: "asm_1@1" }], kind: "pk_interaction", method: "pk.interaction", methodVersion: "1.2.0", scenario });
  const clr = { victim: { drug: "midazolam", doseMg: 4 }, perpetrator: { drug: "clarithromycin", doseMg: 500, intervalH: 12, doses: 14, gapH: 2 } };
  assert.deepEqual(validateEngineJob(job(clr)), []);
  assert.deepEqual(validateEngineJob(job({ ...clr, perpetrator: { ...clr.perpetrator, inactivationSet: "mayhew_hlm" } })), []);
  assert.deepEqual(validateEngineJob(job({ ...clr, perpetrator: { ...clr.perpetrator, inactivationSet: "fitted" } })).map((i) => `${i.code}@${i.field}`), ["scenario_value_invalid@scenario.perpetrator.inactivationSet"]);
  assert.ok(validateEngineJob(job({ ...clr, perpetrator: { ...clr.perpetrator, drug: "ketoconazole", inactivationSet: "mayhew_hlm" } })).length > 0, "an inactivation set on a reversible inhibitor is not a field of it");
});

test("the clarithromycin card says the perpetrator was assembled, names the constant set and its spread, and says the perpetrator's own exposure is too high", () => {
  const card = cardOf("clarithromycin-oral-compared");
  assert.equal(card.perpetrator, "克拉霉素");
  assert.equal(card.weightKg, null);
  assert.match(card.lead, /^合用后，咪达唑仑的曲线下面积是单用时的 4\.\d+ 倍/);
  assert.match(card.lead, /酶被不可逆灭活的结果：给药时肝脏 CYP3A4 活性剩下用药前的 \d+(\.\d+)?%/);
  assert.doesNotMatch(card.lead, /诱导/);
  assert.match(card.citation, /不是已发表的完整模型/);
  const decisive = card.premises.filter((p) => p.decisive).map((p) => p.key);
  assert.deepEqual(decisive, ["pbpk_model", "pbpk_person", "pbpk_regimen", "pbpk_inactivation", "pbpk_perpetrator_exposure"]);
  assert.match(card.premises.find((p) => p.key === "pbpk_model").value, /不是一个已发表的完整模型/);
  assert.match(card.premises.find((p) => p.key === "pbpk_model").value, /没有为了贴近临床结果调过任何一个数/);
  assert.match(card.premises.find((p) => p.key === "pbpk_inactivation").value, /29\.5.*相差五倍.*3\.5、4\.59、11\.5.*7 倍/);
  assert.match(card.premises.find((p) => p.key === "pbpk_perpetrator_exposure").value, /实测是 2\.33 mg\/L 和 15\.9 mg·h\/L.*偏高.*不能把它读成对模型的验证/);
  const defaulted = card.premises.find((p) => p.key === "assumed_perpetrator.inactivationSet");
  assert.ok(defaulted && /三组.*中位|median/.test(defaulted.value) && defaulted.source === "default", "the default set is a stated default, with its rule");
  assert.ok(!words(card).some((w) => BACK_OFFICE.test(w) || /NaN|undefined|null/.test(w)), words(card).filter((w) => BACK_OFFICE.test(w) || /NaN|undefined|null/.test(w)).join(" | "));
});

test("a clarithromycin dose that was not compared is an extrapolation, and a chosen set is worded", () => {
  const card = cardOf("clarithromycin-iv-outside");
  assert.equal(card.route, "iv");
  assert.deepEqual(card.premises.filter((p) => p.key.startsWith("pbpk_outside_")).map((p) => p.key), ["pbpk_outside_perpetrator_dose"]);
  assert.match(card.premises.find((p) => p.key === "pbpk_inactivation").value, /^人肝微粒体常数（Mayhew 2000/);
  assert.ok(!card.premises.some((p) => p.key === "pbpk_perpetrator_exposure"), "no clinical value for 1000 mg twice daily: no comparison is made up");
  assert.match(card.lead, /^合用后，咪达唑仑的曲线下面积是单用时的 \d/);
});

// round-2 review (X3): P1-1 whose words the regimen is, P1-13 no English sentence of the engine on the page, P1-4 no research-question rows on a PBPK result,
// P2-15 two out-of-range rows that say what each states, S15 every comparison figure is the data file's and none is typed in the presenter.
const ENGLISH_RUN = /[A-Za-z]{4,}(?: [A-Za-z]{2,}){2,}/;

test("review P1-1 and P1-13: the regimen is the run's statement unless a checked record says it was the person's, and the defaults are said in Chinese", () => {
  const card = cardOf("oral-7-days");
  assert.equal(card.premises.find((p) => p.key === "pbpk_regimen").source, "assumed", "no record of the person's messages: not 你给的数据");
  // a checked record that holds every stated number of the regimen makes it theirs, and the interval the engine defaulted is not among them
  const said = ["perpetrator.doseMg", "perpetrator.doses", "victim.doseMg"];
  const withRecord = cardOf("oral-7-days", { diagnostics: { ...fixture("oral-7-days").diagnostics, personStated: { schema: 2, readable: true, paths: [], matched: said } } });
  assert.equal(withRecord.premises.find((p) => p.key === "pbpk_regimen").source, "given");
  for (const row of card.premises.filter((p) => p.key.startsWith("assumed_"))) assert.doesNotMatch(row.value, ENGLISH_RUN, `${row.key}: ${row.value}`);
  const weight = card.premises.find((p) => p.key === "assumed_weightKg");
  assert.match(weight.value, /^80 kg（已发表模型代码用的体重/);
  assert.match(card.premises.find((p) => p.key === "assumed_victim.route").value, /^口服（相互作用研究里通常这样给咪达唑仑）/);
  assert.match(card.premises.find((p) => p.key === "assumed_perpetrator.intervalH").value, /^24 小时（每天一次）/);
});

test("review P1-4 and P2-15: no research-question rows on a PBPK card, and the out-of-range rows say which part is out", () => {
  const result = { id: "res_q", version: 1, kind: "pk_interaction", createdAt: "2026-11-09T10:00:00Z", ...fixture("iv-outside-fit") };
  const question = { id: "main", version: 3, fields: { intercurrentEvents: [{ event: "因不良反应停药", strategy: "composite" }] }, bases: {}, written: [], history: [{ version: 3, written: ["intercurrentEvents"] }] };
  const bundle = { allResults: [result], stale: [], researchQuestion: question, executions: new Map([["x", { jobId: "job_1" }]]), jobs: [{ id: "job_1", checkpoint: { questionRef: { id: "main", version: 2 } } }] };
  const [card] = presentPbpkInteractions(bundle, { nodeOf: () => "node" });
  assert.deepEqual(card.premises.filter((p) => p.key.startsWith("question:")), [], "a PBPK result simulates no trial endpoint");
  const outside = card.premises.filter((p) => p.key.startsWith("pbpk_outside_"));
  assert.equal(new Set(outside.map((p) => p.label)).size, outside.length, "adjacent rows are told apart by what they state");
  assert.ok(outside.every((p) => p.decisive), "both are decisive and none is folded away");
});

test("review S15: the clinical comparison figures are read from the data file, none typed in the presenter", () => {
  const data = JSON.parse(readFileSync(new URL("../src/vcrPbpkComparisons.json", import.meta.url), "utf8"));
  const clar = cardOf("clarithromycin-oral-compared").premises.find((p) => p.key === "pbpk_clinical").value;
  assert.ok(clar.includes(`几何平均倍数误差 ${data.clarithromycin.reported.polasek_hlm.geometricMeanFoldError.toFixed(2)}`), clar);
  assert.ok(clar.includes(`${data.clarithromycin.reported.ito_hlm.geometricMeanFoldError.toFixed(2)}，${data.clarithromycin.reported.ito_hlm.of} 项里有 ${data.clarithromycin.reported.ito_hlm.within2} 项`), clar);
  const rif = cardOf("oral-7-days").premises.find((p) => p.key === "pbpk_clinical").value;
  assert.match(rif, /几何平均倍数误差 2\.1/);
  assert.match(rif, /6 项里有 3 项在两倍以内/);
  assert.match(rif, /Link 2008，模型的比值是它的 6\.5 倍/);
  const keto = cardOf("ketoconazole-iv-validation").premises.find((p) => p.key === "pbpk_clinical").value;
  assert.match(keto, /静脉 3 到 4\.3 倍，口服 12\.4 到 18\.3 倍/);
  assert.match(keto, /几何平均倍数误差 1\.41/);
  // the typed numbers of the old sentences are gone from the source
  const source = readFileSync(new URL("../src/vcrPbpk.mjs", import.meta.url), "utf8");
  for (const typed of ["几何平均倍数误差 1.4", "3.5、4.6、11.5", "近八倍", "2.7 到 4.7"]) assert.ok(!source.includes(typed), typed);
});
