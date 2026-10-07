// The programme's operator surface and its two page signals in the real hosted app over HTTP, against a real PostgreSQL: who may read the
// page and run today's decision, that the run is the day's one decision (a second call is the recorded no-op), and that `server.mjs` hands
// the selector the public pages' reads and topic requests only where those pages are on.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ensureEvidenceProject } from "../src/internalProjects.mjs";
import { recordPageRead } from "../src/evidencePublicReads.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const accounts = { operator: `ops${suffix}`, researcher: `res${suffix}` };
const PASSWORD = "test-only-programme-ops-password";
/** @type {{ app: any, base: string, sessions: Record<string, Record<string, string>>, dir: string, isolated: any } | null} */ let context = null;

/** @param {Record<string, any>} over */
async function boot(over = {}) {
  const isolated = await createGeoTestDatabase(databaseUrl, "programmeops");
  const dir = await mkdtemp(path.join(tmpdir(), "evimed-programme-ops-"));
  const tokenFile = path.join(dir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)] });
  const app = createWebApiApp({
    dataDir: dir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: isolated.url, frontierEnabled: true, frontierAudience: "operators", frontierPreviewUsers: Object.values(accounts), knowledgePluginUrl: "http://plugin.test:8080",
    knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl, frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
    autopilotEnabled: true, evidenceProgrammeEnabled: true, evidenceProgrammeDailyBudgetCny: 30, evidenceProgrammeMaxConcurrency: 1, evidencePublicWebEnabled: true,
    operatorUsers: [accounts.operator], operatorMetricsToken: "test-only-metrics-token", modelGatewaySigningSecret: randomBytes(32).toString("hex"), ...over,
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  // Nothing moves under an assertion: the workers that listening started are stopped, and each test runs what it needs by hand.
  for (const worker of [app.frontierWorker, app.autopilotWorker, app.evidenceProgramme?.worker]) await worker?.close();
  await ensureEvidenceProject(app.store);
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  return { app, base, sessions, dir, isolated };
}
/** @param {NonNullable<typeof context>} built */
async function shut(built) {
  await built.app.store.database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(accounts)]);
  await built.app.close();
  await rm(built.dir, { recursive: true, force: true });
  await built.isolated.drop();
}

before(async () => { if (databaseUrl) context = await boot(); });
after(async () => { if (context) await shut(context); });

/** @param {string} role @param {string} method @param {string} pathname @param {any} [body] */
const call = async (role, method, pathname, body) => {
  const response = await fetch(`${context?.base}${pathname}`, { method, headers: context?.sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

test("the page and the run are the operator's: a session, the operator list, and CSRF on the run", options, async () => {
  const anonymous = await fetch(`${context?.base}/api/ops/evidence-programme`);
  assert.equal(anonymous.status, 401);
  for (const [method, pathname] of [["GET", "/api/ops/evidence-programme"], ["POST", "/api/ops/evidence-programme/run"]]) {
    const refused = await call("researcher", method, pathname, method === "POST" ? {} : undefined);
    assert.equal(refused.status, 403, `${method} ${pathname}`);
    assert.equal(refused.body.code, "evidence_programme_operator_required");
  }
  const { "x-open-science-csrf": _csrf, ...withoutCsrf } = /** @type {any} */ (context).sessions.operator;
  const forged = await fetch(`${context?.base}/api/ops/evidence-programme/run`, { method: "POST", headers: withoutCsrf, body: "{}" });
  assert.equal(forged.status, 403);
  assert.equal((await call("operator", "GET", "/api/ops/evidence-programme")).status, 200);
});

test("running today's decision makes the day's one decision through runDay, and a second call is the recorded no-op", options, async () => {
  const app = /** @type {any} */ (context).app;
  const day = app.evidenceProgramme.internals.localDay();
  const first = await call("operator", "POST", "/api/ops/evidence-programme/run", {});
  assert.equal(first.status, 200);
  assert.equal(first.body.data.state, "decided");
  assert.equal(first.body.data.decision.id, `programme-decision-${day}`);
  assert.equal(first.body.data.decision.day, day);
  // No model is configured and no feed item is new, so the recorded decision is "no action" — and that is a decision.
  assert.equal(first.body.data.decision.source, "none");
  const second = await call("operator", "POST", "/api/ops/evidence-programme/run", {});
  assert.equal(second.body.data.decision.id, first.body.data.decision.id);
  assert.equal(second.body.data.decision.decidedAt, first.body.data.decision.decidedAt, "the same document, not a second decision");
  assert.equal((await app.store.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='programme-decision'")).rows[0].n, 1);
  const page = await call("operator", "GET", "/api/ops/evidence-programme");
  assert.equal(page.status, 200);
  assert.equal(page.body.data.decisions[0].id, first.body.data.decision.id);
  assert.equal(page.body.data.zones.length, 6);
  assert.equal(page.body.data.budget.budgetCny, 30);
  assert.equal(page.body.data.status.enabled, true);
});

test("the selector is handed the public pages' reads and topic requests: a zone's reads and a request that names it", options, async () => {
  const app = /** @type {any} */ (context).app;
  const zone = (await app.evidenceProgramme.internals.resolveZones()).find((/** @type {any} */ entry) => entry.key === "nsclc");
  assert.ok(zone.id, "the programme made its lung zone");
  const today = app.evidenceProgramme.internals.localDay();
  for (let n = 0; n < 4; n += 1) await recordPageRead(app.store.database, { zoneId: zone.id, day: today });
  const filed = await call("researcher", "POST", "/api/frontier/evidence/topic-requests", { title: "肺癌新药的真实世界证据", zoneId: zone.id });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const signals = await app.evidenceProgramme.gatherSignals(today);
  assert.equal(signals.readsRecorded, true);
  assert.equal(signals.topicRequestsRecorded, true);
  assert.deepEqual(signals.zones.nsclc.attention.reads, { zonePage: 4, cardPages: 0 });
  assert.deepEqual([signals.zones.nsclc.topicRequests.requests, signals.zones.nsclc.topicRequests.votes], [1, 1]);
  assert.equal(signals.zones["breast-cancer"].topicRequests.requests, 0);
});

test("with the public pages off the selector is told the signals are not recorded, and the programme's page still opens", options, async () => {
  const off = await boot({ evidencePublicWebEnabled: false });
  try {
    const signals = await off.app.evidenceProgramme.gatherSignals("2026-10-06");
    assert.deepEqual([signals.readsRecorded, signals.topicRequestsRecorded], [false, false]);
    const response = await fetch(`${off.base}/api/ops/evidence-programme`, { headers: off.sessions.operator });
    assert.equal(response.status, 200);
  } finally { await shut(off); }
});

test("a deployment with the programme off answers by name and reads nothing", options, async () => {
  const off = await boot({ evidenceProgrammeEnabled: false });
  try {
    for (const [method, pathname] of [["GET", "/api/ops/evidence-programme"], ["POST", "/api/ops/evidence-programme/run"]]) {
      const response = await fetch(`${off.base}${pathname}`, { method, headers: off.sessions.operator, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 404, pathname);
      assert.equal((await response.json()).code, "evidence_programme_not_enabled");
    }
  } finally { await shut(off); }
});
