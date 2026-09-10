import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { mountedMethodDigest, parseSkillFrontmatter, skillBodyDigest } from "@evimed/domain";
import { MAX_MOUNTED_CAPSULE_METHODS, MAX_MOUNTED_CAPSULE_METHOD_BYTES, selectCapsuleMethods } from "./capsuleMethods.mjs";
import { MAX_MOUNTED_LEARNED_METHODS, selectLearnedMethods } from "./learnedMethodMount.mjs";
import { startLearningEvaluationBridge } from "./learningEvaluationBridge.mjs";
import { runLearningEvaluationProcess } from "./learningEvaluationProcess.mjs";
import { HttpError, assertProjectCapacity, resolveScopedPath, writeFileAtomicNoFollow } from "./security.mjs";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Freeze the original owner's method payloads before any evaluation runs.
 * @param {{learning: any, capsules: any, project: any, request: any}} input
 */
export async function freezeLearningEvaluation({ learning, capsules, project, request }) {
  const candidate = structuredClone(await learning.getMethod(request.userId, request.methodId));
  if (candidate.payload?.status !== "candidate" || candidate.payload.contentDigest !== request.candidateDigest
    || (candidate.projectId != null && candidate.projectId !== project.id)) {
    throw new HttpError(409, "method_evaluation_stale", "The candidate no longer matches the requested owner, project and revision.");
  }
  const approved = structuredClone([
    ...await learning.approvedMethods(request.userId, { projectId: project.id }),
    ...await learning.approvedMethods(request.userId, { projectId: null }),
  ]);
  const frozenLearning = {
    getMethod: async (_userId, id) => id === candidate.id ? candidate : null,
    approvedMethods: async (_userId, { projectId }) => approved.filter((document) => document.projectId === projectId),
  };
  const capsuleMethods = capsules ? structuredClone(await selectCapsuleMethods(capsules, { userId: request.userId, projectId: project.id })) : [];
  const capsuleBytes = capsuleMethods.reduce((sum, method) => sum + method.bytes, 0);
  const baseline = await selectLearnedMethods(frozenLearning, { userId: request.userId, projectId: project.id,
    maxCount: Math.min(MAX_MOUNTED_LEARNED_METHODS, MAX_MOUNTED_CAPSULE_METHODS - capsuleMethods.length),
    maxBytes: MAX_MOUNTED_CAPSULE_METHOD_BYTES - capsuleBytes });
  const candidateMethods = await selectLearnedMethods(frozenLearning, {
    userId: request.userId, projectId: project.id, trialMethodIds: [candidate.id],
    maxCount: Math.min(MAX_MOUNTED_LEARNED_METHODS, MAX_MOUNTED_CAPSULE_METHODS - capsuleMethods.length),
    maxBytes: MAX_MOUNTED_CAPSULE_METHOD_BYTES - capsuleBytes,
  });
  if (!candidateMethods.some((method) => method.id === candidate.id)
    || capsuleBytes + candidateMethods.reduce((sum, method) => sum + method.bytes, 0) > MAX_MOUNTED_CAPSULE_METHOD_BYTES) {
    throw new HttpError(413, "method_evaluation_mount_limit", "The frozen candidate does not fit the method context budget.");
  }
  const records = (methods) => approved.filter((document) => methods.some((method) => method.id === document.id));
  const arms = {
    baseline: { capsuleMethods, learnedMethods: baseline, documents: records(baseline) },
    candidate: { capsuleMethods, learnedMethods: candidateMethods, documents: [...records(candidateMethods), candidate] },
  };
  const receipt = (arm) => [...arm.capsuleMethods, ...arm.learnedMethods].map((method) => ({
    name: String(parseSkillFrontmatter(method.document).frontmatter?.name ?? ""),
    digest: skillBodyDigest(method.document, sha256),
  }));
  const baselineDigest = `sha256:${sha256(JSON.stringify({ capsuleMethods, learnedMethods: baseline }))}`;
  return {
    arms,
    grant: {
      userId: request.userId, projectId: project.id, methodId: candidate.id,
      candidateDigest: candidate.payload.contentDigest, mountedDigest: mountedMethodDigest(candidate.payload, sha256),
      snapshotDigest: `sha256:${sha256(JSON.stringify({ userId: request.userId, projectId: project.id, baselineDigest,
        candidateDigest: candidate.payload.contentDigest, candidate: arms.candidate.learnedMethods }))}`, baselineDigest,
      expectedMethods: { baseline: receipt(arms.baseline), candidate: receipt(arms.candidate) },
      bootstrap: request.bootstrap === true,
    },
  };
}

