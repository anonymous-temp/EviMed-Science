import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID, PLATFORM_ACCOUNT_AUTH_TYPE } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { OPENVIKING_PROJECT_ID } from "../src/internalProjects.mjs";
import { OpenVikingCompileAuthority } from "../src/openVikingCompileAuthority.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const hash = text => createHash("sha256").update(text).digest("hex");

test("global qualification authority survives restart and uses the held single connection for atomic historical publication", {
  skip: !databaseUrl && "Dedicated local PostgreSQL required", timeout: 30000,
}, async t => {
  const isolated = await createGeoTestDatabase(databaseUrl, "compileauthority");
  const db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
  const other = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
  t.after(async () => { await db.close(); await other.close(); await isolated.drop(); });
  await db.migrate();
  assert.equal((await db.query("SELECT auth_type FROM evimed_control.users WHERE id=$1", [PLATFORM_PUBLISHER_USER_ID])).rows[0].auth_type, PLATFORM_ACCOUNT_AUTH_TYPE);
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Engine fixture',1000000) ON CONFLICT(user_id,id) DO NOTHING", [PLATFORM_PUBLISHER_USER_ID, OPENVIKING_PROJECT_ID]);
  const binding = { imageDigest: `sha256:${hash("image")}`, engineVersion: "fixture", configDigest: hash("config"),
    qualificationDigest: hash("proof"), upstreamCommit: "a".repeat(40), skillSha256: hash("llm-wiki") };
  const dependencies = { ensureOwner: async () => ({ userId: PLATFORM_PUBLISHER_USER_ID, projectId: OPENVIKING_PROJECT_ID }),
    scopeDigest: hash("fixed endpoint"), isCurrentBinding: value => value?.qualificationDigest === binding.qualificationDigest,
    readConfigurationDigest: async () => binding.configDigest };
  const authority = new OpenVikingCompileAuthority({ ...dependencies, documents: new ProductDocuments(db) });
  await authority.record(await authority.snapshot(), { state: "qualified", skill: "llm-wiki", binding });
  const reference = await authority.reference("llm-wiki", binding);
  assert.ok(reference);
  const restarted = new OpenVikingCompileAuthority({ ...dependencies, documents: new ProductDocuments(db) });
  await db.transaction(client => db.withTransactionClient(client, async () => {
    assert.deepEqual(await restarted.completed("llm-wiki", binding, reference, client), binding);
    assert.equal((await db.query("SELECT 1 AS value")).rows[0].value, 1);
  }));
  const writer = new OpenVikingCompileAuthority({ ...dependencies, documents: new ProductDocuments(other) });
  const snapshot = await writer.snapshot();
  let entered, release, committed = false;
  const reading = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const held = db.transaction(client => db.withTransactionClient(client, async () => {
    assert.deepEqual(await restarted.completed("llm-wiki", binding, reference, client), binding);
    entered(); await released;
  }));
  await reading;
  const revoke = writer.record(snapshot, { state: "rejected", scope: "environment", code: "unsafe_configuration" })
    .then(result => { committed = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(committed, false, "revocation and selected-pointer publication serialize on the held authority row");
  } finally { release(); }
  await held; assert.ok(await revoke);
  assert.equal(await restarted.completed("llm-wiki", binding, reference), null);
  assert.equal(await authority.record(snapshot, { state: "qualified", skill: "llm-wiki", binding }), null,
    "a stale positive cannot revive a newer rejection");
  assert.equal((await authority.snapshot()).value.environment.state, "revoked");
});
