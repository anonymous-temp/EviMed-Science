import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const driver = fileURLToPath(new URL("../../../scripts/ops/capability-acceptance.mjs", import.meta.url));
const originalRun = { id: "run-fixture", sessionId: "real-session", status: "running", effectiveAgentId: "meta-analysis", startedAt: "2026-09-29T01:00:00Z", artifacts: [] };
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-acceptance-driver-"));
  const requests = []; let current = { ...originalRun }; let pollFailure = false; let pollTransport = null;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    let data = null; let status = 200;
    if (request.url === "/api/auth/login") { response.setHeader("set-cookie", "fixture=only; HttpOnly"); data = { csrfToken: "fixture" }; }
    else if (request.url === "/api/projects") data = [{ id: "shared" }];
    else if (request.url === "/api/agents") data = [{ id: "meta-analysis", version: "1", runtimeAgent: "meta" }];
    else if (request.url === "/api/agent-runs") {
      if (pollTransport && requests.filter((item) => item.url === "/api/agent-runs").length > 1) {
        if (pollTransport === "disconnect") request.socket.destroy();
        return;
      }
      if (pollFailure && requests.filter((item) => item.url === "/api/agent-runs").length > 1) status = 503;
      else data = [current, { id: "another-run", status: "running", sessionId: "another-session" }];
    } else if (request.url?.startsWith("/api/research-sessions/")) data = {};
    else if (request.url === "/api/agent-runs/dispatch") { status = 202; data = current; }
    else if (request.url === "/api/commands/read_artifact") data = { encoding: "utf8", data: "Preserved useful partial results." };
    else if (request.url === "/api/commands/stop_runtime") data = {};
    else status = 404;
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = path.join(root, "scripts/ops/capability-acceptance.mjs");
  await fs.mkdir(path.dirname(script), { recursive: true }); await fs.copyFile(driver, script);
  await fs.mkdir(path.join(root, "evals/fixture"), { recursive: true });
  await fs.writeFile(path.join(root, "evals/acceptance-ledger.json"), JSON.stringify({ capabilities: [{ id: "meta-analysis", evalHarness: "evals/fixture" }] }));
  await fs.writeFile(path.join(root, "evals/fixture/briefs.json"), JSON.stringify({ capability: "meta-analysis", briefs: [{ id: "fixture-case", inputs: { topic: "Offline fixture" } }] }));
  const passwordFile = path.join(root, "fixture-login"); await fs.writeFile(passwordFile, "unused-fixture-value", { mode: 0o600 });
  const run = async ({ attach = true, timeout = 30 } = {}) => {
    const args = [script, "--capability", "meta-analysis", "--brief", "fixture-case", "--base", base, "--project", "shared", "--timeout-ms", String(timeout), "--poll-ms", "1", ...(attach ? ["--run", current.id] : [])];
    try { const result = await execute(process.execPath, args, { timeout: 5000, env: { PATH: process.env.PATH, OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE: passwordFile, OPEN_SCIENCE_ACCEPTANCE_USERNAME: "fixture" } }); return { ...result, code: 0 }; }
    catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const records = async () => Promise.all((await fs.readdir(path.join(root, "evals/fixture/results"))).sort().map(async (name) => ({
    directory: path.join(root, "evals/fixture/results", name), record: JSON.parse(await fs.readFile(path.join(root, "evals/fixture/results", name, "run.json"), "utf8")),
  })));
  try { await fn({ root, run, records, requests, setRun: (value) => { current = value; }, failPolls: () => { pollFailure = true; }, transport: (mode) => { pollTransport = mode; } }); }
  finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
}

test("a newly dispatched run outliving its observation budget stays running and can resume the same ID", async () => fixture(async (f) => {
  const result = await f.run({ attach: false });
  assert.equal(f.requests.some((request) => /stop_runtime|cancel/.test(request.url)), false);
  assert.equal(result.code, 3, "pending observation is distinct from failed execution");
  const [{ record }] = await f.records();
  assert.equal(record.outcome.status, "running");
  assert.equal(record.observation.status, "pending");
  assert.match(result.stdout, /--run ['"]?run-fixture/);
  const resumed = await f.run();
  assert.equal(resumed.code, 3);
  assert.equal(f.requests.filter((request) => request.url === "/api/agent-runs/dispatch").length, 1);
  assert.equal((await f.records()).length, 2, "both observations are preserved");
}));

test("poll failures persist a pending observation without stopping or redispatching the attached run", async () => fixture(async (f) => {
  f.failPolls(); const result = await f.run();
  assert.equal(result.code, 3);
  assert.equal(f.requests.some((request) => /stop_runtime|cancel|\/dispatch$/.test(request.url)), false);
  const [{ record }] = await f.records();
  assert.equal(record.session, "real-session");
  assert.equal(record.dispatchedAt, originalRun.startedAt);
  assert.equal(record.observation.status, "pending");
  assert.equal(record.observation.reason, "poll_unavailable");
  assert.ok(Number.isFinite(Date.parse(record.observedAt)));
}));

for (const status of ["succeeded", "failed", "canceled"]) test(`attached ${status} keeps its actual terminal state and partial files while other work continues`, async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status, finishedAt: "2026-09-29T01:10:00Z", durationMs: 600000, errorCode: status === "failed" ? "runtime_died" : null, artifacts: ["partial/report.md"] });
  const result = await f.run();
  assert.equal(f.requests.some((request) => /stop_runtime|cancel|\/dispatch$/.test(request.url)), false);
  assert.equal(result.code, status === "succeeded" ? 0 : 1);
  const [{ record, directory }] = await f.records();
  assert.equal(record.outcome.status, status);
  assert.equal(record.observation.status, "terminal");
  assert.equal(record.outcome.finishedAt, "2026-09-29T01:10:00Z");
  assert.equal(await fs.readFile(path.join(directory, "deliverable/partial/report.md"), "utf8"), "Preserved useful partial results.");
}));

for (const mode of ["disconnect", "hang"]) test(`a ${mode} during polling consumes only the observation deadline`, async () => fixture(async (f) => {
  f.transport(mode);
  const result = await f.run({ timeout: 40 });
  assert.equal(result.code, 3);
  assert.equal(f.requests.some((request) => /stop_runtime|cancel|\/dispatch$/.test(request.url)), false);
  const [{ record }] = await f.records();
  assert.equal(record.runId, "run-fixture");
  assert.equal(record.observation.status, "pending");
  assert.equal(record.observation.reason, "poll_unavailable");
}));

test("a pending observation can be resumed to a terminal one without replacing either record or starting another run", async () => fixture(async (f) => {
  const pending = await f.run();
  assert.equal(pending.code, 3);
  f.setRun({ ...originalRun, status: "succeeded", finishedAt: "2026-09-29T02:00:00Z", durationMs: 3600000 });
  const completed = await f.run();
  assert.equal(completed.code, 0);
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(({ record }) => record.runId), ["run-fixture", "run-fixture"]);
  assert.deepEqual(new Set(records.map(({ record }) => record.observation.status)), new Set(["pending", "terminal"]));
  assert.equal(f.requests.some((request) => /stop_runtime|cancel|\/dispatch$/.test(request.url)), false);
}));
