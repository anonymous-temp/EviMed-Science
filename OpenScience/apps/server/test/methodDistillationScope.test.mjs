// A lesson from a correction knows which methods the run read, and keeps the scope it declares (N14).
//
// What these cases are for: a correction lesson used to be handed the transcript of the run whose result was corrected
// and the list of methods on file, and nothing said which of them that run had read, what became of the results it
// produced under each, or what scope each declared. So the distillation could not tell a method that failed from one that
// was never relevant, and `counterexamples` — which the contract requires — were checked and then thrown away. These
// assert that the input carries the join, that the candidate's scope and the pair of result versions it was learnt from
// reach the store, and that a deployment without the join says it does not know instead of saying "none".
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";
import { DISTILLATION_EXTRACTOR_VERSION, MethodDistillationRuns, buildDistillationInput, distillationDispatchId } from "../src/methodDistillationRuns.mjs";

const hex = (character, length = 64) => character.repeat(length);
const version = (n) => `rv_${String(n).padStart(64, "0")}`;

const SKILL = [
  "---", 'name: "quote-first"', 'description: "Quote the source sentence before stating a claim that rests on it."', 'whenToUse: "When a claim rests on a source."',
  "metadata:", '  role: "functional"', '  applies_when: "A claim rests on a source."', '  not_when: "The claim is the analyst\'s own estimate."',
  '  derived_from: "run:run_1"', `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "",
  ["## Purpose", "Quote.", "", "## When to Use", "When a claim rests on a source.", "", "## Inputs", "Evidence.", "", "## Workflow", "1. Quote it.", "",
    "## Verification", "- Quoted.", "", "## Constraints", "- Never paraphrase a dose.", "", "## Output", "The report."].join("\n"), "",
].join("\n");

const EVENT = {
  id: "feedback:result-corrected:abc", trigger: "result-corrected", runId: "run_1",
  detail: { kind: "analytic", original: { versionId: version(1), digest: hex("a"), path: "report.md" }, successor: { versionId: version(2), digest: hex("b"), path: "x/report.md" },
    successorOrigin: "system_generated", adoption: "not_recorded" },
};

function learning(existing = false) {
  const calls = { created: [], amended: [] };
  return { calls,
    async listMethods() { return { items: [] }; },
    async createCandidate(userId, input) { calls.created.push(input); return { id: "method:learned:quote-first", revision: 1 }; },
    async amendMethod(userId, methodId, input) { calls.amended.push({ methodId, ...input }); return { id: methodId, revision: 4 }; },
    async getMethod(_userId, methodId) {
      if (!existing) throw Object.assign(new Error("none"), { code: "method_not_found" });
      return { id: methodId, revision: 3, payload: { dependencies: [] } };
    } };
}
const distiller = (store) => new MethodDistillationRuns({ learning: store, jobs: { async enqueue() { return { id: "j" }; } },
  dispatch: async () => { throw new Error("not used"); }, readResult: async () => { throw new Error("not used"); } });
const lesson = { userId: "u1", projectId: "p1", payload: { trigger: "correction", feedbackEventIds: [EVENT.id], feedback: [EVENT] } };
const candidate = { operation: "create", applicability: "A claim rests on a source.", counterexamples: ["The claim is the analyst's own estimate.", "Fewer than three studies."] };

test("the input says which methods the run read, what became of their results and the scope each declared; the rules changed, so the identity did", () => {
  const input = buildDistillationInput({ run: { id: "run_1", effectiveAgentId: "meta-analysis" }, trigger: "correction", transcript: null, feedback: [EVENT],
    methodsUsed: { invoked: [{ id: "method:learned:quote-first", name: "quote-first", digest: `sha256:${hex("a")}`, scientific: { against: 1, causalBenefit: "unproven" } }],
      handbooks: [], passedOver: [{ id: "method:learned:sweep", name: "sweep" }], unresolved: [{ name: "gone", reason: "method_unavailable" }] },
    relatedMethods: [{ id: "method:learned:quote-first", payload: { status: "approved", contentDigest: `sha256:${hex("a")}`, frontmatter: { name: "quote-first" }, body: "b",
      scope: { applicability: "A claim rests on a source.", counterexamples: ["Fewer than three studies."], digest: `sha256:${hex("a")}` },
      scientific: { entries: [{ id: `sf_${"1".repeat(32)}`, signal: "analytic_corrected", at: "2026-10-04T00:00:00.000Z", digest: `sha256:${hex("a")}`, used: "invoked", runId: "run_1",
        result: { versionId: version(1), digest: hex("a") }, successor: null, replay: null, event: { id: EVENT.id }, kind: "analytic", applicability: { state: "unknown", basis: "none", codes: [] } }] } } },
      { id: "method:learned:plain", payload: { status: "approved", contentDigest: `sha256:${hex("c")}`, frontmatter: { name: "plain" }, body: "p" } }] });
  assert.equal(input.extractorVersion, "5");
  assert.equal(input.methodsUsed.known, true);
  assert.equal(input.methodsUsed.invoked[0].name, "quote-first");
  assert.deepEqual(input.methodsUsed.passedOver.map((item) => item.name), ["sweep"]);
  assert.deepEqual(input.methodsUsed.unresolved, [{ name: "gone", reason: "method_unavailable" }]);
  const [withRecord, plain] = input.relatedMethods;
  assert.deepEqual([withRecord.scientific.against, withRecord.scientific.causalBenefit, withRecord.scientific.applicability], [1, "unproven", "unknown"]);
  assert.deepEqual(withRecord.scope, { applicability: "A claim rests on a source.", counterexamples: ["Fewer than three studies."], current: true });
  assert.equal("scientific" in plain, false, "a method with nothing recorded says nothing, which is not 'nothing happened'");
  assert.equal("scope" in plain, false);
  // A lesson queued under the old rules is a different job from the same lesson under these.
  assert.equal(DISTILLATION_EXTRACTOR_VERSION, "5");
  assert.notEqual(distillationDispatchId("run_1", "correction", EVENT.id), `method-distillation-${"0".repeat(32)}`);
});

test("a deployment that cannot say which methods the run read says it does not know, and that is not an empty list", () => {
  const unknown = buildDistillationInput({ run: { id: "run_1" }, trigger: "correction", transcript: null, feedback: [EVENT] });
  assert.deepEqual(unknown.methodsUsed, { invoked: [], handbooks: [], passedOver: [], unresolved: [], known: false });
  const none = buildDistillationInput({ run: { id: "run_1" }, trigger: "correction", transcript: null, feedback: [EVENT], methodsUsed: { invoked: [], passedOver: [] } });
  assert.equal(none.methodsUsed.known, true);
  const crowded = buildDistillationInput({ run: { id: "run_1" }, trigger: "correction", transcript: null, methodsUsed: {
    invoked: Array.from({ length: 20 }, (_, n) => ({ name: `m${n}` })), passedOver: Array.from({ length: 20 }, (_, n) => ({ name: `p${n}` })) } });
  assert.deepEqual([crowded.methodsUsed.invoked.length, crowded.methodsUsed.passedOver.length], [8, 8]);
});

test("the distillation is handed what the run read, and a lookup that fails costs the lesson nothing but that knowledge", async () => {
  const seen = [];
  const store = learning();
  const withUsed = new MethodDistillationRuns({ learning: store, jobs: null, usedMethods: async (project, run) => { seen.push([project.id, run.id]); return { invoked: [{ name: "quote-first" }] }; },
    dispatch: async (request) => { seen.push(request.input.methodsUsed); throw Object.assign(new Error("stop here"), { code: "stop_here" }); }, readResult: async () => ({}) });
  await assert.rejects(withUsed.execute({ job: { userId: "u1", projectId: "p1", payload: { trigger: "correction" } }, project: { id: "p1", metaDir: "/nonexistent", baseDir: "/nonexistent" }, run: { id: "run_1" }, feedback: [EVENT] }),
    (error) => error.code === "stop_here");
  assert.deepEqual(seen[0], ["p1", "run_1"]);
  assert.equal(seen[1].known, true);
  const failing = [];
  const broken = new MethodDistillationRuns({ learning: learning(), jobs: null, usedMethods: async () => { throw new Error("ledger down"); },
    dispatch: async (request) => { failing.push(request.input.methodsUsed.known); throw Object.assign(new Error("stop here"), { code: "stop_here" }); }, readResult: async () => ({}) });
  await assert.rejects(broken.execute({ job: { userId: "u1", projectId: "p1", payload: { trigger: "correction" } }, project: { id: "p1", metaDir: "/nonexistent", baseDir: "/nonexistent" }, run: { id: "run_1" } }),
    (error) => error.code === "stop_here");
  assert.deepEqual(failing, [false]);
});

test("a correction lesson keeps the candidate's scope and the pair of result versions it was learnt from, by their immutable identities", async () => {
  const store = learning();
  await distiller(store).applyCandidate(lesson, { id: "run_1", effectiveAgentId: "meta-analysis" }, { candidate, skill: SKILL });
  const [created] = store.calls.created;
  assert.deepEqual(created.scope, { applicability: candidate.applicability, counterexamples: candidate.counterexamples });
  assert.deepEqual(created.provenance.results, [{ role: "original", versionId: version(1), digest: hex("a") }, { role: "successor", versionId: version(2), digest: hex("b") }]);
  // Never an adoption: the provenance says what the researcher did and the successor is only named.
  assert.equal(created.provenance.origin, "inferred");
  assert.equal(created.provenance.signal, "researcher");

  const amending = learning(true);
  await distiller(amending).applyCandidate(lesson, { id: "run_1" }, { candidate: { ...candidate, operation: "amend", targetMethodId: "method:learned:quote-first" }, skill: SKILL });
  assert.deepEqual(amending.calls.amended[0].scope, { applicability: candidate.applicability, counterexamples: candidate.counterexamples });
  assert.equal(amending.calls.amended[0].provenance.results.length, 2);
});

test("a lesson with no correction in it names no result versions, and a candidate with no scope declares none", async () => {
  const store = learning();
  await distiller(store).applyCandidate({ userId: "u1", projectId: "p1", payload: { trigger: "delivered" } }, { id: "run_1" }, { candidate: { operation: "create" }, skill: SKILL });
  const [created] = store.calls.created;
  assert.equal("results" in created.provenance, false);
  assert.deepEqual(created.scope, { applicability: undefined, counterexamples: undefined });
  // A malformed event's identifiers are not carried.
  const odd = learning();
  await distiller(odd).applyCandidate({ userId: "u1", projectId: "p1", payload: { trigger: "correction", feedback: [{ trigger: "result-corrected", detail: { original: { versionId: "rv_short" } } }, { trigger: "deliverable-edited" }] } },
    { id: "run_1" }, { candidate: { operation: "create" }, skill: SKILL });
  assert.equal("results" in odd.calls.created[0].provenance, false);
});
