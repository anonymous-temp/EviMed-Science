// The routes of sharing inside the platform (flywheel F17, F18): a link or a delivery is reached only by a signed-in account, another
// account's capsule is never readable through them, the operator's take-down is the operator's, and the new levers are real levers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpError, sendError } from "../src/security.mjs";
import { createCapsuleRoutes } from "../src/capsuleRoutes.mjs";
import { capsuleShareMetricFamilies, recordShareRefused, recordShared, recordTakedown, resetCapsuleShareMetrics } from "../src/capsuleShareMetrics.mjs";
import { loadConfig } from "../src/config.mjs";
import { unzipSync } from "fflate";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function fixture(t, { operator = false, subscriptionsEnabled = true, shareEnabled = true, audience = true } = {}) {
  const calls = [];
  const own = (user, id) => { if (id !== "mine") throw new HttpError(404, "capsule_not_found", "The capsule is unavailable."); };
  const transferService = {
    assertOwnCapsule: async (user, id) => own(user, id),
    snapshot: async (user, capsuleId, snapshotId) => { own(user, capsuleId); return { id: snapshotId }; },
    methodPack: async (user, id) => { own(user, id); calls.push(["methodPack", user, id]); return { zip: new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]), count: 1, scripts: 0, filename: "evimed-methods.zip" }; },
  };
  const sharing = {
    pending: async (user) => { calls.push(["pending", user]); return []; },
    open: async (user, id) => { calls.push(["open", user, id]); return { delivery: { id }, preview: null }; },
    openLink: async (user, token) => { calls.push(["openLink", user, token]); return { preview: {}, link: {} }; },
    deliver: async (user, id, body) => { own(user, id); calls.push(["deliver", user, id, body]); return { delivered: 0, notDelivered: 1, snapshot: null }; },
    sent: async (user, filter) => { calls.push(["sent", user, filter]); return []; },
    takeDown: async (input) => { calls.push(["takeDown", input]); return { snapshots: 1, copies: 2, withdrawn: 0 }; },
    createLink: async (user, id) => { own(user, id); return { token: "t", link: { id: "l" }, snapshot: { id: "s" } }; },
    afterRevoke: async () => ({}),
  };
  const subscriptions = { enabled: subscriptionsEnabled,
    list: async (user, project) => { calls.push(["subscriptions.list", user, project]); return []; },
    subscribe: async (user, project, zone) => { calls.push(["subscribe", user, project, zone]); return { zoneId: zone }; },
    unsubscribe: async () => ({ unsubscribed: true }), status: async () => ({ subscribed: false, subscription: null }) };
  const store = {
    ensureSessionUser: async (req) => {
      if (req.headers.cookie !== "fixture_session=active") throw new HttpError(401, "unauthorized", "Authentication required.");
      return { user: { id: "someone" } };
    },
    assertCsrf: async (req) => { if (!["GET", "HEAD"].includes(req.method) && req.headers["x-open-science-csrf"] !== "fixture-csrf") throw new HttpError(403, "csrf_required", "CSRF required."); },
    requireProject: async (_user, id) => { if (id !== "owned-project") throw new HttpError(404, "project_not_found", "Project unavailable."); return { id }; },
  };
  const links = { list: async () => [], revoke: async () => ({}) };
  const handle = createCapsuleRoutes({ store, service: {}, transferService, sharing, links, subscriptions, maxJsonBytes: 262144, isOperator: () => operator,
    shareEnabled, frontier: { allows: () => audience } });
  const server = createServer((req, res) => { handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }).catch((error) => sendError(res, error)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: "fixture_session=active", "x-open-science-csrf": "fixture-csrf", "content-type": "application/json" };
  return { base, headers, calls };
}

