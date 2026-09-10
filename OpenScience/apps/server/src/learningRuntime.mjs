import { createHash } from "node:crypto";
import path from "node:path";

import { validateDeliveryReceipt, workspaceLayout } from "@evimed/domain";
import { issueModelGatewayBudgetMarker } from "./modelGateway.mjs";
import {
  HttpError,
  assertProjectCapacity,
  normalizeWorkspaceRelativePath,
  openScopedFileNoFollow,
  resolveScopedPath,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
} from "./security.mjs";

/**
 * The bounded-run adapter the learning loop's two internal capabilities share.
 *
 * Hidden knowledge: every model step in the learning loop runs as an ordinary
 * capability run inside the project's own container, and this is the module
 * that makes that possible without the loop growing its own copy of the launch
 * path. It is `sourceUnderstandingRuntime` with the source removed — the same
 * admission, reservation, dispatch, receipt-checked artifact read and usage
 * settlement, keyed on the run ledger's own `dispatchId` instead of on a
 * source binding.
 *
 * Why not call a provider directly from the worker, which would have been forty
 * lines instead of two hundred and fifty: a run gets metering, the path guard,
 * the sandbox, the model gateway's certification of which model actually
 * answered, and a settled usage receipt. A direct call gets none of those, and
 * the first symptom is a bill with no runs attached to it. The second is a
 * learning loop that can read files the runs it learns from could not.
 *
 * The idempotency story is deliberately simpler than the source one. A source
 * dispatch has to survive a crash between the ledger append and the source
 * binding, so it carries a protected launch intent. A learning job has no
 * second record to keep in step: the ledger's `dispatchId` is the whole
 * binding, so an existing dispatch is adopted and a duplicate is never sent.
 *
 * @module learningRuntime
 */

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 400_000;

/** Where a learning run's own workspace lives, inside the project but outside
 *  every directory a researcher's own runs read or write. */
export const LEARNING_DIR = ".evimed-learning";

/**
 * The file each learning capability reads its frozen input from.
 *
 * Named per capability rather than shared: a SKILL.md says "read
 * distillation-input.json" in the sentence that tells the run what it is doing,
 * and a generic filename there would make the instruction one step vaguer for
 * no gain. The default is only a fallback for a capability that names none.
 */
export const LEARNING_INPUT_FILES = Object.freeze({
  "method-distillation": "distillation-input.json",
  "method-relations": "method-relations-input.json",
});

/** @param {string} capabilityId @returns {string} */
export function learningInputFile(capabilityId) {
  return LEARNING_INPUT_FILES[/** @type {keyof typeof LEARNING_INPUT_FILES} */ (capabilityId)] ?? "learning-input.json";
}

/** @param {Record<string, any>} config @returns {{dailyLimit: number, weeklyLimit: number, runLimit: number}} */
export function learningBudget(config) {
  const configured = [config.learningRunLimitCny, config.learningDailyLimitCny, config.learningWeeklyLimitCny];
  if (configured.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    || [config.userDailySpendLimit, config.userWeeklySpendLimit].some((value) =>
      typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new HttpError(503, "learning_budget_invalid", "The learning loop requires finite positive CNY spending ceilings.");
  }
  const minimum = (/** @type {number[]} */ ...values) => Math.min(...values.filter((value) => value > 0));
  const dailyLimit = minimum(configured[1], config.userDailySpendLimit);
  const weeklyLimit = minimum(configured[2], config.userWeeklySpendLimit);
  return { dailyLimit, weeklyLimit, runLimit: minimum(configured[0], dailyLimit, weeklyLimit) };
}

/**
 * The directory one learning run owns.
 *
 * Derived from the dispatch id rather than chosen, so a re-dispatch of the same
 * logical step lands in the same place and a different step never can.
 * @param {string} capabilityId @param {string} dispatchId @returns {string}
 */
export function learningArtifactDirectory(capabilityId, dispatchId) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(capabilityId ?? ""))) {
    throw new HttpError(400, "learning_capability_invalid", "The learning capability id is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(dispatchId ?? ""))) {
    throw new HttpError(400, "learning_dispatch_invalid", "The learning dispatch id is invalid.");
  }
  return `${LEARNING_DIR}/${capabilityId}/${dispatchId}`;
}

