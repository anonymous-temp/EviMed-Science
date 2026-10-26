// The opt-in RSI layer as the composed app wires it: inert without its deployment file, never able to hold the other
// workers at start, and never able to fail a person's project or account deletion.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { ensureEvidenceProject } from "../src/internalProjects.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 120_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */ let isolated;
before(async () => { if (databaseUrl) isolated = await createGeoTestDatabase(databaseUrl, "rsiwiring"); });
after(async () => { await isolated?.drop(); });

/** @param {Record<string, any>} overrides */
async function withApp(overrides, operation) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-rsi-wiring-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, evolutionEnabled: true, operatorUsers: [], rsiOnlineConfigFile: "", ...overrides });
  const said = /** @type {string[]} */ ([]);
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {any} */ ((chunk) => { said.push(String(chunk)); return true; });
  try { await operation(app, said); }
  finally { process.stderr.write = write; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test("without the deployment file the RSI layer is inert even with evolution on: no serving adapter, importer or policy hook", options, () => withApp({}, async (app, said) => {
  assert.ok(app.evolution, "evolution serving is composed");
  await app.listen(0, "127.0.0.1");
  assert.deepEqual(app.rsi.status(), { runtime: true, configured: false, importer: false, servingAdapters: false, frontierSelection: false });
  assert.deepEqual(said.filter((line) => line.startsWith("rsi:")), []);
}));

test("an RSI start-up failure is said and the other workers start; a failing RSI hook never fails a deletion and leaves a durable retry", options, () => withApp({
  rsiOnlineRuntimeFactory: async () => { throw new Error("rsi start-up failed"); },
}, async (app, said) => {
  const username = `rsiwiring${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "test-only-rsi-password";
  const user = await app.store.createUser(username, password, "RSI wiring");
  // The deployment-owned queue a deferred invalidation is written to (normally provisioned by the configured runtime).
  await ensureEvidenceProject(app.store);
  // listen() awaits the recurring work start, which used to reject on the RSI failure before any other worker started.
  const address = await app.listen(0, "127.0.0.1");
  assert.ok(address.port > 0);
  assert.ok(said.includes("rsi: rsi_online_initialization_failed\n"), said.join("|"));
  assert.equal(app.rsi.status().runtime, false);
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const session = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": (await login.json()).data.csrfToken };
  const created = await fetch(`${base}/api/projects`, { method: "POST", headers: session, body: JSON.stringify({ name: "RSI wiring" }) });
  assert.equal(created.status, 200, await created.clone().text());
  const projectId = (await created.json()).data.id;
  const removed = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: session, body: JSON.stringify({ confirm: projectId }) });
  assert.equal(removed.status, 200, await removed.clone().text());
  const deleted = await fetch(`${base}/api/account`, { method: "DELETE", headers: session, body: JSON.stringify({ confirm: user.id, password }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const retries = await app.store.database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='rsi-incident-export' AND payload ? 'invalidateSource' ORDER BY created_at", [PLATFORM_PUBLISHER_USER_ID]);
  assert.deepEqual(retries.rows.map((row) => row.payload.invalidateSource), [{ userId: user.id, projectId }, { userId: user.id }]);
  assert.ok(said.includes("rsi: rsi_source_invalidation_failed\n"));
}));
