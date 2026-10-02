/** Fixed aggregate replay through the existing VCR gateway; patient tables never enter this adapter. */
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalScenarioJson, validateEngineJob, VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION } from "@evimed/domain";
import { normalizeResultPath } from "@evimed/domain/result-provenance";
import { replayDigest } from "./resultReplayClient.mjs";
import { HttpError, assertProjectCapacity, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath,
  withProjectStorageMutation, writeFileExclusiveNoFollow } from "./security.mjs";

const METHODS = ["design.analytic", "comparator.evalue"];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const TERMINAL = ["succeeded", "failed", "canceled", "not_estimable"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fail = (code, message, status = 409) => { throw new HttpError(status, code, message); };

/** @param {any} project @param {string} file @param {number} limit */
async function stable(project, file, limit) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(project.rootDir, file);
    if (!opened.stat.isFile() || opened.stat.size > limit) fail("result_input_too_large", "Calculation input exceeds its limit.", 413);
    return await readStableFileHandle(opened.handle, opened.stat);
  } finally { await opened?.handle.close(); }
}

/** No inferred environment: all three fields and the installed numerical source digest must exist. */
function identity(health) {
  if (health?.ok !== true || !HASH.test(health.numericalSourceDigest ?? "") || !HASH.test(health.packageLockHash ?? "")
    || typeof health.engineVersion !== "string" || !health.engineVersion || typeof health.rVersion !== "string" || !health.rVersion) return null;
  return { codeDigest: health.numericalSourceDigest,
    environmentDigest: replayDigest({ engineVersion: health.engineVersion, rVersion: health.rVersion, packageLockHash: health.packageLockHash }) };
}

export class ResultVcrReplay {
  /** @param {{engine:any,authorizeProject:(userId:string,projectId:string)=>Promise<any>,config?:any,maxInputBytes?:number,maxCpuSeconds?:number,cancelWaitMs?:number}} dependencies */
  constructor({ engine, authorizeProject, config = {}, maxInputBytes = 1024 * 1024, maxCpuSeconds = 300, cancelWaitMs = 15000 }) {
    this.engine = engine; this.authorizeProject = authorizeProject; this.config = config;
    this.maxInputBytes = maxInputBytes; this.maxCpuSeconds = maxCpuSeconds; this.cancelWaitMs = cancelWaitMs;
  }

  configured(method) { return METHODS.includes(method) && this.engine?.configured() === true; }

  async scoped(scope) {
    if (!scope || ![scope.userId, scope.projectId, scope.jobId].every(value => typeof value === "string" && ID.test(value))
      || !HASH.test(scope.recipeDigest ?? "") || !METHODS.includes(scope.method)) fail("result_replay_scope_invalid", "Invalid calculation scope.", 400);
    const project = await this.authorizeProject(scope.userId, scope.projectId);
    if (!project || project.id !== scope.projectId || typeof project.userId !== "string" || !project.rootDir || !project.workspaceDir || !project.metaDir) {
      fail("result_project_forbidden", "The calculation project is unavailable.", 403);
    }
    resolveScopedPath(project.rootDir, path.relative(project.rootDir, project.workspaceDir));
    resolveScopedPath(project.rootDir, path.relative(project.rootDir, project.metaDir));
    return project;
  }

  async capabilities(scope) {
    await this.scoped(scope);
    let health = null;
    if (this.configured(scope.method)) { try { health = await this.engine.health(); } catch { /* The missing provider has an explicit unavailable projection. */ } }
    const frozen = identity(health);
    return { methods: METHODS.map(method => ({ method, version: "1", engineMethodVersion: VCR_ENGINE_METHODS[method].version,
      available: Boolean(frozen && health.methods?.includes(method)), ...(frozen ?? {}),
      ...(!frozen ? { reason: "result_replay_unavailable" } : {}) })) };
  }

  metadata(project, scope) { return resolveScopedPath(project.metaDir, `result-vcr-replays/${scope.jobId}.json`); }

  engineId(project, scope) { return `replay-${replayDigest([project.userId, project.id, scope.jobId, scope.recipeDigest])}`; }

