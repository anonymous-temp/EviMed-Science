// What the engine tools are told and what they are promised, held equal across
// the two languages that state it.
//
// Seven MCP tools run an engine rather than a lookup: the six specialists and
// the deterministic calculator. The kernel-side wrapper in harness-port attaches
// the session's provider, model and reasoning effort to each of their calls; the
// Python MCP server validates that context before it dispatches, and the control
// plane validates it again when it resolves the session. The Python side kept
// its own list of model ids and it named only the Flash ones, so on a pilot
// certified for deepseek-v4-pro every engine tool was refused before it ran
// (2026-10-03) -- and the refusal itself crashed, which is the Python suite's to
// hold (test_engine_context.py, test_call_arity.py).
//
// The second half is the calculator's own promise. Its description told the
// model that meta.dl reads `studies {id,label,yi,vi}`; the executor requires
// effectMeasure and outcome as well and reports a wrong shape only as a failed
// job. The description is rendered from one table now, and each validator that
// runs is asked about every input that table describes: the Python executor in
// test_research_calculate.py, the control plane's VCR replay here.
//
// Asking is the point, as in evimedMcp.test.mjs: every comparison below reads
// what a module answers, not how its source happens to spell a list.
//
// Two more copies of the context check sit with the engines, in the specialist
// adapter and in the Meta engine. They are asked too, and what they still
// refuse is written down below rather than left to be found on a deployment.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MCP_TOOL_BASE_NAMES, RESULT_REPLAY_METHODS, VCR_DESIGN_SUPPORT, VCR_SCENARIO_SCHEMAS, mcpToolName } from "@evimed/domain";
import { ENGINE_EXECUTION_CONTEXT, decorateEngineToolContext } from "@evimed/harness-port";
import { supportedDeepSeekModels } from "../src/modelGateway.mjs";
import { MODEL_REASONING_EFFORTS, executionContext } from "../src/modelReasoningPolicy.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";
import { ResultVcrReplay } from "../src/resultVcrReplay.mjs";
import { ACCEPTANCE_AGGREGATE } from "../../../scripts/ops/result-revision-acceptance.mjs";

const execFile = promisify(execFileCallback);
const mcpDir = fileURLToPath(new URL("../../../runtime/mcp/evimed-research/", import.meta.url));

/** One expression answered by the MCP server's own modules; `values` arrive as JSON. */
async function python(expression, ...values) {
  const script = [
    "import importlib.util, json, sys",
    "sys.path[:0] = ['.', 'test']",
    "import calculation_inputs as inputs, execution_context as context, research_calculate as calculate, server",
    "values = [json.loads(value) for value in sys.argv[1:]]",
    "def load(path):",
    "    spec = importlib.util.spec_from_file_location('module_asked', path)",
    "    module = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(module)",
    "    return module",
    "def accepts(check, value):",
    "    try:",
    "        check(value)",
    "    except Exception:",
    "        return False",
    "    return True",
    `print(json.dumps(${expression}))`,
  ].join("\n");
  const { stdout } = await execFile("python3", ["-c", script, ...values.map((value) => JSON.stringify(value))], {
    cwd: mcpDir,
    maxBuffer: 16 * 1024 * 1024,
    // No gateway: a call that gets past the context is answered locally.
    env: { ...process.env, EVIMED_RESULT_GATEWAY_URL: "", EVIMED_DISABLED_TOOLS: "" },
  });
  return JSON.parse(stdout);
}

/** Names in `left` that `right` lacks, so a difference is reported by name. */
const missingFrom = (left, right) => [...left].filter((name) => ![...right].includes(name)).sort();

