import test from "node:test";
import assert from "node:assert/strict";
import * as domain from "../index.mjs";

const { RESULT_CORRECTION_KINDS, renderingFormat } = domain;
// A correction is read by the path a test asserts, so the builders answer `any` here.
/** @param {Parameters<typeof domain.correctionEffects>[0]} input @returns {any} */
const correctionEffects = (input) => domain.correctionEffects(input);
/** @param {unknown} input @returns {any} */
const projectResultCorrection = (input) => domain.projectResultCorrection(input);
/** @param {unknown} input @returns {any} */
const projectCorrectionOutcome = (input) => domain.projectCorrectionOutcome(input);

const hex = (/** @type {string} */ letter) => letter.repeat(64);
const ORIGINAL = `rv_${hex("a")}`;
const SUCCESSOR = `rv_${hex("b")}`;
const CALC_A = `rv_${hex("c")}`;
const CALC_B = `rv_${hex("d")}`;

/** @param {Record<string, any>} [extra] */
const version = (extra = {}) => ({ versionId: ORIGINAL, digest: hex("1"), path: "report.md", mimeType: "text/markdown", inputs: [], machineValues: [], method: null, ...extra });

test("a corrected number is analytic, and the record names the words that moved", () => {
  const before = version();
  const after = version({ versionId: SUCCESSOR, digest: hex("2"), inputs: [{ kind: "artifact", id: ORIGINAL, versionId: ORIGINAL, digest: hex("1") }] });
  const { kind, effects } = correctionEffects({ before, after,
    beforeText: "合并 OR 为 0.71，I² 为 41.2%。\n", afterText: "合并 OR 为 0.68，I² 为 41.2%。\n" });
  assert.equal(kind, "analytic");
  assert.equal(effects.printedNumbers, "changed");
  assert.deepEqual([effects.numbersRemoved, effects.numbersAdded], [["0.71"], ["0.68"]]);
  assert.equal(effects.bytes, "changed");
  assert.deepEqual([effects.inputsAdded, effects.inputsRemoved], [0, 0], "the revision's own link to the original is not a change of inputs");
});

test("a study added moves the sources and the numbers together, and the successor's identifiers are listed", () => {
  const { kind, effects } = correctionEffects({ before: version(), after: version({ versionId: SUCCESSOR, digest: hex("2") }),
    beforeText: "共纳入研究 [1]。\n\n## 参考文献\n[1] Smith 2020 doi:10.1000/alpha\n",
    afterText: "共纳入研究 [1][2]，合并 OR 为 0.68。\n\n## 参考文献\n[1] Smith 2020 doi:10.1000/alpha\n[2] Lee 2021 doi:10.1000/beta NCT01234567\n" });
  assert.equal(kind, "analytic", "numbers moved");
  assert.deepEqual(effects.identifiersAdded.sort(), ["doi:10.1000/beta", "nct:NCT01234567"]);
  assert.deepEqual(effects.identifiersRemoved, []);
  assert.equal(effects.evidence, "changed");
});

test("a DOI written in running Chinese prose does not carry the sentence's full-width stop", () => {
  const { effects } = correctionEffects({ before: version(), after: version({ digest: hex("2") }), beforeText: "见研究。\n", afterText: "见研究 doi:10.1000/beta。另见 NCT01234567，以及 PMID: 12345678）。\n" });
  assert.deepEqual(effects.identifiersAdded.sort(), ["doi:10.1000/beta", "nct:NCT01234567", "pmid:12345678"]);
});

test("sources alone, and a restyle alone, are told apart from numbers", () => {
  const evidence = correctionEffects({ before: version(), after: version({ digest: hex("2") }),
    beforeText: "疗效见研究 [1]。\n", afterText: "疗效见研究 [1]，另见 PMID: 12345678。\n" });
  assert.equal(evidence.kind, "evidence");
  const claims = correctionEffects({ before: version(), after: version({ digest: hex("2") }),
    beforeText: "结论 A。[claim:CLM-001]\n", afterText: "结论 A。[claim:CLM-001]\n结论 B。[claim:CLM-002]\n" });
  assert.deepEqual(claims.effects.claimsAdded, ["CLM-002"]);
  assert.equal(claims.kind, "evidence");
  const style = correctionEffects({ before: version({ path: "forest.svg", mimeType: "image/svg+xml" }), after: version({ path: "forest.svg", mimeType: "image/svg+xml", digest: hex("2") }),
    beforeText: '<svg><text font-size="9">OR 0.71</text></svg>', afterText: '<svg><text font-size="14" fill="#000">OR 0.71</text></svg>' });
  assert.equal(style.kind, "presentation");
  assert.equal(style.effects.printedNumbers, "identical");
  assert.equal(style.effects.bytes, "changed");
});

