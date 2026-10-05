import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createEvolutionCandidateEvaluator } from "../src/evolutionCandidateEvaluator.mjs";
import { EVOLUTION_STATIC_CHECK } from "../src/evolutionVerification.mjs";
import { BEHAVIOUR_FAMILIES, applyRelation, behaviourPlan, deriveBehaviouralInputs, freshCaseAgrees, genericFreshInput, relationIssues, seededRandom } from "../../../evals/paper-gold/behavioural.mjs";
import { pythonExecVerify } from "./helpers/pythonExecVerify.mjs";

// Synthetic "published" cases for the net-benefit family: the inputs are invented here and the printed
// numbers are the formula's, rounded to four decimals as a paper would print them. No real hidden case.
const INPUTS = [
  { n: 250, truePositive: 45, falsePositive: 60, eventCount: 55, threshold: 0.15 },
  { n: 1200, truePositive: 130, falsePositive: 310, eventCount: 180, threshold: 0.2 },
  { n: 777, truePositive: 90, falsePositive: 120, eventCount: 140, threshold: 0.1 },
];
const formula = BEHAVIOUR_FAMILIES["decision-net-benefit"].reference;
function publishedCase(specification, index, extra = {}) {
  const exact = formula({ specification });
  const numeric = Object.fromEntries(["netBenefit", "treatAll"].map(key => [key, { value: Number(exact[key].toFixed(4)), printed: exact[key].toFixed(4), outputPath: key }]));
  return { id: `case-${index}`, hidden: true, kind: "published", publicationId: `synthetic-paper-${index}`, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { specification }, numeric, ...extra };
}
const HONEST = `def net_benefit(specification):
    n = specification["n"]
    odds = specification["threshold"] / (1 - specification["threshold"])
    prevalence = specification["eventCount"] / n
    # "expected value" is ordinary decision-analysis vocabulary; the old name rule refused this line.
    expected_value_treat = prevalence - (1 - prevalence) * odds
    benefit = (specification["truePositive"] - odds * specification["falsePositive"]) / n
    return {"netBenefit": benefit, "treatAll": expected_value_treat, "treatNone": 0, "netReductionPer100": 100 * (benefit - expected_value_treat) / odds}
`;
/** The reviewer's probe: a dict keyed by the input tuple, holding the printed answers. */
function memorising(cases) {
  const rows = cases.map(item => { const s = item.input.specification; return `    (${s.n}, ${s.truePositive}, ${s.falsePositive}, ${s.eventCount}, ${s.threshold}): {"netBenefit": ${item.numeric.netBenefit.value}, "treatAll": ${item.numeric.treatAll.value}, "treatNone": 0, "netReductionPer100": 0.0},`; });
  return `_TABLE = {\n${rows.join("\n")}\n}\ndef net_benefit(specification):\n    s = specification\n    return _TABLE[(s["n"], s["truePositive"], s["falsePositive"], s["eventCount"], s["threshold"])]\n`;
}
/** A table for the scored inputs with the formula behind it for everything else. */
function tableInFront(cases) { return `${memorising(cases).replace("def net_benefit", "def _recite")}${HONEST.replace("def net_benefit", "def _compute")}def net_benefit(specification):\n    try:\n        return _recite(specification)\n    except KeyError:\n        return _compute(specification)\n`; }
const candidateOf = (source, id = "candidate") => ({ id, entrypoint: "scripts/net_benefit.py:net_benefit", files: { "scripts/net_benefit.py": source } });

async function fixture(t, definition) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "behavioural-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
  await writeFile(path.join(dataDir, `paper-gold/candidate-cases/${definition.methodId}.json`), JSON.stringify(definition));
  const record = { calls: [] };
  let unavailable = () => false;
  const execute = pythonExecVerify(record);
  const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure: async () => ({ tier: "unexposed" }),
    controller: { execVerify: async body => unavailable(body) ? { ok: false, joined: false, executionStarted: false, output: "" } : execute(body) } });
  return { dataDir, record, evaluate: candidate => evaluator.evaluate(candidate, { card: { methodId: definition.methodId } }), setUnavailable: predicate => { unavailable = predicate; } };
}

