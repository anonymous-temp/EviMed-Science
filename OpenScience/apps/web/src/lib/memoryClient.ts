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

/** What 「本次不用」 can set aside in one conversation. */
export type SessionExclusionType = "memory" | "note" | "capsule" | "method";

export interface SessionExclusion {
  type: SessionExclusionType;
  /** A memory's id, a note's id, a capsule entry's id, or a method's skill name. */
  id: string;
  label: string;
}

/** One conversation's memory state: its incognito switch and what it set aside. */
export interface SessionMemoryState {
  incognito: boolean;
  excluded: SessionExclusion[];
  updatedAt?: string | null;
}

/** A memory one run of the conversation was handed, hydrated from its store. */
export interface SessionBackgroundMemory {
  type: "memory" | "note" | "capsule";
  id: string;
  kind: string;
  scope: string;
  summary: string;
  /** Gone since the run used it: still listed, and said to be gone. */
  available: boolean;
  runIds: string[];
  setAside: boolean;
  basis?: WebMemoryProvenance["basis"] | null;
  provenance?: WebMemoryProvenance | null;
  status?: string | null;
  /** A structured memory's version, for its 「不对」. */
  version?: number | null;
  /** A capsule entry's capsule and revision, for its 「不对」. */
  capsuleId?: string | null;
  revision?: number | null;
  origin?: string | null;
}

/** A method the runtime has mounted, or one an earlier run loaded. */
export interface SessionBackgroundMethod {
  /** The skill name the run sees. */
  name: string;
  label: string;
  source: "learned" | "capsule" | "earlier";
  description?: string;
  methodId?: string;
  entryId?: string;
  capsuleId?: string;
  revision?: number | null;
  status?: string | null;
  trial?: boolean;
  available?: boolean;
  /** Loaded by a run of this conversation, per the run ledger. */
  used: boolean;
  runIds: string[];
  setAside: boolean;
}

export interface SessionBackground {
  sessionId: string;
  incognito: boolean;
  excluded: SessionExclusion[];
  runs: { id: string; status: string; startedAt: string | null }[];
  memories: SessionBackgroundMemory[];
  methods: SessionBackgroundMethod[];
  /** 「本次新记下」: what this conversation wrote by itself. */
  written: MemoryChange[];
}

const sessionPath = (sessionId: string) => `/memory/sessions/${encodeURIComponent(sessionId)}`;

export function fetchSessionMemory(sessionId: string) {
  return productRequest<SessionMemoryState>(sessionPath(sessionId));
}

/** The incognito switch: nothing of this conversation is written, nothing recalled into it. */
export function setSessionIncognito(sessionId: string, incognito: boolean) {
  return productRequest<SessionMemoryState>(sessionPath(sessionId), "PUT", { incognito });
}

/** 「本次不用」: leave one item out of the rest of this conversation. */
export function setAsideForSession(sessionId: string, item: SessionExclusion) {
  return productRequest<SessionMemoryState>(`${sessionPath(sessionId)}/exclusions`, "POST", item);
}

/** Bring a set-aside item back into this conversation. */
export function bringBackForSession(sessionId: string, item: Pick<SessionExclusion, "type" | "id">) {
  return productRequest<SessionMemoryState>(`${sessionPath(sessionId)}/exclusions`, "DELETE", { type: item.type, id: item.id });
}

export function fetchSessionBackground(sessionId: string) {
  return productRequest<SessionBackground>(`${sessionPath(sessionId)}/background`);
}

/** 「不对」 on a structured memory: archived, as a revision the undo can take back. */
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
