// A dispatch that meets a runtime (or the runtime controller) being replaced is a retryable 503 with a named code, never a 500.
//
// Seen on the benchmark host on 2026-10-28: a release switch recreates the runtime controller, which removes every project
// runtime, and the dispatch in flight left through the generic handler as `500 internal_error` (the error ledger's cause was
// `ECONNRESET`) while the next dispatch, three seconds later, got the controller's own `503 runtime_controller_unavailable`.
// The controller side was already coded; the kernel call after a start was not.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { errorCodeMessage } from "@evimed/domain";

import { RuntimeControllerClient } from "../src/runtimeControllerClient.mjs";
import { kernelTransportRefusal } from "../src/runtimeManager.mjs";
import { HttpError } from "../src/security.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { noProfile } from "./helpers/residentProfileDouble.mjs";

const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };

/** A listener that accepts a connection and drops it: what the kernel's port looks like while its container is being removed. */
async function resettingServer() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {string} code @param {string} [name] */
const socketError = (code, name = "Error") => Object.assign(new Error(code), { code, name });

test("a kernel call that lost its connection is a 503 runtime_unavailable that says when to ask again; nothing else is rewritten", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT", "ETIMEDOUT", "ERR_STREAM_PREMATURE_CLOSE"]) {
    const refusal = /** @type {any} */ (kernelTransportRefusal(socketError(code)));
    assert.ok(refusal instanceof HttpError, `${code} is ours now`);
    assert.equal(refusal.status, 503, code);
    assert.equal(refusal.code, "runtime_unavailable", code);
    assert.equal(refusal.retryAfterSeconds, 5, code);
    assert.equal(refusal.cause?.code, code, "the socket's own code stays on the refusal for the log");
  }
  // A response the runtime cut short is an AbortError while the caller's signal is still live.
  const cut = /** @type {any} */ (kernelTransportRefusal(new DOMException("Runtime response closed early.", "AbortError"), new AbortController().signal));
  assert.equal(cut.code, "runtime_unavailable");

  const ours = new HttpError(502, "runtime_wire_protocol_mismatch", "protocol");
  assert.equal(kernelTransportRefusal(ours), ours, "an error that is already ours is passed through, status and code intact");
  const mistake = new TypeError("not a transport failure");
  assert.equal(kernelTransportRefusal(mistake), mistake, "a defect is not dressed up as an outage");
  const unknownErrno = socketError("EACCES");
  assert.equal(kernelTransportRefusal(unknownErrno), unknownErrno, "an errno outside the closed set is not claimed");

  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  const aborted = socketError("ECONNRESET");
  assert.equal(kernelTransportRefusal(aborted, controller.signal), aborted, "after the caller's own abort the deadline decides (504), not this");
  assert.equal(kernelTransportRefusal("ECONNRESET"), "ECONNRESET", "a non-error is returned as it came");
});

test("runtime_unavailable has a Chinese sentence for the person who meets it", () => {
  assert.match(errorCodeMessage("runtime_unavailable"), /运行时/);
});

/** @param {(context: { base: string, manager: any, resetting: { url: string }, failing: Map<string, () => unknown> }) => Promise<void>} fn */
async function withApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-dispatch-unavailable-"));
  const resetting = await resettingServer();
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true,
    memorySettings: {
      configured: false,
      async status() { return { configured: false, connected: false, code: null }; },
      async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
      async sessionState() { return { trialCapsuleId: null }; },
    },
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    app.residentProfiles.forDispatch = noProfile;
    const manager = app.runtimeManager;
    /** Kernel methods that fail, by name: the real transport over a dead port, or a thrown value. */
    const failing = new Map();
    const callKernel = manager.callKernel.bind(manager);
    manager.callKernel = (/** @type {any} */ runtime, /** @type {any} */ project, /** @type {string} */ method, /** @type {any} */ payload, /** @type {any} */ signal, /** @type {any} */ options) => {
      const failure = failing.get(method);
      if (failure === "reset") return callKernel({ ...runtime, url: resetting.url }, project, method, payload, signal, options);
      if (typeof failure === "function") return Promise.reject(failure());
      return callKernel(runtime, project, method, payload, signal, options);
    };
    await fn({ base: `http://127.0.0.1:${address.port}`, manager, resetting, failing });
  } finally {
    await app.close();
    await resetting.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** @param {string} base @param {string} sessionId @param {string} dispatchId */
async function dispatch(base, sessionId, dispatchId = `turn_${sessionId}`) {
  const bound = await fetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) });
  assert.equal(bound.status, 200);
  const response = await fetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST", headers, body: JSON.stringify({ sessionId, dispatchId, text: "what is a cohort study", automated: true }),
  });
  return { response, body: await response.json() };
}

