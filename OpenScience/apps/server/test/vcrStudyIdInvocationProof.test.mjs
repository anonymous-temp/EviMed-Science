// Plan R11 (reworked after the engineering review): a study handed to a conversation BINDS it, so vcr_read / vcr_write / vcr_simulate take no
// study argument. Proved the way a real kernel conversation proves it: the research MCP server's own `call_tool` sends the call, the gateway
// resolves the conversation's grant, and the transcript's pending call must hold exactly what was sent (and no `studyId` is a field).
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

async function controlPlane(/** @type {any} */ t, /** @type {{ granted: boolean, revoked?: boolean }} */ state) {
  const pending = { input: null, tool: "vcr_read" };
  /** @type {any[]} */
  const reached = [];
  const vcr = {
    service: { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 }, forModel: async (/** @type {any} */ payload) => payload,
      requireStudy: async () => OLD, runtimeRead: async (/** @type {any} */ study, /** @type {string} */ what) => { reached.push(["read", study.id, what]); return { what, studyId: study.id }; } },
    store: { studyByControlProject: async () => null, studyByRuntimeDispatch: async () => null, taskContext: async () => ({ id: "std_own", userId: "u1", projectId: "prj_1", scope: "conversation", conversationSessionId: "root" }),
      revokedStudyGrant: async (/** @type {string} */ sessionId) => state.revoked && sessionId === "root" ? { studyId: "std_old", sessionId, grantedBy: "u1", revokedAt: "2026-11-10T00:00:00Z" } : null,
      boundStudyGrant: async (/** @type {string} */ sessionId, /** @type {string} */ person) => state.granted && sessionId === "root" && person === "u1" ? { studyId: "std_old", sessionId, grantedBy: "u1" } : null,
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

test("a conversation holding a grant works in the handed-over study with no study argument, proved by the pending call", async (t) => {
  const { callTool, reached } = await controlPlane(t, { granted: true });
  const read = await callTool("vcr_read", { what: "study" });
  assert.equal(read.status, "success", JSON.stringify(read).slice(0, 400));
  assert.deepEqual(reached.at(-1), ["read", "std_old", "study"]);
  const wrote = await callTool("vcr_write", { what: "task_context" });
  assert.equal(wrote.status, "success", JSON.stringify(wrote).slice(0, 400));
  assert.equal(wrote.data.studyId, "std_old", "the write acted on the handed-over study, not the conversation's own");
  const status = await callTool("vcr_simulate", { action: "status", jobId: "job_1" });
  assert.equal(status.status, "success", JSON.stringify(status).slice(0, 400));
  assert.equal(reached.some(([what, id]) => what === "enqueue" && id !== "std_old"), false);
});

test("without a grant the same call works in the conversation's own study, and a study argument is refused by the tool before it travels", async (t) => {
  const { callTool, reached } = await controlPlane(t, { granted: false });
  const own = await callTool("vcr_read", { what: "study" });
  assert.equal(own.status, "success", JSON.stringify(own).slice(0, 300));
  assert.equal(reached.at(-1)?.[1], "std_own");
  const named = await callTool("vcr_read", { what: "study", studyId: "std_old" });
  assert.equal(named.status, "error", JSON.stringify(named).slice(0, 300));
  assert.match(JSON.stringify(named), /studyId/);
  assert.equal(reached.filter(([, id]) => id === "std_old").length, 0);
});

test("a conversation whose handoff was taken back is told so in a named code, and the work is not mistaken for the old study", async (t) => {
  // live R39 L1 (2026-11-09): after the owner revoked, the next call opened a second study with the same name and said nothing about it
  const { callTool } = await controlPlane(t, { granted: false, revoked: true });
  const read = await callTool("vcr_read", { what: "study" });
  assert.equal(read.status, "success", JSON.stringify(read).slice(0, 400));
  assert.equal(read.data.handoffRevoked.code, "vcr_study_handoff_revoked");
  assert.match(read.data.handoffRevoked.message, /收回/);
  const never = await controlPlane(t, { granted: false });
  assert.equal((await never.callTool("vcr_read", { what: "study" })).data.handoffRevoked, undefined, "no word of it where nothing was handed over");
});