/** The context the kernel-side wrapper attaches for one session, by running the wrapper. */
async function attachedContext(config) {
  let received;
  const definition = {
    name: mcpToolName("research_calculate"),
    execute: async (args) => { received = args[ENGINE_EXECUTION_CONTEXT]; return {}; },
  };
  const release = decorateEngineToolContext({
    tools: { get: (name) => (name === definition.name ? definition : undefined) },
    on: () => () => {},
  });
  await definition.execute({ action: "status", jobId: "job" }, {
    callId: "call_00_native", rootCallId: "call_00_root",
    agent: { session: { id: "session-native", requestHeader: () => ({ config }) } },
  });
  release();
  return received;
}

test("the session models, efforts and engine tools the MCP server admits are the control plane's, by name", async () => {
  const admitted = await python("{'models': sorted(context.SUPPORTED_MODELS), 'efforts': sorted(context.REASONING_EFFORTS), 'tools': sorted(server.ENGINE_CONTEXT_TOOLS)}");
  assert.ok(supportedDeepSeekModels.size >= 3 && admitted.models.length >= 3, "both model lists were read");
  assert.deepEqual(missingFrom(supportedDeepSeekModels, admitted.models), [],
    "the gateway certifies a model the MCP server refuses as a session's: every engine tool fails on a deployment that runs it");
  assert.deepEqual(missingFrom(admitted.models, supportedDeepSeekModels), [],
    "the MCP server admits a session model the gateway does not certify");
  assert.deepEqual(missingFrom(MODEL_REASONING_EFFORTS, admitted.efforts), [], "the control plane offers an effort the MCP server refuses");
  assert.deepEqual(missingFrom(admitted.efforts, MODEL_REASONING_EFFORTS), [], "the MCP server admits an effort the control plane does not offer");

  // The wrapper's roster is asked for the same way a kernel meets it: which
  // published tools come back with a wrapped body.
  const original = async () => ({});
  const wrapped = MCP_TOOL_BASE_NAMES.filter((base) => {
    const definition = { name: mcpToolName(base), execute: original };
    const release = decorateEngineToolContext({
      tools: { get: (name) => (name === definition.name ? definition : undefined) },
      on: () => () => {},
    });
    const decorated = definition.execute !== original;
    release();
    return decorated;
  });
  assert.equal(wrapped.length, 7, "the wrapper decorates the six specialists and the calculator");
  assert.deepEqual(missingFrom(wrapped, admitted.tools), [], "the wrapper attaches a context to a tool whose body refuses one");
  assert.deepEqual(missingFrom(admitted.tools, wrapped), [], "the MCP server expects a context on a tool the wrapper never gives one");
});

test("the context the wrapper attaches is accepted on both sides for every certified model and effort", async () => {
  const contexts = [];
  for (const model of supportedDeepSeekModels) {
    for (const reasoningEffort of [undefined, ...MODEL_REASONING_EFFORTS]) {
      contexts.push(await attachedContext({ provider: "deepseek-official", model, reasoningEffort }));
    }
  }
  assert.equal(contexts.length, supportedDeepSeekModels.size * (MODEL_REASONING_EFFORTS.length + 1));
  for (const context of contexts) assert.deepEqual(executionContext(context, context.model), context);

  const uncertified = { ...contexts[0], model: "deepseek-chat" };
  assert.throws(() => executionContext(uncertified, "deepseek-flash"), { code: "engine_model_context_invalid" });
  const answers = await python(
    "[server.call_tool('research_calculate', {'action': 'status', 'jobId': 'job', '__evimed_execution_context': value}) for value in values[0]]",
    [...contexts, uncertified],
  );
  const refusal = answers.pop();
  for (const [index, answer] of answers.entries()) {
    // Past the context, and stopped where this test leaves it: no gateway.
    assert.equal(answer.error?.code, "result_engine_unavailable", JSON.stringify(contexts[index]));
  }
  assert.equal(refusal.status, "error");
  assert.deepEqual(
    { code: refusal.error.code, message: refusal.error.message, retryable: refusal.error.retryable },
    { code: "engine_execution_context_invalid", message: "The engine execution context is invalid (model).", retryable: false },
  );
  assert.ok(refusal.error.stopReason.length > 0 && refusal.next_actions.length > 0, "the refusal says what to do next");
});

