// The job queue's rules without a database, and the engine channel against a
// fetch double: how a scenario is frozen and hashed, how a seed and a
// replicate count follow from the scenario rather than from a habit, and what
// the engine channel refuses — including a result nobody signed.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_JOB_OPEN_STATES, VCR_JOB_TERMINAL_STATES, vcrReplicatesFor, vcrScenarioHash, vcrSeedFor,
} from "../src/vcrJobs.mjs";
import {
  VCR_ENGINE_RETRYABLE_CODES, createVcrEngineClient, verifyVcrReceipt, vcrReceiptSignature,
} from "../src/vcrEngineClient.mjs";
import { VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, canonicalScenarioJson, replicatesForMcse } from "@evimed/domain";

const scenario = {
  design: { kind: "two_arm_fixed", allocation: "1:1", n: 300 },
  endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7 },
  analysis: { method: "logrank" },
  accrual: { months: 24 },
  performance: ["power", "type_one_error"],
};

const manifest = {
  engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
  startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 42.1,
  outputHash: "c".repeat(64),
};

function engineResult(overrides = {}) {
  return {
    jobId: "job_1", protocolVersion: 1, status: "succeeded", method: "design.simulate", methodVersion: "1.0.0",
    scenarioHash: vcrScenarioHash(scenario), seed: 20260928, replicates: 20000,
    counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
    measures: [{ name: "power", value: 0.812, simulated: true, mcse: 0.0031, interval: { kind: "monte_carlo", low: 0.806, high: 0.818 } }],
    diagnostics: {}, tables: [], manifest: { ...manifest },
    ...overrides,
  };
}

test("a scenario's hash is over its canonical bytes, so key order and undefined never change it", () => {
  const base = vcrScenarioHash(scenario);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(vcrScenarioHash(Object.fromEntries([...Object.entries(scenario)].reverse())), base);
  assert.equal(vcrScenarioHash({ ...scenario, nothing: undefined }), base);
  assert.notEqual(vcrScenarioHash({ ...scenario, truth: { hazardRatio: 0.65 } }), base);
  // The engine hashes exactly these bytes: the domain produces them, the
  // control plane hashes them, and neither side has its own canonicaliser.
  assert.equal(canonicalScenarioJson(scenario).includes('"accrual"'), true);
});

test("the seed is derived from the scenario, so the same frozen scenario is the same run", () => {
  const hash = vcrScenarioHash(scenario);
  const seed = vcrSeedFor(hash);
  assert.equal(vcrSeedFor(hash), seed, "deterministic");
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 2_147_483_647, "inside the protocol's range");
  assert.notEqual(vcrSeedFor(vcrScenarioHash({ ...scenario, truth: { hazardRatio: 1 } })), seed);
});

test("AC-28 replicates follow from the precision asked for, on top of the plan's floors", () => {
  // Under the null the floor is 20,000 unless the asked-for precision needs more.
  assert.equal(vcrReplicatesFor({ ...scenario, truth: { isNull: true } }), VCR_REPLICATES_NULL_MIN);
  assert.equal(vcrReplicatesFor({ ...scenario, truth: { effect: 0 } }), VCR_REPLICATES_NULL_MIN);
  assert.equal(vcrReplicatesFor(scenario), VCR_REPLICATES_ALT_MIN);
  // A one-sided 0.025 type-I error measured to a tenth of a point needs 24,375
  // (plan §5.4, case N05) — more than the floor, so the floor gives way.
  const precise = vcrReplicatesFor({ ...scenario, truth: { isNull: true }, targetMcse: 0.001 });
  assert.equal(precise, replicatesForMcse({ measure: "proportion", target: 0.001 }));
  assert.ok(precise > VCR_REPLICATES_NULL_MIN);
});

test("the job states a queue may still move out of are the three open ones", () => {
  assert.deepEqual([...VCR_JOB_OPEN_STATES], ["queued", "running", "awaiting_budget"]);
  assert.deepEqual([...VCR_JOB_TERMINAL_STATES], ["succeeded", "failed", "canceled"]);
});

test("AC-13 an engine that is not composed answers engine_unavailable by name, never a fabricated number", async () => {
  const client = createVcrEngineClient({ baseUrl: "" });
  assert.equal(client.configured(), false);
  for (const call of [() => client.submit({}), () => client.status("job_1"), () => client.result("job_1"), () => client.health()]) {
    await assert.rejects(call(), (/** @type {any} */ error) => {
      assert.equal(error.code, "engine_unavailable");
      assert.equal(error.retryable, false);
      assert.match(error.message, /暂不可用/);
      return true;
    });
  }
});

test("a job the engine would refuse is refused here, with the field named", async () => {
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => { throw new Error("must not be reached"); } });
  await assert.rejects(client.submit({ jobId: "job_1", studyId: "std_1", kind: "design_simulation", method: "design.simulate",
    methodVersion: "1.0.0", protocolVersion: 1, seed: -1, cpuSecondsLimit: 600, inputs: [], scenario }),
  (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_job_invalid");
    assert.match(error.message, /seed/);
    return true;
  });
});

