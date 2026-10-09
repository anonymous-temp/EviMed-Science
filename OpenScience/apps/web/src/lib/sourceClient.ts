import { knownErrorCodeMessage } from "@evimed/domain";
import type { SourceMaterialsLedger, SourceMaterialsResult } from "@/lib/sourceMaterials";
import { invokeCommand, type WebMe } from "./apiClient";
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
  /** Null when the gateway could not settle the run's cost: not known, never a guess. */
  usage: {
    currency: "CNY";
    modelId: string;
    providerId: string;
    actualCost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  /** Present only when the run's delivery receipt did not vouch for the package this was read from.
   *  A label on a stored understanding, never a reason it is missing; the page does not print it. */
  verification?: "unverified";
  summary: string;
  /**
   * 「包含什么」: up to five things the document holds, written from the document and not cut from the summary (N-17).
   * Absent on an understanding written before the field existed — not read, which is not the same as none; an empty list is
   * an answer.
   */
  contents?: string[];
  /** 「局限」: what limits the document, as it states it or as its stated design implies; empty when it states none. Absent as `contents` is. */
  limitations?: string[];
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
  /** The pages of the text the understanding's anchors are offsets into (`sourcePageForOffset`); null when the parse had none. */
  pageMap?: Array<{ page: number; start: number; end: number }> | null;
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
/** What the parsing API read about a document, checked where it can be: the
 *  DOI against Crossref's title (`verified`; `unconfirmed` when Crossref could
 *  not say; `mismatch` when it named another work — the DOI is then dropped and
 *  only `droppedDoi` keeps it). Absent for a document no metadata came with. */
export interface SourceMetadata {
  title?: string;
  authors?: string[];
  keywords?: string[];
  publicationDate?: string;
  source?: string;
  doi?: string;
  doiCheck?: {
    status: "verified" | "unconfirmed" | "mismatch";
    reason?: string;
    droppedDoi?: string;
    crossrefTitle?: string;
    similarity?: number;
    at?: string;
  };
}
/** The chip a document is counted under (`SOURCE_KINDS` in `@evimed/domain`), and where it came from (`SOURCE_ORIGINS`). */
export type SourceKind = "literature" | "table" | "document" | "page" | "note" | "image";
export type SourceOrigin = "upload" | "drive" | "link" | "note" | "frontier" | "conversation";
/**
 * What a row says about its document, worked out by the control plane (`sourceDisplayOf`) so the page computes
 * nothing about content: what it is called, one line of what it says (once it is understood), its type, the chip it
 * is counted under, where it came from and the facts a meta line states. `shared` is whether the account library
 * holds it, `null` where the list did not ask.
 */
export interface SourceDisplay {
  title: string;
  gist: string | null;
  docType: string;
  typeLabel: string;
  typeShort: string;
  kind: SourceKind;
  origin: SourceOrigin;
  format: string | null;
  pages: number | null;
  size: number | null;
  site: string | null;
  url: string | null;
  shared: boolean | null;
}
/** How many documents fall under each chip, over the whole scope and the search — not over the page. */
export type SourceCounts = Record<"all" | SourceKind, number>;
export interface SourcePayload {
  paths: string[];
  /** The title a note or a saved page was filed under. */
  title?: string;
  /** Where a saved page was read from, and when. */
  link?: { url: string; finalUrl: string; site: string; fetchedAt: string; rendered: boolean; original: string | null } | null;
  /** Set once the type was named by the judge (`judge`) or settled by a reclassification (`format`). */
  typeClassification?: { origin: "judge" | "format" } | null;
  status: SourceStatus;
  docType: string;
  depth: SourceDepth;
  version: number;
  familyId?: string;
  generation?: number;
  /** What intake recorded about the file itself; `size` is in bytes. */
  fingerprint?: { size?: number; mimeType?: string | null; sha256?: string | null } | null;
  analysis?: { phase?: string; pageCount?: number };
  metadata?: SourceMetadata | null;
  omissionAudit?: { status: string; reason?: string; omissionRate: number | null };
  omissionNotice?: SourceOmissionNotice | null;
  reasons: string[];
  valueVector: Record<string, number>;
  coverage: null | {
    total: number; accounted: number; accountedPercent?: number; extracted: number; indexedOnly: number; noContent: number;
    failed: number; percent: number; omissionRate: number | null; parserFailureRate?: number;
    /** What was located, ambiguous, unlocated, unextracted or failed among the tables and values (absent: not extracted). */
    materials?: SourceMaterialsLedger;
  };
  outputs: { summary?: string; facts?: number; methods?: number; artifactPath?: string };
  /** Set once the document's understanding is in; `outputs.summary` is then its summary. */
  currentUnderstandingId?: string | null;
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
 * NOTE: the parser's codes (`source_parser_*`, `source_format_unsupported`,
 * `source_media_unsupported`, `source_changed`) have registry sentences since
 * the in-house parser replaced MinerU; `source_understanding_*` and
 * `source_ingestion_failed` still land on the fallback below. That is a
 * registry gap, not a reason for a fourth table here.
 */
export function sourceFailureMessage(error?: { code: string; message?: string } | null): string | null {
  if (!error?.code) return null;
  return knownErrorCodeMessage(error.code)
    ?? `本版本还没有为这个原因准备说明。把这个代号交给管理员即可定位：${error.code}`;
}

/** One document by its id, wherever it lives in the account: what the reader page opens. 404 for one that is gone or not the account's, the same answer for both. */
export function getSource(id: string) {
  return productRequest<SourceRecord>(`/sources/${encodeURIComponent(id)}`);
}
/** The conversations that used a document, newest first: the account's own, and nobody else's. */
export function getSourceUses(id: string) {
  return productRequest<{ items: SourceUse[] }>(`/sources/${encodeURIComponent(id)}/uses`);
}
/** The structured materials of the current capture: the ledger and every table and figure with the page it was placed on (`materials: null` when none was extracted). */
export function getSourceMaterials(id: string) {
  return productRequest<SourceMaterialsResult>(`/sources/${encodeURIComponent(id)}/materials`);
}
export function getSourceUnderstanding(id: string) {
  return productRequest<SourceUnderstandingResult>(`/sources/${encodeURIComponent(id)}/understanding`);
}
export function listSourceUnderstandingHistory(id: string, cursor?: string | null) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return productRequest<ProductPage<SourceUnderstanding>>(`/sources/${encodeURIComponent(id)}/understanding/history?${query}`);
}
/**
 * A source as the knowledge base page reads it. `readable` is the server's
 * answer to the one question the page asks (`sourceReadable`): can the
 * assistant use this document yet? It is true as soon as the text is read,
 * while the understanding still runs, so the page never says what the
 * pipeline is doing behind that.
 */