test("with the share switch off every sharing route is a 404 by name and reaches nothing; the capsule's own routes are untouched", async (t) => {
  const { base, headers, calls } = await fixture(t, { shareEnabled: false });
  const token = "A".repeat(32);
  for (const [method, url, body] of [
    ["GET", `/api/capsules/shared/${token}`], ["POST", `/api/capsules/shared/${token}/import`, {}], ["GET", "/api/capsules/deliveries"], ["GET", "/api/capsules/deliveries/dlv_1"],
    ["POST", "/api/capsules/deliveries/dlv_1/decline", {}], ["POST", "/api/capsules/takedowns", { authorId: "someone" }],
    ["POST", "/api/capsules/mine/deliveries", { recipients: ["x"] }], ["GET", "/api/capsules/mine/deliveries"], ["POST", "/api/capsules/mine/links", {}], ["GET", "/api/capsules/mine/links"],
    ["DELETE", "/api/capsules/mine/links/l1"], ["POST", "/api/capsules/mine/exports/s1/takedown", {}], ["GET", "/api/capsules/mine/methods/export?format=agent-skills"],
  ]) {
    const response = await fetch(`${base}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal((await response.json()).code, "capsule_share_not_enabled", `${method} ${url}`);
  }
  assert.deepEqual(calls, [], "nothing of sharing was called");
  const own = await fetch(`${base}/api/capsules/subscriptions?projectId=owned-project`, { headers });
  assert.equal(own.status, 200, "a zone subscription is not sharing: it has its own switch");
});

test("a zone subscription is the frontier's: an account outside its audience reads the answer an unknown path gets, and nothing is read or written", async (t) => {
  const { base, headers, calls } = await fixture(t, { audience: false });
  for (const [method, url, body] of [["GET", "/api/capsules/subscriptions?projectId=owned-project"], ["POST", "/api/capsules/subscriptions", { projectId: "owned-project", zoneId: "ez_1" }],
    ["DELETE", "/api/capsules/subscriptions", { projectId: "owned-project", zoneId: "ez_1" }]]) {
    const response = await fetch(`${base}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal((await response.json()).code, "frontier_not_enabled", `${method} ${url}`);
  }
  assert.deepEqual(calls, []);
});

test("a share link and a delivery are reached only by a signed-in account", async (t) => {
  const { base, headers, calls } = await fixture(t);
  for (const [method, url] of [["GET", "/api/capsules/shared/" + "A".repeat(32)], ["GET", "/api/capsules/deliveries/dlv_1"], ["GET", "/api/capsules/deliveries"], ["POST", "/api/capsules/deliveries/dlv_1/decline"]]) {
    assert.equal((await fetch(`${base}${url}`, { method, body: method === "POST" ? "{}" : undefined })).status, 401, `${method} ${url} without a session`);
  }
  assert.equal(calls.length, 0, "nothing was read for an anonymous visitor");
  const opened = await fetch(`${base}/api/capsules/shared/${"A".repeat(32)}`, { headers });
  assert.equal(opened.status, 200);
  assert.deepEqual(calls[0], ["openLink", "someone", "A".repeat(32)], "the account that opens it is the session's, never one the request names");
});

test("another account's capsule is not readable or shareable through the new routes", async (t) => {
  const { base, headers, calls } = await fixture(t);
  const foreign = (method, url, body) => fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const [method, url, body] of [
    ["POST", "/api/capsules/theirs/deliveries", { recipients: ["x"] }], ["GET", "/api/capsules/theirs/deliveries"], ["POST", "/api/capsules/theirs/links", {}], ["GET", "/api/capsules/theirs/links"],
    ["GET", "/api/capsules/theirs/methods/export?format=agent-skills"], ["POST", "/api/capsules/theirs/exports/s1/takedown", {}],
  ]) {
    const response = await foreign(method, url, body);
    assert.equal(response.status, 404, `${method} ${url}`);
    assert.equal((await response.json()).code, "capsule_not_found");
  }
  assert.ok(!calls.some(([name]) => ["methodPack", "takeDown", "sent"].includes(name)), "nothing of it was read or changed");
  const mine = await foreign("GET", "/api/capsules/mine/methods/export?format=agent-skills");
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "application/zip");
  assert.match(mine.headers.get("content-disposition"), /evimed-methods\.zip/);
  assert.equal((await foreign("GET", "/api/capsules/mine/methods/export?format=tar")).status, 400, "only the one format");
  assert.ok(unzipSync(new Uint8Array(await (await foreign("GET", "/api/capsules/mine/methods/export?format=agent-skills")).arrayBuffer())) !== undefined);
});

test("the operator's take-down of an author is the operator's", async (t) => {
  const ordinary = await fixture(t);
  const refused = await fetch(`${ordinary.base}/api/capsules/takedowns`, { method: "POST", headers: ordinary.headers, body: JSON.stringify({ authorId: "author_1", reason: "x" }) });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "capsule_share_operator_required");
  assert.ok(!ordinary.calls.some(([name]) => name === "takeDown"));
  const operator = await fixture(t, { operator: true });
  const done = await fetch(`${operator.base}/api/capsules/takedowns`, { method: "POST", headers: operator.headers, body: JSON.stringify({ authorId: "author_1", reason: "复核后下架" }) });
  assert.equal(done.status, 200);
  assert.deepEqual(operator.calls.find(([name]) => name === "takeDown")[1], { authorId: "author_1", by: "operator", reason: "复核后下架" });
});

test("a subscription is a route of one project the account owns; with the switch off it is the module's not-enabled answer", async (t) => {
  const on = await fixture(t);
  const subscribe = (project) => fetch(`${on.base}/api/capsules/subscriptions`, { method: "POST", headers: on.headers, body: JSON.stringify({ projectId: project, zoneId: "ez_abc12345" }) });
  assert.equal((await subscribe("someone-elses-project")).status, 404, "a project the account cannot open");
  assert.equal((await subscribe("owned-project")).status, 201);
  assert.deepEqual(on.calls.find(([name]) => name === "subscribe"), ["subscribe", "someone", "owned-project", "ez_abc12345"]);
  const off = await fixture(t, { subscriptionsEnabled: false });
  const refused = await fetch(`${off.base}/api/capsules/subscriptions?projectId=owned-project`, { headers: off.headers });
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).code, "evidence_zone_subscription_not_enabled");
  assert.ok(!off.calls.some(([name]) => name.startsWith("subscriptions")), "nothing was read");
});

