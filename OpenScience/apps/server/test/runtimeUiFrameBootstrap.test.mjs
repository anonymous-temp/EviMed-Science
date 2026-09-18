/**
 * What the control plane hands the frame layer at boot, beyond the binding.
 *
 * Three facts the frame bodies decide on and cannot learn any other way — the
 * page is on another origin with no session of ours:
 *
 *  - `operator`: an operator diagnosing a run keeps the rows a researcher's
 *    page hides (the assembled system prompt, the injected context). The same
 *    id allowlist the operations page reads.
 *  - `off`: the frame bodies this deployment switched off, from
 *    `OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF`.
 *  - each capability card's one-line summary and typical duration, which the
 *    `/能力` command shows beside the title.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createWebApiApp } from "../src/server.mjs";

const shellOrigin = "https://science.example";
const uiOrigin = `${shellOrigin}:8443`;

/** @param {any} t @param {Record<string, any>} [overrides] */
async function bootstrapFor(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-frame-bootstrap-"));
  const app = createWebApiApp({
    publicUrl: shellOrigin, runtimeUiPublicOrigin: uiOrigin, sessionCookieName: "session",
    modelGatewaySigningSecret: "test-frame-signing-material-32-bytes-long", sessionTtlMs: 3600000,
    dataDir, devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true, ...overrides,
  });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const me = await fetch(`${base}/api/me`);
  const cookie = me.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const body = (await me.json()).data;
  return { app, base, cookie, csrfToken: body.csrfToken, userId: String(body.user.id) };
}

/** @param {Awaited<ReturnType<typeof bootstrapFor>>} f */
async function frameObject(f) {
  f.app.runtimeManager.runtimeWorkspaceRoot = () => "/workspace";
  const response = await fetch(`${f.base}/api/runtime-ui/frames`, { method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json", "x-open-science-csrf": f.csrfToken }, body: JSON.stringify({ projectId: "default" }) });
  const frame = (await response.json()).data;
  const cookie = `${f.cookie}; ${response.headers.get("set-cookie").split(";")[0]}`;
  const source = await fetch(`http://127.0.0.1:${f.app.runtimeUi.address().port}${new URL(frame.frameUrl).pathname}__evimed_bootstrap.js`, { headers: { cookie } });
  assert.equal(source.status, 200);
  /** @type {any} */
  const sandbox = { location: { origin: uiOrigin }, URL, fetch: async () => new Response("ok"), addEventListener() {}, setTimeout, clearTimeout };
  runInNewContext(await source.text(), sandbox);
  return sandbox.__EVIMED_FRAME__;
}

test("a researcher's frame carries no operator flag and no switched-off bodies by default", async (t) => {
  const f = await bootstrapFor(t);
  const frame = await frameObject(f);
  assert.equal(frame.operator, false);
  assert.deepEqual([...frame.off], []);
  assert.ok(Object.isFrozen(frame));
});

test("an operator's frame says so, and the deployment's switched-off bodies arrive by name", async (t) => {
  const f = await bootstrapFor(t, { runtimeUiFrameOff: "Theme, panels ,not a body!,commands" });
  f.app.config.operatorUsers = [f.userId];
  const frame = await frameObject(f);
  assert.equal(frame.operator, true);
  // Names are normalised and anything that is not a plain name is dropped.
  assert.deepEqual([...frame.off], ["theme", "panels", "commands"]);
});

test("each capability card carries its summary and typical duration for the /能力 command", async (t) => {
  const f = await bootstrapFor(t);
  const frame = await frameObject(f);
  assert.ok(Array.isArray(frame.capabilities));
  assert.ok(frame.capabilities.length >= 10, `only ${frame.capabilities.length} cards reached the frame; the catalogue was not read`);
  for (const card of frame.capabilities) {
    assert.equal(typeof card.summary, "string");
    assert.ok(card.summary.length > 0, `${card.id} has no summary`);
    assert.ok(Array.isArray(card.minutes) && card.minutes.length === 2 && card.minutes[0] <= card.minutes[1], `${card.id} has no duration`);
  }
});
