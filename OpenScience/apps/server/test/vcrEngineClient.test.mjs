// The engine channel against a fetch double: what it refuses before asking,
// what it does with a slow or unending answer, what it holds a result to (the
// identity it echoes, the hash of what it says, the signature over both) and how
// it fetches an output table. Everything here is a property of the client; the
// real engine on the other end of it is `vcrEngineContract.integration.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  VCR_ENGINE_RETRYABLE_CODES, VcrEngineError, createVcrEngineClient, vcrComputedOutputHash, vcrReceiptSignature, vcrResultEchoIssues, verifyVcrReceipt,
} from "../src/vcrEngineClient.mjs";
import { vcrScenarioHash } from "../src/vcrJobs.mjs";

const scenario = {
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 6 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 },
  accrual: { kind: "uniform", duration: 12, followup: 12 }, performance: ["power"],
};
const frozen = { method: "design.simulate", methodVersion: "1.0.0", scenarioHash: vcrScenarioHash(scenario), seed: 20260928, replicates: 20000 };
const job = { jobId: "job_1", studyId: "std_1", kind: "design_simulation", method: "design.simulate", methodVersion: "1.0.0", protocolVersion: 1,
  seed: 20260928, replicates: 20000, cpuSecondsLimit: 600, inputs: [], scenario };

/** A result the way the engine writes one: the hash is what the numbers say, and a receipt key signs it. @param {Record<string, any>} [overrides] @param {string} [key] */
function engineResult(overrides = {}, key = "") {
  const result = {
    jobId: "job_1", protocolVersion: 1, status: "succeeded", method: "design.simulate", methodVersion: "1.0.0",
    scenarioHash: frozen.scenarioHash, seed: 20260928, replicates: 20000, conclusion: "estimable",
    counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3_600_000 },
    measures: [{ name: "power", value: 0.812, simulated: true, mcse: 0.0031, source: "synthetic", interval: { kind: "monte_carlo", low: 0.806, high: 0.818 } }],
    diagnostics: {}, tables: [],
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "b".repeat(64),
      startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:42Z", cpuSeconds: 42.1 },
    ...overrides,
  };
  result.manifest = { ...result.manifest, outputHash: vcrComputedOutputHash(result) };
  if (key) result.manifest.signature = vcrReceiptSignature(key, { jobId: result.jobId, scenarioHash: result.scenarioHash, outputHash: result.manifest.outputHash });
  return result;
}

/** @param {unknown} body @param {number} [status] */
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("AC-13 an engine that is not composed answers engine_unavailable by name, never a fabricated number", async () => {
  const client = createVcrEngineClient({ baseUrl: "" });
  assert.equal(client.configured(), false);
  for (const call of [() => client.submit({}), () => client.status("job_1"), () => client.result("job_1"), () => client.health(), () => client.deleteJob("job_1"), () => client.cancel("job_1")]) {
    await assert.rejects(call(), (/** @type {any} */ error) => {
      assert.equal(error.code, "engine_unavailable");
      assert.equal(error.retryable, false);
      assert.match(error.message, /暂不可用/);
      return true;
    });
  }
});

test("a job the engine would refuse is refused here, with the field named, and a job id that is not one never leaves", async () => {
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => { throw new Error("must not be reached"); } });
  await assert.rejects(client.submit({ ...job, seed: -1 }), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_job_invalid");
    assert.match(error.message, /seed/);
    return true;
  });
  // A scenario the domain's schema does not read is refused by its path.
  await assert.rejects(client.submit({ ...job, scenario: { ...scenario, accrual: { ...scenario.accrual, dropoutRate: 0.1 } } }),
    (/** @type {any} */ error) => error.code === "vcr_engine_job_invalid" && /scenario\.accrual\.dropoutRate/.test(error.message));
  for (const call of [() => client.status("../jobs"), () => client.result("a/b"), () => client.cancel(""), () => client.deleteJob("x y")]) {
    await assert.rejects(call(), (/** @type {any} */ error) => error.code === "vcr_engine_job_invalid");
  }
});