/** @param {any} project @param {string} directory @returns {any} */
export function learningRunProject(project, directory) {
  const relative = String(directory ?? "");
  if (!new RegExp(`^${LEARNING_DIR}/[a-z][a-z0-9-]{0,63}/[A-Za-z0-9_-]{1,128}$`).test(relative)) {
    throw new HttpError(409, "learning_run_scope_unavailable", "The learning run has no valid owned artifact directory.");
  }
  return { ...project, activeWorkspace: project.activeWorkspace ?? "", workspaceDir: resolveScopedPath(project.baseDir, relative) };
}

/**
 * A bounded read that cannot grow past its limit after the initial stat.
 * @param {any} project @param {string} relative @param {number} limit
 */
async function readOwnedFile(project, relative, limit) {
  const normalized = normalizeWorkspaceRelativePath(relative, "learning artifact");
  const opened = await openScopedFileNoFollow(project.baseDir, resolveScopedPath(project.workspaceDir, normalized));
  try {
    if (!opened.stat.isFile() || opened.stat.size <= 0 || opened.stat.size > limit) {
      throw new HttpError(413, "learning_artifact_too_large", "The learning artifact exceeds its bounded read limit.");
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new HttpError(413, "learning_artifact_too_large", "The learning artifact grew beyond its bounded read limit.");
    return { bytes: buffer.subarray(0, length) };
  } finally {
    await opened.handle.close();
  }
}

/**
 * @param {{config: any, store: any, agentRuns: any, runtimeManager: any, researchSessions: any,
 *          registry: any, usageLedger: any, prepareContext: (...args: any[]) => Promise<any>,
 *          cleanup?: (project: any, directory: string) => Promise<any>}} dependencies
 */
export function createLearningRuntime({
  config, store, agentRuns, runtimeManager, researchSessions, registry, usageLedger, prepareContext,
  cleanup = async () => {},
}) {
  /** @param {{userId: string, projectId: string}} identity */
  const resolveProject = async (identity) => {
    const user = await store.userById(identity.userId);
    if (!user) throw new HttpError(404, "learning_account_unavailable", "The learning account is unavailable.");
    return store.requireProject(user, identity.projectId);
  };
  /** @param {any} run @returns {{runId: string, sessionId: string, dispatchId: string}} */
  const identityOf = (run) => ({ runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId });

  return {
    /**
     * @param {{job: any, dispatchId: string, capabilityId: string, contractKind: string, input: any, question: string,
     *          userId: string, projectId: string, isolatedProject?: boolean}} request
     */
    async dispatch(request) {
      const { job, dispatchId, capabilityId, input, question } = request;
      const project = await resolveProject({ userId: request.userId ?? job.userId, projectId: request.projectId ?? job.projectId });
      const directory = learningArtifactDirectory(capabilityId, dispatchId);
      // A private evaluation allocates the entire project for one cell. Using
      // its root also preserves isolation through the runtime controller, whose
      // launch contract carries project identity rather than an arbitrary path.
      const scoped = request.isolatedProject === true ? project : learningRunProject(project, directory);

      // An existing dispatch is adopted, never repeated. A durable record of a
      // request that was already paid for is not permission to pay again.
      const ledger = await agentRuns.list(project);
      const existing = ledger.find((run) => run.dispatchId === dispatchId);
      if (existing) {
        await agentRuns.existingDispatch(scoped, existing);
        if (existing.status === "running") agentRuns.scheduleMonitor(scoped, existing.id);
        else if (runtimeManager.boundedRuntimeScope(scoped)?.runId === dispatchId) {
          await runtimeManager.endBoundedRuntime(scoped, dispatchId);
        }
        return identityOf(existing);
      }

      // The learning loop is never the reason a researcher's own run waits.
      if (ledger.some((run) => run.status === "running")) {
        throw new HttpError(409, "runtime_busy", "The project has an unfinished run; the learning job will wait.");
      }

      const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      if (bytes.length > MAX_INPUT_BYTES) {
        throw new HttpError(413, "learning_input_too_large", "The frozen learning input exceeds its read limit; no model request was sent.");
      }
      if (!usageLedger) throw new HttpError(503, "learning_usage_unavailable", "The learning loop requires gateway accounting.");
      const budget = learningBudget(config);
      await usageLedger.assertWithinLimits(job.userId, budget);
      const selected = (await registry).get(capabilityId);
      if (!selected) throw new HttpError(503, "learning_capability_unconfigured", `The ${capabilityId} capability is not installed.`);

      let reserved = false;
      try {
        const file = resolveScopedPath(scoped.workspaceDir, learningInputFile(capabilityId));
        await withProjectStorageMutation(project, async () => {
          await assertProjectCapacity(project, file, bytes.length, config);
          await writeFileAtomicNoFollow(project.baseDir, file, bytes, { mode: 0o600 });
        });
        const session = await runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, ...budget });
        reserved = true;
        await researchSessions.put(scoped, session.id, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
        const run = await agentRuns.dispatch(scoped, {
          sessionId: session.id,
          dispatchId,
          question,
          effectiveAgentId: selected.id,
          effectiveAgentVersion: selected.version,
          effectiveRuntimeAgent: selected.runtimeAgent,
          effectiveRouteReason: capabilityId,
        }, async (sessionBinding, dispatchedRun, repairText = null) => {
          let promptAttempted = false;
          try {
            // Only this run's owned directory is context. A learning run reads
            // the frozen input it was given and nothing else in the project —
            // it is reasoning about a conversation, not continuing one.
            const prepared = await prepareContext({ ...scoped, baseDir: scoped.workspaceDir }, sessionBinding, config, {
              query: question,
              memories: [],
              specialists: [],
              routedSpecialist: {
                agentId: selected.id,
                agentVersion: selected.version,
                runtimeAgent: selected.runtimeAgent,
                skill: selected.skill,
                companionSkills: selected.companionSkills,
              },
            });
            await usageLedger.assertWithinLimits(job.userId, budget);
            const marker = issueModelGatewayBudgetMarker({
              secret: config.modelGatewaySigningSecret,
              userId: job.userId, projectId: job.projectId, runId: dispatchId, ...budget,
            });
            promptAttempted = true;
            return await runtimeManager.dispatchPrompt(scoped, session.id, {
              text: `${marker}\n${repairText || question}`,
              system: prepared.system,
              agent: selected.runtimeAgent,
              strictContext: true,
              model: `deepseek/${config.deepseekModel}`,
              runId: dispatchedRun.id,
              allowBounded: true,
              requestId: dispatchedRun.kernelRequestIds?.at(-1),
            });
          } catch (error) {
            if (!promptAttempted) error.definitivelyRejected = true;
            throw error;
          }
        });
        return identityOf(run);
      } catch (error) {
        const recorded = (await agentRuns.list(project)).find((run) => run.dispatchId === dispatchId);
        if (recorded?.status === "running") return identityOf(recorded);
        if (reserved) await runtimeManager.endBoundedRuntime(scoped, dispatchId).catch(() => {});
        await cleanup(project, directory).catch(() => {});
        if (recorded) return identityOf(recorded);
        throw error;
      }
    },

    /**
     * @param {{userId: string, projectId: string, runId: string, sessionId: string, dispatchId: string,
     *          capabilityId?: string, contractKind?: string, outputs?: string[]}} identity
     */
    async readResult(identity) {
      const capabilityId = identity.capabilityId ?? identity.dispatchId.split("-").slice(0, -1).join("-");
      const base = await resolveProject(identity);
      const project = learningRunProject(base, learningArtifactDirectory(capabilityId, identity.dispatchId));
      const run = (await agentRuns.list(project)).find((item) => item.id === identity.runId
        && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run) return { status: "pending", reason: "learning_run_ledger_unavailable" };
      if (run.status === "running") {
        await agentRuns.existingDispatch(project, run);
        agentRuns.scheduleMonitor(project, run.id);
        return { status: "pending" };
      }
      if (run.status !== "succeeded") return { status: run.status };

      const receipt = await readOwnedFile(project, workspaceLayout.receiptFile, MAX_INPUT_BYTES);
      const checked = validateDeliveryReceipt(JSON.parse(receipt.bytes.toString("utf8")));
      if (!checked.ok) throw new HttpError(409, "learning_receipt_invalid", "The learning delivery receipt is invalid.");
      const entries = checked.receipt.entries.filter((entry) => entry.capability === capabilityId);
      if (entries.length !== 1) throw new HttpError(409, "learning_receipt_invalid", "One accepted learning package is required.");
      const entry = entries[0];
      const artifacts = new Set(run.artifacts ?? []);
      /** @type {Record<string, string>} */
      const output = {};
      for (const file of entry.files) {
        const relative = artifacts.has(file.path)
          ? file.path
          : `${workspaceLayout.deliverablesDir}/${entry.deliverableId}/${path.posix.basename(file.path)}`;
        if (!artifacts.has(relative)) throw new HttpError(409, "learning_receipt_invalid", "An accepted file is not part of this run.");
        const loaded = await readOwnedFile(project, relative, MAX_OUTPUT_BYTES);
        // The receipt's own digest is what proves the file did not change
        // between acceptance and this read. Without it a run could pass the
        // gate and then rewrite the artifact the loop is about to learn from.
        if (loaded.bytes.length !== file.bytes || createHash("sha256").update(loaded.bytes).digest("hex") !== file.sha256) {
          throw new HttpError(409, "learning_receipt_changed", "An accepted learning artifact changed after delivery.");
        }
        output[path.posix.basename(file.path)] = loaded.bytes.toString("utf8");
      }

      const usage = await usageLedger.summaryRun(identity.userId, identity.dispatchId);
      if (usage.reservedCalls || usage.uncertain) return { status: "pending", reason: "learning_usage_unsettled" };
      if (!usage.settledCalls || !usage.modelId || usage.incompleteUsageCalls) {
        throw new HttpError(409, "learning_usage_invalid", "The learning run has no unambiguous settled model receipt.");
      }
      return { status: "succeeded", output: decodeLearningOutput(output), usage };
    },

    /** @param {any} project @param {any} run */
    async complete(project, run) {
      if (!run?.dispatchId?.startsWith?.("method-")) return false;
      const capabilityId = run.effectiveAgentId ?? run.agentId;
      if (!capabilityId) return false;
      const scoped = learningRunProject(project, learningArtifactDirectory(capabilityId, run.dispatchId));
      if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) {
        await runtimeManager.endBoundedRuntime(scoped, run.dispatchId);
      }
      return true;
    },
  };
}

/**
 * Turn the accepted files into the object the callers expect.
 *
 * Deliberately not a schema: the contract validator has already decided the
 * package is well formed, and re-deciding it here would be the second
 * implementation of a rule that only survives while there is one.
 * @param {Record<string, string>} files
 * @returns {Record<string, any>}
 */
export function decodeLearningOutput(files) {
  /** @type {Record<string, any>} */
  const output = { files: { ...files } };
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith(".md")) {
      if (name === "SKILL.md") output.skill = text;
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(text);
      if (name === "method-candidate.json") output.candidate = value;
      else if (name === "method-relations.json") Object.assign(output, value);
      else output[name] = value;
    } catch {
      throw new HttpError(409, "learning_output_invalid", `${name} is not readable JSON.`);
    }
  }
  return output;
}