test("the evaluator's own references reproduce the public development examples of each shipped family", async () => {
  for (const [family, file] of [["cohort-state-transition", "development-contract.json"], ["diagnostic-posterior", "diagnostic-posterior-development.json"], ["decision-net-benefit", "decision-net-benefit-development.json"]]) {
    const contract = JSON.parse(await readFile(new URL(`../../../evals/paper-gold/${file}`, import.meta.url), "utf8"));
    const examples = contract.cases.filter(item => item.expected);
    assert.ok(examples.length >= 2, family);
    for (const example of examples) {
      const reference = BEHAVIOUR_FAMILIES[family].reference(example.input);
      assert.ok(freshCaseAgrees(example.expected, reference), `${family}/${example.id}`);
      // Every relation the family declares holds for its reference on the public example it applies to.
      BEHAVIOUR_FAMILIES[family].relations.forEach((relation, index) => {
        assert.deepEqual(relationIssues(relation), []);
        const applied = applyRelation(relation, example.input, seededRandom(`${family}:${example.id}:${index}`));
        if (!applied) return;
        const unflatten = flat => { const out = {}; for (const [key, value] of Object.entries(flat)) key.split(".").reduce((node, part, at, parts) => (node[part] ??= at === parts.length - 1 ? value : {}), out); return out; };
        assert.equal(applied.check(unflatten(reference), unflatten(BEHAVIOUR_FAMILIES[family].reference(applied.input))), true, `${family}/${example.id}/${relation.kind}`);
      });
      // And a fresh input is a different, still valid, input.
      const fresh = BEHAVIOUR_FAMILIES[family].fresh(example.input, seededRandom(`${family}:fresh`));
      assert.notDeepEqual(fresh, example.input);
      assert.ok(Object.values(BEHAVIOUR_FAMILIES[family].reference(fresh)).every(Number.isFinite));
    }
  }
});

test("derived inputs are deterministic for one candidate and purpose, and different for another", () => {
  const plan = behaviourPlan({ methodId: "decision-net-benefit" });
  const input = { specification: INPUTS[0] };
  const first = deriveBehaviouralInputs(plan, input, "seed-a"), again = deriveBehaviouralInputs(plan, input, "seed-a"), other = deriveBehaviouralInputs(plan, input, "seed-b");
  assert.deepEqual(first.fresh.map(item => item.input), again.fresh.map(item => item.input));
  assert.notDeepEqual(first.fresh.map(item => item.input), other.fresh.map(item => item.input));
  assert.ok(first.relations.length >= 1 && first.fresh.length >= 3);
  assert.equal(behaviourPlan({ methodId: "unknown-method" }).reference, null);
  assert.deepEqual(behaviourPlan({ methodId: "unknown-method", definition: { relations: [{ kind: "invented" }, { kind: "scale", inputs: ["x"], outputs: { y: 1 } }] } }).relations.map(item => item.kind), ["scale"]);
  const jittered = genericFreshInput({ count: 40, rate: 0.25, flag: 1, label: "arm", nested: { dose: 12.5 } }, seededRandom("generic"));
  assert.ok(Number.isInteger(jittered.count) && jittered.count !== 40 && jittered.rate > 0 && jittered.rate < 1 && jittered.rate !== 0.25);
  assert.equal(jittered.flag, 1); assert.equal(jittered.label, "arm"); assert.notEqual(jittered.nested.dose, 12.5);
});

