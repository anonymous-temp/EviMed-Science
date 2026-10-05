// The publisher account at the HTTP boundary (evidence-flywheel B2, 2026-10-05): a visitor who types its id or its name into the
// registration form, or its id into the login form, gets a refusal, and nothing is created.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

async function withAuthApp(/** @type {(context: { base: string }) => Promise<void>} */ run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-platform-http-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, bootstrapUser: "alice", bootstrapPassword: "correct horse battery staple" });
  const address = await app.listen(0, "127.0.0.1");
  try { await run({ base: `http://127.0.0.1:${address.port}` }); } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
}
const post = (/** @type {string} */ url, /** @type {unknown} */ body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("registering the publisher's id or name is refused by name, and nobody is signed in or created", async () => {
  await withAuthApp(async ({ base }) => {
    for (const body of [
      { username: "evimed-evidence-center", password: "another correct horse" },
      { username: "EVIMED-EVIDENCE-CENTER", password: "another correct horse" },
      { username: "carol", password: "another correct horse", name: "EviMed 证据中心" },
      { username: "carol", password: "another correct horse", name: "EviMed证据中心" },
    ]) {
      const refused = await post(`${base}/api/auth/register`, body);
      assert.equal(refused.status, 409, JSON.stringify(body));
      assert.equal((await refused.json()).code, "platform_account_reserved");
      assert.equal(refused.headers.get("set-cookie"), null, "a refused registration signs nobody in");
    }
    // The name was not taken by the refused attempts: carol registers fine under her own name.
    const fine = await post(`${base}/api/auth/register`, { username: "carol", password: "another correct horse", name: "Carol" });
    assert.equal(fine.status, 201);
  });
});

test("signing in as the publisher answers what a wrong password answers", async () => {
  await withAuthApp(async ({ base }) => {
    const known = await post(`${base}/api/auth/login`, { username: "alice", password: "wrong password here" });
    const platform = await post(`${base}/api/auth/login`, { username: "evimed-evidence-center", password: "wrong password here" });
    assert.equal(platform.status, 401);
    assert.equal(platform.status, known.status);
    assert.equal((await platform.json()).code, (await known.json()).code, "nothing says whether the account exists");
  });
});

test("an account cannot make the platform's evidence project by typing its id", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-evidence-project-http-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const refused = await post(`${base}/api/projects`, { id: "evimed-evidence", name: "Mine" });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "project_id_reserved");
    const made = await post(`${base}/api/projects`, { id: "evimed-evidence-notes", name: "Notes" });
    assert.equal(made.status, 200, "a lookalike name is an ordinary project");
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
