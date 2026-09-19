// A specialist engine's spend, reported by the service that ran the job.
//
// The engines call the model provider from their own containers, and the
// runtime talks to their adapters directly, so the control plane never sees a
// job finish. These tests hold the one door that report comes through: only a
// holder of the workload signing secret can open it, what comes in is checked
// field by field, and what is recorded is one settled `engine` row per job
// attempt, priced by the reference list and landing once however often it is
// retried.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { isPeak, priceUsage } from "@evimed/domain";
import {
  createEngineUsageHandler, ENGINE_KINDS, ENGINE_USAGE_PATH, ENGINE_USAGE_SIGNATURE_HEADER, engineUsageSignature,
} from "../src/engineUsage.mjs";

const secret = "test-only-engine-usage-secret-with-more-than-32-bytes";
const finishedAt = "2026-09-20T02:00:00.000Z";
const now = () => new Date("2026-09-20T02:00:30.000Z");

function report(overrides = {}) {
  return {
    v: 1, kind: "drug-safety-analysis", jobId: "safety-20260920020000-abcdef012345", attempt: 1,
    userId: "user-1", projectId: "project-1", status: "succeeded", finishedAt,
    usage: { requests: 14, cacheHitTokens: 120_000, cacheMissTokens: 30_000, outputTokens: 9_000, model: "deepseek-flash" },
    ...overrides,
  };
}

function ledger() {
  const calls = [];
  const rows = new Map();
  return {
    calls,
    async recordSettled(input) {
      calls.push(input);
      if (input.userId === "gone") throw Object.assign(new Error("fk"), { code: "23503" });
      const existing = rows.get(input.id);
      if (existing && existing.requestFingerprint !== input.requestFingerprint) {
        throw Object.assign(new Error("conflict"), { status: 409, code: "usage_settlement_conflict" });
      }
      const row = existing ?? { ...input, actualCost: input.actualCost };
      rows.set(input.id, row);
      return { id: row.id, runId: row.runId, actualCost: row.actualCost, priced: row.priced };
    },
  };
}

async function serve(t, { usageLedger = ledger(), attributeRun = async () => "run_going", config = { evimedWorkloadSigningSecret: secret } } = {}) {
  const failures = [];
  const handler = createEngineUsageHandler({ config, usageLedger, attributeRun, now });
  const server = createServer((req, res) => handler(req, res, (failure) => failures.push(failure)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = async (body, { signature, contentType = "application/json", path = ENGINE_USAGE_PATH } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        [ENGINE_USAGE_SIGNATURE_HEADER]: signature ?? `v1=${engineUsageSignature(secret, raw)}`,
      },
      body: raw,
    });
    return { status: response.status, body: await response.json(), raw };
  };
  return { post, usageLedger, failures };
}

test("the report signature is the one the Python signers produce", () => {
  // Pinned in deploy/specialist-adapter/test_usage_report.py and in
  // 项目代码/meta/tests/test_evimed_usage_report.py too: three implementations
  // of one derivation, and a change to any one of them fails its own suite.
  assert.equal(
    engineUsageSignature("test-only-engine-usage-vector-secret-0123456789",
      "{\"v\":1,\"kind\":\"peer-review\",\"jobId\":\"review-20260920-abcdef\"}"),
    "8b668423c7817cf0286e1e119411e38bce3bbf4e4b40b2a2e419a9a5b27ac370",
  );
  assert.deepEqual([...ENGINE_KINDS].sort(), [
    "bibliometric-analysis", "drug-safety-analysis", "mendelian-randomization", "meta-analysis", "peer-review", "research-topic-selection",
  ]);
});

