import { createHash } from "node:crypto";
import { PROJECT_CARD_SLOT_LABELS_ZH, SOCKET_TOOL_NAMES } from "@evimed/domain";
import { CAPSULE_PROFILE_FACT_KINDS, CAPSULE_PROFILE_MAX_TOKENS, capsuleFactMemos } from "./capsuleProfile.mjs";
import { isInternalProjectOf } from "./internalProjects.mjs";
import { recordResidentCard, recordResidentOmitted, recordResidentProfile } from "./memoryMetrics.mjs";
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
 * Two additions on 2026-10-23, both read from the plan's I1/I3:
 *
 *  - **The project's card is resident inside a project** (the owner's 「和项目连起来」 standard, which was reachable only by the
 *    model deciding to search): when a person is in a conversation of a named project (not the catch-all, not one of the
 *    platform's own), the card — field, goal, subject, material, stage, constraints, the six general slots and whatever clinical
 *    elements were stated — leads the block, within `PROJECT_CARD_MAX_CHARS`. It is the same card the memory page's 项目 tab
 *    shows, read by the same reader for either engine, handed once per conversation like the profile (it is part of what the
 *    digest is taken over) and never to a turn nobody is in (`attended`). A card that cannot be read is no reason for a
 *    dispatch to fail: the conversation goes on without it.
 *  - **A native account is handed the capsule's half** (`none("native")` used to return before the capsule was asked): the
 *    engine's own plugin hands over `profile.md` and the listing of `preferences/` and `entities/` at a session's start, and
 *    nothing of the capsule — the own capsule's profile entries, such as the notes a project's runs wrote — reached such a
 *    conversation at all. They lead no block of their own: they are the same memos the legacy profile carries after its
 *    records, under the same token cap, and the records half stays the engine's (one account, one path).
 *
 * @module residentProfile
 */

/** The most characters of the project's card a conversation is handed. */
export const PROJECT_CARD_MAX_CHARS = 1_500;

/** The project the catch-all is: it has no single subject, so it has no card (`memoryIntelligence.mjs` keeps no project fact in it). */
const CATCH_ALL_PROJECT_ID = "default";

/**
 * The project's card as one memo, the rows the memory page's 项目 tab reads (`{ slot, label?, text, updatedAt }`), one line each in
 * the card's own order and words, cut at a whole line when the next would pass `maxChars`. Null when the card says nothing.
 * @param {string} projectId @param {readonly { slot?: string, label?: string | null, text?: string, updatedAt?: string | null }[]} rows
 * @param {{ maxChars?: number }} [options]
 * @returns {{ id: string, memoryType: string, kind: string, scope: string, origin: string, content: string, updatedAt: string | null } | null}
 */
export function projectCardMemo(projectId, rows, { maxChars = PROJECT_CARD_MAX_CHARS } = {}) {
  /** @type {string[]} */
  const lines = [];
  let used = 0;
  let updatedAt = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const label = row.label ?? /** @type {Record<string, string>} */ (PROJECT_CARD_SLOT_LABELS_ZH)[String(row.slot ?? "")] ?? "";
    const line = label ? `${label}：${text}` : text;
    // A line that does not fit is cut off at the budget and ends the card: a later, shorter one is not put ahead of its elders.
    const room = maxChars - used - (lines.length ? 1 : 0);
    if (room <= 0) break;
    const kept = [...line].length <= room ? line : `${[...line].slice(0, Math.max(0, room - 1)).join("")}…`;
    lines.push(kept);
    used += [...kept].length + (lines.length > 1 ? 1 : 0);
    if (row.updatedAt && (!updatedAt || String(row.updatedAt) > updatedAt)) updatedAt = String(row.updatedAt);
    if (kept !== line) break;
  }
  if (!lines.length) return null;
  return { id: `card:${projectId}`, memoryType: "project_card", kind: "project_fact", scope: "project", origin: "explicit", content: lines.join("\n"), updatedAt };
}

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
 * The project's card leads, outside the entry cap and with room of its own in the token budget (it is the project's, not one
 * more entry of the person's profile); then the research records, then the capsule's entries. An entry that does not fit the
 * token budget is left out and a later, shorter one may still fit; the rest is counted in the line beside the profile.
 *
 * @param {{ records?: readonly any[], capsuleFacts?: readonly any[], card?: any | null, counts?: { user?: number, project?: number, session?: number }, capsuleCount?: number,
 *   maxRecords?: number, maxTokens?: number }} input
 * @returns {{ text: string, profile: string, memos: any[], omitted: number }}
 *   `profile` is the memos alone, which is what the digest is taken over: the counts beside it move with every record written.
 */
export function renderResidentProfile({ records = [], capsuleFacts = [], card = null, counts = {}, capsuleCount = 0, maxRecords = 24, maxTokens = CAPSULE_PROFILE_MAX_TOKENS }) {
  const candidates = [...records, ...capsuleFactMemos(capsuleFacts)];
  const bound = Math.max(0, Math.trunc(Number(maxRecords)) || 0);
  // Room kept for the line, so saying what was left out cannot itself break the budget.
  const reserve = estimatePromptTokens(lookupLine({ omitted: 9_999, user: 9_999, project: 9_999, session: 9_999, capsule: 9_999 }));
  /** @type {any[]} */
  const memos = card ? [card] : [];
  // The card's own room: what it takes is not taken from the profile's.
  const room = maxTokens + (card ? estimatePromptTokens(renderMemoryContext([card])) : 0);
  let entries = 0;
  for (const memo of candidates) {
    if (entries >= bound) break;
    if (estimatePromptTokens(renderMemoryContext([...memos, memo])) + reserve > room) continue;
    memos.push(memo);
    entries += 1;
  }
  const omitted = candidates.length - entries;
  const line = lookupLine({ omitted, ...counts, capsule: capsuleCount });
  const profile = renderMemoryContext(memos);
  // With no profile to give but something to look up, the line is the block.
  const text = profile ? renderMemoryContext(memos, { lookup: line }) : line;
  return { text, profile, memos, omitted };
}

