import { knownErrorCodeMessage } from "@evimed/domain";
import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export type SourceStatus = "queued" | "parsing" | "complete" | "needs_attention" | "failed" | "missing" | "canceled";
export type SourceDepth = "skip" | "index_only" | "structured" | "deep";
export interface SourceAnchor {
  sourceId: string;
  generation: number;
  unitId: string;
  start: number;
  end: number;
  quote: string;
}
export interface SourceUnderstanding {
  id: string;
  sourceId: string;
  generation: number;
  docType: string;
  depth: SourceDepth;
  schemaVersion: 1;
  createdAt: string;
  run: { id: string; sessionId: string; dispatchId: string } | null;
  usage: {
    currency: "CNY";
    modelId: string;
    providerId: string;
    actualCost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  summary: string;
  slots: Record<string, { state: "known"; value: string; evidence: SourceAnchor[] } | { state: "unknown"; reason: string }>;
  claims: Array<{ id: string; statement: string; evidence: SourceAnchor[] }>;
  methods: Array<{
    id: string;
    title: string;
    description: string;
    whenToUse: string;
    steps: string[];
    checks: string[];
    pitfalls: string[];
    evidence: SourceAnchor[];
    status: "draft";
  }>;
  // The contract now delivers a real verdict. A record written before the audit
  // existed, and any run that did not audit, still projects as `not_run`.
  omissionAudit:
    | { status: "not_run"; reason?: string; omissionRate: null }
    | { status: "audited"; reason?: string; omissionRate: number | null;
        samples: Array<{ unitId: string; represented: boolean; note?: string }> };
  units: Array<{ id: string; unitType: "chunk"; start: number; end: number; text: string; status: string }>;
}
export interface SourceUnderstandingResult {
  sourceId: string;
  generation: number;
  depth: SourceDepth;
  status: SourceStatus;
  current: SourceUnderstanding | null;
}
/** The bounded omission notice `sourceOmissionRecord` keeps on the source row.
 *
 * A metric and nothing else: `sourceUnderstandingOmissionNotice` returns
 * `blocking:false` and appears in no issue list, so nothing built on this can
 * refuse a delivery — the targets it compares against have never been checked
 * against an observed distribution of real sources. `disagreements` are the
 * control plane's own English diagnostics, capped at five lines; the UI states
 * them as a count in Chinese and keeps the raw lines for support only. */
export interface SourceOmissionNotice {
  status: string;
  omissionRate: number | null;
  reportedRate: number | null;
  target: number;
  withinTarget: boolean;
  audited: number;
  planned: number;
  disagreements: string[];
}
export interface SourcePayload {
  paths: string[];
  status: SourceStatus;
  docType: string;
  depth: SourceDepth;
  version: number;
  familyId?: string;
  generation?: number;
  analysis?: { phase?: string };
  omissionAudit?: { status: string; reason?: string; omissionRate: number | null };
  omissionNotice?: SourceOmissionNotice | null;
  reasons: string[];
  valueVector: Record<string, number>;
  coverage: null | {
    total: number; accounted: number; accountedPercent?: number; extracted: number; indexedOnly: number; noContent: number;
    failed: number; percent: number; omissionRate: number | null; parserFailureRate?: number;
  };
  outputs: { summary?: string; facts?: number; methods?: number; artifactPath?: string };
  // `message` is the control plane's own English literal — `recordFailure` is
  // called with "Source analysis failed." for every failure, so it carries no
  // information and cannot be shown. `code` is the fact; `@evimed/domain` is
  // the one place that turns a code into a sentence a researcher reads.
  error?: { code: string; message: string } | null;
}

/**
 * What to tell a researcher about a stored source failure.
 *
 * One function, because a source failure is rendered in three places — the card,
 * the understanding panel's empty state, and a folder whose sync is failing —
 * and three call sites inventing three sentences is how the run ledger ended up
 * with five competing error dictionaries.
 *
 * `knownErrorCodeMessage` rather than `errorCodeMessage` because this caller has
 * a better fallback than the generic one: it already knows the failure is a
 * source analysis failure, so the generic 「这次没有完成…」 opener would repeat
 * what the surrounding sentence just said. The registry stays the only place a
 * code becomes a sentence; only the not-yet-translated case is local.
 *
 * The stored `message` is never used: `recordFailure` is called with the literal
 * English "Source analysis failed." for every failure, so it is the same string
 * every time and it is not in the interface language.
 *
 * NOTE: the source pipeline's own codes (`source_parser_*`,
 * `source_understanding_*`, `source_ingestion_failed`, `document_parser_*`) are
 * in neither `ALL_ERROR_CODES` nor any family regex today, so most real
 * failures land on the fallback below. That is a registry gap, not a reason for
 * a fourth table here.
 */
export function sourceFailureMessage(error?: { code: string; message?: string } | null): string | null {
  if (!error?.code) return null;
  return knownErrorCodeMessage(error.code)
    ?? `本版本还没有为这个原因准备说明。把这个代号交给管理员即可定位：${error.code}`;
}

export function getSourceUnderstanding(id: string) {
  return productRequest<SourceUnderstandingResult>(`/sources/${encodeURIComponent(id)}/understanding`);
}
export function listSourceUnderstandingHistory(id: string, cursor?: string | null) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return productRequest<ProductPage<SourceUnderstanding>>(`/sources/${encodeURIComponent(id)}/understanding/history?${query}`);
}
export type SourceRecord = ProductRecord<SourcePayload> & { projectId: string };
export interface OpenListEntry {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  entryType: "file" | "dir";
  providerHash: string | null;
}