  async absentStatus(project, scope) {
    const engineId = this.engineId(project, scope);
    let progress;
    try { progress = await this.engine.status(engineId); }
    catch (error) { if (error?.code === "vcr_engine_not_found") return this.answer(scope, "ownership_unknown", "unconfirmed"); throw error; }
    if (progress.jobId !== engineId) fail("result_replay_scope_invalid", "The engine returned another calculation.");
    // Only the engine's durable cancellation marker closes an absent reservation.
    return progress.state === "canceled" ? this.answer(scope, "canceled", "confirmed")
      : this.answer(scope, "ownership_unknown", "unconfirmed");
  }

  async recorded(project, scope) {
    let record;
    try { record = JSON.parse((await stable(project, this.metadata(project, scope), this.maxInputBytes + 65536)).toString("utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (record.ownerId !== project.userId || record.projectId !== project.id || record.jobId !== scope.jobId
      || record.recipeDigest !== scope.recipeDigest || record.method !== scope.method || !object(record.job)
      || replayDigest(record.recipe) !== scope.recipeDigest || record.job.jobId !== `replay-${replayDigest([project.userId, project.id, scope.jobId, scope.recipeDigest])}`
      || record.job.method !== scope.method || record.expected?.method !== scope.method || record.expected?.seed !== record.job.seed
      || sha(canonicalScenarioJson(record.job.scenario)) !== record.expected?.scenarioHash) {
      fail("result_replay_scope_invalid", "The saved calculation identity does not match.");
    }
    return record;
  }

  async exclusive(project, file, bytes) {
    await withProjectStorageMutation(project, async () => {
      await assertProjectCapacity({ ...project, baseDir: project.rootDir }, file, bytes.length, this.config);
      try { await writeFileExclusiveNoFollow(project.rootDir, file, bytes); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const saved = await stable(project, file, bytes.length);
        if (!saved.equals(bytes)) fail("result_replay_output_changed", "The saved calculation bytes changed.");
      }
    });
  }

  async start(scope, recipe, { signal = undefined } = {}) {
    const project = await this.scoped(scope);
    if (!this.configured(scope.method)) fail("result_replay_unavailable", "The calculation engine is unavailable.", 503);
    if (signal?.aborted) throw signal.reason ?? new Error("Calculation canceled.");
    const existing = await this.recorded(project, scope);
    if (existing) return this.observe(project, scope, existing);
    if (!object(recipe) || recipe.version !== "1" || recipe.method !== scope.method || replayDigest(recipe) !== scope.recipeDigest
      || Object.keys(recipe).some(key => !["method", "version", "input", "parameters", "codeDigest", "environmentDigest"].includes(key))
      || !object(recipe.input) || Object.keys(recipe.input).some(key => !["path", "sha256"].includes(key))
      || !HASH.test(recipe.input.sha256 ?? "") || !HASH.test(recipe.codeDigest ?? "") || !HASH.test(recipe.environmentDigest ?? "")) {
      fail("result_recipe_invalid", "Invalid fixed calculation recipe.", 400);
    }
    const relativePath = normalizeResultPath(recipe.input.path);
    if (relativePath !== recipe.input.path || relativePath !== `result-replays/${scope.jobId}/input.json`) {
      fail("result_recipe_invalid", "The input must be this calculation's frozen workspace snapshot.", 400);
    }
    const bytes = await stable(project, resolveScopedPath(project.workspaceDir, relativePath), this.maxInputBytes);
    if (sha(bytes) !== recipe.input.sha256) fail("result_input_changed", "The frozen input changed.");
    let input;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { fail("result_recipe_invalid", "Calculation input must be aggregate JSON.", 400); }
    const parameters = recipe.parameters ?? {};
    if (!object(input) || !object(input.scenario) || Object.keys(input).some(key => !["scenario", "seed", "cpuSecondsLimit"].includes(key))
      || !object(parameters) || Object.keys(parameters).some(key => !["seed", "cpuSecondsLimit"].includes(key))) {
      fail("result_recipe_invalid", "Only aggregate scenario, seed and CPU limit are supported.", 400);
    }
    const seed = parameters.seed ?? input.seed ?? 1;
    const cpuSecondsLimit = parameters.cpuSecondsLimit ?? input.cpuSecondsLimit ?? 60;
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647 || !Number.isInteger(cpuSecondsLimit)
      || cpuSecondsLimit < 1 || cpuSecondsLimit > this.maxCpuSeconds) fail("result_recipe_invalid", "Invalid fixed calculation limits.", 400);
    const capability = (await this.capabilities(scope)).methods.find(item => item.method === scope.method);
    if (!capability?.available || capability.codeDigest !== recipe.codeDigest || capability.environmentDigest !== recipe.environmentDigest) {
      fail("result_replay_environment_changed", "The recorded calculation environment is unavailable.");
    }
    const engineId = this.engineId(project, scope);
    const job = { jobId: engineId, studyId: `replay-${replayDigest([project.userId, project.id])}`, protocolVersion: VCR_ENGINE_PROTOCOL_VERSION,
      kind: scope.method === "design.analytic" ? "design_analytic" : "evalue", method: scope.method,
      methodVersion: VCR_ENGINE_METHODS[scope.method].version, scenario: input.scenario,
      inputs: [{ kind: "assumption", id: "asm_replay@1", hash: recipe.input.sha256 }], seed, cpuSecondsLimit, cores: 1 };
    const issues = validateEngineJob(job);
    if (issues.length) fail("result_recipe_invalid", `Aggregate calculation input is invalid: ${issues.map(issue => issue.field).join(", ")}.`, 400);
    const record = { ownerId: project.userId, projectId: project.id, jobId: scope.jobId, recipeDigest: scope.recipeDigest, method: scope.method,
      recipe, job, expected: { method: job.method, methodVersion: job.methodVersion,
        scenarioHash: sha(canonicalScenarioJson(job.scenario)), seed: job.seed, replicates: null } };
    // Reserve before dispatch. A lost response never causes a second automatic submit.
    let reserved = false;
    await withProjectStorageMutation(project, async () => {
      const file = this.metadata(project, scope);
      const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
      await assertProjectCapacity({ ...project, baseDir: project.rootDir }, file, encoded.length, this.config);
      try { await writeFileExclusiveNoFollow(project.rootDir, file, encoded); reserved = true; }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    });
    if (!reserved) return this.observe(project, scope, await this.recorded(project, scope));
    try { await this.engine.submit(job); }
    catch (error) {
      // A concurrently canceled, delayed admission must resolve its tombstone, never retry.
      if (!(error?.code === "vcr_engine_rejected" && error?.status === 409 && error?.detail === "job_canceled")) throw error;
    }
    return this.observe(project, scope, record);
  }

  async status(scope) {
    const project = await this.scoped(scope);
    const record = await this.recorded(project, scope);
    if (!record) return this.absentStatus(project, scope);
    return this.observe(project, scope, record);
  }

  answer(scope, state, cleanup, extra = {}) {
    return { jobId: scope.jobId, recipeDigest: scope.recipeDigest, state, cleanup, artifacts: [], machineValues: [], ...extra };
  }

  async observe(project, scope, record) {
    let progress;
    try { progress = await this.engine.status(record.job.jobId); }
    catch (error) { if (error?.code === "vcr_engine_not_found") return this.answer(scope, "ownership_unknown", "unconfirmed"); throw error; }
    if (progress.jobId !== record.job.jobId) fail("result_replay_scope_invalid", "The engine returned another calculation.");
    if (!TERMINAL.includes(progress.state)) return this.answer(scope, ["queued", "running", "canceling"].includes(progress.state) ? progress.state : "ownership_unknown", "unconfirmed");
    let checked;
    try { checked = await this.engine.result(record.job.jobId, { expected: record.expected }); }
    catch (error) {
      // Queued cancellation has no numerical result, but the gateway confirms there is no running process.
      if (["canceled", "failed"].includes(progress.state) && (error?.code === "vcr_engine_not_found"
        || error?.code === "vcr_engine_rejected" && error?.status === 409 && error?.detail === "result_not_ready")) {
        return this.answer(scope, progress.state, "confirmed", { resultError: error.code });
      }
      throw error;
    }
    const result = checked.result;
    if (result.status !== progress.state) fail("result_replay_scope_invalid", "The engine state changed during result retrieval.");
    const retained = result.status === "succeeded" || result.conclusion === "limited";
    if (retained && (checked.refused || identity(await this.engine.health())?.codeDigest !== record.recipe.codeDigest
      || replayDigest({ engineVersion: result.manifest?.engineVersion, rVersion: result.manifest?.rVersion,
        packageLockHash: result.manifest?.packageLockHash }) !== record.recipe.environmentDigest)) {
      fail("result_replay_environment_changed", "The result does not match the frozen calculation environment.");
    }
    const machineValues = retained ? (result.measures ?? []).filter(measure => Number.isFinite(measure.value)).map(measure => ({
      key: measure.name, value: measure.value, ...(typeof measure.unit === "string" ? { unit: measure.unit } : {}), absoluteTolerance: 1e-10, relativeTolerance: 1e-10,
    })) : [];
    if (new Set(machineValues.map(value => value.key)).size !== machineValues.length) fail("result_replay_output_invalid", "The engine returned duplicate scientific values.");
    const resultPath = `result-replays/${scope.jobId}/output/result.json`;
    const output = Buffer.from(`${JSON.stringify(result)}\n`);
    await this.exclusive(project, resolveScopedPath(project.workspaceDir, resultPath), output);
    const artifact = { path: resultPath, sha256: sha(output), bytes: output.length };
    const receiptPath = `result-replays/${scope.jobId}/output/receipt.json`;
    const receipt = Buffer.from(`${JSON.stringify({ jobId: scope.jobId, recipeDigest: scope.recipeDigest, engineJobId: record.job.jobId,
      method: record.method, methodVersion: record.job.methodVersion, codeDigest: record.recipe.codeDigest,
      environmentDigest: record.recipe.environmentDigest, signed: checked.signed === true, outputHash: checked.outputHash ?? null,
      artifacts: [artifact], machineValues })}\n`);
    await this.exclusive(project, resolveScopedPath(project.workspaceDir, receiptPath), receipt);
    return this.answer(scope, result.status === "not_estimable" ? "failed" : result.status, "confirmed", {
      resultPath, machineValues, scientificStatus: result.status, partial: result.conclusion === "limited",
      artifacts: [artifact, { path: receiptPath, sha256: sha(receipt), bytes: receipt.length }] });
  }

  async cancel(scope) {
    const project = await this.scoped(scope);
    const record = await this.recorded(project, scope);
    if (!record) {
      await this.engine.cancel(this.engineId(project, scope));
      return this.absentStatus(project, scope);
    }
    let before;
    try { before = await this.engine.status(record.job.jobId); }
    catch (error) { if (error?.code !== "vcr_engine_not_found") throw error; }
    if (before && before.jobId !== record.job.jobId) fail("result_replay_scope_invalid", "The engine returned another calculation.");
    // A 404 can precede a delayed POST: persist the engine's cancellation tombstone anyway.
    if (!before || !TERMINAL.includes(before.state)) await this.engine.cancel(record.job.jobId);
    // A cancel acknowledgement alone never proves the R process has stopped.
    const deadline = Date.now() + this.cancelWaitMs;
    for (;;) {
      let answer;
      try { answer = await this.observe(project, scope, record); }
      catch (error) {
        // A terminal process can have an invalid/missing scientific result. Keep the failure separate from cleanup.
        const terminal = await this.engine.status(record.job.jobId);
        if (terminal.jobId !== record.job.jobId || !TERMINAL.includes(terminal.state)) throw error;
        return this.answer(scope, terminal.state === "canceled" ? "canceled" : "failed", "confirmed", { resultError: error?.code ?? "result_replay_output_invalid" });
      }
      if (answer.cleanup === "confirmed" || answer.state === "ownership_unknown" || Date.now() >= deadline) return answer;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
}
