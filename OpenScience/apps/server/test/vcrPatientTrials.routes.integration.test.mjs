// 「给患者找试验」 through the real hosted app, over HTTP, against a real PostgreSQL: the page's one action dispatches a run of the matching
// capability — for the owner, not for a reader who may only read, and not at all for somebody outside the study. Nothing leaves the
// process: the engine is a fetch double, and a run is recorded and not started.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-vcr-password";
const accounts = { owner: `own${suffix}`, viewer: `view${suffix}`, stranger: `str${suffix}` };

/** @type {any} */
let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {any[]} */
const dispatches = [];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrpt");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-pt-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000,
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
    vcrEngineUrl: "http://engine.test:8080", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40),
    // The engine is a double: its health is all the app asks.
    vcrFetch: async (/** @type {any} */ url) => {
      const target = new URL(String(url));
      const body = target.pathname === "/health" ? { ok: true, engineVersion: "test", rVersion: "test", methods: [], packageLockHash: "" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    vcrDispatchRun: async (/** @type {any} */ input) => {
      dispatches.push(input);
      return { runId: `run_${dispatches.length}`, sessionId: `session_${dispatches.length}`, status: "running" };
    },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [name, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[name] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});

after(async () => {
  if (context) {
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} who @param {string} method @param {string} route @param {unknown} [body] */
async function call(who, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[who], body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  /** @type {any} */
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, body: parsed, text };
}

/** A study of the owner's with a patient the chart settles most of, and the viewer a member. */
async function furnishedStudy() {
  const made = await call("owner", "POST", "/api/vcr/studies", { name: "EV-201 患者找试验", question: "晚期肺腺癌患者现在有哪些试验可以去问？", dataTier: "T1" });
  assert.equal(made.status, 201, made.text);
  const study = await context.app.vcr.store.studyById(made.body.data.id);
  const fact = (/** @type {string} */ variable, /** @type {any} */ value, /** @type {Record<string, any>} */ extra = {}, /** @type {number} */ minute = 0) => context.app.vcr.matchStore.saveFact({
    studyId: study.id, userId: study.userId, fact: { subjectKey: "P-0192", variable, value, unit: null, polarity: "affirmed", occurredAt: `2026-09-10T00:0${minute}:00.000Z`,
      recordedAt: null, visibleAt: `2026-09-10T00:0${minute}:00.000Z`, surface: "", source: null, extractedBy: "code", ...extra } });
  await fact("age", 63, { unit: "year" });
  await fact("ecog", 1, {}, 1);
  await fact("active_brain_metastasis", false, { polarity: "negated" }, 2);
  const joined = await call("owner", "POST", `/api/vcr/studies/${study.id}/members`, { userId: accounts.viewer, role: "viewer" });
  assert.equal(joined.status, 201, joined.text);
  return study;
}

test("a reader may not ask for a search, and somebody outside the study finds none of it", options, async () => {
  const study = await furnishedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  const refused = await call("viewer", "POST", `${S}/trial-search`, { subjectKey: "P-0192" });
  assert.deepEqual([refused.status, refused.body.code], [403, "vcr_forbidden"]);
  assert.equal(dispatches.length, 0, "nothing was sent");
  for (const [method, route, body] of [["GET", `${S}/matching?direction=patient_to_trial&candidate=P-0192`, undefined], ["POST", `${S}/trial-search`, { subjectKey: "P-0192" }]]) {
    const outsider = await call("stranger", String(method), String(route), body);
    assert.deepEqual([outsider.status, outsider.body.code], [404, "vcr_study_not_found"], `${method} ${route}`);
  }
});

test("the page's action dispatches a run of the matching capability for the patient", options, async () => {
  const study = await furnishedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  const asked = await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-0192" });
  assert.equal(asked.status, 200, asked.text);
  assert.ok(asked.body.data.runId, "the run is started");
  assert.equal("sessionId" in asked.body.data, false, "and there is no session to go to: the page stays where it is");
  assert.deepEqual([asked.body.data.accepted, asked.body.data.queuedBehind], [true, []]);
  const sent = dispatches.at(-1);
  assert.deepEqual([sent.capabilityId, sent.reason, sent.studyId], ["vcr-matching", "vcr:trial-search", study.id]);
  assert.match(sent.brief, /P-0192/);

  // A patient the study does not hold, and a body that is not the key alone, are refused before anything is sent.
  const sentBefore = dispatches.length;
  assert.deepEqual([(await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-9999" })).body.code], ["vcr_subject_not_found"]);
  assert.equal((await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-0192", extra: 1 })).status, 400);
  assert.equal(dispatches.length, sentBefore);
});
