import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { printedNumber, printedTokenIn, boundedHalfWidth, curatedReference, curatedCaseNumeric, defaultHalfWidth, TOLERANCE_LIMITS } from "./tolerance.mjs";
import { numericScore, crossImplementationScore } from "./evaluator.mjs";

const close = (actual, expected) => Math.abs(actual - expected) <= Math.abs(expected) * 1e-9 + 1e-300;

test("a printed number is read to half a unit of its last printed digit", () => {
  assert.deepEqual(printedNumber("1.30"), { value: 1.3, halfUnit: 0.005, decimals: 2, percent: false });
  assert.equal(printedNumber("12").halfUnit, 0.5);
  assert.equal(printedNumber("3,616").value, 3616);
  assert.ok(close(printedNumber("37.5%").value, 0.375) && close(printedNumber("37.5%").halfUnit, 0.0005));
  assert.ok(close(printedNumber("−0.0149").value, -0.0149));
  for (const token of ["1.2e-5", "1.2E-5", "1.2 x 10^-5", "1.2×10−5"]) {
    assert.ok(close(printedNumber(token).value, 1.2e-5), token);
    assert.ok(close(printedNumber(token).halfUnit, 5e-7), token);
  }
  assert.equal(printedNumber("0.0000001").value, 1e-7);
  for (const token of ["<0.001", "1.2 (0.9-1.5)", "about 3", "", "1.2.3", null, 4]) assert.equal(printedNumber(token), null, String(token));
});

test("the reviewer's scenario: a curator's 1.30 +/- 0.5 no longer accepts the opposite direction", () => {
  // Before the rule, numericScore honoured whatever the curating model wrote.
  const curated = { value: 1.30, absoluteTolerance: 0.5, quote: "odds ratio 1.30 (95% CI 1.10 to 1.54)" };
  assert.equal(numericScore(0.85, curated).valid, false);
  assert.equal(numericScore(0.85, curated).toleranceClamped, true);
  assert.equal(numericScore(1.0, curated).valid, false, "the null value is not within tolerance");
  const frozen = curatedReference({ ...curated, printed: printedTokenIn(curated.quote, curated.value), quantity: "ratio" });
  assert.equal(frozen.ok, true);
  assert.ok(close(frozen.reference.absoluteTolerance, 0.005 * (1 + 1e-9)));
  assert.equal(frozen.reference.toleranceBasis, "printed-precision");
  assert.equal(numericScore(1.3049, frozen.reference).valid, true);
  assert.equal(numericScore(1.2951, frozen.reference).valid, true);
  assert.equal(numericScore(1.306, frozen.reference).valid, false);
  assert.equal(numericScore(0.85, frozen.reference).valid, false);
});

test("a p-value of order 1e-25 with an absolute tolerance of 1e-10 no longer passes anything", () => {
  const legacy = { value: 3.2e-25, absoluteTolerance: 1e-10 };
  assert.equal(numericScore(9.9e-11, legacy).valid, false, "a p 3e14 times the reference");
  assert.equal(numericScore(0, legacy).valid, false, "zero");
  assert.equal(numericScore(3.2e-25 * (1 + 5e-4), legacy).valid, true, "inside the relative ceiling");
  const curated = curatedReference({ value: 3.2e-25, quantity: "p-value" }, { requirePrinted: false });
  assert.equal(curated.ok, true);
  assert.equal(curated.reference.absoluteTolerance, 0);
  assert.ok(close(curated.reference.relativeTolerance, TOLERANCE_LIMITS.computedRelative));
  assert.equal(numericScore(3.2e-25 * (1 + 5e-7), curated.reference).valid, true);
  assert.equal(numericScore(3.2e-25 * (1 + 5e-5), curated.reference).valid, false);
  assert.equal(numericScore(3.3e-25, curated.reference).valid, false);
});

test("tolerances a model writes are discarded; looser than default needs a named reason inside the bound", () => {
  const modelWritten = curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.1 });
  assert.equal(modelWritten.ok, true);
  assert.ok(close(modelWritten.reference.absoluteTolerance, 0.0005 * (1 + 1e-9)), "model tolerance ignored");
  assert.deepEqual(curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.002 }, { allowLoosening: true }), { ok: false, code: "tolerance_reason_required" });
  assert.deepEqual(curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.002, toleranceReason: "because" }, { allowLoosening: true }), { ok: false, code: "tolerance_reason_required" });
  const reasoned = curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.002, toleranceReason: "inputs-rounded-in-source" }, { allowLoosening: true });
  assert.equal(reasoned.ok, true);
  assert.equal(reasoned.reference.absoluteTolerance, 0.002);
  assert.equal(reasoned.reference.toleranceBasis, "named-reason");
  assert.deepEqual(curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.0021, toleranceReason: "inputs-rounded-in-source" }, { allowLoosening: true }), { ok: false, code: "tolerance_exceeds_bound" });
  assert.deepEqual(curatedReference({ value: 0.164, printed: "0.164", absoluteTolerance: 0.05, toleranceReason: "stochastic-method" }, { allowLoosening: true }), { ok: false, code: "tolerance_exceeds_bound" });
  assert.deepEqual(curatedReference({ value: 1.3, printed: "1.25" }), { ok: false, code: "printed_value_bond_failed" });
  assert.deepEqual(curatedReference({ value: 1.3 }), { ok: false, code: "printed_value_missing" });
  assert.deepEqual(curatedReference({ value: 1.3, printed: "1.30", quantity: "odds" }), { ok: false, code: "reference_quantity_unknown" });
});