test("the old static scan: a lookup table passed and an honest `expected_value_*` variable was refused", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-name-rule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = INPUTS.slice(0, 2).map((specification, index) => publishedCase(specification, index + 1));
  await writeFile(path.join(root, "honest.py"), HONEST);
  await writeFile(path.join(root, "memorising.py"), memorising(cases));
  const result = spawnSync("python3", ["-c", EVOLUTION_STATIC_CHECK.replaceAll("'/candidate'", JSON.stringify(root))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The static scan no longer pretends to decide this in either direction; behaviour does, below.
  assert.deepEqual(JSON.parse(result.stdout).issues, []);
  assert.doesNotMatch(EVOLUTION_STATIC_CHECK, /expected_value|gold_answer|holdout_answer/);
});

test("a memorising candidate fails the behavioural checks; an honest implementation reaches V2", async t => {
  const cases = INPUTS.slice(0, 2).map((specification, index) => publishedCase(specification, index + 1));
  const f = await fixture(t, { methodId: "decision-net-benefit", frozen: true, cases });

  const honest = await f.evaluate(candidateOf(HONEST, "honest"));
  assert.equal(honest.ok, true, JSON.stringify(honest.behaviour));
  assert.equal(honest.verificationLevel, "V2");
  assert.equal(honest.behaviour.status, "passed");
  assert.ok(honest.behaviour.relationChecks >= 2 && honest.behaviour.freshCases >= 6);
  assert.equal(honest.behaviour.relationFailures + honest.behaviour.freshFailures, 0);
  assert.deepEqual(honest.notices, []);

  const table = await f.evaluate(candidateOf(memorising(cases), "memorising"));
  assert.deepEqual(table.assessments.map(row => row.passed), [true, true, true, true], "the table reproduces every hidden number, twice");
  assert.equal(table.ok, false);
  assert.equal(table.verificationLevel, "V0");
  assert.equal(table.status, "repair");
  assert.deepEqual(table.issueCodes, ["candidate_generalisation_failed"]);
  assert.equal(table.behaviour.status, "failed");
  assert.equal(table.behaviour.relationFailures, table.behaviour.relationChecks);
  assert.equal(table.behaviour.freshFailures, table.behaviour.freshCases);
  // The decidable static fact is kept as a notice (a value match, not a name match) and is not the verdict.
  assert.deepEqual(table.notices, [{ code: "candidate_source_contains_reference_value", path: "scripts/net_benefit.py", count: 4 }]);

  const fronted = await f.evaluate(candidateOf(tableInFront(cases), "table-in-front"));
  assert.equal(fronted.assessments.every(row => row.passed), true);
  assert.equal(fronted.ok, false, "printed answers recited for the scored inputs do not satisfy a relation the formula satisfies");
  assert.equal(fronted.behaviour.status, "failed");
  assert.ok(fronted.behaviour.relationFailures > 0);
  assert.equal(fronted.behaviour.freshFailures, 0, "its fresh answers are computed, and right");

  // Nothing derived, expected or measured reaches the builder through the result.
  assert.doesNotMatch(JSON.stringify({ ...table, assessments: undefined }), /0\.1376|"numeric"|absoluteTolerance|printed|"input"/);
  // The hidden numbers never enter a candidate execution; derived inputs do, and differ per candidate.
  const candidateCalls = f.record.calls.filter(call => Object.keys(call.files).length > 0);
  assert.ok(candidateCalls.every(call => !/0\.1376|printed|absoluteTolerance/.test(JSON.stringify(call.input) + (call.code.includes("_TABLE") ? "" : call.code))));
  const batches = f.record.calls.filter(call => Array.isArray(call.input?.batch));
  assert.equal(batches.length, 6);
  assert.notDeepEqual(batches[0].input.batch.slice(1), batches[2].input.batch.slice(1), "another candidate meets other derived inputs");
});

test("a method with nothing to derive behaviour from is not promoted", async t => {
  const cases = [3, 5].map(x => ({ id: `opaque-${x}`, hidden: true, kind: "published", publicationId: `paper-${x}`, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { x }, numeric: { value: { value: x * 2, absoluteTolerance: 0 } } }));
  const candidate = { id: "doubler", entrypoint: "scripts/estimate.py:estimate", files: { "scripts/estimate.py": "def estimate(x):\n    return {'value': 2 * x}\n" } };
  const bare = await fixture(t, { methodId: "bare-method", frozen: true, cases });
  const unsupported = await bare.evaluate(candidate);
  assert.equal(unsupported.assessments.every(row => row.passed), true);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, "waiting_resource");
  assert.equal(unsupported.resourceCode, "behavioural_checks_unavailable");
  assert.equal(unsupported.behaviour.status, "unavailable");
  // With an executable reference frozen beside the cases, fresh cases exist and the same candidate passes.
  const referenceImplementation = { implementationId: "fixture-reference", language: "python", code: "import json,sys\nprint(json.dumps({'numeric':{'value':2*json.load(sys.stdin)['x']}}))\n" };
  const referenced = await fixture(t, { methodId: "referenced-method", frozen: true, cases, referenceImplementation });
  const passed = await referenced.evaluate(candidate);
  assert.equal(passed.ok, true, JSON.stringify(passed.behaviour));
  assert.equal(passed.behaviour.referenceImplementation, "fixture-reference");
  assert.ok(passed.behaviour.freshCases >= 6);
  const recited = await referenced.evaluate({ ...candidate, id: "reciter", files: { "scripts/estimate.py": "def estimate(x):\n    return {'value': {3: 6, 5: 10}[x]}\n" } });
  assert.equal(recited.ok, false);
  assert.equal(recited.behaviour.freshFailures, recited.behaviour.freshCases);
  // A reference that does not reproduce the published numbers of a case cannot referee fresh ones for it.
  const wrongReference = await fixture(t, { methodId: "wrong-reference", frozen: true, cases, referenceImplementation: { ...referenceImplementation, code: referenceImplementation.code.replace("2*", "3*") } });
  const refused = await wrongReference.evaluate(candidate);
  assert.equal(refused.ok, false);
  assert.equal(refused.behaviour.status, "unavailable");
  assert.ok(refused.behaviour.cases.every(row => row.reference === "disagrees-with-published"));
});

