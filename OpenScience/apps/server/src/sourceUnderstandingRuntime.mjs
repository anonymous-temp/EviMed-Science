import { createHash } from "node:crypto";
import path from "node:path";
import { validateDeliveryReceipt, workspaceLayout } from "@evimed/domain";
import { issueModelGatewayBudgetMarker } from "./modelGateway.mjs";
import { sourceAttemptId } from "./sourceFiles.mjs";
import { HttpError, assertProjectCapacity, normalizeWorkspaceRelativePath, openScopedFileNoFollow,
  resolveScopedPath, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 400_000;
const CAPABILITY = "source-understanding";
const INPUT_FILE = "source-understanding-input.json";
const OUTPUT_FILE = "source-understanding.json";

/** @param {Record<string,any>} config */
export function sourceUnderstandingBudget(config) {
  const configured = [config.sourceUnderstandingRunLimitCny, config.sourceUnderstandingDailyLimitCny,
    config.sourceUnderstandingWeeklyLimitCny];
  if (configured.some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    || [config.userDailySpendLimit, config.userWeeklySpendLimit].some(value =>
      typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new HttpError(503, "source_understanding_budget_invalid", "Source understanding requires finite positive CNY spending ceilings.");
  }
  const minimum = (...values) => Math.min(...values.filter(value => value > 0));
  const dailyLimit = minimum(configured[1], config.userDailySpendLimit);
  const weeklyLimit = minimum(configured[2], config.userWeeklySpendLimit);
  return { dailyLimit, weeklyLimit, runLimit: minimum(configured[0], dailyLimit, weeklyLimit) };
}

/** @param {any} project @param {any} binding */
export function sourceRunProject(project, binding) {
  const directory = binding?.artifactDirectory;
  if (typeof directory !== "string" || !/^knowledge-base\/\.evimed-derived\/src_[a-f0-9]{32}\/generation-[1-9][0-9]*-[A-Za-z0-9_-]+-[a-f0-9]{24}$/.test(directory)) {
    throw new HttpError(409, "source_run_scope_unavailable", "The source run has no valid owned artifact directory.");
  }
  return { ...project, activeWorkspace: binding.workspaceName ?? "",
    workspaceDir: resolveScopedPath(project.baseDir, directory) };
}

/** A bounded read cannot grow without limit after the initial file stat.
 * @param {any} project @param {string} relative @param {number} limit */
async function readOwnedJson(project, relative, limit) {
  const normalized = normalizeWorkspaceRelativePath(relative, "source artifact");
  // Anchor at the trusted project base, not the customer-replaceable derived
  // directory: every source-directory ancestor must also pass no-follow checks.
  const opened = await openScopedFileNoFollow(project.baseDir, resolveScopedPath(project.workspaceDir, normalized));
  try {
    if (!opened.stat.isFile() || opened.stat.size <= 0 || opened.stat.size > limit) {
      throw new HttpError(413, "source_understanding_artifact_too_large", "The source artifact exceeds its bounded read limit.");
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new HttpError(413, "source_understanding_artifact_too_large", "The source artifact grew beyond its bounded read limit.");
    const bytes = buffer.subarray(0, length);
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } finally { await opened.handle.close(); }
}

/** Existing bounded DSH admission, run recovery, receipt and cancellation.
 * @param {{config:any,store:any,sources:any,agentRuns:any,runtimeManager:any,researchSessions:any,
 * registry:any,usageLedger:any,prepareContext:(...args:any[])=>Promise<any>,cleanup?:(project:any,binding:any)=>Promise<any>}} dependencies */
export function createSourceUnderstandingRuntime({ config, store, sources, agentRuns, runtimeManager,
  researchSessions, registry, usageLedger, prepareContext, cleanup = async () => {} }) {
  const assertCurrent = job => sources.withIngestionLease(job, async () => null);
  const resolveProject = async identity => {
    const user = await store.userById(identity.userId);
    if (!user) throw new HttpError(404, "source_account_unavailable", "The source account is unavailable.");
    return store.requireProject(user, identity.projectId);
  };
  const owner = async identity => {
    if (identity.runId == null) {
      const launch = await sources.understandingLaunchForDispatch(identity.userId, identity.projectId, identity.dispatchId);
      return launch?.sessionId === identity.sessionId && launch.dispatchId === identity.dispatchId ? launch : null;
    }
    const binding = await sources.understandingRunForRun(identity.userId, identity.projectId, identity.runId);
    if (!binding || binding.id !== identity.runId || binding.sessionId !== identity.sessionId
      || binding.dispatchId !== identity.dispatchId) return null;
    return binding;
  };
  const identityOf = run => ({ runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId });

  return {
    async dispatch(request) {
      const { job, dispatchId, input, question } = request;
      await assertCurrent(job);
      const project = await resolveProject(job);
      const source = await sources.get(job.userId, job.payload.sourceId);
      let bound = source.payload.analysis?.run;
      const launch = source.payload.analysis?.launch;
      const ledger = await agentRuns.list(project);
      const existing = ledger.find(run => run.dispatchId === dispatchId);
      // A durable dispatch, including an unknown one, is never permission for
      // another paid request. A protected launch intent closes the crash window
      // between the run-ledger append and the full source binding.
      if (existing) {
        await assertCurrent(job);
        if (!bound?.artifactDirectory && launch?.artifactDirectory) {
          if (launch.sessionId !== existing.sessionId || launch.dispatchId !== dispatchId) {
            throw new HttpError(409, "source_understanding_run_failed", "The existing dispatch does not match its protected source launch.");
          }
          const restored = await sources.bindUnderstandingRun(job, { runId: existing.id, ...launch });
          bound = restored.payload.analysis.run;
        }
        if (bound?.artifactDirectory) {
          if (bound.id !== existing.id || bound.sessionId !== existing.sessionId || bound.dispatchId !== dispatchId) {
            throw new HttpError(409, "source_run_binding_conflict", "The source run binding differs from its ledger.");
          }
          const scoped = sourceRunProject(project, bound);
          await agentRuns.existingDispatch(scoped, existing);
          if (existing.status === "running") agentRuns.scheduleMonitor(scoped, existing.id);
          else await sources.withIngestionLease(job, async () => {
            if (runtimeManager.boundedRuntimeScope(scoped)?.runId === dispatchId) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
          });
        } else {
          throw new HttpError(409, "source_understanding_run_failed", "The previous source dispatch has no recoverable launch scope; no replacement request was sent.");
        }
        return identityOf(existing);
      }
      if (bound) throw new HttpError(409, "source_run_ledger_unavailable", "The bound source run is missing from the durable ledger; no new request was sent.");
      if (launch) {
        await sources.withIngestionLease(job, async () => {
          const scoped = sourceRunProject(project, launch);
          if (runtimeManager.boundedRuntimeScope(scoped)?.runId === dispatchId) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
          await cleanup(project, launch);
        });
        throw new HttpError(409, "source_understanding_run_failed", "The source launch ended before its run was recorded; no replacement request was sent.");
      }
      if (ledger.some(run => run.status === "running")) throw new HttpError(409, "runtime_busy", "The project has an unfinished run; source understanding will wait.");
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      if (bytes.length > MAX_INPUT_BYTES) throw new HttpError(413, "source_understanding_input_too_large", "The frozen input exceeds the existing 8 MiB delivery-read limit; no model request was sent.");
      const budget = sourceUnderstandingBudget(config);
      if (!usageLedger) throw new HttpError(503, "source_understanding_usage_unavailable", "Source understanding requires gateway accounting.");
      await usageLedger.assertWithinLimits(job.userId, budget);
      const selected = (await registry).get(CAPABILITY);
      if (!selected) throw new HttpError(503, "source_understanding_unconfigured", "The source understanding capability is not installed.");
      await assertCurrent(job);
      const binding = { workspaceName: project.activeWorkspace ?? "", artifactDirectory:
        `knowledge-base/.evimed-derived/${source.id}/generation-${source.payload.generation}-${job.id}-${sourceAttemptId(job)}` };
      const scoped = sourceRunProject(project, binding);
      let reserved = false;
      try {
        const session = await sources.withIngestionLease(job, async () => {
          const file = resolveScopedPath(scoped.workspaceDir, INPUT_FILE);
          await withProjectStorageMutation(project, async () => {
            await assertProjectCapacity(project, file, bytes.length, config);
            await writeFileAtomicNoFollow(project.baseDir, file, bytes, { mode: 0o600 });
          });
          const value = await runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, ...budget });
          reserved = true;
          return value;
        });
        await assertCurrent(job);
        await researchSessions.put(scoped, session.id, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
        await sources.bindUnderstandingLaunch(job, { sessionId: session.id, dispatchId, ...binding });
        const run = await agentRuns.dispatch(scoped, {
          sessionId: session.id, dispatchId, question,
          effectiveAgentId: selected.id, effectiveAgentVersion: selected.version,
          effectiveRuntimeAgent: selected.runtimeAgent, effectiveRouteReason: CAPABILITY,
        }, async (sessionBinding, dispatchedRun, repairText = null) => {
          let promptAttempted = false;
          try {
            await sources.bindUnderstandingRun(job, { runId: dispatchedRun.id, sessionId: session.id, dispatchId, ...binding });
            await assertCurrent(job);
            // Only this source's owned directory is context for this run; do
            // not recursively synchronize the parent knowledge base into it.
            const prepared = await prepareContext({ ...scoped, baseDir: scoped.workspaceDir }, sessionBinding, config, {
              query: question, memories: [], specialists: [], routedSpecialist: {
                agentId: selected.id, agentVersion: selected.version, runtimeAgent: selected.runtimeAgent,
                skill: selected.skill, companionSkills: selected.companionSkills,
              },
            });
            await assertCurrent(job);
            await usageLedger.assertWithinLimits(job.userId, budget);
            return await sources.withIngestionLease(job, async () => {
              const marker = issueModelGatewayBudgetMarker({ secret: config.modelGatewaySigningSecret,
                userId: job.userId, projectId: job.projectId, runId: dispatchId, ...budget });
              promptAttempted = true;
              return runtimeManager.dispatchPrompt(scoped, session.id, {
                text: `${marker}\n${repairText || question}`, system: prepared.system,
                agent: selected.runtimeAgent, strictContext: true, model: `deepseek/${config.deepseekModel}`,
                runId: dispatchedRun.id, allowBounded: true, requestId: dispatchedRun.kernelRequestIds?.at(-1),
              });
            });
          } catch (error) {
            if (!promptAttempted) error.definitivelyRejected = true;
            throw error;
          }
        });
        return identityOf(run);
      } catch (error) {
        // A stale attempt may clean its own copy, but account replacement must
        // not turn its old project path into authority over a new account.
        return sources.withAttemptCleanup(job, async () => {
          const recorded = (await agentRuns.list(project)).find(run => run.dispatchId === dispatchId);
          if (recorded?.status === "running") return identityOf(recorded);
          if (reserved) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
          await cleanup(project, binding);
          if (recorded) return identityOf(recorded);
          throw error;
        });
      }
    },

    async readResult(identity) {
      const binding = await owner(identity);
      if (!binding?.artifactDirectory) {
        const project = await resolveProject(identity);
        const unbound = (await agentRuns.list(project)).find(run => run.id === identity.runId
          && run.sessionId === identity.sessionId && run.dispatchId === identity.dispatchId);
        return { status: unbound && unbound.status !== "running" ? "failed" : "pending", reason: "source_run_binding_unknown" };
      }
      const project = sourceRunProject(await resolveProject(identity), binding);
      const run = (await agentRuns.list(project)).find(item => item.id === identity.runId && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run) return { status: "pending", reason: "source_run_ledger_unavailable" };
      if (run.status === "running") {
        await agentRuns.existingDispatch(project, run);
        agentRuns.scheduleMonitor(project, run.id);
        return { status: "pending" };
      }
      if (run.status !== "succeeded") return { status: run.status };
      const receiptRead = await readOwnedJson(project, workspaceLayout.receiptFile, MAX_INPUT_BYTES);
      const checked = validateDeliveryReceipt(receiptRead.value);
      if (!checked.ok) throw new HttpError(409, "source_understanding_receipt_invalid", "The source understanding delivery receipt is invalid.");
      const entries = checked.receipt.entries.filter(entry => entry.contractKind === CAPABILITY && entry.capability === CAPABILITY);
      if (entries.length !== 1) throw new HttpError(409, "source_understanding_receipt_invalid", "One accepted source understanding package is required.");
      const entry = entries[0];
      const artifacts = new Set(run.artifacts ?? []);
      let output;
      for (const name of [INPUT_FILE, OUTPUT_FILE]) {
        const files = entry.files.filter(file => path.posix.basename(file.path) === name);
        if (files.length !== 1) throw new HttpError(409, "source_understanding_receipt_invalid", "The accepted source package is incomplete.");
        const file = files[0];
        const candidates = [file.path];
        if (checked.receipt.formatVersion <= 1 && file.path === name) candidates.push(`${workspaceLayout.deliverablesDir}/${entry.deliverableId}/${name}`);
        const relative = candidates.find(candidate => artifacts.has(candidate));
        if (!relative) throw new HttpError(409, "source_understanding_receipt_invalid", "The accepted file is not part of this run.");
        const loaded = await readOwnedJson(project, relative, name === INPUT_FILE ? MAX_INPUT_BYTES : MAX_OUTPUT_BYTES);
        if (loaded.bytes.length !== file.bytes || createHash("sha256").update(loaded.bytes).digest("hex") !== file.sha256) {
          throw new HttpError(409, "source_understanding_receipt_changed", "An accepted source artifact changed after delivery.");
        }
        if (name === OUTPUT_FILE) output = loaded.value;
      }
      const usage = await usageLedger.summaryRun(identity.userId, identity.dispatchId);
      if (usage.reservedCalls || usage.uncertain) return { status: "pending", reason: "source_usage_unsettled" };
      if (!usage.settledCalls || !usage.modelId || usage.incompleteUsageCalls) throw new HttpError(409, "source_understanding_usage_invalid", "The source run has no unambiguous settled model receipt.");
      return { status: "succeeded", output, usage };
    },

    async complete(project, run) {
      const identity = { userId: project.userId, projectId: project.id, ...identityOf(run) };
      const binding = await owner(identity);
      if (!binding) return false;
      if (runtimeManager.boundedRuntimeScope(project)?.runId === binding.dispatchId) {
        await runtimeManager.endBoundedRuntime(sourceRunProject(project, binding), binding.dispatchId);
      }
      return true;
    },

    async resolveRunProject(project, run) {
      const identity = { userId: project.userId, projectId: project.id, ...identityOf(run) };
      const binding = await owner(identity) ?? (run.dispatchId ? await owner({ ...identity, runId: null }) : null);
      if (!binding) return [run.agentId, run.effectiveAgentId].includes(CAPABILITY) ? null : project;
      if (binding.recoverable === false || binding.sourceDeleted || ["canceled", "deleting", "deleted"].includes(binding.sourceStatus)) return null;
      return sourceRunProject(project, binding);
    },

    async cancel(identity) {
      const binding = await owner(identity);
      if (!binding) return false;
      const base = await resolveProject(identity);
      const project = sourceRunProject(base, binding);
      const run = (await agentRuns.list(project)).find(item => (identity.runId == null || item.id === identity.runId)
        && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run && identity.runId != null) throw new HttpError(409, "source_run_ledger_unavailable", "The canceled source run has no matching ledger identity.");
      if (run?.status === "running") {
        if (runtimeManager.boundedRuntimeScope(project)?.runId === identity.dispatchId) await runtimeManager.cancelRuntimeSession(project, identity.sessionId);
        await agentRuns.cancelSession(project, identity.sessionId);
      }
      if (runtimeManager.boundedRuntimeScope(project)?.runId === identity.dispatchId) await runtimeManager.endBoundedRuntime(project, identity.dispatchId);
      await cleanup(base, binding);
      return true;
    },
  };
}
