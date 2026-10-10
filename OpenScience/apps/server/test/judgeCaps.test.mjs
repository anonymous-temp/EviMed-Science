// Three sides hold a cap on what a site is sent: the client that builds the request, the registry that bounds the
// state it will read, and the gateway that bounds the body it will take off the wire. Where they disagreed, a request
// travelled to be refused at the far end (J2 above 51 projects; a meta-evidence full text over 30,000 characters; a
// J8 manuscript the Python guard lets out at 100,000 bytes but the gateway stopped at 128 KiB).
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ChannelIntentClassifier } from "../src/channels/intent.mjs";
import * as gatewayModule from "../src/judgeGateway.mjs";
import * as sitesModule from "../src/judgeSites.mjs";
import { createJudgeService } from "../src/judgeService.mjs";
import { issueEngineModelToken } from "../src/modelGatewayEngineTokens.mjs";

const { createJudgeGatewayHandler } = gatewayModule;
const { buildJudgeRequest } = sitesModule;
// Named by the code under test; the fallbacks are what the code held before they were named, so the behaviour is what fails first.
const JUDGE_J2_MAX_PROJECTS = /** @type {any} */ (sitesModule).JUDGE_J2_MAX_PROJECTS ?? 51;
const JUDGE_STATE_MAX_CHARS = /** @type {any} */ (sitesModule).JUDGE_STATE_MAX_CHARS ?? 256_000;
const JUDGE_GATEWAY_MAX_BODY_BYTES = /** @type {any} */ (gatewayModule).JUDGE_GATEWAY_MAX_BODY_BYTES ?? 128 * 1024;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const config = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", reviewJevSupportConfidence: 0.8 };
const projectsOf = (/** @type {number} */ count) => Array.from({ length: count }, (_, i) => ({ id: `project-${i + 1}`, name: `项目 ${i + 1}`, lastActivityAt: null }));

test("J2 is offered no more projects than it reads, the same projects the original classifier is shown", async () => {
  /** @type {any[]} */
  const judged = [];
  /** @type {any[]} */
  const original = [];
  const classifier = new ChannelIntentClassifier({ deepseekProviderEnabled: true, deepseekApiKey: "sk-test", modelGatewayTimeoutMs: 30_000 }, {
    judgeService: { judge: async (_site, input) => { judged.push(input); return { outcome: "settled", value: { switch_to: null, has_request: true, continues_running_task: false } }; } },
    callModel: async (_deps, call) => { original.push(JSON.parse(call.body.messages[1].content)); return { choices: [{ message: { content: JSON.stringify({ switch_to: null, has_request: true, continues_running_task: false }) } }] }; },
  });
  const projects = projectsOf(JUDGE_J2_MAX_PROJECTS + 9);
  const intent = await classifier.classify({ userId: "u", projectId: "project-1", text: "把这个对话切到项目 3", projects });
  assert.equal(intent.source, "judge", "an account over the cap is still judged");
  assert.equal(judged[0].projects.length, JUDGE_J2_MAX_PROJECTS);
  await classifier.classifyWithModel({ userId: "u", projectId: "project-1", text: "把这个对话切到项目 3", projects });
  const shown = (original[0].projects ?? []).map((/** @type {any} */ project) => project.id);
  assert.deepEqual(judged[0].projects.map((/** @type {any} */ project) => project.id), shown, "one list for both, so their answers are comparable");
  // The registry's own bound is unchanged: it is what the client now honours, not something loosened.
  assert.throws(() => buildJudgeRequest("J2", { message: "x", currentProjectId: "project-1", projects: projectsOf(JUDGE_J2_MAX_PROJECTS + 1) }), /judge_invalid_input/);
  assert.doesNotThrow(() => buildJudgeRequest("J2", { message: "x", currentProjectId: "project-1", projects: projectsOf(JUDGE_J2_MAX_PROJECTS) }));
});

