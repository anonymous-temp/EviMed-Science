// The identity shim, run as it runs in the engine's container: the shipped Python file, against a fake Compile runtime
// that refuses what the real bot refuses — a trusted request that names no account and no user.
//
// The shim exists because OpenViking v0.5.0 in trusted mode forwards only the root key to its Compile runtime. It reads
// the user from the target URI the server already authorized, adds the two identity headers, and wraps the session id so
// that the status and cancel calls, which carry nothing but that id, can be attributed too — without keeping a table.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENVIKING_SHIM_PORT } from "../src/openVikingLayout.mjs";

const shim = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/web/openviking/identity_shim.py");
const python = ["python3", "python"].find((command) => spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { stdio: "ignore" }).status === 0);
const options = { skip: !python && "Python 3 is required to run the shim" };

function fakeRuntime() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ path: request.url, headers: request.headers, body });
      if (!request.headers["x-openviking-account"] || !request.headers["x-openviking-user"]) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "Trusted OpenViking chat requires X-OpenViking-Account and X-OpenViking-User." }));
        return;
      }
      if (request.url === "/runtime/v1/tasks") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ session_id: request.headers["idempotency-key"], task_id: request.headers["idempotency-key"], status: "accepted", to: body.payload.to }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "running", stage: "compile: agent", error: null, meta: {}, echo: { session: body.session_id, user: request.headers["x-openviking-user"] } }));
    });
  });
  return { server, seen };
}

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startShim(t, upstream, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(python, ["-I", shim], { env: { PATH: process.env.PATH, SHIM_LISTEN_PORT: String(port), SHIM_UPSTREAM: upstream, SHIM_ACCOUNT: "evimed", ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
  let banner = "";
  child.stderr.on("data", (chunk) => { banner += chunk; });
  t.after(() => { child.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 100 && !banner.includes("identity shim on"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(banner, new RegExp(`identity shim on 127\\.0\\.0\\.1:${port} -> `), "the shim did not start on the loopback");
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, port };
}

test("the shim adds the identity the server authorized, wraps and unwraps the session id, and refuses what it cannot attribute", options, async (t) => {
  const { server, seen } = fakeRuntime();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const { post } = await startShim(t, `http://127.0.0.1:${server.address().port}`);

  const user = "u-0f1e2d3c4b5a69788796a5b4";
  const target = `viking://user/${user}/resources/p/p-3c2b1a0998877665ffeeddcc/wiki`;
  const created = await post("/runtime/v1/tasks", { task_type: "compile", payload: { from: [`viking://user/${user}/resources/p/p-3c2b1a0998877665ffeeddcc/sources`], to: target, skill: "viking://agent/skills/llm-wiki" } },
    { "X-API-Key": "root-key", "Idempotency-Key": "cmp_abc", "X-Tt-Logid": "req-1" });
  assert.equal(created.status, 202);
  assert.equal(created.body.session_id, `${user}~cmp_abc`, "the session id does not carry the user the later calls need");
  assert.equal(seen[0].headers["x-openviking-account"], "evimed");
  assert.equal(seen[0].headers["x-openviking-user"], user);
  // What the server sent is passed on untouched: its key, its idempotency key, its request id.
  assert.equal(seen[0].headers["x-api-key"], "root-key");
  assert.equal(seen[0].headers["idempotency-key"], "cmp_abc");
  assert.equal(seen[0].headers["x-tt-logid"], "req-1");
  assert.equal(seen[0].body.payload.to, target);

  const polled = await post("/runtime/v1/tasks/status", { session_id: created.body.session_id }, { "X-API-Key": "root-key" });
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.body.echo, { session: "cmp_abc", user });
  const cancelled = await post("/runtime/v1/tasks/cancel", { session_id: created.body.session_id }, { "X-API-Key": "root-key" });
  assert.deepEqual(cancelled.body.echo, { session: "cmp_abc", user });

  // A target outside every user's root has no user to assert. This refusal is also the control plane's no-spend probe:
  // its sentence is what proves it was the shim that answered (`openVikingEngine.mjs`).
  const shared = await post("/runtime/v1/tasks", { task_type: "compile", payload: { from: ["viking://agent/skills/llm-wiki"], to: "viking://resources/evimed-shim-probe", skill: "viking://agent/skills/llm-wiki" } });
  assert.equal(shared.status, 400);
  assert.equal(shared.body.detail.code, "INVALID_ARGUMENT");
  assert.match(shared.body.detail.message, /^identity shim: /);
  // Only what the engine itself accepts as a user id is ever asserted: its alphabet, never `.` or `..`, one `@` at most.
  for (const to of ["viking://user/../resources/x", "viking://user/./resources/x", "viking://user/a b/resources/x", "viking://user//resources/x", "viking://user/a@b@c/x", "https://user/u1/x"]) {
    assert.equal((await post("/runtime/v1/tasks", { task_type: "compile", payload: { from: [], to, skill: "viking://agent/skills/llm-wiki" } })).status, 400, to);
  }
  for (const sessionId of ["cmp_abc", "~cmp_abc", "u1~", "a b~cmp_abc", "..~cmp_abc", 7]) {
    assert.equal((await post("/runtime/v1/tasks/status", { session_id: sessionId })).status, 400, String(sessionId));
  }
  // It serves the three Compile routes and nothing else of the bot's — its chat interface least of all.
  const elsewhere = await post("/bot/v1/chat", { message: "hi" });
  assert.equal(elsewhere.status, 404);
  assert.equal(elsewhere.body.detail.code, "NOT_FOUND");
  assert.equal(seen.length, 3, "something the shim refused reached the runtime");
});

test("a runtime that does not answer is a 503 the server retries, and the shim itself keeps answering", options, async (t) => {
  const { post } = await startShim(t, "http://127.0.0.1:9", { SHIM_UPSTREAM_TIMEOUT_SECONDS: "2" });
  const answer = await post("/runtime/v1/tasks/status", { session_id: "u1~cmp_x" });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.detail.code, "UNAVAILABLE");
  assert.equal((await post("/", {})).status, 404, "the shim stopped answering after its upstream failed");
});

test("the shipped defaults are the ones the configuration and the health check name", options, () => {
  // Started with no environment at all, it listens where `compile_api.base_url` points and forwards to the bot's own port.
  const result = spawnSync(python, ["-I", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("identity_shim", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(module.LISTEN_HOST, module.LISTEN_PORT, module.UPSTREAM, module.ACCOUNT, module.SEPARATOR)
`, shim], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `127.0.0.1 ${OPENVIKING_SHIM_PORT} http://127.0.0.1:18790 evimed ~`);
});
