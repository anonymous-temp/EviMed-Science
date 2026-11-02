// The criteria-parse check (M3): a deterministic comparator of how a registry trial's eligibility text was structured, and the labelled set
// and stored parses it runs on, with no model and no network. It is a regression check of the comparator and of the stored examples, not a
// measurement of any model's parsing - `evals/vcr-matching/criteria-parse/README.md` says what it does not show.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalRequirement, compareParse, grammarFindings, scoreParses, structureDifferences } from "../../../evals/vcr-matching/criteria-parse/criteria_parse_check.mjs";
import { locateSourceText } from "../src/vcrPatientTrials.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/vcr-matching/criteria-parse");
const set = JSON.parse(await readFile(path.join(dir, "cases.json"), "utf8"));
const stored = JSON.parse(await readFile(path.join(dir, "stored-parses.json"), "utf8"));

test("the labelled set is 30 to 50 realistic eligibility texts in both languages, each line of which the platform's own locator finds once and the grammar accepts", () => {
  assert.ok(set.cases.length >= 30 && set.cases.length <= 50, `${set.cases.length} cases`);
  assert.equal(set.synthetic, true, "the set says it is authored");
  assert.equal(new Set(set.cases.map((item) => item.id)).size, set.cases.length);
  assert.deepEqual([...new Set(set.cases.map((item) => item.language))].sort(), ["en", "zh"]);
  assert.ok(set.cases.filter((item) => item.language === "zh").length >= 10);
  for (const item of set.cases) {
    assert.ok(item.expected.length >= 4 && item.expected.length <= 9, `${item.id}: ${item.expected.length} lines`);
    const spans = item.expected.map((line) => locateSourceText(line.sourceText, item.text));
    assert.ok(spans.every(Boolean), `${item.id}: every labelled line is in its text, word for word`);
    const ordered = spans.map((span) => span.start).sort((a, b) => a - b);
    assert.equal(new Set(ordered).size, ordered.length, `${item.id}: no two labelled lines stand at the same place`);
    assert.ok(item.expected.some((line) => line.kind === "inclusion") && item.expected.some((line) => line.kind === "exclusion"), `${item.id}: both kinds`);
  }
  assert.deepEqual(grammarFindings(set.cases.map((item) => ({ id: item.id, lines: item.expected }))), [], "every labelled requirement is one the platform would accept");
  assert.deepEqual(grammarFindings(Object.entries(stored.parses).map(([id, lines]) => ({ id, lines }))), [], "and every stored parse");
  const ops = new Set(JSON.stringify(set.cases.map((item) => item.expected)).match(/"op":"(\w+)"/g));
  for (const op of ["all", "any", "present", "absent", "compare", "elapsed_since", "language"]) assert.ok(ops.has(`"op":"${op}"`), `the set uses ${op}`);
  assert.ok(JSON.stringify(set.cases).includes('"comparator":"between"') && JSON.stringify(set.cases).includes('"window"'));
});

test("the stored parses cover every case, and exactly the cases named as planted differ from the labelled structure, each in the way it says", () => {
  assert.deepEqual(Object.keys(stored.parses).sort(), set.cases.map((item) => item.id).sort());
  assert.equal(stored.synthetic, true);
  assert.match(stored.note, /not the output of a model run/);
  const report = scoreParses(set, stored);
  for (const row of report.perCase) {
    const flaw = stored.planted[row.id];
    if (!flaw) { assert.equal(row.complete, true, `${row.id} is the labelled structure`); continue; }
    assert.equal(row.complete, false, `${row.id} carries a planted flaw`);
    assert.deepEqual({
      missed: row.missed.map((entry) => entry.sourceText), unlocated: row.unlocated.map((entry) => entry.sourceText), extra: row.extra.map((entry) => entry.sourceText),
      wrongKind: row.wrongKind.map((entry) => entry.sourceText), wrongStructure: row.wrongStructure.map((entry) => entry.sourceText),
    }, { missed: [], unlocated: [], extra: [], wrongKind: [], wrongStructure: [], ...flaw }, `${row.id}: found as planted, and nothing else`);
  }
  assert.equal(Object.keys(stored.planted).length, report.cases - report.casesComplete);
});

test("the figures of the stored set are what they were (a change to the comparator or to an example shows here)", () => {
  const { perCase: _perCase, ...figures } = scoreParses(set, stored);
  assert.deepEqual(figures, {
    cases: 36, casesComplete: 23, criteria: { expected: 236, parsed: 235, matched: 231 },
    missed: 5, unlocated: 2, extra: 2, wrongKind: 2, wrongStructure: 5, logicCorrect: 224,
    percent: { missed: 2.1, malformedOfFound: 3, logicCorrect: 94.9 },
  });
});

