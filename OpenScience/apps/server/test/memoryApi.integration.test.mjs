// The memory routes, over the real store, on a real database.
//
// These used to run against an HTTP fake of a separate memory service, which
// could only ever prove that the routes spoke that service's dialect. The store
// is in-process now, so what is worth proving is what a researcher does: write a
// note and get it back, confirm an inference the product made about them,
// refuse an edit that raced another, and have a deleted project take its
// memories with it. Every one of those crosses the route, the store and the
// database together, and none of them is decidable in any single layer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 20_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** The real app, a real account, and a signed-in browser's headers. */
async function fixture(t) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-memory-api-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl,
  });
  const username = `memory${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "test-only-memory-password";
  const user = await app.store.createUser(username, password, "Memory fixture");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const auth = await login.json();
  const headers = {
    "content-type": "application/json",
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken,
  };
  return { app, base, headers, user };
}

test("the memory dashboard's note lifecycle works end to end", options, async (t) => {
  const { base, headers } = await fixture(t);

  const status = await (await fetch(`${base}/api/memory/status`, { headers })).json();
  assert.deepEqual(status.data, { configured: true, connected: true, code: null, structured: true },
    "the status page reads these four fields; a store on the database answers all four");

  const created = (await (await fetch(`${base}/api/memory/memos`, {
    method: "POST", headers, body: JSON.stringify({ content: "长期研究偏好：优先核对系统综述。 #循证" }),
  })).json()).data;
  assert.equal(created.content, "长期研究偏好：优先核对系统综述。 #循证");
  assert.deepEqual(created.tags, ["循证"], "a tag the researcher wrote must come back as a tag");

  assert.equal((await (await fetch(`${base}/api/memory/memos`, { headers })).json()).data.length, 1);

  const pinned = await fetch(`${base}/api/memory/memos/${created.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
  });
  assert.equal(pinned.status, 200);
  assert.equal((await pinned.json()).data.pinned, true);

  await fetch(`${base}/api/memory/memos/${created.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ state: "archived" }),
  });
  const archived = (await (await fetch(`${base}/api/memory/memos?state=archived`, { headers })).json()).data;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].state, "archived");
  assert.deepEqual((await (await fetch(`${base}/api/memory/memos`, { headers })).json()).data, [],
    "an archived note is out of the default list, not deleted");

  const removed = await fetch(`${base}/api/memory/memos/${created.id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/memory/memos?state=archived`, { headers })).json()).data, []);
});

test("a pending inference is confirmed by the researcher, and a raced edit is refused", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const pending = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "response.evidence_depth",
    value: "Prefer primary evidence and explicit uncertainty.",
    summary: "Primary evidence first; uncertainty must remain visible.",
    origin: "inferred", status: "pending", confidence: 0.7, importance: 0.9, sensitive: false,
  }, {
    sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1",
    quote: "优先给原始证据，并明确保留不确定性。", observedAt: new Date().toISOString(), weight: 1,
  });

  const profile = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  assert.equal(profile.pendingCount, 1);
  assert.equal(profile.groups.preference[0].id, pending.id);

  const confirmed = (await (await fetch(`${base}/api/memory/records/${pending.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: pending.version, status: "active" }),
  })).json()).data;
  // Confirming an inference is the researcher taking ownership of it: the origin
  // stops being the product's guess and the confidence stops being a score.
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.origin, "explicit");
  assert.equal(confirmed.confidence, 1);
  assert.equal(confirmed.version, pending.version + 1);

  const stale = await fetch(`${base}/api/memory/records/${pending.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: pending.version, value: "something else" }),
  });
  assert.equal(stale.status, 409, "an edit against the version that was already replaced must not win");
  assert.equal((await stale.json()).code, "memory_conflict");

  const filtered = (await (await fetch(`${base}/api/memory/records?status=active&kind=preference`, { headers })).json()).data;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].evidence.length, 1, "the quote the inference was drawn from travels with it");

  assert.equal((await fetch(`${base}/api/memory/records/${pending.id}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data.records.length, 0);
});

test("deleting a project deletes its memory and leaves personal memory alone", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const projectId = "project-memory-delete";
  assert.equal((await fetch(`${base}/api/projects`, {
    method: "POST", headers, body: JSON.stringify({ id: projectId, name: "Project memory deletion" }),
  })).status, 200);

  await app.researchMemory.upsertRecord(user.id, {
    scope: "project", scopeId: projectId, kind: "run_summary", key: "run.project-delete",
    value: "project run", summary: "project run", origin: "system", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  await app.researchMemory.create(user.id, `# EviMed agent run\n- Project: ${projectId}\n#evimed-agent-run`);
  await app.researchMemory.create(user.id, "a note the researcher wrote by hand");

  assert.equal((await fetch(`${base}/api/projects/${projectId}`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: projectId }),
  })).status, 200);

  const exported = await app.researchMemory.exportUserMemory(user.id);
  assert.deepEqual(exported.records.map((record) => record.key), ["tone"],
    "the project's memory went with it and the account's did not");
  assert.deepEqual(exported.manualMemos.map((memo) => memo.content), ["a note the researcher wrote by hand"]);
});

test("deleting an account takes every memory with it, counted for the audit", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  await app.researchMemory.create(user.id, "a note that must not outlive the account");

  const deleted = await fetch(`${base}/api/account`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: user.id, password: "test-only-memory-password" }),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  const rows = await app.store.database.query(
    `SELECT (SELECT count(*)::integer FROM evimed_memory.records WHERE user_id=$1) AS records,
            (SELECT count(*)::integer FROM evimed_memory.notes WHERE user_id=$1) AS notes`, [user.id]);
  assert.deepEqual(rows.rows[0], { records: 0, notes: 0 });
});
