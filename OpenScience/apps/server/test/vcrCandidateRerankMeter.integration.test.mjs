// The reranker's spend reaches the usage ledger: a settled row under purpose `vcr`, for the study's owner, priced on the provider's token count (2026-11-04).
// The endpoint is a double; the ledger is the real one on PostgreSQL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { REFERENCE_PRICE_LIST } from '@evimed/domain';
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { VcrCandidateRerank, createRerankMeter, rerankBillFor, rerankCandidates } from "../src/vcrCandidateRerank.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `rerank_${randomUUID()}`;
/** @type {ControlPlaneDatabase} */
let database;
/** @type {UsageLedger} */
let ledger;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Rerank owner','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Rerank',1048576)", [owner]);
  ledger = new UsageLedger(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

const rows = () => database.query("SELECT purpose, operation, model, status, actual_cost::float8 AS cost, priced, cache_miss_tokens, output_tokens, provider_request_id, price_version FROM evimed_usage.model_requests WHERE user_id=$1 ORDER BY created_at", [owner]).then((result) => result.rows);

test("a rerank request is booked under purpose vcr at the provider's token count, one row for each request, for the study's owner", options, async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: 1 - index / 10 })), usage: { total_tokens: 2_000_000 }, request_id: "dash-1" }), { status: 200 });
  };
  const reranker = new VcrCandidateRerank({ apiKey: "k", model: "qwen3-rerank", apiBase: "https://dashscope.example.org/compatible-api/v1/reranks", batchSize: 2 }, { fetchImpl, report: () => {} });
  const study = { id: "vst_1", userId: owner, projectId: "default" };
  const candidates = ["a", "b", "c"].map((id) => ({ registryId: id, title: `t ${id}`, conditions: ["x"] }));
  const result = await rerankCandidates({ summary: "a patient", candidates }, { reranker, bill: (spend) => createRerankMeter(ledger)(study, spend) });
  assert.equal(result.state, "ranked");
  const booked = await rows();
  assert.equal(booked.length, 2, "two requests of at most two documents");
  for (const row of booked) {
    assert.equal(row.purpose, "vcr");
    assert.equal(row.operation, "candidate-rerank");
    assert.equal(row.model, "qwen3-rerank");
    assert.equal(row.status, "settled");
    assert.equal(row.priced, true);
    assert.equal(row.cost, 1, "2,000,000 tokens at ¥0.5 per million");
    assert.equal(Number(row.cache_miss_tokens), 2_000_000);
    assert.equal(Number(row.output_tokens), 0);
    assert.equal(row.provider_request_id, "dash-1");
    assert.equal(row.price_version, REFERENCE_PRICE_LIST.version);
  }
});

test("a rerank model with no price row is booked with its tokens and unpriced, and there is no meter without a ledger", options, async () => {
  const meter = createRerankMeter(ledger);
  await meter({ id: "vst_2", userId: owner, projectId: "default" }, { tokens: 500, requestId: null, model: "some-unpriced-reranker" });
  const last = (await rows()).at(-1);
  assert.equal(last.model, "some-unpriced-reranker");
  assert.equal(last.priced, false);
  assert.equal(last.cost, 0);
  assert.equal(Number(last.cache_miss_tokens), 500);
  assert.equal(createRerankMeter(null), null);
});

test("a conversation with no study yet is billed to its own account and run; with no account there is nobody to bill", options, async () => {
  const meter = createRerankMeter(ledger);
  const before = (await rows()).length;
  const bill = rerankBillFor(meter, { id: null, userId: owner, projectId: "default", scope: "conversation", executionOrigin: { runId: null } });
  assert.equal(typeof bill, "function");
  await bill({ tokens: 1_000, requestId: "dash-3", model: "qwen3-rerank" });
  assert.equal((await rows()).length, before + 1);
  assert.equal(rerankBillFor(meter, { id: null }), null);
  assert.equal(rerankBillFor(null, { id: "s", userId: owner, projectId: "default" }), null);
});
