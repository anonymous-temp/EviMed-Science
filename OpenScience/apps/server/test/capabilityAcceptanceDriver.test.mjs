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
const helper = fileURLToPath(new URL("../../../scripts/ops/throwaway-account.mjs", import.meta.url));
const originalRun = { id: "run-fixture", sessionId: "real-session", status: "running", effectiveAgentId: "meta-analysis", startedAt: "2026-09-29T01:00:00Z", artifacts: [] };
async function fixture(fn, { deleteStatus = 200, dispatchStatus = 202 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-acceptance-driver-"));
  const requests = []; let current = { ...originalRun }; let pollFailure = false; let pollTransport = null; let artifactHang = false; let dispatchCount = 0;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie ?? null, csrf: request.headers["x-open-science-csrf"] ?? null, body: raw ? JSON.parse(raw) : null });
    let data = null; let status = 200;
    if (request.url === "/api/auth/register") { response.setHeader("set-cookie", "fixture=only; HttpOnly"); data = { csrfToken: "fixture" }; status = 201; }
    else if (request.url === "/api/account" && request.method === "DELETE") { status = deleteStatus; data = deleteStatus === 200 ? true : null; }
    else if (request.url === "/api/projects" && request.method === "POST") { status = 201; data = { id: "created" }; }
    else if (request.url === "/api/agents") data = [{ id: "meta-analysis", version: "1", runtimeAgent: "meta" }];
    else if (request.url === "/api/agent-runs") {
      if (pollTransport) {
        if (pollTransport === "disconnect") request.socket.destroy();
        return;
      }
      if (pollFailure) status = 503;
      else data = [current, { id: "another-run", status: "running", sessionId: "another-session" }];
    } else if (request.url?.startsWith("/api/research-sessions/")) data = {};
    else if (request.url === "/api/agent-runs/dispatch") { dispatchCount += 1; status = dispatchStatus; data = { ...current, id: dispatchCount === 1 ? current.id : `${current.id}-turn${dispatchCount}` }; }
    else if (request.url === `/api/agent-runs/${originalRun.id}/cancel`) data = { run: { ...current, status: "canceled" } };
    else if (request.url === "/api/commands/read_artifact") { if (artifactHang) return; data = { encoding: "utf8", data: "Preserved useful partial results." }; }
    else if (request.url === "/api/commands/stop_runtime") data = {};
    else status = 404;
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = path.join(root, "scripts/ops/capability-acceptance.mjs");
  await fs.mkdir(path.dirname(script), { recursive: true }); await fs.copyFile(driver, script);
  await fs.copyFile(helper, path.join(root, "scripts/ops/throwaway-account.mjs"));
  await fs.mkdir(path.join(root, "evals/fixture"), { recursive: true });
  await fs.writeFile(path.join(root, "evals/acceptance-ledger.json"), JSON.stringify({ capabilities: [{ id: "meta-analysis", evalHarness: "evals/fixture" }] }));
  await fs.writeFile(path.join(root, "evals/fixture/briefs.json"), JSON.stringify({ capability: "meta-analysis", briefs: [{ id: "fixture-case", inputs: { topic: "Offline fixture" } }] }));
  const run = async ({ timeout = 30, artifactTimeout = 40, execTimeout = 5000, extra = [] } = {}) => {
    const args = [script, "--capability", "meta-analysis", "--brief", "fixture-case", "--base", base, "--project", "shared", "--timeout-ms", String(timeout), "--poll-ms", "1", "--artifact-timeout-ms", String(artifactTimeout), ...extra];
    try { const result = await execute(process.execPath, args, { timeout: execTimeout, env: { PATH: process.env.PATH } }); return { ...result, code: 0 }; }
    catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const records = async () => Promise.all((await fs.readdir(path.join(root, "evals/fixture/results"))).sort().map(async (name) => ({
    directory: path.join(root, "evals/fixture/results", name), record: JSON.parse(await fs.readFile(path.join(root, "evals/fixture/results", name, "run.json"), "utf8")),
  })));
  const at = (method, url) => requests.findIndex((item) => item.method === method && item.url === url);
  try { await fn({ root, run, records, requests, at, setRun: (value) => { current = value; }, failPolls: () => { pollFailure = true; }, transport: (mode) => { pollTransport = mode; }, hangArtifacts: () => { artifactHang = true; } }); }
  finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
}
const cancelled = (requests) => requests.some((request) => /\/cancel$/.test(request.url));
const stopped = (requests) => requests.some((request) => /stop_runtime/.test(request.url));

