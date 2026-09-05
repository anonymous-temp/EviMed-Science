import assert from "node:assert/strict";
import test from "node:test";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";

function fixture({ sourceStatus = "queued", sourceRevision = 1, jobRevision = sourceRevision, parseError = null } = {}) {
  const calls = [];
  const job = { id: "job-one", userId: "user-one", projectId: "project-one", kind: "ingest",
    payload: { sourceId: "source-one", sourceRevision: jobRevision, extractorVersion: "evimed-analysis-1.0.0" },
    leaseToken: "lease-one", attempts: 1 };
  const source = { id: "source-one", revision: sourceRevision, projectId: "project-one", payload: {
    status: sourceStatus, paths: ["knowledge-base/paper.txt"], fingerprint: { sha256: "a".repeat(64), mimeType: "text/plain" },
  } };
  const jobs = {
    claim: async () => job,
    renew: async () => true,
    finish: async (...args) => { calls.push({ method: "finish", args }); return { status: "succeeded" }; },
    fail: async (...args) => { calls.push({ method: "fail", args }); return { status: "failed" }; },
  };
  const sources = {
    get: async () => source,
    beginIngestion: async (...args) => { calls.push({ method: "beginIngestion", args }); return { ...source, revision: source.revision + 1, payload: { ...source.payload, status: "parsing" } }; },
    recordExtraction: async (...args) => { calls.push({ method: "recordExtraction", args }); return { ...source, revision: source.revision + 1 }; },
    recordFailure: async (...args) => { calls.push({ method: "recordFailure", args }); return { ...source, revision: source.revision + 1 }; },
  };
  const parser = {
    parse: async (...args) => {
      calls.push({ method: "parse", args });
      if (parseError) throw parseError;
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
  const worker = new SourceIngestionWorker({ jobs, sources, parser, resolveSource, materialize, pollMs: 100, leaseMs: 1000 });
  return { calls, job, source, worker };
}

test("an ingest lease parses, accounts, materializes and finishes exactly once", async () => {
  const { calls, worker } = fixture();
  await worker.tick();
  assert.deepEqual(calls.map((call) => call.method), ["beginIngestion", "resolve", "parse", "materialize", "recordExtraction", "finish"]);
  const extraction = calls.find((call) => call.method === "recordExtraction").args[2];
  assert.equal(extraction.facts, 1);
  assert.equal(extraction.methods, 0);
  assert.equal(extraction.artifactPath, "knowledge-base/.evimed-derived/source-one/index.md");
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
