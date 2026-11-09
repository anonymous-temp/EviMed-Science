// The virtual lab's actions on `vcr_simulate`, proved the way a real kernel conversation proves them: the research MCP server's own
// `call_tool` sends the request, the gateway reads it, and the control plane holds what was sent to the pending call in the transcript.
//
// Found on a real kernel (2026-11-07, live phase 3, conversation c): a well-formed `compare` of three Alzheimer arms answered
// vcr_invocation_unavailable "A current native research call is required." three times, so the run subtracted the arms' means itself.
// The proof kept only `action` and `jobId` of any action that was not a start or a validate, so `experiment` (and a search's
// `manifest`, a campaign's or an experiment's id) never matched what the MCP server sent. Every lab action is driven here end to end.
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

/** The three arms of the live conversation: one disease model, differing only in treatment. */
const ARM_SCENARIO = { population: { baseline: { adas: { mean: 22.5, sd: 8.5 } } }, design: { nPerArm: 200, weeks: [0, 13, 26, 39, 52, 65, 78] },
  model: { family: "beta_logit", parameters: "camd_adsim_3" } };
const EXPERIMENT = {
  question: "三组 ADAS-cog 在 78 周的变化有什么不同",
  arms: [
    { name: "安慰剂", method: "patients.progression", scenario: ARM_SCENARIO },
    { name: "对症药物", method: "patients.progression", scenario: { ...ARM_SCENARIO, treatment: { kind: "symptomatic", effect: -2, onsetWeeks: 12 } } },
    { name: "疾病修饰", method: "patients.progression", scenario: { ...ARM_SCENARIO, treatment: { kind: "disease_modifying", slowing: 0.3 } } },
  ],
  comparison: { measures: ["change_from_baseline"], reference: "安慰剂" },
};
const MANIFEST = { question: "smallest trial", objective: { measure: "expected_sample_size", direction: "minimize", truth: "alt" },
  constraints: [{ measure: "type_one_error", op: "<=", bound: 0.025, kind: "error_control", truth: "null" }],
  space: { method: "design.simulate", scenario: { truth: { hazardRatio: 0.75 } }, variables: [{ path: "design.nTreat", values: [150, 200, 250] }] },
  stages: { final: { count: 2 } }, budget: { maxCandidates: 3, cpuSeconds: 600 } };

/** What the model sent to `vcr_simulate`, one per lab action. */
const LAB_CALLS = {
  search: { action: "search", manifest: MANIFEST },
  search_status: { action: "search_status", campaignId: "cmp_live1" },
  search_cancel: { action: "search_cancel", campaignId: "cmp_live1" },
  compare: { action: "compare", experiment: EXPERIMENT },
  compare_status: { action: "compare_status", experimentId: "exp_live1" },
};

