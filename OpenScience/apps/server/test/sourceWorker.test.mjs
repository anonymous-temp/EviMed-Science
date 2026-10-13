import assert from "node:assert/strict";
import test from "node:test";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";

function fixture({ sourceStatus = "queued", sourceRevision = 1, sourceGeneration = sourceRevision,
  jobRevision = sourceGeneration, parseError = null, parsedText = "Parsed research source.\n\nFinding", afterParse = null, renew = async () => true,
  materials = null, engineParser = null, file = "knowledge-base/paper.txt", depth = "index_only", reports = [] } = {}) {
  const calls = [];
  const job = { id: "job-one", userId: "user-one", projectId: "project-one", kind: "ingest",
    payload: { sourceId: "source-one", sourceRevision: jobRevision, extractorVersion: "evimed-analysis-1.0.0" },
    leaseToken: "lease-one", attempts: 1, maxAttempts: 3 };
  const source = { id: "source-one", revision: sourceRevision, projectId: "project-one", payload: {
    status: sourceStatus, generation: sourceGeneration, depth, paths: [file], fingerprint: { sha256: "a".repeat(64), mimeType: "text/plain" },
  } };
  /** The service's own rule (`understandingPending`): the text is in and its understanding is still to come. */
  const pending = () => ["complete", "needs_attention"].includes(source.payload.status)
    && source.payload.understanding?.state === "pending" && source.payload.understanding.generation === source.payload.generation;
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
      if (!pending()) {
        source.revision += 1;
        source.payload.status = "parsing";
      }
      return { ...source, payload: { ...source.payload } };
    },
    // The capture is there once it was frozen, as in the service: a deferred job finds it and parses nothing twice.
    loadCapture: async () => source.captured ?? null,
    freezeCapture: async (_job, result) => {
      source.captured = { ...result, input: { text: result.text, units: result.units } };
      return source.captured;
    },
    // The text is in: the record says the document is usable and its understanding is still to come.
    recordReadable: async (...args) => {
      calls.push({ method: "recordReadable", args });
      source.revision += 1;
      source.payload.status = "complete";
      source.payload.understanding = { generation: source.payload.generation, state: "pending", at: "2026-10-13T00:00:00.000Z" };
      source.payload.analysis = { ...source.payload.analysis, generation: source.payload.generation, readAt: "2026-10-13T00:00:00.000Z" };
      source.payload.outputs = { ...source.payload.outputs, artifactPath: args[1] };
      return { ...source, payload: { ...source.payload } };
    },
    deferIngestion: async (...args) => { calls.push({ method: "deferIngestion", args }); return { deferred: true }; },
    publishUnderstanding: async (...args) => { calls.push({ method: "publishUnderstanding", args }); return { ...source, revision: source.revision + 1 }; },
    recordFailure: async (...args) => { calls.push({ method: "recordFailure", args }); return { ...source, revision: source.revision + 1 }; },
  };
  const parser = {
    parse: async (...args) => {
      calls.push({ method: "parse", args });
      if (parseError) throw parseError;
      await afterParse?.({ source, calls, input: args[0] });
      return {
        extractor: { name: "plain-text", version: "1.0.0", parser: "fallback" },
        units: [{ id: "chunk-1", unitType: "chunk", status: "extracted", itemIds: ["fact-1"] }],
        summary: "Parsed research source.", facts: [{ id: "fact-1", content: "Finding" }], methods: [],
        text: parsedText,
      };
    },
  };
  const resolveSource = async (...args) => { calls.push({ method: "resolve", args }); return "/data/users/user-one/paper.txt"; };
  const materialize = async (...args) => { calls.push({ method: "materialize", args }); return "knowledge-base/.evimed-derived/source-one/index.md"; };
  const discardMaterialized = async (...args) => { calls.push({ method: "discard", args }); };
  const worker = new SourceIngestionWorker({ jobs, sources, parser, resolveSource, materialize, discardMaterialized, materials, engineParser, pollMs: 100, leaseMs: 1000,
    report: (event, detail) => reports.push({ event, detail }) });
  return { calls, job, source, sources, worker, reports };
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

