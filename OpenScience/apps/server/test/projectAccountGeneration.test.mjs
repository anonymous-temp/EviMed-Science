import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PostgresStore } from "../src/store.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("Postgres project snapshots preserve exact account generation across every hydration path and default reuse", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-project-generation-"));
  const store = new PostgresStore({ dataDir, maxProjectBytes: 1024 * 1024,
    databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 3000 });
  const userId = `generation_${randomUUID()}`;
  t.after(async () => {
    await store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.database.migrate();
  const insert = async epoch => {
    const result = await store.database.query(`INSERT INTO evimed_control.users(id,name,auth_type,created_at)
      VALUES($1,'Generation fixture','development',$2::timestamptz) RETURNING created_at::text AS epoch`, [userId, epoch]);
    return result.rows[0].epoch;
  };
  const originalEpoch = await insert("2026-10-03T00:00:00.000111Z");
  const user = await store.userById(userId);
  const original = await store.projectFor(user, "default");
  assert.equal(original.accountCreatedAt, originalEpoch);
  assert.match(original.accountCreatedAt, /000111/);
  const required = await store.requireProject(user, "default");
  assert.equal(required.accountCreatedAt, originalEpoch);
  await store.createProject(user, "named", "Named project");
  assert.equal(store.projects.get(`${userId}:named`).accountCreatedAt, originalEpoch);
  const restored = (await store.listStoredProjects()).filter(project => project.userId === userId);
  assert.equal(restored.length, 2);
  assert.ok(restored.every(project => project.accountCreatedAt === originalEpoch));

  await store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  const replacementEpoch = await insert("2026-10-03T00:00:00.000222Z");
  assert.equal(Date.parse(originalEpoch), Date.parse(replacementEpoch), "fixture deliberately shares the same JS millisecond");
  assert.notEqual(originalEpoch, replacementEpoch);
  const replacementUser = await store.userById(userId);
  const replacement = await store.projectFor(replacementUser, "default");
  assert.equal(replacement.accountCreatedAt, replacementEpoch);
  assert.equal((await store.requireProject(replacementUser, "default")).accountCreatedAt, replacementEpoch);
  assert.equal(original.accountCreatedAt, originalEpoch, "old in-flight project keeps its original account provenance");
  assert.equal(required.accountCreatedAt, originalEpoch);
  assert.ok(restored.every(project => project.accountCreatedAt === originalEpoch));
});

test("projectFromRow copies the supplied SQL snapshot without querying current account state", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-project-generation-unit-"));
  const store = new PostgresStore({ dataDir, databaseUrl: "postgresql://postgres@127.0.0.1:1/evimed_test_unused",
    databasePoolMax: 1, databaseConnectionTimeoutMs: 100 });
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  store.database.query = async () => { throw new Error("Account generation must never be rehydrated later"); };
  const exact = "2026-10-03 00:00:00.123456+00";
  const user = { id: "fixture", rootDir: path.join(dataDir, "users", "fixture"), accountCreatedAt: "new-user-generation" };
  const project = await store.projectFromRow(user, { id: "default", name: "Fixture", quota_bytes: 1024,
    active_workspace: "", archived_at: null, account_created_at: exact });
  assert.equal(project.accountCreatedAt, exact);
  assert.notEqual(project.accountCreatedAt, user.accountCreatedAt);
});