/** The private API uses the existing bounded capability dispatcher and accounting.
 * @param {{config:any,store:any,learning:any,capsules:any,runtimeManager:any,agentRuns:any,
 * learningRuntime:any,commands:any,usageLedger:any,judge?: (cell:any,input:any)=>Promise<any>}} dependencies
 * @param {any} request
 * @param {{signal?: AbortSignal, runProcess?: typeof runLearningEvaluationProcess}} [options]
 */
export async function evaluateLearnedMethod(dependencies, request, options = {}) {
  const { config, store, learning, capsules, runtimeManager, agentRuns, learningRuntime, commands, usageLedger } = dependencies;
  const user = await store.userById(request.userId);
  if (!user) throw new HttpError(404, "learning_account_unavailable", "The evaluation owner is unavailable.");
  const source = await store.requireProject(user, request.projectId);
  const frozen = await freezeLearningEvaluation({ learning, capsules, project: source, request });
  const timeoutMs = 6 * 60 * 60_000;
  const created = new Map();
  const cleaning = new Map();
  const cleanupCell = (cell) => {
    if (cleaning.has(cell.projectId)) return cleaning.get(cell.projectId);
    const operation = (async () => {
    // Only identities minted in this closure can be deleted, including on an
    // interrupted dispatch. The original project is never placed in this map.
    if (created.get(cell.projectId) !== cell) return;
    await runtimeManager.stop(cell.project);
    await agentRuns.cancelSession(cell.scoped ?? cell.project, cell.sessionId).catch(() => {});
    await agentRuns.monitors?.get(cell.runId)?.promise;
    runtimeManager.evaluationMethodSnapshots.delete(runtimeManager.key(cell.project));
    await store.deleteProject(user, cell.projectId, { beforeDelete: async (client) => {
      if (!client) throw new HttpError(503, "learning_usage_unavailable", "Durable evaluation cleanup requires the product database.");
      // The usage table cascades on project deletion. Preserve every settled or
      // uncertain reservation under the original project in the same delete
      // transaction, or cleanup would replenish the account's spending budget.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-usage:${user.id}`]);
      const owned = await client.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=ANY($2::text[]) FOR KEY SHARE", [user.id, [cell.projectId, source.id]]);
      if (owned.rowCount !== 2) throw new HttpError(409, "evaluation_cleanup_source_unavailable", "The original evaluation billing project is unavailable.");
      await client.query("UPDATE evimed_usage.model_requests SET project_id=$3 WHERE user_id=$1 AND project_id=$2", [user.id, cell.projectId, source.id]);
    } });
    created.delete(cell.projectId);
    })().finally(() => cleaning.delete(cell.projectId));
    cleaning.set(cell.projectId, operation);
    return operation;
  };
  const bridge = await startLearningEvaluationBridge({
    grant: frozen.grant, ttlMs: timeoutMs, maxCells: request.bootstrap ? 12 : 600,
    createCell: async (input) => {
      const projectId = `methodeval-${randomBytes(12).toString("hex")}`;
      await store.createProject(user, projectId, "Private method evaluation");
      const project = await store.requireProject(user, projectId);
      const dispatchId = `methodeval_${randomBytes(12).toString("hex")}`;
      const scoped = project;
      const cell = { projectId, project, scoped, dispatchId, runId: "", sessionId: "", arm: input.arm, judgeCalls: 0 };
      created.set(projectId, cell);
      runtimeManager.evaluationMethodSnapshots.set(runtimeManager.key(project), structuredClone(frozen.arms[input.arm]));
      try {
        if (!Array.isArray(input.fixtures) || input.fixtures.length > 50) throw new HttpError(400, "evaluation_fixtures_invalid", "Invalid evaluation fixtures.");
        for (const fixture of input.fixtures) {
          if (typeof fixture?.path !== "string" || typeof fixture?.data !== "string") throw new HttpError(400, "evaluation_fixtures_invalid", "Invalid evaluation fixture.");
          const target = resolveScopedPath(scoped.workspaceDir, fixture.path);
          const bytes = Buffer.from(fixture.data, "base64");
          await assertProjectCapacity(project, target, bytes.length, config);
          await writeFileAtomicNoFollow(project.baseDir, target, bytes, { mode: 0o600 });
        }
        input.signal.throwIfAborted();
        const identity = await learningRuntime.dispatch({
          userId: user.id, projectId, dispatchId, capabilityId: input.capabilityId,
          isolatedProject: true,
          question: input.text, input: { schemaVersion: 1, evaluation: true },
          job: { userId: user.id, projectId, payload: {} },
        });
        Object.assign(cell, identity);
        input.signal.throwIfAborted();
        return cell;
      } catch (error) { await cleanupCell(cell); throw error; }
    },
    readCell: async (cell) => {
      let run = (await agentRuns.list(cell.scoped)).find((record) => record.id === cell.runId);
      if (run?.status !== "running") {
        // The terminal ledger row precedes transcript/observation persistence.
        // Await its monitor before the evaluator reads the final receipts.
        await agentRuns.monitors?.get(cell.runId)?.promise;
        run = (await agentRuns.list(cell.scoped)).find((record) => record.id === cell.runId);
      }
      return run;
    },
    readArtifact: (cell, artifactPath) => commands.invoke("read_artifact", { path: artifactPath }, { config, project: cell.scoped }),
    readTranscript: (cell) => runtimeManager.sessionTranscript(cell.scoped, cell.sessionId, { wake: false }),
    readUsage: async (cell) => {
      const summary = await usageLedger.summaryRun(user.id, cell.dispatchId);
      const complete = summary.settledCalls > 0 && !summary.reservedCalls && !summary.uncertain && !summary.incompleteUsageCalls;
      return { cost: complete ? summary.actualCost : null, calls: summary.settledCalls, currency: summary.currency, openCost: summary.openCost };
    },
    cleanupCell,
    ...(dependencies.judge ? { judge: dependencies.judge } : {}),
  });
  const cleanupAll = async () => {
    const results = await Promise.allSettled([bridge.close()]);
    results.push(...await Promise.allSettled([...created.values()].map(cleanupCell)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Private evaluation cleanup failed.");
  };
  try {
    const report = /** @type {any} */ (await (options.runProcess ?? runLearningEvaluationProcess)(config.learningEvaluationCommand,
      { ...request, baselineDigest: frozen.grant.baselineDigest }, {
        signal: options.signal, timeoutMs,
        env: { OPEN_SCIENCE_EVAL_BASE_URL: bridge.url, OPEN_SCIENCE_EVAL_JOB_TOKEN: bridge.token,
          OPEN_SCIENCE_EVAL_OUTPUT_ROOT: path.join(source.metaDir ?? source.rootDir, "learning-evaluations") },
      }));
    if (["userId", "projectId", "methodId", "candidateDigest", "mountedDigest", "snapshotDigest"].some((field) => report.evaluationScope?.[field] !== frozen.grant[field])
      || report.candidateDigest !== request.candidateDigest || report.baselineDigest !== frozen.grant.baselineDigest) {
      throw new HttpError(409, "method_evaluation_stale", "The evaluator returned a verdict outside this frozen job grant.");
    }
    if (report.verdict === "invalid") {
      throw new HttpError(502, "method_evaluation_failed", "The paired evaluation did not complete its declared frozen cells.");
    }
    return report;
  } finally {
    await cleanupAll();
  }
}
