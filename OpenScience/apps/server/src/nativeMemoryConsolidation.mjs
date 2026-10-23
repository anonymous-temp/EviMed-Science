import { createHash } from "node:crypto";
import { recordNativeConsolidatedFiles, recordNativeConsolidation } from "./nativeMemoryMetrics.mjs";
import { nativeMemoryFile } from "./openVikingSessions.mjs";

/**
 * 重读旧记忆 on the native engine: OpenViking's own memory consolidation, run for an account now and then (2026-10-23, rectification
 * T1.10 / I6).
 *
 * The legacy engine had a reader that went back over an account's old memories under the current rules (`MemoryReview`); the native one
 * had nothing: files written by extractions that ran under earlier wording of the templates, duplicates from different batches, one
 * entity under two names, stayed as they were. The engine does this itself — `ov compile --skill memory` over the account's memories
 * root deduplicates, merges, splits and compacts in place under each type's own schema, conservatively (only clearly the same object),
 * with every distinct fact kept and nothing invented (v0.5.0, `docs/en/context-compilation/06-memory-consolidation.md`). It runs inside
 * the engine, and its model calls reach the model through the platform's gateway as `memory-extraction`, on the OpenViking module's daily
 * budget. So this is the narrowest adapter: when to ask, and what to do with the answer.
 *
 *  - **When.** At most once an interval (a week) per account, only after the account's files changed since the last consolidation left
 *    them (a fingerprint of the files' names, times and sizes, taken when the last one was read in), and only when there are enough files
 *    to have duplicates. The files are looked at no more often than hourly. Held back, and counted, while the account's learning is
 *    paused, an extraction is still working, or the last commit is under ten minutes old: a consolidation and an extraction must not
 *    rewrite the same file at once. One account is asked for by one worker at a time (a lease on the account's row, which runs out by
 *    itself).
 *  - **What comes back.** The task answers with the URIs it added, updated and deleted and no content. Each is read as it is now and
 *    entered as a revision by the engine with the text before (what the overlay held) and after — which is what the memory page's
 *    undo restores from, so no consolidation is a change the person cannot take back in one step — and held to the same checks after
 *    the fact as any other write of the engine (`NativeMemoryWorker.ingestConsolidation`). A task the engine reports with errors and
 *    no change is a failure; one with errors and some change keeps the change and counts as completed (the errors are in the log).
 *  - **Never blocking.** A task runs for minutes; the pass that submits it returns, and the passes after it ask the task how it is
 *    doing. One that outlives `TASK_TIMEOUT_MS` is cancelled and counted as failed; one the engine no longer holds is lost.
 *
 * Off by default (`OPEN_SCIENCE_NATIVE_MEMORY_CONSOLIDATION_ENABLED`): the engine's output on real memory is unmeasured here, and the
 * operator switches it on after a probe on an account's real files.
 *
 * Build to delete: when the engine runs this on its own schedule (it has a Compile auto-update on `main`), the timer goes and the
 * ingestion of its result stays.
 *
 * @module nativeMemoryConsolidation
 */

/** The fewest memory files an account holds before consolidating them is worth a model call. */
export const MIN_FILES = 4;
/** How long the account's files are left unlooked-at after a look that found nothing to do. */
const CHECK_EVERY_MS = 60 * 60_000;
/** How long after its last commit an account is left alone: an extraction may still be writing. */
const QUIET_AFTER_COMMIT_MS = 10 * 60_000;
/** How long a task may run before it is cancelled. */
export const TASK_TIMEOUT_MS = 2 * 60 * 60_000;
/** The lease on an account while a pass looks at it and submits. */
const LEASE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The soft hint the engine is given: what to keep, and what never to do. */
export const CONSOLIDATION_INSTRUCTION = [
  "Consolidate this person's existing memories without losing any fact: merge entries that are clearly the same thing, keep distinct things separate,",
  "and tighten repetitive wording. Do not add anything that is not already in the memories.",
].join(" ");

const digest = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/**
 * The shape of an account's memory files: their addresses, modification times and sizes, hashed. The next consolidation waits until this
 * is not what the last one left.
 * @param {readonly { uri: string, modTime: string | null, size: number }[]} nodes
 */
export function filesFingerprint(nodes) {
  return digest(nodes.map((node) => `${node.uri}\n${node.modTime ?? ""}\n${node.size}`).sort().join("\n"));
}

export class NativeMemoryConsolidation {
  /**
   * @param {{
   *   config: any,
   *   researchMemory: { settings: (userId: string) => Promise<any> },
   *   sessions: import("./openVikingSessions.mjs").OpenVikingSessions,
   *   resources: import("./openVikingResources.mjs").OpenVikingResources,
   *   overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
   *   ingest: (userId: string, task: { taskId: string, adds: readonly string[], updates: readonly string[], deletes: readonly string[] }) => Promise<{ added: number, updated: number, deleted: number }>,
   *   now?: () => Date, report?: (line: string) => void,
   * }} dependencies
   */
  constructor({ config, researchMemory, sessions, resources, overlay, ingest, now = () => new Date(), report = () => {} }) {
    this.config = config ?? {};
    this.researchMemory = researchMemory;
    this.sessions = sessions;
    this.resources = resources;
    this.overlay = overlay;
    this.ingest = ingest;
    this.now = now;
    this.report = report;
    this.intervalMs = Math.max(1, Number(this.config.nativeMemoryConsolidationIntervalDays ?? 7)) * DAY_MS;
  }