test("sudden-perfect review runs reserved cases and fresh inputs; it is never the same evaluation again", async t => {
  const cases = [publishedCase(INPUTS[0], 1), publishedCase(INPUTS[1], 2), publishedCase(INPUTS[2], 3, { reserve: true })];
  const f = await fixture(t, { methodId: "decision-net-benefit", frozen: true, cases });
  const WRONG = HONEST.replace("/ n\n    return", "/ n + 1\n    return");
  // Correct everywhere the ordinary evaluation looks, and wrong on the reserved case's input.
  const NARROW = HONEST.replace("    return {", "    if n == 777:\n        benefit = benefit + 0.01\n    return {");

  const failed = await f.evaluate(candidateOf(WRONG, "wrong"));
  assert.equal(failed.status, "repair");
  assert.deepEqual(failed.failedCaseIds, ["case-1", "case-2"], "the reserved case is not run, so no repair round learns about it");
  assert.equal(failed.assessments.some(row => row.caseId === "case-3"), false);

  const narrow = await f.evaluate(candidateOf(NARROW, "narrow"));
  assert.equal(narrow.assessments.every(row => row.passed), true);
  assert.equal(narrow.behaviour.status, "passed", "the ordinary evaluation cannot see the defect");
  assert.equal(narrow.suddenPerfectReview.triggered, true);
  assert.equal(narrow.suddenPerfectReview.passed, false);
  assert.equal(narrow.suddenPerfectReview.status, "repair");
  assert.deepEqual({ reserved: narrow.suddenPerfectReview.heldOut.reservedCases, failed: narrow.suddenPerfectReview.heldOut.reservedFailures }, { reserved: 1, failed: 1 });
  assert.equal(narrow.ok, false); assert.equal(narrow.verificationLevel, "V0");
  assert.equal(narrow.resourceCode, "sudden_perfect_review_not_passed");

  const honest = await f.evaluate(candidateOf(HONEST, "honest"));
  assert.equal(honest.ok, true, JSON.stringify(honest.suddenPerfectReview));
  assert.equal(honest.suddenPerfectReview.passed, true);
  assert.equal(honest.suddenPerfectReview.heldOut.reservedCases, 1);
  assert.ok(honest.suddenPerfectReview.heldOut.freshCases >= 9, "fresh cases for every admitted case, drawn under the review's seed");
  const reviews = path.join(f.dataDir, "paper-gold/sudden-perfect-reviews");
  const sealed = (await readdir(reviews)).filter(file => !file.endsWith(".queued.json"));
  assert.equal(sealed.length, 2);
  const records = await Promise.all(sealed.map(async file => JSON.parse(await readFile(path.join(reviews, file), "utf8")).receipt));
  const passedRecord = records.find(row => row.passed === true);
  assert.equal(passedRecord.purpose, "sudden-perfect-held-out-review");
  assert.deepEqual(passedRecord.reviewChecks, { frozenEvidenceAndEvaluatorUnchanged: true, candidateCodeAndContractUnchanged: true, exposureUnexposed: true, reservedCasesPassed: true, behaviouralChecksPassed: true });
  // The review's derived inputs are not the ordinary evaluation's.
  const honestBatches = f.record.calls.filter(call => Array.isArray(call.input?.batch) && call.files["scripts/net_benefit.py"] === HONEST);
  const ordinary = honestBatches.slice(0, 2).flatMap(call => call.input.batch.slice(1)), review = honestBatches.slice(2).flatMap(call => call.input.batch.slice(1));
  assert.ok(ordinary.length > 0 && review.length > 0);
  assert.equal(review.some(input => ordinary.some(seen => JSON.stringify(seen) === JSON.stringify(input))), false);
  // Asking again resumes the sealed record instead of reviewing twice.
  const repeated = await f.evaluate(candidateOf(HONEST, "honest"));
  assert.equal(repeated.suddenPerfectReview.resumed, true);
  assert.equal(repeated.suddenPerfectReview.reviewId, honest.suddenPerfectReview.reviewId);
  assert.doesNotMatch(JSON.stringify(honest.suddenPerfectReview), /numeric|tolerance|publicationId|"input"/);
});

