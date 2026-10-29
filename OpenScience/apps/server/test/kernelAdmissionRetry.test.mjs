import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { kernelAdmissionRetries, requestRuntime } from "../src/runtimeManager.mjs";

/** A kernel on a unix socket that refuses the first `refusals` requests at admission, as one whose Connection is being rebuilt does. */
async function kernel(t, refusals) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kernel-admission-"));
  const socketPath = path.join(dir, "kernel.sock");
  /** @type {string[]} */
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      if (bodies.length <= refusals) { res.writeHead(401); res.end("unauthorized"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seen: body }));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await rm(dir, { recursive: true, force: true });
  });
  return { runtime: { url: "http://dsh.runtime", socketPath }, bodies };
}

test("a request the kernel refused at admission while its Connection was rebuilt is sent again, body and all, and admitted", async (t) => {
  const { runtime, bodies } = await kernel(t, 1);
  const before = { ...kernelAdmissionRetries };
  const response = await requestRuntime(runtime, `${runtime.url}/api/session/create`, { method: "POST", body: Buffer.from('{"a":1}') }, { retryDelaysMs: [1, 1] });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await new Response(response.body).text()), { ok: true, seen: '{"a":1}' });
  assert.deepEqual(bodies, ['{"a":1}', '{"a":1}'], "the second attempt carries the same body");
  assert.equal(kernelAdmissionRetries.recovered, before.recovered + 1);
  assert.equal(kernelAdmissionRetries.persisted, before.persisted);
});

test("a 401 that outlives the retries is returned as it is and counted as persisted, after a bounded number of attempts", async (t) => {
  const { runtime, bodies } = await kernel(t, Infinity);
  const before = { ...kernelAdmissionRetries };
  const response = await requestRuntime(runtime, `${runtime.url}/api/session/list`, { method: "POST", body: "{}" }, { retryDelaysMs: [1, 1] });
  await response.body?.cancel().catch(() => {});
  assert.equal(response.status, 401);
  assert.equal(bodies.length, 3, "one attempt and two retries, no more");
  assert.equal(kernelAdmissionRetries.persisted, before.persisted + 1);
});

test("a streamed body is never sent twice: its 401 is the answer", async (t) => {
  const { runtime, bodies } = await kernel(t, 1);
  const response = await requestRuntime(runtime, `${runtime.url}/api/upload`, { method: "POST", body: Readable.from(["streamed"]) }, { retryDelaysMs: [1, 1] });
  await response.body?.cancel().catch(() => {});
  assert.equal(response.status, 401);
  assert.deepEqual(bodies, ["streamed"]);
});

test("an answer that is not a 401 is never retried", async (t) => {
  const { runtime, bodies } = await kernel(t, 0);
  const response = await requestRuntime(runtime, `${runtime.url}/api/session/list`, { method: "GET" }, { retryDelaysMs: [1, 1] });
  await response.body?.cancel().catch(() => {});
  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
});
