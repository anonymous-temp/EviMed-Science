import type { WebAgentRun } from "./apiClient";
import { runQuestion } from "./runPresentation";

/**
 * The name each conversation was last listed under, by its session id.
 *
 * Fed by every read of a run ledger (`listWebAgentRuns`). The sidebar reads
 * the ledgers of the projects it shows every twenty seconds, so the
 * conversation someone clicks has almost always been listed already, and the
 * conversation surface can name the one it is opening — 「标题 · 正在打开…」
 * (UI plan §2.2) — without a read of its own. Memory only: a conversation it
 * has no name for is opened without one.
 */
const titles = new Map<string, string>();

/** Remembers the name of each conversation a ledger read lists: the first run listed for it, the ledger's newest. */
export function rememberConversationTitles(runs: readonly WebAgentRun[]): void {
  const named = new Set<string>();
  for (const run of runs) {
    if (!run.sessionId || named.has(run.sessionId)) continue;
    const title = run.title?.trim() || runQuestion(run);
    if (!title) continue;
    named.add(run.sessionId);
    titles.set(run.sessionId, title);
  }
}

/** The name a conversation was last listed under, or null. */
export function conversationTitle(sessionId: string | null | undefined): string | null {
  return sessionId ? titles.get(sessionId) ?? null : null;
}
