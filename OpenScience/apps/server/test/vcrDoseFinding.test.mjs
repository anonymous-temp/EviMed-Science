// The dose-finding designs on the trial page (algorithm round T7, T15, 2026-11-03): the engine's result of a design_dose job, read into the
// card the trial tab shows. The fixtures are real results of the engine (tests/numeric/N81-N83 hold their numbers to references).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cellLabel, presentDoseDesigns, vcrDoseSubjectId } from "../src/vcrDoseFinding.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { measureLabel } from "../src/vcrViewsKit.mjs";
import { VCR_RESULT_KIND_TABS } from "@evimed/domain";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-dose/${name}.json`, import.meta.url), "utf8"));
const card = (name, patch = {}) => {
  const result = { ...fixture(name), id: "res_1", version: 1, kind: "design_dose", subjectId: "dose:x", createdAt: "2026-11-03T00:00:00Z", supersededBy: null, reviewState: "ai_set", ...patch };
  return presentDoseDesigns({ allResults: [result], stale: [] }, { nodeOf: (row) => `result:${row.id}@${row.version}` })[0];
};

test("a finished design_dose job reaches the trial tab: its own kind, the trial tab, a key made of the designs and the curve", () => {
  assert.equal(vcrResultKindFor("design_dose"), "design_dose");
  assert.ok(VCR_RESULT_KINDS.includes("design_dose"));
  assert.equal(VCR_RESULT_KIND_TABS.design_dose, "trial");
  const curve = [0.05, 0.1, 0.2, 0.3, 0.45, 0.6];
  const a = vcrDoseSubjectId({ design: { kind: "boin", compare: ["three_plus_three"] }, truth: { toxicity: curve } });
  assert.equal(a, vcrDoseSubjectId({ design: { kind: "three_plus_three", compare: ["boin"] }, truth: { toxicity: curve } }), "the same two designs on the same curve are one question");
  assert.notEqual(a, vcrDoseSubjectId({ design: { kind: "boin", compare: ["three_plus_three"] }, truth: { toxicity: [0.1, 0.2, 0.3] } }), "another curve is another result");
  assert.notEqual(a, vcrDoseSubjectId({ design: { kind: "boin", compare: ["crm"] }, truth: { toxicity: curve } }), "another comparison is another result");
  assert.match(a, /^dose:boin\+three_plus_three:[0-9a-f]{10}$/);
  // Live 2026-11-04: BOIN with 45 patients instead of 30, and BOIN with the published boundaries, were versions of the question's own result: the
  // page showed the sensitivity run beside a reply that stated the first. Everything the scenario states but the order of the designs is the question.
  const asked = { design: { kind: "boin", compare: ["three_plus_three"], targetToxicity: 0.25, cohortSize: 3, maxPatients: 30, startDose: 1 }, truth: { toxicity: curve } };
  assert.equal(vcrDoseSubjectId(asked), vcrDoseSubjectId({ truth: { toxicity: curve }, design: { startDose: 1, maxPatients: 30, cohortSize: 3, targetToxicity: 0.25, compare: ["three_plus_three"], kind: "boin" } }), "key order is not a difference");
  assert.equal(vcrDoseSubjectId(asked), vcrDoseSubjectId({ ...asked, design: { ...asked.design, kind: "three_plus_three", compare: ["boin"] } }), "nor is the order of the two designs");
  assert.notEqual(vcrDoseSubjectId(asked), vcrDoseSubjectId({ ...asked, design: { ...asked.design, maxPatients: 45 } }), "another size is another result");
  assert.notEqual(vcrDoseSubjectId(asked), vcrDoseSubjectId({ ...asked, design: { ...asked.design, boin: { lambdaE: 0.197, lambdaD: 0.298 } } }), "another boundary is another result");
  assert.notEqual(vcrDoseSubjectId(asked), vcrDoseSubjectId({ ...asked, design: { ...asked.design, targetToxicity: 0.3 } }), "another target is another result");
});

test("four designs on one curve sit side by side, with the difference against the one asked about and the error of the differences", () => {
  const each = card("compare");
  assert.equal(each.form, "dose_finding");
  assert.equal(each.title, "BOIN 与 3+3、Keyboard、CRM 的对比");
  assert.match(each.question, /几种设计选对最大耐受剂量的概率、超量给药的人数差多少/);
  assert.deepEqual(each.table.rows.map((row) => row.label), ["BOIN", "3+3", "Keyboard", "CRM"]);
  assert.deepEqual(each.table.rows.map((row) => row.role), ["asked", "compared", "compared", "compared"]);
  const boin = each.table.rows[0].cells.correct_dose_probability;
  assert.equal(boin.unit, "%");
  assert.ok(boin.mcse > 0 && boin.value > 30 && boin.value < 60, "a simulated probability, in percent, with its error");
  assert.equal(boin.source, "synthetic");
  assert.deepEqual(each.differences.rows.map((row) => row.label), ["3+3 比 BOIN", "Keyboard 比 BOIN", "CRM 比 BOIN"]);
  const threePlusThree = each.differences.rows[0].cells;
  assert.ok(threePlusThree.correct_dose_probability.value < -10, "3+3 picks the right dose less often than BOIN on this curve");
  assert.ok(threePlusThree.patients_above_mtd.value < 0, "and treats fewer people above the MTD, because it is smaller");
  const paired = each.differences.rows[0].cells.correct_dose_probability.mcse;
  const apart = Math.hypot(each.table.rows[0].cells.correct_dose_probability.mcse, each.table.rows[1].cells.correct_dose_probability.mcse);
  assert.ok(paired < apart, "the paired difference has a smaller error than the two errors together");
  assert.equal(each.doses.length, 6);
  assert.equal(each.doses.filter((dose) => dose.mtd).map((dose) => dose.dose)[0], 4);
  assert.equal(each.perDose.length, 4);
  assert.ok(each.perDose.every((row) => row.select.length === 6 && row.patients.length === 6));
  const total = each.perDose[0].select.reduce((sum, value) => sum + value.value, 0) + each.table.rows[0].cells.select_none_probability.value;
  assert.ok(Math.abs(total - 100) < 1e-6, "the probabilities of choosing each dose and of choosing none add to 100%");
  assert.equal(each.limited, null);
});

test("the premises name the curve, the target, the size and the skeleton, and say what BOIN is; nothing says a design is qualified", () => {
  const each = card("compare");
  const decisive = each.premises.filter((row) => row.decisive).map((row) => row.key);
  assert.deepEqual(decisive, ["curve", "target", "size", "skeleton", "boin"]);
  const boin = each.premises.find((row) => row.key === "boin");
  assert.match(boin.value, /局部/);
  assert.match(boin.value, /无信息先验/);
  assert.match(boin.value, /联合用药和迟发毒性不在其中/);
  assert.ok(each.premises.find((row) => row.key === "curve").value.includes("5%"));
  assert.equal(each.premises.find((row) => row.key === "target").source, "default", "a target nobody stated is a default");
  const everything = JSON.stringify(each);
  assert.doesNotMatch(everything, /FDA|认定|批准|背书|qualif|endors/i);
  assert.ok(each.premises.some((row) => row.label === "“选对”的含义"), "what 'correct' means is a premise");
});

test("one design alone is a card of its own and no label is a back-office key", () => {
  const each = card("alone");
  assert.equal(each.title, "3+3 的运行特征");
  assert.equal(each.differences, null);
  assert.match(each.question, /这种设计/);
  for (const entry of each.headline) assert.match(entry.label, /[一-龥]/, entry.key);
  for (const column of each.table.columns) assert.match(column.label, /[一-龥]/, column.key);
  for (const name of ["select_dose_3", "patients_dose_2", "correct_dose_probability", "patients_above_mtd"]) assert.ok(cellLabel(name), name);
  assert.equal(measureLabel("select_dose_3"), "第 3 剂量被选中的概率");
  assert.equal(measureLabel("patients_dose_2"), "第 2 剂量的患者数（平均）");
  assert.ok(!each.premises.some((row) => row.key === "boin" || row.key === "skeleton"), "only the designs that ran have premises");
});

test("the selection among randomised doses is a table of exact probabilities, with the size and the saw-tooth said", () => {
  const each = card("selection");
  assert.equal(each.form, "dose_selection");
  assert.equal(each.title, "随机分组的剂量选择");
  assert.equal(each.selection.perArm, 289);
  assert.equal(each.selection.requiredFirst, 289);
  assert.equal(each.selection.requiredStable, 313);
  assert.match(each.selection.note, /起伏/);
  assert.equal(each.selection.scenarios.length, 2);
  const first = each.selection.scenarios[0];
  assert.equal(first.rightDose, 1);
  assert.equal(first.correct.mcse, null, "an exact probability carries no Monte-Carlo error");
  assert.equal(first.correct.unit, "%");
  assert.ok(first.correct.value >= 90 - 1e-6);
  assert.ok(Math.abs(first.select.reduce((sum, value) => sum + value.value, 0) - 100) < 1e-6);
  assert.equal(each.selection.totalPatients, 289 * 2);
  assert.deepEqual(each.premises.filter((row) => row.decisive).map((row) => row.key), ["rates", "margin", "right", "probability"]);
  const table = card("selection_table");
  assert.equal(table.selection.requiredFirst, null, "a stated size is a table, not a search");
  assert.equal(table.selection.perArm, 40);
});

test("an error of exactly zero (no event in any trial, or a size every trial shared) is shown with no error, never as ±0", () => {
  const each = card("compare");
  const sizes = each.table.rows.map((row) => row.cells.expected_sample_size);
  assert.ok(sizes.every((value) => value.mcse === null || value.mcse > 0));
  for (const row of each.perDose) for (const value of [...row.select, ...row.patients]) assert.ok(value.mcse === null || value.mcse > 0);
});

test("a run that was stopped by its budget says so and keeps its numbers", () => {
  const stopped = card("compare", { conclusion: "limited", diagnostics: { ...fixture("compare").diagnostics, doseFinding: { ...fixture("compare").diagnostics.doseFinding, trials: 2000, trialsRequested: 4000 } } });
  assert.match(stopped.limited, /2000 次，原定 4000 次/);
  assert.ok(stopped.table.rows[0].cells.correct_dose_probability.value > 0);
});

test("every number the engine puts in a result's headline has a label, so none is dropped from the card (review RF2 P2-9)", () => {
  for (const name of ["alone", "compare", "selection", "selection_table"]) {
    const result = fixture(name);
    const unlabelled = result.measures.map((measure) => String(measure.name)).filter((measure) => cellLabel(measure) === null);
    assert.deepEqual(unlabelled, [], `${name}: a measure without a label is a number the card cannot show`);
  }
  const selection = presentDoseDesigns({ allResults: [{ ...fixture("selection"), id: "res_1", version: 1, kind: "design_dose", createdAt: "2026-11-04T00:00:00Z" }], stale: [] }, { nodeOf: (row) => `result:${row.id}` });
  assert.ok(selection[0].headline.some((entry) => entry.key === "worst_correct_dose_probability"), "the worst scenario's chance of choosing the right dose is on the card");
});
