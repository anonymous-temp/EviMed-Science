// Round 2, stream A4: the start of a disease-progression simulation reaches the conversation with two more fields, proved the way a real kernel
// conversation proves them. `people { recordId, mode }` runs the start on a record of virtual people (what a comparison's arm does), and a `result`
// input with `treatment.effectFrom` takes the drug effect from a pooling of the study (R31 tier C). The research MCP server's own `call_tool` sends the
// request, the gateway reads it, and the control plane holds what was sent to the pending call in the transcript.
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
import { vcrPeopleStartBinding } from "../src/vcrPeople.mjs";

const execFile = promisify(execFileCallback);
const mcpDir = fileURLToPath(new URL("../../../runtime/mcp/evimed-research/", import.meta.url));


/** What the model sent to `vcr_simulate` for a start. */
const PEOPLE = { recordId: "res_people1", mode: "paired_counterfactual" };
const SCENARIO = { endpoint: { type: "continuous", unit: "points" }, design: { nTreat: 60, nControl: 60 }, timeUnit: "weeks", visits: [0, 26, 52, 78],
  model: { family: "beta_logit", parameterSet: { id: "camd-adas-cog-11", version: "adsim-3.0" } },
  treatment: { symptomatic: { atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: "assumed" } }, effectFrom: { input: "result:res_pool1@2", estimand: "donepezil 10 mg, mild to moderate AD, ADAS-cog at 24 weeks" } } };
const CALLS = {
  people: { action: "start", kind: "generate_progression", scenario: { ...SCENARIO, treatment: { symptomatic: SCENARIO.treatment.symptomatic } }, people: PEOPLE },
  result: { action: "start", kind: "generate_progression", scenario: SCENARIO, inputs: [{ kind: "result", id: "result:res_pool1@2" }] },
};