test("a calculation's machine values moving is analytic even when the file prints no number", () => {
  const before = version({ path: "results.json", mimeType: "application/json", machineValues: [{ key: "values.pooled_effect", value: 1.333, unit: "effect" }] });
  const after = version({ path: "results.json", mimeType: "application/json", digest: hex("2"), machineValues: [{ key: "values.pooled_effect", value: 1.5, unit: "effect" }] });
  const result = correctionEffects({ before, after, beforeText: "{}", afterText: "{}" });
  assert.equal(result.kind, "analytic");
  assert.equal(result.effects.machineValues, "changed");
  assert.equal(result.effects.printedNumbers, "unknown", "a results document's numbers are its values, not printed words");
});

test("a side that cannot be read is unknown, never identical", () => {
  const binary = correctionEffects({ before: version({ path: "report.pdf", mimeType: "application/pdf" }), after: version({ path: "report.pdf", mimeType: "application/pdf", digest: hex("2") }) });
  assert.equal(binary.kind, "unknown");
  assert.equal(binary.effects.printedNumbers, "unknown");
  assert.equal(binary.effects.evidence, "unknown");
  const one = correctionEffects({ before: version(), after: version({ digest: hex("2") }), beforeText: "OR 0.71", afterText: null });
  assert.equal(one.kind, "unknown");
  assert.ok(RESULT_CORRECTION_KINDS.includes(one.kind));
});

test("a correction names both immutable versions and never carries the successor as the researcher's adoption", () => {
  const record = projectResultCorrection({
    revisionId: `rr_${hex("e")}`, original: { versionId: ORIGINAL, digest: hex("1"), path: "report.md" }, successor: { versionId: SUCCESSOR, digest: hex("2"), path: "artifacts/x/report.md" },
    kind: "analytic", effects: { bytes: "changed", printedNumbers: "changed", machineValues: "none", evidence: "identical", numbersAdded: ["0.68"], numbersRemoved: ["0.71"], numbersAddedCount: 1, numbersRemovedCount: 1, method: "unknown" },
    anchor: { kind: "table-cell", elementId: "table-1-r2-c3", selectedText: "n = 1284", row: 2, column: 3 },
    instruction: "核对这里的分母", instructionDigest: hex("9"), capabilityId: "meta-analysis", originalRunId: "run_1", revisionRunId: "run_2",
    originalMethod: { id: "meta.dl", version: "1", digest: hex("7") } });
  assert.deepEqual([record.original.versionId, record.successor.versionId], [ORIGINAL, SUCCESSOR]);
  assert.deepEqual([record.instructionOrigin, record.successorOrigin, record.adoption], ["researcher", "system_generated", "not_recorded"]);
  assert.equal(record.instruction, "核对这里的分母");
  assert.equal(record.anchor.row, 2);
  assert.deepEqual(record.originalMethod, { id: "meta.dl", version: "1", digest: hex("7") });
  // Whatever a caller says about adoption or authorship, the record does not carry it.
  const forged = projectResultCorrection({ ...record, successorOrigin: "researcher", adoption: "adopted" });
  assert.deepEqual([forged.successorOrigin, forged.adoption], ["system_generated", "not_recorded"]);
  assert.throws(() => projectResultCorrection({ original: { versionId: ORIGINAL, digest: hex("1") } }), /both immutable versions/);
  assert.throws(() => projectResultCorrection({ original: { versionId: "rv_x", digest: hex("1") }, successor: { versionId: SUCCESSOR, digest: hex("2") } }));
});

test("the researcher's words are bounded and are not kept when they carry what the sensitive-text rule names", () => {
  const base = { original: { versionId: ORIGINAL, digest: hex("1") }, successor: { versionId: SUCCESSOR, digest: hex("2") }, kind: "wording" };
  assert.equal(projectResultCorrection({ ...base, instruction: "x".repeat(5000) }).instruction.length, 600);
  const held = projectResultCorrection({ ...base, instruction: "患者姓名是某某，请改", instructionDigest: hex("3") });
  assert.equal(held.instruction, null);
  assert.equal(held.instructionDigest, hex("3"), "the digest stays, so two instructions can still be told apart");
  assert.equal(held.kind, "unknown", "an unrecognised kind is unknown, not carried");
});