test("a submitted job is accepted by id, and a timeout is retryable while a refusal is not", async () => {
  const accepted = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ jobId: "job_1", accepted: true }, 202) });
  assert.deepEqual(await accepted.submit(job), { jobId: "job_1", accepted: true });
  const wrongIdentity = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ jobId: "job_other", accepted: true }, 202) });
  await assert.rejects(wrongIdentity.submit(job), { code: "vcr_engine_response_invalid" });

  const refused = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ detail: "job_field_invalid", field: "seed" }, 422) });
  await assert.rejects(refused.status("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_rejected");
    assert.equal(error.retryable, false);
    assert.equal(error.detail, "job_field_invalid", "the engine's own fixed code reaches the job's error");
    return true;
  });

  const busy = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => new Response("", { status: 503 }) });
  await assert.rejects(busy.status("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_unreachable");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual([...VCR_ENGINE_RETRYABLE_CODES], ["vcr_engine_timeout", "vcr_engine_unreachable"]);

  // A job the engine does not know is named: the queue answers it by submitting again, not by failing.
  const lost = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ detail: "job_not_found" }, 404) });
  await assert.rejects(lost.status("job_1"), (/** @type {any} */ error) => error.code === "vcr_engine_not_found" && error.retryable === false);
});

test('health preserves only a well-formed numerical source digest from the running engine', async () => {
  let digest = 'a'.repeat(64);
  const client = createVcrEngineClient({ baseUrl: 'http://engine.local', fetchImpl: async () => json({ ok: true, numericalSourceDigest: digest, rVersion: 'R version 4.3.3', packageLockHash: 'b'.repeat(64) }) });
  assert.equal((await client.health()).numericalSourceDigest, digest);
  digest = 'unknown'; assert.equal((await client.health()).numericalSourceDigest, null);
});

test("the workload token is read at the moment of the call, so a rotation reaches a long-running worker", async () => {
  /** @type {string[]} */
  const seen = [];
  let token = "first";
  const client = createVcrEngineClient({
    baseUrl: "http://engine.local", token: () => token,
    fetchImpl: async (/** @type {any} */ _url, /** @type {any} */ init) => {
      seen.push(String(init.headers.authorization ?? ""));
      return json({ ok: true, engineVersion: "1.0.0", rVersion: "R 4.3.3", methods: [], packageLockHash: "" });
    },
  });
  await client.health();
  token = "second";
  await client.health();
  assert.deepEqual(seen, ["Bearer first", "Bearer second"]);
});

test("the deadline covers the body as well as the headers: an answer that stalls is a timeout, and one that never ends is refused at the byte cap", async () => {
  // Headers at once, then a body that never comes: the timer is still running.
  const stalled = createVcrEngineClient({
    baseUrl: "http://engine.local", timeoutMs: 1_000,
    fetchImpl: async (/** @type {any} */ _url, /** @type {any} */ init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jobId":'));
        // A real socket keeps the event loop alive while it waits; the client's deadline timer
        // is unref'd on purpose, and Node 22's test runner cancels a test that has nothing
        // else pending. Hold the loop until the deadline aborts the read.
        const hold = setTimeout(() => {}, 60_000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(hold);
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    }), { status: 200 }),
  });
  const started = Date.now();
  await assert.rejects(stalled.status("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_timeout");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, "it did not wait for the body for ever");

  // An engine that never stops talking costs a bounded read, not the process's memory.
  let served = 0;
  const endless = createVcrEngineClient({
    baseUrl: "http://engine.local", maxResponseBytes: 64 * 1024,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { served += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024).fill(120)); },
    }), { status: 200 }),
  });
  await assert.rejects(endless.status("job_1"), (/** @type {any} */ error) => error.code === "vcr_engine_response_invalid");
  assert.ok(served <= 512 * 1024, `read only ${served} bytes of an endless answer`);
});

