// `pnpm rebuild:memory-index` is the whole recovery story for the recall index:
// the index holds nothing of its own, so a lost volume or a changed embedding
// model is repaired by running this and nothing else. That makes two properties
// worth a real process rather than a unit test of a function it does not
// export: that the command builds its store and its index client from the
// server's own configuration, and that it rebuilds BOTH halves — the research
// records it writes itself, and the capsule facts that go through the durable
// job the server's worker also claims. Rebuilding one half and reporting
// success is the failure this test exists to refuse.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createStore } from "../src/store.mjs";
import { parseCapsuleFactUri, parseMemoryUri } from "../src/openVikingClient.mjs";
import { loadConfig } from "../src/config.mjs";
import { startOpenVikingServer } from "./fixtures/openVikingServer.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/rebuild-memory-index.mjs");
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("the rebuild command restores both halves of the index from the control-plane database", options, async (t) => {
  const index = await startOpenVikingServer();
  const dataDir = await mkdtemp("/tmp/evimed-rebuild-index-");
  const userId = `rebuild${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const environment = {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_STATE_STORE: "postgres",
    OPEN_SCIENCE_DATABASE_URL: databaseUrl,
    OPEN_SCIENCE_RUNTIME_MODE: "mock",
    OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: "openviking",
    OPEN_SCIENCE_OPENVIKING_URL: index.url,
    OPEN_SCIENCE_OPENVIKING_API_KEY: index.apiKey,
  };
  const store = createStore(loadConfig({
    dataDir, stateStore: "postgres", databaseUrl, runtimeMode: "mock", authMode: "local", devAuth: false,
  }));
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await database.close();
    await store.close();
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await store.createUser(userId, "test-only-rebuild-password", "rebuild");
  const documents = new ProductDocuments(database);
  await documents.put(userId, "capsule", "capsule-one", { title: "a capsule", imported: false }, { expectedRevision: 0 });
  await documents.put(userId, "fact", "fact-one",
    { capsuleId: "capsule-one", factKind: "preference", layer: "stable", content: "prefers tables over prose", status: "approved" },
    { expectedRevision: 0 });
  const { ResearchMemoryStore } = await import("../src/researchMemory.mjs");
  const memory = new ResearchMemoryStore({}, { database });
  await memory.upsertRecord(userId, {
    scope: "user", scopeId: "", kind: "preference", key: "reporting.format",
    value: "prefers tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.8, sensitive: false,
  });

  const { stdout } = await run(process.execPath, [script, "--user", userId, "--json"], { env: environment });
  const summary = JSON.parse(stdout);
  assert.equal(summary.ok, true, stdout);
  assert.equal(summary.written, 1, "the research record was not written to the index");
  assert.equal(summary.capsules, 1, "the capsule half of the index was not rebuilt");
  assert.equal(summary.capsulesFailed, 0, stdout);

  // Read back through the same parsers recall uses: a file the index holds
  // under a path recall cannot parse is a file recall will never return.
  const written = [...index.files.keys()];
  assert.equal(written.filter((uri) => parseMemoryUri(uri)?.recordId).length, 1,
    `the research record copy is missing from ${written.join(", ")}`);
  assert.equal(written.filter((uri) => parseCapsuleFactUri(uri)?.factId === "fact-one").length, 1,
    `the capsule fact is missing from ${written.join(", ")}`);

  // The publication ledger is what the server's own worker reads to decide that
  // a capsule needs no work. A rebuild that left it behind would be reported as
  // done and then be undone by the next reconcile.
  const published = await database.query(
    "SELECT status,entry_count FROM evimed_product.memory_index_state WHERE user_id=$1 AND capsule_id=$2",
    [userId, "capsule-one"]);
  assert.equal(published.rows[0]?.status, "published");
  assert.equal(published.rows[0]?.entry_count, 1);

  // Running it again is the recovery case that matters: after a lost volume the
  // files are gone and the ledger still says published, and the command has to
  // write them again rather than believe the ledger.
  index.files.clear();
  const second = JSON.parse((await run(process.execPath, [script, "--user", userId, "--json"], { env: environment })).stdout);
  assert.equal(second.ok, true);
  assert.equal(index.files.size, 2, "a second run rebuilt nothing, so a lost index would stay lost");
});

test("the rebuild command refuses to run against a deployment with no index selected", options, async (t) => {
  const dataDir = await mkdtemp("/tmp/evimed-rebuild-index-");
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  // `builtin` is the term matcher: there is no index to rebuild, and the useful
  // answer is which provider the deployment is on rather than a stack trace.
  const result = await run(process.execPath, [script, "--user", "nobody", "--json"], {
    env: {
      ...process.env,
      OPEN_SCIENCE_DATA_DIR: dataDir,
      OPEN_SCIENCE_STATE_STORE: "postgres",
      OPEN_SCIENCE_DATABASE_URL: databaseUrl,
      OPEN_SCIENCE_RUNTIME_MODE: "mock",
      OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: "builtin",
      OPEN_SCIENCE_OPENVIKING_URL: "",
    },
  }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).status.provider, "builtin");
});
