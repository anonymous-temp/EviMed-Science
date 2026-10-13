import { createHash } from "node:crypto";
import { SOCKET_TOOL_NAMES } from "@evimed/domain";
import { CAPSULE_PROFILE_FACT_KINDS, CAPSULE_PROFILE_MAX_TOKENS, capsuleFactMemos } from "./capsuleProfile.mjs";
import { recordResidentOmitted, recordResidentProfile } from "./memoryMetrics.mjs";
import { estimatePromptTokens } from "./modelGateway.mjs";
import { renderMemoryContext } from "./researchContext.mjs";
import { memoryPausedFor } from "./researchMemory.mjs";

/**
 * The resident profile: the one thing of the researcher's memory that is pushed into a conversation.
 *
 * Hidden knowledge (review M6, owner ruling of 2026-10-10). Every dispatch used to hand the model the memories the platform
 * had retrieved for the question — up to eight records and 20,000 characters, episodic and project records among them — and
 * the capsule's profile besides, and did it again at every follow-up of the same conversation. The project's own ablations
 * showed no gain from it (v8 and v9 worse, v10 and v11 inconclusive), published work finds that always-present personal
 * context costs answers that did not need it, and every product that documents its load point hands a small standing layer
 * up front and lets the model look the rest up. So:
 *
 *  - What is pushed is the standing profile only — the records of the durable kinds (profile, preference, behavior,
 *    correction) and the capsule's own profile entries, at most `maxRecords` of them and `CAPSULE_PROFILE_MAX_TOKENS` tokens in
 *    all — with one short line saying what else can be looked up, by scope.
 *  - It is pushed once: at a conversation's first dispatch, and again only when it changed, or when the kernel compacted the
 *    conversation since (a compaction takes the block out of the history it was written into). The digest of what a
 *    conversation was last handed and the compaction that came after are the conversation's own state in
 *    `evimed_memory.sessions`; a follow-up that finds the block unchanged adds nothing to the context.
 *  - Everything else is the recall tool's (`evimed_capsule_recall`): the model asks when the question points at earlier work.
 *
 * A delegated child never saw the conversation, so it is handed the profile as it stands at every dispatch
 * (`memory.md`), whether or not the root was.
 *
 * @module residentProfile
 */

/**
 * The line beside the profile: what can be looked up, by scope, for a model that would otherwise not know a recall has
 * anything to find. Empty when there is nothing, and nothing in it but counts and the tool's name.
 * @param {{ omitted?: number, user?: number, project?: number, session?: number, capsule?: number }} counts
 */
export function lookupLine({ omitted = 0, user = 0, project = 0, session = 0, capsule = 0 }) {
  const parts = [
    omitted > 0 ? `未列出的画像 ${omitted} 条` : "",
    project > 0 ? `本项目记忆 ${project} 条` : "",
    session > 0 ? `本次对话的记忆 ${session} 条` : "",
    user > 0 ? `其他记忆 ${user} 条` : "",
    capsule > 0 ? `胶囊笔记 ${capsule} 条` : "",
  ].filter(Boolean);
  return parts.length ? `可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：${parts.join("，")}。` : "";
}

/**
 * The block, within its caps.
 *
 * The research records come first, then the capsule's entries; an entry that does not fit the token budget is left out and a
 * later, shorter one may still fit; the rest is counted in the line beside the profile.
 *
 * @param {{ records?: readonly any[], capsuleFacts?: readonly any[], counts?: { user?: number, project?: number, session?: number }, capsuleCount?: number,
 *   maxRecords?: number, maxTokens?: number }} input
 * @returns {{ text: string, profile: string, memos: any[], omitted: number }}
 *   `profile` is the memos alone, which is what the digest is taken over: the counts beside it move with every record written.
 */
export function renderResidentProfile({ records = [], capsuleFacts = [], counts = {}, capsuleCount = 0, maxRecords = 24, maxTokens = CAPSULE_PROFILE_MAX_TOKENS }) {
  const candidates = [...records, ...capsuleFactMemos(capsuleFacts)];
  const bound = Math.max(0, Math.trunc(Number(maxRecords)) || 0);
  // Room kept for the line, so saying what was left out cannot itself break the budget.
  const reserve = estimatePromptTokens(lookupLine({ omitted: 9_999, user: 9_999, project: 9_999, session: 9_999, capsule: 9_999 }));
  /** @type {any[]} */
  const memos = [];
  for (const memo of candidates) {
    if (memos.length >= bound) break;
    if (estimatePromptTokens(renderMemoryContext([...memos, memo])) + reserve > maxTokens) continue;
    memos.push(memo);
  }
  const omitted = candidates.length - memos.length;
  const line = lookupLine({ omitted, ...counts, capsule: capsuleCount });
  const profile = renderMemoryContext(memos);
  // With no profile to give but something to look up, the line is the block.
  const text = profile ? renderMemoryContext(memos, { lookup: line }) : line;
  return { text, profile, memos, omitted };
}

