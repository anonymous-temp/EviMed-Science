/**
 * What became of a received pack in the runs that were handed it: the last two stages of the sharing funnel (`applied`,
 * `corrected` in `capsuleShareMetrics.mjs`), counted per channel the pack reached the account by (file, delivery, link).
 *
 * Hidden knowledge:
 *
 * - **A received pack's methods are not the learned methods' path.** A learned method is counted by `methodObservations.mjs` and
 *   `methodAppliedOutcomes.mjs`, which read the account's learned-method library (`_lm…` directories) and know nothing of a pack
 *   someone else sent. A received pack's methods are listed in the conversation's methods section, each naming its mounted file
 *   (`/runtime/capsule-methods/<entry id>/SKILL.md`, `capsuleMethods.mjs`); they are not registered as skills, so there is no skill
 *   call to read. The one trace that says a run used one is the model opening that file, and this module reads exactly that, off the
 *   transcripts the terminal hook already holds, and names no learned method.
 * - **Applied is the model's own act.** A pack is handed to a run by being enabled; it is applied when the model opened one of its
 *   methods: a `read` or `grep` of the file, or a shell program that prints it (`READING_PROGRAMS`, the vocabulary the learned
 *   methods' reading uses). Once per run and pack however many of its methods were opened. A method the pack's author put in a
 *   delegation's body, which the child never opened as a file, leaves no trace and is not counted. A platform pack
 *   (`payload.official`) is the platform's own text and no share; it is never counted here.
 * - **Corrected is the researcher's, and is read from the evidence the learning loop already writes.** A correction, preference or
 *   rejection the follow-up judge or a steer recorded for a run (`isLearningCorrection`) is a correction of that run. It is not
 *   attributed to one method of the run: the judge is shown the cards of the learned methods the run opened, never a received
 *   pack's, so this says only that the run that applied the pack was then corrected. A correction recorded before the run's
 *   transcript was read (a steer typed into the run) and one recorded after are the same event, in either order.
 * - **Process memory, bounded.** The pair of run and pack is held in this process so each is counted once; a restart between a run
 *   and its follow-up drops that one pair, and the oldest are forgotten past the bound. The funnel is a gauge of use, not a ledger,
 *   and nothing is written for it: counting never changes the run, the pack or the researcher's learning.
 *
 * @module capsuleShareOutcomes
 */

import { LEARNING_EVIDENCE_TRIGGER, isLearningCorrection, isResearcherOwnedWork } from "@evimed/domain";

import { capsuleMethodDirectoryName } from "./capsuleMethods.mjs";
import { CAPSULE_SHARE_CHANNELS, recordShareApplied, recordShareCorrected } from "./capsuleShareMetrics.mjs";
import { READING_PROGRAMS } from "./methodObservations.mjs";

