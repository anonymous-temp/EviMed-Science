import { createHash, randomUUID } from "node:crypto";
import {
  KNOWLEDGE_TREES, applyKnowledgePageEdits, checkPageQuotations, diffKnowledgePageEdit,
  emptyKnowledgeUserEdits, isKnowledgeMirrorPath, isTypedKnowledgePage, knowledgeGraphToGraph, knowledgeMirrorPathOf,
  knowledgeSourceIdOfUri, readKnowledgePage, wikiPagesToGraph,
} from "@evimed/domain";
import { knowledgeDigest, knowledgeGenerationRoots, knowledgeOutputPath, readKnowledgeManifest, readKnowledgeOutputSource, readKnowledgeSourceInputs, readSelectedKnowledgeGeneration, validKnowledgeExecution, validKnowledgeQualificationRef, writeKnowledgeManifest } from "./knowledgeGeneration.mjs";
import { compileIdempotencyKey } from "./openVikingResources.mjs";
import { isCompiledPage } from "./openVikingSourceSync.mjs";
import { HttpError } from "./security.mjs";
import { projectSourceManifestRecord, sourceIndexDocument, sourceReadable } from "./sourceService.mjs";

/**
 * 「知识页」: a project's documents compiled into a linked wiki and a knowledge graph by OpenViking's own Compile, and
 * the product layer around it — when to compile, the mirror in the ledger, a person's edits, the labels.
 *
 * Hidden knowledge:
 *
 * - **Upstream compiles; this schedules.** The pages are written by the official `llm-wiki` and `knowledge-graph`
 *   skills through `POST /api/v1/compile`, exactly as upstream runs them. Upstream has no notion of *when*: that is
 *   this module — after the project's documents changed and were quiet for a while, once enough of them are readable,
 *   within the `knowledge` caps, one compile at a time per target.
 * - **The ledger mirrors by content hash, and the mirror is what the product reads.** A finished compile reports every
 *   file of its target as "updated" whether it changed or not, and its task record expires in a day; so the mirror
 *   never asks the task anything. It lists the tree, downloads each file, and writes a new version of a document only
 *   where the bytes differ (`#mirror`). It can be run again at any time and after any failure, which is why a failed,
 *   cancelled or expired task loses nothing. Mirrored files are documents under `knowledge-base/wiki/**` and
 *   `knowledge-base/kg/**`, written through the one intake every upload uses.
 * - **Mirror first, then compile.** The pages as they stand are in the ledger before any compile is submitted, so
 *   whatever a compile does to them, the ledger holds what they were. (Until v0.5.1 a target also stopped being compiled
 *   at 100 typed pages: at 128 the engine's model rewrote 102 existing pages into one-line stubs to fit and the task
 *   said `completed`. v0.5.1.1 has no such cap — a target of 140 pages was compiled twice with every page kept byte for
 *   byte — and the stop is gone with it.)
 * - **A person's edit is a ledger revision first, then a write-back.** Their blocks are kept on the page's record,
 *   named verbatim in every compile instruction, and put back by code after a compile that dropped them (measured: the
 *   engine keeps them one recompile and loses them the next). A compile and a write-back never touch one target at
 *   the same time: while a round runs, a save is queued and written when the round ends. Since v0.5.1.1 that is also a
 *   checked write: a write-back names the hash of the bytes the engine held when the page was last mirrored or written
 *   (`engineSha256`), and a page the engine's Compile changed since is refused by the engine (409) and not overwritten —
 *   the mirror and its re-application then put the person's blocks on the engine's newer text.
 * - **Quotation labels are laid on afterwards.** For every source link whose title carries a quotation, whether it is
 *   in the captured text of the document it names (`checkPageQuotations`). ✓ and ⚠ are stored beside the page; a page
 *   or a sentence without a quotation simply has no label, and no page waits for or is refused by any of it.
 * - **A change is a label and a queue entry, never a verdict.** A document that was replaced, removed or retracted
 *   marks the pages that link to it (found in the mirror by recorded document id) and queues a recompile.
 * - **The engine being down stops compiling and nothing else.** Uploads, search and conversations never wait on this
 *   module; pages already mirrored stay readable, and the status says when they were last compiled.
 *
 * Build to delete: the user-block carry goes when a release's Compile keeps a person's passages across recompiles on
 * its own (measured on v0.5.1.1 only for the checked write: the carry is kept); the mirror and the labels stay.
 *
 * @module knowledgePageService
 */

const STATE_RECORD = "wiki-state";
const PAGE_RECORD = "wiki-page";
const USAGE_RECORD = "wiki-usage";
const USAGE_ID = "wiki:usage";
/** Readable documents scanned for a project: a bound on the work, not on what a project may hold. */
const SCAN_LIMIT = 1000;
/** Quotation records one page's record keeps; the rest are counted. */
const QUOTATIONS_KEPT = 160;
const POLL_MS = 5_000;
const SOURCE_ID = /^src_[a-f0-9]{32}$/;
/** What the compile is asked for besides upstream's own skill text. English, as measured (lab/knowledge RESULTS item 7: 568 of 568 claim links carried a quotation, 567 verbatim). */
const QUOTATION_INSTRUCTION = "For every claim-level source link, put the supporting sentence in the link title, copied verbatim from that source: "
  + "[readable title](viking://… \"the exact sentence or clause from the source\"). Copy it character for character from the source file; never paraphrase, "
  + "translate, shorten with an ellipsis or merge two passages inside a title. If no single passage supports the claim verbatim, leave the title out. "
  + "Keep the file name of every source link exactly as it is, including its .md.";
const GRAPH_INSTRUCTION = "Use general entity types that fit the material; when it is clinical or scientific, types such as drug, disease, gene, trial, outcome and guideline are welcome.";
/** One compile of the graph (2026-10-13, live) wrote a whole second graph one level down, under `<target>/<target name>/`. */
/**
 * Whether a finished compile is asked once more: a wiki round that ended `completed` with at most one typed page in its target
 * (the index alone) and was not already asked again. About two compiles in nine did that on the v0.5.1.1 lab (2026-10-23).
 * @param {{ tree: string, status: string, typed: number, retried: boolean }} round
 */
export function asksAgainForIndexOnly({ tree, status, typed, retried }) {
  return tree === "wiki" && status === "completed" && !retried && Number(typed) <= 1;
}

const LAYOUT_INSTRUCTION = "Write every file directly under the target directory — index.md, the type directories and relations.jsonl at its top level — and never create a subdirectory named after the target.";
const LANGUAGE_NAMES = new Map([["zh", "Simplified Chinese"], ["zh-cn", "Simplified Chinese"], ["zh-hans", "Simplified Chinese"], ["zh-tw", "Traditional Chinese"],
  ["zh-hk", "Traditional Chinese"], ["zh-hant", "Traditional Chinese"], ["en", "English"], ["ja", "Japanese"], ["ko", "Korean"], ["fr", "French"], ["de", "German"],
  ["es", "Spanish"], ["pt", "Portuguese"], ["ru", "Russian"], ["it", "Italian"]]);

/** @param {string | Buffer} bytes @returns {string} */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {Iterable<string>} ids @param {Map<string, { basis: string }>} details */
const sourceBasis = (ids, details) => sha256(JSON.stringify([...new Set(ids)].sort().map((id) => [id, details.get(id)?.basis ?? null])));
/** @param {unknown} error @returns {string} */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(/** @type {any} */ (error).code) ? /** @type {any} */ (error).code : "knowledge_pages_failed");
/** @param {string} projectId */ const stateId = (projectId) => `wiki:state:${projectId}`;
/** @param {string} projectId @param {string} tree @param {string} rel */
const pageId = (projectId, tree, rel) => `wiki:page:${projectId}:${tree}:${sha256(rel).slice(0, 32)}`;

/**
 * The first language of an `Accept-Language` header as a lower-case tag, or null. What a browser states about its
 * reader is the one signal of "the user's language" the platform has; nothing here reads prose to guess one.
 * @param {unknown} header @returns {string | null}
 */
export function preferredLanguage(header) {
  const first = String(header ?? "").split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(first) ? first : null;
}


/**
 * What a project below the threshold is told: how many more documents start a round. At least one more, whatever the arithmetic
 * says (a count that is already past it is not below it).
 * @param {number} readable @param {number} minSources
 */
export function thresholdSentence(readable, minSources) {
  return `资料还不够：再加 ${Math.max(1, minSources - readable)} 份就会开始整理`;
}

/**
 * The instruction one compile is submitted with: the output language, the quotation in each source link's title, and
 * every passage a person wrote into the pages, verbatim, so the engine keeps them.
 * @param {{ tree: "wiki" | "kg", language: string | null, userBlocks?: Array<{ path: string, text: string }>, removed?: Array<{ path: string, text: string }> }} request
 */
export function knowledgeCompileInstruction({ tree, language, userBlocks = [], removed = [] }) {
  const named = language ? LANGUAGE_NAMES.get(language) ?? LANGUAGE_NAMES.get(language.split("-")[0]) ?? `the language with the tag "${language}"` : null;
  const parts = [named
    ? `Write everything you produce — pages, titles, descriptions and labels — in ${named}, whatever language the sources are in. Quotations stay in the source's own language.`
    : "Write everything you produce in one language: the language the existing pages are written in; when there are none yet, the language most of the sources are written in. Quotations stay in the source's own language."];
  parts.push(LAYOUT_INSTRUCTION);
  if (tree === "kg") return [...parts, GRAPH_INSTRUCTION].join("\n\n");
  parts.push(QUOTATION_INSTRUCTION);
  if (userBlocks.length) {
    parts.push(["The passages below were written into the pages by the user by hand; they do not come from any source file. Keep each of them verbatim in the page it is listed under: "
      + "do not rewrite it, do not move it to another section, do not delete it, and do not drop it for having no source link.",
    ...userBlocks.map((block, index) => `(${index + 1}) page ${block.path}:\n${block.text}`),
    "Update everything else from the sources as usual."].join("\n"));
  }
  if (removed.length) {
    parts.push(["The user deleted the passages below from the pages. Do not write them back:",
      ...removed.map((block, index) => `(${index + 1}) page ${block.path}:\n${block.text}`)].join("\n"));
  }
  return parts.join("\n\n");
}

export class KnowledgePageService {
  /**
   * @param {{
   *   config: any, documents: any, jobs: any, sources: any, store: any, resources: any, engine?: any, sourceSync?: any,
   *   entries: { writePage: (request: { user: any, project: any, tree: string, rel: string, buffer: Buffer, title: string }) => Promise<any>,
   *     retirePage: (request: { user: any, source: any }) => Promise<any>, readPage: (project: any, tree: string, rel: string) => Promise<string | null> },
   *   knowledgeContext?: any,
   *   libraryText?: ((userId: string, sourceId: string) => Promise<string | null>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   *   `resources`: `OpenVikingResources`; `engine`: `OpenVikingEngine` (its `ready("knowledge")`); `sourceSync`: `OpenVikingSourceSync`;
   *   `libraryText`: the account library's own copy of a document, which a compile reads beside the project's documents
   */
  constructor({ config, documents, jobs, sources, store, resources, engine = null, sourceSync = null, entries, knowledgeContext = null, libraryText = null, now = () => new Date(), report = () => {} }) {
    this.knowledgeContext = knowledgeContext;
    this.config = config; this.documents = documents; this.jobs = jobs; this.sources = sources; this.store = store;
    this.resources = resources; this.engine = engine; this.sourceSync = sourceSync; this.entries = entries; this.libraryText = libraryText; this.now = now; this.report = report;
    this.counters = { rounds: 0, failed: 0, compiles: 0, indexOnlyRetries: 0, pagesMirrored: 0, pagesRetired: 0, blocksRestored: 0, writeBacks: 0, writeBackConflicts: 0, deferred: 0,
      quotationsPresent: 0, quotationsAbsent: 0, tokens: 0, misplaced: 0 };
  }

  /** Compiling is on: the switch, and an engine to compile with. Pages that exist are readable either way. */
  get enabled() { return this.config.ovKnowledgeEnabled === true && Boolean(this.resources?.configured); }

  async #knowledgeContext(userId, projectId) {
    if (!this.knowledgeContext) return null;
    const context = await this.knowledgeContext.forProject({ userId, id: projectId });
    if (!["owned", "geo-project"].includes(context?.kind)) throw new HttpError(503, "knowledge_scope_unavailable", "The project knowledge policy is unavailable.");
    return context;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The ledger

