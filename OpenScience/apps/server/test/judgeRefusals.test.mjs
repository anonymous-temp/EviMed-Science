// A site's circuit and its `failed` series answer one question: is the provider failing? A request the control plane
// refused to send, or that the account cannot pay for, says nothing about that, and used to answer it anyway: three
// manuscripts over Jev's ceiling opened J8's circuit for every other user, and one account's exhausted module budget
// (`usage_module_budget_exceeded`, 402) did the same and fed the JevFailing alert.
import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "node:http";
import { once } from "node:events";

import * as jevModel from "../src/jevModel.mjs";
import { createJudgeGatewayHandler } from "../src/judgeGateway.mjs";
import { createJudgeService } from "../src/judgeService.mjs";
import { issueEngineModelToken } from "../src/modelGatewayEngineTokens.mjs";
import { HttpError } from "../src/security.mjs";
import { reviewDeliveredRegister } from "../src/reportRegisterJudge.mjs";

const { JevError } = jevModel;
const config = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", reviewJevSupportConfidence: 0.8 };
const answerOf = (question, selected) => {
  const keys = Object.keys(question.criteria);
  return { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])) };
};
/** An answering provider: the last option of every question. */
const answering = async (_deps, call) => ({
  model: config.reviewJevModel, cost: 0.01,
  answers: Object.fromEntries(Object.entries(call.questions).map(([id, question]) => [id, answerOf(question, Object.keys(question.criteria).at(-1))])),
});
const manuscript = { manuscript: "A trial.", criteria: [{ id: "a", text: "Randomised" }] };
const requestCount = (service, site, outcome) => service.requestMetrics().find((row) => row.site === site && row.outcome === outcome)?.value ?? 0;

test("requests over Jev's ceiling are their own outcome: no circuit, no failure", async () => {
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw new JevError("jev_request_too_large", "too large"); } });
  for (let i = 0; i < 5; i += 1) {
    const result = await service.judge("J8", manuscript, { userId: `u${i}`, projectId: "p" });
    assert.equal(result.outcome, "fallback");
    assert.equal(result.code, "judge_request_too_large", `call ${i}`);
    assert.equal(result.cause, "jev_request_too_large");
  }
  assert.equal(requestCount(service, "J8", "refused"), 5);
  assert.equal(requestCount(service, "J8", "failed"), 0, "the series JevFailing reads stays clear");
  // The same site, another user, a request that fits: the circuit never opened.
  const healthy = createJudgeService({ calibrationMode: true, config, callImpl: answering });
  assert.equal((await healthy.judge("J8", manuscript)).outcome, "settled");
  await service.close();
  await healthy.close();
});

test("an exhausted budget is a refusal of that account, not a provider failure", async () => {
  for (const code of ["usage_module_budget_exceeded", "usage_budget_exceeded"]) {
    const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw new HttpError(402, code, "refused"); } });
    for (let i = 0; i < 4; i += 1) assert.equal((await service.judge("J14", { left: "A", right: "B" })).code, "judge_budget_exceeded", code);
    assert.equal(requestCount(service, "J14", "refused"), 4);
    assert.equal(requestCount(service, "J14", "failed"), 0);
    await service.close();
  }
});

test("other ledger refusals and a missing pin are refusals too, and name what refused", async () => {
  for (const [error, code] of [
    [new JevError("usage_ledger_unavailable", "no ledger"), "judge_ledger_refused"],
    [new HttpError(409, "usage_reservation_conflict", "conflict"), "judge_ledger_refused"],
    [new JevError("jev_unconfigured", "no pin"), "judge_unconfigured"],
  ]) {
    const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw error; } });
    for (let i = 0; i < 4; i += 1) assert.equal((await service.judge("J4", { line: "x" })).code, code);
    assert.equal(requestCount(service, "J4", "failed"), 0);
    await service.close();
  }
  for (const failure of [new JevError("jev_upstream_error", "5xx", { status: 502 }), new JevError("jev_auth_failed", "401", { status: 401 }),
    new JevError("jev_payment_required", "402", { status: 402 }), new JevError("jev_unreachable", "down"), new JevError("jev_response_invalid", "bad"),
    new Error("plain")]) {
    assert.equal(jevModel.requestRefusalCode(failure), null, `${failure.code ?? failure.message} is the provider's, not a refusal`);
  }
});

test("provider failures still open the circuit and count as failed; a refusal between them neither advances nor resets it", async () => {
  /** @type {Array<() => never>} */
  const script = [
    () => { throw new JevError("jev_upstream_error", "5xx", { status: 503, retryable: true }); },
    () => { throw new JevError("jev_unreachable", "down"); },
    () => { throw new JevError("jev_request_too_large", "too large"); },
    () => { throw new HttpError(402, "usage_module_budget_exceeded", "spent"); },
    () => { throw new JevError("jev_upstream_error", "5xx", { status: 503, retryable: true }); },
  ];
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => script.shift()() });
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await service.judge("J3", { question: "q", capabilities: [{ id: "a", title: "A" }] })).code);
  assert.deepEqual(codes, ["judge_provider_failure", "judge_provider_failure", "judge_request_too_large", "judge_budget_exceeded", "judge_provider_failure"]);
  assert.equal(requestCount(service, "J3", "failed"), 3);
  assert.equal(requestCount(service, "J3", "refused"), 2);
  assert.equal((await service.judge("J3", { question: "q", capabilities: [{ id: "a", title: "A" }] })).code, "judge_circuit_open", "three provider failures opened it");
  await service.close();
});

test("a failure keeps the Jev client's own code for a caller that reports it", async () => {
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw new JevError("jev_payment_required", "402", { status: 402 }); } });
  const result = await service.judge("J4", { line: "x" });
  assert.equal(result.code, "judge_provider_failure");
  assert.equal(result.cause, "jev_payment_required");
  const plain = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw new Error("socket hang up"); } });
  assert.equal("cause" in await plain.judge("J4", { line: "x" }), false, "a message is never a code");
  await service.close();
  await plain.close();
});

test("the register judge stops at the first sign the account cannot pay, instead of asking for every remaining line", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-budget-"));
  try {
    await writeFile(path.join(root, "report.md"), Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n"));
    const calls = [];
    await reviewDeliveredRegister({ project: { id: "p", userId: "u", workspaceDir: root }, run: { id: "r", artifacts: ["report.md"] },
      judgeService: { judge: async (_site, value) => { calls.push(value.line); return { outcome: "fallback", code: "judge_budget_exceeded", value: null }; } },
      onNotices: async () => {} });
    assert.deepEqual(calls, ["Line 1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an engine is told the judge's code, never the Jev client's own failure code", async t => {
  const secret = "test-only-model-gateway-signing-secret-32-bytes";
  const server = createServer(createJudgeGatewayHandler({
    config: { engineModelGatewayEnabled: true, modelGatewaySigningSecret: secret },
    judgeService: { judge: async () => ({ outcome: "fallback", code: "judge_provider_failure", cause: "jev_auth_failed", value: null, answers: { private: "raw" } }) },
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const jwt = issueEngineModelToken({ secret, userId: "user", projectId: "project", kind: "peer-review", jobId: "peer-review-20261010-test", runId: "run", ttlSeconds: 300 }).token;
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", headers: { authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ site: "J8", input: { manuscript: "x", criteria: [] } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, "judge_provider_failure");
  assert.equal("cause" in body, false);
  assert.equal("answers" in body, false);
});
