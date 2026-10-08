import { SOURCE_KINDS } from "@evimed/domain";
import type { SourceKind, SourceScope } from "./sourceClient";

/**
 * Where the knowledge base is, said in its address (design reference §13.1, E-8 and E-19): the list's scope, type
 * filter and search, and — on a document's own page — the tab and the page of its original. A bookmark, a reload, the
 * back button and a link from somewhere else all land on the same place, and the way back from a document restores the
 * list as it was left.
 *
 * ```
 * /app/files?scope=<project id | shared>&kind=<kind>&q=<text>
 * /app/files/<source id>?<the same three>&tab=<content | original>&page=<n>
 * ```
 *
 * `scope` is absent for the project the tab is in. The document page carries the list's three so that its way back
 * (「知识库」) is the list it came from, and it reads the document by its own id, wherever that document lives.
 */

/** The shared documents of the account, as a scope: no project's. */
export const SHARED_SCOPE = "shared";

export interface KnowledgeListState {
  /** `shared`, a project's id, or null for the project the tab is in. */
  scope: string | null;
  kind: SourceKind | null;
  q: string;
}

const KIND_IDS: readonly string[] = SOURCE_KINDS.map((kind) => kind.id);
const MAX_SCOPE_CHARS = 200;
const MAX_QUERY_CHARS = 200;
/** A source id: `src_` and a hash today; wide enough for an older id, narrow enough that it cannot carry a path or a script. */
const SOURCE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

/** The list's state from an address, read as untrusted: a known type, a short scope, a bounded search. */
export function readListState(params: URLSearchParams): KnowledgeListState {
  const scope = (params.get("scope") ?? "").trim();
  const kind = params.get("kind") ?? "";
  return {
    scope: scope && scope.length <= MAX_SCOPE_CHARS ? scope : null,
    kind: KIND_IDS.includes(kind) ? (kind as SourceKind) : null,
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_CHARS),
  };
}

/** The list's state as query parameters, in one order, with nothing in them that is the default. */
export function listParams(state: KnowledgeListState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.scope) params.set("scope", state.scope);
  if (state.kind) params.set("kind", state.kind);
  if (state.q) params.set("q", state.q);
  return params;
}

const withSearch = (path: string, params: URLSearchParams) => {
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

/** The list, as it was: 「知识库」 with the scope, the type and the search. */
export function listPath(state: KnowledgeListState): string {
  return withSearch("/app/files", listParams(state));
}

export type ReaderTab = "content" | "original";

/** What a document page shows beyond the document: which tab (when there is no room for both columns) and which page of the original. */
export interface ReaderView {
  tab: ReaderTab | null;
  page: number | null;
}

/** The tab and the page of a document page's address; anything else is ignored. */
export function readReaderView(params: URLSearchParams): ReaderView {
  const tab = params.get("tab");
  const page = Number(params.get("page"));
  return {
    tab: tab === "content" || tab === "original" ? tab : null,
    page: Number.isInteger(page) && page > 0 && page <= 100_000 ? page : null,
  };
}

/** A document's own page, carrying the list it was opened from. */
export function readerPath(sourceId: string, state: KnowledgeListState, view: ReaderView = { tab: null, page: null }): string {
  const params = listParams(state);
  if (view.tab) params.set("tab", view.tab);
  if (view.page) params.set("page", String(view.page));
  return withSearch(`/app/files/${encodeURIComponent(sourceId)}`, params);
}

/**
 * The document a legacy address names: `/app/files?source=<id>`. Nothing in this product wrote such a link, but the
 * drawer a document used to open in had no address, and a hand-made or remembered one is read as a document's page
 * rather than as a list with a stray parameter.
 */
export function legacySourceParam(params: URLSearchParams): string | null {
  const id = params.get("source");
  return id && SOURCE_ID.test(id) ? id : null;
}

/** The scope a list state names, with the tab's project standing for none. */
export function scopeOf(state: KnowledgeListState, currentProjectId: string): SourceScope {
  if (state.scope === SHARED_SCOPE) return { kind: "shared" };
  return { kind: "project", projectId: state.scope ?? currentProjectId };
}

/** The `scope` parameter for a scope: nothing for the tab's own project. */
export function scopeParam(scope: SourceScope, currentProjectId: string): string | null {
  if (scope.kind === "shared") return SHARED_SCOPE;
  return scope.projectId === currentProjectId ? null : scope.projectId;
}

/* ------------------------------------------------------------ position -- */

/** How far the list was scrolled and how many documents it had loaded, when a document was opened from it. */
export interface ListPosition {
  scroll: number;
  count: number;
}

const POSITION_KEY = "evimed:knowledge-list-position";
const MAX_RESTORED_DOCUMENTS = 1000;

const positionKey = (state: KnowledgeListState) => `${POSITION_KEY}:${listParams(state)}`;

/** Keeps where the list was, for the list state it was in; read again when the reader comes back to it. */
export function rememberListPosition(state: KnowledgeListState, position: ListPosition): void {
  try { window.sessionStorage.setItem(positionKey(state), JSON.stringify(position)); }
  catch { /* storage is a convenience: a list that cannot remember opens at the top */ }
}

/** The position kept for a list state, or null — read as untrusted, since storage is whatever was left in it. */
export function recallListPosition(state: KnowledgeListState): ListPosition | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(positionKey(state)) ?? "null") as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    const { scroll, count } = value;
    if (typeof scroll !== "number" || !Number.isFinite(scroll) || scroll < 0 || scroll > 10_000_000) return null;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
    return { scroll, count: Math.min(count, MAX_RESTORED_DOCUMENTS) };
  } catch { return null; }
}
