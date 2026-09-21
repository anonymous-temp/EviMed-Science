import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validateDeliveryReceipt, workspaceLayout } from "@evimed/domain";
import { assertBoundedRunAffordable, boundedRunBudget } from "./boundedRunBudget.mjs";
import { LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME } from "./internalProjects.mjs";
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

/**
 * The learning loop's spend, as its own caps and the account's (`boundedRunBudget`).
 * Its own caps count `learning` spend only; zero means none, the default.
 * @param {Record<string, any>} config
 */
export function learningBudget(config) {
  return boundedRunBudget({
    runLimitCny: config.learningRunLimitCny,
    dailyLimitCny: config.learningDailyLimitCny,
    weeklyLimitCny: config.learningWeeklyLimitCny,
    purpose: "learning",
    invalidCode: "learning_budget_invalid",
  }, config);
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

/** Where a finished step's accepted output is kept once the next step needs
 *  the workspace: the project's own metadata directory, which no runtime mounts. */
const RESULT_ARCHIVE_DIR = "learning-results";

/** How many archived results one learning project keeps. A result is read
 *  within minutes of its run finishing; this bounds the directory, not the loop. */
const MAX_ARCHIVED_RESULTS = 200;

/**
 * One run's archived result, shaped as a project so `readOwnedFile` reads it
 * with the same scoping and bounds as the workspace.
 * @param {any} project @param {string} dispatchId
 */
function resultArchive(project, dispatchId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(dispatchId ?? ""))) {
    throw new HttpError(400, "learning_dispatch_invalid", "The learning dispatch id is invalid.");
  }
  return { ...project, baseDir: project.metaDir, workspaceDir: path.join(project.metaDir, RESULT_ARCHIVE_DIR, dispatchId) };
}

/** @param {any} root a project, or a `resultArchive` @returns {Promise<boolean>} */
async function hasReceipt(root) {
  const stat = await fs.lstat(path.join(root.workspaceDir, workspaceLayout.receiptFile)).catch(() => null);
  return Boolean(stat?.isFile());
}

/**
 * Whether a succeeded run's result can still be read: archived, or still in
 * the workspace because no step has started since. Anything else was emptied
 * before this archive existed, and the lesson has to be run again.
 * @param {any} project @param {any[]} ledger newest first @param {any} run
 */
async function resultAvailable(project, ledger, run) {
  if (await hasReceipt(resultArchive(project, run.dispatchId))) return true;
  return ledger[0]?.id === run.id && hasReceipt(project);
}

/**
 * Keep the latest run's accepted output before its workspace is emptied.
 *
 * Every step runs in the learning project's one workspace (the controller
 * mounts a project's root), and a result is read only after its run's usage
 * settles — so the next step's clear deleted a delivered lesson before its job
 * read it (production, 2026-09-21: `source-ledger-closure`, lost to ENOENT).
 * Only regular files the ledger names, read without following links; the
 * receipt goes last, so an archive with a receipt is a complete one.
 * @param {any} project @param {any[]} ledger newest first
 */