test("a finished job's spend becomes one settled engine row, priced by the reference list and charged to the going run", async (t) => {
  const { post, usageLedger } = await serve(t);
  const answer = await post(report());
  assert.equal(answer.status, 200);
  assert.equal(answer.body.data.recorded, true);
  assert.equal(usageLedger.calls.length, 1);
  const recorded = usageLedger.calls[0];
  const expected = priceUsage({ resourceType: "model", model: "deepseek-flash", cacheHit: 120_000, cacheMiss: 30_000, output: 9_000,
    peak: isPeak(new Date(finishedAt)) });
  assert.equal(recorded.purpose, "engine");
  assert.equal(recorded.userId, "user-1");
  assert.equal(recorded.projectId, "project-1");
  assert.equal(recorded.runId, "run_going");
  assert.equal(recorded.model, "deepseek-flash");
  assert.equal(recorded.actualCost, expected.cost);
  assert.equal(recorded.priced, true);
  assert.deepEqual(recorded.usage, { cacheHitTokens: 120_000, cacheMissTokens: 30_000, completionTokens: 9_000 });
  assert.equal(recorded.providerRequestId, "drug-safety-analysis:safety-20260920020000-abcdef012345#1");
  assert.equal(recorded.requestFingerprint, createHash("sha256").update(answer.raw).digest("hex"));
  assert.equal(recorded.now.toISOString(), finishedAt, "the row sits at the job's end, not at the report's arrival");
  assert.match(recorded.id, /^engine_[0-9a-f]{40}$/);

  // A retry of the same report is the same row; a second attempt of the same
  // job is its own row.
  await post(report());
  await post(report({ attempt: 2 }));
  assert.equal(usageLedger.calls[1].id, recorded.id);
  assert.notEqual(usageLedger.calls[2].id, recorded.id);
});

test("a job that never reached the model records nothing, and an unknown run stays unattributed", async (t) => {
  const quiet = await serve(t);
  const none = await quiet.post(report({ usage: { requests: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, model: "" } }));
  assert.equal(none.status, 200);
  assert.equal(none.body.data.recorded, false);
  assert.equal(quiet.usageLedger.calls.length, 0);

  const unattributed = await serve(t, { attributeRun: async () => { throw new Error("run ledger unreadable"); } });
  assert.equal((await unattributed.post(report())).status, 200, "attribution failing never costs the record");
  assert.equal(unattributed.usageLedger.calls[0].runId, null);

  const failedJob = await serve(t);
  await failedJob.post(report({ status: "failed" }));
  assert.equal(failedJob.usageLedger.calls[0].purpose, "engine", "a failed job's tokens were spent too");
});

test("only a holder of the workload signing secret can report, and only a well-formed report is recorded", async (t) => {
  const { post, usageLedger, failures } = await serve(t);
  assert.equal((await post(report(), { signature: "" })).status, 401);
  assert.equal((await post(report(), { signature: `v1=${"0".repeat(64)}` })).status, 401);
  // A signature over other bytes does not carry over to these.
  const other = JSON.stringify(report({ userId: "user-2" }));
  assert.equal((await post(report(), { signature: `v1=${engineUsageSignature(secret, other)}` })).status, 401);
  assert.equal((await post(report(), { contentType: "text/plain" })).status, 415);
  for (const broken of [
    { v: 2 },
    { kind: "coffee-analysis" },
    { jobId: "../../etc" },
    { attempt: 0 },
    { userId: "" },
    { status: "running" },
    { finishedAt: "2026-07-01T00:00:00.000Z" },
    { finishedAt: "2026-09-21T00:00:00.000Z" },
    { usage: { requests: -1, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, model: "deepseek-flash" } },
    { usage: { requests: 1, cacheHitTokens: 1.5, cacheMissTokens: 0, outputTokens: 0, model: "deepseek-flash" } },
    { usage: { requests: 1, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, model: "deepseek flash; drop" } },
  ]) {
    const answer = await post(report(broken));
    assert.equal(answer.status, 400, JSON.stringify(broken));
    assert.equal(answer.body.code, "engine_usage_invalid");
  }
  assert.equal(usageLedger.calls.length, 0, "nothing refused reached the ledger");
  assert.ok(failures.length > 0 && failures.every((failure) => typeof failure.code === "string"), "refusals reach the error funnel");
});

test("a deployment that cannot verify, or cannot record, says so; a vanished owner is told not to retry", async (t) => {
  assert.equal((await (await serve(t, { config: {} })).post(report())).status, 503);
  assert.equal((await (await serve(t, { usageLedger: null })).post(report())).status, 503);
  const gone = await serve(t);
  const answer = await gone.post(report({ userId: "gone" }));
  assert.equal(answer.status, 404);
  assert.equal(answer.body.code, "engine_usage_owner_unknown");
  const { post } = await serve(t);
  assert.equal((await post(report(), { path: `${ENGINE_USAGE_PATH}/extra` })).status, 404);
});
