import assert from "node:assert/strict";
import test from "node:test";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";

function fixture({ sourceStatus = "queued", sourceRevision = 1, sourceGeneration = sourceRevision,
  jobRevision = sourceGeneration, parseError = null, afterParse = null, renew = async () => true } = {}) {
  const calls = [];
  const job = { id: "job-one", userId: "user-one", projectId: "project-one", kind: "ingest",
    payload: { sourceId: "source-one", sourceRevision: jobRevision, extractorVersion: "evimed-analysis-1.0.0" },
    leaseToken: "lease-one", attempts: 1 };
  const source = { id: "source-one", revision: sourceRevision, projectId: "project-one", payload: {
    status: sourceStatus, generation: sourceGeneration, depth: "index_only", paths: ["knowledge-base/paper.txt"], fingerprint: { sha256: "a".repeat(64), mimeType: "text/plain" },
  } };
  const jobs = {
    claim: async () => job,
    renew,
    finish: async (...args) => { calls.push({ method: "finish", args }); return { status: "succeeded" }; },
    fail: async (...args) => { calls.push({ method: "fail", args }); return { status: "failed" }; },
  };
  const sources = {
    withIngestionLease: async (_job, operation) => operation(),
    withAttemptCleanup: async (_job, operation) => operation(),
    get: async () => source,
    beginIngestion: async (...args) => {
      calls.push({ method: "beginIngestion", args });
      source.revision += 1;
      source.payload.status = "parsing";
      return { ...source, payload: { ...source.payload } };
    },
    loadCapture: async () => null,
    freezeCapture: async (_job, result) => ({ ...result, input: { text: result.text, units: result.units } }),
    recordReadable: async (...args) => {
      calls.push({ method: "recordReadable", args });
      source.revision += 1;
      source.payload.analysis = { ...source.payload.analysis, generation: source.payload.generation, readAt: "2026-09-24T00:00:00.000Z" };
      source.payload.outputs = { ...source.payload.outputs, artifactPath: args[1] };
      return { ...source, payload: { ...source.payload } };
    },
    publishUnderstanding: async (...args) => { calls.push({ method: "publishUnderstanding", args }); return { ...source, revision: source.revision + 1 }; },
    recordFailure: async (...args) => { calls.push({ method: "recordFailure", args }); return { ...source, revision: source.revision + 1 }; },
  };
  const parser = {
    parse: async (...args) => {
      calls.push({ method: "parse", args });
      if (parseError) throw parseError;
      await afterParse?.({ source, calls });
      return {
        extractor: { name: "plain-text", version: "1.0.0", parser: "fallback" },
        units: [{ id: "chunk-1", unitType: "chunk", status: "extracted", itemIds: ["fact-1"] }],
        summary: "Parsed research source.", facts: [{ id: "fact-1", content: "Finding" }], methods: [],
        text: "Parsed research source.\n\nFinding",
      };
    },
  };
  const resolveSource = async (...args) => { calls.push({ method: "resolve", args }); return "/data/users/user-one/paper.txt"; };
  const materialize = async (...args) => { calls.push({ method: "materialize", args }); return "knowledge-base/.evimed-derived/source-one/index.md"; };
  const discardMaterialized = async (...args) => { calls.push({ method: "discard", args }); };
  const worker = new SourceIngestionWorker({ jobs, sources, parser, resolveSource, materialize, discardMaterialized, pollMs: 100, leaseMs: 1000 });
  return { calls, job, source, sources, worker };
}

test("an ingest lease parses, accounts, materializes and finishes exactly once", async () => {
  const { calls, worker } = fixture();
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "publishUnderstanding"]);
  const publication = calls.find((call) => call.method === "publishUnderstanding").args;
  assert.equal(publication[2], null);
  assert.equal(publication[3], "knowledge-base/.evimed-derived/source-one/index.md");
  assert.equal(worker.status().lastError, null);
  assert.ok(worker.status().lastCompletedAt);
});

test("a canceled or stale manifest is skipped without reading source bytes", async () => {
  for (const options of [{ sourceStatus: "canceled" }, { sourceRevision: 2, jobRevision: 1 }]) {
    const { calls, worker } = fixture(options);
    await worker.tick();
    assert.equal(calls.some((call) => call.method === "parse"), false);
    const finish = calls.find((call) => call.method === "finish");
    assert.equal(finish.args[3].skipped, true);
  }
});

test("a parser failure is visible on the source and follows bounded job retry", async () => {
  const error = new Error("parser offline");
  error.code = "source_parser_unavailable";
  const { calls, worker } = fixture({ parseError: error });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "recordFailure"), true);
  const failed = calls.find((call) => call.method === "fail");
  assert.equal(failed.args[3].code, "source_parser_unavailable");
  assert.equal(failed.args[4].retry, true);
  assert.equal(worker.status().lastError, "source_parser_unavailable");
});

