import { createHash } from "node:crypto";
import { RESULT_REPLAY_METHODS, compareResultNumbers, isResultDigest, normalizeResultPath } from "@evimed/domain";
import { migrateProductStore } from "./productPersistence.mjs";
import { CONTROL_PLANE_SCHEMA } from "./controlPlaneDatabase.mjs";
import { replayDigest } from "./resultReplayClient.mjs";
import { HttpError, assertProjectCapacity, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath,
  withProjectStorageMutation, writeFileExclusiveNoFollow } from "./security.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const recipeId = versionId => `recipe_${versionId}`;
const ENVIRONMENT_PARTS = Object.freeze({ code: ["codeDigest", "代码"], environment: ["environmentDigest", "运行环境"] });

/**
 * What a replay ran on, set against what the original recorded.
 *
 * The code and environment digests of a recipe say which engine produced a
 * result. Recalculating on an engine that has since changed is still a
 * recalculation: it runs, and the record says that it did not run on the same
 * thing (2026-10-04: a freshness or environment record is our own evidence, it
 * labels and never refuses). `recorded` is the original's, `current` is what
 * this replay ran on, and `changed` names which of the two differ.
 * @param {{codeDigest: string, environmentDigest: string}} recorded @param {{codeDigest: string, environmentDigest: string}} current
 */
export function replayEnvironment(recorded, current) {
  const changed = Object.entries(ENVIRONMENT_PARTS).filter(([, [key]]) => recorded[key] !== current[key]).map(([part]) => part);
  return { status: changed.length ? "differs" : "same", changed,
    recorded: { codeDigest: recorded.codeDigest, environmentDigest: recorded.environmentDigest },
    current: { codeDigest: current.codeDigest, environmentDigest: current.environmentDigest } };
}

/** The finding a result carries when it was recalculated on another environment than its original's. */
function environmentFinding(environment) {
  const parts = environment.changed.map(part => {
    const [key, label] = ENVIRONMENT_PARTS[part];
    return `${label}摘要 ${environment.recorded[key].slice(0, 8)} → ${environment.current[key].slice(0, 8)}`;
  });
  return { id: "environment-differs", kind: "execution", status: "environment_differs",
    message: `这次重算所用的计算环境与原结果记录的不同（${parts.join("；")}）；数值比较是在新环境下得到的，不能说明原环境下可以复现。` };
}

/** Only an owned deterministic producer calls admit(). Browser routes select an
 * existing immutable recipe; they cannot supply paths, code, tools or parameters. */
export class ResultReplayService {
  constructor({ results, documents, jobs, engine, config = {} }) {
    this.results = results; this.documents = documents; this.jobs = jobs; this.engine = engine; this.config = config;
  }

  /** Project-before-job lock ordering also fences project deletion. Nested
   * product operations borrow this transaction rather than opening a new one. */
  async projectTransaction(ownerId, projectId, operation) {
    const database = this.jobs.database ?? this.documents.database;
    if (!database) return operation(null); // explicit in-memory test stores
    await migrateProductStore(database);
    return database.transaction(async client => {
      const locked = await client.query(`SELECT id FROM ${CONTROL_PLANE_SCHEMA}.projects WHERE user_id=$1 AND id=$2 FOR UPDATE`, [ownerId, projectId]);
      if (!locked.rows[0]) throw new HttpError(404, "project_not_found", "The project is unavailable.");
      return database.withTransactionClient(client, () => operation(client));
    });
  }

  async withProjectLease(job, operation) {
    const result = await this.projectTransaction(job.userId, job.projectId,
      () => this.jobs.withLease(job.userId, job.id, job.leaseToken, operation));
    if (result === null) throw new HttpError(409, "product_job_lease_lost", "The worker no longer owns this calculation.");
    return result;
  }

  async stopExecution(execution) {
    if (!execution) return;
    // A bare HTTP 404 cannot close a delayed admission. Owned adapters publish
    // durable cancellation tombstones and return a scoped terminal response.
    const stopped = await this.engine.cancel(execution);
    if (stopped?.jobId !== execution.jobId || stopped?.recipeDigest !== execution.recipeDigest || stopped.cleanup !== "confirmed"
      || !["succeeded", "failed", "canceled", "timed_out"].includes(stopped.state)) {
      throw new HttpError(409, "result_replay_stop_unconfirmed", "The calculation process has not stopped under its owned identity.");
    }
    return stopped;
  }

