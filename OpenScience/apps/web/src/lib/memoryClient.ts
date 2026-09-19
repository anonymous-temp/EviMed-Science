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
  /** The shared capsule this conversation is trying (「试用一次」), if any. */
  trialCapsuleId?: string | null;
  trialCapsule?: { id: string; title: string | null };
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

/** One event of 「时间轴」, as codes and the stored words; the page says it in Chinese. */
export interface TimelineEvent {
  id: string;
  at: string;
  /** The calendar day in the researcher's zone. */
  day: string;
  type: "memory" | "run" | "method" | "feedback";
  change: string;
  before?: string;
  after?: string;
  by?: string;
  runId?: string | null;
  recordId?: string;
  kind?: string | null;
  scope?: string;
  origin?: string | null;
  basis?: WebMemoryProvenance["basis"] | null;
  /** 「曾经如此」: a fact that held until another replaced it. */
  wasTrue?: boolean;
  replacedBy?: string;
  title?: string;
  recalled?: number;
  methods?: number;
  methodId?: string;
  name?: string;
  reason?: string;
}

export interface TimelineDensity {
  day: string;
  memory: number;
  run: number;
  method: number;
  feedback: number;
}

export interface MemoryTimelinePage {
  items: TimelineEvent[];
  nextBefore: string | null;
  density: TimelineDensity[];
  timeZone: string;
  /** Sources that could not be read for this page. */
  missing: string[];
}

export function fetchMemoryTimeline({ before = null, limit = 50 }: { before?: string | null; limit?: number } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) query.set("timeZone", zone);
  } catch {
    // The server's default zone answers instead.
  }
  return productRequest<MemoryTimelinePage>(`/memory/timeline?${query.toString()}`);
}

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
