import { useEffect } from "react";
import { announceMemoryChanged, fetchMemoryChanges, undoMemoryRecord, type MemoryChange } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";

/** When this browser last showed the capsule, per account and project. */
const SEEN_KEY = "evimed.memory.seenAt";

/** The write prompt's one line: how many, and the first two in their own words. */
export function writePromptMessage(changes: readonly MemoryChange[]): string {
  const named = changes.slice(0, 2).map((change) => `「${change.summary}」`).join("");
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
 */
export function useMemoryWritePrompt(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const now = new Date().toISOString();
    const seenAt = window.localStorage.getItem(SEEN_KEY);
    window.localStorage.setItem(SEEN_KEY, now);
    if (!seenAt) return undefined;
    void fetchMemoryChanges({ since: seenAt }).then((changes) => {
      if (!active || changes.length === 0) return;
      toast.success(writePromptMessage(changes), { action: { label: "撤销", onClick: () => void undoChanges(changes) } });
    }).catch(() => {
      // A prompt that cannot load is a prompt not shown; the page itself says
      // what memory holds either way.
    });
    return () => { active = false; };
  }, [enabled]);
}
