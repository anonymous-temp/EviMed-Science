import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { handbookSummary } from "../src/learningMetrics.mjs";
import { LearningService } from "../src/learningService.mjs";
import { HandbookConsolidation, capabilityHandbookId } from "../src/handbookConsolidation.mjs";
import { frontmatter, BODY, registry } from "./helpers/handbookFixture.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
let database; let documents; let jobs; let learning;
const owners = [];
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  documents = new ProductDocuments(database); jobs = new ProductJobs(database); learning = new LearningService({ documents, jobs });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [owners]); await database.close(); } });
async function setup() {
  const owner = `handbook_${randomUUID()}`; owners.push(owner);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Handbook test','development')", [owner]);
  const input = { frontmatter, body: BODY, capabilityId: "geo-content", provenance: { runId: "source-run", sourceProjectId: "source-project" } };
  const candidate = await learning.recordHandbookCandidate(owner, input);
  // Claim only this test's job: unrelated suites may share the isolated DB.
  const rows = await database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='consolidate'", [owner]);
  const id = rows.rows[0].id;
  await database.query("UPDATE evimed_product.jobs SET status='running',lease_token='test-lease',lease_expires_at=clock_timestamp()+interval '1 minute',attempts=1 WHERE user_id=$1 AND id=$2", [owner,id]);
  const job = await jobs.get(owner, id);
  const loop = new HandbookConsolidation({ learning, jobs, registry, resolveSourceRun: async () => ({ id: "source-run", effectiveAgentId: "geo-content" }) });
  return { owner, input, candidate, job, loop };
}

test("Postgres applies supplement, disposition and job exactly once in the same transaction", options, async () => {
  const f = await setup();
  const result = await f.loop.run({ job: f.job });
  assert.equal(result.disposition, "applied");
  const summary = await handbookSummary(database, f.owner);
  assert.equal(summary.applied, 1);
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.verifiedImprovement, 0);
  assert.equal(summary.recent[0].source.runId, "source-run");
  assert.equal((await jobs.get(f.owner, f.job.id)).status, "succeeded");
  const row = await documents.get(f.owner, "method", result.handbookId);
  assert.equal(row.payload.contentDigest, f.candidate.payload.contentDigest);
  await f.loop.run({ job: f.job });
  await learning.recordHandbookCandidate(f.owner, f.input);
  assert.equal((await documents.get(f.owner, "method", row.id)).revision, 1);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id=$1", [f.owner])).rows[0].n, 1);
  assert.equal((await documents.get(f.owner, "method", f.candidate.id)).payload.dispositions[f.candidate.payload.contentDigest].disposition, "applied");
});

test("Postgres expired leases and failed writes commit neither application nor disposition", options, async () => {
  const f = await setup();
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner, f.job.id]);
  await assert.rejects(f.loop.run({ job: f.job }), { code: "product_job_lease_lost" });
  assert.equal(await documents.get(f.owner, "method", capabilityHandbookId("geo-content", frontmatter.name)), null);
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE user_id=$1 AND id=$2", [f.owner, f.job.id]);
  const put = documents.put.bind(documents);
  documents.put = async (...args) => { if (args[3]?.recordType === "capability-handbook") throw new Error("Injected write failure"); return put(...args); };
  try { await assert.rejects(f.loop.run({ job: f.job }), /Injected write failure/); } finally { documents.put = put; }
  assert.equal((await documents.get(f.owner, "method", f.candidate.id)).payload.dispositions[f.candidate.payload.contentDigest].state, "queued");
  assert.equal((await jobs.get(f.owner, f.job.id)).status, "running");
  assert.equal((await f.loop.run({ job: f.job })).disposition, "applied");
});

test("Postgres concurrent candidate amendment cannot be replaced by the old evaluated result", options, async () => {
  const f = await setup();
  f.loop.evaluate = async ({ binding }) => {
    await learning.recordHandbookCandidate(f.owner, { ...f.input, body: `${BODY}\nA newer lesson.` });
    return { ...binding, verdict: "better", report: "reports/mock.json" };
  };
  assert.equal((await f.loop.run({ job: f.job })).disposition, "stale");
  const row = await documents.get(f.owner, "method", f.candidate.id);
  assert.match(row.payload.body, /newer lesson/);
  assert.equal(row.payload.dispositions[f.candidate.payload.contentDigest].disposition, "stale");
  assert.equal(await documents.get(f.owner, "method", capabilityHandbookId("geo-content", frontmatter.name)), null);
});

test("Postgres account deletion while evaluating prevents any application", options, async () => {
  const f = await setup();
  f.loop.evaluate = async ({ binding }) => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [f.owner]);
    return { ...binding, verdict: "better", report: "reports/mock.json" };
  };
  await assert.rejects(f.loop.run({ job: f.job }), { code: "handbook_candidate_unavailable" });
  assert.equal(await documents.get(f.owner, "method", capabilityHandbookId("geo-content", frontmatter.name)), null);
});

test("Postgres handbook metrics count the entire owner ledger beyond the recent-card page", options, async () => {
  const f = await setup();
  const result = await f.loop.run({ job: f.job });
  const original = await documents.get(f.owner, "method", result.handbookId);
  await documents.createBatch(f.owner, Array.from({ length: 60 }, (_, index) => ({ kind: "method", id: `${original.id}-${index}`, payload: original.payload })));
  const summary = await handbookSummary(database, f.owner);
  assert.equal(summary.applied, 61);
  assert.equal(summary.recent.length, 6);
  assert.equal((await handbookSummary(database, "missing-owner")).applied, 0);
});

test("Postgres stale completion and its single retry survive an enqueue failure atomically", options, async () => {
  const f = await setup();
  const enqueue = jobs.enqueue.bind(jobs);
  jobs.enqueue = async (...args) => { if (args[2]?.retryOf) throw new Error("Injected retry enqueue failure"); return enqueue(...args); };
  const stale = { action: "optimize", disposition: "stale", reason: "handbook_baseline_changed", candidateDigest: f.candidate.payload.contentDigest };
  try { await assert.rejects(f.loop.complete(f.job, f.candidate, stale), /Injected retry enqueue failure/); } finally { jobs.enqueue = enqueue; }
  assert.equal((await jobs.get(f.owner, f.job.id)).status, "running", "a retry cannot be lost after a committed completion");
  assert.equal((await documents.get(f.owner, "method", f.candidate.id)).payload.dispositions[f.candidate.payload.contentDigest].state, "queued");
  await f.loop.complete(f.job, f.candidate, stale);
  await f.loop.reconcile(f.owner);
  const retry = await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'retryOf'=$2", [f.owner,f.job.id]);
  assert.equal(retry.rows.length, 1);
});