test("a tolerance that would accept the null or trivial answer is refused at curation", () => {
  // 1.01 printed to two decimals: loosening to two units of the last digit reaches the null ratio of 1.
  assert.deepEqual(curatedReference({ value: 1.01, printed: "1.01", quantity: "ratio", absoluteTolerance: 0.02, toleranceReason: "inputs-rounded-in-source" }, { allowLoosening: true }),
    { ok: false, code: "tolerance_accepts_trivial_answer" });
  assert.deepEqual(curatedReference({ value: 0.012, printed: "0.012", quantity: "difference", absoluteTolerance: 0.002, toleranceReason: "stochastic-method" }, { allowLoosening: true }).ok, true);
  assert.deepEqual(curatedReference({ value: 0.001, printed: "0.001", quantity: "difference", absoluteTolerance: 0.002, toleranceReason: "inputs-rounded-in-source" }, { allowLoosening: true }),
    { ok: false, code: "tolerance_accepts_trivial_answer" });
  // A paper may print the null itself. That number is kept, and marked as unable to tell answers apart.
  const printedNull = curatedReference({ value: 1, printed: "1.0", quantity: "ratio" });
  assert.equal(printedNull.ok, true);
  assert.equal(printedNull.discriminating, false);
  assert.deepEqual(curatedCaseNumeric({ estimate: { value: 1, printed: "1.0", quantity: "ratio" } }), { ok: false, code: "case_accepts_trivial_answer" });
  const mixed = curatedCaseNumeric({ estimate: { value: 1, printed: "1.0", quantity: "ratio", quote: "OR 1.0" }, upper: { value: 1.4, printed: "1.4", quantity: "ratio", outputPath: "ci.upper" } });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.numeric.upper.outputPath, "ci.upper");
  assert.equal(mixed.numeric.estimate.quote, "OR 1.0");
  assert.deepEqual(curatedCaseNumeric({ estimate: { value: 1.3, printed: "1.3" }, bad: { value: 2, printed: "2.5" } }), { ok: false, code: "printed_value_bond_failed", key: "bad" });
});

test("a quotation bonds a number by token, never by substring", () => {
  assert.equal(printedTokenIn("the hazard ratio was 0.52 in 1,250 patients", 5), null, "5 is not printed in 0.52 or 1,250");
  assert.equal(printedTokenIn("a rate of 0.12 per year", 12), null);
  assert.equal(printedTokenIn("10 of 100 patients", 1), null);
  assert.equal(printedTokenIn("the hazard ratio was 0.52 in 1,250 patients", 0.52), "0.52");
  assert.equal(printedTokenIn("the hazard ratio was 0.52 in 1,250 patients", 1250), "1,250");
  assert.equal(printedTokenIn("95% CI 0.80–1.25", 1.25), "1.25");
  assert.equal(printedTokenIn("a net benefit of −0.0149", -0.0149), "-0.0149");
  assert.equal(printedTokenIn("posterior probability 37.5%", 0.375), "37.5%");
  assert.equal(printedTokenIn("posterior probability 37.5%", 37.5), "37.5");
  assert.equal(printedTokenIn("p = 1.2 × 10−5", 1.2e-5), "1.2 × 10-5");
  assert.equal(printedTokenIn("version 1.30.2 of the package", 1.3), null);
  assert.equal(printedTokenIn(null, 1), null);
});

test("cross-implementation agreement uses the published tolerance and the same bound", () => {
  const tolerances = { effect: { value: 1.3, printed: "1.30", absoluteTolerance: 0.5 } };
  const scored = crossImplementationScore({ implementationId: "candidate", numeric: { effect: 0.9 } }, { implementationId: "reference", numeric: { effect: 1.2987 } }, tolerances);
  assert.equal(scored.effect.valid, false);
  assert.equal(crossImplementationScore({ implementationId: "candidate", numeric: { effect: 1.3001 } }, { implementationId: "reference", numeric: { effect: 1.2987 } }, tolerances).effect.valid, true);
});

test("the Python port in score_existing_methods.py reaches the same half-widths", async () => {
  const { vectors } = JSON.parse(await readFile(new URL("./tolerance-vectors.json", import.meta.url), "utf8"));
  for (const vector of vectors) {
    const bounded = boundedHalfWidth(vector.reference);
    assert.ok(close(bounded.halfWidth, vector.halfWidth), `${vector.name}: ${bounded.halfWidth}`);
    assert.equal(bounded.clamped, vector.clamped, vector.name);
  }
  const script = fileURLToPath(new URL("./score_existing_methods.py", import.meta.url));
  const program = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('scorer',${JSON.stringify(script)})\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nprint(json.dumps([module.bounded_half_width(v['reference']) for v in json.load(sys.stdin)['vectors']]))\n`;
  const result = spawnSync("python3", ["-c", program], { input: JSON.stringify({ vectors }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const python = JSON.parse(result.stdout);
  vectors.forEach((vector, index) => {
    assert.ok(close(python[index][0], vector.halfWidth), `${vector.name}: python ${python[index][0]}`);
    assert.equal(python[index][1], vector.clamped, vector.name);
  });
  assert.ok(close(defaultHalfWidth({ value: 2 }), 2e-6));
});