export type SourceRecord = ProductRecord<SourcePayload> & { projectId: string; readable?: boolean; display: SourceDisplay };
/**
 * Where the list's search matched inside a document's own text (N-16): the page it is on (null where the document has no
 * pages), one line of text around the match, and its offsets in the document's parsed text.
 */
export interface SourcePassage {
  page: number | null;
  snippet: string;
  start: number;
  end: number;
}
/**
 * A page of the list: the documents, the cursor for the next page and, for the page's own list, the chip counts. When the
 * search matched inside documents' text, `passages` holds the matches of the rows of this page, by document id.
 */
export type SourcePage = ProductPage<SourceRecord> & { counts?: SourceCounts; passages?: Record<string, SourcePassage[]> };
/**
 * A conversation that used a document (N-16): a passage of it came back from a search, or a run read its text. `title` is the
 * conversation's name in its project's ledger — null where the ledger no longer holds it.
 */
export interface SourceUse {
  sessionId: string;
  projectId: string;
  runId: string;
  title: string | null;
  kinds: Array<"search" | "read">;
  uses: number;
  firstUsedAt: string;
  lastUsedAt: string;
}
/** Whose documents a list is of: one project's, or the account's shared documents (every project reads them). */
export type SourceScope = { kind: "project"; projectId: string } | { kind: "shared" };
/** What the page filters by, in the words a row says (`SOURCE_STATES`). */
export type SourceListState = "reading" | "ready" | "attention";
export interface OpenListEntry {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  entryType: "file" | "dir";
  providerHash: string | null;
}