  /** @param {string} userId @param {string} projectId */
  async #state(userId, projectId) {
    const row = await this.documents.get(userId, "knowledge", stateId(projectId));
    const base = { recordType: STATE_RECORD, projectId, round: 1, pending: {}, lastChangeAt: null, compiledAt: null, lastRound: null, lastError: null,
      run: null, language: null, pages: { wiki: 0, kg: 0 }, writeBacks: [], taken: {} };
    return { row, value: { ...base, ...(row?.payload ?? {}) } };
  }

  /**
   * Change the project's state with the record it was read as, again if another writer got there first.
   * @param {string} userId @param {string} projectId @param {(value: any) => any} change
   */
  async #updateState(userId, projectId, change) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { row, value } = await this.#state(userId, projectId);
      const next = change(structuredClone(value));
      if (next == null) return value;
      try {
        await this.documents.put(userId, "knowledge", stateId(projectId), next, { expectedRevision: row?.revision ?? 0, projectId });
        return next;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      }
    }
    throw new HttpError(409, "knowledge_state_conflict", "The knowledge pages' state kept changing; try again.");
  }

  /** The mirrored files of a project that are not retired. @param {string} userId @param {string} projectId @param {Record<string, any>} [filter] */
  async #pageRecords(userId, projectId, filter = {}) {
    const context = await this.#knowledgeContext(userId, projectId);
    if (context?.kind === "geo-project") {
      const rows = (context.selected?.pages ?? []).filter(row => Object.entries(filter).every(([key, value]) =>
        Array.isArray(value) ? value.every(item => row.payload[key]?.includes(item)) : row.payload[key] === value));
      await context.current();
      return rows;
    }
    /** @type {any[]} */
    const found = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const reply = await this.documents.list(userId, "knowledge", { projectId, filter: { recordType: PAGE_RECORD, ...filter }, limit: 100, cursor });
      found.push(...reply.items);
      cursor = reply.nextCursor;
      if (!cursor) break;
    }
    return found.filter((row) => !row.payload.retired && typeof row.payload.path === "string" && KNOWLEDGE_TREES.includes(row.payload.tree));
  }

  /**
   * Write one page's record with the revision it was read at, again if it moved.
   * @param {string} userId @param {string} projectId @param {string} tree @param {string} rel @param {(value: any | null) => any} change
   */
  async #savePage(userId, projectId, tree, rel, change) {
    const id = pageId(projectId, tree, rel);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const row = await this.documents.get(userId, "knowledge", id);
      const next = change(row ? structuredClone(row.payload) : null);
      if (next == null) return row?.payload ?? null;
      try {
        await this.documents.put(userId, "knowledge", id, next, { expectedRevision: row?.revision ?? 0, projectId });
        return next;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      }
    }
    throw new HttpError(409, "knowledge_page_conflict", "The page's record kept changing; try again.");
  }

  /** Whether a source record is a mirrored file of a compiled tree. @param {any} source */
  static isPage(source) { return isCompiledPage(source); }

  // -------------------------------------------------------------------------------------------------------------------
  // What the project's documents do to the queue

  /**
   * A document became readable: a page is not a document to compile. Durable callers request strict failure propagation.
   * @param {string} userId @param {string} projectId @param {string} sourceId
   */
  async noteSourceReady(userId, projectId, sourceId, { strict = false } = {}) {
    if (!this.enabled) return;
    try {
      const source = await this.sources.get(userId, sourceId);
      if (!source || source.projectId !== projectId || KnowledgePageService.isPage(source)) return;
      // A document is announced when its text is in and again when its understanding ends: the second says nothing the
      // round that read the text has not already taken in.
      const context = await this.#knowledgeContext(userId, projectId);
      const textSha = context?.kind === "geo-project" ? knowledgeDigest(context.inputs.find(input => input.receipt.sourceId === sourceId)?.receipt ?? null)
        : String(source.payload?.analysis?.textSha256 ?? "");
      const changed = await this.#updateState(userId, projectId, (value) => {
        if (value.pending[sourceId]) return null;
        if (textSha && value.taken?.[sourceId] === textSha) return null;
        value.pending[sourceId] = "added";
        value.lastChangeAt = this.now().toISOString();
        return value;
      });
      if (changed.pending[sourceId]) await this.schedule(userId, projectId);
    } catch (error) { this.report(codeOf(error)); if (strict) throw error; }
  }

  /**
   * Documents that pages cite have changed — replaced, removed, retracted. The pages are labelled at once, from the
   * mirror's own record of which documents each page links to, and the project is queued for a recompile.
   * @param {string} userId @param {string} projectId @param {Array<{ sourceId: string, reason: "changed" | "retracted" | "removed" }>} changes
   * @returns {Promise<{ pages: number }>}
   */
  async noteSourcesChanged(userId, projectId, changes, { strict = false } = {}) {
    try {
      const labelled = new Set();
      for (const change of changes) {
        if (!SOURCE_ID.test(change.sourceId)) continue;
        for (const row of await this.#pageRecords(userId, projectId, { dependsOn: [change.sourceId] })) {
          await this.#savePage(userId, projectId, row.payload.tree, row.payload.path, (value) => {
            if (!value || value.retired) return null;
            const stale = value.stale ?? { since: this.now().toISOString(), sources: [] };
            if (stale.sources.some((/** @type {any} */ entry) => entry.sourceId === change.sourceId && entry.reason === change.reason)) return null;
            stale.sources = [...stale.sources.filter((/** @type {any} */ entry) => entry.sourceId !== change.sourceId), { sourceId: change.sourceId, reason: change.reason }];
            return { ...value, stale };
          });
          labelled.add(`${row.payload.tree}/${row.payload.path}`);
        }
      }
      if (!this.enabled) return { pages: labelled.size };
      await this.#updateState(userId, projectId, (value) => {
        for (const change of changes) if (SOURCE_ID.test(change.sourceId)) value.pending[change.sourceId] = change.reason === "removed" ? "withdrawn" : "changed";
        value.lastChangeAt = this.now().toISOString();
        return value;
      });
      await this.schedule(userId, projectId);
      return { pages: labelled.size };
    } catch (error) { this.report(codeOf(error)); if (strict) throw error; return { pages: 0 }; }
  }

  /** A personal-library mutation reaches existing compiled projects, including aliases of the same bytes.
   * A project's own readable copy remains authorized when its personal-library copy is removed.
   * @param {string} userId @param {string} sourceId @param {"changed" | "removed"} reason */
  async noteLibraryChanged(userId, sourceId, reason) {
    if (!SOURCE_ID.test(sourceId)) return { projects: 0, pages: 0 };
    const aliases = new Set([sourceId]);
    const origin = this.sources.documents?.get
      ? await this.sources.documents.get(userId, "source", sourceId, { includeDeleted: true })
      : await this.sources.get(userId, sourceId).catch((/** @type {any} */ error) => { if (error?.status === 404) return null; throw error; });
    const digest = origin?.payload?.fingerprint?.sha256;
    if (typeof digest === "string") {
      for (const deleted of [false, true]) {
        let cursor = null;
        do {
          const page = await this.documents.list(userId, "source", { deleted, filter: { fingerprint: { sha256: digest } }, limit: 100, cursor });
          for (const row of page.items) if (SOURCE_ID.test(row.id)) aliases.add(row.id);
          cursor = page.nextCursor ?? null;
        } while (cursor);
      }
    }
    /** @type {Map<string, any>} */ const sourceRecords = new Map();
    /** @type {Map<string, Set<string>>} */ const targets = new Map();
    let cursor = null;
    do {
      const page = await this.documents.list(userId, "knowledge", { filter: { recordType: PAGE_RECORD }, limit: 100, cursor });
      for (const row of page.items) {
        const projectId = row.projectId ?? row.payload.projectId;
        if (!projectId || row.payload.retired) continue;
        const dependencies = reason === "removed" ? (row.payload.dependsOn ?? []).filter((/** @type {any} */ id) => aliases.has(id)) : [sourceId];
        for (const id of dependencies) {
          if (!sourceRecords.has(id)) sourceRecords.set(id, await this.sources.get(userId, id).catch((/** @type {any} */ error) => { if (error?.status === 404) return null; throw error; }));
          const own = sourceRecords.get(id);
          if (own && own.projectId === projectId && !own.deletedAt && sourceReadable(own.payload)) continue;
          if (!targets.has(projectId)) targets.set(projectId, new Set());
          targets.get(projectId)?.add(id);
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    let pages = 0;
    for (const [projectId, ids] of targets) {
      const result = await this.noteSourcesChanged(userId, projectId, [...ids].map((id) => ({ sourceId: id, reason })), { strict: true });
      pages += result.pages;
    }
    return { projects: targets.size, pages };
  }

  /** The project's documents that carry a DOI in their parsed metadata. @param {string} userId @param {string} projectId @param {string} doi */
  async sourceIdsByDoi(userId, projectId, doi) {
    /** @type {Set<string>} */
    const found = new Set();
    for (const spelling of new Set([doi, doi.toUpperCase()])) {
      const reply = await this.sources.documents.list(userId, "source", { projectId, filter: { metadata: { doi: spelling } }, limit: 50 });
      for (const item of reply.items) found.add(item.id);
    }
    return [...found];
  }

  /** The pages and graph files that cite one document, by the recorded id. @param {string} userId @param {string} projectId @param {string} sourceId */
  async pagesQuoting(userId, projectId, sourceId) {
    return (await this.#pageRecords(userId, projectId, { dependsOn: [sourceId] })).map((row) => ({
      tree: row.payload.tree, path: row.payload.path, slug: row.payload.path, title: row.payload.title, sourceId: row.payload.pageSourceId }));
  }

  /**
   * Put the project's next round in the queue: one job per (project, round), run after the quiet period. A change that
   * arrives meanwhile is part of the same round; the job asks again for quiet when it is claimed.
   * @param {string} userId @param {string} projectId @param {{ immediate?: boolean }} [options]
   */
  async schedule(userId, projectId, { immediate = false } = {}) {
    if (!this.enabled) return null;
    const { value } = await this.#state(userId, projectId);
    const wait = immediate ? 0 : this.config.knowledgePagesDebounceMs;
    const idempotencyKey = `wiki-compile:${projectId}:${value.round}`;
    const job = await this.jobs.enqueue(userId, "wiki-compile", { projectId, round: value.round }, {
      idempotencyKey, projectId, maxAttempts: 4, rearmFailed: true, runAfter: new Date(this.now().getTime() + wait),
    });
    if (immediate) await this.jobs.bringForward?.(userId, idempotencyKey);
    return job;
  }

  /**
   * 「重新整理」: the person asks for a round now. The quiet period is not waited for; the threshold of documents and
   * the page limit still apply. `language` is the language their browser states, kept when the project has none yet.
   * @param {string} userId @param {string} projectId @param {{ language?: string | null }} [options]
   */
  async requestRound(userId, projectId, { language = null } = {}) {
    if (!this.enabled) return null;
    await this.#updateState(userId, projectId, (value) => {
      value.pending.manual = "added";
      value.lastChangeAt = null;
      if (language && !value.language) value.language = language;
      return value;
    });
    return this.schedule(userId, projectId, { immediate: true });
  }

  /**
   * A project whose documents are readable and that has never produced a page gets its first round without anything having to
   * change. A round is otherwise asked for by a document turning readable or changing (`noteSourceReady`,
   * `noteSourcesChanged`) or by a person; a document that was already there when the compile was switched on, one whose round
   * was closed below the threshold (a threshold that has since been lowered), or one whose announcement was lost between the
   * ledger write and the queue write has neither, and a project with one document never gets a second one to ask. This is the
   * periodic pass's read of them (`catchUpAll`), by the ledger alone: a project that has compiled, is compiling, has pages, or
   * failed (its next change or 「重新整理」 asks again, and a pass that re-asked every quarter hour would pay for the same
   * failure every quarter hour) is left alone. Idempotent — a project already queued gets the same job back.
   * @param {string} userId @param {string} projectId
   * @returns {Promise<"scheduled" | "waiting" | "skipped">} `waiting`: a round is already queued or running for it
   */
  async catchUp(userId, projectId) {
    if (!this.enabled) return "skipped";
    const { value } = await this.#state(userId, projectId);
    const context = await this.#knowledgeContext(userId, projectId);
    if (context?.kind === "geo-project") {
      if (value.run) return "waiting";
      if (context.selected || context.inputs.length < this.config.knowledgePagesMinSources) return "skipped";
      if (value.lastError && value.lastError.sourceSetDigest === context.sourceSetDigest) return "skipped";
      await this.#updateState(userId, projectId, state => { state.pending.catchUp = "changed"; return state; });
      await this.schedule(userId, projectId); return "scheduled";
    }
    if (value.compiledAt || value.lastRound || value.lastError || value.pages?.wiki || value.pages?.kg) return "skipped";
    if (value.run) return "waiting";
    const readable = await this.#readableSources(userId, projectId);
    if (readable.length === 0 || readable.length < this.config.knowledgePagesMinSources) return "skipped";
    if ((await this.#pageRecords(userId, projectId)).length > 0) return "skipped";
    const queued = Object.keys(value.pending).length > 0;
    if (!queued) {
      // Quiet is counted from now: the round that follows runs after the usual period and not in the middle of an upload.
      await this.#updateState(userId, projectId, (state) => {
        if (Object.keys(state.pending).length) return null;
        state.pending.catchUp = "added";
        state.lastChangeAt = this.now().toISOString();
        return state;
      });
    }
    await this.schedule(userId, projectId);
    return queued ? "waiting" : "scheduled";
  }

  /**
   * The periodic pass of `catchUp` over every project that holds documents, a bounded number per pass. One project failing is
   * its own and leaves the rest.
   * @param {{ projects: () => Promise<Array<{ userId: string, projectId: string }>>, limit?: number }} options
   */
  async catchUpAll({ projects, limit = 200 }) {
    const summary = { at: this.now().toISOString(), projects: 0, scheduled: 0, error: /** @type {string | null} */ (null) };
    if (!this.enabled) return summary;
    try {
      for (const { userId, projectId } of (await projects()).slice(0, limit)) {
        summary.projects += 1;
        try { if ((await this.catchUp(userId, projectId)) === "scheduled") summary.scheduled += 1; }
        catch (error) { this.report(codeOf(error)); }
      }
    } catch (error) { summary.error = codeOf(error); this.report(summary.error); }
    return summary;
  }

  /** The language the project's pages are written in, stated once. @param {string} userId @param {string} projectId @param {string | null} language @param {{ replace?: boolean }} [options] */
  async noteLanguage(userId, projectId, language, { replace = false } = {}) {
    if (!language) return;
    await this.#updateState(userId, projectId, (value) => {
      if (value.language === language || (value.language && !replace)) return null;
      value.language = language;
      return value;
    }).catch((error) => this.report(codeOf(error)));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The `knowledge` caps

  /** What compiles of this account used in the last day and week, as recorded when each task ended. @param {string} userId */
  async #spent(userId) {
    const row = await this.documents.get(userId, "knowledge", USAGE_ID);
    const entries = Array.isArray(row?.payload?.entries) ? row.payload.entries : [];
    const now = this.now().getTime();
    const since = (/** @type {number} */ ms) => entries.filter((/** @type {any} */ entry) => now - Date.parse(entry.at) < ms).reduce((/** @type {number} */ sum, /** @type {any} */ entry) => sum + (Number(entry.cny) || 0), 0);
    return { row, entries, day: since(86_400_000), week: since(7 * 86_400_000) };
  }

  /**
   * A finished task's tokens, booked once against the account's `knowledge` caps. The engine reports input and output
   * tokens for the compile rounds only and does not tell cache hits apart; pricing all input as uncached overstates
   * the rounds and roughly covers the summaries the engine writes after them, which carry no task id (measured: those
   * are 45–50% of a compile's real cost). The provider's own bill is booked by the model gateway as platform cost.
   * @param {string} userId @param {{ taskId: string, tree: string, usage: { inputTokens: number, outputTokens: number } | null }} task
   */
  async #recordUsage(userId, { taskId, tree, usage }) {
    if (!usage) return 0;
    const cny = Math.round((usage.inputTokens * Number(this.config.knowledgePagesInputCnyPerMillion ?? 2) + usage.outputTokens * Number(this.config.knowledgePagesOutputCnyPerMillion ?? 8)) / 100) / 10_000;
    this.counters.tokens += usage.inputTokens + usage.outputTokens;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { row, entries } = await this.#spent(userId);
      if (entries.some((/** @type {any} */ entry) => entry.taskId === taskId)) return cny;
      const cutoff = this.now().getTime() - 8 * 86_400_000;
      const next = [...entries.filter((/** @type {any} */ entry) => Date.parse(entry.at) >= cutoff), { at: this.now().toISOString(), taskId, tree, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cny }].slice(-400);
      try {
        await this.documents.put(userId, "knowledge", USAGE_ID, { recordType: USAGE_RECORD, entries: next }, { expectedRevision: row?.revision ?? 0 });
        return cny;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      }
    }
    return cny;
  }

  /** Whether the account may start another compile now; the cap that says no, otherwise. @param {string} userId */
  async #overBudget(userId) {
    const daily = Number(this.config.knowledgePagesDailyLimitCny) || 0;
    const weekly = Number(this.config.knowledgePagesWeeklyLimitCny) || 0;
    if (daily <= 0 && weekly <= 0) return null;
    const { day, week } = await this.#spent(userId);
    if (daily > 0 && day >= daily) return "day";
    if (weekly > 0 && week >= weekly) return "week";
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Documents

  /** The project's readable documents that are not compiled pages. @param {string} userId @param {string} projectId */
  async #readableSources(userId, projectId) {
    const context = await this.#knowledgeContext(userId, projectId);
    if (context?.kind === "geo-project") return context.inputs.map(input => input.source);
    /** @type {any[]} */
    const found = [];
    let cursor = null;
    for (let page = 0; page < SCAN_LIMIT / 100; page += 1) {
      const reply = await this.sources.list(userId, { projectId, state: "ready", limit: 100, cursor });
      found.push(...reply.items.filter((/** @type {any} */ item) => !KnowledgePageService.isPage(item) && !item.deletedAt));
      cursor = reply.nextCursor;
      if (!cursor) break;
    }
    return found;
  }

  /**
   * The text of documents of this project as it was pushed for the compile to read: the captured text under its
   * header, a marker line where each page begins. A document of another project, a page, one that is gone or one not
   * yet read is absent, and a quotation of it is `source_missing`.
   * @param {string} userId @param {string} projectId @param {Iterable<string>} ids @param {Map<string, any>} [cache]
   * @returns {Promise<Map<string, { text: string, title: string }>>}
   */
  async #texts(userId, projectId, ids, cache = new Map()) {
    const context = await this.#knowledgeContext(userId, projectId);
    for (const id of new Set(ids)) {
      if (cache.has(id) || !SOURCE_ID.test(id)) continue;
      try {
        const source = await this.sources.get(userId, id).catch(() => null);
        if (!source || source.projectId !== projectId || source.deletedAt || KnowledgePageService.isPage(source) || context?.kind === "geo-project" && !await context.acceptSource(source)) {
          // Not a document of this project: the account's library may hold it, and its copy there is what the compile read.
          const copy = context?.kind !== "geo-project" && this.libraryText ? await this.libraryText(userId, id).catch(() => null) : null;
          if (copy) cache.set(id, { title: /^#[ \t]+(.+)$/m.exec(copy)?.[1]?.trim() ?? id, text: copy });
          continue;
        }
        const capture = await this.sources.loadCapture(userId, source);
        if (!capture) continue;
        cache.set(id, { title: projectSourceManifestRecord(source).display.title,
          text: sourceIndexDocument({ original: source.payload.paths?.[0] ?? id, sha256: source.payload.fingerprint?.sha256 ?? "", extractor: capture.extractor ?? {},
            text: capture.input.text, pageMap: capture.pageMap, metadata: capture.metadata }) });
      } catch (error) {
        if (/** @type {any} */ (error)?.status !== 404 && /** @type {any} */ (error)?.code !== "source_not_found") this.report(codeOf(error));
      }
    }
    return cache;
  }

  /** Current authorized source facts; a personal-library copy has its own availability and may outlive the project. Under a
   * project's shared context (「循证 GEO」) a document counts only when that context accepts it, and no library copy does.
   * @param {string} userId @param {string} projectId @param {Iterable<string>} ids */
  async #sourceDetails(userId, projectId, ids) {
    /** @type {Map<string, {title: string, available: boolean, sourceVersion: number | null, basis: string}>} */
    const details = new Map();
    const context = await this.#knowledgeContext(userId, projectId);
    const shared = context?.kind === "geo-project";
    for (const id of new Set(ids)) {
      if (!SOURCE_ID.test(id)) continue;
      try {
        const source = await this.sources.get(userId, id).catch(() => null);
        if (source && source.projectId === projectId && !source.deletedAt && sourceReadable(source.payload)
          && (!shared || await context.acceptSource(source))) {
          details.set(id, { title: projectSourceManifestRecord(source).display.title, available: true,
            sourceVersion: Number.isSafeInteger(source.payload.version) ? source.payload.version : null,
            basis: sha256(JSON.stringify([source.revision, source.payload.generation, source.payload.analysis?.textSha256 ?? null])) });
          continue;
        }
        const copy = !shared && this.libraryText ? await this.libraryText(userId, id).catch(() => null) : null;
        if (copy) details.set(id, { title: /^#[ \t]+(.+)$/m.exec(copy)?.[1]?.trim() ?? id, available: true, sourceVersion: null, basis: sha256(copy) });
      } catch { /* Unavailable source metadata never certifies availability. */ }
    }
    return details;
  }

  /** Runtime browsing uses current source authority; the historical UI reader may still show a stale page.
   * @param {string} userId @param {string} projectId @param {string} tree @param {string} rel */
  async browseEligibility(userId, projectId, tree, rel) {
    if (!KNOWLEDGE_TREES.includes(tree)) return { allowed: false, sourceIds: [], code: "knowledge_tree_invalid" };
    const record = (await this.#pageRecords(userId, projectId, { tree })).find((row) => row.payload.path === rel);
    if (!record) return { allowed: false, sourceIds: [], code: "knowledge_page_not_mirrored" };
    const sourceIds = /** @type {string[]} */ ([...new Set((record.payload.dependsOn ?? []).filter((/** @type {any} */ id) => SOURCE_ID.test(id)))]);
    const details = await this.#sourceDetails(userId, projectId, sourceIds);
    return { allowed: sourceIds.every((id) => details.has(id)), sourceIds };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The mirror

  /**
   * What one compiled file says, for its record: its type and title, the documents and pages it links to and — for a
   * wiki page — the label of each quotation.
   * @param {string} userId @param {string} projectId @param {"wiki" | "kg"} tree @param {string} rel @param {string} content @param {Map<string, any>} texts
   */
  async #describe(userId, projectId, tree, rel, content, texts) {
    const root = this.resources.treeUri(userId, projectId, tree);
    if (!/\.md$/i.test(rel)) {
      // relations.jsonl: the documents its evidence names.
      const ids = new Set();
      for (const line of content.split("\n")) {
        try { for (const uri of JSON.parse(line).evidence ?? []) { const id = knowledgeSourceIdOfUri(uri); if (id) ids.add(id); } } catch { /* a line that is not JSON names nothing */ }
      }
      return { type: "relations", title: rel, typed: false, dependsOn: [...ids], links: [], quotations: null };
    }
    const page = readKnowledgePage(content, { path: rel, root });
    const fromFrontmatter = (Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : []).map((uri) => knowledgeSourceIdOfUri(uri));
    const dependsOn = [...new Set([...page.links.filter((link) => link.kind === "source").map((link) => knowledgeSourceIdOfUri(link.uri)), ...fromFrontmatter].filter(Boolean))];
    /** @type {any} */
    let quotations = null;
    if (tree === "wiki") {
      await this.#texts(userId, projectId, /** @type {string[]} */ (dependsOn), texts);
      const checked = checkPageQuotations([{ path: rel, content }], { sourceText: (_uri, sourceId) => (sourceId ? texts.get(sourceId)?.text ?? null : null) });
      // Every link whose title carries a sentence is checked, beside a claim or in the 来源 list: a page that cites only in its
      // list still has its quotations confirmed (or not). A list entry with no sentence is a bibliography line, not a miss.
      const listed = (/** @type {string} */ status) => checked.records.filter((record) => record.inSourceList && record.quote && record.status === status).length;
      const counts = { ...checked.summary, present: checked.summary.present + listed("present"), absent: checked.summary.absent + listed("absent") };
      this.counters.quotationsPresent += counts.present; this.counters.quotationsAbsent += counts.absent;
      const basis = sourceBasis(/** @type {string[]} */ (dependsOn), await this.#sourceDetails(userId, projectId, /** @type {string[]} */ (dependsOn)));
      quotations = { checkedSha256: sha256(content), sourceBasis: basis, checkedAt: this.now().toISOString(), counts,
        records: checked.records.slice(0, QUOTATIONS_KEPT).map((record) => ({ sourceId: record.sourceId, quote: record.quote?.slice(0, 600) ?? null, status: record.status, inSourceList: record.inSourceList, index: record.index })),
        truncated: Math.max(0, checked.records.length - QUOTATIONS_KEPT) };
    }
    return { type: page.type, title: page.title, typed: isTypedKnowledgePage(rel, content), dependsOn, links: [...new Set(page.links.filter((link) => link.kind === "page").map((link) => link.path))].slice(0, 200), quotations };
  }

  /**
   * Bring the ledger's mirror of one compiled tree level with the engine, by content hash. With `reapply`, a wiki page
   * that lost a person's blocks gets them back first (and the engine's copy is written to match). Files the engine no
   * longer holds are retired — unless the engine holds no tree at all, which is an engine that lost its data or cannot
   * be read, never a reason to throw the mirror away.
   * @param {any} user @param {any} project @param {"wiki" | "kg"} tree @param {{ reapply?: boolean, round?: number }} [options]
   */
  async #mirror(user, project, tree, { reapply = false, round = 0 } = {}) {
    const userId = user.id;
    const projectId = project.id;
    const root = this.resources.treeUri(userId, projectId, tree);
    const everything = (await this.resources.tree(userId, root)).filter((/** @type {any} */ entry) => !entry.isDir);
    // A compile that wrote a tree one level down, under `<target>/<target name>/`, did not write the tree: what it left
    // there is the engine's derived output, not a page, and counting it would walk the tree toward the page limit.
    // It is taken out of the engine so the next compile does not build on it, and the round says that it happened.
    const misplaced = everything.filter((/** @type {any} */ entry) => String(entry.relPath ?? "").startsWith(`${tree}/`));
    const listed = misplaced.length ? everything.filter((/** @type {any} */ entry) => !String(entry.relPath ?? "").startsWith(`${tree}/`)) : everything;
    if (misplaced.length) {
      this.counters.misplaced += misplaced.length;
      this.report("knowledge_compile_misplaced");
      await this.resources.removeTree(userId, `${root}/${tree}`).catch((/** @type {unknown} */ error) => this.report(codeOf(error)));
    }
    const known = new Map((await this.#pageRecords(userId, projectId, { tree })).map((row) => [row.payload.path, row.payload]));
    const summary = { tree, files: listed.length, typed: 0, created: 0, updated: 0, unchanged: 0, retired: 0, restored: 0, skipped: 0, failed: 0, misplaced: misplaced.length };
    /** @type {Map<string, any>} */
    const texts = new Map();
    const seen = new Set();
    for (const entry of listed) {
      const rel = entry.relPath;
      if (!isKnowledgeMirrorPath(rel) || !/\.(?:md|jsonl)$/i.test(rel)) { summary.skipped += 1; continue; }
      // The listing says the engine holds it: a read that fails below is a read to try again, never a file that is gone.
      seen.add(rel);
      try {
        const bytes = await this.resources.download(userId, entry.uri);
        if (!bytes) continue;
        const engineText = bytes.toString("utf8");
        // The hash of what the engine holds for this page after this pass: its bytes, or the text written over them below.
        let engineHash = sha256(bytes);
        if (isTypedKnowledgePage(rel, engineText)) summary.typed += 1;
        const record = known.get(rel);
        let text = engineText;
        /** @type {string[]} */
        let restored = [];
        if (reapply && tree === "wiki" && record?.userEdits && /\.md$/i.test(rel)) {
          const applied = applyKnowledgePageEdits(engineText, record.userEdits);
          if (applied.changed) {
            text = applied.markdown;
            restored = [...applied.restored, ...applied.removedAgain];
            await this.resources.writePage(userId, entry.uri, text, { expectedSha256: engineHash });
            engineHash = sha256(text);
            this.counters.writeBacks += 1; this.counters.blocksRestored += restored.length; summary.restored += restored.length;
          }
        }
        const digest = sha256(text);
        if (record && record.sha256 === digest) {
          summary.unchanged += 1;
          // Keep the hash a later write-back names true to the engine's bytes (a re-applied page changed them under the record).
          if (record.engineSha256 !== engineHash) await this.#savePage(userId, projectId, tree, rel, (value) => value && ({ ...value, engineSha256: engineHash }));
          continue;
        }
        const described = await this.#describe(userId, projectId, tree, rel, text, texts);
        const written = await this.entries.writePage({ user, project, tree, rel, buffer: Buffer.from(text, "utf8"), title: described.title });
        const at = this.now().toISOString();
        await this.#savePage(userId, projectId, tree, rel, (value) => ({
          recordType: PAGE_RECORD, projectId, tree, path: rel, uri: entry.uri, pageSourceId: written.source.id, sha256: digest, engineSha256: engineHash,
          type: described.type, title: described.title, typed: described.typed, dependsOn: described.dependsOn, links: described.links, quotations: described.quotations,
          userEdits: value?.userEdits ?? null, basis: value?.userEdits ? "user" : "compiler",
          restored: restored.length ? { at, count: restored.length, round } : value?.restored ?? null,
          // A page rewritten from the documents as they are now no longer rests on what they were.
          stale: null, retired: false, updatedAt: at, createdAt: value?.createdAt ?? at, round,
        }));
        if (record) summary.updated += 1; else summary.created += 1;
        this.counters.pagesMirrored += 1;
      } catch (error) {
        // One file failing is that file's failure; the next mirror tries it again.
        summary.failed += 1;
        this.report(codeOf(error));
      }
    }
    if (listed.length > 0) {
      for (const [rel, record] of known) {
        if (seen.has(rel)) continue;
        try {
          const source = await this.sources.get(userId, record.pageSourceId).catch(() => null);
          if (source && !source.deletedAt) await this.entries.retirePage({ user, source });
          await this.#savePage(userId, projectId, tree, rel, (value) => value && ({ ...value, retired: true, retiredAt: this.now().toISOString() }));
          summary.retired += 1; this.counters.pagesRetired += 1;
        } catch (error) { summary.failed += 1; this.report(codeOf(error)); }
      }
    }
    return summary;
  }

  /**
   * The hash a write-back to one page names: the bytes the engine held when the page was last mirrored or written back
   * (`engineSha256` of its record) or, for a record that carries none, the bytes it holds now.
   * @param {string} userId @param {string} uri @param {any} record
   */
  async #expectedHash(userId, uri, record) {
    if (/^[a-f0-9]{64}$/.test(String(record?.engineSha256 ?? ""))) return /** @type {string} */ (record.engineSha256);
    const bytes = await this.resources.download(userId, uri);
    if (!bytes) throw new HttpError(409, "knowledge_page_engine_changed", "The page is no longer in the engine.");
    return sha256(bytes);
  }

  /**
   * Write one page of the ledger back to the engine as a checked write, and remember the hash of what it now holds.
   * @param {string} userId @param {string} projectId @param {"wiki" | "kg"} tree @param {string} rel @param {string} text
   * @param {{ wait?: boolean }} [options]
   */
  async #writeBack(userId, projectId, tree, rel, text, { wait = true } = {}) {
    const uri = `${this.resources.treeUri(userId, projectId, tree)}/${rel}`;
    const record = (await this.documents.get(userId, "knowledge", pageId(projectId, tree, rel)))?.payload ?? null;
    await this.resources.writePage(userId, uri, text, { expectedSha256: await this.#expectedHash(userId, uri, record), wait });
    this.counters.writeBacks += 1;
    await this.#savePage(userId, projectId, tree, rel, (value) => value && ({ ...value, engineSha256: sha256(text) }));
  }

  /**
   * Write the saves that were queued while a round ran, or while the engine could not be reached. A save whose page the
   * engine's Compile has changed since it was last read is not written: it is dropped from the queue (counted), because
   * its blocks are on the page's record and the round that follows names them to the compile and puts them back.
   * @param {any} user @param {any} project
   */
  async #flushWriteBacks(user, project) {
    const { value } = await this.#state(user.id, project.id);
    const queued = Array.isArray(value.writeBacks) ? value.writeBacks : [];
    if (!queued.length) return 0;
    /** @type {any[]} */
    const left = [];
    for (const entry of queued) {
      try {
        const text = await this.entries.readPage(project, entry.tree, entry.path);
        if (text != null) await this.#writeBack(user.id, project.id, entry.tree, entry.path, text);
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "knowledge_page_engine_changed") { this.counters.writeBackConflicts += 1; this.report("knowledge_page_engine_changed"); continue; }
        left.push(entry); this.report(codeOf(error));
      }
    }
    await this.#updateState(user.id, project.id, (state) => {
      const done = new Set(queued.filter((entry) => !left.includes(entry)).map((entry) => `${entry.tree}/${entry.path}`));
      state.writeBacks = (state.writeBacks ?? []).filter((/** @type {any} */ entry) => !done.has(`${entry.tree}/${entry.path}`));
      return state;
    });
    if (left.length) throw new HttpError(503, "knowledge_write_back_pending", "A saved page could not be written to the engine yet.");
    return queued.length;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // A round

  /** @param {string} userId @param {string} projectId @param {"wiki" | "kg"} tree @param {any} state */
  async #instruction(userId, projectId, tree, state) {
    if (tree === "kg") return knowledgeCompileInstruction({ tree, language: state.language });
    /** @type {Array<{ path: string, text: string }>} */
    const userBlocks = [];
    /** @type {Array<{ path: string, text: string }>} */
    const removed = [];
    let room = Math.max(2_000, Number(this.config.knowledgePagesInstructionChars) || 24_000);
    for (const row of await this.#pageRecords(userId, projectId, { tree: "wiki" })) {
      for (const block of row.payload.userEdits?.blocks ?? []) {
        if (block.text.length > room) continue;
        room -= block.text.length;
        userBlocks.push({ path: row.payload.path, text: block.text });
      }
      for (const entry of row.payload.userEdits?.removed ?? []) {
        if (entry.text.length > room) continue;
        room -= entry.text.length;
        removed.push({ path: row.payload.path, text: entry.text });
      }
    }
    return knowledgeCompileInstruction({ tree, language: state.language, userBlocks, removed });
  }

  /**
   * Submit one tree's compile. Returns the task.
   * @param {any} user @param {any} project @param {"wiki" | "kg"} tree @param {any} state @param {number} attempt
   */
  async #submit(user, project, tree, state, attempt) {
    const roots = this.resources.roots(user.id, project.id);
    const from = tree === "wiki" ? [roots.sources] : [roots.sources];
    // The account's library is a compile source beside the project's own documents, when it holds any.
    if (tree === "wiki" && this.config.knowledgePagesIncludeLibrary !== false) {
      const library = await this.resources.listSources(user.id, roots.library).catch(() => []);
      if (library.length) from.push(roots.library);
    }
    const key = compileIdempotencyKey({ projectId: project.id, tree, round: state.round, attempt });
    const task = await this.resources.submitCompile(user.id, { from, to: roots[tree], skill: tree === "wiki" ? "llm-wiki" : "knowledge-graph",
      instruction: await this.#instruction(user.id, project.id, tree, state), idempotencyKey: key });
    this.counters.compiles += 1;
    return { taskId: task.taskId, key, submittedAt: this.now().toISOString(), status: task.status, stage: task.stage };
  }

  /**
   * Run (or continue) one job. A round is a short sequence of steps — make the engine's copy of the documents agree,
   * mirror, submit the wiki compile, wait, mirror and label, the same for the graph — and each call does the next one
   * and answers what the worker should do: `{ result }` finished; `{ defer: { code, delayMs } }` come back, with no
   * attempt spent.
   * @param {{ id: string, userId: string, projectId: string, payload: any }} job
   * @returns {Promise<{ result: any, sharedSettlement?: any } | { defer: { code: string, delayMs: number } }>}
   */
  async runJob(job) {
    const userId = job.userId;
    const projectId = String(job.payload?.projectId ?? job.projectId ?? "");
    if (!this.enabled) return { result: { skipped: "disabled" } };
    const { value: state } = await this.#state(userId, projectId);
    if (Number(job.payload?.round) !== state.round) return { result: { skipped: "round_superseded" } };
    const user = await this.store.userById(userId);
    if (!user) return { result: { skipped: "account_gone" } };
    let project;
    try { project = await this.store.requireProject(user, projectId); }
    catch (error) {
      if (/** @type {any} */ (error)?.status === 404 || /** @type {any} */ (error)?.code === "project_not_found") return { result: { skipped: "project_gone" } };
      throw error;
    }
    const context = await this.#knowledgeContext(userId, projectId);
    if (context?.kind === "geo-project") return this.#runShared(job, user, project, state, context);
    const defer = (/** @type {string} */ code, /** @type {number} */ delayMs) => { this.counters.deferred += 1; return { defer: { code, delayMs } }; };
    // The engine cannot compile now: the round waits, and nothing else in the product does.
    const ready = this.engine?.ready?.("knowledge");
    if (ready && !ready.ok) return defer(String(ready.code ?? "openviking_engine_unchecked"), 120_000);

    if (!state.run) {
      // Quiet first: the round runs after the last change, not after the first.
      const quiet = state.lastChangeAt ? Date.parse(state.lastChangeAt) + this.config.knowledgePagesDebounceMs - this.now().getTime() : 0;
      if (quiet > 1000) return defer("knowledge_waiting_for_quiet", Math.min(quiet, 3_600_000));
      const readable = await this.#readableSources(userId, projectId);
      const pages = await this.#pageRecords(userId, projectId);
      const taken = Object.fromEntries(readable.map((/** @type {any} */ item) => [item.id, String(item.payload?.analysis?.textSha256 ?? "")]).filter(([, sha]) => sha));
      // Below the threshold a wiki would index nothing a search does not already read — unless pages exist, which a change must still reach.
      if (readable.length < this.config.knowledgePagesMinSources && !pages.length) {
        // The round is closed, so the next document asks for a new one (a finished job is never run again under its key).
        await this.#updateState(userId, projectId, (value) => { value.pending = {}; value.round += 1; return value; });
        return { result: { skipped: "below_threshold", readable: readable.length } };
      }
      const over = await this.#overBudget(userId);
      if (over) return defer("usage_budget_exceeded", over === "day" ? 3_600_000 : 6 * 3_600_000);
      // The engine's copy of the documents is made to agree with PostgreSQL before anything reads it.
      if (this.sourceSync) {
        try {
          const projectSync = await this.sourceSync.reconcileProject(userId, projectId);
          const librarySync = await this.sourceSync.reconcileLibrary(userId);
          if (projectSync.failed.length || librarySync.failed.length) return defer("knowledge_source_sync_pending", 30_000);
          const verified = await this.sourceSync.reconcileProject(userId, projectId, { apply: false });
          if (verified.missing.length || verified.stale.length || verified.extra.length) return defer("knowledge_source_sync_pending", 30_000);
          const current = await this.sourceSync.expected(userId, projectId);
          if (current.size !== Object.keys(taken).length || [...current].some(([id, value]) => taken[id] !== value.sha)) {
            return defer("knowledge_source_sync_pending", 30_000);
          }
        } catch (error) {
          this.report(codeOf(error));
          return defer("knowledge_source_sync_pending", 30_000);
        }
      }
      // What the engine holds is in the ledger before a compile may touch it, and nothing a person saved is still waiting.
      await this.#flushWriteBacks(user, project);
      const mirrored = await this.#mirror(user, project, "wiki", { round: state.round });
      const submitted = await this.#submit(user, project, "wiki", state, 0);
      await this.#updateState(userId, projectId, (value) => {
        value.pages = { ...value.pages, wiki: mirrored.typed };
        value.taken = taken;
        value.run = { step: "wiki", startedAt: this.now().toISOString(), changeAt: value.lastChangeAt, wiki: submitted, kg: null, summary: {} };
        return value;
      });
      return defer("knowledge_compile_running", POLL_MS);
    }

    const run = state.run;
    if (run.step === "wiki" || run.step === "kg") {
      const tree = /** @type {"wiki" | "kg"} */ (run.step);
      const held = run[tree];
      const task = await this.resources.task(userId, held.taskId);
      if (task && !task.terminal) {
        const elapsed = this.now().getTime() - Date.parse(held.submittedAt);
        if (elapsed > (Number(this.config.knowledgePagesTaskTimeoutMs) || 1_800_000)) await this.resources.cancelTask(userId, held.taskId).catch(() => null);
        if (task.stage !== held.stage || task.status !== held.status) {
          await this.#updateState(userId, projectId, (value) => { if (value.run?.[tree]) { value.run[tree].stage = task.stage; value.run[tree].status = task.status; } return value; });
        }
        return defer("knowledge_compile_running", POLL_MS);
      }
      // Ended, or a record the engine no longer holds. Either way what is in the target is mirrored: nothing is lost with a task.
      const mirrored = await this.#mirror(user, project, tree, { reapply: true, round: state.round });
      const cost = task ? await this.#recordUsage(userId, { taskId: task.taskId, tree, usage: task.usage }) : 0;
      // A task that says `completed` can still be partial (a job of the pipeline failed): what it reported rides with the round.
      const outcome = { status: task?.status ?? "expired", error: task?.error ?? null, seconds: task?.processingSeconds ?? null, tokens: task?.usage?.totalTokens ?? null, cost,
        warnings: (task?.result?.warnings ?? []).slice(0, 5).map((/** @type {string} */ line) => line.slice(0, 300)), ...mirrored };
      const failed = outcome.status !== "completed";
      if (failed) this.counters.failed += 1;
      // About two compiles in nine end `completed` with only index.md written (the v0.5.1.1 lab, 2026-10-23): from documents enough
      // for a wiki that is a round that did not happen. It is asked once more, never twice; the second answer stands whatever it is.
      if (asksAgainForIndexOnly({ tree, status: outcome.status, typed: mirrored.typed, retried: Boolean(held.retried) })
        && (await this.#readableSources(userId, projectId)).length >= this.config.knowledgePagesMinSources) {
        const again = await this.#submit(user, project, "wiki", state, (Number(held.attempt) || 0) + 1);
        this.counters.indexOnlyRetries += 1;
        await this.#updateState(userId, projectId, (value) => {
          if (!value.run) return null;
          value.run.summary = { ...value.run.summary, wikiIndexOnly: outcome };
          value.run.wiki = { ...again, attempt: (Number(held.attempt) || 0) + 1, retried: true };
          return value;
        });
        return defer("knowledge_compile_running", POLL_MS);
      }
      await this.#updateState(userId, projectId, (value) => {
        if (!value.run) return null;
        value.pages = { ...value.pages, [tree]: mirrored.typed };
        value.run.summary = { ...value.run.summary, [tree]: outcome };
        value.run.step = tree === "wiki" && !failed ? "kg-start" : "finish";
        return value;
      });
      return defer("knowledge_round_advancing", 0);
    }

    if (run.step === "kg-start") {
      if (this.config.knowledgeGraphEnabled === false) {
        await this.#updateState(userId, projectId, (value) => { if (value.run) value.run.step = "finish"; return value; });
        return defer("knowledge_round_advancing", 0);
      }
      const mirrored = await this.#mirror(user, project, "kg", { round: state.round });
      const submitted = await this.#submit(user, project, "kg", state, 0);
      await this.#updateState(userId, projectId, (value) => {
        if (!value.run) return null;
        value.pages = { ...value.pages, kg: mirrored.typed };
        value.run.kg = submitted;
        value.run.step = "kg";
        return value;
      });
      return defer("knowledge_compile_running", POLL_MS);
    }

    // finish: the round is done; its documents leave the queue, the round number moves on. A change recorded while the
    // round ran may concern a document it read as it was before; then the queue stays and the next round reads again.
    await this.#flushWriteBacks(user, project).catch((error) => this.report(codeOf(error)));
    const summary = run.summary ?? {};
    const failure = ["wiki", "kg"].map((tree) => summary[tree]).find((entry) => entry && entry.status !== "completed");
    const next = await this.#updateState(userId, projectId, (value) => {
      if (value.lastChangeAt === run.changeAt) value.pending = {};
      value.round += 1;
      if (summary.wiki?.status === "completed") value.compiledAt = this.now().toISOString();
      value.lastRound = { at: this.now().toISOString(), jobId: job.id, startedAt: run.startedAt, ...summary };
      value.lastError = failure ? { code: failure.status === "expired" ? "knowledge_task_expired" : `knowledge_compile_${failure.status}`, detail: failure.error, at: this.now().toISOString(), round: state.round } : null;
      value.run = null;
      return value;
    });
    this.counters.rounds += 1;
    if (Object.keys(next.pending).length) await this.schedule(userId, projectId).catch((error) => this.report(codeOf(error)));
    return { result: { round: state.round, ...summary } };
  }

  /** A logical address names one selected output even when several paths
   * share the same content-addressed source. Optional receipt fields freeze a
   * reader's base; they never authorize a different generation or page. */
  #addressedPage(context, project, source, address = null) {
    if (address && (address.projectId !== project.id || !KNOWLEDGE_TREES.includes(address.tree) || !knowledgeOutputPath(address.path))) {
      throw new HttpError(409, "knowledge_page_changed", "The knowledge page address changed.");
    }
    const selected = context?.selected;
    const page = address ? selected?.pages.find(row => row.payload.tree === address.tree && row.payload.path === address.path)
      : selected?.pages.find(row => row.payload.pageSourceId === source.id);
    if (address && (!page || page.payload.pageSourceId !== source.id || Object.hasOwn(address, "generationId") && address.generationId !== selected.receipt.generationId
      || address.pageId != null && address.pageId !== page.id || address.pageRevision != null && address.pageRevision !== page.revision)) {
      throw new HttpError(409, "knowledge_page_changed", "The addressed knowledge page changed; reload this page before editing.");
    }
    return page;
  }

  /** @returns {Promise<{source:any,duplicate:boolean,changed:boolean,writeBack:"none"|"queued"|"written",userBlocks:number}>} */
  async #saveSharedEdit({ user, project, source, markdown, baseSha256, address = null }, context) {
    const selected = context.selected;
    const page = this.#addressedPage(context, project, source, address);
    if (!page || !/\.md$/i.test(page.payload.path)) throw new HttpError(409, "knowledge_page_not_editable", "This knowledge page is unavailable for editing.");
    const current = await this.entries.readPage(project, page.payload.tree, page.payload.mirrorRel);
    if (current == null || sha256(current) !== page.payload.sha256 || baseSha256 && sha256(current) !== baseSha256) throw new HttpError(409, "knowledge_page_changed", "The page changed while it was being edited.");
    const text = `${String(markdown ?? "").replace(/\r\n?/g, "\n").trimEnd()}\n`;
    if (!text.trim()) throw new HttpError(400, "knowledge_page_empty", "A page cannot be saved empty.");
    if (text === current) return { source, duplicate: true, changed: false, writeBack: "none", userBlocks: 0 };
    const allowedIds = new Set(context.inputs.map(input => input.receipt.sourceId));
    for (const match of text.matchAll(/\b(src_[a-f0-9]{32})\b/g)) if (!allowedIds.has(match[1])) throw new HttpError(409, "knowledge_output_scope_unverified", "The edited page names an unavailable source.");
    for (const match of text.matchAll(/viking:\/\/[^\s"'`()<>[\]]*/g)) {
      const uri = match[0];
      if (!context.resources.inScope(user.id, project.id, uri) && !context.inputs.some(input => uri === `${selected.receipt.roots.sources}/${input.receipt.sourceId}.md`)) {
        throw new HttpError(409, "knowledge_output_scope_unverified", "The edited page names an unavailable resource.");
      }
    }
    const diff = diffKnowledgePageEdit(current, text, page.payload.userEdits ?? emptyKnowledgeUserEdits(), { digest: words => sha256(words).slice(0, 16) });
    const id = `kedit_${sha256(randomUUID()).slice(0, 32)}`;
    const edit = { recordType: "knowledge-generation-edit", generationId: selected.receipt.generationId, policy: context.stamp,
      sourceSetDigest: context.sourceSetDigest, pageId: page.id, pageRevision: page.revision, baseSha256: sha256(current),
      baseEngineSha256: page.payload.engineSha256, actor: { userId: user.id, ownerCreatedAt: context.stamp.ownerCreatedAt },
      text, textSha256: sha256(text), diffDigest: knowledgeDigest(diff), userEdits: diff.edits, createdAt: this.now().toISOString() };
    await context.current();
    await this.documents.database.transaction(client => this.documents.database.withTransactionClient(client, async () => {
      await context.lockCurrent(client);
      const state = await this.#state(user.id, project.id);
      if (state.value.sharedEdit || state.value.selectedGeneration?.digest !== knowledgeDigest(selected.receipt)) throw new HttpError(409, "knowledge_page_changed", "Another knowledge edit is being saved.");
      await this.documents.put(user.id, "knowledge", id, edit, { projectId: project.id, expectedRevision: 0, transactionClient: client });
      await this.documents.put(user.id, "knowledge", stateId(project.id), { ...state.value, sharedEdit: { id, digest: knowledgeDigest(edit) },
        editEpoch: Number(state.value.editEpoch ?? 0) + 1, pending: { ...state.value.pending, edit: "changed" } },
      { projectId: project.id, expectedRevision: state.row.revision, transactionClient: client });
    }));
    await this.schedule(user.id, project.id, { immediate: true });
    return { source, duplicate: false, changed: true, writeBack: "queued", userBlocks: diff.edits.blocks.length };
  }

  async #applySharedEdit(job, user, project, state, context) {
    const superseded = async code => {
      await this.#transitionShared(job, { round: state.round, generationId: state.run?.generationId }, value => {
        if (value.sharedEdit?.id !== state.sharedEdit.id || value.sharedEdit?.digest !== state.sharedEdit.digest) {
          throw new HttpError(409, "knowledge_page_changed", "Another knowledge edit replaced this queue entry.");
        }
        // Keep the immutable edit and state revision for recovery, but never
        // rebase its checked write onto changed source/page bytes automatically.
        value.lastSharedEdit = { ...value.sharedEdit, status: "superseded", code, at: this.now().toISOString() };
        value.sharedEdit = null;
        value.pending = { ...value.pending, refresh: "changed" };
        return value;
      });
      return { defer: { code: "knowledge_round_advancing", delayMs: 0 } };
    };
    const editRow = await this.documents.get(user.id, "knowledge", state.sharedEdit.id), edit = editRow?.payload;
    const generationRow = await this.documents.get(user.id, "knowledge", edit?.generationId), generation = generationRow?.payload;
    const pageRow = await this.documents.get(user.id, "knowledge", edit?.pageId), page = pageRow?.payload;
    if (!edit || !generation || !page || knowledgeDigest(edit) !== state.sharedEdit.digest
      || edit.policy.digest !== context.stamp.digest || edit.sourceSetDigest !== context.sourceSetDigest
      || pageRow.revision !== edit.pageRevision || page.sha256 !== edit.baseSha256) return superseded("knowledge_page_changed");
    const outputs = await readKnowledgeManifest(this.documents, user.id, project.id, generation.outputs);
    if (!outputs || generation.sourceSetDigest !== context.sourceSetDigest) return superseded("knowledge_page_changed");
    const engineBytes = await this.resources.download(user.id, page.uri);
    if (!engineBytes) return superseded("knowledge_page_engine_changed");
    // Restart after a successful checked write is idempotent only for these
    // exact desired bytes; any other changed base is a conflict, never retry.
    if (sha256(engineBytes) !== edit.textSha256) {
      try { await this.resources.writePage(user.id, page.uri, edit.text, { expectedSha256: edit.baseEngineSha256 }); }
      catch (error) {
        if (codeOf(error) === "knowledge_page_engine_changed") return superseded("knowledge_page_engine_changed");
        throw error;
      }
    }
    const written = await this.entries.writePage({ user, project, tree: page.tree, rel: page.mirrorRel, buffer: Buffer.from(edit.text), title: page.title });
    const captured = await readKnowledgeOutputSource({ sources: this.sources, ownerId: user.id, projectId: project.id, sourceId: written.source.id });
    if (!captured) return { defer: { code: "knowledge_mirror_capture_pending", delayMs: 2000 } };
    try {
      await this.#transitionShared(job, { round: state.round, generationId: state.run?.generationId }, async (value, client) => {
      await context.lockCurrent(client);
      const currentPage = await this.documents.get(user.id, "knowledge", pageRow.id);
      if (currentPage.revision !== pageRow.revision || value.sharedEdit?.digest !== state.sharedEdit.digest) throw new HttpError(409, "knowledge_page_changed", "The edit changed before publication.");
      const payload = { ...page, sha256: edit.textSha256, engineSha256: edit.textSha256, pageSourceId: captured.source.id,
        userEdits: edit.userEdits, editReceipt: { id: editRow.id, revision: editRow.revision, digest: knowledgeDigest(edit) }, basis: "user", editedAt: edit.createdAt };
      const changed = await this.documents.put(user.id, "knowledge", pageRow.id, payload, { projectId: project.id, expectedRevision: pageRow.revision, transactionClient: client });
      const updated = [];
      for (const output of outputs) {
        const candidate = output.recordId === pageRow.id ? { ...output, engineBytesSha256: edit.textSha256, displayedBytesSha256: edit.textSha256,
          bytes: Buffer.byteLength(edit.text), recordRevision: changed.revision, recordDigest: knowledgeDigest(payload), source: captured.receipt } : output;
        // Content-addressed aliases can share a source row. Editing one path
        // revises that row's remaining path metadata; rebind only after proving
        // every unchanged path, file hash and current capture again under the
        // existing project/source locks, never merely revision >= old revision.
        const fresh = await readKnowledgeOutputSource({ sources: this.sources, ownerId: user.id, projectId: project.id, sourceId: candidate.source.sourceId });
        const mirror = await this.entries.readPage(project, candidate.tree, candidate.mirrorRel);
        if (!fresh || fresh.receipt.fileSha256 !== candidate.displayedBytesSha256 || mirror === null
          || sha256(mirror) !== candidate.displayedBytesSha256
          || !fresh.source.payload.paths?.includes(`knowledge-base/${candidate.tree}/${candidate.mirrorRel}`)) {
          throw new HttpError(409, "knowledge_mirror_changed", "An edited generation mirror could not be verified.");
        }
        updated.push({ ...candidate, source: fresh.receipt });
      }
      const manifest = await writeKnowledgeManifest(this.documents, user.id, project.id, generation.generationId, `edit-${editRow.id}`, updated);
      const nextGeneration = { ...generation, outputs: manifest, outputDigest: knowledgeDigest(updated) };
      const updatedGeneration = await this.documents.put(user.id, "knowledge", generationRow.id, nextGeneration,
        { projectId: project.id, expectedRevision: generationRow.revision, transactionClient: client });
      value.selectedGeneration = { id: generationRow.id, revision: updatedGeneration.revision, digest: knowledgeDigest(nextGeneration) };
      value.sharedEdit = null;
      return value;
      });
    } catch (error) {
      // The page/generation writes above have rolled back. A definite vanished
      // output is an obsolete edit base, whereas an IO/ledger outage remains
      // retryable and must not discard the active edit intent.
      if (["knowledge_mirror_changed", "source_not_found", "knowledge_page_changed"].includes(codeOf(error))) {
        return superseded(codeOf(error));
      }
      throw error;
    }
    return { defer: { code: "knowledge_round_advancing", delayMs: 0 } };
  }

  /** A shared transition never replays a stale closure into a newer round. */
  async #transitionShared(job, expected, operation) {
    const database = this.documents.database;
    if (!database || !job.leaseToken) throw new HttpError(409, "product_job_lease_lost", "A shared compile requires its current worker lease.");
    const result = await this.jobs.withLease(job.userId, job.id, job.leaseToken, client => database.withTransactionClient(client, async () => {
      const state = await this.#state(job.userId, job.projectId);
      if (state.value.round !== expected.round || (expected.generationId !== undefined && state.value.run?.generationId !== expected.generationId)
        || expected.step && state.value.run?.step !== expected.step || expected.taskId && state.value.run?.taskId !== expected.taskId) {
        throw new HttpError(409, "knowledge_generation_superseded", "The compile round changed before this worker could save it.");
      }
      const next = await operation(structuredClone(state.value), client);
      const live = await client.query(`SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND lease_token=$3
        AND status='running' AND lease_expires_at>clock_timestamp()`, [job.userId, job.id, job.leaseToken]);
      if (!live.rows.length) throw new HttpError(409, "product_job_lease_lost", "The compile lease expired before saving.");
      await this.documents.put(job.userId, "knowledge", stateId(job.projectId), next, { projectId: job.projectId, expectedRevision: state.row?.revision ?? 0, transactionClient: client });
      return next;
    }));
    if (!result) throw new HttpError(409, "product_job_lease_lost", "The compile lease was lost.");
    return result;
  }

  async #runShared(job, user, project, state, context) {
    const defer = (code, delayMs = POLL_MS) => ({ defer: { code, delayMs } });
    const expected = { round: state.round, generationId: state.run?.generationId };
    if (state.sharedEdit) return this.#applySharedEdit(job, user, project, state, context);
    if (state.run && !state.run.generationId) {
      for (const tree of ["wiki", "kg"]) if (state.run[tree]?.taskId) await this.resources.cancelTask(user.id, state.run[tree].taskId).catch(() => null);
      await this.#transitionShared(job, expected, value => ({ ...value, run: null }));
      return defer("knowledge_clean_generation_required", 0);
    }
    if (!state.run) {
      const quiet = state.lastChangeAt ? Date.parse(state.lastChangeAt) + this.config.knowledgePagesDebounceMs - this.now().getTime() : 0;
      if (quiet > 1000) return defer("knowledge_waiting_for_quiet", Math.min(quiet, 3_600_000));
      if (context.inputs.length < this.config.knowledgePagesMinSources) {
        await this.#transitionShared(job, expected, value => ({ ...value, round: value.round + 1, pending: {} }));
        return { result: { skipped: "below_threshold", readable: context.inputs.length } };
      }
      const over = await this.#overBudget(user.id);
      if (over) return defer("usage_budget_exceeded", 3_600_000);
      const generationId = `kg_${sha256(randomUUID()).slice(0, 32)}`;
      const roots = knowledgeGenerationRoots(this.resources, user.id, project.id, generationId);
      if (this.config.knowledgeGraphEnabled === false) roots.kg = null;
      const requests = {};
      for (const tree of ["wiki", "kg"]) {
        if (tree === "kg" && this.config.knowledgeGraphEnabled === false) continue;
        const request = { from: [roots.sources], to: roots[tree], skill: tree === "wiki" ? "llm-wiki" : "knowledge-graph",
          instruction: knowledgeCompileInstruction({ tree: /** @type {"wiki"|"kg"} */ (tree), language: state.language,
            userBlocks: tree === "wiki" ? (context.selected?.pages ?? []).filter(page => (page.payload.editReceipt || page.payload.carriedEditReceipt) && page.payload.tree === "wiki")
              .flatMap(page => (page.payload.userEdits?.blocks ?? []).map(block => ({ path: page.payload.path, text: block.text }))) : [],
            removed: tree === "wiki" ? (context.selected?.pages ?? []).filter(page => (page.payload.editReceipt || page.payload.carriedEditReceipt) && page.payload.tree === "wiki")
              .flatMap(page => (page.payload.userEdits?.removed ?? []).map(block => ({ path: page.payload.path, text: block.text }))) : [] }), generationId, tree, editReceipts: [] };
        request.editReceipts = tree === "wiki" ? (context.selected?.pages ?? []).filter(page => (page.payload.editReceipt || page.payload.carriedEditReceipt) && page.payload.tree === "wiki")
          .map(page => ({ ...(page.payload.editReceipt ?? page.payload.carriedEditReceipt), path: page.payload.path, tree: page.payload.tree })) : [];
        const execution = await context.compileExecutionFor?.(context.stamp, request);
        if (!validKnowledgeExecution(execution, request)) return defer("knowledge_compile_execution_unqualified", 120_000);
        requests[tree] = { ...request, execution };
      }
      await context.current();
      await this.#transitionShared(job, expected, async (value, client) => {
        await context.lockCurrent(client);
        const inputs = await writeKnowledgeManifest(this.documents, user.id, project.id, generationId, "inputs", context.inputs.map(input => input.receipt));
        const edits = await writeKnowledgeManifest(this.documents, user.id, project.id, generationId, "edits",
          (context.selected?.pages ?? []).filter(page => (page.payload.editReceipt || page.payload.carriedEditReceipt) && page.payload.tree === "wiki")
            .map(page => ({ path: page.payload.path, tree: page.payload.tree, userEdits: page.payload.userEdits, editReceipt: page.payload.editReceipt ?? page.payload.carriedEditReceipt })));
        const generation = { edits, recordType: "knowledge-generation", generationId, status: "preparing", policy: context.stamp,
          sourceSetDigest: context.sourceSetDigest, editEpoch: Number(state.editEpoch ?? 0), roots, inputs, requests, tasks: {}, startedAt: this.now().toISOString(),
 };
        await this.documents.put(user.id, "knowledge", generationId, generation, { projectId: project.id, expectedRevision: 0, transactionClient: client });
        value.run = { generationId, step: "freeze", startedAt: generation.startedAt, changeAt: value.lastChangeAt, taskId: null };
        return value;
      });
      return defer("knowledge_round_advancing", 0);
    }
    const run = state.run;
    const row = await this.documents.get(user.id, "knowledge", run.generationId);
    const generation = row?.payload;
    const editInputs = generation?.edits ? await readKnowledgeManifest(this.documents, user.id, project.id, generation.edits) : [];
    if (!editInputs) throw new HttpError(409, "knowledge_generation_superseded", "The frozen edit manifest changed.");
    const aliases = context.inputs.map(input => ({ uri: `${generation?.roots.sources}/${input.receipt.sourceId}.md`, sourceId: input.receipt.sourceId }));
    if (!generation || generation.policy.digest !== context.stamp.digest || generation.sourceSetDigest !== context.sourceSetDigest || generation.editEpoch !== Number(state.editEpoch ?? 0)) {
      if (run.taskId) await this.resources.cancelTask(user.id, run.taskId).catch(() => null);
      await this.#transitionShared(job, expected, value => ({ ...value, round: value.round + 1, run: null, pending: { ...value.pending, refresh: "changed" } }));
      await this.schedule(user.id, project.id, { immediate: true });
      return { result: { skipped: "generation_superseded" } };
    }
    const change = async (step, patch, taskId = null) => this.#transitionShared(job, { ...expected, step: run.step, taskId: run.taskId }, async (value, client) => {
      await context.lockCurrent(client);
      const current = await this.documents.get(user.id, "knowledge", run.generationId);
      if (current.revision !== row.revision) throw new HttpError(409, "knowledge_generation_superseded", "The generation changed.");
      await this.documents.put(user.id, "knowledge", run.generationId, { ...generation, ...patch }, { projectId: project.id, expectedRevision: row.revision, transactionClient: client });
      value.run = { ...value.run, step, taskId };
      return value;
    });
    if (run.step === "freeze") {
      if (this.sourceSync) await this.sourceSync.reconcileInputs(user.id, project.id, context.inputs);
      // An already reserved directory is replayed only when its complete bytes
      // equal the frozen manifest. No target from another attempt is reused.
      const existing = await this.resources.listAll(user.id, generation.roots.sources);
      const names = new Set(context.inputs.map(input => `${generation.roots.sources}/${input.receipt.sourceId}.md`));
      if (existing.some(entry => entry.isDir || !names.has(entry.uri))) throw new HttpError(409, "knowledge_generation_input_changed", "The frozen input directory contains an unexpected file.");
      for (const input of context.inputs) {
        const uri = `${generation.roots.sources}/${input.receipt.sourceId}.md`;
        const before = await this.resources.download(user.id, uri);
        if (before && sha256(before) !== input.receipt.renditionSha256) throw new HttpError(409, "knowledge_generation_input_changed", "A frozen source changed.");
        if (!before) await this.resources.pushSource(user.id, uri, input.text, { sourceId: input.receipt.sourceId, sha: input.receipt.textSha256 });
        const after = await this.resources.download(user.id, uri);
        if (!after || sha256(after) !== input.receipt.renditionSha256) throw new HttpError(409, "knowledge_generation_input_changed", "A frozen source could not be verified.");
      }
      for (const tree of ["wiki", "kg"]) if (generation.roots[tree] && (await this.resources.listAll(user.id, generation.roots[tree])).length) {
        throw new HttpError(409, "knowledge_target_not_fresh", "The shared compile target must be empty before its first submission.");
      }
      await context.current();
      await change("wiki-submit", { status: "compiling", emptyTargets: { wiki: true, kg: Boolean(generation.roots.kg) } });
      return defer("knowledge_round_advancing", 0);
    }
    if (run.step.endsWith("-submit")) {
      const tree = run.step.split("-")[0], request = generation.requests[tree];
      const execution = await context.compileExecutionFor(context.stamp, request);
      if (!validKnowledgeExecution(execution, request) || knowledgeDigest(execution) !== knowledgeDigest(request.execution)) throw new HttpError(409, "knowledge_compile_execution_unqualified", "The compile execution qualification changed.");
      const requestDigest = knowledgeDigest(request);
      const key = compileIdempotencyKey({ projectId: project.id, tree, round: state.round, attempt: generation.attempt ?? 0, requestDigest });
      await this.#verifySharedInputs(user.id, context, generation);
      await context.current();
      // Key and exact body were frozen in the generation before this POST.
      const task = await this.resources.submitCompile(user.id, { from: request.from, to: request.to, skill: request.skill, instruction: request.instruction, idempotencyKey: key });
      await context.current();
      await change(tree, { tasks: { ...generation.tasks, [tree]: { request, requestDigest, key, taskId: task.taskId, submittedAt: this.now().toISOString() } } }, task.taskId);
      return defer("knowledge_compile_running");
    }
    if (run.step === "wiki" || run.step === "kg") {
      const tree = run.step, held = generation.tasks[tree];
      const task = await this.resources.task(user.id, held.taskId);
      if (task && !task.terminal) {
        if (this.now().getTime() - Date.parse(held.submittedAt) > (Number(this.config.knowledgePagesTaskTimeoutMs) || 1_800_000)) {
          await this.resources.cancelTask(user.id, held.taskId).catch(() => null);
          throw new HttpError(409, "knowledge_task_expired", "The shared compile exceeded its deadline.");
        }
        return defer("knowledge_compile_running");
      }
      if (!task || task.status !== "completed") throw new HttpError(409, "knowledge_compile_failed", "The shared compile did not complete.");
      await this.#recordUsage(user.id, { taskId: task.taskId, tree, usage: task.usage });
      const tasks = { ...generation.tasks, [tree]: { ...held, task, taskDigest: knowledgeDigest(task) } };
      // Exactly one index-only retry; its target and request are fresh.
      if (tree === "wiki" && !generation.attempt) {
        const files = await this.#sharedOutputFiles(user.id, generation.roots.wiki);
        const typed = files.filter(file => isTypedKnowledgePage(file.path, file.bytes.toString("utf8"))).length;
        if (asksAgainForIndexOnly({ tree, status: task.status, typed, retried: false })) {
          const roots = knowledgeGenerationRoots(this.resources, user.id, project.id, generation.generationId, 1);
          if (generation.roots.kg === null) roots.kg = null;
          const request = { ...generation.requests.wiki, to: roots.wiki };
          if ((await this.resources.listAll(user.id, roots.wiki)).length) throw new HttpError(409, "knowledge_target_not_fresh", "The retry target is not empty.");
          await change("wiki-submit", { roots, attempt: 1, earlierWiki: tasks.wiki, tasks: {}, requests: { ...generation.requests, wiki: request } });
          return defer("knowledge_round_advancing", 0);
        }
      }
      if (!generation.requests.kg) tasks.kg = { disabled: true };
      await change(tree === "wiki" && generation.requests.kg ? "kg-submit" : "mirror", { tasks });
      return defer("knowledge_round_advancing", 0);
    }
    if (run.step === "mirror") {
      await this.#verifySharedInputs(user.id, context, generation);
      const outputs = [];
      for (const tree of ["wiki", "kg"]) {
        if (generation.tasks[tree]?.disabled) continue;
        for (const file of await this.#sharedOutputFiles(user.id, generation.roots[tree])) {
          // Absolute engine references must name this generation's exact
          // frozen input or target, never another owner's library/history.
          const frozenEdit = tree === "wiki" ? editInputs.find(page => page.tree === tree && page.path === file.path) : null;
          const trustedBase = frozenEdit ? { payload: frozenEdit } : null;
          if (trustedBase) {
            const applied = applyKnowledgePageEdits(file.bytes.toString("utf8"), trustedBase.payload.userEdits);
            if (applied.changed) {
              await this.resources.writePage(user.id, file.uri, applied.markdown, { expectedSha256: sha256(file.bytes) });
              file.bytes = Buffer.from(applied.markdown);
            }
          }
          const text = file.bytes.toString("utf8");
          const permittedIds = new Set(context.inputs.map(input => input.receipt.sourceId));
          for (const mention of text.matchAll(/\b(src_[a-f0-9]{32})\b/g)) if (!permittedIds.has(mention[1])) {
            throw new HttpError(409, "knowledge_output_scope_unverified", "A compiled file names an unavailable source.");
          }
          for (const match of text.matchAll(/viking:\/\/[^\s"'`()<>[\]]*/g)) {
            const uri = match[0];
            if (!aliases.some(alias => alias.uri === uri)
              && ![generation.roots.wiki, generation.roots.kg].some(root => uri.startsWith(`${root}/`))) {
              throw new HttpError(409, "knowledge_output_scope_unverified", "A compiled file names an unproven resource.");
            }
          }
          const mirrorRel = `generations/${generation.generationId}/${file.path}`;
          const existingMirror = await this.entries.readPage(project, tree, mirrorRel);
          if (existingMirror != null && sha256(existingMirror) !== sha256(file.bytes)) throw new HttpError(409, "knowledge_mirror_changed", "An immutable generation mirror changed.");
          const written = await this.entries.writePage({ user, project, tree, rel: mirrorRel, buffer: file.bytes, title: readKnowledgePage(text, { path: file.path }).title ?? file.path });
          const captured = await readKnowledgeOutputSource({ sources: this.sources, ownerId: user.id, projectId: project.id, sourceId: written.source.id });
          if (!captured) return defer("knowledge_mirror_capture_pending", 2000);
          const id = `kgp_${sha256(`${project.id}\0${generation.generationId}\0${tree}\0${file.path}`)}`;
          const payload = { recordType: PAGE_RECORD, generationId: generation.generationId, tree, path: file.path, mirrorRel,
            uri: file.uri, pageSourceId: captured.source.id, sha256: sha256(file.bytes), engineSha256: sha256(file.bytes),
            title: readKnowledgePage(text, { path: file.path }).title ?? file.path, typed: isTypedKnowledgePage(file.path, text),
            dependsOn: aliases.filter(alias => text.includes(alias.uri)).map(alias => alias.sourceId),
            updatedAt: generation.startedAt, retired: false, basis: "compiler",
            ...(trustedBase ? { userEdits: trustedBase.payload.userEdits, carriedEditReceipt: trustedBase.payload.editReceipt } : {}) };
          const prior = await this.documents.get(user.id, "knowledge", id);
          if (prior && knowledgeDigest(prior.payload) !== knowledgeDigest(payload)) throw new HttpError(409, "knowledge_generation_superseded", "The generation page was changed.");
          let page = prior;
          if (!page) await this.#transitionShared(job, { ...expected, step: "mirror", taskId: run.taskId }, async (value, client) => {
            await context.lockCurrent(client);
            page = await this.documents.put(user.id, "knowledge", id, payload, { projectId: project.id, expectedRevision: 0, transactionClient: client });
            return value;
          });
          outputs.push({ tree, path: file.path, mirrorRel, uri: file.uri, bytes: file.bytes.length, engineBytesSha256: sha256(file.bytes), displayedBytesSha256: sha256(file.bytes),
            recordId: id, recordRevision: page.revision, recordDigest: knowledgeDigest(payload), source: captured.receipt });
        }
      }
      await context.current();
      // Rehydrate reused content-addressed sources only after every mirror
      // path has been registered, otherwise later path additions stale them.
      for (const output of outputs) {
        const captured = await readKnowledgeOutputSource({ sources: this.sources, ownerId: user.id, projectId: project.id, sourceId: output.source.sourceId });
        if (!captured) return defer("knowledge_mirror_capture_pending", 2000);
        output.source = captured.receipt;
      }
      const manifest = await writeKnowledgeManifest(this.documents, user.id, project.id, generation.generationId, "outputs", outputs);
      await change("finish", { outputs: manifest, outputDigest: knowledgeDigest(outputs), status: "completed" });
      return defer("knowledge_round_advancing", 0);
    }
    return { result: { round: state.round, generationId: generation.generationId, warnings: Object.values(generation.tasks).flatMap(task => task.task?.result?.warnings ?? []).slice(0, 20) },
      sharedSettlement: { generationId: generation.generationId, round: state.round, generationRevision: row.revision, digest: knowledgeDigest(generation) } };
  }

  async #verifySharedInputs(userId, context, generation) {
    const wanted = new Map(context.inputs.map(input => [`${generation.roots.sources}/${input.receipt.sourceId}.md`, input]));
    const files = await this.resources.listAll(userId, generation.roots.sources);
    if (files.length !== wanted.size || files.some(file => file.isDir || !wanted.has(file.uri))) throw new HttpError(409, "knowledge_generation_input_changed", "The frozen source inventory changed.");
    for (const [uri, input] of wanted) {
      const bytes = await this.resources.download(userId, uri);
      if (!bytes || sha256(bytes) !== input.receipt.renditionSha256) throw new HttpError(409, "knowledge_generation_input_changed", "A frozen source's bytes changed.");
    }
  }

  /** Complete traversal uses paged ls, never the engine's truncated tree. */
  async #sharedOutputFiles(userId, root) {
    const files = [], pending = [root], seen = new Set();
    while (pending.length) {
      const directory = pending.shift();
      if (seen.has(directory) || seen.size > 10000) throw new HttpError(422, "knowledge_output_scan_incomplete", "The output inventory is incomplete.");
      seen.add(directory);
      for (const entry of await this.resources.listAll(userId, directory)) {
        const path = String(entry.uri).slice(root.length + 1);
        if (path.split("/").some(part => part.startsWith("."))) continue;
        if (!entry.uri.startsWith(`${root}/`) || !knowledgeOutputPath(path) || !entry.uri.startsWith(`${directory}/`)
          || entry.uri.slice(directory.length + 1).includes("/")) throw new HttpError(409, "knowledge_output_scope_unverified", "The output listing contains an unproven path.");
        if (entry.isDir) pending.push(entry.uri);
        else {
          const bytes = await this.resources.download(userId, entry.uri);
          if (!bytes || files.length >= 5000) throw new HttpError(422, "knowledge_output_scan_incomplete", "The output inventory is incomplete.");
          files.push({ path, uri: entry.uri, bytes });
        }
      }
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Qualify each completed task live before taking a job/state lock. Reads
   * later use these authority references without contacting the engine. */
  async prepareSharedSettlement(job, settlement) {
    const context = await this.#knowledgeContext(job.userId, job.projectId);
    const generation = await this.documents.get(job.userId, "knowledge", settlement.generationId);
    if (context?.kind !== "geo-project" || generation?.revision !== settlement.generationRevision || knowledgeDigest(generation.payload) !== settlement.digest
      || generation.payload.policy.digest !== context.stamp.digest) throw new HttpError(409, "knowledge_generation_superseded", "The shared generation changed before qualification.");
    const qualificationRefs = {};
    for (const tree of ["wiki", "kg"]) {
      const held = generation.payload.tasks?.[tree];
      if (tree === "kg" && held?.disabled === true) continue;
      if (!held?.request) throw new HttpError(409, "knowledge_generation_unverified", "The compile task receipt is unavailable.");
      const execution = await context.compileExecutionFor(context.stamp, held.request, { mode: "live" });
      if (!validKnowledgeExecution(execution, held.request) || knowledgeDigest(execution) !== knowledgeDigest(held.request.execution)) {
        throw new HttpError(409, "knowledge_compile_execution_unqualified", "The compile execution changed before publication.");
      }
      const reference = await context.compileExecutionFor(context.stamp, held.request, { mode: "authority-reference" });
      if (!validKnowledgeQualificationRef(reference, held.request)) throw new HttpError(409, "knowledge_compile_execution_unqualified", "The execution authority did not preserve the observed binding.");
      qualificationRefs[tree] = reference;
    }
    return { ...settlement, context, qualificationRefs };
  }

  async finishSharedJob(job, settlement, client) {
    return this.documents.database.withTransactionClient(client, async () => {
      const context = settlement.context;
      if (context?.kind !== "geo-project") throw new HttpError(409, "knowledge_scope_denied", "The shared project policy changed.");
      await context.lockCurrent(client);
      const currentInputs = await readKnowledgeSourceInputs({ documents: this.documents, sources: this.sources, ownerId: job.userId, projectId: job.projectId });
      if (knowledgeDigest(currentInputs.map(input => input.receipt)) !== knowledgeDigest(context.inputs.map(input => input.receipt))) throw new HttpError(409, "knowledge_generation_superseded", "The source set changed before selection.");
      const state = await this.#state(job.userId, job.projectId);
      const generation = await this.documents.get(job.userId, "knowledge", settlement.generationId);
      if (state.value.round !== settlement.round || state.value.run?.generationId !== settlement.generationId || state.value.run?.step !== "finish"
        || generation?.revision !== settlement.generationRevision || knowledgeDigest(generation.payload) !== settlement.digest
        || generation.payload.editEpoch !== Number(state.value.editEpoch ?? 0) || state.value.sharedEdit
        || generation.payload.sourceSetDigest !== context.sourceSetDigest || generation.payload.policy.digest !== context.stamp.digest) {
        throw new HttpError(409, "knowledge_generation_superseded", "The shared compile changed before selection.");
      }
      for (const tree of ["wiki", "kg"]) {
        const held = generation.payload.tasks?.[tree];
        if (tree === "kg" && held?.disabled === true) continue;
        const authorityRef = settlement.qualificationRefs?.[tree];
        if (!held?.request || !validKnowledgeQualificationRef(authorityRef, held.request)) throw new HttpError(409, "knowledge_compile_execution_unqualified", "The prepared authority reference is unavailable.");
        const execution = await context.compileExecutionFor(context.stamp, held.request, { mode: "completed-read", authorityRef, transactionClient: client });
        if (!validKnowledgeExecution(execution, held.request) || knowledgeDigest(execution) !== knowledgeDigest(held.request.execution)) throw new HttpError(409, "knowledge_compile_execution_unqualified", "The execution authority changed before publication.");
      }
      // Authority records are locked before the generation/state publication.
      const payload = { ...generation.payload, qualificationRefs: settlement.qualificationRefs };
      const qualified = await this.documents.put(job.userId, "knowledge", generation.id, payload,
        { projectId: job.projectId, expectedRevision: generation.revision, transactionClient: client });
      const next = { ...state.value, selectedGeneration: { id: generation.id, revision: qualified.revision, digest: knowledgeDigest(payload) },
        round: state.value.round + 1, run: null, compiledAt: this.now().toISOString(), lastRound: { at: this.now().toISOString(), generationId: generation.id },
        lastError: null, pending: state.value.lastChangeAt === state.value.run.changeAt ? {} : state.value.pending,
        taken: Object.fromEntries(context.inputs.map(input => [input.receipt.sourceId, knowledgeDigest(input.receipt)])) };
      await this.documents.put(job.userId, "knowledge", stateId(job.projectId), next, { projectId: job.projectId, expectedRevision: state.row.revision, transactionClient: client });
      const verified = await readSelectedKnowledgeGeneration({ documents: this.documents, sources: this.sources, project: context.project,
        policy: context.stamp, currentInputs, compileExecutionFor: context.compileExecutionFor, transactionClient: client });
      if (verified?.receipt.generationId !== generation.id) throw new HttpError(409, "knowledge_generation_unverified", "The shared output could not be verified for selection.");
    });
  }

  /**
   * A round that cannot go on as it is — a step kept failing until the job's attempts were spent — is closed: what is
   * mirrored stays, the task (if one is still running) is asked to stop, and the next change asks for a new round.
   * @param {{ userId: string, projectId?: string | null, payload: any }} job @param {string} code
   */
  async recordFailure(job, code) {
    const projectId = String(job.payload?.projectId ?? job.projectId ?? "");
    if (!projectId) return;
    const { value } = await this.#state(job.userId, projectId).catch(() => ({ value: null }));
    if (value?.run?.generationId && value.round !== Number(job.payload?.round)) return;
    const sharedGeneration = value?.run?.generationId ? await this.documents.get(job.userId, "knowledge", value.run.generationId) : null;
    const context = sharedGeneration ? null : await this.#knowledgeContext(job.userId, projectId).catch(() => null);
    const failedSourceSetDigest = sharedGeneration?.payload.sourceSetDigest
      ?? (context?.kind === "geo-project" ? context.sourceSetDigest : null);
    for (const tree of ["wiki", "kg"]) {
      const taskId = sharedGeneration?.payload.tasks?.[tree]?.taskId ?? value?.run?.[tree]?.taskId;
      if (taskId) await this.resources.cancelTask(job.userId, taskId).catch(() => null);
    }
    if (value?.run?.generationId) {
      await this.#transitionShared(job, { round: Number(job.payload?.round), generationId: value.run.generationId }, state => ({ ...state,
        round: state.round + 1, run: null, lastError: { code, at: this.now().toISOString(), sourceSetDigest: failedSourceSetDigest } }));
      return;
    }
    await this.#updateState(job.userId, projectId, (state) => {
      if (state.round !== Number(job.payload?.round)) return null;
      state.round += 1;
      state.run = null;
      state.lastError = { code, at: this.now().toISOString(), round: Number(job.payload?.round),
        ...(failedSourceSetDigest ? { sourceSetDigest: failedSourceSetDigest } : {}) };
      return state;
    }).catch((error) => this.report(codeOf(error)));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What a person does to a page

  /**
   * A person saved a page in the reader. Their text is the document's next version in the ledger first; what they
   * changed is kept as blocks on the page's record; then the engine's copy is written to match — at once when no round
   * is running, otherwise when the round ends.
   * @param {{ user: any, project: any, source: any, markdown: string, baseSha256?: string | null, address?: any }} request
   * @returns {Promise<{ source: any, duplicate: boolean, changed: boolean, writeBack: "written" | "queued" | "none", userBlocks: number }>}
   */
  async saveEdit({ user, project, source, markdown, baseSha256 = null, address = null }) {
    const context = await this.#knowledgeContext(user.id, project.id);
    if (context?.kind === "geo-project") return this.#saveSharedEdit({ user, project, source, markdown, baseSha256, address }, context);
    const addressed = address ? await this.pageView(user.id, project, source, address) : null;
    const where = addressed ? { tree: addressed.tree, rel: addressed.path } : knowledgeMirrorPathOf(source?.payload?.paths?.[0]);
    if (!where || !/\.md$/i.test(where.rel)) throw new HttpError(409, "knowledge_page_not_editable", "That document is not a page that can be edited.");
    const text = `${String(markdown ?? "").replace(/\r\n?/g, "\n").trimEnd()}\n`;
    if (!text.trim()) throw new HttpError(400, "knowledge_page_empty", "A page cannot be saved empty.");
    const current = await this.entries.readPage(project, where.tree, where.rel);
    if (current == null) throw new HttpError(404, "knowledge_page_not_found", "The page could not be read.");
    // The save was made against a page a compile has rewritten since: the person is shown the page as it is now.
    if (baseSha256 && sha256(current) !== baseSha256) throw new HttpError(409, "knowledge_page_changed", "The page changed while it was being edited.");
    if (current === text) return { source, duplicate: true, changed: false, writeBack: "none", userBlocks: 0 };
    const record = (await this.documents.get(user.id, "knowledge", pageId(project.id, where.tree, where.rel)))?.payload ?? null;
    const diff = diffKnowledgePageEdit(current, text, record?.userEdits ?? emptyKnowledgeUserEdits(), { digest: (words) => sha256(words).slice(0, 16) });
    const described = await this.#describe(user.id, project.id, where.tree, where.rel, text, new Map());
    const written = await this.entries.writePage({ user, project, tree: where.tree, rel: where.rel, buffer: Buffer.from(text, "utf8"), title: described.title });
    const at = this.now().toISOString();
    const uri = `${this.resources.treeUri(user.id, project.id, where.tree)}/${where.rel}`;
    await this.#savePage(user.id, project.id, where.tree, where.rel, (value) => ({
      ...(value ?? { recordType: PAGE_RECORD, projectId: project.id, tree: where.tree, path: where.rel, uri, createdAt: at, round: 0, engineSha256: null, restored: null, stale: null }),
      pageSourceId: written.source.id, sha256: sha256(text), type: described.type, title: described.title, typed: described.typed,
      dependsOn: described.dependsOn, links: described.links, quotations: described.quotations, userEdits: diff.edits, basis: "user", retired: false, updatedAt: at, editedAt: at,
    }));
    /** @type {"written" | "queued"} */
    let writeBack = "queued";
    const { value: state } = await this.#state(user.id, project.id);
    if (this.resources?.configured && !state.run) {
      // Not waited for: the person's save answers when the file is written, not when the engine has summarised it. A second
      // save inside those seconds finds the directory busy and is queued, like any write the engine could not take.
      try { await this.#writeBack(user.id, project.id, where.tree, where.rel, text, { wait: false }); writeBack = "written"; }
      catch (error) { this.report(codeOf(error)); }
    }
    if (writeBack === "queued") {
      await this.#updateState(user.id, project.id, (value) => {
        value.writeBacks = [...(value.writeBacks ?? []).filter((/** @type {any} */ entry) => !(entry.tree === where.tree && entry.path === where.rel)), { tree: where.tree, path: where.rel, at }].slice(-200);
        return value;
      });
    }
    return { source: written.source, duplicate: false, changed: true, writeBack, userBlocks: diff.edits.blocks.length };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What a person sees

  /** A page record as a list row. @param {any} payload */
  static #row(payload) {
    const counts = payload.quotations?.counts ?? null;
    return {
      sourceId: payload.pageSourceId ?? null, tree: payload.tree, path: payload.path, type: payload.type ?? null, title: payload.title ?? payload.path,
      updatedAt: payload.updatedAt ?? null,
      labels: {
        stale: payload.stale?.sources ?? [],
        userEdited: Boolean(payload.userEdits && (payload.userEdits.blocks?.length || payload.userEdits.removed?.length || Object.keys(payload.userEdits.frontmatter ?? {}).length)),
        userBlocks: payload.userEdits?.blocks?.length ?? 0,
        restored: payload.restored ?? null,
        quotations: counts ? { present: counts.present, absent: counts.absent, none: counts.noQuotation, sourceMissing: counts.sourceMissing } : null,
      },
    };
  }

  /**
   * A project's compiled files as a flat list and as a tree of directories.
   * @param {string} userId @param {string} projectId
   */
  async list(userId, projectId) {
    const rows = (await this.#pageRecords(userId, projectId)).map((row) => KnowledgePageService.#row(row.payload))
      .sort((left, right) => (left.tree === right.tree ? (left.path < right.path ? -1 : 1) : left.tree === "wiki" ? -1 : 1));
    /** @type {Record<string, any>} */
    const trees = {};
    for (const tree of KNOWLEDGE_TREES) {
      /** @type {any} */
      const root = { name: tree, path: "", kind: "directory", children: [] };
      for (const row of rows.filter((entry) => entry.tree === tree)) {
        let node = root;
        const parts = row.path.split("/");
        parts.slice(0, -1).forEach((part, index) => {
          let child = node.children.find((/** @type {any} */ entry) => entry.kind === "directory" && entry.name === part);
          if (!child) { child = { name: part, path: parts.slice(0, index + 1).join("/"), kind: "directory", children: [] }; node.children.push(child); }
          node = child;
        });
        node.children.push({ name: parts.at(-1), kind: "page", ...row });
      }
      trees[tree] = root;
    }
    return { pages: rows, trees, counts: { wiki: rows.filter((row) => row.tree === "wiki").length, kg: rows.filter((row) => row.tree === "kg").length } };
  }

  /**
   * One page as the reader shows it: its Markdown, its front matter, where each link leads, the documents it cites
   * with each quotation's label, whether it holds a person's blocks, and what changed under it.
   * @param {string} userId @param {any} project @param {any} source the page's document
   */
  async pageView(userId, project, source, address = null) {
    const context = await this.#knowledgeContext(userId, project.id);
    const selectedPage = context?.kind === "geo-project" ? this.#addressedPage(context, project, source, address) : null;
    if (context?.kind === "geo-project" && !selectedPage) throw new HttpError(404, "knowledge_page_not_found", "That knowledge page is unavailable.");
    const where = selectedPage ? { tree: selectedPage.payload.tree, rel: selectedPage.payload.path }
      : address ? { tree: address.tree, rel: address.path } : knowledgeMirrorPathOf(source?.payload?.paths?.[0]);
    if (address && context?.kind !== "geo-project" && (address.projectId !== project.id || !KNOWLEDGE_TREES.includes(address.tree)
      || !knowledgeOutputPath(address.path) || !source.payload?.paths?.includes(`knowledge-base/${address.tree}/${address.path}`))) {
      throw new HttpError(409, "knowledge_page_changed", "The addressed knowledge page changed.");
    }
    if (!where) throw new HttpError(404, "knowledge_page_not_found", "That document is not a knowledge page.");
    const markdown = await this.entries.readPage(project, where.tree, selectedPage?.payload.mirrorRel ?? where.rel);
    if (markdown == null || selectedPage && sha256(markdown) !== selectedPage.payload.sha256) throw new HttpError(404, "knowledge_page_not_found", "The page could not be read.");
    const records = await this.#pageRecords(userId, project.id, { tree: where.tree });
    const byPath = new Map(records.map((row) => [row.payload.path, row.payload]));
    const ledgerRow = records.find(row => row.payload.path === where.rel) ?? null;
    const ledger = ledgerRow?.payload ?? null;
    if (address && context?.kind !== "geo-project" && (address.generationId != null || address.pageId != null && address.pageId !== ledgerRow?.id
      || address.pageRevision != null && address.pageRevision !== ledgerRow?.revision)) throw new HttpError(409, "knowledge_page_changed", "The addressed page revision changed.");
    const root = context?.kind === "geo-project" ? context.selected.receipt.roots[where.tree] : this.resources.treeUri(userId, project.id, where.tree);
    const page = readKnowledgePage(markdown, { path: where.rel, root, known: new Set(byPath.keys()) });
    // The labels of this text: the stored ones when they were computed for these bytes, else computed now.
    const digest = sha256(markdown);
    const texts = new Map();
    const cited = [...new Set(page.links.filter((link) => link.kind === "source").map((link) => knowledgeSourceIdOfUri(link.uri)).filter(Boolean))];
    const dependencyIds = /** @type {string[]} */ ([...new Set([...cited,
      ...(Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : []).map((uri) => knowledgeSourceIdOfUri(uri))].filter(Boolean))]);
    const details = await this.#sourceDetails(userId, project.id, dependencyIds);
    const quotations = ledger?.quotations?.checkedSha256 === digest && ledger.quotations.sourceBasis === sourceBasis(dependencyIds, details) ? ledger.quotations
      : (await this.#describe(userId, project.id, where.tree, where.rel, markdown, texts)).quotations;
    const labelAt = new Map((quotations?.records ?? []).map((/** @type {any} */ record) => [record.index, record]));
    const links = page.links.map((link) => {
      if (link.kind === "page") {
        const target = byPath.get(/** @type {string} */ (link.path));
        return { kind: "page", text: link.text, path: link.path, sourceId: target?.pageSourceId ?? null, title: target?.title ?? null, exists: Boolean(target), index: link.index, end: link.end };
      }
      if (link.kind === "source") {
        const sourceId = knowledgeSourceIdOfUri(link.uri);
        const label = labelAt.get(link.index);
        return { kind: "source", text: link.text, sourceId, title: sourceId ? details.get(sourceId)?.title ?? null : null, available: Boolean(sourceId && details.has(sourceId)),
          sourceVersion: sourceId ? details.get(sourceId)?.sourceVersion ?? null : null, checkedAt: quotations?.checkedAt ?? null,
          quote: link.quote, status: label?.status ?? (link.quote ? "source_missing" : "no_quotation"), inSourceList: label?.inSourceList ?? false, index: link.index, end: link.end };
      }
      return { kind: "external", text: link.text, href: link.target, index: link.index, end: link.end };
    });
    // The page as the earlier reader showed it: one item per unit with the quotations it carries.
    /** @type {Array<{ heading: string, items: any[] }>} */
    const sections = [];
    for (const unit of page.units) {
      if (unit.kind === "heading") continue;
      let section = sections.at(-1);
      if (!section || section.heading !== unit.heading) { section = { heading: unit.heading, items: [] }; sections.push(section); }
      const within = links.filter((link) => link.index >= unit.start && link.index < unit.end);
      const evidence = within.filter((link) => link.kind === "source" && link.sourceId).map((link) => ({ sourceId: link.sourceId, title: link.title, quote: link.quote ?? "", status: link.status === "present" ? "verified" : link.status === "absent" ? "quote_not_found" : link.status === "source_missing" ? "source_unavailable" : "unquoted" }));
      const quoted = evidence.filter((entry) => entry.status !== "unquoted");
      let words = unit.text;
      for (const link of [...within].sort((left, right) => right.index - left.index)) words = words.slice(0, link.index - unit.start) + link.text + words.slice(link.end - unit.start);
      section.items.push({ kind: "claim", text: words.replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, "").trim(),
        status: !quoted.length ? "unsupported" : quoted.every((entry) => entry.status === "verified") ? "verified" : "unverified",
        claimKind: new Set(evidence.map((entry) => entry.sourceId)).size > 1 ? "synthesized" : "direct", confidence: null, evidence: quoted });
    }
    const claims = sections.flatMap((section) => section.items);
    const count = (/** @type {string} */ status) => claims.filter((item) => item.status === status).length;
    if (context?.kind === "geo-project") await context.current();
    return {
      ...(ledgerRow ? { address: { projectId: project.id, tree: where.tree, path: where.rel,
        generationId: selectedPage?.payload.generationId ?? null, pageId: ledgerRow.id, pageRevision: ledgerRow.revision } } : {}),
      sourceId: source.id, tree: where.tree, path: where.rel, slug: where.rel, type: page.type, title: page.title, description: page.description, tags: page.tags,
      markdown, sha256: digest, frontmatter: page.frontmatter, body: page.body, links,
      sources: cited.map((id) => ({ sourceId: id, title: details.get(/** @type {string} */ (id))?.title ?? null, available: details.has(/** @type {string} */ (id)), sourceVersion: details.get(/** @type {string} */ (id))?.sourceVersion ?? null })),
      quotations: quotations?.counts ? { present: quotations.counts.present, absent: quotations.counts.absent, none: quotations.counts.noQuotation, sourceMissing: quotations.counts.sourceMissing, checkedAt: quotations.checkedAt ?? null } : null,
      userEdited: Boolean(ledger?.userEdits && (ledger.userEdits.blocks?.length || ledger.userEdits.removed?.length || Object.keys(ledger.userEdits.frontmatter ?? {}).length)),
      userBlocks: (ledger?.userEdits?.blocks ?? []).map((/** @type {any} */ block) => ({ id: block.id, text: block.text, heading: block.heading })),
      restored: ledger?.restored ?? null, editable: /\.md$/i.test(where.rel), updatedAt: ledger?.updatedAt ?? null,
      basis: ledger?.basis ?? "compiler", stale: ledger?.stale?.sources ?? [],
      sections, counts: { claims: claims.length, verified: count("verified"), unverified: count("unverified"), unsupported: count("unsupported") },
      held: [], heldCount: 0, dangling: links.filter((link) => link.kind === "page" && !link.exists).map((link) => link.path),
    };
  }

  /** The mirrored files of one tree, read from the project. @param {string} userId @param {any} project @param {"wiki" | "kg"} tree */
  async #files(userId, project, tree) {
    const context = await this.#knowledgeContext(userId, project.id);
    // In path order, so a graph's nodes come out the same way every time it is read.
    const records = (await this.#pageRecords(userId, project.id, { tree })).sort((left, right) => (left.payload.path < right.payload.path ? -1 : 1));
    /** @type {{ path: string, content: string, record: any }[]} */
    const files = [];
    for (const row of records) {
      const content = await this.entries.readPage(project, tree, row.payload.mirrorRel ?? row.payload.path).catch(() => null);
      if (row.payload.generationId && (content == null || sha256(content) !== row.payload.sha256)) throw new HttpError(409, "knowledge_mirror_changed", "The knowledge mirror no longer matches its receipt.");
      if (content != null) files.push({ path: row.payload.path, content, record: row.payload });
    }
    if (context?.kind === "geo-project") await context.current();
    return files;
  }

  /**
   * `{ nodes, links }` of a project: the pages and the links between them (`wiki`), or the entities and the relations
   * between them (`kg`), with every source and every piece of evidence mapped back to the knowledge-base document it names.
   * @param {string} userId @param {any} project @param {"wiki" | "kg"} kind
   */
  async graph(userId, project, kind) {
    const operationContext = await this.#knowledgeContext(userId, project.id);
    const files = await this.#files(userId, project, kind);
    const byPath = new Map(files.map((file) => [file.path, file.record]));
    const documentOf = (/** @type {string} */ uri) => knowledgeSourceIdOfUri(uri);
    if (kind === "wiki") {
      const graph = wikiPagesToGraph(files, { root: operationContext?.kind === "geo-project" ? operationContext.selected?.receipt.roots.wiki : this.resources.treeUri(userId, project.id, "wiki") });
      const details = await this.#sourceDetails(userId, project.id, graph.nodes.flatMap((node) => node.sources.map((source) => documentOf(source.uri) ?? "")));
      if (operationContext?.kind === "geo-project") await operationContext.current();
      return {
        kind, nodes: graph.nodes.map((node) => {
          const record = byPath.get(node.path);
          const cited = [...new Set(node.sources.map((source) => documentOf(source.uri)).filter(Boolean))];
          return { id: node.id, path: node.path, title: node.title, type: node.type, description: node.description, tags: node.tags, degree: node.degree, sourceId: record?.pageSourceId ?? null,
            stale: record?.stale?.sources ?? [], userEdited: Boolean(record?.userEdits?.blocks?.length), sources: cited.map((id) => ({ sourceId: id, title: details.get(/** @type {string} */ (id))?.title ?? null, sourceVersion: details.get(/** @type {string} */ (id))?.sourceVersion ?? null, available: details.has(/** @type {string} */ (id)) })) };
        }),
        links: graph.links, unresolved: graph.unresolved.length, problems: [],
      };
    }
    const graph = knowledgeGraphToGraph(files);
    const named = [...graph.nodes.flatMap((node) => node.sources), ...graph.links.flatMap((link) => link.evidence)].map((uri) => documentOf(uri) ?? "");
    const details = await this.#sourceDetails(userId, project.id, named);
    const map = (/** @type {string[]} */ uris) => [...new Set(uris.map((uri) => documentOf(uri)).filter(Boolean))].map((id) => ({ sourceId: id, title: details.get(/** @type {string} */ (id))?.title ?? null, sourceVersion: details.get(/** @type {string} */ (id))?.sourceVersion ?? null, available: details.has(/** @type {string} */ (id)), locator: null, quote: null }));
    if (operationContext?.kind === "geo-project") await operationContext.current();
    return {
      kind, nodes: graph.nodes.map((node) => ({ id: node.id, path: node.path, title: node.title, entityType: node.entityType, description: node.description, aliases: node.aliases,
        degree: node.degree, sourceId: byPath.get(node.path)?.pageSourceId ?? null, stale: byPath.get(node.path)?.stale?.sources ?? [], sources: map(node.sources) })),
      links: graph.links.map((link) => ({ source: link.source, target: link.target, relation: link.relation, label: link.label, evidence: map(link.evidence) })),
      relations: graph.relationCounts, unresolved: 0, problems: graph.problems.slice(0, 50).map((problem) => ({ kind: problem.kind, line: problem.line ?? null, path: problem.path ?? null })),
    };
  }

  /**
   * What the memory map's knowledge-graph source reads (`memoryMapSources/knowledgeGraph.mjs`): the compiled files of
   * the project the map is narrowed to, whole. Null when the map is of the whole account (entity ids are a project's
   * own, and two projects' graphs are two graphs) or the project has neither a graph nor a wiki yet.
   * @param {{ user: { id: string }, projectId: string | null }} request
   */
  async fetchProducts(request) {
    if (!request?.projectId || !request.user?.id) return null;
    const user = await this.store.userById(request.user.id);
    if (!user) return null;
    let project;
    try { project = await this.store.requireProject(user, request.projectId); } catch { return null; }
    const context = await this.#knowledgeContext(user.id, project.id);
    const kg = await this.#files(user.id, project, "kg");
    const wiki = await this.#files(user.id, project, "wiki");
    if (context?.kind === "geo-project") await context.current();
    if (!kg.length && !wiki.length) return null;
    return {
      entities: kg.filter((file) => /^entities\/[^/]+\.md$/i.test(file.path)).map((file) => ({ path: file.path, text: file.content })),
      relations: kg.find((file) => file.path === "relations.jsonl")?.content ?? "",
      pages: wiki.filter((file) => /\.md$/i.test(file.path)).map((file) => ({ uri: file.path, text: file.content })),
    };
  }

  /**
   * The compiled files for a vault export: each with its text and the documents it cites, as the ledger mirrors them.
   * @param {string} userId @param {any} project
   */
  async vaultFiles(userId, project) {
    /** @type {Array<{ tree: string, path: string, content: string, title: string }>} */
    const files = [];
    for (const tree of /** @type {Array<"wiki" | "kg">} */ (KNOWLEDGE_TREES)) {
      for (const file of await this.#files(userId, project, tree)) files.push({ tree, path: file.path, content: file.content, title: file.record.title ?? file.path });
    }
    const context = await this.#knowledgeContext(userId, project.id);
    const roots = context?.kind === "geo-project" ? { ...context.resources.roots(), library: null } : this.resources.roots(userId, project.id);
    if (context?.kind === "geo-project") await context.current();
    return { files, roots: { wiki: roots.wiki, kg: roots.kg, sources: roots.sources, library: roots.library } };
  }

  /**
   * The state of a project's compile, in the words a page shows.
   * @param {string} userId @param {string} projectId
   */
  async summary(userId, projectId) {
    const context = await this.#knowledgeContext(userId, projectId);
    const { value } = await this.#state(userId, projectId);
    const pages = await this.#pageRecords(userId, projectId);
    const wiki = pages.filter((row) => row.payload.tree === "wiki");
    const kg = pages.filter((row) => row.payload.tree === "kg");
    const readable = this.enabled ? (await this.#readableSources(userId, projectId)).length : 0;
    const ready = this.engine?.ready?.("knowledge") ?? null;
    const run = context?.kind === "geo-project" && !value.run?.generationId ? null : value.run;
    const running = run ? (run.step === "wiki" || run.step === "kg" ? run[run.step] : null) : null;
    const pending = Object.keys(value.pending ?? {}).length;
    const state = !this.enabled ? "disabled"
      : run ? "compiling"
        : ready && !ready.ok ? "engine_unavailable"
          : pending ? (readable < this.config.knowledgePagesMinSources && !pages.length ? "below_threshold" : "queued")
            : value.lastError ? "failed" : wiki.length ? "compiled" : readable < this.config.knowledgePagesMinSources ? "below_threshold" : "idle";
    if (context?.kind === "geo-project") await context.current();
    return {
      enabled: this.enabled, state,
      engine: ready ? { ok: ready.ok, code: ready.code } : null,
      stage: run ? { tree: run.step === "kg" || run.step === "kg-start" ? "kg" : "wiki", step: run.step, task: running?.stage ?? null, status: running?.status ?? null, startedAt: run.startedAt } : null,
      pages: wiki.length, graphFiles: kg.length,
      typedPages: { wiki: wiki.filter((row) => row.payload.typed).length, kg: kg.filter((row) => row.payload.typed).length },
      stale: pages.filter((row) => row.payload.stale?.sources?.length).length,
      userEdited: pages.filter((row) => row.payload.userEdits?.blocks?.length).length,
      quotations: wiki.reduce((sum, row) => ({ present: sum.present + (row.payload.quotations?.counts?.present ?? 0), absent: sum.absent + (row.payload.quotations?.counts?.absent ?? 0),
        none: sum.none + (row.payload.quotations?.counts?.noQuotation ?? 0) }), { present: 0, absent: 0, none: 0 }),
      held: 0, pending, readable, minSources: this.config.knowledgePagesMinSources, round: value.round, language: value.language ?? null,
      // Why no round runs, in the words a person reads: a request for one below the threshold is accepted (the next document asks
      // for a new round by itself) and then closed, and a status that only said `below_threshold` left the person who had just
      // pressed 「重新整理」 with nothing to say why.
      message: state === "below_threshold" ? thresholdSentence(readable, this.config.knowledgePagesMinSources) : null,
      compiledAt: wiki.length ? value.compiledAt : null, lastRound: wiki.length ? value.lastRound : null, lastError: value.lastError, writeBacksQueued: (value.writeBacks ?? []).length,
    };
  }

  status() { return { enabled: this.enabled, ...this.counters }; }
}