test("a document is finished as soon as its text is in; its understanding is the job's second leg and holds nothing back", async () => {
  // 2026-09-24: a PDF stayed unsearchable for the one to four minutes its
  // understanding run took, because its text was written out only after it.
  // 2026-10-13: and it stayed `parsing` for all of that time, which is what
  // every reader of the status took it to be.
  const { calls, source, sources, worker } = fixture({ depth: "structured" });
  let runs = 0;
  worker.understandingRuns = { execute: async () => {
    runs += 1;
    calls.push({ method: "understand" });
    return runs === 1 ? { state: "pending", runId: "run-one", sessionId: "session-one", dispatchId: "dispatch-one" }
      : { state: "complete", runId: "run-one", sessionId: "session-one", dispatchId: "dispatch-one", output: { summary: "指南" } };
  } };
  /** @type {string[]} */
  const readable = [];
  /** @type {string[]} */
  const published = [];
  worker.onReadable = (job) => { readable.push(job.id); };
  worker.onPublished = (job) => { published.push(job.id); };

  // The first leg: the text is captured, written out and recorded, and the job goes back to the queue with no wait.
  assert.deepEqual(await worker.tick(), { deferred: true, readable: true });
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "recordReadable", "deferIngestion"],
    "no understanding is asked for in the leg that reads the text");
  assert.equal(calls.find((call) => call.method === "recordReadable").args[1], "knowledge-base/.evimed-derived/source-one/index.md");
  assert.deepEqual(calls.find((call) => call.method === "deferIngestion").args.slice(1), [null, 0], "behind the documents still to be read, and not a moment later than that");
  assert.equal(source.payload.status, "complete", "the document's outcome is decided");
  assert.deepEqual(readable, ["job-one"], "the index is told the document can be searched now");
  assert.deepEqual(published, []);

  // The second leg: nothing is parsed or written twice, and a run that has not ended is waited for by the job alone.
  calls.length = 0;
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "understand", "deferIngestion"]);
  assert.equal(calls.find((call) => call.method === "deferIngestion").args[1].runId, "run-one");
  assert.equal(source.payload.status, "complete");

  // The run ended: the understanding is published against the copy that was recorded.
  calls.length = 0;
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "understand", "publishUnderstanding"]);
  const publication = calls.find((call) => call.method === "publishUnderstanding").args;
  assert.equal(publication[2].state, "complete");
  assert.equal(publication[3], "knowledge-base/.evimed-derived/source-one/index.md");
  assert.deepEqual(readable, ["job-one"], "a copy already recorded is not announced again");
  assert.deepEqual(published, ["job-one"]);
});

test("an understanding that cannot run, or does not succeed, is a fact about the understanding and never the document's failure", async () => {
  // 2026-10-13: each of these left a document whose text was in reading `failed`.
  for (const code of ["source_understanding_unconfigured", "source_understanding_run_failed", "source_understanding_invalid", "source_understanding_input_too_large"]) {
    const { calls, source, worker } = fixture({ depth: "structured" });
    worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("no understanding"), { code }); } };
    await worker.tick();
    calls.length = 0;
    await worker.tick();
    const methods = calls.map((call) => call.method);
    assert.deepEqual(methods, ["beginIngestion", "publishUnderstanding"], code);
    const publication = calls.find((call) => call.method === "publishUnderstanding").args;
    assert.equal(publication[2], null, `${code}: there is no understanding to publish`);
    assert.equal(publication[3], "knowledge-base/.evimed-derived/source-one/index.md", `${code}: the text it was read into stands`);
    assert.deepEqual(publication[4], { understandingError: code }, `${code}: said on the record, as the understanding's`);
    assert.equal(source.payload.status, "complete", code);
    assert.equal(worker.status().lastError, code, "the worker still says what went wrong last");
  }
  // A deployment with no understanding at all is the same answer, and no retry is spent on it.
  const { calls, worker } = fixture({ depth: "structured" });
  worker.understandingRuns = null;
  await worker.tick();
  await worker.tick();
  assert.deepEqual(calls.at(-1).args[4], { understandingError: "source_understanding_unconfigured" });
  assert.equal(calls.some((call) => ["recordFailure", "fail", "discard"].includes(call.method)), false);
});