// The specialist adapter and the Meta engine each validate the forwarded context
// with a copy of the same check (a Meta test holds the two files byte-identical),
// and those copies still name only the Flash ids. On a deployment certified for
// deepseek-v4-pro the MCP server now lets the six specialist tools through and
// the adapter answers HTTP 422; the calculator is not behind an adapter and
// runs. The gap is pinned, not hidden: widening the copies fails this test until
// ENGINE_SIDE_GAP is emptied, and from then on it holds them to the gateway.
const ENGINE_SIDE_COPIES = [
  "../../../deploy/specialist-adapter/evimed_specialist_adapter/engine_model.py",
  "../../../../项目代码/meta/new_meta/core/engine_model.py",
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
const ENGINE_SIDE_GAP = ["deepseek-v4-pro"];

test("the engines' own copies of the context check admit the certified models, less a gap that is written down", async () => {
  const context = await attachedContext({ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" });
  const candidates = [...supportedDeepSeekModels, "deepseek-chat"];
  const admitted = await python(
    "{path: [model for model in values[1] if accepts(load(path).validate_context, {**values[0], 'model': model})] for path in values[2]}",
    context, candidates, ENGINE_SIDE_COPIES,
  );
  assert.deepEqual(Object.keys(admitted), ENGINE_SIDE_COPIES);
  for (const [file, models] of Object.entries(admitted)) {
    assert.ok(models.includes("deepseek-flash"), `${file} was asked and admits the default model`);
    assert.deepEqual(missingFrom(models, supportedDeepSeekModels), [], `${file} admits a session model the gateway does not certify`);
    assert.deepEqual(missingFrom(supportedDeepSeekModels, models), ENGINE_SIDE_GAP,
      `${file} no longer refuses exactly the models written down as its gap: set ENGINE_SIDE_GAP to what it still refuses`);
  }
});

const sha = (value) => createHash("sha256").update(value).digest("hex");
const vcrHealth = { ok: true, engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "a".repeat(64),
  numericalSourceDigest: "b".repeat(64), methods: ["design.analytic", "comparator.evalue"] };

/**
 * What the control plane's VCR replay says of one frozen input: `admitted` once
 * it has handed the engine a job carrying that scenario, or its refusal code.
 */
async function vcrVerdict(project, jobId, method, input, parameters = {}) {
  const inputPath = `result-replays/${jobId}/input.json`;
  const bytes = Buffer.from(JSON.stringify(input));
  await mkdir(path.dirname(path.join(project.workspaceDir, inputPath)), { recursive: true });
  await writeFile(path.join(project.workspaceDir, inputPath), bytes);
  const recipe = { method, version: "1", input: { path: inputPath, sha256: sha(bytes) }, parameters,
    codeDigest: vcrHealth.numericalSourceDigest,
    environmentDigest: replayDigest({ engineVersion: vcrHealth.engineVersion, rVersion: vcrHealth.rVersion, packageLockHash: vcrHealth.packageLockHash }) };
  const submitted = [];
  const adapter = new ResultVcrReplay({
    engine: { configured: () => true, health: async () => vcrHealth,
      submit: async (job) => { submitted.push(job); return { jobId: job.jobId, accepted: true }; },
      status: async (id) => ({ jobId: id, state: "running" }) },
    authorizeProject: async () => project,
  });
  try {
    await adapter.start({ userId: "member", projectId: project.id, jobId, method, recipeDigest: replayDigest(recipe) }, recipe);
  } catch (error) {
    assert.equal(submitted.length, 0, "a refused input reaches no engine");
    return error.code;
  }
  assert.deepEqual(submitted.map((job) => job.scenario), [input.scenario]);
  return "admitted";
}

test("research_calculate offers the domain's methods and describes inputs the VCR replay admits", async (t) => {
  const described = await python(
    "{'methods': list(calculate.METHODS), 'executed': sorted(inputs.deterministic_replay.METHODS), "
    + "'cases': {method: {**inputs.cases(method), 'parameters': inputs.parameter_cases(method)} "
    + "for method in calculate.METHODS if method not in inputs.deterministic_replay.METHODS}}");
  assert.deepEqual(missingFrom(RESULT_REPLAY_METHODS, described.methods), [], "the control plane runs a method the tool does not offer");
  assert.deepEqual(missingFrom(described.methods, RESULT_REPLAY_METHODS), [], "the tool offers a method the control plane does not run");
  // Every method is asked about by one of the two suites; these are this one's.
  assert.equal(described.executed.length, 3);
  assert.deepEqual(Object.keys(described.cases).sort(), ["comparator.evalue", "design.analytic"]);

  const rootDir = await mkdtemp(path.join(os.tmpdir(), "evimed-engine-tool-contract-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const project = { id: "p", userId: "owner", rootDir, workspaceDir: path.join(rootDir, "workspace"),
    baseDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, "metadata") };
  await mkdir(project.metaDir, { recursive: true });
  let jobs = 0;
  const verdict = (method, input, parameters) => vcrVerdict(project, `job_${++jobs}`, method, input, parameters);

  for (const [method, cases] of Object.entries(described.cases)) {
    assert.ok(cases.admitted.length >= 2 && cases.refused.length >= 5, `${method}: the described inputs were read`);
    for (const input of cases.admitted) {
      for (const parameters of cases.parameters.admitted) {
        assert.equal(await verdict(method, input, parameters), "admitted", `${method} refuses an input its description offers: ${JSON.stringify(input)}`);
      }
    }
    for (const input of cases.refused) {
      assert.equal(await verdict(method, input, {}), "result_recipe_invalid", `${method} admits ${JSON.stringify(input)}`);
    }
    for (const parameters of cases.parameters.refused) {
      assert.equal(await verdict(method, cases.admitted[0], parameters), "result_recipe_invalid", `${method} admits parameters ${JSON.stringify(parameters)}`);
    }
  }
  // The scenario without its key, which "VCR scenarios" left a model free to write.
  assert.equal(await verdict("comparator.evalue", { riskRatio: 3.9 }, {}), "result_recipe_invalid");

  // And the other way round, where the domain can be asked: nothing these two
  // methods run is missing from what the tool offers.
  const designs = described.cases["design.analytic"].admitted.map(({ scenario }) => `${scenario.design.kind} ${scenario.endpoint.type}`);
  const supported = Object.entries(VCR_DESIGN_SUPPORT["design.analytic"]).flatMap(([kind, endpoints]) => endpoints.map((endpoint) => `${kind} ${endpoint}`));
  assert.deepEqual(missingFrom(supported, designs), [], "design.analytic runs a design the tool does not describe");
  assert.deepEqual(missingFrom(designs, supported), [], "the tool describes a design design.analytic does not run");
  const evalue = described.cases["comparator.evalue"].admitted.map(({ scenario }) => scenario);
  const fields = VCR_SCENARIO_SCHEMAS["comparator.evalue"].fields;
  assert.deepEqual(missingFrom(Object.keys(fields), evalue.flatMap((scenario) => Object.keys(scenario))), [], "comparator.evalue reads a key the tool does not describe");
  assert.deepEqual(missingFrom(fields.scale.values, evalue.map((scenario) => scenario.scale)), [], "comparator.evalue takes a scale the tool does not describe");
});

test("the acceptance journeys upload an aggregate the meta.dl executor admits", async () => {
  const verdicts = await python("[inputs.verdict('meta.dl', value) for value in values]",
    ACCEPTANCE_AGGREGATE, { studies: ACCEPTANCE_AGGREGATE.studies });
  // The second is what the journeys uploaded until 2026-10-03.
  assert.deepEqual(verdicts, ["admitted", "replay_input_invalid"]);
});