export interface SourceListOptions {
  /** The pipeline's own word, or what the page says about a document; one or the other. */
  status?: string;
  state?: SourceListState;
  /** A chip: the list holds only documents of that kind. */
  kind?: SourceKind;
  /** A search over what a document is called and what it says, run where the documents are. */
  q?: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * One page of a scope's documents, newest first. A project id alone is that project's list, as it always was.
 * `counts` come with every page: the whole scope's inventory by chip, which a chosen chip does not move.
 */
export function listSources(scope: string | SourceScope, { status = "", state, kind, q = "", cursor, limit }: SourceListOptions = {}) {
  const query = new URLSearchParams();
  if (typeof scope === "string") query.set("projectId", scope);
  else if (scope.kind === "shared") query.set("scope", "shared");
  else query.set("projectId", scope.projectId);
  if (state) query.set("state", state);
  else if (status) query.set("status", status);
  if (kind) query.set("kind", kind);
  if (q.trim()) query.set("q", q.trim());
  if (cursor) query.set("cursor", cursor);
  if (limit) query.set("limit", String(limit));
  return productRequest<SourcePage>(`/sources?${query}`);
}

/** 「添加网页链接」: the control plane reads the page and keeps a snapshot of it in the project's knowledge base. */
export function addSourceLink(projectId: string, url: string) {
  return productRequest<{ source: SourceRecord; duplicate: boolean; changed: boolean }>("/sources/links", "POST", { projectId, url });
}
/** 「新建笔记」: a Markdown document the researcher writes. */
export function addSourceNote(projectId: string, input: { title: string; body: string }) {
  return productRequest<{ source: SourceRecord; duplicate: boolean }>("/sources/notes", "POST", { projectId, ...input });
}
/** What a note's editor opens with. */
export function getSourceNote(id: string) {
  return productRequest<{ title: string; body: string }>(`/sources/${encodeURIComponent(id)}/note`);
}
/** 「保存」 in a note's editor: changed text is the note's next version — a new document id — and it is read again. */
export function saveSourceNote(id: string, input: { title: string; body: string }) {
  return productRequest<{ source: SourceRecord; duplicate: boolean; changed: boolean }>(`/sources/${encodeURIComponent(id)}/note`, "PUT", input);
}
/** 「重新读取」 on a saved page: read its address again. */
export function refetchSource(id: string) {
  return productRequest<{ source: SourceRecord; duplicate: boolean; changed: boolean }>(`/sources/${encodeURIComponent(id)}/refetch`, "POST", {});
}
/**
 * 「存入知识库」 on a file a conversation produced: a copy in this project's knowledge base, read like an upload. The
 * path is the file's, relative to the project's workspace; the destination is the control plane's.
 */
export function saveToKnowledgeBase(path: string) {
  return invokeCommand<{ path: string; duplicate: boolean; sourceId: string | null }>("save_to_knowledge_base", { path });
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
/** Whether `/api/me` offers 连接网盘: OpenList configured and a storage mounted
 *  under its tenant root (`features.openList`). A missing `features` is off. */
export function openListOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return !!features && typeof features === "object" && (features as Record<string, unknown>).openList === true;
}
export function importOpenListSource(projectId: string, path: string) {
  return productRequest<{ source: SourceRecord; duplicate: boolean }>("/sources/openlist/import", "POST", { projectId, path });
}

/**
 * 「所有项目可用」: a document made available to every project of the account (the personal library, `/api/library`).
 * Which documents are is the list's own answer (`display.shared`, and the shared scope), so the page reads no second list.
 */
export function addToLibrary(sourceId: string) {
  return productRequest<{ sourceId: string; status: string }>("/library", "POST", { sourceId });
}
export function removeFromLibrary(sourceId: string) {
  return productRequest<{ sourceId: string; removed: true }>(`/library/${encodeURIComponent(sourceId)}`, "DELETE");
}
