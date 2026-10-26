import { recordObservationPromotion } from "./nativeMemoryMetrics.mjs";
import { memoryLines, normalisedStatement } from "./nativeMemoryOverlay.mjs";

/**
 * E3: a choice made in two different conversations becomes a preference (owner decision 6 of 2026-10-25, which amended principle 18).
 *
 * The language judgement stays with the engine; the counting is code. A choice the person made inside a request and never called a rule
 * (a pivot table in a budget, APA for references) is written by the engine's `observations` template as a note — one file per choice,
 * one line per conversation that showed it (`memory-templates-src/observations.yaml`). Nothing reads a note as a fact: it is not in
 * `MEMORY_SEGMENT_OF_TYPE`, so `nativeMemoryFile` answers null for it and the page's list, the map, search, the resident block, recall
 * through the gateway, the export and 「与你相关」 never see it, and the gateway hides its directory from the engine's own recall.
 *
 * What this module decides is whether a note was written from two different conversations: the distinct platform conversations among the
 * engine revisions of one observation file (`overlay.conversationOf`: the plugin's session `dsh-<conversation>`, or a replay of a failed
 * extraction traced back to the conversation it replays — a replay is one conversation, not a second). Two commits of one conversation
 * (the control plane commits after each attended turn) are one conversation. When two conversations wrote a file it is promoted: its words go to the
 * engine as the person's explicit request to keep the choice (`NativeMemoryStore.keepRepeatedChoice`: the same path as 「记住这一条」, so
 * the templates and the never-kept rules apply a second time and the engine writes the preference), then the note is removed. The preference is
 * an ordinary memory: the page lists it, the drawer says 「你在两次对话里都这样做」, forgetting it is one click with its undo, and a preference
 * the person forgot is not learned again (the rejection list holds for it as for any line).
 *
 * Counting by file is what the template shape buys: the engine merges the same observation into the same file when the extractor reuses its
 * topic (measured by the replay of `c22` and `e3b` in `evals/memory-write-quality`). When it writes a second file for the same choice
 * the two stay at one conversation each and nothing is promoted: the failure leaves the person without a preference they could have had,
 * and never with one they did not choose. Retention stays unset (owner decision 6): an unpromoted note is kept.
 *
 * @module nativeMemoryObservations
 */

/** How many different conversations make a repeated choice. */
export const CONVERSATIONS_TO_PROMOTE = 2;
/** The most notes one pass promotes, and the longest words handed over. */
const MAX_PER_PASS = 5;
const MAX_WORDS = 600;

/**
 * The distinct conversations among the engine revisions of one file that wrote it (an addition or an update, not undone).
 * @param {readonly any[]} revisions a file's revisions
 * @param {(revision: any) => Promise<string | null>} conversationOf
 * @returns {Promise<Set<string>>}
 */
export async function conversationsThatWrote(revisions, conversationOf) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const revision of revisions) {
    if (revision.actor !== "engine" || !["added", "updated"].includes(revision.change) || revision.undoneAt || !revision.engineSession) continue;
    const conversation = await conversationOf(revision);
    if (conversation) found.add(conversation);
  }
  return found;
}

/**
 * What an observation file says, as the words handed to the engine: its statements, each without a bullet or an as-of date, joined, at most
 * `MAX_WORDS` characters. Empty when the file holds none.
 * @param {string} body
 */
export function observationWords(body) {
  /** @type {string[]} */
  const kept = [];
  for (const line of memoryLines(body)) {
    const text = line.replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/i, "").trim();
    if (!text || kept.some((held) => normalisedStatement(held) === normalisedStatement(text))) continue;
    kept.push(text);
  }
  return kept.join("；").slice(0, MAX_WORDS);
}

export class NativeMemoryObservations {
  /**
   * @param {{ overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
   *   sessions: import("./openVikingSessions.mjs").OpenVikingSessions,
   *   keepRepeatedChoice: (userId: string, choice: string) => Promise<{ archiveUri: string }>,
   *   memorySettings?: { settings: (userId: string) => Promise<{ learningPaused?: boolean }> } | null,
   *   report?: (line: string) => void }} dependencies
   *   `keepRepeatedChoice` is `NativeMemoryStore.keepRepeatedChoice`; `memorySettings` says whether the account paused learning, in which
   *   case nothing is promoted (a paused account is not written to).
   */
  constructor({ overlay, sessions, keepRepeatedChoice, memorySettings = null, report = () => {} }) {
    this.overlay = overlay;
    this.sessions = sessions;
    this.keepRepeatedChoice = keepRepeatedChoice;
    this.memorySettings = memorySettings;
    this.report = report;
  }

  /**
   * Promote every note of the account that two different conversations wrote. Never throws: a note that cannot be promoted now stays and is
   * looked at again at the next commit.
   * @param {string} userId @returns {Promise<{ checked: number, promoted: number, paused: boolean }>}
   */
  async promote(userId) {
    const result = { checked: 0, promoted: 0, paused: false };
    try {
      if (this.memorySettings) {
        const settings = await this.memorySettings.settings(userId);
        if (settings?.learningPaused) { result.paused = true; return result; }
      }
      for (const file of await this.overlay.observationFiles(userId)) {
        if (result.promoted >= MAX_PER_PASS) break;
        result.checked += 1;
        const revisions = await this.overlay.revisionsOf(userId, file.uri, { limit: 200 });
        const conversations = await conversationsThatWrote(revisions, (revision) => this.overlay.conversationOf(userId, revision.engineSession, revision.archiveUri));
        if (conversations.size < CONVERSATIONS_TO_PROMOTE) continue;
        const body = await this.sessions.read(userId, file.uri);
        if (body === null) { await this.overlay.removeFile(userId, file.uri); continue; }
        const words = observationWords(body);
        if (!words) { recordObservationPromotion("empty"); continue; }
        await this.keepRepeatedChoice(userId, words);
        // The note is spent once the engine has the words (a failed extraction is replayed from its archive, as any commit's is).
        await this.sessions.remove(userId, file.uri);
        await this.overlay.addRevision({ userId, uri: file.uri, memoryType: "observations", change: "deleted", actor: "platform", reason: "promoted to a preference",
          before: body, after: null, projectId: null });
        await this.overlay.removeFile(userId, file.uri);
        result.promoted += 1;
        recordObservationPromotion("promoted");
      }
    } catch (error) {
      recordObservationPromotion("failed");
      this.report(`native memory observations: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
    }
    return result;
  }
}