test("a result is verified against the numbers it says, and the hash and signature agree with what this side computed", async () => {
  const key = "receipt-key";
  const good = createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: key, fetchImpl: async () => json(engineResult({}, key)) });
  const answer = await good.result("job_1", { expected: frozen });
  assert.equal(answer.signed, true);
  assert.equal(answer.refused, false);
  assert.equal(answer.result.measures[0].value, 0.812);
  assert.equal(answer.outputHash, vcrComputedOutputHash(answer.result));

  // Signed over a hash the engine wrote, but the numbers were changed after signing: the hash this side computes differs.
  const tampered = engineResult({}, key);
  tampered.measures[0].value = 0.95;
  const changed = createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: key, fetchImpl: async () => json(tampered) });
  await assert.rejects(changed.result("job_1", { expected: frozen }), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_receipt_invalid");
    assert.equal(error.detail.reason, "output_hash_mismatch");
    return true;
  });

  // A number nobody signed, and a signature over another scenario.
  const unsigned = createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: key, fetchImpl: async () => json(engineResult()) });
  await assert.rejects(unsigned.result("job_1"), (/** @type {any} */ error) => error.detail.reason === "signature_missing");
  const forged = engineResult();
  forged.manifest.signature = vcrReceiptSignature(key, { jobId: "job_1", scenarioHash: "0".repeat(64), outputHash: forged.manifest.outputHash });
  const wrongScenario = createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: key, fetchImpl: async () => json(forged) });
  await assert.rejects(wrongScenario.result("job_1"), (/** @type {any} */ error) => error.detail.reason === "signature_mismatch");

  // A deployment with no key configured is told the result is unsigned rather than told nothing — and the hash is still held.
  const bare = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json(engineResult()) });
  assert.equal((await bare.result("job_1")).signed, false);
  assert.deepEqual(verifyVcrReceipt(engineResult(), ""), { signed: false, ok: true, reason: "no_receipt_key", outputHash: vcrComputedOutputHash(engineResult()) });
  const badHash = engineResult();
  badHash.manifest.outputHash = "1".repeat(64);
  assert.equal(verifyVcrReceipt(badHash, "").ok, false);
});

test("a result for another scenario, seed, method or replicate count under this job's id is not this job's answer", async () => {
  const cases = /** @type {Array<[Record<string, any>, string]>} */ ([
    [{ scenarioHash: "a".repeat(64) }, "scenarioHash"], [{ seed: 7 }, "seed"], [{ method: "design.grid" }, "method"],
    [{ methodVersion: "2.0.0" }, "methodVersion"], [{ replicates: 5000 }, "replicates"],
  ]);
  for (const [override, field] of cases) {
    const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json(engineResult(override)) });
    await assert.rejects(client.result("job_1", { expected: frozen }), (/** @type {any} */ error) => {
      assert.equal(error.code, "vcr_engine_result_mismatch", field);
      assert.deepEqual(error.detail.fields, [field]);
      return true;
    });
  }
  // A run cut short completed fewer replicates than asked: lower is honest, higher is not, and a grid's count is a total over cells.
  assert.deepEqual(vcrResultEchoIssues(frozen, { ...engineResult(), status: "failed", conclusion: "limited", replicates: 9500 }), []);
  assert.deepEqual(vcrResultEchoIssues(frozen, { ...engineResult(), status: "failed", conclusion: "limited", replicates: 25000 }), ["replicates"]);
  assert.deepEqual(vcrResultEchoIssues({ ...frozen, method: "design.grid" }, { ...engineResult(), method: "design.grid", replicates: 90000 }), []);
  assert.deepEqual(vcrResultEchoIssues(frozen, engineResult()), []);
  const another = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json(engineResult({ jobId: "job_2" })) });
  await assert.rejects(another.result("job_1"), (/** @type {any} */ error) => error.code === "vcr_engine_result_invalid" && /另一个作业/.test(error.message));
});

test("an engine refusal it could not tie to a job comes back as the engine's reason, not as a mismatch", async () => {
  // The engine refuses a job whose identity fields are malformed: nothing to echo, no hash, no signature, no numbers.
  const refusal = { jobId: "job_1", protocolVersion: 1, status: "failed", method: null, methodVersion: null, scenarioHash: "0".repeat(64), seed: null, replicates: null,
    notEstimableRule: null, counts: {}, measures: [], diagnostics: { issues: [{ code: "job_id_invalid", field: "jobId", detail: "A job id is 1–121 characters." }] }, tables: [],
    manifest: { engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "", startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:00:00Z", cpuSeconds: 0 } };
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: "key", fetchImpl: async () => json(refusal) });
  const answer = await client.result("job_1", { expected: frozen });
  assert.equal(answer.refused, true);
  assert.equal(answer.signed, false);
  assert.equal(answer.result.diagnostics.issues[0].code, "job_id_invalid");
  // A failed result that carries measures is not a refusal: it is held to the same checks as any other.
  const partial = engineResult({ status: "failed", conclusion: "limited" }, "key");
  assert.equal((await createVcrEngineClient({ baseUrl: "http://engine.local", receiptKey: "key", fetchImpl: async () => json(partial) }).result("job_1", { expected: frozen })).refused, false);
});

