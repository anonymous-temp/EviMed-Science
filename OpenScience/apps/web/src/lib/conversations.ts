import type { WebAgentRun } from "@/lib/apiClient";
import { runMoment } from "@/lib/runPresentation";

/**
 * A conversation as the sidebar lists it: every run the ledger recorded for
 * one kernel session, as one row.
 *
 * The ledger records a run per dispatched turn, so a conversation with a
 * follow-up question was two rows of nearly one title, both highlighted when
 * it was open (production, 2026-09-24). A list of conversations — DSH's own,
 * ChatGPT's, Claude's — has one row per conversation.
 *
 * - `lead`: the newest run — its time dates the row, and it is what 「未打开」
 *   and 「进行中」 are read from (any run working counts as working).
 * - `titleRun`: the run whose title names the conversation — the one a
 *   researcher renamed by hand, else the first, whose question opened it.
 */
export interface Conversation {
  sessionId: string;
  /** Newest first. */
  runs: WebAgentRun[];
  lead: WebAgentRun;
  titleRun: WebAgentRun;
}

function started(run: WebAgentRun): number {
  const at = Date.parse(run.createdAt ?? run.startedAt ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/** One entry per session, newest activity first. */
export function groupConversations(runs: readonly WebAgentRun[]): Conversation[] {
  const bySession = new Map<string, WebAgentRun[]>();
  for (const run of runs) {
    const list = bySession.get(run.sessionId);
    if (list) list.push(run);
    else bySession.set(run.sessionId, [run]);
  }
  const conversations: Conversation[] = [];
  for (const [sessionId, list] of bySession) {
    const newest = [...list].sort((a, b) => runMoment(b) - runMoment(a));
    const first = [...list].sort((a, b) => started(a) - started(b))[0];
    const titleRun = list.find((run) => run.titleSource === "user") ?? first;
    conversations.push({ sessionId, runs: newest, lead: newest[0], titleRun });
  }
  return conversations.sort((a, b) => runMoment(b.lead) - runMoment(a.lead));
}
