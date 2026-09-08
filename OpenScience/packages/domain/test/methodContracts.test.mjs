// The two contracts the self-evolution loop delivers against.
//
// The property worth protecting here is not the JSON schema, it is that the
// SKILL.md half is graded by `validateMethodSkill` and by nothing else. The run
// is told to satisfy that function; a second copy of those rules living in the
// registry would be invisible to the run and would look exactly like nothing
// having happened — which is the drift the clinical gate has already paid for
// three times. So one test compares the gate's findings with the function's,
// code for code, rather than trusting that the call is still there.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { METHOD_RELATIONS_ACTIONS, contractKindLabel, runGate } from "../index.mjs";
import { parseSkillFrontmatter, renderMethodSkill, validateMethodSkill } from "../src/methodSkill.mjs";

/** @param {string} text @returns {string} */
const digestOf = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const BASE_DIGEST = digestOf("base");

const METHOD_BODY = [
  "## Purpose",
  "Repair a source-grounded report in place after the evidence gate returns addressable issues.",
  "",
  "## When to Use",
  "A delivered report failed the gate and every issue names a claim and a source.",
  "",
  "## Inputs",
  "The failing report, the accepted source ledger, and the gate verdict.",
  "",
  "## Workflow",
  "1. Read the verdict and group the issues by claim.",
  "2. For each claim, re-open the source span it is bonded to.",
  "3. Edit only the sentences the verdict names.",
  "",
  "## Verification",
  "- Every edited claim still quotes its source verbatim.",
  "- No number changed without sweeping its dependent claims.",
  "",
  "## Constraints",
  "- Never widen a claim's tier to close an issue.",
  "",
  "## Output",
  "The repaired report, resubmitted through evimed_submit_deliverable.",
].join("\n");

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
const methodFrontmatter = (overrides = {}) => ({
  name: "evidence-preserving-report-repair",
  description: "Repairs a source-grounded report in place when the evidence gate returns addressable issues, editing only the sentences the verdict names.",
  whenToUse: "When a delivered report failed the evidence gate with addressable issues.",
  "allowed-tools": "read edit evimed_submit_deliverable",
  license: "internal",
  metadata: {
    role: "functional",
    applies_when: "A previously generated report and an accepted source ledger exist.",
    not_when: "The cited source is unavailable or does not support the requested correction.",
    derived_from: "run:run_1, feedback:evt_1",
    evimed_schema: "method-skill/1",
  },
  ...overrides,
});

/** @param {{frontmatter?: Record<string, unknown>, body?: string}} [overrides] @returns {string} */
const methodSkillText = (overrides = {}) => renderMethodSkill(
  overrides.frontmatter ?? methodFrontmatter(),
  overrides.body ?? METHOD_BODY,
);

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
const candidateJson = (overrides = {}) => ({
  schemaVersion: 1,
  operation: "create",
  baseDigest: null,
  evidence: [{ runId: "run_1", seqRange: [12, 31], quote: "the gate returned three addressable issues" }],
  applicability: "A delivered report failed the evidence gate with addressable issues.",
  counterexamples: ["The cited source is unavailable."],
  risk: { touchesSafety: false, widensTools: false },
  testScenarios: [
    { id: "TS-1", runId: "run_1", situation: "Three claims lost their quotes.", expected: "Each claim regains a verbatim quote." },
    { id: "TS-2", runId: "run_2", situation: "A number moved and its dependants did not.", expected: "The dependent claims are swept." },
    { id: "TS-3", runId: "run_3", situation: "A citation resolves to the wrong source.", expected: "The citation is repointed, not deleted." },
  ],
  ...overrides,
});

const CANDIDATE_OUTPUTS = Object.freeze([
  { path: "SKILL.md", required: true },
  { path: "method-candidate.json", required: true },
  { path: "distillation-notes.md", required: false },
]);

const RELATIONS_OUTPUTS = Object.freeze([
  { path: "method-relations.json", required: true },
  { path: "revision-notes.md", required: false },
]);

/** @param {{skill?: string, candidate?: unknown}} [parts] */
const gateCandidate = (parts = {}) => runGate({
  contractKind: "method-candidate",
  expectedOutputs: CANDIDATE_OUTPUTS,
  files: new Map([
    ["SKILL.md", parts.skill ?? methodSkillText()],
    ["method-candidate.json", JSON.stringify(parts.candidate ?? candidateJson(), null, 2)],
  ]),
});