test("the counters start at zero for every label and count only what they are told", () => {
  resetCapsuleShareMetrics();
  const read = () => Object.fromEntries(capsuleShareMetricFamilies().map((family) => [family.name, family.series]));
  assert.ok(read().open_science_capsule_shares_total.every((row) => row.value === 0));
  recordShared("link"); recordShared("not-a-channel"); recordTakedown("operator", 3); recordShareRefused("not_text_only"); recordShareRefused("made-up");
  const now = read();
  assert.equal(now.open_science_capsule_shares_total.find((row) => row.labels.channel === "link").value, 1);
  assert.equal(now.open_science_capsule_shares_total.reduce((sum, row) => sum + row.value, 0), 1, "an unknown label is ignored, never counted under a made-up one");
  assert.equal(now.open_science_capsule_takedown_copies_total.find((row) => row.labels.by === "operator").value, 3);
  assert.equal(now.open_science_capsule_share_refused_total.find((row) => row.labels.reason === "not_text_only").value, 1);
  resetCapsuleShareMetrics();
});

const LEVERS = [
  ["OPEN_SCIENCE_CAPSULE_SHARE_LINK_TTL_DAYS", "capsuleShareLinkTtlDays", 30, ["0", "366", "x"]],
  ["OPEN_SCIENCE_CAPSULE_SHARE_LINK_MAX_USES", "capsuleShareLinkMaxUses", 20, ["0", "1001"]],
  ["OPEN_SCIENCE_CAPSULE_SHARE_CORROBORATION_MIN_ACCOUNTS", "capsuleShareCorroborationMinAccounts", 3, ["0", "101"]],
  ["OPEN_SCIENCE_CAPSULE_SHARE_CORROBORATION_KEPT_DAYS", "capsuleShareCorroborationKeptDays", 14, ["0", "366"]],
  ["OPEN_SCIENCE_CAPSULE_SHARE_DELIVERIES_PER_DAY", "capsuleShareDeliveriesPerDay", 50, ["0", "1001"]],
  ["OPEN_SCIENCE_EVIDENCE_ZONE_SUBSCRIPTION_MAX_PER_PROJECT", "evidenceZoneSubscriptionMaxPerProject", 5, ["0", "21"]],
  ["OPEN_SCIENCE_EVIDENCE_ZONE_SUBSCRIPTION_MAX_ITEMS", "evidenceZoneSubscriptionMaxItems", 6, ["0", "31"]],
];
/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: repoRoot })); } finally { process.env = saved; }
}

test("the sharing levers have the defaults the plan names, are range-checked by name, and the subscription follows the frontier", () => {
  const defaults = configUnder({});
  for (const [, key, expected] of LEVERS) assert.equal(defaults[key], expected, key);
  // Every line has its own switch, off until turned on; the subscription also needs the frontier (2026-10-06 review).
  assert.equal(defaults.evidenceZoneSubscriptionEnabled, false, "off with the frontier off");
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_ENABLED: "true" }).evidenceZoneSubscriptionEnabled, false, "the frontier being on does not turn it on");
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_ZONE_SUBSCRIPTION_ENABLED: "true" }).evidenceZoneSubscriptionEnabled, true);
  assert.equal(configUnder({ OPEN_SCIENCE_EVIDENCE_ZONE_SUBSCRIPTION_ENABLED: "true" }).evidenceZoneSubscriptionEnabled, false, "and its own switch does not turn it on without the frontier");
  assert.equal(defaults.capsuleShareEnabled, false);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_ENABLED: "true" }).capsuleShareEnabled, false, "sharing is not the frontier's");
  assert.equal(configUnder({ OPEN_SCIENCE_CAPSULE_SHARE_ENABLED: "true" }).capsuleShareEnabled, true);
  assert.equal(configUnder({ OPEN_SCIENCE_CAPSULE_SHARE_LINK_TTL_DAYS: "7", OPEN_SCIENCE_CAPSULE_SHARE_LINK_MAX_USES: "" }).capsuleShareLinkTtlDays, 7);
  for (const [name, , , bad] of LEVERS) for (const value of bad) assert.throws(() => configUnder({ [name]: value }), new RegExp(name), `${name}=${value}`);
});

test("each lever is documented in .env.example and passed value-less by the web service", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const defaults = configUnder({});
  for (const [name, key] of [...LEVERS, ["OPEN_SCIENCE_EVIDENCE_ZONE_SUBSCRIPTION_ENABLED", "evidenceZoneSubscriptionEnabled"], ["OPEN_SCIENCE_CAPSULE_SHARE_ENABLED", "capsuleShareEnabled"]]) {
    const lines = [...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    assert.equal(lines.length, 1, `${name} appears once in .env.example`);
    assert.equal(lines[0][1], String(defaults[key]), `${name} in .env.example is the code's default`);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), `${name} is passed by compose`);
  }
});