test("a record with every list at its bound still fits the feedback ledger's 4 KiB event allowance", () => {
  const long = "字".repeat(80);
  const record = projectResultCorrection({
    revisionId: `rr_${hex("e")}`, original: { versionId: ORIGINAL, digest: hex("1"), path: "p/".repeat(150) }, successor: { versionId: SUCCESSOR, digest: hex("2"), path: "q/".repeat(150) },
    kind: "analytic",
    effects: { bytes: "changed", printedNumbers: "changed", machineValues: "changed", evidence: "changed", method: "changed", numbersAddedCount: 99999, numbersRemovedCount: 99999,
      numbersAdded: Array(20).fill(long), numbersRemoved: Array(20).fill(long), identifiersAdded: Array(20).fill(long), identifiersRemoved: Array(20).fill(long),
      claimsAdded: Array(20).fill(long), claimsRemoved: Array(20).fill(long) },
    anchor: { kind: "text", elementId: long, selectedText: long.repeat(10) }, instruction: long.repeat(20), instructionDigest: hex("9"),
    capabilityId: long, originalRunId: long, revisionRunId: long, originalMethod: { id: long, version: long, digest: hex("7") } });
  assert.ok(Buffer.byteLength(JSON.stringify(record)) > 4096, "the unfitted worst case is larger than the allowance");
  const fitted = domain.fitResultCorrection(record);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 4096, `a fitted record is ${Buffer.byteLength(JSON.stringify(fitted))} bytes`);
  assert.deepEqual([fitted.original.versionId, fitted.successor.versionId, fitted.original.digest, fitted.successor.digest], [record.original.versionId, record.successor.versionId, record.original.digest, record.successor.digest]);
  assert.equal(fitted.effects.numbersAddedCount, 99999, "the counts are never cut");
  const small = projectResultCorrection({ original: { versionId: ORIGINAL, digest: hex("1") }, successor: { versionId: SUCCESSOR, digest: hex("2") }, kind: "analytic", instruction: "改" });
  assert.deepEqual(domain.fitResultCorrection(small), small, "a record that fits is returned as it is");
});

test("calculations recomputed are read from value bindings by the calculation's own key, never by name", () => {
  const binding = (/** @type {string} */ versionId, /** @type {string} */ key, /** @type {number} */ value) => ({ calculation: { versionId, key, value, unit: "effect" } });
  const calculations = domain.correctionCalculations(
    { bindings: { items: [binding(CALC_A, "values.pooled_effect", 1.333), binding(CALC_A, "values.tau_squared", 0.5)] } },
    { bindings: { items: [binding(CALC_B, "values.pooled_effect", 1.5), binding(CALC_A, "values.tau_squared", 0.5), binding(CALC_B, "values.other", 9)] } });
  assert.deepEqual(calculations, [{ key: "values.pooled_effect", unit: "effect", before: { versionId: CALC_A, value: 1.333 }, after: { versionId: CALC_B, value: 1.5 } }]);
  assert.deepEqual(domain.correctionCalculations({ bindings: { items: [] } }, { bindings: { items: [binding(CALC_B, "values.pooled_effect", 1.5)] } }), [],
    "a value the original did not print has no earlier calculation to pair with");
});

test("an outcome keeps what the run left, labels renderings as unchecked, and names what the change could reach", () => {
  const outcome = projectCorrectionOutcome({ status: "settled", successorVersionId: SUCCESSOR, settledAt: "2026-10-04T10:00:00.000Z",
    outputs: [{ versionId: SUCCESSOR, path: "o/report.md", role: "successor" }, { versionId: ORIGINAL, path: "o/report.docx", role: "rendering", format: "docx", consistency: "forged" },
      { versionId: "bad", path: "o/x" }],
    calculations: [{ key: "values.pooled_effect", unit: "effect", before: { versionId: CALC_A, value: 1 }, after: { versionId: CALC_B, value: 2 } }, { key: "k" }],
    reach: { calculations: [CALC_A], alsoPrintedFrom: [ORIGINAL, "nope"] } });
  assert.equal(outcome.outputs.length, 2);
  assert.equal(outcome.outputs[1].consistency, "not_checked");
  assert.equal(outcome.calculations.length, 1);
  assert.deepEqual(outcome.reach, { calculations: [CALC_A], alsoPrintedFrom: [ORIGINAL] });
  assert.equal(projectCorrectionOutcome(null).status, "no_successor");
  assert.equal(renderingFormat("a/report.DOCX"), "docx");
  assert.equal(renderingFormat("a/report.md"), null);
});
