import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { issueResultReplayToken, replayCanonical, replayDigest, ResultReplayClient } from "../src/resultReplayClient.mjs";
import { ResultEngineRouter } from "../src/resultEngineRouter.mjs";

const scope = { userId: "user", projectId: "project", jobId: "c40e90ce-caa7-46af-90e2-61b581e23c30", recipeDigest: "a".repeat(64), method: "meta.dl" };
const config = { resultEngineUrl: "http://engine:8031", evimedWorkloadSigningSecret: "test-only-".repeat(8), resultEngineRequestTimeoutMs: 20 };

test("calculation credential binds only an owned recipe job and canonical parameters are stable", () => {
  const token = issueResultReplayToken(config.evimedWorkloadSigningSecret, scope, 1000);
  const [header, body, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.aud, "evimed-result-replay"); assert.equal(claims.jobId, scope.jobId);
  assert.equal(claims.recipeDigest, scope.recipeDigest); assert.equal(claims.exp, 1300);
  assert.equal(signature, createHmac("sha256", config.evimedWorkloadSigningSecret).update(`${header}.${body}`).digest("base64url"));
  assert.equal(replayCanonical({ z: [true, "中文"], a: { d: 1, b: false } }), '{"a":{"b":false,"d":1},"z":[true,"中文"]}');
  assert.equal(replayDigest({ b: 2, a: 1 }), replayDigest({ a: 1, b: 2 }));
  assert.throws(() => issueResultReplayToken("short", scope));
  assert.throws(() => issueResultReplayToken(config.evimedWorkloadSigningSecret, { ...scope, projectId: "../foreign" }));
});

test("engine reads have a whole-body deadline and cancel a stalled stream", async () => {
  let canceled = false;
  const client = new ResultReplayClient({ config, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"unfinished":')); },
    cancel() { canceled = true; },
  })) });
  await assert.rejects(client.status(scope), { code: "result_engine_timeout" });
  assert.equal(canceled, true);
});

test("engine requests refuse redirects, bound responses and do not forward source error bodies", async () => {
  let observed;
  const client = new ResultReplayClient({ config, fetchImpl: async (url, init) => {
    observed = { url, init }; return new Response(JSON.stringify({ jobId: scope.jobId, state: "queued" }));
  } });
  assert.equal((await client.start(scope, { method: "meta.dl" })).state, "queued");
  assert.equal(observed.url.href, "http://engine:8031/api/v1/evimed/result-replays");
  assert.equal(observed.init.redirect, "error"); assert.equal(observed.init.method, "POST");
  assert.equal(JSON.parse(observed.init.body).jobId, scope.jobId);
  const oversized = new ResultReplayClient({ config, maxBytes: 4, fetchImpl: async () => new Response('{"large":1}') });
  await assert.rejects(oversized.status(scope), { code: "result_engine_response_limit" });
  const refused = new ResultReplayClient({ config, fetchImpl: async () => new Response("private error containing a credential", { status: 403 }) });
  await assert.rejects(refused.status(scope), error => error.code === "result_engine_rejected" && !error.message.includes("credential"));
});

test("aggregate VCR recipes never fall through to the Python engine", async () => {
  const seen = [];
  const python = { configured: () => true, start: async value => { seen.push(value.method); return "python"; } };
  const vcr = { configured: method => method === "design.analytic", start: async value => { seen.push(value.method); return "R"; } };
  const router = new ResultEngineRouter({ python, vcr });
  assert.equal(await router.start(scope, {}), "python");
  assert.equal(await router.start({ ...scope, method: "design.analytic" }, {}), "R");
  assert.equal(router.configured("comparator.evalue"), false);
  assert.throws(() => router.start({ ...scope, method: "comparator.evalue" }, {}), { code: "result_engine_unavailable" });
  assert.deepEqual(seen, ["meta.dl", "design.analytic"]);
});