/** A control plane with the real gateway and the real proof; what the queue is handed is what a test reads. */
async function controlPlane(t) {
  const pending = { input: null };
  /** @type {any[]} */
  const enqueued = [];
  const study = { id: "std_live", userId: "u1", projectId: "prj_1", scope: "conversation", purpose: "task", name: "AD", nameBasis: "model", conversationSessionId: "root" };
  const vcr = {
    service: { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 }, forModel: async (/** @type {any} */ payload) => payload },
    store: { studyByControlProject: async () => study, studyByRuntimeDispatch: async () => null, taskContext: async () => study, query: async () => ({ rows: [] }),
      assumptions: async () => [], populations: async () => [], rows: async () => [], one: async () => null },
    experiments: { bindPeopleStart: async (/** @type {any} */ _study, /** @type {any} */ scenario, /** @type {any} */ people) => {
      const bound = vcrPeopleStartBinding(scenario, people);
      if (!bound.ok) throw Object.assign(new Error("people refused"), { status: 400, code: "vcr_people_invalid", issues: bound.issues });
      return bound;
    } },
    jobs: { enqueue: async (/** @type {any} */ request) => { enqueued.push(request); return { job: { id: "job_start1", state: "queued", progress: {} }, created: true }; },
      get: async () => null },
  };
  const project = { id: "prj_1", userId: "u1" };
  const transcripts = { sessionTranscript: async (/** @type {any} */ _project, /** @type {string} */ sessionId) => ({ sessionId, truncated: false,
    turns: [{ startSeq: 1, end: null }],
    messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_start", status: "pending", tool: mcpToolName("vcr_simulate"), input: pending.input }] }] }) };
  const runtimeManager = { boundedRuntimeScope: () => null, assertActiveModelGatewayToken: (/** @type {string} */ token) => {
    if (token !== "runtime-token") throw new Error("bad token");
    return { userId: "u1", projectId: "prj_1" };
  } };
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:1/internal/models/v1" }, runtimeManager, {
    vcr,
    resolveInvocation: async (/** @type {any} */ identity, /** @type {string} */ header, /** @type {string} */ operation, /** @type {any} */ body) =>
      verifyVcrInvocation({ header, operation, body, project, runtimeManager: transcripts, resolveSession: () => ({ runId: "run_live" }),
        runs: async () => [{ id: "run_live", sessionId: "root", status: "running" }], authenticatedUserId: String(identity.userId) }),
  });
  const server = http.createServer((req, res) => { handler(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-start-proof-"));
  const tokenFile = path.join(directory, "gateway-token");
  await writeFile(tokenFile, "runtime-token\n");
  await chmod(tokenFile, 0o600);
  t.after(async () => { await new Promise((done) => server.close(() => done(undefined))); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const callTool = async (/** @type {Record<string, any>} */ args) => {
    pending.input = args;
    const context = { v: 1, sessionId: "root", callId: "call_start", rootCallId: "call_start", provider: "deepseek-official", model: "deepseek-v4-flash" };
    const script = [
      "import importlib.util, json, sys",
      "sys.path[:0] = ['.']",
      "spec = importlib.util.spec_from_file_location('evimed_research_mcp_start', 'server.py')",
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
  return { callTool, enqueued };
}

test("a start that names a record of virtual people is proved by its pending call and queued as one arm of a comparison on that record", async (t) => {
  const { callTool, enqueued } = await controlPlane(t);
  const answer = await callTool(CALLS.people);
  assert.equal(answer.status, "success", JSON.stringify(answer).slice(0, 500));
  const request = enqueued.at(-1);
  assert.equal(request.kind, "generate_progression");
  assert.deepEqual(request.derived, [{ resultId: "res_people1", table: "progression-people", shape: "subject" }], "the table rides beside the scenario, never in it");
  assert.deepEqual(request.scenario.people, { inputId: "res_people1:progression-people", mode: "paired_counterfactual" });
  assert.equal(request.scenario.design, undefined, "a paired run is on everyone in the record: the arm's own group sizes are not carried");
  assert.equal(request.internal, true);
  const seed = request.seed;
  assert.ok(Number.isInteger(seed) && seed > 0, "the seed follows the record, so two drugs on one record draw the same people");
  await callTool({ ...CALLS.people, scenario: { ...CALLS.people.scenario, treatment: { symptomatic: { ...SCENARIO.treatment.symptomatic, pointsAt: { value: -2, basis: "assumed" } } } } });
  assert.equal(enqueued.at(-1).seed, seed);
  // a resampled-trials start keeps the group sizes and the same record
  await callTool({ ...CALLS.people, people: { recordId: "res_people1", mode: "resampled_trials" } });
  assert.equal(enqueued.at(-1).scenario.design.nTreat, 60);
});

test("a start that states people of its own beside a record, or names a record for another kind, is refused by name", async (t) => {
  const { callTool, enqueued } = await controlPlane(t);
  const before = enqueued.length;
  const conflict = await callTool({ ...CALLS.people, scenario: { ...CALLS.people.scenario, instantiate: { n: 40 } } });
  assert.notEqual(conflict.status, "success");
  assert.match(JSON.stringify(conflict), /start_people_conflict|instantiate/);
  const wrongMode = await callTool({ ...CALLS.people, people: { recordId: "res_people1", mode: "everyone" } });
  assert.notEqual(wrongMode.status, "success");
  const otherKind = await callTool({ action: "start", kind: "design_analytic", scenario: {}, people: PEOPLE });
  assert.notEqual(otherKind.status, "success");
  assert.equal(enqueued.length, before, "nothing was queued");
});

test("a result input and the effect that names it ride to the queue whole, and the proof covers them", async (t) => {
  const { callTool, enqueued } = await controlPlane(t);
  const answer = await callTool(CALLS.result);
  assert.equal(answer.status, "success", JSON.stringify(answer).slice(0, 500));
  const request = enqueued.at(-1);
  assert.deepEqual(request.inputs, [{ kind: "result", id: "result:res_pool1@2" }]);
  assert.equal(request.scenario.treatment.effectFrom.input, "result:res_pool1@2", "the control plane binds it when it queues; the gateway carries it as written");
});

test("the proof holds the new start fields to the pending call: a changed record, mode, result or effect is a forged request", async () => {
  const project = { id: "prj_1", userId: "u1" };
  const proof = (/** @type {Record<string, any>} */ input, /** @type {Record<string, any>} */ body) => verifyVcrInvocation({
    header: JSON.stringify({ v: 1, sessionId: "root", callId: "call_start" }), operation: "simulate", body, project,
    runtimeManager: { sessionTranscript: async (/** @type {any} */ _p, /** @type {string} */ sessionId) => ({ sessionId, truncated: false, turns: [{ startSeq: 1, end: null }],
      messages: [{ turnStartSeq: 1, role: "assistant", parts: [{ type: "tool", callId: "call_start", status: "pending", tool: mcpToolName("vcr_simulate"), input }] }] }) },
    resolveSession: () => ({ runId: "run_live" }), runs: [{ id: "run_live", sessionId: "root" }] });
  for (const [name, call] of Object.entries(CALLS)) assert.equal((await proof(call, call)).runId, "run_live", name);
  const forged = [
    [CALLS.people, { ...CALLS.people, people: { ...PEOPLE, recordId: "res_other" } }],
    [CALLS.people, { ...CALLS.people, people: { ...PEOPLE, mode: "resampled_trials" } }],
    [CALLS.people, { ...CALLS.people, people: undefined }],
    [CALLS.result, { ...CALLS.result, inputs: [{ kind: "result", id: "result:res_other@2" }] }],
    [CALLS.result, { ...CALLS.result, scenario: { ...SCENARIO, treatment: { ...SCENARIO.treatment, effectFrom: { input: "result:res_pool1@2", target: "disease_modifying_fraction" } } } }],
  ];
  for (const [input, body] of forged) await assert.rejects(proof(input, body), { code: "vcr_invocation_unavailable" }, JSON.stringify(body).slice(0, 140));
});
