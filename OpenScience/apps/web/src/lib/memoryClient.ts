/**
 * The memory capsule's own client: what the 2026-09-20 capsule work added to
 * the memory and capsule APIs. Kept apart from `apiClient.ts`, which every
 * surface of the shell edits, so the capsule's calls change in one place.
 *
 * Every call goes through `productRequest`, which already speaks the
 * `{ data }` envelope, the CSRF header and the error dictionary.
 */
import type { WebMemoryProvenance, WebStructuredMemory } from "./apiClient";
import { productRequest, type CapsuleEntry } from "./productClient";

/** One memory that changed by itself — a line of the write prompt 「刚记住了…」. */
export interface MemoryChange {
  id: string;
  key: string;
  kind: string;
  scope: string;
  scopeId: string;
  summary: string;
  status: string;
  change: "created" | "updated";
  changedAt: string | null;
  /** The version the one-click undo names. */
  version: number;
  provenance?: WebMemoryProvenance;
  /** The fact this one replaced, when it replaced one. */
  replaced?: { id: string; summary: string };
}

/** What changed by itself since a moment, optionally only in one conversation. */
export function fetchMemoryChanges({ since, sessionId }: { since: string; sessionId?: string | null }): Promise<MemoryChange[]> {
  const query = new URLSearchParams({ since });
  if (sessionId) query.set("sessionId", sessionId);
  return productRequest<MemoryChange[]>(`/memory/changes?${query.toString()}`);
}

/** Undo the last change to one memory; undoing its creation removes it. */
export function undoMemoryRecord(id: string, expectedVersion: number) {
  return productRequest<{ undone: "restored" | "removed"; record: WebStructuredMemory | null; restored: WebStructuredMemory[] }>(
    `/memory/records/${encodeURIComponent(id)}/undo`, "POST", { expectedVersion },
  );
}

/** Undo the last change to one capsule entry; undoing its creation removes it. */
export function undoCapsuleEntry(capsuleId: string, entry: Pick<CapsuleEntry, "id" | "revision">) {
  return productRequest<{ undone: "restored" | "removed"; entry: CapsuleEntry }>(
    `/capsules/${encodeURIComponent(capsuleId)}/entries/${encodeURIComponent(entry.id)}/undo`, "POST",
    { expectedRevision: entry.revision },
  );
}

/** Said on `window` whenever a capsule surface changed a memory, so another
 *  surface on screen reloads instead of showing what was just undone. */
export const MEMORY_CHANGED_EVENT = "evimed.memory.changed";

export function announceMemoryChanged() {
  window.dispatchEvent(new Event(MEMORY_CHANGED_EVENT));
}
