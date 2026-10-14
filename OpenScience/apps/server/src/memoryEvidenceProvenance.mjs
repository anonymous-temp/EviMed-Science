import { dispatchedRequestIdsOf, isPlatformStartedRun } from "./memoryDispatch.mjs";
import { memorySourceRejection } from "./memoryIntelligence.mjs";

/**
 * Whose words a stored memory's evidence is: the person's, the assistant's, or something the platform sent.
 *
 * Hidden knowledge: a record keeps, for each observation, the message it quoted as `sessions/<conversation>/messages/seq_<n>` —
 * where the message is, not who said it. Reading older memories again (`memoryReview.mjs`) needs the second fact for the two
 * classes extraction wrote until 2026-10-14 and refuses now: a memory resting on what the assistant said, and a memory resting
 * on an instruction the platform dispatched (a scheduled task reuses one conversation, so its template was quoted as the
 * person's habit). Both are structural, so both are decided here from the run ledger and the stored transcripts — the
 * requests the platform sent (`memoryDispatch.mjs`), the message's role and its own request id — and never from its wording.
 *
 * Every answer is one of `person`, `assistant`, `dispatched` or `unknown`. `unknown` is the honest one: a transcript older than
 * its retention, a conversation of another project, a message id of another shape. A memory with any `person` or `unknown`
 * observation is never decided here; it is the model's to read, or it stays.
 *
 * @module memoryEvidenceProvenance
 */

/** @typedef {"person" | "assistant" | "dispatched" | "unknown"} EvidenceVoice */

const REF = /^sessions\/([^/]+)\/messages\/seq_(\d+)$/;

/**
 * @param {{
 *   projectsFor: (userId: string, scopeId: string | null) => Promise<any[]>,
 *   runIndex: (project: any) => Promise<Map<string, any[]>>,
 *   readTranscript: (project: any, runId: string) => Promise<{ messages: any[] } | null>,
 * }} dependencies
 *   `projectsFor`: the projects that may hold a memory's conversations — the one a project-scoped memory belongs to, else all
 *   of the account's. `runIndex`: every conversation of a project with its runs (`AgentRunStore.conversationIndex`).
 *   `readTranscript`: a run's stored transcript, whole conversation included (`readRunTranscript`).
 * @returns {(userId: string, record: { scope?: string, scopeId?: string, evidence?: readonly { sourceRef?: string }[] }) => Promise<EvidenceVoice[]>}
 *   One answer per evidence entry, in order. Holds its reads for its own lifetime: make one per reading.
 */
export function createEvidenceProvenance({ projectsFor, runIndex, readTranscript }) {
  /** @type {Map<string, Promise<any[]>>} */
  const projects = new Map();
  /** @type {Map<string, Promise<Map<string, any[]>>>} */
  const indexes = new Map();
  /** @type {Map<string, Promise<{ runs: any[], dispatched: Set<string>, onlyPlatform: boolean, bySeq: Map<number, any>, unread: any[] }>>} */
  const conversations = new Map();

  /** @param {string} userId @param {string | null} scopeId */
  const projectsOf = (userId, scopeId) => {
    const key = `${userId}\u0000${scopeId ?? ""}`;
    if (!projects.has(key)) projects.set(key, projectsFor(userId, scopeId).catch(() => []));
    return /** @type {Promise<any[]>} */ (projects.get(key));
  };

  /** @param {any} project */
  const indexOf = (project) => {
    if (!indexes.has(project.id)) indexes.set(project.id, runIndex(project).catch(() => new Map()));
    return /** @type {Promise<Map<string, any[]>>} */ (indexes.get(project.id));
  };

  /** The conversation's runs wherever it lives, with the requests the platform sent into it. @param {string} userId @param {string | null} scopeId @param {string} sessionId */
  function conversationOf(userId, scopeId, sessionId) {
    const key = `${userId}\u0000${scopeId ?? ""}\u0000${sessionId}`;
    if (!conversations.has(key)) {
      conversations.set(key, (async () => {
        for (const project of await projectsOf(userId, scopeId)) {
          const runs = (await indexOf(project)).get(sessionId);
          if (runs?.length) {
            return { project, runs, dispatched: dispatchedRequestIdsOf(runs), onlyPlatform: runs.every(isPlatformStartedRun), bySeq: new Map(), unread: [...runs] };
          }
        }
        return { project: null, runs: [], dispatched: new Set(), onlyPlatform: false, bySeq: new Map(), unread: [] };
      })());
    }
    return /** @type {Promise<any>} */ (conversations.get(key));
  }

  /** Reads stored transcripts, newest run first, until the message is found or none is left. @param {any} conversation @param {string} sessionId @param {number} seq */
  async function messageAt(conversation, sessionId, seq) {
    while (!conversation.bySeq.has(seq) && conversation.unread.length) {
      const run = conversation.unread.shift();
      const transcript = await readTranscript(conversation.project, run.id).catch(() => null);
      for (const message of transcript?.messages ?? []) {
        if (message?.sessionId === sessionId && Number.isSafeInteger(message.seq) && !conversation.bySeq.has(message.seq)) conversation.bySeq.set(message.seq, message);
      }
    }
    return conversation.bySeq.get(seq) ?? null;
  }

  return async function evidenceProvenance(userId, record) {
    const scopeId = record.scope === "project" && record.scopeId ? record.scopeId : null;
    /** @type {EvidenceVoice[]} */
    const voices = [];
    for (const entry of record.evidence ?? []) {
      const found = REF.exec(String(entry?.sourceRef ?? ""));
      if (!found) { voices.push("unknown"); continue; }
      const sessionId = found[1];
      const conversation = await conversationOf(userId, scopeId, sessionId);
      if (!conversation.runs.length) { voices.push("unknown"); continue; }
      const message = await messageAt(conversation, sessionId, Number(found[2]));
      if (message) {
        if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") voices.push("unknown");
        else if (message.role !== "user") voices.push("assistant");
        else if (typeof message.sourceRequestId === "string" && conversation.dispatched.has(message.sourceRequestId)) voices.push("dispatched");
        // Platform text in the user slot (a brief, a recalled memory, a continuation) is the platform's, by the sender it records.
        else if (memorySourceRejection(message) === "injected") voices.push("dispatched");
        else voices.push("person");
        continue;
      }
      // No stored transcript says who wrote it. A conversation in which the platform alone ever started a turn holds no
      // sentence of a person's, so what a memory quoted from it was a dispatch; any other conversation stays undecided.
      voices.push(conversation.onlyPlatform ? "dispatched" : "unknown");
    }
    return voices;
  };
}