test("canceling after parsing fences the result before materialization", async () => {
  const { calls, source, worker } = fixture({ afterParse: async () => {
    source.payload.status = "canceled";
    source.payload.generation += 1;
  } });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "materialize"), false);
  assert.equal(calls.some((call) => call.method === "publishUnderstanding"), false);
  assert.equal(calls.some((call) => call.method === "recordFailure"), false);
});

test("a cancel racing with materialization deletes only this job's unpublished artifact", async () => {
  const { calls, source, worker } = fixture();
  const originalGet = worker.sources.get;
  let reads = 0;
  worker.sources.get = async (...args) => {
    reads += 1;
    if (reads === 3) {
      source.payload.status = "canceled";
      source.payload.generation += 1;
    }
    return originalGet(...args);
  };
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "materialize"), true);
  assert.equal(calls.some((call) => call.method === "discard"), true);
  assert.equal(calls.some((call) => call.method === "publishUnderstanding"), false);
});

test("an expired lease never publishes a parsed artifact", async () => {
  let renewals = 0;
  const { calls, worker } = fixture({ renew: async () => { renewals += 1; return renewals === 1; } });
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "materialize"), true);
  assert.equal(calls.some((call) => call.method === "discard"), true);
  assert.equal(calls.some((call) => call.method === "publishUnderstanding"), false);
});

test("a document is readable as soon as it is read, while its understanding still runs", async () => {
  // 2026-09-24: a PDF stayed unsearchable for the one to four minutes its
  // understanding run took, because its text was written out only after it.
  const { calls, source, sources, worker } = fixture();
  source.payload.depth = "structured";
  let runs = 0;
  worker.understandingRuns = { execute: async () => {
    runs += 1;
    calls.push({ method: "understand" });
    return runs === 1 ? { state: "pending", runId: "run-one", sessionId: "session-one", dispatchId: "dispatch-one" }
      : { state: "complete", runId: "run-one", sessionId: "session-one", dispatchId: "dispatch-one", output: { summary: "指南" } };
  } };
  sources.deferIngestion = async (...args) => { calls.push({ method: "deferIngestion", args }); return { deferred: true }; };
  /** @type {string[]} */
  const readable = [];
  worker.onReadable = (job) => { readable.push(job.id); };
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "recordReadable", "understand", "deferIngestion"],
    "the text is written and recorded before the understanding is dispatched");
  assert.equal(calls.find((call) => call.method === "recordReadable").args[1], "knowledge-base/.evimed-derived/source-one/index.md");
  assert.deepEqual(readable, ["job-one"], "the index is told the document can be searched now");

  // The deferred job comes back: the capture is there and the text already
  // written, so nothing is parsed or written twice, and the understanding is
  // published against the copy that was recorded.
  calls.length = 0;
  sources.loadCapture = async () => ({ input: { text: "Parsed research source.", units: [] }, extractor: { name: "plain-text" } });
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "understand", "publishUnderstanding"]);
  const publication = calls.find((call) => call.method === "publishUnderstanding").args;
  assert.equal(publication[2].state, "complete");
  assert.equal(publication[3], "knowledge-base/.evimed-derived/source-one/index.md");
  assert.deepEqual(readable, ["job-one"], "a copy already recorded is not announced again");
});

test("an understanding that fails after the document was read keeps the text it was read into", async () => {
  const { calls, source, worker } = fixture();
  source.payload.depth = "structured";
  worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("invalid"), { code: "source_understanding_invalid" }); } };
  await worker.tick();
  const methods = calls.map((call) => call.method);
  assert.ok(methods.includes("recordReadable"));
  assert.ok(methods.includes("recordFailure"), "the failure is said on the source");
  assert.equal(methods.includes("discard"), false, "the recorded copy is the source's, not the attempt's to discard");
  assert.equal(calls.find((call) => call.method === "fail").args[4].retry, false);
});

test("an index-only document is written out and published in one step, as before", async () => {
  const { calls, worker } = fixture();
  await worker.tick();
  assert.equal(calls.some((call) => call.method === "recordReadable"), false, "complete already says it: nothing runs after it");
});

test("a folder sync runs on the existing ingest lease and finishes with its own summary", async () => {
  const { calls, job, sources, worker } = fixture();
  job.payload = { action: "source-folder-sync", folderId: "srcdir_one", run: 1, page: 1 };
  sources.consumeFolderSync = async (...args) => { calls.push({ method: "consumeFolderSync", args }); return { folderId: "srcdir_one", registered: 2, complete: true }; };
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["consumeFolderSync", "finish"], "no source row is read or parsed for a folder job");
  assert.equal(calls[0].args[0].id, "job-one");
  assert.deepEqual(calls[1].args[3], { folderId: "srcdir_one", registered: 2, complete: true });
  assert.equal(worker.status().lastError, null);
  assert.ok(worker.status().lastCompletedAt);
});

