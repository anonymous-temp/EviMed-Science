import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createResultReuseRoutes } from "../src/resultReuseRoutes.mjs";
import { assertCandidate, assertNumerical, assertSuccessor, assertStaging, promptProof, REVISION_JOURNEYS } from "../../../scripts/ops/result-revision-acceptance.mjs";

test("hosted acceptance refuses an old or untracked release before dispatch", () => {
  const revision = "a".repeat(40);
  const manifest = { source: { revision }, app: { releaseId: "candidate" }, runtime: { image: "candidate-runtime", imageId: `sha256:${"c".repeat(64)}` }, services: [{ name: "result-replay", image: "candidate-replay", imageId: `sha256:${"d".repeat(64)}` }] };
  const health = { releaseId: "candidate" };
  const ready = { ok: true, checks: { release: { ok: true, releaseId: "candidate", revision: revision.slice(0, 12) } } };
  assertCandidate(manifest, health, ready, revision);
  assert.throws(() => assertCandidate(manifest, { releaseId: "old" }, ready, revision), /different release/);
  assert.throws(() => assertCandidate(manifest, health, { ...ready, checks: { release: { ok: false } } }, revision), /unavailable/);
  assert.throws(() => assertCandidate(manifest, health, ready, "b".repeat(40)), /requested candidate/);
  assert.throws(() => assertCandidate({ ...manifest, services: [] }, health, ready, revision), /replay service/);
  assert.throws(() => assertCandidate({ ...manifest, runtime: { image: "mutable-tag" } }, health, ready, revision), /runtime image/);
});
test("the actual prompt envelope is distinct from staging and unrelated native frames", () => {
  const payload = { args: { request: { sessionId: "session", requestId: "request", content: [{ type: "text", text: "Bound draft + actual instruction" }], evimedResultRevision: { referenceId: "rr_bound" } } } };
  const mux = promptProof({ type: "open", endpoint: "session/prompt", payload });
  const http = promptProof({ type: "client-request", method: "session/prompt", payload });
  assert.deepEqual(http, mux); assert.equal(mux.referenceId, "rr_bound");
  assert.equal(mux.instructionDigest.length, 64);
  assert.equal(promptProof({ type: "open", endpoint: "session/page", payload }), null);
  assert.equal(promptProof({ referenceId: "rr_bound", draft: "unsent" }), null);
});
test("the acceptance staging check consumes the actual route's 201 contract and refuses a retargeted digest", async () => {
  const versionId = `rv_${"a".repeat(64)}`;
  const stage = { referenceId: `rr_${"b".repeat(64)}`, sessionId: "session", draft: "修改要求：" };
  const input = { projectId: "project", digest: "original-digest", anchor: { kind: "rendered-element", elementKind: "text" } };
  const route = createResultReuseRoutes({ exporter: null, revisions: { stage: async () => stage }, store: { ensureSessionUser: async () => ({ user: { id: "test" } }), assertCsrf: async () => {} } });
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  request.url = `/api/results/${versionId}/revisions`; request.method = "POST";
  let status; let body;
  assert.equal(await route(request, { writeHead(value) { status = value; }, end(bytes) { body = JSON.parse(bytes); } }), true);
  assert.equal(status, 201);
  assertStaging(status, input, body.data, { digest: "original-digest" }, "project", "text");
  assert.throws(() => assertStaging(status, { ...input, digest: "new-digest" }, body.data, { digest: "original-digest" }, "project", "text"));
});
test("empty metadata cannot prove unchanged numerical outputs, while actual method values can", () => {
  const before = { code: { id: "meta.dl" }, machineValues: [{ key: "values.pooled_effect", value: 4 / 3, unit: "effect" }] };
  assertNumerical(before, structuredClone(before), "identical");
  assert.throws(() => assertNumerical({ ...before, machineValues: [] }, before, "identical"), /empty figure/);
  assert.throws(() => assertNumerical(before, { ...before, machineValues: [{ key: "values.pooled_effect", value: 4 / 3, unit: "other" }] }, "identical"));
  assert.throws(() => assertNumerical(before, { ...before, code: { id: "fake" } }, "identical"));
});
test("add-study acceptance checks an independently known four-study estimate", () => {
  const before = { code: { id: "meta.dl" }, machineValues: [{ key: "values.pooled_effect", value: 4 / 3 }] };
  assertNumerical(before, { ...before, machineValues: [{ key: "values.pooled_effect", value: 1.5 }, { key: "new-study", value: 1 }] }, "changed");
  assert.throws(() => assertNumerical(before, before, "changed"), /did not change/);
  assert.throws(() => assertNumerical(before, { ...before, machineValues: [{ key: "values.pooled_effect", value: 99 }] }, "changed"), /1.5/);
});
test("a filename cannot prove a successor without exact native request ancestry", () => {
  const original = { projectId: "project", versionId: "rv_original", digest: "digest" };
  const prompt = { sessionId: "session", requestId: "request", referenceId: "rr_bound" };
  const run = { id: "run", kernelRequestIds: ["request"] };
  const successor = { projectId: "project", supersedesVersionId: "rv_original", producer: { runId: "run", sessionId: "session" },
    inputs: [{ versionId: "rv_original", digest: "digest" }], path: "artifacts/result-revisions/rr_bound/output/new.md" };
  assertSuccessor(original, successor, run, prompt);
  assert.throws(() => assertSuccessor(original, { ...successor, supersedesVersionId: null }, run, prompt), /ancestry/);
  assert.throws(() => assertSuccessor(original, successor, { ...run, kernelRequestIds: ["another-request"] }, prompt), /submitted native/);
  assert.throws(() => assertSuccessor(original, { ...successor, inputs: [] }, run, prompt));
  assert.equal(REVISION_JOURNEYS.length, 3);
});
test("the acceptance reads the recorded correction: the immutable pair, the kind decided from the bytes, whose words and whose output", async () => {
  const { assertCorrection, assertSettled } = await import("../../../scripts/ops/result-revision-acceptance.mjs");
  const original = { versionId: `rv_${"a".repeat(64)}`, digest: "1".repeat(64) };
  const successor = { versionId: `rv_${"b".repeat(64)}`, digest: "2".repeat(64) };
  const run = { id: "run_2" };
  const entry = (extra = {}, outcome = null) => ({ id: "feedback:1", role: "original", outcome, correction: { original, successor: { ...successor }, kind: "analytic", revisionRunId: "run_2",
    instructionOrigin: "researcher", successorOrigin: "system_generated", adoption: "not_recorded", ...extra } });
  assert.equal(assertCorrection(original, successor, [entry()], { numerical: "changed" }, run).id, "feedback:1");
  assert.throws(() => assertCorrection(original, successor, [entry({ kind: "presentation" })], { numerical: "changed" }, run), /moved the printed numbers/);
  assert.throws(() => assertCorrection(original, successor, [entry()], { numerical: "identical" }, run), /numbers were to stay/);
  assertCorrection(original, successor, [entry({ kind: "presentation" })], { numerical: "identical" }, run);
  assert.throws(() => assertCorrection(original, successor, [], { numerical: "changed" }, run), /no correction was recorded/);
  assert.throws(() => assertCorrection(original, successor, [entry({ adoption: "adopted" })], { numerical: "changed" }, run));
  assert.throws(() => assertCorrection(original, successor, [entry({ successorOrigin: "researcher" })], { numerical: "changed" }, run));
  assert.throws(() => assertCorrection(original, successor, [entry({ original: { ...original, digest: "9".repeat(64) } })], { numerical: "changed" }, run));
  assert.throws(() => assertCorrection(original, successor, [entry({ revisionRunId: "run_9" })], { numerical: "changed" }, run), /names the run/);
  assert.throws(() => assertCorrection(original, successor, [{ ...entry(), role: "successor" }], { numerical: "changed" }, run));
  const settled = entry({}, { status: "settled", outputs: [{ versionId: successor.versionId, path: "o/report.md", role: "successor", consistency: "not_checked" }, { versionId: `rv_${"c".repeat(64)}`, path: "o/report.docx", role: "rendering", consistency: "not_checked" }] });
  assertSettled(settled, successor);
  assert.throws(() => assertSettled(entry(), successor), /not settled/);
  assert.throws(() => assertSettled({ ...settled, outcome: { ...settled.outcome, outputs: settled.outcome.outputs.slice(1) } }, successor), /not among/);
  assert.throws(() => assertSettled({ ...settled, outcome: { ...settled.outcome, outputs: [settled.outcome.outputs[0], { ...settled.outcome.outputs[1], consistency: "consistent" }] } }, successor), /not checked/);
});