export class ResidentProfiles {
  /**
   * @param {{ config: any, store: any, capsules?: { profileFacts: Function, lookupCount?: Function } | null }} dependencies
   *   `store` is the research-memory store; `capsules` the capsule service, whose absence leaves the profile to the records.
   */
  constructor({ config, store, capsules = null }) {
    this.config = config;
    this.store = store;
    this.capsules = capsules;
    // `OPEN_SCIENCE_MEMORY_PROFILE_MAX_RECORDS`: the cap on how many entries the profile may carry, for the reason it has a token
    // cap — what is always present is paid for on every request, and the attention it takes is taken from the question.
    this.maxRecords = Math.max(0, Math.min(100, Math.trunc(Number(config?.memoryProfileMaxRecords ?? 24)) || 0));
  }

  /**
   * The profile for one dispatch, and whether this dispatch hands it over.
   *
   * Reads fail loudly where the dispatch's memory always did: a store that cannot answer rejects the dispatch rather than
   * sending the run out without the profile it would have had (the caller wraps it in `memoryRecallRejection`). The
   * capsule's half degrades — a capsule that cannot be read leaves the records.
   *
   * @param {string} userId @param {{ projectId: string, sessionId: string | null }} scope
   * @returns {Promise<{ text: string, memories: any[], due: boolean, reason: string, omitted: number, delivered: () => Promise<void> }>}
   */
  async forDispatch(userId, { projectId, sessionId }) {
    const none = (/** @type {string} */ reason) => {
      recordResidentProfile(reason);
      return { text: "", memories: [], due: false, reason, omitted: 0, delivered: async () => {} };
    };
    // The deployment's switch, then the researcher's own: nothing of the memory is handed over, and the profile a
    // conversation was given earlier is not taken back.
    if (this.config?.memoryRecallEnabled === false) return none("paused");
    // An account on the native engine is handed its profile by the engine's memory plugin at the start of each session
    // (2026-10-13): a second copy from here would be the same facts twice, from two stores.
    if (typeof this.store.memoryEngine === "function" && await this.store.memoryEngine(userId) === "native") return none("native");
    const pause = await memoryPausedFor(this.store, userId, projectId, sessionId);
    if (pause.recall) return none("paused");

    const [records, counts] = await Promise.all([
      this.store.residentRecords(userId, { projectId, sessionId, limit: this.maxRecords }),
      this.store.lookupCounts(userId, { projectId, sessionId }),
    ]);
    const capsuleFacts = this.capsules ? await this.capsules.profileFacts(userId, projectId, CAPSULE_PROFILE_FACT_KINDS).catch(() => []) : [];
    const capsuleCount = typeof this.capsules?.lookupCount === "function" ? await this.capsules.lookupCount(userId, projectId, CAPSULE_PROFILE_FACT_KINDS).catch(() => 0) : 0;
    const block = renderResidentProfile({ records, capsuleFacts, counts, capsuleCount, maxRecords: this.maxRecords });
    if (!block.text) return none("empty");
    if (block.omitted > 0) recordResidentOmitted(block.omitted);

    const digest = createHash("sha256").update(block.profile).digest("hex");
    // A conversation whose state cannot be read (an id the store cannot hold) is handed the profile and not recorded as
    // having been: it is the safe direction, and the next dispatch asks again.
    /** @type {{ digest: string | null, compactedSince: boolean } | null} */
    let state = null;
    if (sessionId) {
      try { state = await this.store.residentState(userId, projectId, sessionId); }
      catch (error) {
        if (/** @type {any} */ (error)?.code !== "memory_session_invalid") throw error;
      }
    }
    const reason = !state || state.digest === null ? "first"
      : state.digest !== digest ? "changed"
        : state.compactedSince ? "compacted" : "unchanged";
    const due = reason !== "unchanged";
    recordResidentProfile(reason);
    const memories = block.memos;
    return {
      text: block.text, memories, due, reason, omitted: block.omitted,
      // After the prompt that carried it was accepted, so a dispatch that failed leaves the next one to hand it over.
      delivered: async () => {
        if (!due) return;
        if (state && sessionId) await this.store.noteResidentDelivered(userId, projectId, sessionId, digest).catch(() => {});
        const used = memories.map((memo) => /^record:(.+)$/.exec(String(memo.id))?.[1]).filter(Boolean);
        if (used.length && typeof this.store.noteRecordUsage === "function") void Promise.resolve(this.store.noteRecordUsage(userId, used)).catch(() => {});
      },
    };
  }
}
