import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createVcrTrialCorpus } from "../src/vcrTrialCorpus.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const trialId = (number) => `NCT${String(number).padStart(8, "0")}`;

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "vcr-trial-corpus-"));
  const manifestPath = join(path, "manifest.json");
  const databasePath = join(path, "trials.sqlite");
  t.after(() => rm(path, { recursive: true, force: true }));
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, nct_id TEXT UNIQUE, xml_sha256 TEXT, payload_sha256 TEXT, payload BLOB, archive TEXT);
    CREATE VIRTUAL TABLE terms USING fts5(title,condition,summary,description,eligibility,content='',tokenize='porter unicode61');
    BEGIN;
  `);
  const document = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)");
  const terms = db.prepare("INSERT INTO terms(rowid, title, condition, summary, description, eligibility) VALUES (?, ?, ?, ?, ?, ?)");
  for (let n = 1; n <= 600; n += 1) {
    const title = n === 101 ? "Diabetes Biomarker" : "Diabetes Study";
    const payload = {
      nct_id: trialId(n), title, condition: "Diabetes", eligibility: "Inclusion Criteria:\nAge 18 years or older.",
      summary: "Frozen summary", detailed_description: "Frozen detailed description",
      minimum_age: "18 Years", gender: "All", overall_status: "Completed", xml_sha256: hash(`xml ${n}`),
      qrels: "REFERENCE LABEL", contact_email: "private@example.test",
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    document.run(n, payload.nct_id, payload.xml_sha256, hash(bytes), deflateSync(bytes), "private-archive.zip");
    terms.run(n, title, payload.condition, "", "", payload.eligibility);
  }
  db.exec("COMMIT");
  db.close();
  const manifest = { version: 1, id: "snapshot-1", sourceVersion: "release-1", snapshotDate: "2021-04-27",
    databasePath: "trials.sqlite", databaseSha256: hash(await readFile(databasePath)) };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath };
}

test("frozen product evidence reads 500 deterministically ranked unique IDs in ten pages and resolves its exact original record", async (t) => {
  const { manifest, manifestPath } = await fixture(t);
  const trialCorpus = createVcrTrialCorpus(manifestPath);
  t.after(() => trialCorpus.close());
  let liveCalls = 0;
  const liveRegistry = { async record() { liveCalls += 1; }, async search() { liveCalls += 1; } };
  const pipeline = createVcrEvidencePipeline({ store: {}, registry: liveRegistry, trialCorpus });
  const filter = { collection: manifest.id, condition: "diabetes", terms: ["biomarker", "unmatched", "other", "unused"], limit: 500 };
  const service = new VcrService({ store: {}, config: { vcrCandidateSearchMax: 20 }, evidence: pipeline });
  const first = await service.runtimeRead({}, "candidates", filter);
  assert.equal(first.status, "ok");
  assert.equal(first.asOf, manifest.snapshotDate);
  assert.deepEqual(first.collection, { id: manifest.id, sourceVersion: manifest.sourceVersion,
    snapshotDate: manifest.snapshotDate, sourceFormat: "clinicaltrials-xml", databaseSha256: manifest.databaseSha256, revision: trialCorpus.revision });
  assert.equal(first.retrieval.totalMatched, 600);
  assert.equal(first.retrieval.truncated, true);
  assert.equal(first.retrieval.retrievedIds.length, 500);
  assert.equal(first.candidates[0].registryId, trialId(101));
  const ids = [];
  let page = first;
  for (let n = 0; n < 10; n += 1) {
    assert.equal(page.candidates.length, 50);
    ids.push(...page.candidates.map(({ registryId, rank }, offset) => {
      assert.equal(rank, n * 50 + offset + 1);
      return registryId;
    }));
    if (n < 9) page = await service.runtimeRead({}, "candidates", { ...filter, cursor: page.nextCursor });
  }
  assert.deepEqual(ids, first.retrieval.retrievedIds);
  assert.equal(new Set(ids).size, 500);
  assert.equal(page.nextCursor, null);
  assert.deepEqual((await pipeline.candidatesFor({}, filter)).retrieval, first.retrieval);
  for (const override of [{ terms: ["unrelated"] }, { limit: 450 }, { status: "open" }]) {
    assert.equal((await pipeline.candidatesFor({}, { ...filter, ...override, cursor: first.nextCursor })).reason, "trial_collection_cursor_invalid");
  }
  assert.equal((await pipeline.candidatesFor({}, { ...filter, collection: "different" })).reason, "trial_collection_unavailable");
  assert.equal((await pipeline.candidatesFor({}, { ...filter, limit: 501 })).code, "vcr_read_filter_invalid");
  const { collection, collectionRevision, registry, registryId } = first.candidates[0];
  const record = await pipeline.registryRecord({}, { collection, collectionRevision, registry, registryId: registryId.toLowerCase() });
  const exact = await pipeline.candidateRecord({ collection, collectionRevision, registry, registryId });
  assert.equal(record.record.registryId, exact.trial.registryId);
  assert.equal(record.record.eligibilityText, exact.trial.eligibilityText);
  assert.equal(record.sources[0].recordHash, exact.trial.recordHash);
  assert.equal(record.collection.databaseSha256, manifest.databaseSha256);
  assert.equal(record.collection.sourceSha256, record.collection.xmlSha256);
  assert.deepEqual(record.record.description, { briefSummary: "Frozen summary", detailedDescription: "Frozen detailed description" });
  assert.doesNotMatch(JSON.stringify(record), /qrels|REFERENCE LABEL|private@example\.test|private-archive\.zip|trials\.sqlite/);
  assert.equal((await pipeline.registryRecord({}, { collection, collectionRevision, registryId: trialId(1000) })).status, "registry_not_found");
  assert.equal((await pipeline.candidateRecord({ collection, collectionRevision, registryId: trialId(1000) })).status, "registry_not_found");
  assert.equal(liveCalls, 0);

  await writeFile(manifestPath, JSON.stringify({ ...manifest, sourceVersion: "release-2", sourceFormat: "trialgpt-json" }));
  const newer = createVcrTrialCorpus(manifestPath);
  t.after(() => newer.close());
  const newerPipeline = createVcrEvidencePipeline({ store: {}, trialCorpus: newer });
  const oldCursor = await newerPipeline.candidatesFor({}, { ...filter, cursor: first.nextCursor });
  assert.equal(oldCursor.reason, "trial_collection_cursor_invalid");
  const wrongRevision = await newerPipeline.candidateRecord({ collection, collectionRevision, registry, registryId });
  assert.equal(wrongRevision.reason, "trial_collection_revision_mismatch");
  const noRevision = await pipeline.registryRecord({}, { collection, registry, registryId });
  assert.equal(noRevision.reason, "trial_collection_revision_mismatch");
  const newerRecord = await newerPipeline.candidateRecord({ collection, collectionRevision: newer.revision, registry, registryId });
  assert.notEqual(newerRecord.trial.recordHash, exact.trial.recordHash);
  assert.equal(newerRecord.collection.sourceSha256, record.collection.sourceSha256);
  assert.equal(newerRecord.collection.xmlSha256, undefined);
});

test("frozen evidence refuses a wrong manifest version or database hash", async (t) => {
  const { manifest, manifestPath } = await fixture(t);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 2 }));
  assert.throws(() => createVcrTrialCorpus(manifestPath), { code: "trial_collection_manifest_invalid" });
  await writeFile(manifestPath, JSON.stringify({ ...manifest, databaseSha256: "a".repeat(64) }));
  const trialCorpus = createVcrTrialCorpus(manifestPath);
  t.after(() => trialCorpus.close());
  await assert.rejects(trialCorpus.record(trialId(1)), { code: "trial_collection_index_hash_mismatch" });
});

test("frozen worker caps pending calls and removes aborted queued requests without interrupting active work", async (t) => {
  const { manifestPath } = await fixture(t);
  const corpus = createVcrTrialCorpus(manifestPath);
  t.after(() => corpus.close());
  const queueAbort = new AbortController();
  const records = Array.from({ length: 8 }, (_, index) => corpus.record(trialId(index + 1), index === 7 ? queueAbort.signal : undefined));
  const settled = Promise.allSettled(records);
  await assert.rejects(corpus.record(trialId(9)), { code: "trial_collection_busy" });
  queueAbort.abort();
  const replacement = corpus.record(trialId(9));
  const results = await settled;
  assert.ok(results.slice(0, 7).every(({ status }) => status === "fulfilled"));
  assert.equal(results[7].reason.code, "trial_collection_read_aborted");
  assert.equal((await replacement).precedent.registryId, trialId(9));
});

test("aborting active work retires its worker, settles queued calls, and lets later calls reopen the index", async (t) => {
  const { manifestPath } = await fixture(t);
  const corpus = createVcrTrialCorpus(manifestPath);
  t.after(() => corpus.close());
  const activeAbort = new AbortController();
  const active = corpus.record(trialId(1), activeAbort.signal);
  const queued = corpus.record(trialId(2));
  const rejected = Promise.all([
    assert.rejects(active, { code: "trial_collection_read_aborted" }),
    assert.rejects(queued, { code: "trial_collection_read_aborted" }),
  ]);
  activeAbort.abort();
  await rejected;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assert.equal((await corpus.record(trialId(3))).precedent.registryId, trialId(3));
      return;
    } catch (error) {
      assert.equal(error.code, "trial_collection_busy");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail("Retired corpus worker did not release admission");
});

test("frozen worker enforces its deadline and closes with all pending callers settled", async (t) => {
  const { manifestPath } = await fixture(t);
  const timed = createVcrTrialCorpus(manifestPath, { timeoutMs: 1 });
  t.after(() => timed.close());
  await assert.rejects(timed.record(trialId(1)), { code: "trial_collection_read_timeout" });

  const corpus = createVcrTrialCorpus(manifestPath);
  const pending = Promise.all([
    assert.rejects(corpus.record(trialId(1)), { code: "trial_collection_worker_closed" }),
    assert.rejects(corpus.record(trialId(2)), { code: "trial_collection_worker_closed" }),
  ]);
  await corpus.close();
  await pending;
  await assert.rejects(corpus.record(trialId(3)), { code: "trial_collection_worker_closed" });
});