/** How many run-and-pack pairs and corrected runs are remembered: a bound on memory, not an opinion. */
const REMEMBERED = 4000;
/** How far the account's received packs and a pack's entries are paged: a hundred a page, a bound and not a quota. */
const PACK_PAGES = 5;
/** A mounted method's own file as a tool path names it, absolute or relative to the methods directory: the directory it is in. */
const SKILL_FILE_IN_PATH = /(?:^|\/)([^/\s'"]+)\/SKILL\.md$/;
/** The shell's separators between one program and the next. */
const SHELL_SEGMENTS = /&&|\|\||[;|\n]/;

/** @param {Map<string, unknown> | Set<string>} held @param {number} limit */
function forgetOldest(held, limit) {
  while (held.size > limit) held.delete(/** @type {string} */ (held instanceof Map ? held.keys().next().value : held.values().next().value));
}

/**
 * The files named `SKILL.md` that the sessions' completed tool calls read: the directories a `read` or `grep` was aimed at, and the
 * segments of shell commands whose program prints a file and which name a `SKILL.md`. Nothing is matched to a pack here.
 * @param {readonly any[]} sessions
 * @returns {{ directories: Set<string>, commands: string[] }}
 */
export function methodFilesRead(sessions) {
  /** @type {Set<string>} */
  const directories = new Set();
  /** @type {string[]} */
  const commands = [];
  for (const session of sessions ?? []) {
    for (const message of session?.transcript?.messages ?? []) {
      for (const part of message?.parts ?? []) {
        if (part?.type !== "tool" || part?.status !== "completed") continue;
        if (part.tool === "read" || part.tool === "grep") {
          const found = SKILL_FILE_IN_PATH.exec(String(part.input?.path ?? part.input?.file_path ?? part.input?.filePath ?? ""));
          if (found) directories.add(found[1]);
        } else if (part.tool === "bash") {
          for (const raw of String(part.input?.command ?? part.input?.cmd ?? "").split(SHELL_SEGMENTS)) {
            const words = raw.trim().replace(/^[({]+\s*/, "").split(/\s+/);
            let index = 0;
            while (index < words.length && (words[index] === "sudo" || words[index] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;
            if (raw.includes("SKILL.md") && READING_PROGRAMS.has((words[index] ?? "").split("/").pop() ?? "")) commands.push(raw);
          }
        }
      }
    }
  }
  return { directories, commands };
}

/**
 * @param {{ capsules: { documents: { list: (userId: string, kind: string, options: Record<string, any>) => Promise<{ items: any[], nextCursor?: string | null }> } },
 *   remembered?: number }} dependencies
 */
export function createReceivedPackOutcomes({ capsules, remembered = REMEMBERED }) {
  /** The packs a run applied and how the account got each: `runId\0capsuleId` → its channel and whether a correction has been counted. @type {Map<string, { runId: string, channel: string, corrected: boolean }>} */
  const applied = new Map();
  /** Runs the researcher has corrected. @type {Set<string>} */
  const corrected = new Set();

  /** @param {{ channel: string, corrected: boolean }} entry */
  const countCorrection = (entry) => {
    if (entry.corrected) return;
    entry.corrected = true;
    recordShareCorrected(entry.channel);
  };

  /**
   * The received packs of an account that one of the files read is a method of, with the channel each came by.
   * @param {string} userId @param {{ directories: Set<string>, commands: string[] }} read
   * @returns {Promise<{ id: string, channel: string }[]>}
   */
  async function appliedPacks(userId, read) {
    const opened = (/** @type {string} */ directory) => read.directories.has(directory) || read.commands.some((command) => command.includes(`${directory}/SKILL.md`));
    /** @type {{ id: string, channel: string }[]} */
    const found = [];
    /** @type {string | null} */
    let cursor = null;
    for (let pages = 0; pages < PACK_PAGES; pages += 1) {
      const page = await capsules.documents.list(userId, "capsule", { limit: 100, cursor, filter: { imported: true } });
      for (const pack of page.items) {
        const channel = String(pack.payload?.transfer?.channel ?? "");
        if (pack.payload?.official || !CAPSULE_SHARE_CHANNELS.includes(channel)) continue;
        let entryCursor = null;
        let taken = false;
        for (let entryPages = 0; entryPages < PACK_PAGES && !taken; entryPages += 1) {
          const entries = await capsules.documents.list(userId, "fact", { limit: 100, cursor: entryCursor, filter: { capsuleId: pack.id, status: "approved" }, fields: { status: true } });
          taken = entries.items.some((entry) => opened(capsuleMethodDirectoryName(entry.id)));
          entryCursor = entries.nextCursor ?? null;
          if (!entryCursor) break;
        }
        if (taken) found.push({ id: String(pack.id), channel });
      }
      cursor = page.nextCursor ?? null;
      if (!cursor) break;
    }
    return found;
  }

  return {
    /**
     * A run has finished: count each received pack whose method file its sessions opened. Never throws and never waits on anything
     * but the account's own pack list; a run that opened no method file costs nothing but the scan of its transcript.
     * @param {{ project: { userId: string }, run: { id: string, automated?: boolean, effectiveRouteReason?: string | null, effectiveAgentId?: string | null }, sessions: readonly any[], skip?: boolean }} input
     * @returns {Promise<number>} the packs counted as applied
     */
    async afterRun({ project, run, sessions, skip = false }) {
      try {
        if (skip || !isResearcherOwnedWork(run)) return 0;
        const read = methodFilesRead(sessions);
        if (!read.directories.size && !read.commands.length) return 0;
        let counted = 0;
        for (const pack of await appliedPacks(String(project.userId), read)) {
          const key = `${run.id}\u0000${pack.id}`;
          if (applied.has(key)) continue;
          const entry = { runId: String(run.id), channel: pack.channel, corrected: false };
          applied.set(key, entry);
          forgetOldest(applied, remembered);
          recordShareApplied(pack.channel);
          counted += 1;
          // A steer typed into the run was recorded while it still ran: the correction is already known.
          if (corrected.has(entry.runId)) countCorrection(entry);
        }
        return counted;
      } catch { return 0; }
    },

    /**
     * An evidence event of the learning loop was recorded (`FeedbackEvents.onRecorded`): a correction of a run that applied a pack is
     * that pack's `corrected`, counted once however often the event is recorded again.
     * @param {{ trigger?: string, runId?: string | null, detail?: unknown }} event
     */
    onEvidence(event) {
      try {
        if (event?.trigger !== LEARNING_EVIDENCE_TRIGGER || !event.runId || !isLearningCorrection(event.detail)) return;
        const runId = String(event.runId);
        corrected.add(runId);
        forgetOldest(corrected, remembered);
        for (const entry of applied.values()) if (entry.runId === runId) countCorrection(entry);
      } catch { /* a counter never decides */ }
    },
  };
}