test("a dispatch whose runtime drops the connection before the prompt is sent answers 503 runtime_unavailable, and the run says so", async () => {
  await withApp(async ({ base, failing }) => {
    failing.set("session/create", "reset");
    const { response, body } = await dispatch(base, "ses_reset_create");
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.code, "runtime_unavailable");
    assert.equal(response.headers.get("retry-after"), "5");

    const listed = await (await fetch(`${base}/api/agent-runs`, { headers })).json();
    const run = listed.data.find((/** @type {any} */ item) => item.sessionId === "ses_reset_create");
    assert.ok(run, "the dispatch left a run behind");
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "runtime_unavailable", "the run carries our code, not the socket's (ECONNRESET)");
  });
});

test("a dispatch whose connection drops after the prompt was sent is the same 503, and asking again with its id finds the run it began", async () => {
  await withApp(async ({ base, failing }) => {
    failing.set("session/prompt", "reset");
    const first = await dispatch(base, "ses_reset_prompt", "turn_reset_prompt");
    assert.equal(first.response.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.code, "runtime_unavailable");

    failing.clear();
    const again = await dispatch(base, "ses_reset_prompt", "turn_reset_prompt");
    assert.equal(again.response.status, 202, JSON.stringify(again.body));
    const listed = await (await fetch(`${base}/api/agent-runs`, { headers })).json();
    assert.equal(listed.data.filter((/** @type {any} */ item) => item.sessionId === "ses_reset_prompt").length, 1, "one run, not two prompts");
  });
});

test("a defect inside the dispatch is still an internal error: only a lost connection is an outage", async () => {
  await withApp(async ({ base, failing }) => {
    failing.set("session/create", () => new TypeError("a bug in our own code"));
    const { response, body } = await dispatch(base, "ses_defect");
    assert.equal(response.status, 500, JSON.stringify(body));
    assert.equal(body.code, "internal_error");
  });
});

test("the runtime controller being replaced is a 503 runtime_controller_unavailable whichever way its socket fails", async (t) => {
  const dir = await mkdtemp(path.join("/tmp", "p01-rc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const refused = { status: 503, code: "runtime_controller_unavailable" };

  // The socket file is gone: the controller container was removed and its replacement has not bound yet.
  const missing = new RuntimeControllerClient({ runtimeControllerSocket: path.join(dir, "gone.sock") });
  await assert.rejects(() => missing.health(), refused);

  // A parent directory that cannot be inspected (here a file where a directory should be) used to leave as a raw ENOTDIR.
  await writeFile(path.join(dir, "plain"), "");
  const blocked = new RuntimeControllerClient({ runtimeControllerSocket: path.join(dir, "plain", "inner", "c.sock") });
  await assert.rejects(() => blocked.health(), refused);

  // The controller accepts the connection and the container dies under it.
  await mkdir(path.join(dir, "run"));
  const socketPath = path.join(dir, "run", "c.sock");
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dropped = new RuntimeControllerClient({ runtimeControllerSocket: socketPath, runtimeControllerTimeoutMs: 2_000 });
  await assert.rejects(() => dropped.health(), refused);
});
