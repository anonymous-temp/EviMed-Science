// `pnpm rebuild:frontier-index` is the whole recovery story for the frontier
// feed's vectors: the backup leaves their rows out (plan §10.4.6), and the
// pipeline refills only what it published in the last 30 days. So the
// properties worth a real database are the ones a restore depends on — every
// published item without a current vector gets one, in bounded batches; a
// second run embeds nothing; a vector of another model counts as missing; the
// text embedded is the pipeline's own; a provider that refuses stops the run
// instead of being asked once per batch for the whole archive; and two runs
// never pay for the same embeddings at once.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { frontierEmbeddingText, parseArguments, rebuildFrontierIndex, REBUILD_BATCH } from "../../../scripts/ops/rebuild-frontier-index.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/rebuild-frontier-index.mjs");
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DIMENSION = 1024;
const MODEL = `synthetic-embedding@${DIMENSION}`;

/** @type {{ name: string, database: ControlPlaneDatabase }[]} */
const opened = [];
after(async () => {
  if (!databaseUrl) return;
  for (const { database } of opened) await database.close();
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    for (const { name } of opened) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

/** A database of its own with the frontier schema migrated and one source. */
async function frontierDatabase() {
  const name = `evimed_test_rebuild_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const database = new ControlPlaneDatabase({ databaseUrl: url.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  opened.push({ name, database });
  const capabilities = await migrateFrontier(database, { dimension: DIMENSION });
  assert.equal(capabilities.vector, true, "the vector table exists only with pgvector");
  await insertSource(database, "nejm");
  return database;
}

/** An embedder that records what it was asked and fails the calls `fails` names. */
function recordingEmbedder({ modelKey = MODEL, fails = (/** @type {number} */ _call) => false } = {}) {
  /** @type {string[][]} */
  const calls = [];
  return {
    modelKey, dimension: DIMENSION, configured: true, calls,
    /** @param {string[]} texts */
    async embedDocuments(texts) {
      calls.push(texts);
      if (fails(calls.length)) throw Object.assign(new Error("synthetic provider outage"), { code: "kb_embedding_unavailable" });
      return texts.map((text) => Array.from({ length: DIMENSION }, (_, position) => (position === text.length % DIMENSION ? 1 : 0)));
    },
  };
}

/** @param {ControlPlaneDatabase} database */
async function vectors(database) {
  const result = await database.query(`SELECT i.title_raw, v.model_key FROM evimed_frontier.item_vectors v
    JOIN evimed_frontier.items i ON i.id = v.item_id ORDER BY i.title_raw`);
  return Object.fromEntries(result.rows.map((row) => [row.title_raw, row.model_key]));
}

/** @param {ControlPlaneDatabase} database @param {string} id @param {string} modelKey */
async function storeVector(database, id, modelKey) {
  await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, $2, $3)",
    [id, modelKey, `[${Array.from({ length: DIMENSION }, () => 0.5).join(",")}]`]);
}

test("the command takes --all and nothing else", () => {
  assert.deepEqual(parseArguments([]), { all: false });
  assert.deepEqual(parseArguments(["--all"]), { all: true });
  for (const argv of [["--user", "someone"], ["--everything"], ["all"]]) {
    assert.throws(() => parseArguments(argv), /unknown argument/);
  }
  assert.equal(REBUILD_BATCH, 16, "the pipeline's own batch");
});

test("the embedded text is the card's title and summary, the Chinese where there is one", () => {
  assert.equal(frontierEmbeddingText({ title_raw: "Original", title_zh: "中文标题", summary_zh: "中文摘要" }), "中文标题\n中文摘要");
  assert.equal(frontierEmbeddingText({ title_raw: "Original", title_zh: null, summary_zh: null }), "Original");
  assert.equal(frontierEmbeddingText({ title_raw: "Original", title_zh: null, summary_zh: "中文摘要" }), "Original\n中文摘要");
});

test("a rebuild embeds every published item without a current vector, in bounded batches, and a second run embeds nothing", options, async () => {
  const database = await frontierDatabase();
  const a = await insertItem(database, { title: "A", titleZh: "甲", summaryZh: "甲的摘要" });
  const b = await insertItem(database, { title: "B" });
  const c = await insertItem(database, { title: "C", titleZh: "丙" });
  const current = await insertItem(database, { title: "D" });
  const stale = await insertItem(database, { title: "E", titleZh: "戊", summaryZh: "戊的摘要" });
  await insertItem(database, { title: "W", state: "withdrawn" });
  await storeVector(database, current.id, MODEL);
  // A vector of another model is not comparable with a query of this one:
  // missing, by the pipeline's own test.
  await storeVector(database, stale.id, "retired-embedding@1024");

  const embedder = recordingEmbedder();
  const first = await rebuildFrontierIndex({ database, embedder, batchSize: 2 });
  assert.deepEqual({ ...first, failures: undefined }, { locked: false, scope: "missing", modelKey: MODEL, scanned: 4, embedded: 4,
    failed: 0, batches: 2, stopped: null, failures: undefined, remaining: 0 });
  assert.deepEqual(embedder.calls.map((texts) => texts.length), [2, 2], "two bounded batches, not one call for the archive");
  assert.deepEqual(embedder.calls.flat(), ["甲\n甲的摘要", "B", "丙", "戊\n戊的摘要"], "in id order, the card's text");
  assert.deepEqual(await vectors(database), { A: MODEL, B: MODEL, C: MODEL, D: MODEL, E: MODEL },
    "every published item has a vector of this model; the withdrawn one has none");
  assert.ok([a, b, c].every((item) => item.id));

  const again = recordingEmbedder();
  const second = await rebuildFrontierIndex({ database, embedder: again, batchSize: 2 });
  assert.equal(second.scanned, 0);
  assert.equal(second.embedded, 0);
  assert.equal(again.calls.length, 0, "a second run pays for nothing");

  const everything = recordingEmbedder();
  const all = await rebuildFrontierIndex({ database, embedder: everything, all: true });
  assert.equal(all.scope, "all");
  assert.equal(all.embedded, 5, "--all replaces every published item's vector, current or not");
  assert.equal(everything.calls.length, 1, "five items fit one batch of sixteen");
});

test("the rebuild embeds exactly the text the pipeline embeds when it publishes", options, async () => {
  // Two writers of one table: a rebuilt vector and a fresh one must be the
  // embedding of the same text, or search ranks the two by different measures.
  const database = await frontierDatabase();
  for (const [title, titleZh, summaryZh] of [["One", "一", "一的摘要"], ["Two", null, null], ["Three", "三", null], ["Four", null, "四的摘要"]]) {
    await insertItem(database, { title, titleZh, summaryZh, timelineAt: "2026-09-22T01:00:00Z" });
  }
  const fromPipeline = recordingEmbedder();
  const pipeline = new FrontierPipeline({
    database, embedder: fromPipeline, config: { kbEmbeddingDimension: DIMENSION },
    editor: { available: false, screen: async () => { throw new Error("not used"); }, edit: async () => { throw new Error("not used"); } },
    plugin: { text: async () => { throw new Error("not used"); } },
    glossary: { current: async () => null },
    now: () => new Date("2026-09-22T12:00:00Z"),
  });
  const summary = await pipeline.processBatch();
  assert.equal(summary.embedded, 4, "the pipeline's embed step ran over the four items");
  await database.query("DELETE FROM evimed_frontier.item_vectors");

  const fromRebuild = recordingEmbedder();
  const rebuilt = await rebuildFrontierIndex({ database, embedder: fromRebuild });
  assert.equal(rebuilt.embedded, 4);
  assert.deepEqual(fromRebuild.calls.flat().sort(), fromPipeline.calls.flat().sort());
});

test("failed batches are counted and the next run finishes them; three in a row stop the run", options, async () => {
  const database = await frontierDatabase();
  for (const title of ["P", "Q", "R", "S", "T"]) await insertItem(database, { title });

  const refusing = recordingEmbedder({ fails: () => true });
  const stopped = await rebuildFrontierIndex({ database, embedder: refusing, batchSize: 1 });
  assert.equal(stopped.stopped, "kb_embedding_unavailable");
  assert.equal(refusing.calls.length, 3, "a refusing provider is asked three times, not once per item");
  assert.equal(stopped.failed, 3);
  assert.deepEqual(stopped.failures, { kb_embedding_unavailable: 3 });
  assert.equal(stopped.remaining, 5);

  const flaky = recordingEmbedder({ fails: (call) => call === 2 });
  const partial = await rebuildFrontierIndex({ database, embedder: flaky, batchSize: 1 });
  assert.equal(partial.stopped, null, "one failure is not a pattern");
  assert.equal(partial.embedded, 4);
  assert.equal(partial.failed, 1);
  assert.equal(partial.remaining, 1, "what failed is still missing, and reported as such");

  const finished = await rebuildFrontierIndex({ database, embedder: recordingEmbedder(), batchSize: 1 });
  assert.equal(finished.embedded, 1);
  assert.equal(finished.remaining, 0);
});

test("a second rebuild beside a running one embeds nothing", options, async () => {
  const database = await frontierDatabase();
  await insertItem(database, { title: "Held" });
  const holder = await database.pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtext('evimed-frontier-rebuild'))");
    const embedder = recordingEmbedder();
    const refused = await rebuildFrontierIndex({ database, embedder });
    assert.equal(refused.locked, true);
    assert.equal(embedder.calls.length, 0);
    await holder.query("SELECT pg_advisory_unlock(hashtext('evimed-frontier-rebuild'))");
  } finally {
    holder.release();
  }
  const released = await rebuildFrontierIndex({ database, embedder: recordingEmbedder() });
  assert.equal(released.locked, false);
  assert.equal(released.embedded, 1);
});

test("the command says why it cannot run: the module off, or no embedding key", async () => {
  const environment = { ...process.env, OPEN_SCIENCE_DASHSCOPE_API_KEY: "", OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE: "" };
  const off = await run(process.execPath, [script], { env: { ...environment, OPEN_SCIENCE_FRONTIER_ENABLED: "false" } })
    .then(() => null, (error) => error);
  assert.ok(off, "the module off is a non-zero exit");
  assert.match(JSON.parse(off.stdout).reason, /OPEN_SCIENCE_FRONTIER_ENABLED is false/);
  const keyless = await run(process.execPath, [script, "--all"], { env: { ...environment, OPEN_SCIENCE_FRONTIER_ENABLED: "true" } })
    .then(() => null, (error) => error);
  assert.ok(keyless);
  assert.match(JSON.parse(keyless.stdout).reason, /no DashScope key/);
  const unknown = await run(process.execPath, [script, "--user", "x"], { env: environment }).then(() => null, (error) => error);
  assert.ok(unknown);
  assert.match(unknown.stderr, /unknown argument --user/);
});