test("a parse equal to the labelled structure is complete, whatever order its operands and keys are in", () => {
  const item = set.cases.find((entry) => entry.id === "en-nsclc-egfr-second-line");
  const backwards = (node) => (Array.isArray(node) ? node.map(backwards) : node && typeof node === "object"
    ? Object.fromEntries(Object.keys(node).reverse().map((key) => [key, backwards(node[key])])) : node);
  const shuffled = item.expected.map((line) => ({ ...line, requirement: backwards(line.requirement) }));
  const reorder = (node) => (node?.operands ? { ...node, operands: [...node.operands].reverse().map(reorder) } : node);
  const reversed = [...item.expected].reverse().map((line) => ({ ...line, requirement: reorder(line.requirement) }));
  for (const parsed of [item.expected, shuffled, reversed]) assert.equal(compareParse({ text: item.text, expected: item.expected, parsed }).complete, true);
});

const TEXT = "Inclusion Criteria:\n* Age >= 18 years\n* Hemoglobin below 10 g/dL\n* Documented EGFR mutation or ALK rearrangement\nExclusion Criteria:\n* Pregnant women\n* Able to consent: not";
const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } };
const HB = { kind: "inclusion", criterionType: "lab", sourceText: "Hemoglobin below 10 g/dL", requirement: { op: "compare", variable: "hemoglobin", comparator: "lt", value: 10, unit: "g/dL" } };
const DRIVER = { kind: "inclusion", criterionType: "biomarker", sourceText: "Documented EGFR mutation or ALK rearrangement",
  requirement: { op: "any", operands: [{ op: "present", variable: "egfr_mutation" }, { op: "present", variable: "alk_rearrangement" }] } };
const PREGNANT = { kind: "exclusion", criterionType: "pregnancy", sourceText: "Pregnant women", requirement: { op: "present", variable: "pregnancy" } };
const EXPECTED = [AGE, HB, DRIVER, PREGNANT];
const compare = (parsed, extra = {}) => compareParse({ text: TEXT, expected: EXPECTED, parsed, ...extra });

test("the comparator reads a line as the same line when it stands at the same characters, folding what the platform folds", () => {
  assert.equal(compare(EXPECTED).complete, true);
  assert.equal(compare([{ ...AGE, sourceText: "age ≥ 18 years" }, HB, DRIVER, PREGNANT]).complete, true, "case, >= against ≥ and spacing are the same");
  assert.equal(compare([{ ...AGE, sourceText: "* Age >= 18 years" }, HB, DRIVER, PREGNANT]).complete, true, "a list marker is the list's");
  const paraphrase = compare([{ ...AGE, sourceText: "Adults only" }, HB, DRIVER, PREGNANT]);
  assert.deepEqual([paraphrase.missed.length, paraphrase.unlocated.length], [1, 1], "a paraphrase is a missed line and an unlocated one, never a near match");
  const repeated = compare([AGE, AGE, HB, DRIVER, PREGNANT]);
  assert.deepEqual([repeated.extra.length, repeated.complete], [1, false], "a repeat is an extra line");
  const narrative = compare([...EXPECTED, { kind: "inclusion", criterionType: "other", sourceText: "Inclusion Criteria:", requirement: { op: "present", variable: "x" } }]);
  assert.deepEqual([narrative.extra.length, narrative.missed.length], [1, 0], "a located sentence that is no line is extra");
  assert.deepEqual(compare([]).missed.length, 4, "no parse is every line missed");
});

test("the comparator tells a wrong kind from a wrong structure, and a wrong structure by where it differs", () => {
  const kind = compare([AGE, HB, DRIVER, { ...PREGNANT, kind: "inclusion" }]);
  assert.deepEqual(kind.wrongKind, [{ sourceText: "Pregnant women", expected: "exclusion", got: "inclusion" }]);
  assert.equal(kind.wrongStructure.length, 0);
  const value = compare([{ ...AGE, requirement: { ...AGE.requirement, value: 81 } }, HB, DRIVER, PREGNANT]);
  assert.deepEqual(value.wrongStructure, [{ sourceText: "Age >= 18 years", differences: ["requirement.value"] }]);
  const logic = compare([AGE, HB, { ...DRIVER, requirement: { ...DRIVER.requirement, op: "all" } }, PREGNANT]);
  assert.deepEqual(logic.wrongStructure[0].differences, ["requirement.op"]);
  const unit = compare([AGE, { ...HB, requirement: { ...HB.requirement, unit: "g/L" } }, DRIVER, PREGNANT]);
  assert.deepEqual(unit.wrongStructure[0].differences, ["requirement.unit"], "a unit is part of the structure");
  const applicability = compare([{ ...PREGNANT, applicability: { op: "compare", variable: "sex", comparator: "eq", value: "female" } }, AGE, HB, DRIVER]);
  assert.equal(applicability.wrongStructure.length, 1);
  assert.ok(applicability.wrongStructure[0].differences.every((path) => path.startsWith("applicability")), "a scope the label does not have is a difference of the applicability, not of the requirement");
  assert.equal(compare([AGE, HB, DRIVER, { ...PREGNANT, requirement: { op: "absent", variable: "pregnancy" } }]).wrongStructure[0].differences[0], "requirement.op");
});

