// Plan G3 (same class as R22): every result family whose card prints the one 「这个结论的前提」 block carries the research question's rows
// the way the trial, population and comparison pages do (which version the result answers). The bias and borrowing rows are part of the
// comparison page's own premises, which take the question in `vcrPremises("comparator", ...)`; a test below holds that too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { presentBayesianDesigns } from "../src/vcrBayesianDesign.mjs";
import { presentConfirmatoryDesigns } from "../src/vcrConfirmatory.mjs";
import { presentDoseDesigns } from "../src/vcrDoseFinding.mjs";
import { presentPrognosticModels } from "../src/vcrPrognosticTraining.mjs";
import { presentSplineFits } from "../src/vcrSplineFit.mjs";
import { presentWinRatioDesigns } from "../src/vcrWinRatio.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { resultQuestionInput } from "../src/vcrResearchQuestionView.mjs";

const fixture = (directory, name) => JSON.parse(readFileSync(new URL(`./fixtures/${directory}/${name}.json`, import.meta.url), "utf8"));
const NODE = (row) => `result:${row.id}@${row.version}`;
const QUESTION = { id: "main", version: 3, studyId: "s", fields: { question: "q" }, bases: {}, written: [], by: "u", createdAt: null };
/** A bundle whose job recorded the question's first version, so a result answers an earlier one. */
const bundle = (result, question = QUESTION) => ({ allResults: [result], stale: [], researchQuestion: question,
  executions: new Map([[result.executionId, { jobId: "job_1" }]]), jobs: [{ id: "job_1", checkpoint: { questionRef: { id: "main", version: 1 } } }] });
const FAMILIES = [
  ["dose", presentDoseDesigns, "design_dose", fixture("vcr-dose", "selection"), {}],
  ["confirmatory", presentConfirmatoryDesigns, "design_confirmatory", fixture("vcr-confirmatory", "futility"), {}],
  ["bayesian", presentBayesianDesigns, "design_bayesian", fixture("vcr-bayesian", "bop2"), {}],
  ["win ratio", presentWinRatioDesigns, "design_win_ratio", fixture("vcr-win-ratio", "power"), {}],
  ["prognostic model", presentPrognosticModels, "prognostic_training", fixture("vcr-prognostic-training", "cox"), {}],
  ["spline fit", presentSplineFits, "model_fit", fixture("vcr-borrowing", "spline-fit"), { diagnostics: { timeUnit: "months" } }],
];

for (const [name, present, kind, base, patch] of FAMILIES) {
  test(`the ${name} card names the version of the research question it answers`, () => {
    const result = { ...base, ...patch, diagnostics: { ...base.diagnostics, ...patch.diagnostics }, id: "res_1", version: 1, kind, subjectId: "x", executionId: "exe_1",
      createdAt: "2026-11-04T00:00:00Z", supersededBy: null, reviewState: "ai_set" };
    const own = present({ allResults: [result], stale: [] }, { nodeOf: NODE })[0];
    assert.ok(own, `${name}: a card`);
    assert.ok(!own.premises.some((row) => row.key.startsWith("question:")), "a study with no question adds nothing");
    const card = present(bundle(result), { nodeOf: NODE })[0];
    const earlier = card.premises.find((row) => row.key === "question:earlier");
    assert.ok(earlier, `${name}: ${card.premises.map((row) => row.key)}`);
    assert.match(earlier.value, /第 1 版.*第 3 版/);
    assert.ok(card.premises.filter((row) => row.decisive).length <= 5, "the block's own limit holds");
    // every premise the card had is still there, in the one block
    for (const row of own.premises) assert.ok(card.premises.some((entry) => entry.key === row.key), `${name}: ${row.key} kept`);
    // a result whose job recorded no version is not marked
    const unmarked = present({ ...bundle(result), jobs: [{ id: "job_1", checkpoint: {} }] }, { nodeOf: NODE })[0];
    assert.ok(!unmarked.premises.some((row) => row.key === "question:earlier"));
  });
}

test("the comparison page's own premises take the question, so a bias analysis and a borrowing carry it", () => {
  const input = resultQuestionInput(bundle({ executionId: "exe_1" }), { executionId: "exe_1" });
  for (const diagnostics of [fixture("vcr-bias-analysis", "bias-ratio").diagnostics ?? {}, fixture("vcr-borrowing", "elastic-binary").diagnostics ?? {}]) {
    const rows = vcrPremises("comparator", { researchQuestion: input, diagnostics, measures: {} });
    assert.ok(rows.some((row) => row.key === "question:earlier"));
  }
});
