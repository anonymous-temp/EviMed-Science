import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productJobs.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
// 2026-10-08, live: a job asked for in a project deleted a moment before failed on the foreign key, unclassified.
test("a job asked for in a project that was just deleted is told the project is gone", { skip: !url && "A disposable localhost test database is required" }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const owner = `deleted_project_${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Deleted project','development')", [owner]);
    const jobs = new ProductJobs(database);
    await assert.rejects(jobs.enqueue(owner, "evolution-build", { dossierId: "one" }, { idempotencyKey: owner, projectId: "p-gone" }),
      (error) => error.code === "project_not_found" && error.status === 404);
    // A job of no project is untouched by the rule.
    assert.ok((await jobs.enqueue(owner, "evolution-build", { dossierId: "two" }, { idempotencyKey: `${owner}-account` })).id);
  } finally { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]); await database.close(); }
});

// 2026-10-08, live: an account whose learning budget was spent held 23 hourly consolidation passes, each to run in turn.
test("a newer consolidation pass closes the hourly passes still waiting, and nothing else", { skip: !url && "A disposable localhost test database is required" }, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  const owner = `superseded_${randomUUID()}`;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Superseded passes','development')", [owner]);
    const jobs = new ProductJobs(database);
    const older = await jobs.enqueue(owner, "consolidate", { action: "sleep", date: "2026-10-08T01:00:00.000Z" }, { idempotencyKey: `${owner}-1` });
    const afterMethod = await jobs.enqueue(owner, "consolidate", { action: "sleep", date: "2026-10-08T01:30:00.000Z", after: "method-1" }, { idempotencyKey: `${owner}-m` });
    const evaluate = await jobs.enqueue(owner, "consolidate", { action: "evaluate" }, { idempotencyKey: `${owner}-e` });
    const newer = await jobs.enqueue(owner, "consolidate", { action: "sleep", date: "2026-10-08T02:00:00.000Z" }, { idempotencyKey: `${owner}-2` });
    assert.equal(await jobs.supersedeQueued(owner, "consolidate", "sleep", newer.id), 1);
    const closed = await jobs.get(owner, older.id);
    assert.equal(closed.status, "canceled");
    assert.equal(closed.result.supersededBy, newer.id);
    for (const kept of [afterMethod, evaluate, newer]) assert.equal((await jobs.get(owner, kept.id)).status, "queued");
  } finally { await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]); await database.close(); }
});