async function archiveLatestResult(project, ledger) {
  const latest = ledger[0];
  if (latest?.status !== "succeeded" || !latest.dispatchId) return;
  const archive = resultArchive(project, latest.dispatchId);
  if (await hasReceipt(archive) || !await hasReceipt(project)) return;
  for (const relative of [...(latest.artifacts ?? []), workspaceLayout.receiptFile]) {
    const loaded = await readOwnedFile(project, relative, MAX_OUTPUT_BYTES).catch(() => null);
    if (!loaded) continue;
    await writeFileAtomicNoFollow(archive.baseDir, resolveScopedPath(archive.workspaceDir, relative), loaded.bytes, { mode: 0o600 });
  }
  const root = path.join(project.metaDir, RESULT_ARCHIVE_DIR);
  const kept = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  if (kept.length <= MAX_ARCHIVED_RESULTS) return;
  const aged = await Promise.all(kept.filter((entry) => entry.isDirectory())
    .map(async (entry) => ({ name: entry.name, at: (await fs.lstat(path.join(root, entry.name))).mtimeMs })));
  aged.sort((left, right) => left.at - right.at);
  for (const { name } of aged.slice(0, aged.length - MAX_ARCHIVED_RESULTS)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}

/**
 * Empty the learning project's workspace before a step: nothing of the
 * researcher's lives there, and a step must not read the last one's files.
 * The last step's result is archived first (`archiveLatestResult`).
 * @param {any} project @param {any[]} ledger newest first
 */
async function clearLearningWorkspace(project, ledger) {
  if (project?.id !== LEARNING_PROJECT_ID) {
    throw new HttpError(409, "learning_workspace_refused", "Only the learning project's workspace is cleared.");
  }
  await withProjectStorageMutation(project, async () => {
    await archiveLatestResult(project, ledger);
    const entries = await fs.readdir(project.workspaceDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await fs.rm(path.join(project.workspaceDir, entry.name), { recursive: true, force: true });
    }
  });
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
  /**
   * Where a learning step runs: the account's own learning project, made on
   * first use (`internalProjects.mjs`). Never the researcher's project — a
   * bounded run holds its project's runtime, and a lesson distilled in the
   * project it came from locked that conversation for minutes (2026-09-21).
   * @param {string} userId
   */
  const learningProject = async (userId) => {
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "learning_account_unavailable", "The learning account is unavailable.");
    try {
      return await store.requireProject(user, LEARNING_PROJECT_ID);
    } catch (error) {
      if (error?.code !== "project_not_found" && error?.status !== 404) throw error;
      await store.createProject(user, LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME);
      return store.requireProject(user, LEARNING_PROJECT_ID);
    }
  };
  /** @param {{userId: string, projectId: string, isolatedProject?: boolean}} identity */
  const runProject = (identity) => (identity.isolatedProject === true
    ? resolveProject(identity)
    : learningProject(identity.userId));
  /** @param {any} run @returns {{runId: string, sessionId: string, dispatchId: string}} */
  const identityOf = (run) => ({ runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId });

  return {
    /**
     * @param {{job: any, dispatchId: string, capabilityId: string, contractKind: string, input: any, question: string,
     *          userId: string, projectId: string, isolatedProject?: boolean}} request
     */
    async dispatch(request) {
      const { job, capabilityId, input, question } = request;
      const baseDispatchId = request.dispatchId;
      const project = await runProject({ userId: request.userId ?? job.userId, projectId: request.projectId ?? job.projectId,
        isolatedProject: request.isolatedProject === true });
      learningArtifactDirectory(capabilityId, baseDispatchId);
      // The whole project is the run's workspace — the learning project for a
      // learning step, the cell's own project for an evaluation. The runtime
      // controller mounts a project's workspace root by identity and ignores a
      // subdirectory: a learning step scoped under `.evimed-learning/…` saw the
      // root as /workspace, went looking for its own input, and the run policy
      // found no dispatch index and treated it as a plain conversation, with no
      // method (production, 2026-09-21). One learning project, one run at a
      // time (below), so the root is safe to give it.
      const scoped = project;

      // A dispatch that is working, or that delivered, is adopted and never
      // repeated: a durable record of a request already paid for is not
      // permission to pay again. One that failed or was cancelled is not
      // adopted — it is retried under the next attempt id. Adopting it made one
      // bad run a lesson lost for good: every re-queued job read the same
      // failure back (2026-09-21). How many attempts a lesson gets is the job's
      // own limit. A delivery whose files a later step emptied before the
      // archive existed is spent as well: adopting it read ENOENT forever.
      const ledger = await agentRuns.list(project);
      const attempts = ledger
        .filter((run) => run.dispatchId === baseDispatchId || String(run.dispatchId ?? "").startsWith(`${baseDispatchId}-a`))
        .sort((left, right) => String(left.startedAt ?? left.createdAt ?? "").localeCompare(String(right.startedAt ?? right.createdAt ?? "")));
      const latest = attempts.at(-1) ?? null;
      const lost = latest?.status === "succeeded" && request.isolatedProject !== true
        && !await resultAvailable(project, ledger, latest);
      const spent = latest && (lost || ["failed", "cancelled", "canceled"].includes(String(latest.status)));
      const existing = spent ? null : latest;
      const dispatchId = spent ? `${baseDispatchId}-a${attempts.length + 1}` : String(latest?.dispatchId ?? baseDispatchId);
      const directory = learningArtifactDirectory(capabilityId, dispatchId);
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
      // A step starts on an empty workspace: the previous step's input, its
      // deliverables and its receipt are not this step's to read. Only in the
      // learning project, which holds nothing of the researcher's.
      if (request.isolatedProject !== true) await clearLearningWorkspace(project, ledger);

      const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      if (bytes.length > MAX_INPUT_BYTES) {
        throw new HttpError(413, "learning_input_too_large", "The frozen learning input exceeds its read limit; no model request was sent.");
      }
      if (!usageLedger) throw new HttpError(503, "learning_usage_unavailable", "The learning loop requires gateway accounting.");
      const budget = learningBudget(config);
      await assertBoundedRunAffordable(usageLedger, job.userId, budget);
      const selected = (await registry).get(capabilityId);
      if (!selected) throw new HttpError(503, "learning_capability_unconfigured", `The ${capabilityId} capability is not installed.`);

      let reserved = false;
      try {
        const file = resolveScopedPath(scoped.workspaceDir, learningInputFile(capabilityId));
        await withProjectStorageMutation(project, async () => {
          await assertProjectCapacity(project, file, bytes.length, config);
          await writeFileAtomicNoFollow(project.baseDir, file, bytes, { mode: 0o600 });
        });
        const session = await runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, ...budget.scope });
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
            await assertBoundedRunAffordable(usageLedger, job.userId, budget);
            const marker = issueModelGatewayBudgetMarker({
              secret: config.modelGatewaySigningSecret,
              // The project the runtime belongs to, which the gateway checks the
              // marker against: the learning project, not the lesson's.
              userId: job.userId, projectId: project.id, runId: dispatchId, ...budget.scope,
            });
            promptAttempted = true;
            return await runtimeManager.dispatchPrompt(scoped, session.id, {
              // The question first: the kernel names a session after the start
              // of its first message. The gateway finds the marker anywhere.
              text: `${repairText || question}\n\n${marker}`,
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
     *          capabilityId?: string, contractKind?: string, outputs?: string[], isolatedProject?: boolean}} identity
     */
    async readResult(identity) {
      const capabilityId = identity.capabilityId
        ?? identity.dispatchId.replace(/-a\d+$/, "").split("-").slice(0, -1).join("-");
      const project = await runProject(identity);
      const ledger = await agentRuns.list(project);
      const run = ledger.find((item) => item.id === identity.runId
        && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run) return { status: "pending", reason: "learning_run_ledger_unavailable" };
      if (run.status === "running") {
        await agentRuns.existingDispatch(project, run);
        agentRuns.scheduleMonitor(project, run.id);
        return { status: "pending" };
      }
      if (run.status !== "succeeded") return { status: run.status };

      // Archived once a later step needed the workspace; until then, still in
      // it. A workspace a later step has already taken holds that step's files.
      const archived = resultArchive(project, run.dispatchId);
      const source = await hasReceipt(archived) ? archived
        : identity.isolatedProject === true || ledger[0]?.id === run.id ? project : null;
      if (!source || !await hasReceipt(source)) {
        throw new HttpError(409, "learning_result_missing", "The learning run's delivered files are gone; its next attempt runs it again.");
      }
      const receipt = await readOwnedFile(source, workspaceLayout.receiptFile, MAX_INPUT_BYTES);
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
        const loaded = await readOwnedFile(source, relative, MAX_OUTPUT_BYTES);
        // The receipt's own digest is what proves the file did not change
        // between acceptance and this read. Without it a run could pass the
        // gate and then rewrite the artifact the loop is about to learn from.
        if (loaded.bytes.length !== file.bytes || createHash("sha256").update(loaded.bytes).digest("hex") !== file.sha256) {
          throw new HttpError(409, "learning_receipt_changed", "An accepted learning artifact changed after delivery.");
        }
        output[path.posix.basename(file.path)] = loaded.bytes.toString("utf8");
      }

      const usage = await usageLedger.summaryRun(identity.userId, identity.dispatchId);
      // Wait only for a request still in flight. An `uncertain` one is a request
      // whose settlement will never arrive — the stream was cut — and waiting on
      // it held the first successful distillation back for good (2026-09-21: 48
      // settled calls, 1 uncertain). Its reserved cost still counts where caps do.
      if (usage.reservedCalls) return { status: "pending", reason: "learning_usage_unsettled" };
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
      if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) {
        await runtimeManager.endBoundedRuntime(project, run.dispatchId);
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
