import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ResultVcrReplay } from "../src/resultVcrReplay.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const health = { ok: true, engineVersion: "1.0.0", rVersion: "R 4.3.3", packageLockHash: "a".repeat(64),
  numericalSourceDigest: "b".repeat(64), methods: ["design.analytic", "comparator.evalue"] };
const scenario = { riskRatio: 3.9, confidenceLimit: 1.8, scale: "risk_ratio" };

async function fixture(t, { input = { scenario }, engine = null, cancelWaitMs = 20 } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "evimed-vcr-replay-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const project = { id: "p", userId: "owner", rootDir, workspaceDir: path.join(rootDir, "workspace"),
    baseDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, "metadata") };
  const scope = { userId: "member", projectId: "p", jobId: "job_1", method: "comparator.evalue", recipeDigest: "" };
  await mkdir(path.join(project.workspaceDir, "result-replays/job_1"), { recursive: true });
  await mkdir(project.metaDir);
  const bytes = Buffer.from(JSON.stringify(input));
  const inputPath = "result-replays/job_1/input.json";
  await writeFile(path.join(project.workspaceDir, inputPath), bytes);
  const recipe = { method: scope.method, version: "1", input: { path: inputPath, sha256: sha(bytes) }, parameters: {},
    codeDigest: health.numericalSourceDigest, environmentDigest: replayDigest({ engineVersion: health.engineVersion, rVersion: health.rVersion, packageLockHash: health.packageLockHash }) };
  scope.recipeDigest = replayDigest(recipe);
  let submitted;
  let submits = 0;
  let state = "running";
  let cancels = 0;
  const mock = { configured: () => true, health: async () => health,
    submit: async job => { submitted = job; submits++; return { jobId: job.jobId, accepted: true }; },
    status: async id => ({ jobId: id, state }), cancel: async () => { cancels++; return { canceled: true }; },
    result: async () => ({ signed: false, outputHash: "c".repeat(64), result: {
      jobId: submitted.jobId, method: submitted.method, methodVersion: submitted.methodVersion, status: state,
      manifest: { engineVersion: health.engineVersion, rVersion: health.rVersion, packageLockHash: health.packageLockHash },
      measures: state === "succeeded" ? [{ name: "e_value", value: 7.263 }] : [],
    } }), };
  let allowed = true;
  let authCalls = 0;
  const adapter = new ResultVcrReplay({ engine: engine ?? mock, cancelWaitMs,
    authorizeProject: async (actor, id) => { authCalls++; assert.equal(actor, "member"); assert.equal(id, "p");
      if (!allowed) throw Object.assign(new Error("revoked"), { code: "forbidden" }); return project; } });
  return { project, scope, recipe, adapter, mock, setState: value => { state = value; }, revoke: () => { allowed = false; },
    get submitted() { return submitted; }, get submits() { return submits; }, get cancels() { return cancels; }, get authCalls() { return authCalls; } };
}

test("VCR replay reserves owner-scoped identity, reuses the gateway and survives adapter restart without resubmission", async t => {
  const f = await fixture(t);
  const started = await f.adapter.start(f.scope, f.recipe);
  assert.equal(started.state, "running");
  assert.equal(started.cleanup, "unconfirmed");
  assert.equal(f.submitted.methodVersion, "1.0.0");
  assert.deepEqual(f.submitted.inputs, [{ kind: "assumption", id: "asm_replay@1", hash: f.recipe.input.sha256 }]);
  assert.equal(f.submitted.cores, 1);
  const restarted = new ResultVcrReplay({ engine: f.mock, authorizeProject: async () => f.project });
  assert.equal((await restarted.start(f.scope, f.recipe)).state, "running");
  assert.equal(f.submits, 1);
  f.setState("succeeded");
  const answer = await restarted.status(f.scope);
  assert.equal(answer.cleanup, "confirmed");
  assert.equal(answer.jobId, f.scope.jobId);
  assert.equal(answer.recipeDigest, f.scope.recipeDigest);
  assert.equal(answer.machineValues[0].key, "e_value");
  assert.equal(answer.artifacts.length, 2);
  for (const artifact of answer.artifacts) {
    const bytes = await readFile(path.join(f.project.workspaceDir, artifact.path));
    assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes);
  }
  assert.equal(JSON.parse(await readFile(path.join(f.project.workspaceDir, answer.artifacts[1].path), "utf8")).signed, false);
  assert.deepEqual(await restarted.status(f.scope), answer);
});

