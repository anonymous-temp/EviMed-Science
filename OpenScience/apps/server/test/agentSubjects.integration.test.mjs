/**
 * The CDSS integration end to end, in the real app on a real database: an
 * institution mints an integration key, and per doctor the CDSS proposes a
 * note, reads the dashboard, posts prescription edits until a habit forms,
 * recalls it, forgets one doctor, and the institution's own deletion takes
 * every doctor with it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { subjectAccountId } from "../src/agentApiKeys.mjs";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("an integration key serves each doctor alone, and the institution's deletion takes every doctor with it", options, async (t) => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-agent-subjects-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl, agentMemoryApiEnabled: true,
  });
  const username = `hospital${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "test-only-hospital-password";
  const institution = await app.store.createUser(username, password, "Hospital");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const doctors = ["doc-7", "doc-8"].map((subject) => subjectAccountId(institution.id, subject));
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[institution.id, ...doctors]]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const session = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": (await login.json()).data.csrfToken };
  const minted = await fetch(`${base}/api/agent-keys`, { method: "POST", headers: session,
    body: JSON.stringify({ name: "CDSS", scopes: ["memory.read", "memory.write", "memory.manage", "memory.observe"], subjects: true }) });
  assert.equal(minted.status, 201);
  const key = (await minted.json()).data.key;
  /** @param {string} route @param {{ method?: string, body?: any, subject?: string }} [init] */
  const call = (route, { method = "GET", body, subject } = {}) => fetch(`${base}/api/agent-memory/v1${route}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(subject ? { "x-subject": subject } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // A proposal for one doctor waits on that doctor's dashboard, and nowhere else.
  assert.equal((await call("/note", { method: "POST", subject: "doc-7", body: { factKind: "preference", content: "药味控制在 12 味以内" } })).status, 200);
  const board7 = (await (await call("/dashboard", { subject: "doc-7" })).json()).data;
  assert.deepEqual(board7.pending.map((item) => [item.type, item.summary]), [["note", "药味控制在 12 味以内"]]);
  const board8 = (await (await call("/dashboard", { subject: "doc-8" })).json()).data;
  assert.equal(board8.pending.length, 0, "another doctor's dashboard is their own");
  const institutional = (await (await call("/dashboard")).json()).data;
  assert.equal(institutional.pending.length, 0, "and so is the institution's");

  // Three edits make a habit, recalled for that doctor only.
  for (const id of ["e1", "e2", "e3"]) {
    const observed = await call("/observations", { method: "POST", subject: "doc-7",
      body: { observationId: id, syndrome: "脾胃气虚证", changes: [{ type: "replace", from: "党参", to: "太子参" }] } });
    assert.equal(observed.status, 202, await observed.clone().text());
  }
  const recalled = (await (await call("/recall", { method: "POST", subject: "doc-7", body: { query: "脾胃气虚", methods: "own" } })).json()).data;
  assert.deepEqual(recalled.methods.map((method) => method.title), ["脾胃气虚证：太子参易党参"]);
  const elsewhere = (await (await call("/recall", { method: "POST", subject: "doc-8", body: { query: "脾胃气虚", methods: "own" } })).json()).data;
  assert.deepEqual(elsewhere.methods, []);

  // Forgetting one doctor deletes that account; the other stays.
  await call("/note", { method: "POST", subject: "doc-8", body: { factKind: "preference", content: "复诊间隔一周" } });
  const forgot = await call("/subject", { method: "DELETE", subject: "doc-8" });
  assert.deepEqual((await forgot.json()).data, { deleted: true });
  const accounts = async () => (await app.store.database.query("SELECT id FROM evimed_control.users WHERE id=ANY($1::text[]) ORDER BY id", [doctors])).rows.map((row) => row.id);
  assert.deepEqual(await accounts(), [doctors[0]]);

  // The institution's deletion takes every doctor with it.
  const deleted = await fetch(`${base}/api/account`, { method: "DELETE", headers: session, body: JSON.stringify({ confirm: institution.id, password }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await accounts(), []);
  const left = await app.store.database.query(`SELECT
    (SELECT count(*)::integer FROM evimed_product.documents WHERE user_id=ANY($1::text[])) AS documents,
    (SELECT count(*)::integer FROM evimed_agent.subjects WHERE user_id=ANY($1::text[])) AS subjects,
    (SELECT count(*)::integer FROM evimed_agent.observations WHERE user_id=ANY($1::text[])) AS observations`, [doctors]);
  assert.deepEqual(left.rows[0], { documents: 0, subjects: 0, observations: 0 });
});