test("an understanding failure that may pass is retried by the job alone, and recorded when the last attempt is spent", async () => {
  const { calls, job, source, worker } = fixture({ depth: "structured" });
  worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("ledger away"), { code: "source_run_ledger_unavailable" }); } };
  await worker.tick();
  calls.length = 0;
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "fail"]);
  assert.equal(calls.find((call) => call.method === "fail").args[4].retry, true);
  assert.equal(source.payload.status, "complete", "the document is not what is being retried");
  // The last attempt: nothing will try again, so the job ends as a finished document with the reason on it.
  job.attempts = 3;
  calls.length = 0;
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "publishUnderstanding"]);
  assert.deepEqual(calls.at(-1).args[4], { understandingError: "source_run_ledger_unavailable" });
});

test("a failure before the text is in is still the document's, exactly as before", async () => {
  const { calls, worker } = fixture({ depth: "structured", parseError: Object.assign(new Error("parser offline"), { code: "source_parser_unavailable" }) });
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "recordFailure", "fail"]);
});

test("a document nobody understands is written out, published and announced in one step", async () => {
  const { calls, worker } = fixture();
  /** @type {string[]} */
  const events = [];
  worker.onReadable = () => { events.push("readable"); };
  worker.onPublished = () => { events.push("published"); };
  await worker.tick();
  assert.equal(calls.some((call) => ["recordReadable", "deferIngestion"].includes(call.method)), false, "complete already says it: nothing runs after it");
  assert.deepEqual(events, ["readable", "published"], "its text can be taken by the index and the engine from this moment");
});

test("a recording is kept as an original without a byte of it being fetched", async () => {
  for (const file of ["knowledge-base/查房录音.m4a", "openlist/会议/visit.MP4"]) {
    const { calls, worker } = fixture({ file, depth: "skip" });
    /** @type {string[]} */
    const events = [];
    worker.onReadable = () => { events.push("readable"); };
    worker.onPublished = () => { events.push("published"); };
    await worker.tick();
    assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "publishUnderstanding"], file);
    assert.deepEqual(calls[1].args.slice(1), [null, null, null, { original: "source_original_media" }], file);
    assert.deepEqual(events, ["published"], "there is no text for anyone to take");
    assert.equal(worker.status().lastError, null);
  }
  // Whatever depth its record carries: nothing reads a recording.
  const overridden = fixture({ file: "knowledge-base/visit.mp4", depth: "deep" });
  await overridden.worker.tick();
  assert.deepEqual(overridden.calls.map((call) => call.method), ["beginIngestion", "publishUnderstanding"]);
  // A depth of `skip` on a file that could be read is the researcher's choice, and says so by carrying no reason.
  const skipped = fixture({ depth: "skip" });
  await skipped.worker.tick();
  assert.deepEqual(skipped.calls[1].args.slice(1), [null, null, null, {}]);
});