  /** Failure cleanup is itself lease-fenced: an old worker never cancels a
   * process that a recovered owner is currently joining. */
  async stop(job, prepared = null) {
    const outcome = await this.withProjectLease(job, async client => {
      const row = await this.documents.get(job.userId, "result-replay", job.payload.replayId);
      if (row?.payload.jobId !== job.id) throw new HttpError(409, "result_replay_scope_invalid", "The calculation scope changed.");
      let error;
      let answer;
      try { answer = await this.stopExecution(row.payload.execution); } catch (failure) { error = failure; }
      if (!error && prepared && answer?.resultPath) await this.preservePartialOwned(job, prepared, answer, client);
      const current = await this.documents.get(job.userId, "result-replay", row.id);
      await this.documents.put(job.userId, "result-replay", row.id, { ...current.payload,
        cleanup: error ? "unknown" : "confirmed", ...(error ? { stopError: "result_replay_stop_unconfirmed" } : { stopError: null }) },
      { projectId: job.projectId, expectedRevision: current.revision, transactionClient: client });
      return { error };
    });
    if (outcome.error) throw outcome.error;
    return true;
  }

  /** Reconcile physical ownership independently from the retry budget. A lost
   * lease/three exhausted attempts never means a process has actually joined. */
  async reconcileTerminatedAttempts() {
    const database = this.jobs.database ?? this.documents.database;
    if (!database) return;
    await migrateProductStore(database);
    const candidates = (await database.query(`SELECT d.user_id,d.project_id,d.id,d.payload->>'jobId' AS job_id
      FROM evimed_product.documents d JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId'
      WHERE d.kind='result-replay' AND d.deleted_at IS NULL AND d.payload->>'recordType'='result-replay'
        AND d.payload->'execution' IS NOT NULL AND d.payload->'execution'<>'null'::jsonb
        AND COALESCE(d.payload->>'cleanup','pending')<>'confirmed'
        AND NOT (j.status='running' AND j.lease_expires_at>clock_timestamp()) ORDER BY d.updated_at LIMIT 5`)).rows;
    for (const candidate of candidates) await this.projectTransaction(candidate.user_id, candidate.project_id, async client => {
      const currentJob = (await client.query("SELECT status,lease_expires_at>clock_timestamp() AS live FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", [candidate.user_id, candidate.job_id])).rows[0];
      if (!currentJob || currentJob.status === "running" && currentJob.live) return;
      const row = await this.documents.get(candidate.user_id, "result-replay", candidate.id);
      if (!row?.payload.execution || row.payload.cleanup === "confirmed") return;
      let confirmed = false;
      let answer;
      try {
        answer = await this.engine.status(row.payload.execution);
        if (answer?.jobId !== row.payload.execution.jobId || answer?.recipeDigest !== row.payload.execution.recipeDigest) {
          throw new HttpError(409, "result_replay_stop_unconfirmed", "The calculation returned another process identity.");
        }
        if (answer.cleanup === "confirmed" && ["succeeded", "failed", "canceled", "timed_out"].includes(answer.state)) confirmed = true;
        else { answer = await this.stopExecution(row.payload.execution); confirmed = true; }
      } catch { /* Retain the physical blocker, including unreachable engines. */ }
      if (confirmed && answer?.resultPath && ["failed", "canceled"].includes(currentJob.status)) {
        try {
          const prepared = await this.preparedForRecord(row);
          if (prepared) await this.preservePartialOwned({ userId: candidate.user_id, id: candidate.job_id, projectId: candidate.project_id,
            payload: { requestedBy: row.payload.requestedBy, replayId: row.id } }, prepared, answer, client);
        } catch { /* Cleanup remains confirmed even after a source permission revocation. */ }
      }
      const latest = await this.documents.get(candidate.user_id, "result-replay", row.id);
      await this.documents.put(candidate.user_id, "result-replay", row.id, { ...latest.payload,
        cleanup: confirmed ? "confirmed" : "unknown", stopError: confirmed ? null : "result_replay_stop_unconfirmed" },
      { projectId: candidate.project_id, expectedRevision: latest.revision, transactionClient: client });
    });
  }