test("the actor is reauthorized on capabilities, status and cancellation, including shared projects", async t => {
  const f = await fixture(t);
  assert.equal((await f.adapter.capabilities(f.scope)).methods.length, 2);
  await f.adapter.start(f.scope, f.recipe);
  f.revoke();
  await assert.rejects(f.adapter.status(f.scope), { code: "forbidden" });
  await assert.rejects(f.adapter.cancel(f.scope), { code: "forbidden" });
  await assert.rejects(f.adapter.capabilities(f.scope), { code: "forbidden" });
  assert.ok(f.authCalls >= 5);
});

test("aggregate allowlist rejects patient tables, extra scenarios, executable payloads and changed input before submit", async t => {
  for (const input of [{ scenario, inputs: [{ kind: "analysis_table", location: "patient.csv" }] },
    { scenario: { ...scenario, patientRecords: [{ id: "private" }] } }, { scenario: { ...scenario, expression: "system('x')" } },
    { scenario, seed: 2147483648 }, { scenario, cpuSecondsLimit: 301 }]) {
    const f = await fixture(t, { input });
    await assert.rejects(f.adapter.start(f.scope, f.recipe), { code: "result_recipe_invalid" });
    assert.equal(f.submits, 0);
  }
  const changed = await fixture(t);
  await writeFile(path.join(changed.project.workspaceDir, changed.recipe.input.path), JSON.stringify({ scenario: { riskRatio: 4 } }));
  await assert.rejects(changed.adapter.start(changed.scope, changed.recipe), { code: "result_input_changed" });
  assert.equal(changed.submits, 0);
});

test("missing provider and missing installed source identity expose unavailable capabilities", async t => {
  const f = await fixture(t, { engine: { configured: () => false } });
  assert.equal(f.adapter.configured("meta.dl"), false);
  assert.equal((await f.adapter.capabilities(f.scope)).methods.every(item => item.available === false), true);
  await assert.rejects(f.adapter.start(f.scope, f.recipe), { code: "result_replay_unavailable" });
  const incomplete = await fixture(t);
  incomplete.mock.health = async () => ({ ...health, numericalSourceDigest: null });
  assert.equal((await incomplete.adapter.capabilities(incomplete.scope)).methods.every(item => !item.available), true);
});

test("changed health identity, mismatched scope and input symlinks cannot launch a calculation", async t => {
  const f = await fixture(t);
  f.mock.health = async () => ({ ...health, numericalSourceDigest: "d".repeat(64) });
  await assert.rejects(f.adapter.start(f.scope, f.recipe), { code: "result_replay_environment_changed" });
  assert.equal(f.submits, 0);
  const linked = await fixture(t);
  const inputPath = path.join(linked.project.workspaceDir, linked.recipe.input.path);
  await rm(inputPath); await writeFile(path.join(linked.project.rootDir, "outside.json"), JSON.stringify({ scenario }));
  await symlink(path.join(linked.project.rootDir, "outside.json"), inputPath);
  await assert.rejects(linked.adapter.start(linked.scope, linked.recipe));
  assert.equal(linked.submits, 0);
  const mismatch = await fixture(t);
  await mismatch.adapter.start(mismatch.scope, mismatch.recipe);
  await assert.rejects(mismatch.adapter.status({ ...mismatch.scope, recipeDigest: "e".repeat(64) }), { code: "result_replay_scope_invalid" });
});

test("cancel acknowledgement remains unconfirmed until the gateway observes a terminal process state", async t => {
  const f = await fixture(t);
  await f.adapter.start(f.scope, f.recipe);
  const pending = await f.adapter.cancel(f.scope);
  assert.equal(pending.cleanup, "unconfirmed");
  assert.equal(f.cancels, 1);
  f.mock.cancel = async () => { setTimeout(() => f.setState("canceled"), 5); return { canceled: true }; };
  const canceled = await f.adapter.cancel(f.scope);
  assert.equal(canceled.state, "canceled"); assert.equal(canceled.cleanup, "confirmed");
  assert.equal(canceled.machineValues.length, 0);
  assert.equal(canceled.artifacts.length, 2, "the engine's stopped result is retained");
});