test("a file nothing here reads is kept as an original with the reason, never failed", async () => {
  // No engine on this deployment, or the parsing API's own 415.
  const unread = fixture({ file: "knowledge-base/src.zip", depth: "structured",
    parseError: Object.assign(new Error("Nothing here parses this document format."), { code: "source_format_unsupported", status: 415 }) });
  await unread.worker.tick();
  assert.deepEqual(unread.calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "publishUnderstanding"]);
  assert.deepEqual(unread.calls.at(-1).args.slice(1), [null, null, null, { original: "source_original_unread" }]);
  assert.equal(unread.calls.find((call) => call.method === "parse").args[0].engine, null, "without an engine the parser is handed none");
  assert.equal(unread.worker.status().lastError, null);

  // The engine was asked and could not read it this time.
  const failed = fixture({ file: "knowledge-base/src.zip", depth: "structured",
    parseError: Object.assign(new Error("The engine's parsers could not read the document."), { code: "source_original_engine_failed", status: 502 }) });
  await failed.worker.tick();
  assert.deepEqual(failed.calls.at(-1).args.slice(1), [null, null, null, { original: "source_original_engine_failed" }]);

  // It was read, and there was no text in it — whoever read it.
  const empty = fixture({ file: "knowledge-base/scan.png", parsedText: " \n" });
  await empty.worker.tick();
  assert.deepEqual(empty.calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "publishUnderstanding"]);
  assert.deepEqual(empty.calls.at(-1).args.slice(1), [null, null, null, { original: "source_original_no_text" }]);

  // A scan whose OCR failed on every page is not that: it is a text read only in part, captured and said as such.
  const scan = fixture({ file: "knowledge-base/scan.pdf" });
  scan.worker.parser.parse = async (...args) => {
    scan.calls.push({ method: "parse", args });
    return { extractor: { name: "evimed-extract", version: "evimed-extract@0.5.0", parser: "api" }, text: "", summary: "",
      units: [{ id: "page-1", unitType: "page", status: "failed", itemIds: [] }], facts: [], methods: [] };
  };
  await scan.worker.tick();
  assert.deepEqual(scan.calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "publishUnderstanding"]);
  assert.deepEqual(scan.calls.at(-1).args.length, 4, "published as the capture it is, with no reason to be an original");

  // The same code without the parser's 415 is a failure of something else (a path that is not a file), and stays one.
  const broken = fixture({ parseError: Object.assign(new Error("The source is not a regular file."), { code: "source_format_unsupported", status: 400 }) });
  await broken.worker.tick();
  assert.deepEqual(broken.calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "recordFailure", "fail"]);
  assert.equal(broken.calls.at(-1).args[4].retry, false);
});

test("a file neither reader takes is handed to the engine's parsers under the account and the document's own id", async () => {
  /** @type {any[]} */
  const asked = [];
  const engineParser = async (...args) => { asked.push(args); return { text: "# src.zip\n\nREADME", files: [{ path: "README.md", chars: 6 }] }; };
  const { calls, worker } = fixture({ file: "knowledge-base/src.zip", engineParser,
    // The parser client decides the route from the bytes and calls the engine it was handed; this double does the same.
    afterParse: async ({ input }) => { await input.engine({ name: "src.zip", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), signal: input.signal }); } });
  await worker.tick();
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], "user-one");
  assert.deepEqual([asked[0][1].name, asked[0][1].token, asked[0][1].bytes.length], ["src.zip", "source-one", 4]);
  assert.ok(asked[0][1].signal instanceof AbortSignal, "the engine's read stops with the parse");
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "publishUnderstanding"], "what the engine read is captured like any other text");
});

