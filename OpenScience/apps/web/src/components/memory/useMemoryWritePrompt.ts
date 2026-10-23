import { useEffect } from "react";
import { fetchWebMe, getWebProjectId } from "@/lib/apiClient";
import { announceMemoryChanged, fetchMemoryChanges, undoMemoryRecord, type MemoryChange } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";

/**
 * When this browser last showed the capsule, per account and project: the key names both, so two accounts in one browser, or two
 * projects of one account, never share a clock (it was one global key under a comment that said otherwise).
 */
const SEEN_KEY = "evimed.memory.seenAt";

/** The key one account's one project keeps its clock under. */
export function seenKey(userId: string, projectId: string): string {
  return `${SEEN_KEY}:${userId}:${projectId}`;
}

/** The write prompt's one line: how many, and the first two in their own words. */
export function writePromptMessage(changes: readonly MemoryChange[]): string {
  const named = changes.slice(0, 2).map((change) => `“${change.summary}”`).join("");
  return `刚记住了 ${changes.length} 条：${named}${changes.length > 2 ? ` 等 ${changes.length} 条` : ""}`;
}

/** Undo every change the prompt named, newest first, and say how it went. */
export async function undoChanges(changes: readonly MemoryChange[]): Promise<void> {
  let undone = 0;
  let failure: unknown = null;
  for (const change of changes) {
    try {
      await undoMemoryRecord(change.id, change.version);
      undone += 1;
    } catch (error) {
      failure ??= error;
    }
  }
  announceMemoryChanged();
  if (failure) toast.error(`撤销了 ${undone} 条，其余没有撤销：${productErrorMessage(failure)}`);
  else toast.success(`已撤销 ${undone} 条`);
}

/**
 * 「刚记住了 … 撤销」 on the next visit to the capsule (owner ruling
 * 2026-09-19: memory takes effect without asking, so the researcher is told
 * where they are, with the way back one click away — no modal, no
 * confirmation). The first visit only starts the clock: a prompt about
 * everything ever learned would be a list, not news.
 *
 * Every page of the capsule runs it — the overview, the map and the three lists — so landing on any of them is the visit; the clock is
 * the account's and the project's (`seenKey`), which is why the account is read first: with no account to name there is no clock to keep.
 */
export function useMemoryWritePrompt(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const projectId = getWebProjectId();
    void Promise.resolve().then(() => fetchWebMe()).then((me) => {
      const userId = me?.user.id;
      if (!active || !userId) return null;
      const key = seenKey(userId, projectId);
      const seenAt = window.localStorage.getItem(key);
      window.localStorage.setItem(key, new Date().toISOString());
      return seenAt ? fetchMemoryChanges({ since: seenAt }) : null;
    }).then((changes) => {
      if (!active || !changes || changes.length === 0) return;
      toast.success(writePromptMessage(changes), { action: { label: "撤销", onClick: () => void undoChanges(changes) } });
    }).catch(() => {
      // A prompt that cannot load is a prompt not shown; the page itself says
      // what memory holds either way.
    });
    return () => { active = false; };
  }, [enabled]);
}