/** A control plane with the real gateway and the real proof; the kernel's transcript holds one pending call, which a test sets. */
async function controlPlane(t) {
  const pending = { input: null };
  /** @type {any[]} */
  const reached = [];
  const study = { id: "std_live", userId: "u1", projectId: "prj_1", scope: "conversation", purpose: "task", name: "AD", nameBasis: "model",
    conversationSessionId: "root" };
  const answer = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, status: "running", stop: null });
  const vcr = {
    service: { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 }, forModel: async (/** @type {any} */ payload) => payload },
    store: { studyByControlProject: async () => study, studyByRuntimeDispatch: async () => null, taskContext: async () => study, query: async () => ({ rows: [] }) },
    jobs: {},
    experiments: {
      startCampaign: async (/** @type {any} */ _study, /** @type {any} */ manifest) => { reached.push(["search", manifest]); return answer("campaign", "cmp_live1"); },
      startExperiment: async (/** @type {any} */ _study, /** @type {any} */ experiment) => { reached.push(["compare", experiment]); return answer("experiment", "exp_live1"); },
      cancel: async (/** @type {any} */ _study, /** @type {string} */ id) => { reached.push(["search_cancel", id]); return answer("campaign", id); },
      view: async (/** @type {any} */ _study, /** @type {string} */ id) => { reached.push(["view", id]); return answer(id.startsWith("cmp_") ? "campaign" : "experiment", id); },
    },
  };
  const project = { id: "prj_1", userId: "u1" };
  const transcripts = { sessionTranscript: async (/** @type {any} */ _project, /** @type {string} */ sessionId) => ({ sessionId, truncated: false,
    turns: [{ startSeq: 1, end: null }],
    messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_lab", status: "pending", tool: mcpToolName("vcr_simulate"), input: pending.input }] }] }) };
  const runtimeManager = { boundedRuntimeScope: () => null, assertActiveModelGatewayToken: (/** @type {string} */ token) => {
    if (token !== "runtime-token") throw new Error("bad token");
    return { userId: "u1", projectId: "prj_1" };
  } };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/internal/models/v1" }, runtimeManager, {
    vcr,
    // As server.mjs wires it.
    resolveInvocation: async (/** @type {any} */ identity, /** @type {string} */ header, /** @type {string} */ operation, /** @type {any} */ body) =>
      verifyVcrInvocation({ header, operation, body, project, runtimeManager: transcripts, resolveSession: () => ({ runId: "run_live" }),
        runs: async () => [{ id: "run_live", sessionId: "root", status: "running" }], authenticatedUserId: String(identity.userId) }),
  });
  const server = http.createServer((req, res) => { handler(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-lab-proof-"));
  const tokenFile = path.join(directory, "gateway-token");
  await writeFile(tokenFile, "runtime-token\n");
  await chmod(tokenFile, 0o600);
  t.after(async () => { await new Promise((done) => server.close(() => done(undefined))); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  /** The research MCP server's `call_tool`, run as the runtime runs it, with the context the kernel-side wrapper attaches. */
  const callTool = async (/** @type {Record<string, any>} */ args) => {
    pending.input = args;
    const context = { v: 1, sessionId: "root", callId: "call_lab", rootCallId: "call_lab", provider: "deepseek-official", model: "deepseek-v4-flash" };
    const script = [
      "import importlib.util, json, sys",
      "sys.path[:0] = ['.']",
      "spec = importlib.util.spec_from_file_location('evimed_research_mcp_lab', 'server.py')",
      "server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)",
      "print(json.dumps(server.call_tool('vcr_simulate', {**json.loads(sys.argv[1]), '__evimed_execution_context': json.loads(sys.argv[2])}), ensure_ascii=False))",
    ].join("\n");
    const { stdout } = await execFile("python3", ["-c", script, JSON.stringify(args), JSON.stringify(context)], {
      cwd: mcpDir, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, EVIMED_VCR_GATEWAY_URL: `${base}/internal/vcr/v1`, EVIMED_PUBLIC_SOURCE_GATEWAY_URL: `${base}/internal/sources/v1/fetch`,
        EVIMED_MODEL_GATEWAY_TOKEN_FILE: tokenFile, EVIMED_DISABLED_TOOLS: "" },
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
  };
  return { callTool, reached };
}

test("every lab action sent through vcr_simulate by the research MCP server is proved by its pending call and reaches the lab", async (t) => {
  const { callTool, reached } = await controlPlane(t);
  for (const [action, args] of Object.entries(LAB_CALLS)) {
    const before = reached.length;
    const answer = await callTool(args);
    assert.equal(answer.status, "success", `${action}: ${JSON.stringify(answer).slice(0, 400)}`);
    assert.equal(reached.length, before + 1, `${action} reached the lab`);
  }
  // What reached the lab is what the model sent, whole.
  assert.deepEqual(reached.find(([what]) => what === "compare")?.[1], EXPERIMENT);
  assert.deepEqual(reached.find(([what]) => what === "search")?.[1], MANIFEST);
  assert.deepEqual(reached.filter(([what]) => what !== "compare" && what !== "search").map(([, id]) => id), ["cmp_live1", "cmp_live1", "exp_live1"]);
});

test("a lab request that is not the pending call is refused", async () => {
  // The proof holds the projection to the call, so the projection must not loosen it: a changed arm, another id, or a key the
  // gateway does not read for that action is a forged request.
  const project = { id: "prj_1", userId: "u1" };
  const proof = (/** @type {Record<string, any>} */ input, /** @type {Record<string, any>} */ body) => verifyVcrInvocation({
    header: JSON.stringify({ v: 1, sessionId: "root", callId: "call_lab" }), operation: "simulate", body, project,
    runtimeManager: { sessionTranscript: async (/** @type {any} */ _p, /** @type {string} */ sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_lab", status: "pending", tool: mcpToolName("vcr_simulate"), input }] }] }) },
    resolveSession: () => ({ runId: "run_live" }), runs: [{ id: "run_live", sessionId: "root" }] });
  for (const [action, args] of Object.entries(LAB_CALLS)) assert.equal((await proof(args, args)).runId, "run_live", action);
  const forged = [
    [LAB_CALLS.compare, { ...LAB_CALLS.compare, experiment: { ...EXPERIMENT, arms: EXPERIMENT.arms.slice(0, 2) } }],
    [LAB_CALLS.search, { ...LAB_CALLS.search, manifest: { ...MANIFEST, budget: { maxCandidates: 30, cpuSeconds: 6000 } } }],
    [LAB_CALLS.search_status, { action: "search_status", campaignId: "cmp_other" }],
    [LAB_CALLS.search_status, { action: "search_cancel", campaignId: "cmp_live1" }],
    [LAB_CALLS.compare_status, { action: "compare_status", experimentId: "exp_other" }],
    [LAB_CALLS.compare, { action: "compare" }],
  ];
  for (const [input, body] of forged) await assert.rejects(proof(input, body), { code: "vcr_invocation_unavailable" }, JSON.stringify(body).slice(0, 120));
  // A key the MCP server never forwards for that action is not projected either: the call may carry it, the request does not.
  assert.equal((await proof({ ...LAB_CALLS.compare_status, jobId: "job_x" }, LAB_CALLS.compare_status)).runId, "run_live");
});
