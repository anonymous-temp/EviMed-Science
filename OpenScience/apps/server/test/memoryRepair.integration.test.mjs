import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { correctMemoryOrigin, parseArguments } from "../../../scripts/ops/correct-memory-origin.mjs";

/**
 * Putting stored memory right after the 2026-09-26 audit, against a real
 * PostgreSQL: a record whose words were the platform's is relabelled as a
 * revision (M-2).
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const owner = `memory_repair_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Memory repair','development')", [owner]);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

/** The GEO record of 2026-09-25, as extraction wrote it. @param {string} projectId */
async function geoProductRecord(projectId) {
  return store.upsertRecord(owner, {
    scope: "project", scopeId: projectId, kind: "project_fact", key: "project.geo.product",
    value: "GEO 项目围绕信尔美（玛仕度肽注射液）开展，产品为一盒 2 支的处方药，需冷链。",
    summary: "GEO 项目围绕信尔美（玛仕度肽注射液）开展，产品为一盒 2 支的处方药，需冷链。",
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, lastConfirmedAt: "2026-09-25T18:42:00Z",
  }, { sourceType: "conversation_message", sourceRef: "sessions/session_2e114dd/messages/seq_9",
    quote: "产品：信尔美（通用名：玛仕度肽注射液）。", observedAt: "2026-09-25T18:42:00Z" }, { by: "extraction" });
}

test("an origin is corrected as a revision by the platform, and nothing the record says moves", options, async () => {
  const written = await geoProductRecord("geo-origin");
  assert.equal(written.provenance.basis, "stated", "shown as the researcher's words before");
  const { record, changed } = await store.correctOrigin(owner, written.id, { origin: "system", reason: "the evidence is a dispatch brief", expectedVersion: written.version });
  assert.equal(changed, true);
  assert.equal(record.origin, "system");
  assert.equal(record.confidence, 0.8);
  assert.equal(record.lastConfirmedAt, null, "no confirmation was ever given");
  assert.equal(record.value, written.value);
  assert.deepEqual(record.evidence.map((item) => item.quote), ["产品：信尔美（通用名：玛仕度肽注射液）。"]);
  assert.notEqual(record.provenance.basis, "stated");
  const revision = record.revisions.at(-1);
  assert.equal(revision.by, "system");
  assert.match(revision.reason, /^origin explicit -> system: the evidence is a dispatch brief/);
  assert.equal(record.version, written.version + 1);

  // Asking again changes nothing, and a stale version is refused.
  assert.equal((await store.correctOrigin(owner, written.id, { origin: "system", reason: "again" })).changed, false);
  await assert.rejects(store.correctOrigin(owner, written.id, { origin: "inferred", reason: "stale", expectedVersion: written.version }),
    { code: "memory_conflict" });
  await assert.rejects(store.correctOrigin(owner, written.id, { origin: "system", reason: "" }), { code: "memory_payload_invalid" });
});

test("the operator script reports by default, corrects with --apply, and finds nothing the second time", options, async () => {
  const target = await geoProductRecord("geo-script");
  const elsewhere = await geoProductRecord("geo-other");
  const report = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script"]));
  assert.equal(report.applied, false);
  assert.deepEqual(report.matched.map((item) => item.id), [target.id]);
  assert.equal((await store.getRecord(owner, target.id)).origin, "explicit", "a report writes nothing");

  const applied = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script", "--apply"]));
  assert.deepEqual(applied.corrected.map((item) => [item.id, item.origin, item.changed]), [[target.id, "system", true]]);
  assert.equal((await store.getRecord(owner, elsewhere.id)).origin, "explicit", "another project's record is not touched");
  const again = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script", "--apply"]));
  assert.deepEqual(again.matched, []);
  assert.throws(() => parseArguments(["--user", owner]), /--key/);
  assert.throws(() => parseArguments(["--user", owner, "--key", "k", "--from", "system"]), /same origin/);
});