test("a variable by any of its aliases, a number as a number, and a language node as a language node", () => {
  const renamed = [AGE, { ...HB, requirement: { ...HB.requirement, variable: "hb" } }, DRIVER, PREGNANT];
  assert.equal(compare(renamed).wrongStructure.length, 1, "another name is another variable unless the case says they are one");
  assert.equal(compare(renamed, { aliases: [["hemoglobin", "hb", "haemoglobin"]] }).complete, true);
  assert.equal(compare([{ ...AGE, requirement: { ...AGE.requirement, value: "18" } }, HB, DRIVER, PREGNANT]).complete, true);
  const language = { kind: "inclusion", criterionType: "consent_capacity", sourceText: "Able to consent: not", requirement: { op: "language", key: "consent", text: "Able to consent: not" } };
  const asked = compareParse({ text: TEXT, expected: [language], parsed: [{ ...language, requirement: { op: "language", key: "capacity_to_consent", text: "Can consent" } }] });
  assert.equal(asked.complete, true, "what a language criterion asks is the model's to answer: its key and words are not the parse's to get right");
  assert.equal(compareParse({ text: TEXT, expected: [language], parsed: [{ ...language, requirement: { op: "present", variable: "consent" } }] }).wrongStructure.length, 1);
  assert.deepEqual(canonicalRequirement({ op: "all", operands: [{ op: "present", variable: "b" }, { op: "present", variable: "a" }] }),
    canonicalRequirement({ op: "all", operands: [{ op: "present", variable: "a" }, { op: "present", variable: "b" }] }));
  assert.deepEqual(structureDifferences({ a: [1, 2] }, { a: [1, 3] }), ["requirement.a[1]"]);
  assert.deepEqual(structureDifferences({ a: [1] }, { a: [1, 2] }), ["requirement.a.length"]);
});

test("the grammar findings name a requirement the platform would refuse and an exclusion written negated twice", () => {
  const findings = grammarFindings([{ id: "x", lines: [{ kind: "inclusion", requirement: { op: "teleport" } }, { kind: "exclusion", requirement: { op: "not", operand: { op: "not", operand: { op: "present", variable: "a" } } } },
    { kind: "maybe", requirement: { op: "present", variable: "a" } }] }]);
  assert.equal(findings.length, 3);
  assert.match(findings[0], /^x\[0\]\.requirement:/);
  assert.match(findings[1], /negated twice/);
  assert.match(findings[2], /kind/);
});

test("the command checks a file of parses against the set, prints the figures, and refuses what it cannot read by name", async () => {
  const runner = path.join(dir, "criteria_parse_check.mjs");
  const done = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  const report = JSON.parse(done.stdout);
  assert.deepEqual([report.cases, report.casesComplete, report.criteria.expected, report.synthetic], [36, 23, 236, true]);

  const directory = await mkdtemp(path.join(os.tmpdir(), "criteria-parse-"));
  try {
    // A parse that is the labelled structure is perfect; the same command takes any file of parses.
    const perfect = { synthetic: false, parses: Object.fromEntries(set.cases.map((item) => [item.id, item.expected])) };
    await writeFile(path.join(directory, "perfect.json"), JSON.stringify(perfect));
    const out = path.join(directory, "report.json");
    const ran = spawnSync(process.execPath, [runner, "--parses", path.join(directory, "perfect.json"), "--out", out], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const perfectReport = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual([perfectReport.casesComplete, perfectReport.percent, perfectReport.synthetic], [36, { missed: 0, malformedOfFound: 0, logicCorrect: 100 }, false]);

    await writeFile(path.join(directory, "bad.json"), "{}");
    const refused = spawnSync(process.execPath, [runner, "--parses", path.join(directory, "bad.json")], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /parses/);
    assert.equal(refused.stdout, "", "nothing that looks like a result was printed");
    const missing = spawnSync(process.execPath, [runner, "--parses", path.join(directory, "nope.json")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /not readable JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
