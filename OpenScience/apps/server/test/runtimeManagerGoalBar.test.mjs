// `RuntimeManager.goalBar` over a real socket: a fake of it in the goal service's tests hid that it read the kernel's answer the wrong way, so
// every call came back a fault on a real kernel while every test passed (drills of 2026-11-03).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { RuntimeManager } from "../src/runtimeManager.mjs";

const PROJECT = { id: "project-a", userId: "user-a" };
const READ = { v: "loopx_goalbar_request_v2", op: "read", sessionId: "s" };

/** @param {import('node:test').TestContext} t @param {(body: any) => { status?: number, text: string }} answer */
async function kernel(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ path: req.url, method: req.method, cookie: req.headers.cookie, type: req.headers["content-type"], body });
      const { status = 200, text } = answer(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const manager = new RuntimeManager({ maxJsonBytes: 1 << 20 });
  manager.runtimes.set(manager.key(PROJECT), { url: `http://127.0.0.1:${port}`, cookie: "kernel=1" });
  return { manager, seen };
}

test("the bar's answer is read from the kernel's own response, and the request is the bar's own, without the wire's args envelope", async (t) => {
  const value = { v: "loopx_goalbar_response_v2", op: "read", sessionId: "s", result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active" } } };
  const { manager, seen } = await kernel(t, (body) => ({ text: JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }) }));
  assert.deepEqual(await manager.goalBar(PROJECT, READ), value);
  assert.equal(seen[0].path, "/api/loopx.goalbar");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].cookie, "kernel=1");
  assert.equal(seen[0].type, "application/json");
  assert.equal(seen[0].body.type, "client-request");
  assert.equal(seen[0].body.method, "loopx.goalbar");
  assert.deepEqual(seen[0].body.payload, READ);
});

test("a refusal says its code, and an answer nobody can read is a fault of its own", async (t) => {
  const refused = await kernel(t, () => ({ text: JSON.stringify({ result: { ok: false, error: { code: "bad-request" } } }) }));
  assert.deepEqual((await refused.manager.goalBar(PROJECT, READ)).result, { kind: "fault", code: "bad-request" });
  const garbled = await kernel(t, () => ({ status: 502, text: "<html>" }));
  assert.deepEqual((await garbled.manager.goalBar(PROJECT, READ)).result, { kind: "fault", code: "goalbar_unreachable" });
});

test("with no runtime up there is nobody to ask", async () => {
  const manager = new RuntimeManager({ maxJsonBytes: 1 << 20 });
  assert.deepEqual((await manager.goalBar(PROJECT, READ)).result, { kind: "fault", code: "runtime_not_running" });
});