export function listSources(projectId: string, { status = "" }: { status?: string } = {}) {
  const query = new URLSearchParams({ projectId });
  if (status) query.set("status", status);
  return productRequest<ProductPage<SourceRecord>>(`/sources?${query}`);
}
export function overrideSource(id: string, input: { expectedRevision: number; docType: string; depth: string; reason: string }) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}`, "PATCH", input);
}
export function retrySource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}/retry`, "POST", { expectedRevision });
}
export function cancelSource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}/cancel`, "POST", { expectedRevision });
}
export function removeSource(id: string, expectedRevision: number) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}`, "DELETE", { expectedRevision });
}
export interface SourceFamily {
  sourceId: string;
  familyId: string | null;
  currentVersion: number | null;
  items: SourceRecord[];
  nextCursor: string | null;
}
export interface SourceFolderSync {
  at: string;
  run: number;
  startPage: number;
  endPage: number;
  complete: boolean;
  scanned: number;
  registered: number;
  updated: number;
  unchanged: number;
  directories: number;
  tracked: number;
  // `skipped` and `removedPaths` are bounded example lists; the counts are the
  // totals. A run that skipped five hundred entries names twenty of them.
  skipped: Array<{ path: string; reason: string }>;
  skippedCount: number;
  removedPaths: string[];
  removedCount: number;
  removalCheck: "full" | "partial";
}
export interface SourceFolderPayload {
  recordType: "source-folder";
  connector: { type: string; id: string };
  status: "active" | "paused";
  recursive: false;
  sync: { run: number; page: number };
  entries: Record<string, { providerHash: string; sourceId: string; version: number; size: number }>;
  lastSync: SourceFolderSync | null;
  // `lastSync` is written only on the success path, so a folder whose sync keeps
  // failing shows its last *successful* run forever and reads as healthy, and a
  // folder the service paused shows a bare 「已暂停」 with no reason. This is the
  // one field that says otherwise. Optional and absent-tolerant on purpose:
  // folder records written before it existed will not carry it, and the server
  // side that writes it lands separately (see the handoff note in the review).
  lastError?: { code: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}
export type SourceFolderRecord = ProductRecord<SourceFolderPayload> & { projectId: string };
export type DuplicateGroupKind = "version-family" | "shared-content" | "similar-name";
export interface DuplicateMember {
  sourceId: string;
  version: number;
  familyId: string | null;
  status: SourceStatus;
  docType: string;
  paths: string[];
  size: number;
  sha256: string | null;
  connectorType: string | null;
  updatedAt: string;
}
export interface DuplicateGroup {
  kind: DuplicateGroupKind;
  groupKey: string;
  label: string;
  members: DuplicateMember[];
  sourceIds: string[];
  decision: { decision: "linked" | "dismissed"; note: string; at: string } | null;
}

export function getSourceFamily(id: string) {
  return productRequest<SourceFamily>(`/sources/${encodeURIComponent(id)}/family`);
}
export function listSourceFolders(projectId: string) {
  const query = new URLSearchParams({ projectId });
  return productRequest<ProductPage<SourceFolderRecord>>(`/sources/folders?${query}`);
}
export function registerSourceFolder(projectId: string, path: string) {
  return productRequest<{ folder: SourceFolderRecord; created: boolean; scheduled: boolean }>("/sources/folders", "POST", { projectId, path });
}
export function syncSourceFolder(id: string, expectedRevision: number) {
  return productRequest<{ folder: SourceFolderRecord; scheduled: boolean }>(`/sources/folders/${encodeURIComponent(id)}/sync`, "POST", { expectedRevision });
}
export function setSourceFolderStatus(id: string, expectedRevision: number, status: "active" | "paused") {
  return productRequest<{ folder: SourceFolderRecord; scheduled: boolean }>(`/sources/folders/${encodeURIComponent(id)}`, "PATCH", { expectedRevision, status });
}
export function listDuplicateCandidates(projectId: string) {
  const query = new URLSearchParams({ projectId });
  return productRequest<{ items: DuplicateGroup[]; scanned: number; truncated: boolean }>(`/sources/duplicates?${query}`);
}
export function decideDuplicateGroup(input: { projectId: string; groupKey: string; sourceIds: string[]; decision: "linked" | "dismissed" }) {
  return productRequest<ProductRecord<{ groupKey: string; decision: string }>>("/sources/duplicates", "POST", input);
}
export function browseOpenList(projectId: string, path: string) {
  const query = new URLSearchParams({ projectId, path });
  return productRequest<{ entries: OpenListEntry[]; nextCursor: string | null }>(`/sources/openlist?${query}`);
}
export function importOpenListSource(projectId: string, path: string) {
  return productRequest<{ source: SourceRecord; duplicate: boolean }>("/sources/openlist/import", "POST", { projectId, path });
}