/** @param {unknown} report */
const gateRelations = (report) => runGate({
  contractKind: "method-relations",
  expectedOutputs: RELATIONS_OUTPUTS,
  files: new Map([["method-relations.json", JSON.stringify(report, null, 2)]]),
});

/** @param {{issues: readonly {code: string}[]}} verdict @returns {string[]} */
const codes = (verdict) => verdict.issues.map((entry) => entry.code).sort();

/* ------------------------------------------------------------ the good cases */

test("a well-formed method candidate is accepted", () => {
  const verdict = gateCandidate();
  assert.deepEqual(verdict.issues, [], verdict.issues.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.errorCode, null);
});

test("no_change is a real answer and is accepted on its reason and its pair alone", () => {
  // The common outcome. A distillation that can only succeed by proposing an
  // edit is one that will invent an edit, so the contract has to let it say no
  // — while still making it say which method it declined to move.
  const verdict = gateCandidate({
    candidate: {
      schemaVersion: 1,
      operation: "no_change",
      targetMethodId: "method:abc",
      baseDigest: BASE_DIGEST,
      reason: "The same recovery step is already in the method on file; this run adds one more observation of it.",
      evidence: [{ runId: "run_9", seqRange: [4, 9], quote: "retried the search with the narrower query" }],
    },
  });
  assert.deepEqual(verdict.issues, [], verdict.issues.map((entry) => entry.message).join("\n"));
});

test("a screen, a decision and a build each satisfy the relations contract on their own fields", () => {
  assert.deepEqual(METHOD_RELATIONS_ACTIONS, ["screen", "decide", "build"]);

  const screen = gateRelations({
    schemaVersion: 1,
    action: "screen",
    screened: {
      selected: [{ group: "g1", methods: ["a-method", "b-method"], reason: "Both describe recovering from a failed retrieval." }],
      rejected: [{ method: "c-method", reason: "Shares only the topic, not an operation." }],
    },
  });
  assert.deepEqual(screen.issues, [], screen.issues.map((entry) => entry.message).join("\n"));

  const decide = gateRelations({
    schemaVersion: 1,
    action: "decide",
    assignments: [{
      ASSIGNMENT: "A1",
      SKILLS: ["a-method", "b-method"],
      RELATION_TYPE: "shared_part",
      REASON: "Both re-issue the narrowed query and re-check the ledger in the same three steps.",
    }],
  });
  assert.deepEqual(decide.issues, [], decide.issues.map((entry) => entry.message).join("\n"));

  const build = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{
      ASSIGNMENT: "A1",
      SKILLS: ["a-method", "b-method"],
      RELATION_TYPE: "shared_part",
      REASON: "Both re-issue the narrowed query and re-check the ledger in the same three steps.",
    }],
    revisions: [{
      assignment: "A1",
      methodId: "method:a",
      name: "evidence-preserving-report-repair",
      operation: "amend",
      baseDigest: BASE_DIGEST,
      skill: methodSkillText(),
    }],
  });
  assert.deepEqual(build.issues, [], build.issues.map((entry) => entry.message).join("\n"));
});

/* ------------------------------------------ the SKILL.md is graded once, elsewhere */

test("a candidate whose SKILL.md breaks a method rule comes back with that rule's own code", () => {
  const withoutVerification = METHOD_BODY.split("\n## Verification")[0] + "\n## Output\nThe repaired report.\n";
  const verdict = gateCandidate({ skill: methodSkillText({ body: withoutVerification }) });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.issues.some((entry) => entry.code === "method_body_section_missing" && entry.path === "SKILL.md"),
    `expected method_body_section_missing, got ${codes(verdict).join(", ")}`,
  );

  const named = gateCandidate({ skill: methodSkillText({ frontmatter: methodFrontmatter({ name: "Not-Kebab-Case" }) }) });
  assert.ok(named.issues.some((entry) => entry.code === "method_name_shape"));

  const unprovenanced = methodFrontmatter();
  delete /** @type {Record<string, unknown>} */ (unprovenanced.metadata).derived_from;
  const anonymous = gateCandidate({ skill: methodSkillText({ frontmatter: unprovenanced }) });
  assert.ok(
    anonymous.issues.some((entry) => entry.code === "method_derived_from_missing"),
    "a candidate must name the run it was learned from, or nobody can audit it back",
  );
});