test("a full text longer than the site reads is clipped, not refused: the role is told from the opening", async () => {
  /** @type {any[]} */
  const sent = [];
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async (_deps, call) => {
    sent.push(call.state);
    return { model: config.reviewJevModel, cost: 0, answers: { role: { type: "choice", choice: "primary_publication", confidence: 1,
      probabilities: { adjacent_outcome_trial: 0, design_or_protocol: 0, secondary_analysis: 0, primary_publication: 1 } } } };
  } });
  const result = await service.judge("meta-evidence-role", { title: "A randomised trial", abstract: "Abstract.", text: "全文".repeat(20_000), targetOutcome: "mortality" }, { userId: "u", projectId: "p" });
  assert.equal(result.outcome, "settled", "a 40,000-character text is the ordinary case");
  assert.equal(result.value.role, "primary_publication");
  assert.equal(sent[0].text.length, 30_000, "clipped to the bound the registry reads");
  // Clipping never leaves half of a surrogate pair in what is sent.
  await service.judge("meta-evidence-role", { title: "t", abstract: "a", text: `${"a".repeat(29_999)}😀tail`, targetOutcome: "o" }, { userId: "u", projectId: "p" });
  assert.equal(sent[1].text, "a".repeat(29_999));
  // Other texts keep the bound they had: a manuscript is not clipped into a different question.
  assert.throws(() => buildJudgeRequest("J7", { filename: "a.txt", text: "x".repeat(30_001), types: ["other", "paper"] }), /judge_invalid_input/);
  await service.close();
});

const secret = "test-only-model-gateway-signing-secret-32-bytes";
const engineToken = issueEngineModelToken({ secret, userId: "user", projectId: "project", kind: "peer-review", jobId: "peer-review-20261010-test", runId: "run", ttlSeconds: 300 }).token;
/** @param {import("node:test").TestContext} t */
async function gateway(t) {
  /** @type {any[]} */
  const calls = [];
  const server = createServer(createJudgeGatewayHandler({ config: { engineModelGatewayEnabled: true, modelGatewaySigningSecret: secret },
    judgeService: { judge: async (...args) => { calls.push(args); return { outcome: "fallback", code: "judge_uncalibrated", value: null }; } } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, post: (/** @type {string} */ body) => fetch(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, { method: "POST", headers: { authorization: `Bearer ${engineToken}` }, body }) };
}

test("a manuscript at the registry's bound reaches the judge; only a body past the ceiling is refused at the wire", async t => {
  const { calls, post } = await gateway(t);
  // 100,000 characters of Chinese is 300 KB on the wire: over the 128 KiB the gateway used to take, under what the registry reads.
  const manuscript = "稿".repeat(100_000);
  const body = JSON.stringify({ site: "J8", input: { manuscript, criteria: [{ id: "c1", text: "Randomised?" }] } });
  assert.ok(Buffer.byteLength(body) > 128 * 1024 && Buffer.byteLength(body) < JUDGE_GATEWAY_MAX_BODY_BYTES);
  const accepted = await post(body);
  assert.equal(accepted.status, 200, "the transport does not refuse what the registry would read");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].manuscript.length, 100_000);
  const refused = await post(JSON.stringify({ site: "J8", input: { manuscript: "x".repeat(JUDGE_GATEWAY_MAX_BODY_BYTES), criteria: [] } }));
  assert.equal(refused.status, 400, "the gateway answers an unreadable body as an invalid request, as it always has");
  assert.equal(calls.length, 1, "and what is refused at the wire never reaches the judge");
});

test("the gateway's ceiling covers the largest state the registry reads and equals the shared Python client's own", async () => {
  assert.ok(/** @type {any} */ (gatewayModule).JUDGE_GATEWAY_MAX_BODY_BYTES && /** @type {any} */ (sitesModule).JUDGE_STATE_MAX_CHARS, "both limits are named where they are enforced");
  // The registry reads at most JUDGE_STATE_MAX_CHARS characters of state; UTF-8 takes at most three bytes for each, plus the envelope.
  assert.ok(JUDGE_GATEWAY_MAX_BODY_BYTES >= JUDGE_STATE_MAX_CHARS * 3 + 64 * 1024, `${JUDGE_GATEWAY_MAX_BODY_BYTES} bytes cannot hold ${JUDGE_STATE_MAX_CHARS} characters`);
  const client = await readFile(path.join(workspaceRoot, "项目代码/evimed_judge.py"), "utf8");
  const guard = /if len\(body\) > (\d+(?: \* \d+)*):/.exec(client);
  assert.ok(guard, "the Python client guards the size of what it sends");
  const bytes = guard[1].split(" * ").reduce((product, factor) => product * Number(factor), 1);
  assert.equal(bytes, JUDGE_GATEWAY_MAX_BODY_BYTES, "a request the client lets out is one the gateway reads, and the reverse");
});