test("a job waits for a runtime or budget instead of failing when none is free, and the document does not wait with it", async () => {
  // 2026-09-21: a knowledge-base upload was marked failed in 21 s because the
  // account's background work held every runtime slot.
  // `runtime_yielded`: the document's run had a runtime and a researcher's start
  // took it back; the run is released first (`SourceUnderstandingRuns`).
  for (const [code, delayMs] of [["runtime_limit_exceeded", 60_000], ["runtime_capacity_full", 60_000], ["runtime_proxy_limit_exceeded", 60_000], ["runtime_yielded", 60_000], ["usage_budget_exceeded", 3_600_000]]) {
    const { calls, source, worker } = fixture({ depth: "structured" });
    worker.understandingRuns = { execute: async () => { throw Object.assign(new Error("no room"), { code }); } };
    await worker.tick();
    calls.length = 0;
    await worker.tick();
    const methods = calls.map((call) => call.method);
    assert.deepEqual(methods, ["beginIngestion", "deferIngestion"], code);
    assert.equal(calls.find((call) => call.method === "deferIngestion").args[2], delayMs, code);
    assert.equal(source.payload.status, "complete", `${code}: the document's state is not held by the wait`);
    assert.equal(worker.status().lastError, null, code);
  }
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

test("canceling while the parser is streaming aborts owned transport and cannot publish or retry", async () => {
  const f = fixture();
  let aborted = false;
  f.worker.parser.parse = async ({ signal }) => new Promise((resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1000);
    setTimeout(() => { f.source.payload.status = "canceled"; f.source.payload.generation += 1; }, 10);
    signal.addEventListener("abort", () => { aborted = true; clearInterval(keepAlive); reject(Object.assign(new Error("Canceled"), { code: "source_parser_canceled" })); }, { once: true });
  });
  await f.worker.tick();
  assert.equal(aborted, true);
  assert.equal(f.calls.some(call => ["materialize", "publishUnderstanding", "recordFailure"].includes(call.method)), false);
  const failure = f.calls.find(call => call.method === "fail");
  assert.equal(failure.args[3].code, "source_generation_stale");
  assert.equal(failure.args[4].retry, false);
});

test("the structured materials of a parse are read from the same file under the parse's own cancellation and frozen with the capture", async () => {
  const seen = [];
  const materials = { extract: async (input) => { seen.push(input); return { coverage: { values: { total: 3 } }, structure: { textSha256: "f".repeat(64) }, tables: [] }; } };
  const { calls, worker, sources } = fixture({ materials });
  let frozen = null;
  const original = sources.freezeCapture;
  sources.freezeCapture = async (job, result) => { frozen = result; calls.push({ method: "freeze" }); return original(job, result); };
  await worker.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, "/data/users/user-one/paper.txt");
  assert.equal(seen[0].name, "paper.txt");
  assert.equal(seen[0].sha256, "a".repeat(64));
  assert.equal(seen[0].parserRevision, "plain-text@1.0.0");
  assert.equal(seen[0].text, "Parsed research source.\n\nFinding");
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.deepEqual(frozen.materials.coverage, { values: { total: 3 } });
  assert.deepEqual(calls.map((call) => call.method).filter((name) => ["parse", "freeze", "materialize"].includes(name)), ["parse", "freeze", "materialize"]);
  assert.equal(worker.status().lastError, null);
});

test("a defect in the materials extension is a source with no structure and a report, never a failed ingestion", async () => {
  const reports = [];
  const materials = { extract: async () => { throw Object.assign(new Error("boom"), { code: "materials_defect" }); } };
  const { calls, worker } = fixture({ materials, reports });
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "publishUnderstanding"]);
  assert.equal(worker.status().lastError, null);
  assert.deepEqual(reports, [{ event: "source_materials_failed", detail: { code: "materials_defect" } }]);
});

test("canceling while the materials are being read stops the ingestion like canceling the parse", async () => {
  /** @type {AbortSignal | null} */
  let signal = null;
  const materials = { extract: async (input) => {
    signal = input.signal;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      input.signal.addEventListener("abort", () => { clearTimeout(timer); reject(input.signal.reason); }, { once: true });
    });
  } };
  const { calls, source, worker } = fixture({ materials });
  const running = worker.tick();
  while (!signal) await new Promise((resolve) => setTimeout(resolve, 10));
  // The source is superseded: the worker's own check aborts the controller it handed the extension.
  source.payload.status = "canceled";
  await running;
  assert.equal(calls.some((call) => call.method === "materialize"), false);
  assert.equal(calls.some((call) => call.method === "publishUnderstanding"), false);
});