test("the gate's method findings are validateMethodSkill's findings, code for code", () => {
  // Not "the gate also rejects it" — the same codes, in the same set. A second
  // implementation would pass that weaker assertion for months.
  const broken = methodSkillText({
    frontmatter: methodFrontmatter({ name: "--bad--name--", "allowed-tools": "read no_such_tool" }),
    body: "## Purpose\nA body missing almost every section.\n",
  });
  const parsed = parseSkillFrontmatter(broken);
  const direct = validateMethodSkill({ frontmatter: parsed.frontmatter, body: parsed.body, requireProvenance: true });
  const throughGate = gateCandidate({ skill: broken });

  assert.ok(direct.issues.length > 3, "the probe is meant to break several rules at once");
  assert.deepEqual(
    throughGate.issues.filter((entry) => entry.check === "method-skill-rules").map((entry) => entry.code).sort(),
    direct.issues.map((entry) => entry.code).sort(),
  );
});

test("a rewritten method inside a build is graded as the method it will become", () => {
  const verdict = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "subset", REASON: "The wider one repeats the narrower one's three steps." }],
    revisions: [{
      assignment: "A1",
      name: "a-different-directory",
      operation: "amend",
      baseDigest: BASE_DIGEST,
      skill: methodSkillText(),
    }],
  });
  assert.ok(
    verdict.issues.some((entry) => entry.code === "method_name_directory_mismatch"),
    `a rewrite whose frontmatter name is not the method it claims to revise: ${codes(verdict).join(", ")}`,
  );
  assert.ok(verdict.issues.every((entry) => entry.severity === "required"));
});

/* --------------------------------------------------- the proposer is not the judge */

test("a candidate cannot approve itself or carry a verdict of its own", () => {
  const approved = gateCandidate({ candidate: candidateJson({ status: "approved" }) });
  assert.equal(approved.ok, false);
  assert.ok(approved.issues.some((entry) => entry.message.includes('status may only be "candidate"')));

  const selfEvaluated = gateCandidate({
    candidate: candidateJson({ evaluations: [{ report: "evals/method-quality/reports/1.json", verdict: "better" }] }),
  });
  assert.equal(selfEvaluated.ok, false);
  assert.ok(selfEvaluated.issues.some((entry) => entry.message.includes("evaluation verdict")));

  assert.deepEqual(gateCandidate({ candidate: candidateJson({ status: "candidate" }) }).issues, []);
});

/* ------------------------------------------------------------- the JSON schemas */

test("an operation that edits a method must name it and pin the revision it edited", () => {
  const amend = gateCandidate({ candidate: candidateJson({ operation: "amend" }) });
  assert.ok(amend.issues.some((entry) => entry.message.includes("targetMethodId")));
  assert.ok(amend.issues.some((entry) => entry.message.includes("baseDigest")));

  const merge = gateCandidate({
    candidate: candidateJson({ operation: "merge", targetMethodId: "method:a", baseDigest: BASE_DIGEST, mergedMethodIds: ["method:a"] }),
  });
  assert.ok(merge.issues.some((entry) => entry.message.includes("mergedMethodIds")), "a merge of one method is an amend");

  const created = gateCandidate({ candidate: candidateJson({ baseDigest: BASE_DIGEST }) });
  assert.ok(created.issues.some((entry) => entry.message.includes("create has no base revision")));

  const halfPaired = gateCandidate({
    candidate: { schemaVersion: 1, operation: "no_change", targetMethodId: "method:a", baseDigest: null, reason: "Already covered.", evidence: [] },
  });
  assert.ok(halfPaired.issues.some((entry) => entry.message.includes("together or neither")));
});

