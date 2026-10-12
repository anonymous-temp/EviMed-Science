import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_COMPILE_INPUT_FILE, KNOWLEDGE_WIKI_PATCH_FILE } from "@evimed/domain";
import { assertBoundedRunAffordable, boundedRunBudget } from "./boundedRunBudget.mjs";
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_PROJECT_NAME, RUNTIME_YIELDED_CODE } from "./internalProjects.mjs";
import { issueModelGatewayBudgetMarker } from "./modelGateway.mjs";
import { MAX_INPUT_BYTES, readRunPackage } from "./sourceUnderstandingRuntime.mjs";
import { HttpError, assertProjectCapacity, openScopedDirectoryNoFollow, resolveScopedPath, withProjectStorageMutation,
  writeFileAtomicNoFollow } from "./security.mjs";

/**
 * The bounded-run adapter of the knowledge-page compile (「知识页」).
 *
 * Hidden knowledge: it is `sourceUnderstandingRuntime` with the source taken out — the same admission, reservation,
 * dispatch, receipt-checked read and usage settlement, for a run whose input is a project's documents and whose output is
 * a patch of pages (`wiki-patch.json`). Why a run and not a model call from the worker: a run gets metering, the path
 * guard, the sandbox and the model gateway's certification of which model answered, and it can read the documents and the
 * pages it is to update as files, which is how a compiler "reads before it writes". A direct call gets none of those.
 *
 * The run lives in the account's knowledge project (`evimed-knowledge`, internal: hidden, never a researcher's slot) and in
 * a workspace of its own under it, named from the dispatch id alone (`knowledgeRunProject`). That is the one shape the
 * runtime controller can mount (a project's root or one workspace directly under it), and a name that is a pure function of
 * the id is what lets a restart find the run's files again without a record of them (`resolveRunProject`). The ledger's
 * `dispatchId` is the whole binding, so — unlike a source — no second record has to be kept in step with it: an existing
 * dispatch is adopted and a duplicate is never sent.
 *
 * @module knowledgeCompileRuntime
 */

const CAPABILITY = "knowledge-compile";
const MAX_OUTPUT_BYTES = 2_000_000;

/** The dispatch id of the round of a project's compile: one id per (project, round), so a retry finds the same run. @param {string} projectId @param {number} round */
export function knowledgeCompileDispatchId(projectId, round) {
  return `${CAPABILITY}-${createHash("sha256").update(`${projectId}\0${round}`).digest("hex").slice(0, 32)}`;
}

const DISPATCH_ID = /^knowledge-compile-[a-f0-9]{32}$/;
const RUN_WORKSPACE = /^kc-[a-f0-9]{24}$/;

/** How many finished runs' workspaces the knowledge project keeps. A result is read within minutes; this bounds the disk. */
const MAX_KEPT_RUN_WORKSPACES = 20;

/** @param {string} dispatchId */
function workspaceName(dispatchId) {
  if (!DISPATCH_ID.test(String(dispatchId ?? ""))) throw new HttpError(409, "knowledge_run_scope_unavailable", "The compile run has no valid dispatch id.");
  return `kc-${createHash("sha256").update(dispatchId).digest("hex").slice(0, 24)}`;
}

/**
 * The project one compile run is dispatched in: the account's knowledge project, with the run's own directory as its workspace.
 * @param {any} home the account's knowledge project @param {string} dispatchId
 */
export function knowledgeRunProject(home, dispatchId) {
  const workspace = workspaceName(dispatchId);
  return { ...home, activeWorkspace: workspace, workspaceDir: resolveScopedPath(home.baseDir, workspace) };
}

/**
 * The compile's spend against its own caps (counted over the `knowledge` purpose only) and the account's.
 * @param {Record<string, any>} config
 */
export function knowledgeCompileBudget(config) {
  return boundedRunBudget({
    runLimitCny: config.knowledgePagesRunLimitCny,
    dailyLimitCny: config.knowledgePagesDailyLimitCny,
    weeklyLimitCny: config.knowledgePagesWeeklyLimitCny,
    purpose: "knowledge",
    invalidCode: "knowledge_budget_invalid",
  }, config);
}

