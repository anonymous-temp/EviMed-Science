/** Optional R dependency integration: set VCR_R_LIBS to the pinned test library.
 * Runs the unchanged numerical entrypoint through the existing gateway client.
 * The local transport is a fixture, not qualification of a deployed signed service. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ResultVcrReplay } from "../src/resultVcrReplay.mjs";
import { createVcrEngineClient } from "../src/vcrEngineClient.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";

const exec = promisify(execFile);
const engineRoot = fileURLToPath(new URL("../../../../项目代码/vcr-engine/", import.meta.url));
const sha = value => createHash("sha256").update(value).digest("hex");
const enabled = Boolean(process.env.VCR_R_LIBS);

// Same installed-file identity as service/app.py numerical_source_digest; no copied numerical formula.
async function numericalSourceDigest() {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(R|json)$/.test(entry.name)) files.push(file);
    }
  };
  await visit(path.join(engineRoot, "R"));
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = await readFile(file);
    hash.update(`${path.relative(engineRoot, file).split(path.sep).join("/")}\0${bytes.length}\0${sha(bytes)}\n`);
  }
  return hash.digest("hex");
}

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "evimed-vcr-real-"));
  const env = { ...process.env, VCR_ENGINE_ROOT: engineRoot };
  const source = 'local({lib<-Sys.getenv("VCR_R_LIBS","");if(nzchar(lib)).libPaths(c(lib,.libPaths()))});root<-Sys.getenv("VCR_ENGINE_ROOT");source(file.path(root,"R","engine.R"));vcr_engine_load(root);cat(jsonlite::toJSON(vcr_engine_health(),auto_unbox=TRUE,digits=NA))';
  const { stdout } = await exec("Rscript", ["-e", source], { env });
  const health = { ...JSON.parse(stdout), numericalSourceDigest: await numericalSourceDigest() };
  assert.equal(health.ok, true, "the genuine R startup self-check must pass");
  const project = { id: "p", userId: "owner", rootDir, baseDir: path.join(rootDir, "workspace"),
    workspaceDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, "metadata") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const jobs = new Map();
  const calls = [];
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: options.method ?? "GET" });
    if (route === "/health") return response(health);
    if (route === "/jobs" && options.method === "POST") {
      const job = JSON.parse(options.body);
      assert.equal(job.inputs.every(input => input.kind === "assumption" && input.location === undefined), true);
      assert.equal(jobs.has(job.jobId), false, "a frozen engine identity is submitted once");
      const output = path.join(rootDir, "engine-jobs", job.jobId);
      await mkdir(output, { recursive: true });
      const jobFile = path.join(output, "job.json");
      await writeFile(jobFile, JSON.stringify(job));
      const process = spawn("Rscript", [path.join(engineRoot, "service/run_job.R"), jobFile, output], { env });
      const record = { process, state: "running", result: null, stderr: "", closed: null };
      process.stderr.on("data", bytes => { record.stderr += bytes.toString(); });
      process.stdout.resume();
      record.closed = new Promise((resolve, reject) => {
        process.once("error", reject);
        process.once("close", async code => {
          try {
            assert.equal(code, 0, record.stderr);
            record.result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
            record.state = record.result.status;
            resolve();
          } catch (error) { reject(error); }
        });
      });
      // Avoid unhandled rejection while the adapter is polling; the awaited cleanup still asserts failures.
      record.closed.catch(() => { record.state = "failed"; });
      jobs.set(job.jobId, record);
      return response({ jobId: job.jobId, accepted: true });
    }
    const matched = /^\/jobs\/([^/]+)(\/result|\/cancel)?$/.exec(route);
    if (!matched || !jobs.has(matched[1])) return response({ error: "job_not_found" }, 404);
    const record = jobs.get(matched[1]);
    if (matched[2] === "/result") { await record.closed; return response(record.result); }
    if (matched[2] === "/cancel") { if (record.state === "running") record.process.kill("SIGTERM"); return response({ canceled: true }); }
    return response({ jobId: matched[1], state: record.state, progress: { done: record.state === "succeeded" ? 1 : 0, total: 1 } });
  };
  const client = createVcrEngineClient({ baseUrl: "http://isolated-vcr-fixture.invalid", fetchImpl });
  const adapter = new ResultVcrReplay({ engine: client, authorizeProject: async (userId, projectId) => {
    assert.equal(userId, "owner"); assert.equal(projectId, "p"); return project;
  } });
  t.after(async () => {
    for (const record of jobs.values()) if (record.state === "running") record.process.kill("SIGTERM");
    await Promise.all([...jobs.values()].map(record => record.closed));
    await rm(rootDir, { recursive: true, force: true });
  });
  return { project, adapter, jobs, calls };
}

async function calculate(f, method, scenario, jobId) {
  const scope = { userId: "owner", projectId: "p", jobId, method, recipeDigest: "a".repeat(64) };
  const capability = (await f.adapter.capabilities(scope)).methods.find(item => item.method === method);
  assert.equal(capability.available, true);
  const input = Buffer.from(JSON.stringify({ scenario, seed: 331331, cpuSecondsLimit: 60 }));
  const relativePath = `result-replays/${jobId}/input.json`;
  await mkdir(path.dirname(path.join(f.project.workspaceDir, relativePath)), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, relativePath), input);
  const recipe = { method, version: "1", input: { path: relativePath, sha256: sha(input) }, parameters: {},
    codeDigest: capability.codeDigest, environmentDigest: capability.environmentDigest };
  scope.recipeDigest = replayDigest(recipe);
  let answer = await f.adapter.start(scope, recipe);
  const deadline = Date.now() + 15000;
  while (!["succeeded", "failed"].includes(answer.state) && Date.now() < deadline) {
    await delay(20); answer = await f.adapter.status(scope);
  }
  assert.equal(answer.state, "succeeded"); assert.equal(answer.cleanup, "confirmed");
  for (const artifact of answer.artifacts) {
    const bytes = await readFile(path.join(f.project.workspaceDir, artifact.path));
    assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes);
  }
  const receipt = JSON.parse(await readFile(path.join(f.project.workspaceDir, answer.artifacts[1].path), "utf8"));
  assert.equal(receipt.recipeDigest, scope.recipeDigest); assert.equal(receipt.signed, false);
  assert.ok(receipt.outputHash.match(/^[a-f0-9]{64}$/));
  assert.equal([...f.jobs.values()].every(record => record.process.exitCode === 0), true, "cleanup follows actual R process exit");
  return answer;
}

test("genuine design.analytic replay matches Schoenfeld's 331-event example and is deterministic", { skip: !enabled && "VCR_R_LIBS is required for genuine R integration" }, async t => {
  const f = await fixture(t);
  const scenario = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" },
    truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { alpha: 0.025, sided: 1, power: 0.9 } };
  const first = await calculate(f, "design.analytic", scenario, "design_1");
  const second = await calculate(f, "design.analytic", scenario, "design_2");
  assert.deepEqual(first.machineValues, second.machineValues);
  const values = Object.fromEntries(first.machineValues.map(value => [value.key, value.value]));
  // Independently tabulated standard normal quantiles, not the engine's analytic helper.
  const expected = (1.959963984540054 + 1.2815515655446004) ** 2 / (0.25 * Math.log(0.7) ** 2);
  assert.ok(Math.abs(values.required_events_exact - expected) < 1e-9);
  assert.equal(values.required_events, 331);
  assert.equal(f.calls.filter(call => call.route === "/jobs").length, 2);
  t.diagnostic(`Actual required_events_exact=${values.required_events_exact}; required_events=${values.required_events}; repeated R result identical.`);
});

test("genuine comparator.evalue replay matches independent RR calculation and confidence-limit example", { skip: !enabled && "VCR_R_LIBS is required for genuine R integration" }, async t => {
  const f = await fixture(t);
  const scenario = { riskRatio: 3.9, confidenceLimit: 1.8, scale: "risk_ratio" };
  const first = await calculate(f, "comparator.evalue", scenario, "evalue_1");
  const second = await calculate(f, "comparator.evalue", scenario, "evalue_2");
  assert.deepEqual(first.machineValues, second.machineValues);
  const values = Object.fromEntries(first.machineValues.map(value => [value.key, value.value]));
  assert.ok(Math.abs(values.e_value - (3.9 + Math.sqrt(3.9 * (3.9 - 1)))) < 1e-12);
  assert.ok(Math.abs(values.e_value - 7.26) < 0.005);
  assert.equal(values.e_value_confidence_limit, 3);
  t.diagnostic(`Actual e_value=${values.e_value}; e_value_confidence_limit=${values.e_value_confidence_limit}; repeated R result identical.`);
});