test("the run is made in a throwaway account that is registered first, signs the requests, and is deleted last", async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status: "succeeded", finishedAt: "2026-09-29T01:10:00Z", artifacts: [] });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const [register] = f.requests;
  assert.equal(register.url, "/api/auth/register");
  assert.match(register.body.username, /^acc-\d{12}-[0-9a-f]{6}$/);
  assert.ok(register.body.password.length >= 24);
  assert.equal(f.requests.some((request) => request.url === "/api/auth/login"), false, "nobody is signed in as");
  const signed = f.requests.filter((request) => !["/api/auth/register", "/api/account"].includes(request.url));
  assert.ok(signed.length >= 3 && signed.every((request) => request.cookie === "fixture=only" && request.csrf === "fixture"), "every other request carries the registered session");
  assert.equal(f.requests.at(-1).method, "DELETE");
  assert.equal(f.requests.at(-1).url, "/api/account");
  assert.deepEqual(f.requests.at(-1).body, { confirm: register.body.username, password: register.body.password });
  assert.ok(f.at("POST", "/api/projects") > 0 && f.at("POST", "/api/projects") < f.at("POST", "/api/agent-runs/dispatch"), "the project is made in the new account");
  assert.deepEqual(f.requests.find((request) => request.url === "/api/projects").body, { id: "shared", name: "Acceptance meta-analysis" });
  assert.match(result.stdout, new RegExp(`account created: ${register.body.username}`));
  assert.match(result.stdout, new RegExp(`account deleted: ${register.body.username}`));
  assert.equal(result.stdout.includes(register.body.password) || result.stderr.includes(register.body.password), false, "the password is never printed");
  assert.equal(cancelled(f.requests) || stopped(f.requests), false, "a finished run is not cancelled");
}));

test("a run outliving its observation budget is recorded pending, cancelled with its account, and cannot be resumed", async () => fixture(async (f) => {
  const result = await f.run();
  assert.equal(result.code, 3, "pending observation is distinct from failed execution");
  assert.equal(f.requests.some((request) => request.url === "/api/agent-runs/dispatch"), true);
  const [{ record }] = await f.records();
  assert.equal(record.outcome.status, "running");
  assert.equal(record.observation.status, "pending");
  assert.match(record.observation.note, /cancelled when the driver's throwaway account was deleted/);
  assert.match(result.stdout, /PENDING.*cancelled with the throwaway account.*longer --timeout-ms/);
  assert.doesNotMatch(result.stdout, /Resume:|--run/);
  assert.ok(f.at("POST", "/api/agent-runs/run-fixture/cancel") > f.at("POST", "/api/agent-runs/dispatch") && f.at("POST", "/api/agent-runs/run-fixture/cancel") < f.at("DELETE", "/api/account"), "cancelled first, then the account goes");
  assert.equal(stopped(f.requests), false);
}));

test("poll failures persist a pending observation and never redispatch; the account's deletion ends the run", async () => fixture(async (f) => {
  f.failPolls(); const result = await f.run();
  assert.equal(result.code, 3);
  assert.equal(f.requests.filter((request) => request.url === "/api/agent-runs/dispatch").length, 1);
  assert.equal(stopped(f.requests), false);
  const [{ record }] = await f.records();
  assert.equal(record.session.startsWith("acc-meta-analysis-") || record.session === "real-session", true);
  assert.equal(record.dispatchedAt, originalRun.startedAt);
  assert.equal(record.observation.status, "pending");
  assert.equal(record.observation.reason, "poll_unavailable");
  assert.ok(Number.isFinite(Date.parse(record.observedAt)));
  assert.equal(f.requests.at(-1).url, "/api/account");
}));

for (const status of ["succeeded", "failed", "canceled"]) test(`a ${status} run keeps its actual terminal state and partial files, and is not cancelled`, async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status, finishedAt: "2026-09-29T01:10:00Z", durationMs: 600000, errorCode: status === "failed" ? "runtime_died" : null, artifacts: ["partial/report.md"] });
  const result = await f.run();
  assert.equal(cancelled(f.requests) || stopped(f.requests), false);
  assert.equal(f.requests.filter((request) => request.url === "/api/agent-runs/dispatch").length, 1);
  assert.equal(result.code, status === "succeeded" ? 0 : 1);
  const [{ record, directory }] = await f.records();
  assert.equal(record.outcome.status, status);
  assert.equal(record.observation.status, "terminal");
  assert.equal(record.outcome.finishedAt, "2026-09-29T01:10:00Z");
  assert.equal(await fs.readFile(path.join(directory, "deliverable/partial/report.md"), "utf8"), "Preserved useful partial results.");
  assert.equal(f.requests.at(-1).url, "/api/account", "the account is deleted after the files are saved");
}));