/** Drop the oldest finished runs' workspaces past the bound; only one run works at a time. @param {any} home @param {string} keep */
async function pruneRunWorkspaces(home, keep) {
  const entries = await fs.readdir(home.baseDir, { withFileTypes: true }).catch(() => []);
  const runs = entries.filter((entry) => entry.isDirectory() && RUN_WORKSPACE.test(entry.name) && entry.name !== keep);
  if (runs.length < MAX_KEPT_RUN_WORKSPACES) return;
  const aged = await Promise.all(runs.map(async (entry) => ({ name: entry.name, at: (await fs.lstat(path.join(home.baseDir, entry.name))).mtimeMs })));
  aged.sort((left, right) => left.at - right.at);
  for (const { name } of aged.slice(0, aged.length - MAX_KEPT_RUN_WORKSPACES + 1)) {
    await fs.rm(path.join(home.baseDir, name), { recursive: true, force: true });
  }
}

/**
 * @param {{ config: any, store: any, agentRuns: any, runtimeManager: any, researchSessions: any, registry: any, usageLedger: any,
 *   prepareContext: (...args: any[]) => Promise<any> }} dependencies
 */
export function createKnowledgeCompileRuntime({ config, store, agentRuns, runtimeManager, researchSessions, registry, usageLedger, prepareContext }) {
  /** The account's knowledge project, made on first use (`internalProjects.mjs`). @param {string} userId */
  const knowledgeHome = async (userId) => {
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "knowledge_account_unavailable", "The knowledge account is unavailable.");
    try {
      return await store.requireProject(user, KNOWLEDGE_PROJECT_ID);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "project_not_found" && /** @type {any} */ (error)?.status !== 404) throw error;
      await store.createProject(user, KNOWLEDGE_PROJECT_ID, KNOWLEDGE_PROJECT_NAME).catch(() => null);
      return store.requireProject(user, KNOWLEDGE_PROJECT_ID);
    }
  };
  /** @param {any} run */
  const identityOf = (run) => ({ runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId });

  return {
    /**
     * Start the compile of one round, or adopt the run already started for it.
     * `files` are written into the run's workspace beside the input (`sources/<id>.txt`, `pages/<slug>.md`): the same text as the
     * input carries, as plain files, because a quotation must be copied from the text and not from its JSON-escaped form.
     * @param {{ userId: string, dispatchId: string, input: any, files?: Array<{ rel: string, text: string }>, question: string, assertCurrent?: () => Promise<any> }} request
     */
    async dispatch(request) {
      const { userId, dispatchId, input, question } = request;
      const files = request.files ?? [];
      const assertCurrent = request.assertCurrent ?? (async () => null);
      const home = await knowledgeHome(userId);
      const scoped = knowledgeRunProject(home, dispatchId);
      const ledger = await agentRuns.list(home);
      const existing = ledger.find((/** @type {any} */ run) => run.dispatchId === dispatchId);
      // A dispatch that exists is adopted and never repeated: a durable record of a request already paid for is not
      // permission to pay again.
      if (existing) {
        await assertCurrent();
        await agentRuns.existingDispatch(scoped, existing);
        if (existing.status === "running") agentRuns.scheduleMonitor(scoped, existing.id);
        else if (runtimeManager.boundedRuntimeScope(scoped)?.runId === dispatchId) await runtimeManager.endBoundedRuntime(scoped, dispatchId);
        return identityOf(existing);
      }
      if (ledger.some((/** @type {any} */ run) => run.status === "running")) {
        throw new HttpError(409, "runtime_busy", "Another compile is running; this one will wait.");
      }
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
      if (bytes.length > MAX_INPUT_BYTES) throw new HttpError(413, "knowledge_input_too_large", "The frozen input exceeds the delivery-read limit; no model request was sent.");
      const budget = knowledgeCompileBudget(config);
      if (!usageLedger) throw new HttpError(503, "knowledge_usage_unavailable", "The knowledge compile requires gateway accounting.");
      await assertBoundedRunAffordable(usageLedger, userId, budget);
      const selected = (await registry).get(CAPABILITY);
      if (!selected) throw new HttpError(503, "knowledge_unconfigured", "The knowledge-compile capability is not installed.");
      await assertCurrent();
      let reserved = false;
      try {
        await withProjectStorageMutation(home, async () => {
          await pruneRunWorkspaces(home, scoped.activeWorkspace);
          const total = bytes.length + files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
          await assertProjectCapacity(home, resolveScopedPath(scoped.workspaceDir, KNOWLEDGE_COMPILE_INPUT_FILE), total, config);
          // The directory now, the files once the run exists: the controller mounts only a workspace that is already there.
          const opened = await openScopedDirectoryNoFollow(home.baseDir, scoped.workspaceDir, { create: true });
          await opened.handle.close();
        });
        const session = await runtimeManager.reserveBoundedRuntimeSession(scoped, { runId: dispatchId, ...budget.scope });
        reserved = true;
        await researchSessions.put(scoped, session.id, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
        const run = await agentRuns.dispatch(scoped, {
          sessionId: session.id, dispatchId, question,
          effectiveAgentId: selected.id, effectiveAgentVersion: selected.version,
          effectiveRuntimeAgent: selected.runtimeAgent, effectiveRouteReason: CAPABILITY,
        }, async (/** @type {any} */ sessionBinding, /** @type {any} */ dispatchedRun, repairText = null) => {
          let promptAttempted = false;
          try {
            // The frozen input is part of this run, so it is written once the run exists: the package must carry it back
            // verbatim, and a copy keeps its original's time — written before the run began, the preserved input was judged
            // "a previous run's file" (`sourceUnderstandingRuntime.mjs`, production 2026-09-21).
            await withProjectStorageMutation(home, async () => {
              await writeFileAtomicNoFollow(home.baseDir, resolveScopedPath(scoped.workspaceDir, KNOWLEDGE_COMPILE_INPUT_FILE), bytes, { mode: 0o600 });
              for (const file of files) {
                await writeFileAtomicNoFollow(home.baseDir, resolveScopedPath(scoped.workspaceDir, file.rel), Buffer.from(file.text, "utf8"), { mode: 0o600 });
              }
            });
            await assertCurrent();
            const prepared = await prepareContext({ ...scoped, baseDir: scoped.workspaceDir }, sessionBinding, config, {
              query: question, memories: [], specialists: [], routedSpecialist: {
                agentId: selected.id, agentVersion: selected.version, runtimeAgent: selected.runtimeAgent,
                skill: selected.skill, companionSkills: selected.companionSkills,
              },
            });
            await assertBoundedRunAffordable(usageLedger, userId, budget);
            // The project the runtime belongs to, which the gateway checks the marker against: the knowledge project.
            const marker = issueModelGatewayBudgetMarker({ secret: config.modelGatewaySigningSecret,
              userId, projectId: home.id, runId: dispatchId, ...budget.scope });
            promptAttempted = true;
            return await runtimeManager.dispatchPrompt(scoped, session.id, {
              // The question first, the markers last, inside a platform tag: the brief is the platform's, never the
              // researcher's words, and a reader of the conversation must be able to tell without knowing the project.
              text: `${repairText || question}\n\n<evimed-knowledge-compile>${dispatchId}</evimed-knowledge-compile>\n${marker}`, system: prepared.system,
              routedCapability: prepared.routedCapability, agent: selected.runtimeAgent, strictContext: true, model: `deepseek/${config.deepseekModel}`,
              runId: dispatchedRun.id, allowBounded: true, requestId: dispatchedRun.kernelRequestIds?.at(-1),
            });
          } catch (error) {
            if (!promptAttempted) /** @type {any} */ (error).definitivelyRejected = true;
            throw error;
          }
        });
        return identityOf(run);
      } catch (error) {
        const recorded = (await agentRuns.list(home)).find((/** @type {any} */ item) => item.dispatchId === dispatchId);
        if (recorded?.status === "running") return identityOf(recorded);
        if (reserved) await runtimeManager.endBoundedRuntime(scoped, dispatchId).catch(() => {});
        if (!recorded) await withProjectStorageMutation(home, () => fs.rm(scoped.workspaceDir, { recursive: true, force: true })).catch(() => {});
        if (recorded) return identityOf(recorded);
        // The launch failed before its run was recorded because a researcher's start took the runtime back: the round
        // waits, and is nobody's failure.
        if (runtimeManager.wasYielded?.(scoped)) throw new HttpError(409, RUNTIME_YIELDED_CODE, "A researcher needed the runtime; the compile runs again when there is room.");
        throw error;
      }
    },

    /**
     * What the run left: pending while it works, `failed` with its status when it did not succeed, else the patch it
     * delivered, with whether its receipt vouches for it and what the gateway settled for it.
     * @param {{ userId: string, runId: string, sessionId: string, dispatchId: string }} identity
     */
    async readResult(identity) {
      const home = await knowledgeHome(identity.userId);
      const scoped = knowledgeRunProject(home, identity.dispatchId);
      const run = (await agentRuns.list(home)).find((/** @type {any} */ item) => item.id === identity.runId && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (!run) return { status: "pending", reason: "knowledge_run_ledger_unavailable" };
      if (run.status === "running") {
        await agentRuns.existingDispatch(scoped, run);
        agentRuns.scheduleMonitor(scoped, run.id);
        return { status: "pending" };
      }
      // The platform stopped it for a researcher's start: the caller releases the round and waits.
      if (run.status !== "succeeded") return { status: run.status, ...(run.errorCode === RUNTIME_YIELDED_CODE ? { yielded: true } : {}) };
      const { values, verified } = await readRunPackage(scoped, run, { capability: CAPABILITY, contractKind: "knowledge-wiki-patch",
        files: [{ name: KNOWLEDGE_WIKI_PATCH_FILE, limit: MAX_OUTPUT_BYTES }, { name: KNOWLEDGE_COMPILE_INPUT_FILE, limit: MAX_INPUT_BYTES }],
        required: KNOWLEDGE_WIKI_PATCH_FILE, missingCode: "knowledge_output_missing", missingMessage: "The run left no patch to read." });
      const usage = await usageLedger.summaryRun(identity.userId, identity.dispatchId);
      // Wait only for a request still in flight; one whose settlement will never arrive is recorded as not known, never as a
      // reason to lose the pages (2026-10-04: a cost that cannot be settled is not a reason to refuse the work).
      if (usage.reservedCalls) return { status: "pending", reason: "knowledge_usage_unsettled" };
      const known = usage.settledCalls && usage.modelId && !usage.incompleteUsageCalls ? usage : null;
      return { status: "succeeded", patch: values[KNOWLEDGE_WIKI_PATCH_FILE], usage: known, ...(verified ? {} : { verification: "unverified" }) };
    },

    /** A finished compile lets go of the knowledge project's runtime. @param {any} project @param {any} run */
    async complete(project, run) {
      if (project?.id !== KNOWLEDGE_PROJECT_ID || !DISPATCH_ID.test(String(run?.dispatchId ?? ""))) return false;
      if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) await runtimeManager.endBoundedRuntime(project, run.dispatchId);
      return true;
    },

    /**
     * Which workspace a run in the knowledge project belongs to, re-derived from its id. Every other project's runs are
     * its own. @param {any} project @param {any} run
     */
    async resolveRunProject(project, run) {
      if (project?.id !== KNOWLEDGE_PROJECT_ID) return project;
      return DISPATCH_ID.test(String(run?.dispatchId ?? "")) ? knowledgeRunProject(project, run.dispatchId) : project;
    },

    /** @param {{ userId: string, runId?: string | null, sessionId: string, dispatchId: string }} identity */
    async cancel(identity) {
      const home = await knowledgeHome(identity.userId);
      const scoped = knowledgeRunProject(home, identity.dispatchId);
      const run = (await agentRuns.list(home)).find((/** @type {any} */ item) => (identity.runId == null || item.id === identity.runId)
        && item.sessionId === identity.sessionId && item.dispatchId === identity.dispatchId);
      if (run?.status === "running") {
        if (runtimeManager.boundedRuntimeScope(scoped)?.runId === identity.dispatchId) await runtimeManager.cancelRuntimeSession(scoped, identity.sessionId);
        await agentRuns.cancelSession(scoped, identity.sessionId);
      }
      if (runtimeManager.boundedRuntimeScope(scoped)?.runId === identity.dispatchId) await runtimeManager.endBoundedRuntime(scoped, identity.dispatchId);
      await withProjectStorageMutation(home, () => fs.rm(scoped.workspaceDir, { recursive: true, force: true }));
      return true;
    },
  };
}
