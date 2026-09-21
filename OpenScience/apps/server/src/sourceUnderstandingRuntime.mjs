import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateDeliveryReceipt, workspaceLayout } from "@evimed/domain";
import { assertBoundedRunAffordable, boundedRunBudget } from "./boundedRunBudget.mjs";
import { SOURCES_PROJECT_ID, SOURCES_PROJECT_NAME } from "./internalProjects.mjs";
import { issueModelGatewayBudgetMarker } from "./modelGateway.mjs";
import { sourceAttemptId } from "./sourceFiles.mjs";
import { HttpError, assertProjectCapacity, normalizeWorkspaceRelativePath, openScopedFileNoFollow,
  resolveScopedPath, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 400_000;
const CAPABILITY = "source-understanding";
const INPUT_FILE = "source-understanding-input.json";
const OUTPUT_FILE = "source-understanding.json";

/** The binding's own record of where an attempt's run lives. Unchanged in
 *  shape: it is what the source ledger stores and what cleanup is keyed on. */
const SOURCE_RUN_BINDING = /^knowledge-base\/\.evimed-derived\/(src_[a-f0-9]{32})\/generation-([1-9][0-9]*)-[A-Za-z0-9_-]+-([a-f0-9]{24})$/;

/** A run's workspace in the sources project (see `sourceRunProject`). */
const SOURCE_RUN_WORKSPACE = /^src_[a-f0-9]{32}-g[1-9][0-9]*-[a-f0-9]{24}$/;

/** How many finished runs' workspaces the sources project keeps. A result is
 *  read within minutes of its run finishing; this bounds the disk, not the work. */
const MAX_KEPT_RUN_WORKSPACES = 50;

/** @param {Record<string,any>} config */
export function sourceUnderstandingBudget(config) {
  // Its own caps count `source-understanding` spend only; zero means none, the
  // default (`boundedRunBudget`).
  return boundedRunBudget({
    runLimitCny: config.sourceUnderstandingRunLimitCny,
    dailyLimitCny: config.sourceUnderstandingDailyLimitCny,
    weeklyLimitCny: config.sourceUnderstandingWeeklyLimitCny,
    purpose: "source-understanding",
    invalidCode: "source_understanding_budget_invalid",
  }, config);
}

/**
 * The project one understanding run is dispatched in: the account's sources
 * project, with the attempt's own directory as its workspace.
 *
 * Hidden knowledge: the runtime controller mounts a project's workspace root,
 * or one named workspace directly under it (`activeWorkspace`), and nothing
 * deeper. This used to scope the run to `knowledge-base/.evimed-derived/…`
 * inside the researcher's own project; the controller mounted that project's
 * root, so the run never saw its own input or brief — and reserving the
 * researcher's runtime stopped their open conversation and answered 423 until
 * the run ended (2026-09-21: every upload failed, reproduced live). One level,
 * named for the source, generation and attempt the binding records, in a
 * project the researcher never sees: the run reads only its own input, and the
 * researcher's project is never touched.
 * @param {any} home the account's sources project @param {any} binding
 */
export function sourceRunProject(home, binding) {
  const match = SOURCE_RUN_BINDING.exec(String(binding?.artifactDirectory ?? ""));
  if (!match) throw new HttpError(409, "source_run_scope_unavailable", "The source run has no valid owned artifact directory.");
  const workspace = `${match[1]}-g${match[2]}-${match[3]}`;
  return { ...home, activeWorkspace: workspace, workspaceDir: resolveScopedPath(home.baseDir, workspace) };
}

/**
 * Keep the sources project's disk bounded: drop the oldest finished runs'
 * workspaces past `MAX_KEPT_RUN_WORKSPACES`. Only one run works in the project
 * at a time (the ledger check in `dispatch`), so everything but the newest is
 * a finished run whose result was read long ago.
 * @param {any} home @param {string} keep the workspace about to be used
 */
async function pruneRunWorkspaces(home, keep) {
  const entries = await fs.readdir(home.baseDir, { withFileTypes: true }).catch(() => []);
  const runs = entries.filter(entry => entry.isDirectory() && SOURCE_RUN_WORKSPACE.test(entry.name) && entry.name !== keep);
  if (runs.length < MAX_KEPT_RUN_WORKSPACES) return;
  const aged = await Promise.all(runs.map(async entry => ({ name: entry.name, at: (await fs.lstat(path.join(home.baseDir, entry.name))).mtimeMs })));
  aged.sort((left, right) => left.at - right.at);
  for (const { name } of aged.slice(0, aged.length - MAX_KEPT_RUN_WORKSPACES + 1)) {
    await fs.rm(path.join(home.baseDir, name), { recursive: true, force: true });
  }
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
  /**
   * The account's sources project, made on first use (`internalProjects.mjs`).
   * @param {string} userId
   */
  const sourcesHome = async userId => {
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "source_account_unavailable", "The source account is unavailable.");
    try {
      return await store.requireProject(user, SOURCES_PROJECT_ID);
    } catch (error) {
      if (error?.code !== "project_not_found" && error?.status !== 404) throw error;
      // Two uploads can find it missing together; the second creation is the
      // one that loses, and the project they both wanted exists either way.
      await store.createProject(user, SOURCES_PROJECT_ID, SOURCES_PROJECT_NAME).catch(() => null);
      return store.requireProject(user, SOURCES_PROJECT_ID);
    }
  };
  /** Remove one attempt's run workspace from the sources project.
   * @param {any} home @param {any} binding */
  const removeRunWorkspace = async (home, binding) => {
    const scoped = sourceRunProject(home, binding);
    await withProjectStorageMutation(home, () => fs.rm(scoped.workspaceDir, { recursive: true, force: true }));
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
      // The researcher's project owns the source; the run happens in the
      // account's sources project (`sourceRunProject`).
      const project = await resolveProject(job);
      const home = await sourcesHome(job.userId);
      const source = await sources.get(job.userId, job.payload.sourceId);
      let bound = source.payload.analysis?.run;
      const launch = source.payload.analysis?.launch;
      const ledger = await agentRuns.list(home);
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
          const scoped = sourceRunProject(home, bound);
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
          const scoped = sourceRunProject(home, launch);
          if (runtimeManager.boundedRuntimeScope(scoped)?.runId === dispatchId) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
          await cleanup(project, launch);
          await removeRunWorkspace(home, launch);
        });
        throw new HttpError(409, "source_understanding_run_failed", "The source launch ended before its run was recorded; no replacement request was sent.");
      }
      if (ledger.some(run => run.status === "running")) throw new HttpError(409, "runtime_busy", "Another document is being understood; this one will wait.");
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      if (bytes.length > MAX_INPUT_BYTES) throw new HttpError(413, "source_understanding_input_too_large", "The frozen input exceeds the existing 8 MiB delivery-read limit; no model request was sent.");
      const budget = sourceUnderstandingBudget(config);
      if (!usageLedger) throw new HttpError(503, "source_understanding_usage_unavailable", "Source understanding requires gateway accounting.");
      await assertBoundedRunAffordable(usageLedger, job.userId, budget);
      const selected = (await registry).get(CAPABILITY);
      if (!selected) throw new HttpError(503, "source_understanding_unconfigured", "The source understanding capability is not installed.");
      await assertCurrent(job);
      const binding = { workspaceName: project.activeWorkspace ?? "", artifactDirectory:
        `knowledge-base/.evimed-derived/${source.id}/generation-${source.payload.generation}-${job.id}-${sourceAttemptId(job)}` };
      const scoped = sourceRunProject(home, binding);
      let reserved = false;
      try {
        const session = await sources.withIngestionLease(job, async () => {
          const file = resolveScopedPath(scoped.workspaceDir, INPUT_FILE);
          await withProjectStorageMutation(home, async () => {
            await pruneRunWorkspaces(home, scoped.activeWorkspace);
            await assertProjectCapacity(home, file, bytes.length, config);
            await writeFileAtomicNoFollow(home.baseDir, file, bytes, { mode: 0o600 });
          });
          const value = await runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, ...budget.scope });
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
            await assertBoundedRunAffordable(usageLedger, job.userId, budget);
            return await sources.withIngestionLease(job, async () => {
              // The project the runtime belongs to, which the gateway checks the
              // marker against: the sources project, not the source's.
              const marker = issueModelGatewayBudgetMarker({ secret: config.modelGatewaySigningSecret,
                userId: job.userId, projectId: home.id, runId: dispatchId, ...budget.scope });
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
          const recorded = (await agentRuns.list(home)).find(run => run.dispatchId === dispatchId);
          if (recorded?.status === "running") return identityOf(recorded);
          if (reserved) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
          await cleanup(project, binding);
          if (!recorded) await removeRunWorkspace(home, binding);
          if (recorded) return identityOf(recorded);
          throw error;
        });
      }
    },

    async readResult(identity) {
      const binding = await owner(identity);
      if (!binding?.artifactDirectory) {
        const home = await sourcesHome(identity.userId);
        const unbound = (await agentRuns.list(home)).find(run => run.id === identity.runId
          && run.sessionId === identity.sessionId && run.dispatchId === identity.dispatchId);
        return { status: unbound && unbound.status !== "running" ? "failed" : "pending", reason: "source_run_binding_unknown" };
      }
      const project = sourceRunProject(await sourcesHome(identity.userId), binding);
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
      // Wait only for a request still in flight. An `uncertain` one is a request
      // whose settlement will never arrive — the stream was cut — and waiting on
      // it held the first successful distillation back for good (2026-09-21: 48
      // settled calls, 1 uncertain). Its reserved cost still counts where caps do.
      if (usage.reservedCalls) return { status: "pending", reason: "source_usage_unsettled" };
      if (!usage.settledCalls || !usage.modelId || usage.incompleteUsageCalls) throw new HttpError(409, "source_understanding_usage_invalid", "The source run has no unambiguous settled model receipt.");
      return { status: "succeeded", output, usage };
    },

    /** A finished understanding run lets go of the sources project's runtime,
     *  so the next document's run can take it. @param {any} project @param {any} run */
    async complete(project, run) {
      if (project?.id !== SOURCES_PROJECT_ID || !String(run?.dispatchId ?? "").startsWith(`${CAPABILITY}-`)) return false;
      if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) {
        await runtimeManager.endBoundedRuntime(project, run.dispatchId);
      }
      return true;
    },

    /** Which workspace a run in the sources project belongs to, re-derived from
     *  the source ledger on recovery. Every other project's runs are its own.
     *  @param {any} project @param {any} run */
    async resolveRunProject(project, run) {
      if (project?.id !== SOURCES_PROJECT_ID) return project;
      // The source's project is not this one, so the owner is looked up across
      // the account's projects.
      const identity = { userId: project.userId, projectId: null, ...identityOf(run) };
      const binding = await owner(identity) ?? (run.dispatchId ? await owner({ ...identity, runId: null }) : null);
      if (!binding) return null;
      if (binding.recoverable === false || binding.sourceDeleted || ["canceled", "deleting", "deleted"].includes(binding.sourceStatus)) return null;
      return sourceRunProject(project, binding);
    },

    async cancel(identity) {
      const binding = await owner(identity);
      if (!binding) return false;
      const base = await resolveProject(identity);
      const home = await sourcesHome(identity.userId);
      const project = sourceRunProject(home, binding);
      const run = (await agentRuns.list(project)).find(item => (identity.runId == null || item.id === identity.runId)
        && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run && identity.runId != null) throw new HttpError(409, "source_run_ledger_unavailable", "The canceled source run has no matching ledger identity.");
      if (run?.status === "running") {
        if (runtimeManager.boundedRuntimeScope(project)?.runId === identity.dispatchId) await runtimeManager.cancelRuntimeSession(project, identity.sessionId);
        await agentRuns.cancelSession(project, identity.sessionId);
      }
      if (runtimeManager.boundedRuntimeScope(project)?.runId === identity.dispatchId) await runtimeManager.endBoundedRuntime(project, identity.dispatchId);
      await cleanup(base, binding);
      await removeRunWorkspace(home, binding);
      return true;
    },
  };
}