test("evidence is a located quote, and a proposal that cites none is refused", () => {
  const paraphrased = gateCandidate({ candidate: candidateJson({ evidence: [{ runId: "run_1", seqRange: [12, 31] }] }) });
  assert.ok(paraphrased.issues.some((entry) => entry.message.includes("verbatim quote")));

  const unlocated = gateCandidate({ candidate: candidateJson({ evidence: [{ runId: "run_1", seqRange: [31, 12], quote: "x" }] }) });
  assert.ok(unlocated.issues.some((entry) => entry.message.includes("seqRange")));

  const empty = gateCandidate({ candidate: candidateJson({ evidence: [] }) });
  assert.ok(empty.issues.some((entry) => entry.message.includes("rests on nothing")));

  const untested = gateCandidate({ candidate: candidateJson({ testScenarios: [{ id: "TS-1", runId: "run_1", situation: "s", expected: "e" }] }) });
  assert.ok(untested.issues.some((entry) => entry.message.includes("testScenarios[] has 1 entries")));
});

test("the analyser's four fields are required, and an abstract pattern needs three peers", () => {
  const missingFields = gateRelations({
    schemaVersion: 1,
    action: "decide",
    assignments: [{ SKILLS: ["a-method"], RELATION_TYPE: "no_such_relation" }],
  });
  const messages = missingFields.issues.map((entry) => entry.message).join("\n");
  assert.match(messages, /ASSIGNMENT identifier/);
  assert.match(messages, /RELATION_TYPE/);
  assert.match(messages, /SKILLS/);
  assert.match(messages, /REASON/);

  const twoPeers = gateRelations({
    schemaVersion: 1,
    action: "decide",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "abstract_pattern", REASON: "Both plan then verify." }],
  });
  assert.ok(
    twoPeers.issues.some((entry) => entry.message.includes("at least 3")),
    "two methods that resemble each other are a merge or a subset, not a pattern over peers",
  );
});

test("a build carries out the assignment it was given and rewrites nothing a conflict was found in", () => {
  const invented = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "merge", REASON: "One method written twice." }],
    revisions: [{ assignment: "A2", name: "evidence-preserving-report-repair", operation: "amend", baseDigest: BASE_DIGEST, skill: methodSkillText() }],
  });
  assert.ok(invented.issues.some((entry) => entry.message.includes("authoritative")));

  const rewroteAConflict = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "conflicts_with", REASON: "Opposite instructions in the same situation." }],
    notices: [{ assignment: "A1", kind: "conflict", message: "The researcher decides." }],
    revisions: [{ assignment: "A1", name: "evidence-preserving-report-repair", operation: "amend", baseDigest: BASE_DIGEST, skill: methodSkillText() }],
  });
  assert.ok(rewroteAConflict.issues.some((entry) => entry.message.includes("conflicts_with")));

  const silentConflict = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "conflicts_with", REASON: "Opposite instructions in the same situation." }],
    revisions: [],
  });
  assert.ok(
    silentConflict.issues.some((entry) => entry.message.includes("carries no notice")),
    "a conflict nobody is told about is a conflict that stays in the library",
  );

  const orphanedRetirement = gateRelations({
    schemaVersion: 1,
    action: "build",
    assignments: [{ ASSIGNMENT: "A1", SKILLS: ["a-method", "b-method"], RELATION_TYPE: "merge", REASON: "One method written twice." }],
    revisions: [{ assignment: "A1", name: "a-method", operation: "retire", baseDigest: BASE_DIGEST }],
  });
  assert.ok(orphanedRetirement.issues.some((entry) => entry.message.includes("forwarding address")));
});

test("an unreadable or absent deliverable is reported as itself, not as a content failure", () => {
  const unparsable = runGate({
    contractKind: "method-candidate",
    expectedOutputs: CANDIDATE_OUTPUTS,
    files: new Map([["SKILL.md", methodSkillText()], ["method-candidate.json", "{ not json"]]),
  });
  assert.ok(unparsable.issues.some((entry) => entry.message.includes("is not valid JSON")));

  const absent = runGate({ contractKind: "method-relations", expectedOutputs: RELATIONS_OUTPUTS, files: new Map() });
  assert.equal(absent.ok, false);
  assert.ok(absent.issues.every((entry) => entry.code === "required_output_missing"));
});

test("both kinds carry a Chinese label, because a run's inbox names them", () => {
  assert.equal(contractKindLabel("method-candidate"), "方法候选");
  assert.equal(contractKindLabel("method-relations"), "方法关系");
});
