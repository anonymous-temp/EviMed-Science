/**
 * The memory capsule's own client: what the 2026-09-20 capsule work added to
 * the memory and capsule APIs. Kept apart from `apiClient.ts`, which every
 * surface of the shell edits, so the capsule's calls change in one place.
 *
 * Every call goes through `productRequest`, which already speaks the
 * `{ data }` envelope, the CSRF header and the error dictionary.
 */
import type { WebMemoryProvenance, WebStructuredMemory } from "./apiClient";
import { productRequest, type CapsuleEntry, type CapsuleRecord, type CapsuleScanResult } from "./productClient";

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

/**
 * A conversation's own memory state, and the panel that read it, are gone
 * (2026-09-20). 无痕, 「本次不用」 and 「本次用到的背景」 were three controls on
 * one grey bar above every conversation, over a thing the platform is supposed
 * to handle itself; the account-level switch on the memory page is what remains.
 */

/** 「忘记」 on a memory: archived, as a revision the undo can take back. */
export function archiveMemoryRecord(id: string, expectedVersion: number) {
  return productRequest<WebStructuredMemory>(`/memory/records/${encodeURIComponent(id)}`, "PATCH", { status: "archived", expectedVersion });
}

/** 「不对」 on a learned method: retired, and restorable by rolling back to the revision before. */
export function retireLearnedMethod(methodId: string, expectedRevision: number) {
  return productRequest<{ id: string; revision: number }>(`/methods/${encodeURIComponent(methodId)}/retire`, "POST",
    { expectedRevision, reason: "在对话中被标为不对" });
}

export function restoreLearnedMethod(methodId: string, expectedRevision: number, targetRevision: number) {
  return productRequest<{ id: string; revision: number }>(`/methods/${encodeURIComponent(methodId)}/rollback`, "POST",
    { expectedRevision, targetRevision });
}

/** 「不对」 on a capsule entry: retired, as a revision the entry's undo can take back. */
export function retireCapsuleEntry(capsuleId: string, entryId: string, expectedRevision: number) {
  return productRequest<CapsuleEntry>(`/capsules/${encodeURIComponent(capsuleId)}/entries/${encodeURIComponent(entryId)}`, "PATCH",
    { expectedRevision, status: "retired" });
}

/** A capsule entry as the combined read returns it: with the project it was noted in. */
export type OwnCapsuleEntry = CapsuleEntry & { projectId?: string | null };

/** 「我的记忆胶囊」, read as one: the account capsule and every capsule of the researcher's own. */
export interface MyCapsule {
  capsule: CapsuleRecord | null;
  capsules: { id: string; title: string; projectId: string | null; revision: number }[];
  entries: OwnCapsuleEntry[];
}

export function fetchMyCapsule() {
  return productRequest<MyCapsule>("/capsules/mine");
}

/** The account capsule, made on first use; where an entry written on the capsule page goes. */
export function ensureMyCapsule() {
  return productRequest<CapsuleRecord>("/capsules/mine", "POST");
}

/*
 * The timeline read (`/memory/timeline`) is gone from the page with the
 * 「最近变化」 block it fed (2026-09-23 plan §5.6): a method's history is its
 * row's own 「历史版本」, a memory's is its revisions, and a list of back-office
 * events above the list said the same thing twice.
 */

/** A pack someone shared, as the received shelf shows it. */
export interface ReceivedCapsule {
  id: string;
  revision: number;
  title: string;
  description: string;
  issuerTrust: "verified" | "unverified" | string;
  importedAt: string | null;
  /** In force account-wide or for this project. */
  enabled: boolean;
  /** Approved entries by kind. */
  counts: Record<string, number>;
  /** The first few methods, in their own words. */
  methods: string[];
  /** A pack imported before whole-pack trust is scanned the first time it is enabled or tried. */
  scanned: boolean;
  waiting: number;
  scan: Pick<CapsuleScanResult, "model" | "checkedAt" | "dropped"> | null;
}

export function fetchReceivedCapsules() {
  return productRequest<ReceivedCapsule[]>("/capsules/received");
}

/** One click in: account-wide, as a reference. */
export function enableReceivedCapsule(id: string) {
  return productRequest<ReceivedCapsule | null>(`/capsules/${encodeURIComponent(id)}/enable`, "POST", {});
}

/** One click out: the pack stops contributing anything. */
export function disableCapsule(id: string) {
  return productRequest<{ disabled: true; lists: number }>(`/capsules/${encodeURIComponent(id)}/disable`, "POST", {});
}

/** Mark a new conversation as a trial of the pack; the conversation then opens under that id. */
export function startCapsuleTrial(id: string, sessionId: string) {
  return productRequest<{ capsuleId: string; sessionId: string }>(`/capsules/${encodeURIComponent(id)}/trial`, "POST", { sessionId });
}