  /** Whether this deployment consolidates at all: the lever, the native engine, and what it needs to reach it. */
  get applicable() {
    return this.config.nativeMemoryConsolidationEnabled === true && this.config.ovNativeMemoryEnabled === true
      && Boolean(this.sessions?.configured && this.resources?.configured && this.overlay?.configured);
  }

  /**
   * One pass over one native account: ask for a consolidation when one is due, or look after the one in flight. Never throws.
   * @param {string} userId @returns {Promise<string>} what became of it, one of `NATIVE_CONSOLIDATION_OUTCOMES`, or "off"
   */
  async tick(userId) {
    if (!this.applicable) return "off";
    try {
      const state = await this.overlay.consolidationState(userId);
      if (state.task) return await this.#settle(userId, state);
      const outcome = await this.#maybeSubmit(userId, state);
      recordNativeConsolidation(outcome);
      return outcome;
    } catch (error) {
      this.report(`native memory consolidation: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      recordNativeConsolidation("failed");
      return "failed";
    }
  }

  /** @param {string} userId @param {Awaited<ReturnType<import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay["consolidationState"]>>} state */
  async #maybeSubmit(userId, state) {
    const at = this.now().getTime();
    if (state.consolidatedAt && at - Date.parse(state.consolidatedAt) < this.intervalMs) return "not_due";
    if (state.checkedAt && at - Date.parse(state.checkedAt) < CHECK_EVERY_MS) return "not_due";
    const settings = await this.researchMemory.settings(userId);
    if (settings.learningPaused) return "held_back";
    const open = await this.overlay.openCommits({ userId, limit: 1, now: this.now() });
    const latest = (await this.overlay.commitsOf(userId, { limit: 1 }))[0];
    if (open.length || (latest && at - Date.parse(latest.createdAt ?? "") < QUIET_AFTER_COMMIT_MS)) return "held_back";
    if (!await this.overlay.claimConsolidation(userId, LEASE_MS)) return "held_back";
    const root = this.sessions.memoryRoot(userId);
    const files = (await this.sessions.tree(userId, root, { levelLimit: 8 })).filter((node) => !node.isDir && nativeMemoryFile(node.uri, root));
    if (files.length < MIN_FILES) { await this.overlay.noteConsolidationChecked(userId, this.now()); return "too_few"; }
    const fingerprint = filesFingerprint(files);
    if (state.fingerprint === fingerprint) { await this.overlay.noteConsolidationChecked(userId, this.now()); return "unchanged"; }
    // The same files in the same hour, the same key: asked twice (a restart between the answer and the note) is one task. The engine answers
    // a key it has seen with the task it made — a failed one too — so a retry, which waits at least the hour, is a new key.
    const hour = this.now().toISOString().slice(0, 13).replace(/\D/g, "");
    const task = await this.resources.submitMemoryConsolidation(userId, {
      to: root, instruction: CONSOLIDATION_INSTRUCTION, idempotencyKey: `nm-consolidate-${digest(userId).slice(0, 24)}-${fingerprint.slice(0, 24)}-${hour}`,
    });
    await this.overlay.noteConsolidationSubmitted(userId, task.taskId, this.now());
    return "submitted";
  }

  /** @param {string} userId @param {Awaited<ReturnType<import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay["consolidationState"]>>} state */
  async #settle(userId, state) {
    const taskId = /** @type {string} */ (state.task);
    const task = await this.resources.memoryConsolidationTask(userId, taskId);
    if (!task) {
      // The engine keeps a task record a day: a consolidation that was not read in by then is not coming.
      await this.overlay.noteConsolidationDone(userId, { succeeded: false, at: this.now() });
      recordNativeConsolidation("lost");
      return "lost";
    }
    if (!task.terminal) {
      if (state.startedAt && this.now().getTime() - Date.parse(state.startedAt) > TASK_TIMEOUT_MS) {
        await this.resources.cancelTask(userId, taskId).catch(() => null);
        await this.overlay.noteConsolidationDone(userId, { succeeded: false, at: this.now() });
        recordNativeConsolidation("failed");
        return "failed";
      }
      return "submitted";
    }
    const result = task.result;
    const changed = result ? result.adds.length + result.updates.length + result.deletes.length : 0;
    if (task.status !== "completed" || !result || (result.errors.length && !changed)) {
      this.report(`native memory consolidation: ${userId.slice(0, 8)}… ${task.status}: ${(task.error ?? result?.errors?.[0] ?? "no reason given").slice(0, 160)}`);
      await this.overlay.noteConsolidationDone(userId, { succeeded: false, at: this.now() });
      recordNativeConsolidation("failed");
      return "failed";
    }
    if (result.errors.length) this.report(`native memory consolidation: ${userId.slice(0, 8)}… completed with ${result.errors.length} error(s): ${result.errors[0].slice(0, 160)}`);
    const counts = await this.ingest(userId, { taskId, adds: result.adds, updates: result.updates, deletes: result.deletes });
    // The shape of what it left, so that the next one waits for the account's files to change from it.
    const root = this.sessions.memoryRoot(userId);
    const left = (await this.sessions.tree(userId, root, { levelLimit: 8 })).filter((node) => !node.isDir && nativeMemoryFile(node.uri, root));
    await this.overlay.noteConsolidationDone(userId, { succeeded: true, fingerprint: filesFingerprint(left), at: this.now() });
    recordNativeConsolidatedFiles(counts);
    recordNativeConsolidation("completed");
    return "completed";
  }
}