test("a folder that no longer exists stops instead of retrying forever", async () => {
  const { calls, job, sources, worker } = fixture();
  job.payload = { action: "source-folder-sync", folderId: "srcdir_gone", run: 1, page: 1 };
  sources.consumeFolderSync = async () => { throw Object.assign(new Error("gone"), { code: "source_folder_not_found" }); };
  await worker.tick();
  const failed = calls.find((call) => call.method === "fail");
  assert.equal(failed.args[3].code, "source_folder_not_found");
  assert.equal(failed.args[4].retry, false, "a deleted folder is terminal, not a retry loop");
  assert.equal(calls.some((call) => call.method === "recordFailure"), false, "a folder job owns no source manifest to fail");
});

test("an unconfigured folder connector is retried, not written off", async () => {
  const { calls, job, sources, worker } = fixture();
  job.payload = { action: "source-folder-sync", folderId: "srcdir_one", run: 1, page: 1 };
  sources.consumeFolderSync = async () => { throw Object.assign(new Error("unconfigured"), { code: "source_folder_connector_unavailable" }); };
  await worker.tick();
  assert.equal(calls.find((call) => call.method === "fail").args[4].retry, true);
});

test("a document waits for a runtime or budget instead of failing when none is free", async () => {
  // 2026-09-21: a knowledge-base upload was marked failed in 21 s because the
  // account's background work held every runtime slot.
  for (const [code, delayMs] of [["runtime_limit_exceeded", 60_000], ["runtime_proxy_limit_exceeded", 60_000], ["usage_budget_exceeded", 3_600_000]]) {
    const { calls, source, sources, worker } = fixture();
    source.payload.depth = "structured";
    sources.deferIngestion = async (...args) => { calls.push({ method: "deferIngestion", args }); return { deferred: true }; };
    worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("no room"), { code }); } };
    await worker.tick();
    const methods = calls.map((call) => call.method);
    assert.ok(methods.includes("deferIngestion"), code);
    assert.equal(calls.find((call) => call.method === "deferIngestion").args[2], delayMs, code);
    assert.equal(methods.includes("recordFailure"), false, `${code}: the document is not failed`);
    assert.equal(methods.includes("fail"), false, `${code}: the job is not spent`);
  }
});

test("the repair cycle sweeps memory whose document or project is gone, and says what it did or why it could not", async () => {
  // Plan 2026-09-23 §5.6: the deletions withdraw in their own transaction;
  // this is what catches a publication that raced one, and what a deletion
  // before 2026-09-24 left behind.
  const { sources } = fixture();
  const order = [];
  /** @type {any[]} */
  const reported = [];
  sources.reconcileJobs = async () => { order.push("jobs"); throw Object.assign(new Error("jobs down"), { code: "product_state_unavailable" }); };
  sources.withdrawOrphanedMemory = async () => { order.push("sweep"); return { sources: 2, projects: 1, entries: 5, ledgers: 2 }; };
  const worker = new SourceIngestionWorker({ jobs: {}, sources, parser: {}, resolveSource: async () => "", materialize: async () => "",
    report: (event, detail) => { reported.push({ event, detail }); } });
  await worker.reconcile();
  assert.deepEqual(order, ["jobs", "sweep"], "a failed job repair does not stop the sweep");
  assert.deepEqual(reported, [{ event: "derived_memory_withdrawn", detail: { sources: 2, projects: 1, entries: 5, ledgers: 2 } }]);
  assert.equal(worker.status().orphanSweep.entries, 5);
  assert.equal(worker.status().orphanSweep.error, null);

  // A sweep with nothing to do is quiet; one that fails is on the status and the report.
  sources.withdrawOrphanedMemory = async () => ({ sources: 0, projects: 0, entries: 0, ledgers: 0 });
  await worker.reconcile();
  assert.equal(reported.length, 1);
  sources.withdrawOrphanedMemory = async () => { throw Object.assign(new Error("db down"), { code: "product_state_unavailable" }); };
  const throwingReport = new SourceIngestionWorker({ jobs: {}, sources, parser: {}, resolveSource: async () => "", materialize: async () => "",
    report: () => { throw new Error("the audit ledger is full"); } });
  await throwingReport.reconcile();
  assert.equal(throwingReport.status().orphanSweep.error, "product_state_unavailable", "a report that throws does not hide the failure");
  await worker.reconcile();
  assert.deepEqual(reported.at(-1), { event: "derived_memory_sweep_failed", detail: { code: "product_state_unavailable" } });
  // One cycle at a time: a second call while one runs joins it.
  /** @type {() => void} */
  let release = () => {};
  sources.withdrawOrphanedMemory = () => new Promise((resolve) => { release = () => resolve({ sources: 0, projects: 0, entries: 0, ledgers: 0 }); });
  const first = worker.reconcile();
  assert.equal(worker.reconcile(), first);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
});