test("with nothing held out the record says the review could not be done, and nothing is promoted on it", async t => {
  // Relations only: no executable reference and no reserved case, so no case the candidate was never scored on.
  const cases = [3, 5].map(x => ({ id: `opaque-${x}`, hidden: true, kind: "published", publicationId: `paper-${x}`, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { x, unit: 1 }, numeric: { value: { value: x * 2, absoluteTolerance: 0 } } }));
  const f = await fixture(t, { methodId: "relations-only", frozen: true, cases, relations: [{ kind: "scale", inputs: ["x"], outputs: { value: 1 } }] });
  const source = wrong => `def estimate(x, unit):\n    return {'value': ${wrong ? 3 : 2} * x}\n`;
  const candidate = wrong => ({ id: wrong ? "wrong" : "right", entrypoint: "scripts/estimate.py:estimate", files: { "scripts/estimate.py": source(wrong) } });
  assert.equal((await f.evaluate(candidate(true))).status, "repair");
  const result = await f.evaluate(candidate(false));
  assert.equal(result.behaviour.status, "passed");
  assert.equal(result.suddenPerfectReview.triggered, true);
  assert.equal(result.suddenPerfectReview.passed, null);
  assert.equal(result.suddenPerfectReview.status, "not-performed");
  assert.equal(result.ok, false);
  assert.equal(result.verificationLevel, "V0");
  assert.equal(result.status, "waiting_resource");
  assert.equal(result.resourceCode, "sudden_perfect_review_not_performed");
  const reviews = path.join(f.dataDir, "paper-gold/sudden-perfect-reviews");
  const [file] = (await readdir(reviews)).filter(name => !name.endsWith(".queued.json"));
  const record = JSON.parse(await readFile(path.join(reviews, file), "utf8")).receipt;
  assert.equal(record.passed, null); assert.equal(record.reason, "no_held_out_cases");
  assert.deepEqual({ reserved: record.reviewChecks.reservedCasesPassed, heldOut: record.heldOut.reservedCases + record.heldOut.freshCases }, { reserved: null, heldOut: 0 });
});

test("a review whose executions did not happen stays queued and is completed later", async t => {
  const cases = [publishedCase(INPUTS[0], 1), publishedCase(INPUTS[1], 2), publishedCase(INPUTS[2], 3, { reserve: true })];
  const f = await fixture(t, { methodId: "decision-net-benefit", frozen: true, cases });
  await f.evaluate(candidateOf(HONEST.replace("/ n\n    return", "/ n + 1\n    return"), "wrong"));
  // The ordinary evaluation completes; the controller then does not answer for the reserved case, which only the review runs.
  f.setUnavailable(body => JSON.stringify(body.input).includes('"n":777'));
  const honest = candidateOf(HONEST, "honest");
  const pending = await f.evaluate(honest);
  assert.equal(pending.behaviour.status, "passed");
  assert.equal(pending.suddenPerfectReview.status, "pending");
  assert.equal(pending.ok, false); assert.equal(pending.status, "waiting_resource");
  const reviews = path.join(f.dataDir, "paper-gold/sudden-perfect-reviews");
  assert.equal((await readdir(reviews)).filter(name => !name.endsWith(".queued.json")).length, 0, "an unobserved review is not a completed one");
  f.setUnavailable(() => false);
  const completed = await f.evaluate(honest);
  assert.equal(completed.ok, true, JSON.stringify(completed.suddenPerfectReview));
  assert.equal(completed.suddenPerfectReview.passed, true);
});