test("a submitted job is accepted by id, and a timeout is retryable while a refusal is not", async () => {
  const accepted = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify({ jobId: "job_1", accepted: true }), { status: 202, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(await accepted.submit({ jobId: "job_1", studyId: "std_1", kind: "design_simulation", method: "design.simulate",
    methodVersion: "1.0.0", protocolVersion: 1, seed: 20260928, replicates: 20000, cpuSecondsLimit: 600, inputs: [], scenario }),
  { jobId: "job_1", accepted: true });

  const refused = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify({ error: "bad scenario" }), { status: 400 }),
  });
  await assert.rejects(refused.status("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_rejected");
    assert.equal(error.retryable, false);
    return true;
  });

  const busy = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  await assert.rejects(busy.status("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_unreachable");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual([...VCR_ENGINE_RETRYABLE_CODES], ["vcr_engine_timeout", "vcr_engine_unreachable"]);
});

test("the workload token is read at the moment of the call, so a rotation reaches a long-running worker", async () => {
  /** @type {string[]} */
  const seen = [];
  let token = "first";
  const client = createVcrEngineClient({
    baseUrl: "http://engine.local", token: () => token,
    fetchImpl: async (/** @type {any} */ _url, /** @type {any} */ init) => {
      seen.push(String(init.headers.authorization ?? ""));
      return new Response(JSON.stringify({ ok: true, engineVersion: "1.0.0", rVersion: "R 4.3.3", methods: [], packageLockHash: "" }),
        { status: 200 });
    },
  });
  await client.health();
  token = "second";
  await client.health();
  assert.deepEqual(seen, ["Bearer first", "Bearer second"]);
});

test("a result the engine did not sign is refused when this deployment asks for a receipt", async () => {
  const key = "receipt-key";
  const signed = engineResult();
  signed.manifest.signature = vcrReceiptSignature(key, {
    jobId: signed.jobId, scenarioHash: signed.scenarioHash, outputHash: signed.manifest.outputHash,
  });
  const good = createVcrEngineClient({
    baseUrl: "http://engine.local", receiptKey: key,
    fetchImpl: async () => new Response(JSON.stringify(signed), { status: 200 }),
  });
  const answer = await good.result("job_1");
  assert.equal(answer.signed, true);
  assert.equal(answer.result.measures[0].value, 0.812);

  const unsigned = createVcrEngineClient({
    baseUrl: "http://engine.local", receiptKey: key,
    fetchImpl: async () => new Response(JSON.stringify(engineResult()), { status: 200 }),
  });
  await assert.rejects(unsigned.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_receipt_invalid");
    assert.equal(error.detail.reason, "signature_missing");
    return true;
  });

  const tampered = engineResult();
  tampered.manifest.signature = vcrReceiptSignature(key, { jobId: "job_1", scenarioHash: "0".repeat(64), outputHash: tampered.manifest.outputHash });
  const forged = createVcrEngineClient({
    baseUrl: "http://engine.local", receiptKey: key,
    fetchImpl: async () => new Response(JSON.stringify(tampered), { status: 200 }),
  });
  await assert.rejects(forged.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.detail.reason, "signature_mismatch");
    return true;
  });

  // A deployment with no key configured is told the result is unsigned rather
  // than told nothing: the execution record keeps that fact.
  const bare = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify(engineResult()), { status: 200 }),
  });
  assert.equal((await bare.result("job_1")).signed, false);
  assert.deepEqual(verifyVcrReceipt(engineResult(), ""), { signed: false, ok: true, reason: "no_receipt_key" });
});

test("AC-28 a result whose simulated measure has no Monte-Carlo error never reaches the ledger", async () => {
  const missing = engineResult({ measures: [{ name: "power", value: 0.812, simulated: true }] });
  const client = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify(missing), { status: 200 }),
  });
  await assert.rejects(client.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_result_invalid");
    assert.match(error.message, /mcse/);
    return true;
  });
});

test("a result that answers another job is refused", async () => {
  const client = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify(engineResult({ jobId: "job_2" })), { status: 200 }),
  });
  await assert.rejects(client.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_result_invalid");
    assert.match(error.message, /另一个作业/);
    return true;
  });
});

test("a not-estimable result is a valid finished result when it names its rule", async () => {
  const notEstimable = engineResult({
    status: "not_estimable", notEstimableRule: "effective_sample_size_below_floor",
    measures: [], counts: { realPatients: 240, events: 41, effectiveSampleSize: 12, generatedRecords: 0 },
  });
  const client = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify(notEstimable), { status: 200 }),
  });
  const answer = await client.result("job_1");
  assert.equal(answer.result.status, "not_estimable");
  assert.equal(answer.result.notEstimableRule, "effective_sample_size_below_floor");

  const unnamed = createVcrEngineClient({
    baseUrl: "http://engine.local",
    fetchImpl: async () => new Response(JSON.stringify({ ...notEstimable, notEstimableRule: null }), { status: 200 }),
  });
  await assert.rejects(unnamed.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_result_invalid");
    return true;
  });
});