for (const mode of ["disconnect", "hang"]) test(`a ${mode} during polling consumes only the observation deadline`, async () => fixture(async (f) => {
  f.transport(mode);
  const result = await f.run({ timeout: 40 });
  assert.equal(result.code, 3);
  assert.equal(stopped(f.requests), false);
  assert.equal(f.requests.filter((request) => request.url === "/api/agent-runs/dispatch").length, 1);
  const [{ record }] = await f.records();
  assert.equal(record.runId, "run-fixture");
  assert.equal(record.observation.status, "pending");
  assert.equal(record.observation.reason, "poll_unavailable");
  assert.equal(f.requests.at(-1).url, "/api/account");
}));

test("two runs of one brief each get an account of their own, and both records are kept", async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status: "succeeded", finishedAt: "2026-09-29T02:00:00Z", durationMs: 3600000 });
  assert.equal((await f.run()).code, 0);
  assert.equal((await f.run()).code, 0);
  const registrations = f.requests.filter((request) => request.url === "/api/auth/register");
  assert.equal(registrations.length, 2);
  assert.notEqual(registrations[0].body.username, registrations[1].body.username);
  assert.deepEqual(f.requests.filter((request) => request.method === "DELETE").map((request) => request.body.confirm), registrations.map((request) => request.body.username));
  assert.equal((await f.records()).length, 2, "both observations are preserved");
}));

for (const status of ["running", "succeeded"]) test(`hanging artifact reads cannot trap a ${status} observation after its deadline`, async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status, artifacts: ["partial/report.md"] });
  f.hangArtifacts();
  const result = await f.run({ artifactTimeout: 40, execTimeout: 4000 });
  assert.equal(result.code, status === "running" ? 3 : 0);
  assert.equal(cancelled(f.requests), status === "running", "only a run still going is cancelled, with its account");
  const [{ record }] = await f.records();
  assert.equal(record.outcome.status, status);
  assert.equal(record.observation.status, status === "running" ? "pending" : "terminal");
  assert.match(result.stdout, /could not read partial\/report.md|artifact capture budget/);
  assert.equal(f.requests.at(-1).url, "/api/account");
}));

test("a driver error still deletes the account, and says the error", async () => fixture(async (f) => {
  const result = await f.run();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /dispatch failed: 500/);
  assert.equal(f.requests.at(-1).url, "/api/account", "deleted after the dispatch failed");
  assert.match(result.stdout, /account deleted: acc-/);
}, { dispatchStatus: 500 }));

test("an account that cannot be deleted is exit 4 and a FAIL line naming it, ahead of what the run found", async () => fixture(async (f) => {
  f.setRun({ ...originalRun, status: "succeeded", finishedAt: "2026-09-29T01:10:00Z" });
  const result = await f.run();
  assert.equal(result.code, 4, result.stderr + result.stdout);
  const { username, password } = f.requests[0].body;
  assert.match(result.stdout, new RegExp(`FAIL account ${username} was NOT deleted \\(403`));
  assert.equal(result.stdout.includes(password) || result.stderr.includes(password), false);
  assert.equal((await f.records()).length, 1, "what the run delivered is kept");
}, { deleteStatus: 403 }));

test("what a new account cannot have is refused before one is made: a run or a GEO project to attach to, an export with no project", async () => fixture(async (f) => {
  await fs.writeFile(path.join(f.root, "prompt.txt"), "a prompt");
  for (const [extra, said] of [
    [["--run", "run-fixture"], /--run and --geo-project are gone/],
    [["--geo-project", "geo_1", "--geo-step", "baseline"], /--run and --geo-project are gone/],
    [["--geo-step", "baseline"], /need --geo-create <brand>/],
    [["--geo-create", "Brand", "--geo-step", "baseline", "--prompt-file", path.join(f.root, "prompt.txt")], /no --prompt-file with them/],
  ]) {
    const result = await f.run({ extra });
    assert.equal(result.code, 2, extra.join(" "));
    assert.match(result.stderr, said);
  }
  assert.deepEqual(f.requests, [], "no account was made, nothing was asked of the deployment");
}));

