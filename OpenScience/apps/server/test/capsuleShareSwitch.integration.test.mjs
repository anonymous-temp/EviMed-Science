// Every line has its own switch, and each is off until turned on (evidence-flywheel review fix 8, 2026-10-06), through the composed
// app against a real PostgreSQL: sharing a capsule with other accounts (its routes, its counters, the flag the share panel reads) and
// the evidence-zone subscription (its routes, which also ask the frontier's audience, and the recall of subscribed zones).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-switch-password";
const accounts = { inside: `inside${suffix}`, outside: `outside${suffix}` };
/** @type {any} */ let isolated, dataDir;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "capsuleswitch");
  dataDir = await mkdtemp(path.join(tmpdir(), "evimed-capsule-switch-"));
});
after(async () => { await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

/** The app composed with `overrides`, both accounts signed in; `run` gets a caller. */
async function withApp(/** @type {Record<string, any>} */ overrides, /** @type {(api: any) => Promise<void>} */ run) {
  const tokenFile = path.join(dataDir, `knowledge-plugin-${randomUUID().slice(0, 6)}.token`);
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "operators", frontierPreviewUsers: [accounts.inside],
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} }, ...overrides,
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id).catch(() => null);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  const call = async (/** @type {string} */ role, /** @type {string} */ method, /** @type {string} */ pathname, /** @type {any} */ body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const metrics = async () => (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  try { await run({ call, metrics }); } finally { await app.close(); }
}

test("sharing is off until its own switch is on: routes 404 by name, no counter, and the share panel's flag is false", options, async () => {
  await withApp({ frontierAudience: "operators" }, async ({ call, metrics }) => {
    const me = await call("inside", "GET", "/api/me");
    assert.equal(me.body.data.features.capsuleShare, false);
    for (const [method, route, body] of [["GET", "/api/capsules/deliveries"], ["GET", "/api/capsules/shared/" + "A".repeat(32)], ["POST", "/api/capsules/takedowns", { authorId: "x" }],
      ["GET", "/api/capsules/anything/deliveries"], ["GET", "/api/capsules/anything/links"], ["GET", "/api/capsules/anything/methods/export?format=agent-skills"]]) {
      const answered = await call("inside", method, route, body);
      assert.equal(answered.status, 404, `${method} ${route}`);
      assert.equal(answered.body.code, "capsule_share_not_enabled", `${method} ${route}`);
    }
    assert.doesNotMatch(await metrics(), /open_science_capsule_shares_total/, "nothing of sharing is exported while it is off");
    // The capsule's own routes are not sharing and answer as before.
    assert.equal((await call("inside", "GET", "/api/capsules")).status, 200);
  });
  await withApp({ capsuleShareEnabled: true }, async ({ call, metrics }) => {
    assert.equal((await call("inside", "GET", "/api/me")).body.data.features.capsuleShare, true);
    assert.equal((await call("inside", "GET", "/api/capsules/deliveries")).status, 200, "on, a recipient with nothing waiting reads an empty list");
    assert.match(await metrics(), /^open_science_capsule_shares_total/m);
  });
});

test("a zone subscription is off until its own switch is on, needs the frontier's audience", options, async () => {
  const subscribe = (/** @type {any} */ call, /** @type {string} */ role) => call(role, "GET", "/api/capsules/subscriptions?projectId=default");
  // The frontier is on and shown to the first account; the subscription's own switch is not.
  await withApp({}, async ({ call }) => {
    assert.equal((await call("inside", "GET", "/api/me")).body.data.features.zoneSubscription, false);
    const answered = await subscribe(call, "inside");
    assert.deepEqual([answered.status, answered.body.code], [404, "evidence_zone_subscription_not_enabled"]);
  });
  await withApp({ evidenceZoneSubscriptionEnabled: true }, async ({ call }) => {
    assert.equal((await call("inside", "GET", "/api/me")).body.data.features.zoneSubscription, true);
    assert.equal((await subscribe(call, "inside")).status, 200, "inside the frontier's audience");
    assert.equal((await call("outside", "GET", "/api/me")).body.data.features.zoneSubscription, false);
    const outside = await subscribe(call, "outside");
    assert.deepEqual([outside.status, outside.body.code], [404, "frontier_not_enabled"], "outside it, the answer every zone route gives");
    const subscribed = await call("outside", "POST", "/api/capsules/subscriptions", { projectId: "default", zoneId: "ez_0123456789abcdef" });
    assert.deepEqual([subscribed.status, subscribed.body.code], [404, "frontier_not_enabled"]);
  });
});
