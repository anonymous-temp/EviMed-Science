import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const shellOrigin = "https://science.example";
const uiOrigin = `${shellOrigin}:8443`;
const config = { publicUrl: shellOrigin, runtimeUiPublicOrigin: uiOrigin, sessionCookieName: "session", modelGatewaySigningSecret: "test-frame-signing-material-32-bytes-long", sessionTtlMs: 3600000 };
const req = { headers: { cookie: "session=login-one" } };
const user = { id: "user-one" };
const project = { id: "project-one", userId: user.id };
const session = { expiresAt: 100000 };

async function frameApi(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-frame-api-"));
  const app = createWebApiApp({ ...config, dataDir, devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const me = await fetch(`${base}/api/me`);
  const cookie = me.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const csrfToken = (await me.json()).data.csrfToken;
  return { app, base, cookie, csrfToken };
}

test("frame creation requires explicit authentication, CSRF and owned project, and returns a path cookie", async (t) => {
  const f = await frameApi(t);
  const create = (body, headers) => fetch(`${f.base}/api/runtime-ui/frames`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await create({ projectId: "default" }, {})).status, 401);
  assert.equal((await create({ projectId: "default" }, { cookie: f.cookie })).status, 403);
  const headers = { cookie: f.cookie, "x-open-science-csrf": f.csrfToken };
  assert.equal((await create({}, headers)).status, 400);
  assert.equal((await create({ projectId: "foreign" }, headers)).status, 404);
  const response = await create({ projectId: "default" }, headers);
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.match(data.frameId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(data.frameUrl, `${uiOrigin}/__evimed/f/${data.frameId}/`);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^evimed_ui_frame=.+; Path=/__evimed/f/${data.frameId}/; HttpOnly; SameSite=Lax`));
  assert.equal(data.token, undefined);
});

test("signed frame claims bind the login fingerprint and reject tampering, expiry, audience and path substitution", async () => {
  const { issueRuntimeUiFrame, validateRuntimeUiFrame, parseRuntimeUiFramePath } = await import("../src/runtimeUiFrames.mjs");
  const issued = issueRuntimeUiFrame({ config, req, user, session, project, now: 1000 });
  const frameReq = { headers: { cookie: `${req.headers.cookie}; ${issued.cookie.split(";")[0]}` } };
  const claims = validateRuntimeUiFrame({ config, req: frameReq, user, session, frameId: issued.frameId, now: 2000 });
  assert.equal(claims.projectId, project.id);
  assert.equal(claims.expiresAt, session.expiresAt);
  assert.equal(claims.authSessionHash.includes("login-one"), false);
  assert.deepEqual(parseRuntimeUiFramePath(`${issued.prefix}plugins/??bundle&rev=r&a=1&a=2`), { frameId: issued.frameId, prefix: issued.prefix, suffix: "/plugins/??bundle&rev=r&a=1&a=2" });
  for (const [change, code] of [
    [{ now: 100000 }, "runtime_ui_frame_expired"],
    [{ frameId: "a".repeat(32) }, "runtime_ui_frame_invalid"],
    [{ user: { id: "user-two" } }, "runtime_ui_frame_invalid"],
    [{ config: { ...config, runtimeUiPublicOrigin: "https://science.example:9443" } }, "runtime_ui_frame_invalid"],
    [{ req: { headers: { cookie: frameReq.headers.cookie.replace("login-one", "login-two") } } }, "runtime_ui_frame_invalid"],
    [{ req: { headers: { cookie: `${frameReq.headers.cookie}x` } } }, "runtime_ui_frame_invalid"],
    [{ req: { headers: { cookie: req.headers.cookie } } }, "runtime_ui_frame_required"],
    [{ req: { headers: { cookie: `${frameReq.headers.cookie}; ${issued.cookie.split(";")[0]}` } } }, "runtime_ui_frame_invalid"],
  ]) {
    assert.throws(() => validateRuntimeUiFrame({ config, req: frameReq, user, session, frameId: issued.frameId, now: 2000, ...change }), (error) => error.code === code);
  }
  for (const target of ["/", "/api/remote.mux", "/?project=second", "/__evimed/f/bad/api/session/page", `${issued.prefix}../assets/a.js`, `${issued.prefix}%2e%2e/assets/a.js`, `${issued.prefix}%2fapi`]) {
    assert.throws(() => parseRuntimeUiFramePath(target), /frame|path/i);
  }
});

test("production frame signing fails closed without stable protected material and deployment origins must share host", async () => {
  const { issueRuntimeUiFrame } = await import("../src/runtimeUiFrames.mjs");
  for (const overrides of [
    { production: true, modelGatewaySigningSecret: "" },
    { production: true, modelGatewaySigningSecret: "short" },
    { publicUrl: "https://shell.example" },
    { runtimeUiPublicOrigin: shellOrigin },
  ]) assert.throws(() => issueRuntimeUiFrame({ config: { ...config, ...overrides }, req, user, project, session, now: 1000 }));
});

test("the authenticated external bootstrap installs the real browser hook without changing global fetch or starting a runtime", async (t) => {
  const { runInNewContext } = await import("node:vm");
  const f = await frameApi(t);
  let starts = 0;
  f.app.runtimeManager.start = async () => { starts++; throw new Error("bootstrap must not wake runtime"); };
  const response = await fetch(`${f.base}/api/runtime-ui/frames`, { method: "POST", headers: { cookie: f.cookie, "content-type": "application/json", "x-open-science-csrf": f.csrfToken }, body: JSON.stringify({ projectId: "default" }) });
  const frame = (await response.json()).data;
  const cookie = `${f.cookie}; ${response.headers.get("set-cookie").split(";")[0]}`;
  const prefix = new URL(frame.frameUrl).pathname;
  const source = await fetch(`http://127.0.0.1:${f.app.runtimeUi.address().port}${prefix}__evimed_bootstrap.js`, { headers: { cookie } });
  assert.equal(source.status, 200);
  assert.match(source.headers.get("content-type"), /text\/javascript/);
  assert.equal(source.headers.get("cache-control"), "private, no-store");
  const requests = [];
  const nativeFetch = async (url, options) => { requests.push([url, options]); return new Response("ok"); };
  const sandbox = { location: { origin: uiOrigin }, URL, fetch: nativeFetch, addEventListener() {}, setTimeout, clearTimeout };
  runInNewContext(await source.text(), sandbox);
  assert.equal(sandbox.fetch, nativeFetch);
  assert.equal(sandbox.__EVIMED_FRAME__.frameId, frame.frameId);
  assert.equal(sandbox.__EVIMED_FRAME__.shellOrigin, shellOrigin);
  assert.ok(Object.isFrozen(sandbox.__EVIMED_FRAME__));
  assert.ok(Object.isFrozen(sandbox.__DSH_TRANSPORT__));
  assert.notEqual(sandbox.__DSH_TRANSPORT__.ownsHost, true);
  const result = await sandbox.__DSH_TRANSPORT__.fetch(new URL("/api/session/page?cursor=a%2Fb", uiOrigin), { method: "POST", body: "native" });
  assert.equal(await result.text(), "ok");
  assert.equal(requests[0][0], `${uiOrigin}${prefix}api/session/page?cursor=a%2Fb`);
  assert.equal(requests[0][1].body, "native");
  assert.equal(starts, 0);
});