test("AC-28 a result whose simulated measure has no Monte-Carlo error never reaches the ledger", async () => {
  const missing = engineResult({ measures: [{ name: "power", value: 0.812, simulated: true, source: "synthetic" }] });
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json(missing) });
  await assert.rejects(client.result("job_1"), (/** @type {any} */ error) => {
    assert.equal(error.code, "vcr_engine_result_invalid");
    assert.match(error.message, /mcse/);
    return true;
  });
});

test("a not-estimable result is a valid finished result when it names its rule", async () => {
  const notEstimable = engineResult({
    status: "not_estimable", conclusion: "not_estimable", notEstimableRule: "effective_sample_size_below_floor",
    measures: [], counts: { realPatients: 240, events: 41, effectiveSampleSize: 12, generatedRecords: 0 },
  });
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json(notEstimable) });
  const answer = await client.result("job_1");
  assert.equal(answer.result.status, "not_estimable");
  assert.equal(answer.result.notEstimableRule, "effective_sample_size_below_floor");
  const unnamed = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ ...notEstimable, notEstimableRule: null }) });
  await assert.rejects(unnamed.result("job_1"), (/** @type {any} */ error) => error.code === "vcr_engine_result_invalid");
});

test("a job's directory on the engine is discarded on request, and a job the engine already forgot is discarded", async () => {
  /** @type {Array<[string, string | undefined]>} */
  const seen = [];
  const client = createVcrEngineClient({ baseUrl: "http://engine.local", token: "tok", fetchImpl: async (/** @type {any} */ url, /** @type {any} */ init) => {
    seen.push([String(url), init.method]);
    return String(url).endsWith("job_1") ? json({ discarded: true }) : json({ detail: "job_not_found" }, 404);
  } });
  assert.deepEqual(await client.deleteJob("job_1"), { discarded: true });
  assert.deepEqual(await client.deleteJob("job_9"), { discarded: true });
  assert.deepEqual(seen, [["http://engine.local/jobs/job_1", "DELETE"], ["http://engine.local/jobs/job_9", "DELETE"]]);
  const refused = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async () => json({ detail: "job_still_running" }, 409) });
  await assert.rejects(refused.deleteJob("job_1"), (/** @type {any} */ error) => error.code === "vcr_engine_rejected" && error.detail === "job_still_running");
});

test("an output table is downloaded under the hash the result lists, and a substituted one is not kept", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-table-"));
  try {
    const csv = "age,ldh\n61,220\n55,190\n";
    const sha = createHash("sha256").update(csv).digest("hex");
    const client = createVcrEngineClient({ baseUrl: "http://engine.local", fetchImpl: async (/** @type {any} */ url) => {
      assert.equal(String(url), "http://engine.local/jobs/job_1/tables/population");
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    } });
    const destination = path.join(directory, "population.csv");
    assert.deepEqual(await client.downloadTable("job_1", "population", { destination, sha256: sha }), { bytes: csv.length, sha256: sha });
    assert.equal(await fs.readFile(destination, "utf8"), csv);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["population.csv"], "no partial file is left beside it");

    const other = path.join(directory, "other.csv");
    await assert.rejects(client.downloadTable("job_1", "population", { destination: other, sha256: "0".repeat(64) }),
      (/** @type {any} */ error) => error.code === "vcr_engine_table_invalid");
    await assert.rejects(fs.access(other), "the substituted table is not kept");
    assert.deepEqual((await fs.readdir(directory)).sort(), ["population.csv"]);
    await assert.rejects(client.downloadTable("job_1", "../secret", { destination: other, sha256: sha }), (/** @type {any} */ error) => error.code === "vcr_engine_job_invalid");
    await assert.rejects(client.downloadTable("job_1", "population", { destination: other, sha256: "nope" }), (/** @type {any} */ error) => error.code === "vcr_engine_table_invalid");
    // The byte cap holds while the bytes stream in.
    await assert.rejects(client.downloadTable("job_1", "population", { destination: other, sha256: sha, maxBytes: 5 }), (/** @type {any} */ error) => error.code === "vcr_engine_response_invalid");
    await assert.rejects(fs.access(other));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  assert.ok(new VcrEngineError("vcr_engine_timeout", "x").retryable);
});
