// OpenList readiness and the 连接网盘 offer (audit I3-4, 2026-09-26).
//
// Production's OpenList had an empty `x_storages`; every browse answered 502
// while `/api/ready` said `openList: connected`, because readiness requested
// `/ping` — which OpenList answers with no credential and nothing mounted. The
// check now lists the tenant root with the deployment's credential, and the
// same probe tells the knowledge-base page whether to offer the entry at all.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { startFakeOpenList } from "./fakeOpenList.mjs";

const METRICS_TOKEN = "metrics-token-for-openlist-readiness";

/** @param {import("node:test").TestContext} t @param {Record<string, any>} overrides */
async function startApp(t, overrides) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-openlist-ready-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: METRICS_TOKEN, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  return {
    ready: async () => (await (await fetch(`${base}/api/ready`)).json()).data,
    features: async () => (await (await fetch(`${base}/api/me`)).json()).data.features,
    metrics: async () => (await fetch(`${base}/api/ops/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).text(),
  };
}

/** @param {{ url: string, token: string }} openList */
const requiredOpenList = (openList) => ({ requireOpenList: true, openListUrl: openList.url, openListToken: openList.token, openListTenantRoot: "/tenants" });

test("an OpenList that answers but has nothing mounted is degraded, not connected — and not red", async (t) => {
  const openList = await startFakeOpenList(t);
  const app = await startApp(t, requiredOpenList(openList));
  const check = (await app.ready()).checks.openList;
  assert.equal(check.ok, true, "nothing mounted is the operator's provisioning; red would fail the web healthcheck");
  assert.equal(check.state, "degraded");
  assert.equal(check.connected, undefined, "`connected` is what the old ping said over an empty drive");
  assert.equal(check.storage, "missing");
  assert.equal(check.namespaces, 0);
  assert.equal(check.warning, "openlist_storage_missing");
  const said = JSON.stringify(check);
  assert.equal(said.includes(openList.token) || said.includes(openList.url) || said.includes("127.0.0.1"), false, "no credential or address in the payload");
  // The probe is the browse route's call — authenticated, against the tenant root — not `/ping`.
  assert.deepEqual(openList.requests, [{ path: "/tenants", page: 1, perPage: 1, authorization: openList.token }]);

  assert.equal((await app.features()).openList, false, "the page is not offered an empty drive");
  const metrics = await app.metrics();
  assert.match(metrics, /^open_science_openlist_storage_mounted 0$/m);
  assert.match(metrics, /^open_science_openlist_storage_probes_total\{outcome="missing"\} 1$/m);
  assert.match(metrics, /^open_science_readiness_check\{check="openList",code="ok"\} 1$/m);
  assert.equal(openList.requests.length, 1, "readiness, /api/me and the scrape shared one probe");
});

test("a mounted tenant storage is connected and offered", async (t) => {
  const openList = await startFakeOpenList(t, { mounts: { "/tenants/alice": ["paper.pdf"], "/tenants/bob": [] } });
  const app = await startApp(t, requiredOpenList(openList));
  const check = (await app.ready()).checks.openList;
  assert.deepEqual({ ok: check.ok, state: check.state, connected: check.connected, storage: check.storage, namespaces: check.namespaces, warning: check.warning },
    { ok: true, state: "connected", connected: true, storage: "mounted", namespaces: 2, warning: undefined });
  assert.equal((await app.features()).openList, true);
  assert.match(await app.metrics(), /^open_science_openlist_storage_mounted 1$/m);
});

test("a credential OpenList refuses is the platform's own fault, and red", async (t) => {
  const openList = await startFakeOpenList(t, { mounts: { "/tenants/alice": ["paper.pdf"] } });
  const app = await startApp(t, { ...requiredOpenList(openList), openListToken: "a-token-openlist-never-issued" });
  const check = (await app.ready()).checks.openList;
  assert.equal(check.ok, false);
  assert.equal(check.code, "openlist_credential_rejected");
  assert.equal((await app.features()).openList, false);
});

test("an OpenList that is not configured is never probed and never offered", async (t) => {
  const openList = await startFakeOpenList(t, { mounts: { "/tenants/alice": ["paper.pdf"] } });
  const app = await startApp(t, { requireOpenList: false, openListUrl: "", openListToken: openList.token });
  const ready = await app.ready();
  assert.deepEqual(ready.checks.openList, { ok: true, required: false, configured: false });
  assert.equal((await app.features()).openList, false);
  assert.equal(openList.requests.length, 0);
});

test("the OpenList bootstrap hands the administrator secret after `--`, so a secret starting with '-' is not read as a flag", async () => {
  // configure-production-state writes randomBytes(36) as base64url, which
  // starts with "-" one time in 64; OpenList 4.2.6 then exits 1 with
  // "unknown shorthand flag" (measured against the pinned image, 2026-09-29).
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../../../deploy/openlist/bootstrap.sh", import.meta.url), "utf8");
  const call = script.split("\n").find((line) => line.includes("openlist admin set"));
  assert.ok(call, "the bootstrap sets the administrator password");
  const secretAt = call.indexOf('"$password"');
  const endAt = call.indexOf(" -- ");
  assert.ok(endAt > 0 && endAt < secretAt, "`--` comes before the secret");
  assert.ok(call.indexOf("--data") < endAt, "the data directory is an option, so it goes before `--`");
});