test("lost submit response and lost engine ownership never automatically repeat execution", async t => {
  const f = await fixture(t);
  f.mock.submit = async () => { throw Object.assign(new Error("timeout"), { code: "vcr_engine_timeout" }); };
  await assert.rejects(f.adapter.start(f.scope, f.recipe), { code: "vcr_engine_timeout" });
  f.mock.status = async () => { throw Object.assign(new Error("missing"), { code: "vcr_engine_not_found" }); };
  assert.equal((await f.adapter.start(f.scope, f.recipe)).state, "ownership_unknown");
  assert.equal((await f.adapter.cancel(f.scope)).cleanup, "unconfirmed");
});

test("absent and reserved admissions receive durable cancellation before any delayed submit", async t => {
  for (const reserved of [false, true]) {
    const f = await fixture(t);
    const missing = () => Object.assign(new Error("missing"), { code: "vcr_engine_not_found" });
    let canceled = false; let attempts = 0;
    f.mock.status = async id => { if (!canceled) throw missing(); return { jobId: id, state: "canceled" }; };
    f.mock.cancel = async () => { canceled = true; return { canceled: true }; };
    f.mock.result = async () => { throw missing(); };
    f.mock.submit = async () => {
      attempts++;
      throw Object.assign(new Error(canceled ? "canceled" : "timeout"), canceled
        ? { code: "vcr_engine_rejected", status: 409, detail: "job_canceled" } : { code: "vcr_engine_timeout" });
    };
    if (reserved) await assert.rejects(f.adapter.start(f.scope, f.recipe), { code: "vcr_engine_timeout" });
    assert.equal((await f.adapter.cancel(f.scope)).cleanup, "confirmed");
    const restarted = new ResultVcrReplay({ engine: f.mock, authorizeProject: async () => f.project });
    const answer = await restarted.start(f.scope, f.recipe);
    assert.equal(answer.state, "canceled"); assert.equal(answer.cleanup, "confirmed");
    assert.equal(answer.artifacts.length, 0); assert.equal(attempts, 1);
    await restarted.start(f.scope, f.recipe); assert.equal(attempts, 1, "restart never repeats the canceled admission");
  }
});

test("a cancellation response cannot close another engine identity", async t => {
  const f = await fixture(t);
  f.mock.status = async () => ({ jobId: "different-engine-job", state: "canceled" });
  await assert.rejects(f.adapter.cancel(f.scope), { code: "result_replay_scope_invalid" });
});

test("preserved outputs cannot be overwritten by a changed engine response or workspace bytes", async t => {
  const f = await fixture(t);
  await f.adapter.start(f.scope, f.recipe); f.setState("succeeded");
  const answer = await f.adapter.status(f.scope);
  await writeFile(path.join(f.project.workspaceDir, answer.resultPath), "substituted");
  await assert.rejects(f.adapter.status(f.scope), { code: "result_replay_output_changed" });
  assert.equal((await f.adapter.cancel(f.scope)).cleanup, "confirmed", "invalid saved result bytes do not invent a still-running process");
});

test("queued cancellation can confirm cleanup without inventing a numerical result", async t => {
  const f = await fixture(t);
  await f.adapter.start(f.scope, f.recipe);
  f.setState("canceled");
  f.mock.result = async () => { throw Object.assign(new Error("not_ready"), { code: "vcr_engine_rejected", status: 409, detail: "result_not_ready" }); };
  const answer = await f.adapter.cancel(f.scope);
  assert.equal(answer.state, "canceled"); assert.equal(answer.cleanup, "confirmed");
  assert.equal(answer.machineValues.length, 0); assert.equal(answer.artifacts.length, 0);
});

test("a verified stopped calculation keeps actual limited values and never labels them complete", async t => {
  const f = await fixture(t);
  await f.adapter.start(f.scope, f.recipe); f.setState("canceled");
  f.mock.result = async () => ({ signed: true, outputHash: "c".repeat(64), result: {
    status: "canceled", conclusion: "limited", measures: [{ name: "e_value", value: 7.263 }],
    manifest: { engineVersion: health.engineVersion, rVersion: health.rVersion, packageLockHash: health.packageLockHash },
  } });
  const answer = await f.adapter.cancel(f.scope);
  assert.equal(answer.state, "canceled"); assert.equal(answer.cleanup, "confirmed");
  assert.equal(answer.partial, true); assert.equal(answer.machineValues[0].value, 7.263);
  assert.equal(answer.artifacts.length, 2);
});