test("PICO brief dispatch preserves supplied studies and source notes without evaluator answers", async () => fixture(async f => {
  const catalogue = JSON.parse(await fs.readFile(new URL("../../../evals/evidence-appraisal/briefs.json", import.meta.url), "utf8"));
  const source = catalogue.briefs.find(brief => brief.id === "appraisal-002-tirzepatide-companion-papers");
  const brief = { ...source, id: "fixture-case", mustDo: ["EVALUATOR_ONLY_REQUIRED"], mustNotDo: ["EVALUATOR_ONLY_FORBIDDEN"], gradedOn: "EVALUATOR_ONLY_GRADE" };
  await fs.writeFile(path.join(f.root, "evals/fixture/briefs.json"), JSON.stringify({ capability: "meta-analysis", briefs: [brief] }));
  const result = await f.run();
  assert.equal(result.code, 3);
  const prompt = f.requests.find(request => request.url === "/api/agent-runs/dispatch").body.text;
  for (const value of [...source.inputs.studies, ...source.inputs.sourceNotes]) assert.ok(prompt.includes(value), value);
  assert.ok(prompt.includes(source.inputs.question));
  assert.doesNotMatch(prompt, /EVALUATOR_ONLY/);
  assert.equal(f.requests.find(request => request.url === "/api/agent-runs/dispatch").body.automated, true, "the run is marked automated: it teaches the platform nothing");
}));


test("brief follow-ups run sequentially in the same session and each turn is captured before the next", async () => fixture(async f => {
  await fs.writeFile(path.join(f.root, "evals/fixture/briefs.json"), JSON.stringify({ capability: "meta-analysis", briefs: [{
    id: "fixture-case", inputs: { topic: "First analysis" }, followUps: ["Reuse it in centimetres.", "Explain the change."],
    gradedOn: "EVALUATOR_ONLY", mustDo: ["EVALUATOR_ONLY"],
  }] }));
  f.setRun({ ...originalRun, status: "succeeded", artifacts: ["results.json"] });
  const result = await f.run({ extra: ["--dispatch-id", "fixed-acceptance"] });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const dispatches = f.requests.filter(r => r.url === "/api/agent-runs/dispatch");
  assert.equal(dispatches.length, 3);
  assert.deepEqual(dispatches.slice(1).map(r => r.body.text), ["Reuse it in centimetres.", "Explain the change."]);
  assert.ok(dispatches.every(r => r.body.automated === true && !r.body.text.includes("EVALUATOR_ONLY")));
  assert.ok(dispatches.slice(1).every(r => r.body.sessionId === "real-session"));
  assert.equal(new Set(dispatches.map(r => r.body.dispatchId)).size, 3);
  const records = (await f.records()).sort((a, b) => a.record.turn - b.record.turn);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.record.turn), [1, 2, 3]);
  assert.equal(records[1].record.previousRunId, records[0].record.runId);
  assert.equal(records[2].record.previousRunId, records[1].record.runId);
  for (const { directory } of records) assert.equal(await fs.readFile(path.join(directory, "deliverable/results.json"), "utf8"), "Preserved useful partial results.");
  const flow = f.requests.filter(r => ["/api/agent-runs/dispatch", "/api/commands/read_artifact"].includes(r.url)).map(r => r.url);
  assert.deepEqual(flow, Array.from({ length: 3 }, () => ["/api/agent-runs/dispatch", "/api/commands/read_artifact"]).flat());
  assert.equal(f.requests.filter(r => r.url === "/api/auth/register").length, 1);
  assert.equal(f.requests.at(-1).url, "/api/account");
}));

test("a failed first turn prevents dependent follow-ups", async () => fixture(async f => {
  await fs.writeFile(path.join(f.root, "evals/fixture/briefs.json"), JSON.stringify({ capability: "meta-analysis", briefs: [{
    id: "fixture-case", inputs: { topic: "First analysis" }, followUps: ["Do not run after failure."],
  }] }));
  f.setRun({ ...originalRun, status: "failed" });
  assert.equal((await f.run()).code, 1);
  assert.equal(f.requests.filter(r => r.url === "/api/agent-runs/dispatch").length, 1);
  assert.equal(f.requests.at(-1).url, "/api/account");
}));