  async admit(userId, { projectId, versionId, inputVersionId, recipe, machineValues, receipt }) {
    const project = await this.results.scope(userId, projectId);
    const output = await this.results.get(userId, projectId, versionId);
    const input = await this.results.raw(userId, projectId, inputVersionId);
    const unbound = !RESULT_REPLAY_METHODS.includes(recipe?.method) ? "the method is not an admitted deterministic method"
      : !isResultDigest(recipe.codeDigest) || !isResultDigest(recipe.environmentDigest) ? "the recipe does not carry the code and environment digests of the engine that ran"
      : recipe.input?.sha256 !== input.version.digest ? "the recipe's input digest is not that of the captured input"
      : receipt?.recipeDigest !== replayDigest(recipe) ? "the engine's receipt names another recipe than this one"
      : receipt?.outputDigest !== output.digest ? "the engine's receipt names other output bytes than the captured result"
      : output.producer.kind !== "engine" || output.coverage.producer !== "bound" ? "the result was not captured as the engine's own output"
      : null;
    if (unbound) throw new HttpError(409, "result_recipe_unverified", `The recipe was not saved with this result: ${unbound}.`);
    compareResultNumbers(machineValues, machineValues);
    const payload = { recordType: "result-replay-recipe", projectId, versionId, inputVersionId,
      recipe: structuredClone(recipe), recipeDigest: replayDigest(recipe), machineValues: structuredClone(machineValues),
      receipt: { recipeDigest: receipt.recipeDigest, outputDigest: receipt.outputDigest }, capturedAt: new Date().toISOString() };
    const id = recipeId(versionId);
    const existing = await this.documents.get(project.userId, "result-replay", id);
    if (existing) {
      if (existing.payload.recipeDigest !== payload.recipeDigest || existing.payload.inputVersionId !== inputVersionId) throw new HttpError(409, "result_recipe_conflict", "The result already has another recipe.");
      return existing.payload;
    }
    await this.documents.put(project.userId, "result-replay", id, payload, { projectId, expectedRevision: 0 });
    return payload;
  }

  async recipe(userId, version) {
    const project = await this.results.scope(userId, version.projectId);
    const row = await this.documents.get(project.userId, "result-replay", recipeId(version.versionId));
    if (!row || row.projectId !== project.id || row.payload.recordType !== "result-replay-recipe") return null;
    return row.payload;
  }

  async eligibility(userId, version) {
    const recipe = await this.recipe(userId, version);
    return { replay: { status: recipe && this.engine.configured(recipe.recipe.method) ? "available" : "unavailable",
      reasons: recipe ? this.engine.configured(recipe.recipe.method) ? [] : ["engine_unavailable"] : ["no_owned_deterministic_recipe"] },
    export: { status: version.coverage.gaps.length ? "partial" : "available", reasons: version.coverage.gaps } };
  }

