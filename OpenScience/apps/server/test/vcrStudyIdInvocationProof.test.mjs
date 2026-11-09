// Plan R11: the explicit `studyId` of vcr_read / vcr_write / vcr_simulate, proved the way a real kernel conversation proves it: the research
// MCP server's own `call_tool` sends it, the gateway reads it, and the transcript's pending call must hold exactly what was sent.
// (The lab actions were refused here once for a field the proof dropped, 2026-11-07; the same trap is closed for this one.)
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mcpToolName } from "@evimed/domain";
import { createVcrGatewayHandler } from "../src/vcrGateway.mjs";
import { verifyVcrInvocation } from "../src/vcrExecutionContext.mjs";

const execFile = promisify(execFileCallback);
const mcpDir = fileURLToPath(new URL("../../../runtime/mcp/evimed-research/", import.meta.url));
const OLD = { id: "std_old", userId: "u1", projectId: "prj_1", scope: "conversation", purpose: "task", name: "Earlier", conversationSessionId: "sess_old" };

async function controlPlane(/** @type {any} */ t, /** @type {{ granted: boolean }} */ state) {
  const pending = { input: null, tool: "vcr_read" };
  /** @type {any[]} */
  const reached = [];
  const vcr = {
    service: { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 }, forModel: async (/** @type {any} */ payload) => payload,
      requireStudy: async () => OLD, runtimeRead: async (/** @type {any} */ study, /** @type {string} */ what) => { reached.push(["read", study.id, what]); return { what, studyId: study.id }; } },
    store: { studyByControlProject: async () => null, studyByRuntimeDispatch: async () => null, taskContext: async () => ({ id: "std_own", userId: "u1", projectId: "prj_1", scope: "conversation", conversationSessionId: "root" }),
      studyConversationGrant: async (/** @type {string} */ studyId, /** @type {string} */ sessionId) => state.granted && studyId === "std_old" && sessionId === "root" ? { grantedBy: "u1" } : null,
      query: async () => ({ rows: [] }) },
    jobs: { enqueue: async (/** @type {any} */ input) => { reached.push(["enqueue", input.studyId]); return { job: { id: "job_1", state: "queued", progress: {} }, created: true }; },
      get: async () => ({ id: "job_1", state: "running", progress: {}, cpuSecondsUsed: 0, error: null }) },
  };
  const project = { id: "prj_1", userId: "u1" };
  const transcripts = { sessionTranscript: async (/** @type {any} */ _project, /** @type {string} */ sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
    messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_s", status: "pending", tool: mcpToolName(pending.tool), input: pending.input }] }] }) };
  const runtimeManager = { boundedRuntimeScope: () => null, assertActiveModelGatewayToken: (/** @type {string} */ token) => { if (token !== "runtime-token") throw new Error("bad token"); return { userId: "u1", projectId: "prj_1" }; } };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/internal/models/v1" }, runtimeManager, { vcr,
    resolveInvocation: async (/** @type {any} */ identity, /** @type {string} */ header, /** @type {string} */ operation, /** @type {any} */ body) =>
      verifyVcrInvocation({ header, operation, body, project, runtimeManager: transcripts, resolveSession: () => ({ runId: "run_s" }),
        runs: async () => [{ id: "run_s", sessionId: "root", status: "running" }], authenticatedUserId: String(identity.userId) }) });
  const server = http.createServer((req, res) => { handler(req, res, () => {}).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-studyid-proof-"));
  const tokenFile = path.join(directory, "gateway-token");
  await writeFile(tokenFile, "runtime-token\n");
  await chmod(tokenFile, 0o600);
  t.after(async () => { await new Promise((done) => server.close(() => done(undefined))); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const callTool = async (/** @type {string} */ tool, /** @type {Record<string, any>} */ args) => {
    pending.input = args; pending.tool = tool;
    const context = { v: 1, sessionId: "root", callId: "call_s", rootCallId: "call_s", provider: "deepseek-official", model: "deepseek-v4-flash" };
    const script = ["import importlib.util, json, sys", "sys.path[:0] = ['.']",
      "spec = importlib.util.spec_from_file_location('evimed_research_mcp_sid', 'server.py')",
      "server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)",
      "print(json.dumps(server.call_tool(sys.argv[3], {**json.loads(sys.argv[1]), '__evimed_execution_context': json.loads(sys.argv[2])}), ensure_ascii=False))"].join("\n");
    const { stdout } = await execFile("python3", ["-c", script, JSON.stringify(args), JSON.stringify(context), tool], { cwd: mcpDir, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, EVIMED_VCR_GATEWAY_URL: `${base}/internal/vcr/v1`, EVIMED_PUBLIC_SOURCE_GATEWAY_URL: `${base}/internal/sources/v1/fetch`,
        EVIMED_MODEL_GATEWAY_TOKEN_FILE: tokenFile, EVIMED_DISABLED_TOOLS: "" } });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
  };
  return { callTool, reached };
}

test("a studyId sent by vcr_read, vcr_write and vcr_simulate reaches the handed-over study, proved by the pending call", async (t) => {
  const { callTool, reached } = await controlPlane(t, { granted: true });
  const read = await callTool("vcr_read", { what: "study", studyId: "std_old" });
  assert.equal(read.status, "success", JSON.stringify(read).slice(0, 400));
  assert.deepEqual(reached.at(-1), ["read", "std_old", "study"]);
  const wrote = await callTool("vcr_write", { what: "task_context", studyId: "std_old" });
  assert.equal(wrote.status, "success", JSON.stringify(wrote).slice(0, 400));
  assert.equal(wrote.data.studyId, "std_old", "the write acted on the handed-over study, not the conversation's own");
  const status = await callTool("vcr_simulate", { action: "status", jobId: "job_1", studyId: "std_old" });
  assert.equal(status.status, "success", JSON.stringify(status).slice(0, 400));
  assert.equal(reached.some(([what, id]) => what === "enqueue" && id !== "std_old"), false);
});

test("without a grant the same call is refused by name, and a study id the pending call never held is a forged request", async (t) => {
  const state = { granted: false };
  const { callTool, reached } = await controlPlane(t, state);
  const refused = await callTool("vcr_read", { what: "study", studyId: "std_old" });
  assert.equal(refused.status, "error", JSON.stringify(refused).slice(0, 300));
  assert.match(JSON.stringify(refused), /vcr_study_not_granted/);
  assert.equal(reached.length, 0);
  const project = { id: "prj_1", userId: "u1" };
  const proof = (/** @type {Record<string, any>} */ input, /** @type {Record<string, any>} */ body) => verifyVcrInvocation({
    header: JSON.stringify({ v: 1, sessionId: "root", callId: "call_s" }), operation: "read", body, project,
    runtimeManager: { sessionTranscript: async (/** @type {any} */ _p, /** @type {string} */ sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_s", status: "pending", tool: mcpToolName("vcr_read"), input }] }] }) },
    resolveSession: () => ({ runId: "run_s" }), runs: [{ id: "run_s", sessionId: "root" }] });
  assert.equal((await proof({ what: "study", studyId: "std_old" }, { what: "study", studyId: "std_old" })).runId, "run_s");
  await assert.rejects(proof({ what: "study" }, { what: "study", studyId: "std_old" }), { code: "vcr_invocation_unavailable" });
  await assert.rejects(proof({ what: "study", studyId: "std_old" }, { what: "study", studyId: "std_other" }), { code: "vcr_invocation_unavailable" });
  await assert.rejects(proof({ what: "study", studyId: "std_old" }, { what: "study" }), { code: "vcr_invocation_unavailable" });
});

test("the research plugin tools carry the same studyId: the call, its projection and the pending call must agree", async () => {
  const project = { id: "prj_1", userId: "u1" };
  const proof = (/** @type {string} */ tool, /** @type {Record<string, any>} */ input, /** @type {Record<string, any>} */ body) => verifyVcrInvocation({
    header: JSON.stringify({ v: 1, sessionId: "root", callId: "call_p" }), operation: "simulate", body, project, assertResearchPluginSelection: async () => {},
    runtimeManager: { sessionTranscript: async (/** @type {any} */ _p, /** @type {string} */ sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_p", status: "pending", tool, input }] }] }) },
    resolveSession: () => ({ runId: "run_p" }), runs: [{ id: "run_p", sessionId: "root" }] });
  const read = { jobId: "job_1", studyId: "std_old" };
  assert.equal((await proof("virtual_trial_read", read, { action: "status", jobId: "job_1", studyId: "std_old" })).runId, "run_p");
  const search = { campaignId: "cmp_1", studyId: "std_old" };
  assert.equal((await proof("virtual_trial_search", search, { action: "search_status", campaignId: "cmp_1", studyId: "std_old" })).runId, "run_p");
  // a request that drops the study, names another or adds one the call never held is forged
  await assert.rejects(proof("virtual_trial_read", read, { action: "status", jobId: "job_1" }), { code: "vcr_invocation_unavailable" });
  await assert.rejects(proof("virtual_trial_read", read, { action: "status", jobId: "job_1", studyId: "std_other" }), { code: "vcr_invocation_unavailable" });
  await assert.rejects(proof("virtual_trial_read", { jobId: "job_1" }, { action: "status", jobId: "job_1", studyId: "std_old" }), { code: "vcr_invocation_unavailable" });
  await assert.rejects(proof("virtual_trial_read", { jobId: "job_1", studyId: "bad id" }, { action: "status", jobId: "job_1", studyId: "bad id" }), { code: "vcr_invocation_unavailable" });
});