export class ResidentProfiles {
  /**
   * @param {{ config: any, store: any, capsules?: { profileFacts: Function, lookupCount?: Function } | null,
   *   projectCard?: ((userId: string, projectId: string, engine: "native" | "legacy") => Promise<readonly any[]>) | null }} dependencies
   *   `store` is the research-memory store; `capsules` the capsule service, whose absence leaves the profile to the records.
   *   `projectCard` reads the rows of a project's card for the engine the account is on (the rows the memory page's 项目 tab
   *   shows); without it no card is handed over.
   */
  constructor({ config, store, capsules = null, projectCard = null }) {
    this.config = config;
    this.store = store;
    this.capsules = capsules;
    this.projectCard = projectCard;
    // `OPEN_SCIENCE_MEMORY_PROFILE_MAX_RECORDS`: the cap on how many entries the profile may carry, for the reason it has a token
    // cap — what is always present is paid for on every request, and the attention it takes is taken from the question.
    this.maxRecords = Math.max(0, Math.min(100, Math.trunc(Number(config?.memoryProfileMaxRecords ?? 24)) || 0));
  }

  /**
   * The project's card as a memo, when this dispatch is one a person is in, inside a project that has a subject of its own.
   * Any failure of the read is no card: the conversation goes on without it.
   * @param {string} userId @param {string} projectId @param {boolean} attended @param {"native" | "legacy"} engine
   */
  async #card(userId, projectId, attended, engine) {
    if (!attended || !this.projectCard || !projectId || projectId === CATCH_ALL_PROJECT_ID || isInternalProjectOf(this.config, userId, projectId)) return null;
    // Bounded: the card of a native account is a read of the engine, and a dispatch is not to wait on an engine that hangs
    // (`OPEN_SCIENCE_MEMORY_RESIDENT_CARD_TIMEOUT_MS`). A card read late is not read; the next message asks again.
    const deadline = Math.max(100, Math.trunc(Number(this.config?.memoryResidentCardTimeoutMs ?? 1_500)) || 1_500);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      const rows = await Promise.race([
        this.projectCard(userId, projectId, engine),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("the project card was not read in time"), { code: "resident_card_timeout" })), deadline); }),
      ]);
      const memo = projectCardMemo(projectId, /** @type {any} */ (rows));
      recordResidentCard(memo ? "read" : "empty");
      return memo;
    } catch (error) {
      recordResidentCard(/** @type {any} */ (error)?.code === "resident_card_timeout" ? "timeout" : "unread");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The profile for one dispatch, and whether this dispatch hands it over.
   *
   * Reads fail loudly where the dispatch's memory always did: a store that cannot answer rejects the dispatch rather than
   * sending the run out without the profile it would have had (the caller wraps it in `memoryRecallRejection`). The
   * capsule's half degrades — a capsule that cannot be read leaves the records — and so does the project's card.
   *
   * @param {string} userId @param {{ projectId: string, sessionId: string | null, attended?: boolean }} scope
   *   `attended`: a person is in this turn now (the web chat, an IM channel). A scheduled task, an episode, a module's step and
   *   a platform job are turns nobody is in, and are handed no project card.
   * @returns {Promise<{ text: string, memories: any[], due: boolean, reason: string, omitted: number, delivered: () => Promise<void> }>}
   */
  async forDispatch(userId, { projectId, sessionId, attended = false }) {
    const none = (/** @type {string} */ reason) => {
      recordResidentProfile(reason);
      return { text: "", memories: [], due: false, reason, omitted: 0, delivered: async () => {} };
    };
    // The deployment's switch, then the researcher's own: nothing of the memory is handed over, and the profile a
    // conversation was given earlier is not taken back.
    if (this.config?.memoryRecallEnabled === false) return none("paused");
    // An account on the native engine is handed its profile and preferences by the engine's memory plugin at the start of each
    // session (2026-10-13): the records half from here would be the same facts twice, from two stores. What the plugin does not
    // have is the capsule's profile entries and the project's card, and those are handed over below.
    const native = typeof this.store.memoryEngine === "function" && await this.store.memoryEngine(userId) === "native";
    const pause = await memoryPausedFor(this.store, userId, projectId, sessionId);
    if (pause.recall) return none("paused");

    const [records, counts] = native ? [[], {}] : await Promise.all([
      this.store.residentRecords(userId, { projectId, sessionId, limit: this.maxRecords }),
      this.store.lookupCounts(userId, { projectId, sessionId }),
    ]);
    const card = await this.#card(userId, projectId, attended, native ? "native" : "legacy");
    const capsuleFacts = this.capsules ? await this.capsules.profileFacts(userId, projectId, CAPSULE_PROFILE_FACT_KINDS).catch(() => []) : [];
    // The line beside the profile names the recall tool, which a native conversation does not have: its lookup is the engine's.
    const capsuleCount = !native && typeof this.capsules?.lookupCount === "function" ? await this.capsules.lookupCount(userId, projectId, CAPSULE_PROFILE_FACT_KINDS).catch(() => 0) : 0;
    const block = renderResidentProfile({ records, capsuleFacts, card, counts, capsuleCount, maxRecords: this.maxRecords });
    if (!block.text) return none(native ? "native" : "empty");
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