  async request(userId, versionId, input) {
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.requestId)) throw new HttpError(400, "result_replay_request_invalid", "Invalid calculation request.");
    const project = await this.results.scope(userId, input.projectId);
    const version = await this.results.get(userId, project.id, versionId);
    if (input.digest !== version.digest) throw new HttpError(409, "result_replay_changed", "The selected result changed.");
    const frozen = await this.recipe(userId, version);
    // Two different things are missing here, and the researcher can do something
    // about neither the same way: say which.
    if (!frozen) throw new HttpError(409, "result_recipe_unavailable", "This result has no recorded calculation recipe (its method, input and parameters), because it was not produced by an admitted deterministic engine run; there is nothing to recalculate it from.");
    if (!this.engine.configured(frozen.recipe.method)) throw new HttpError(503, "result_engine_unavailable", `The calculation engine for ${frozen.recipe.method} is not deployed in this environment, so this result cannot be recalculated here.`);
    await this.results.raw(userId, project.id, frozen.inputVersionId);
    const id = `replay_${hash(JSON.stringify([project.userId, project.id, userId, input.requestId]))}`;
    const prior = await this.documents.get(project.userId, "result-replay", id);
    if (prior) {
      if (prior.payload.versionId !== versionId || prior.payload.requestedBy !== userId) throw new HttpError(409, "result_replay_conflict", "This request already names another result.");
      return this.status(userId, project.id, id);
    }
    const operation = async client => {
      const job = await this.jobs.enqueue(project.userId, "result-replay", { replayId: id, requestedBy: userId, versionId,
        recipeId: recipeId(versionId) }, { idempotencyKey: id, projectId: project.id, maxAttempts: 3, transactionClient: client });
      await this.documents.put(project.userId, "result-replay", id, { recordType: "result-replay", id, projectId: project.id,
        versionId, requestedBy: userId, jobId: job.id, state: "queued", createdAt: new Date().toISOString() },
      { projectId: project.id, expectedRevision: 0, transactionClient: client });
    };
    if (this.documents.database) {
      await migrateProductStore(this.documents.database);
      await this.documents.database.transaction(operation);
    } else await operation(null); // explicit in-memory test stores
    return this.status(userId, project.id, id);
  }

  /** Initial calculations are requested by an authenticated, observed native
   * tool call. The control plane freezes all execution identities itself. */
  async calculate(userId, project, input, producer, revalidate = async () => {}) {
    if (!RESULT_REPLAY_METHODS.includes(input.method)) throw new HttpError(409, "result_calculation_unavailable", `${input.method} is not an admitted deterministic method.`);
    if (!this.engine.configured(input.method)) throw new HttpError(503, "result_engine_unavailable", `The calculation engine for ${input.method} is not deployed in this environment.`);
    if (!producer.sessionId || !producer.callId) throw new HttpError(409, "result_calculation_unavailable", "The calculation was not requested from an observed conversation turn, so its result cannot be bound to one.");
    const inputPath = normalizeResultPath(input.inputPath);
    const file = await openScopedFileNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, inputPath));
    let bytes;
    try {
      if (file.stat.size > 8 * 1024 * 1024) throw new HttpError(413, "result_input_limit", "The calculation input exceeds its limit.");
      bytes = await readStableFileHandle(file.handle, file.stat);
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { await file.handle.close(); }
    const parameters = input.parameters ?? {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length > 8
      || Object.entries(parameters).some(([key, value]) => !["yates", "correctZeroCells", "maxNodes", "seed", "cpuSecondsLimit"].includes(key)
        || !(typeof value === "boolean" || Number.isSafeInteger(value)))) throw new HttpError(400, "result_recipe_invalid", "Unsupported calculation parameters.");
    const inputVersion = await this.results.captureFile({ userId, project, relativePath: inputPath, expectedDigest: hash(bytes),
      producer: { ...producer, kind: "tool", eventId: `input:${producer.callId}` } });
    const id = `replay_${hash(JSON.stringify([project.userId, project.id, producer.sessionId, producer.callId]))}`;
    const existing = await this.documents.get(project.userId, "result-replay", id);
    if (existing) {
      if (existing.payload.initial?.inputVersionId !== inputVersion.versionId || existing.payload.initial.recipe.method !== input.method
        || replayDigest(existing.payload.initial.recipe.parameters) !== replayDigest(parameters)) throw new HttpError(409, "result_replay_conflict", "This call already owns another calculation.");
      return this.status(userId, project.id, id);
    }
    const capabilities = await this.engine.capabilities({ userId: project.userId, projectId: project.id, jobId: id,
      recipeDigest: "0".repeat(64), method: input.method });
    const capability = capabilities.methods?.find(item => item.method === input.method && item.available !== false);
    if (!capability || !isResultDigest(capability.codeDigest) || !isResultDigest(capability.environmentDigest)) throw new HttpError(503, "result_engine_unavailable", `The calculation engine for ${input.method} did not report the code and environment identity a result must be recorded with, so it cannot run here.`);
    const recipe = { method: input.method, version: capability.version, input: { path: inputPath, sha256: inputVersion.digest },
      parameters, codeDigest: capability.codeDigest, environmentDigest: capability.environmentDigest };
    await revalidate();
    const operation = async client => {
      const job = await this.jobs.enqueue(project.userId, "result-replay", { replayId: id, requestedBy: userId },
        { idempotencyKey: id, projectId: project.id, maxAttempts: 3, transactionClient: client });
      await this.documents.put(project.userId, "result-replay", id, { recordType: "result-replay", id, projectId: project.id,
        versionId: null, requestedBy: userId, jobId: job.id, state: "queued", initial: { recipe, inputVersionId: inputVersion.versionId,
          producer, capability }, createdAt: new Date().toISOString() }, { projectId: project.id, expectedRevision: 0, transactionClient: client });
    };
    if (this.documents.database) { await migrateProductStore(this.documents.database); await this.documents.database.transaction(operation); }
    else await operation(null);
    return this.status(userId, project.id, id);
  }

  async owned(userId, projectId, id) {
    const project = await this.results.scope(userId, projectId);
    const row = await this.documents.get(project.userId, "result-replay", id);
    if (!row || row.projectId !== project.id || row.payload.recordType !== "result-replay") throw new HttpError(404, "result_replay_unavailable", "The calculation is unavailable.");
    if (row.payload.versionId) await this.results.get(userId, project.id, row.payload.versionId);
    return { project, row };
  }

  async status(userId, projectId, id) {
    const { project, row } = await this.owned(userId, projectId, id);
    const job = await this.jobs.get(project.userId, row.payload.jobId);
    return { id, projectId, versionId: row.payload.versionId, state: row.payload.cleanup === "unknown" ? "ownership_unknown" : job?.status ?? row.payload.state,
      outputVersionId: row.payload.outputVersionId ?? null, comparison: row.payload.comparison ?? null, environment: row.payload.environment ?? null,
      resultVersionId: row.payload.outputVersionId ?? null, artifacts: row.payload.artifacts ?? [],
      partial: row.payload.partial === true,
      error: row.payload.stopError ? { code: row.payload.stopError } : job?.error ? { code: job.error.code } : null, cleanup: row.payload.cleanup ?? null };
  }

  async cancel(userId, projectId, id) {
    const { project, row } = await this.owned(userId, projectId, id);
    if (row.payload.requestedBy !== userId && project.userId !== userId) throw new HttpError(403, "result_replay_forbidden", "This calculation belongs to another researcher.");
    await this.projectTransaction(project.userId, projectId, client => this.cancelLocked(project.userId, row.payload.jobId, id, client));
    return this.status(userId, projectId, id);
  }

  async cancelLocked(ownerId, jobId, replayId, client) {
    const job = client ? (await client.query("SELECT * FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND kind='result-replay' FOR UPDATE", [ownerId, jobId])).rows[0]
      : await this.jobs.get(ownerId, jobId);
    if (!job) return;
    const current = await this.documents.get(ownerId, "result-replay", replayId);
    if (!current || current.payload.jobId !== jobId) throw new HttpError(409, "result_replay_scope_invalid", "The calculation scope changed.");
    const active = ["queued", "running"].includes(job.status);
    if (!active && (!current.payload.execution || current.payload.cleanup === "confirmed")) return;
    const answer = await this.stopExecution(current.payload.execution);
    if (answer?.resultPath) {
      try {
        const prepared = await this.preparedForRecord(current);
        if (prepared) await this.preservePartialOwned({ userId: ownerId, projectId: current.projectId, id: jobId,
          payload: { requestedBy: current.payload.requestedBy, replayId } }, prepared, answer, client);
      } catch { /* Stopping a process never requires renewed permission to its scientific output. */ }
    }
    if (client && active) await client.query("UPDATE evimed_product.jobs SET status='canceled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND id=$2", [ownerId, jobId]);
    else if (active) await this.jobs.cancel(ownerId, jobId);
    const latest = await this.documents.get(ownerId, "result-replay", current.id);
    await this.documents.put(ownerId, "result-replay", current.id, { ...latest.payload, state: active ? "canceled" : job.status, cleanup: "confirmed", stopError: null },
      { projectId: current.projectId, expectedRevision: latest.revision, transactionClient: client });
  }

  async preparedForRecord(row) {
    const project = await this.results.scope(row.payload.requestedBy, row.projectId);
    const original = row.payload.versionId ? await this.results.get(row.payload.requestedBy, project.id, row.payload.versionId) : null;
    const frozen = row.payload.initial ?? (original ? await this.recipe(row.payload.requestedBy, original) : null);
    // What the job ran on, not what the original recorded: the engine's own
    // receipt names the former.
    const used = row.payload.environment?.current;
    return frozen ? { project, row, original, frozen, execution: row.payload.execution, environment: row.payload.environment ?? null,
      recipe: { ...frozen.recipe, ...(used ? { codeDigest: used.codeDigest, environmentDigest: used.environmentDigest } : {}),
        input: { ...frozen.recipe.input, path: `result-replays/${row.payload.jobId}/input.json` } } } : null;
  }

  /** Called before project/account rows or files disappear, on the deletion's
   * owned transaction. Unknown process ownership blocks destructive removal. */
  async cancelProject(ownerId, projectId, client) {
    await client.query(`SELECT id FROM ${CONTROL_PLANE_SCHEMA}.projects WHERE user_id=$1 AND ($2::text IS NULL OR id=$2) FOR UPDATE`, [ownerId, projectId]);
    const database = this.jobs.database ?? this.documents.database;
    await database.withTransactionClient(client, async () => {
      const rows = (await client.query(`SELECT j.id,j.payload FROM evimed_product.jobs j JOIN evimed_product.documents d ON d.payload->>'jobId'=j.id
        WHERE j.user_id=$1 AND j.kind='result-replay' AND d.user_id=j.user_id AND d.kind='result-replay' AND d.deleted_at IS NULL
        AND ($2::text IS NULL OR j.project_id=$2) AND (j.status IN ('queued','running') OR (d.payload->'execution' IS NOT NULL
          AND d.payload->'execution'<>'null'::jsonb AND COALESCE(d.payload->>'cleanup','pending')<>'confirmed')) ORDER BY j.id FOR UPDATE OF j`, [ownerId, projectId])).rows;
      for (const job of rows) await this.cancelLocked(ownerId, job.id, job.payload.replayId, client);
    });
  }

  async prepare(job) {
    return this.withProjectLease(job, () => this.prepareOwned(job));
  }

  async prepareOwned(job) {
    const { project, row } = await this.owned(job.payload.requestedBy, job.projectId, job.payload.replayId);
    if (project.userId !== job.userId || row.payload.jobId !== job.id) throw new HttpError(409, "result_replay_scope_invalid", "The calculation scope changed.");
    const original = row.payload.versionId ? await this.results.get(job.payload.requestedBy, project.id, row.payload.versionId) : null;
    const frozen = row.payload.initial ?? (original ? await this.recipe(job.payload.requestedBy, original) : null);
    if (!frozen) throw new HttpError(409, "result_recipe_unavailable", "This result has no recorded calculation recipe (its method, input and parameters), so there is nothing to recalculate it from.");
    const input = await this.results.raw(job.payload.requestedBy, project.id, frozen.inputVersionId);
    if (input.version.digest !== frozen.recipe.input.sha256) throw new HttpError(409, "result_input_changed", "The input saved with the recipe no longer matches its recorded digest, so the recipe cannot be replayed on it.");
    const relativePath = `result-replays/${job.id}/input.json`;
    const full = resolveScopedPath(project.workspaceDir, relativePath);
    await withProjectStorageMutation(project, async () => {
      await assertProjectCapacity(project, full, input.bytes.length, this.config);
      try { await writeFileExclusiveNoFollow(project.workspaceDir, full, input.bytes); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const file = await openScopedFileNoFollow(project.workspaceDir, full);
        try { if (file.stat.size !== input.bytes.length || hash(await readStableFileHandle(file.handle, file.stat)) !== input.version.digest) throw new HttpError(409, "result_input_changed", "The frozen input changed."); }
        finally { await file.handle.close(); }
      }
    });
    const recorded = { ...frozen.recipe, input: { path: relativePath, sha256: input.version.digest } };
    const probe = { userId: project.userId, projectId: project.id, jobId: job.id, recipeDigest: replayDigest(recorded), method: recorded.method };
    const capabilities = await this.engine.capabilities(probe);
    const available = capabilities.methods?.find(item => item.method === recorded.method && item.available !== false);
    // An engine that is not there, or that does not say what it is, cannot run
    // anything. One that is there but is not the engine the original ran on can:
    // it runs, and the record says so (`replayEnvironment`).
    if (!available || !isResultDigest(available.codeDigest) || !isResultDigest(available.environmentDigest)) {
      throw new HttpError(503, "result_engine_unavailable", `The calculation engine does not offer ${recorded.method} here (it is not deployed, or it did not report its code and environment identity), so this result cannot be recalculated.`);
    }
    // A job that has started keeps the identity it started under: after a
    // restart it joins that engine job, even if the engine has been replaced.
    const current = row.payload.execution && row.payload.environment?.current ? row.payload.environment.current
      : { codeDigest: available.codeDigest, environmentDigest: available.environmentDigest };
    const recipe = { ...recorded, codeDigest: current.codeDigest, environmentDigest: current.environmentDigest };
    const execution = { userId: project.userId, projectId: project.id, jobId: job.id, recipeDigest: replayDigest(recipe), method: recipe.method };
    if (row.payload.execution && replayDigest(row.payload.execution) !== replayDigest(execution)) throw new HttpError(409, "result_replay_scope_invalid", "The calculation identity changed.");
    const environment = replayEnvironment({ codeDigest: frozen.recipe.codeDigest, environmentDigest: frozen.recipe.environmentDigest }, current);
    return { project, row, original, frozen, recipe, execution, environment };
  }

  /** Serialize admission with cancellation and commit the stable execution
   * identity even if the engine's response is lost after it accepted work. */
  async start(job, prepared, options = {}) {
    const outcome = await this.withProjectLease(job, async client => {
      const current = await this.documents.get(job.userId, "result-replay", job.payload.replayId);
      if (!current || current.payload.jobId !== job.id) throw new HttpError(409, "result_replay_scope_invalid", "The calculation scope changed.");
      if (current.payload.execution && replayDigest(current.payload.execution) !== replayDigest(prepared.execution)) throw new HttpError(409, "result_replay_scope_invalid", "The calculation identity changed.");
      if (!current.payload.execution) await this.documents.put(job.userId, "result-replay", current.id,
        { ...current.payload, execution: prepared.execution, environment: prepared.environment, cleanup: "pending", state: "running" },
        { projectId: job.projectId, expectedRevision: current.revision, transactionClient: client });
      if (!await this.jobs.renew(job.userId, job.id, job.leaseToken, 60000)) throw new HttpError(409, "product_job_lease_lost", "The worker no longer owns this calculation.");
      try { return { answer: await this.engine.start(prepared.execution, prepared.recipe, options) }; }
      catch (error) { return { error }; }
    });
    if (outcome.error) throw outcome.error;
    return outcome.answer;
  }

  async complete(job, prepared, answer) {
    return this.withProjectLease(job, () => this.completeOwned(job, prepared, answer));
  }

  async completeOwned(job, prepared, answer) {
    if (answer.state !== "succeeded") throw new HttpError(409, "result_replay_receipt_invalid", `The engine's answer is "${answer.state}", not a finished calculation, so no result was saved from it.`);
    const output = await this.captureOutputOwned(job, prepared, answer);
    // The numbers are compared on whatever the replay ran on, and the
    // comparison says whether that was what the original ran on.
    const comparison = prepared.original ? { bytes: output.digest === prepared.original.digest ? "identical" : "changed",
      numbers: compareResultNumbers(prepared.frozen.machineValues, answer.machineValues), environment: prepared.environment ?? null,
      scientificApplicability: "not_assessed" } : null;
    await this.admit(job.payload.requestedBy, { projectId: job.projectId, versionId: output.versionId,
      inputVersionId: prepared.frozen.inputVersionId, recipe: prepared.recipe, machineValues: answer.machineValues,
      receipt: { recipeDigest: prepared.execution.recipeDigest, outputDigest: output.digest } });
    const current = await this.documents.get(job.userId, "result-replay", prepared.row.id);
    await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { outputVersionId: output.versionId, comparison }, async client => {
      await this.documents.put(job.userId, "result-replay", current.id, { ...current.payload, state: "succeeded", cleanup: "confirmed", partial: false,
        outputVersionId: output.versionId, comparison, artifacts: answer.artifacts.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })) },
      { projectId: job.projectId, expectedRevision: current.revision, transactionClient: client });
    });
    return output;
  }

  async readOutput(project, artifact, limit) {
    if (!artifact || !isResultDigest(artifact.sha256)) throw new HttpError(409, "result_replay_receipt_invalid", "The engine returned a calculation output without the sha256 of its bytes, so the output cannot be checked against a record and was not saved.");
    const file = await openScopedFileNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, artifact.path));
    try {
      if (file.stat.size > limit) throw new HttpError(413, "result_replay_response_limit", "The calculation output exceeds its limit.");
      const bytes = await readStableFileHandle(file.handle, file.stat);
      if (hash(bytes) !== artifact.sha256 || artifact.bytes !== undefined && artifact.bytes !== bytes.length) {
        throw new HttpError(409, "result_replay_receipt_invalid", "The calculation output's size or sha256 does not match the byte record the engine returned for it, so it was not saved as a result.");
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { await file.handle.close(); }
  }

  /** Partial output stays visible without admitting a reproducible baseline or
   * treating an interrupted calculation as a complete scientific result. */
  async preservePartialOwned(job, prepared, answer, client) {
    if (!answer.resultPath || !answer.artifacts?.length) return;
    let output;
    let error;
    try { output = await this.captureOutputOwned(job, prepared, answer); }
    catch (failure) { error = failure.code ?? "result_replay_receipt_invalid"; }
    const row = await this.documents.get(job.userId, "result-replay", job.payload.replayId);
    await this.documents.put(job.userId, "result-replay", row.id, { ...row.payload, ...(output ? {
      outputVersionId: output.versionId, partial: true, artifacts: answer.artifacts.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
    } : {}), ...(error ? { partialCaptureError: error } : {}) },
    { projectId: job.projectId, expectedRevision: row.revision, transactionClient: client });
  }

  async captureOutputOwned(job, prepared, answer) {
    if (answer.jobId !== job.id || answer.recipeDigest !== prepared.execution.recipeDigest
      || !["succeeded", "failed", "canceled", "timed_out"].includes(answer.state) || answer.cleanup !== "confirmed") {
      throw new HttpError(409, "result_replay_receipt_invalid", "The engine's answer does not carry this calculation's job and recipe identity, or does not say its process has stopped, so it cannot be taken as this calculation's result.");
    }
    compareResultNumbers(answer.machineValues, answer.machineValues);
    const outputPath = normalizeResultPath(answer.resultPath);
    if (!outputPath.startsWith(`result-replays/${job.id}/output/`)) throw new HttpError(409, "result_replay_receipt_invalid", "The engine named a result file outside this calculation's own output directory, so it was not read.");
    const artifact = answer.artifacts?.find(file => file.path === outputPath);
    if (!artifact || !isResultDigest(artifact.sha256)) throw new HttpError(409, "result_replay_receipt_invalid", "The engine's byte record does not list the result file with its sha256, so the result cannot be checked and was not saved.");
    const payload = await this.readOutput(prepared.project, artifact, 8 * 1024 * 1024);
    if (["design.analytic", "comparator.evalue"].includes(prepared.recipe.method)) {
      const receiptPath = `result-replays/${job.id}/output/receipt.json`;
      const receiptArtifact = answer.artifacts.find(item => item.path === receiptPath);
      const receipt = await this.readOutput(prepared.project, receiptArtifact, 1024 * 1024);
      const recorded = receipt.artifacts?.find(item => item.path === outputPath);
      const numeric = values => values.map(item => ({ key: item.key, value: item.value, ...(item.unit === undefined ? {} : { unit: item.unit }) }));
      const measures = (Array.isArray(payload.measures) ? payload.measures : []).filter(item => Number.isFinite(item.value))
        .map(item => ({ key: item.name, value: item.value, ...(typeof item.unit === "string" ? { unit: item.unit } : {}) }));
      if (receipt.jobId !== job.id || receipt.recipeDigest !== prepared.execution.recipeDigest || receipt.method !== prepared.recipe.method
        || receipt.codeDigest !== prepared.recipe.codeDigest || receipt.environmentDigest !== prepared.recipe.environmentDigest
        || recorded?.sha256 !== artifact.sha256 || payload.method !== prepared.recipe.method
        || replayDigest(receipt.machineValues) !== replayDigest(answer.machineValues)
        || replayDigest(measures) !== replayDigest(numeric(answer.machineValues))) {
        throw new HttpError(409, "result_replay_receipt_invalid", "The numbers the engine reported do not match the result file and receipt it saved (the output, the receipt or the measures differ), so none of it was saved as a result.");
      }
    } else if (payload.receipt?.recipeDigest !== prepared.execution.recipeDigest || replayDigest(payload.machineValues) !== replayDigest(answer.machineValues)) {
      throw new HttpError(409, "result_replay_receipt_invalid", "The numbers the engine reported do not match the result file it saved, so none of it was saved as a result.");
    }
    return this.results.captureFile({ userId: job.payload.requestedBy, project: prepared.project, relativePath: outputPath,
      expectedDigest: artifact.sha256, producer: { ...(prepared.frozen.producer ?? prepared.original?.producer), kind: "engine", callId: job.id, eventId: job.id },
      inputs: [{ kind: "data", id: prepared.frozen.inputVersionId, versionId: prepared.frozen.inputVersionId,
        digest: prepared.recipe.input.sha256, availability: "captured" }],
      // What actually ran: the original's own references while the engine is the
      // one it recorded, this engine's when it is not.
      code: !prepared.environment?.changed.includes("code") && prepared.original?.code
        ? prepared.original.code : { kind: "code", id: prepared.recipe.method, digest: prepared.recipe.codeDigest, availability: "reference" },
      environment: !prepared.environment?.changed.includes("environment") && prepared.original?.environment
        ? prepared.original.environment : { kind: "code", id: "engine-environment", digest: prepared.recipe.environmentDigest, availability: "reference" },
      machineValues: answer.machineValues, supersedesVersionId: prepared.original?.versionId,
      findings: [...(answer.state === "succeeded" ? [] : [{ id: "partial-calculation", kind: "execution", status: "partial",
        message: "计算在完成之前停止了，保存下来的数值只是部分输出。" }]),
      ...(prepared.environment?.status === "differs" ? [environmentFinding(prepared.environment)] : [])] });
  }
}
