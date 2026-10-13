import { createHash } from "node:crypto";
import {
  KNOWLEDGE_PAGE_ENGINE_LIMIT, KNOWLEDGE_PAGE_SUBMIT_LIMIT, KNOWLEDGE_TREES, applyKnowledgePageEdits, checkPageQuotations, diffKnowledgePageEdit,
  emptyKnowledgeUserEdits, isKnowledgeMirrorPath, isTypedKnowledgePage, knowledgeGraphToGraph, knowledgeMirrorPathOf,
  knowledgeSourceIdOfUri, readKnowledgePage, wikiPagesToGraph,
} from "@evimed/domain";
import { compileIdempotencyKey } from "./openVikingResources.mjs";
import { isCompiledPage } from "./openVikingSourceSync.mjs";
import { HttpError } from "./security.mjs";
import { projectSourceManifestRecord, sourceIndexDocument } from "./sourceService.mjs";

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
 * - **Mirror first, then compile, and never at 100 typed pages.** At 128 the engine does not fail: its model rewrote
 *   102 existing pages into one-line stubs to fit and the task said `completed`. The pages as they stood are in the
 *   ledger before any compile is submitted, and a target at `KNOWLEDGE_PAGE_SUBMIT_LIMIT` is not submitted to at all —
 *   the project's state says so (`limited`) and everything already compiled stays as it is.
 * - **A person's edit is a ledger revision first, then a write-back.** Their blocks are kept on the page's record,
 *   named verbatim in every compile instruction, and put back by code after a compile that dropped them (measured: the
 *   engine keeps them one recompile and loses them the next). A compile and a write-back never touch one target at
 *   the same time: while a round runs, a save is queued and written when the round ends.
 * - **Quotation labels are laid on afterwards.** For every source link whose title carries a quotation, whether it is
 *   in the captured text of the document it names (`checkPageQuotations`). ✓ and ⚠ are stored beside the page; a page
 *   or a sentence without a quotation simply has no label, and no page waits for or is refused by any of it.
 * - **A change is a label and a queue entry, never a verdict.** A document that was replaced, removed or retracted
 *   marks the pages that link to it (found in the mirror by recorded document id) and queues a recompile.
 * - **The engine being down stops compiling and nothing else.** Uploads, search and conversations never wait on this
 *   module; pages already mirrored stay readable, and the status says when they were last compiled.
 *
 * Build to delete: the user-block carry and the 100-page stop go when the pin reaches a release whose Compile takes a
 * version precondition and has no page limit (upstream `main` after PR #5750); the mirror and the labels stay.
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
const LAYOUT_INSTRUCTION = "Write every file directly under the target directory — index.md, the type directories and relations.jsonl at its top level — and never create a subdirectory named after the target.";
const LANGUAGE_NAMES = new Map([["zh", "Simplified Chinese"], ["zh-cn", "Simplified Chinese"], ["zh-hans", "Simplified Chinese"], ["zh-tw", "Traditional Chinese"],
  ["zh-hk", "Traditional Chinese"], ["zh-hant", "Traditional Chinese"], ["en", "English"], ["ja", "Japanese"], ["ko", "Korean"], ["fr", "French"], ["de", "German"],
  ["es", "Spanish"], ["pt", "Portuguese"], ["ru", "Russian"], ["it", "Italian"]]);

/** @param {string | Buffer} bytes @returns {string} */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
   *   libraryText?: ((userId: string, sourceId: string) => Promise<string | null>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   *   `resources`: `OpenVikingResources`; `engine`: `OpenVikingEngine` (its `ready("knowledge")`); `sourceSync`: `OpenVikingSourceSync`;
   *   `libraryText`: the account library's own copy of a document, which a compile reads beside the project's documents
   */
  constructor({ config, documents, jobs, sources, store, resources, engine = null, sourceSync = null, entries, libraryText = null, now = () => new Date(), report = () => {} }) {
    this.config = config; this.documents = documents; this.jobs = jobs; this.sources = sources; this.store = store;
    this.resources = resources; this.engine = engine; this.sourceSync = sourceSync; this.entries = entries; this.libraryText = libraryText; this.now = now; this.report = report;
    this.counters = { rounds: 0, failed: 0, compiles: 0, pagesMirrored: 0, pagesRetired: 0, blocksRestored: 0, writeBacks: 0, limited: 0, deferred: 0,
      quotationsPresent: 0, quotationsAbsent: 0, tokens: 0, misplaced: 0 };
  }

  /** Compiling is on: the switch, and an engine to compile with. Pages that exist are readable either way. */
  get enabled() { return this.config.ovKnowledgeEnabled === true && Boolean(this.resources?.configured); }

  // -------------------------------------------------------------------------------------------------------------------
  // The ledger

  /** @param {string} userId @param {string} projectId */
  async #state(userId, projectId) {
    const row = await this.documents.get(userId, "knowledge", stateId(projectId));
    const base = { recordType: STATE_RECORD, projectId, round: 1, pending: {}, lastChangeAt: null, compiledAt: null, lastRound: null, lastError: null,
      run: null, language: null, pages: { wiki: 0, kg: 0 }, limited: { wiki: false, kg: false }, writeBacks: [] };
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
   * A document became readable: the project has something new to compile. Never throws; a page is not a document to compile.
   * @param {string} userId @param {string} projectId @param {string} sourceId
   */
  async noteSourceReady(userId, projectId, sourceId) {
    if (!this.enabled) return;
    try {
      const source = await this.sources.get(userId, sourceId);
      if (!source || source.projectId !== projectId || KnowledgePageService.isPage(source)) return;
      const changed = await this.#updateState(userId, projectId, (value) => {
        if (value.pending[sourceId]) return null;
        value.pending[sourceId] = "added";
        value.lastChangeAt = this.now().toISOString();
        return value;
      });
      if (changed.pending[sourceId]) await this.schedule(userId, projectId);
    } catch (error) { this.report(codeOf(error)); }
  }

  /**
   * Documents that pages cite have changed — replaced, removed, retracted. The pages are labelled at once, from the
   * mirror's own record of which documents each page links to, and the project is queued for a recompile.
   * @param {string} userId @param {string} projectId @param {Array<{ sourceId: string, reason: "changed" | "retracted" | "removed" }>} changes
   * @returns {Promise<{ pages: number }>}
   */
  async noteSourcesChanged(userId, projectId, changes) {
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
    } catch (error) { this.report(codeOf(error)); return { pages: 0 }; }
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
    for (const id of new Set(ids)) {
      if (cache.has(id) || !SOURCE_ID.test(id)) continue;
      try {
        const source = await this.sources.get(userId, id).catch(() => null);
        if (!source || source.projectId !== projectId || source.deletedAt || KnowledgePageService.isPage(source)) {
          // Not a document of this project: the account's library may hold it, and its copy there is what the compile read.
          const copy = this.libraryText ? await this.libraryText(userId, id).catch(() => null) : null;
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

  /** Titles of documents by id, for a list that only names them. @param {string} userId @param {string} projectId @param {Iterable<string>} ids */
  async #titles(userId, projectId, ids) {
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const id of new Set(ids)) {
      if (!SOURCE_ID.test(id)) continue;
      try {
        const source = await this.sources.get(userId, id);
        if (source && source.projectId === projectId && !source.deletedAt) titles.set(id, projectSourceManifestRecord(source).display.title);
      } catch { /* a document that is gone has no title to show */ }
    }
    return titles;
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
      quotations = { checkedSha256: sha256(content), checkedAt: this.now().toISOString(), counts,
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
            await this.resources.writePage(userId, entry.uri, text);
            this.counters.writeBacks += 1; this.counters.blocksRestored += restored.length; summary.restored += restored.length;
          }
        }
        const digest = sha256(text);
        if (record && record.sha256 === digest) { summary.unchanged += 1; continue; }
        const described = await this.#describe(userId, projectId, tree, rel, text, texts);
        const written = await this.entries.writePage({ user, project, tree, rel, buffer: Buffer.from(text, "utf8"), title: described.title });
        const at = this.now().toISOString();
        await this.#savePage(userId, projectId, tree, rel, (value) => ({
          recordType: PAGE_RECORD, projectId, tree, path: rel, uri: entry.uri, pageSourceId: written.source.id, sha256: digest, engineSha256: sha256(engineText),
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

  /** Write the saves that were queued while a round ran, or while the engine could not be reached. @param {any} user @param {any} project */
  async #flushWriteBacks(user, project) {
    const { value } = await this.#state(user.id, project.id);
    const queued = Array.isArray(value.writeBacks) ? value.writeBacks : [];
    if (!queued.length) return 0;
    /** @type {any[]} */
    const left = [];
    for (const entry of queued) {
      try {
        const text = await this.entries.readPage(project, entry.tree, entry.path);
        if (text != null) {
          await this.resources.writePage(user.id, `${this.resources.treeUri(user.id, project.id, entry.tree)}/${entry.path}`, text);
          this.counters.writeBacks += 1;
        }
      } catch (error) { left.push(entry); this.report(codeOf(error)); }
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
   * Submit one tree's compile unless the target is at the page limit. Returns the task, or `{ limited: true }`.
   * @param {any} user @param {any} project @param {"wiki" | "kg"} tree @param {any} state @param {number} typed @param {number} attempt
   */
  async #submit(user, project, tree, state, typed, attempt) {
    if (typed >= KNOWLEDGE_PAGE_SUBMIT_LIMIT) { this.counters.limited += 1; return { limited: true }; }
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
    return { limited: false, taskId: task.taskId, key, submittedAt: this.now().toISOString(), status: task.status, stage: task.stage };
  }

  /**
   * Run (or continue) one job. A round is a short sequence of steps — make the engine's copy of the documents agree,
   * mirror, submit the wiki compile, wait, mirror and label, the same for the graph — and each call does the next one
   * and answers what the worker should do: `{ result }` finished; `{ defer: { code, delayMs } }` come back, with no
   * attempt spent.
   * @param {{ id: string, userId: string, projectId: string, payload: any }} job
   * @returns {Promise<{ result: any } | { defer: { code: string, delayMs: number } }>}
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
        await this.sourceSync.reconcileProject(userId, projectId);
        await this.sourceSync.reconcileLibrary(userId).catch((error) => this.report(codeOf(error)));
      }
      // What the engine holds is in the ledger before a compile may touch it, and nothing a person saved is still waiting.
      await this.#flushWriteBacks(user, project);
      const mirrored = await this.#mirror(user, project, "wiki", { round: state.round });
      const submitted = await this.#submit(user, project, "wiki", state, mirrored.typed, 0);
      await this.#updateState(userId, projectId, (value) => {
        value.pages = { ...value.pages, wiki: mirrored.typed };
        value.limited = { ...value.limited, wiki: submitted.limited };
        value.run = { step: submitted.limited ? "kg-start" : "wiki", startedAt: this.now().toISOString(), changeAt: value.lastChangeAt, wiki: submitted.limited ? null : submitted, kg: null, summary: {} };
        return value;
      });
      return defer(submitted.limited ? "knowledge_page_limit" : "knowledge_compile_running", submitted.limited ? 0 : POLL_MS);
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
      const outcome = { status: task?.status ?? "expired", error: task?.error ?? null, seconds: task?.processingSeconds ?? null, tokens: task?.usage?.totalTokens ?? null, cost, ...mirrored };
      const failed = outcome.status !== "completed";
      if (failed) this.counters.failed += 1;
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
      const submitted = await this.#submit(user, project, "kg", state, mirrored.typed, 0);
      await this.#updateState(userId, projectId, (value) => {
        if (!value.run) return null;
        value.pages = { ...value.pages, kg: mirrored.typed };
        value.limited = { ...value.limited, kg: submitted.limited };
        value.run.kg = submitted.limited ? null : submitted;
        value.run.step = submitted.limited ? "finish" : "kg";
        return value;
      });
      return defer(submitted.limited ? "knowledge_page_limit" : "knowledge_compile_running", submitted.limited ? 0 : POLL_MS);
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

  /**
   * A round that cannot go on as it is — a step kept failing until the job's attempts were spent — is closed: what is
   * mirrored stays, the task (if one is still running) is asked to stop, and the next change asks for a new round.
   * @param {{ userId: string, projectId?: string | null, payload: any }} job @param {string} code
   */
  async recordFailure(job, code) {
    const projectId = String(job.payload?.projectId ?? job.projectId ?? "");
    if (!projectId) return;
    const { value } = await this.#state(job.userId, projectId).catch(() => ({ value: null }));
    for (const tree of ["wiki", "kg"]) {
      const taskId = value?.run?.[tree]?.taskId;
      if (taskId) await this.resources.cancelTask(job.userId, taskId).catch(() => null);
    }
    await this.#updateState(job.userId, projectId, (state) => {
      if (state.round !== Number(job.payload?.round)) return null;
      state.round += 1;
      state.run = null;
      state.lastError = { code, at: this.now().toISOString(), round: Number(job.payload?.round) };
      return state;
    }).catch((error) => this.report(codeOf(error)));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What a person does to a page

  /**
   * A person saved a page in the reader. Their text is the document's next version in the ledger first; what they
   * changed is kept as blocks on the page's record; then the engine's copy is written to match — at once when no round
   * is running, otherwise when the round ends.
   * @param {{ user: any, project: any, source: any, markdown: string, baseSha256?: string | null }} request
   * @returns {Promise<{ source: any, duplicate: boolean, changed: boolean, writeBack: "written" | "queued" | "none", userBlocks: number }>}
   */
  async saveEdit({ user, project, source, markdown, baseSha256 = null }) {
    const where = knowledgeMirrorPathOf(source?.payload?.paths?.[0]);
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
      try { await this.resources.writePage(user.id, uri, text); writeBack = "written"; this.counters.writeBacks += 1; }
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
  async pageView(userId, project, source) {
    const where = knowledgeMirrorPathOf(source?.payload?.paths?.[0]);
    if (!where) throw new HttpError(404, "knowledge_page_not_found", "That document is not a knowledge page.");
    const markdown = await this.entries.readPage(project, where.tree, where.rel);
    if (markdown == null) throw new HttpError(404, "knowledge_page_not_found", "The page could not be read.");
    const records = await this.#pageRecords(userId, project.id, { tree: where.tree });
    const byPath = new Map(records.map((row) => [row.payload.path, row.payload]));
    const ledger = byPath.get(where.rel) ?? null;
    const root = this.resources.treeUri(userId, project.id, where.tree);
    const page = readKnowledgePage(markdown, { path: where.rel, root, known: new Set(byPath.keys()) });
    // The labels of this text: the stored ones when they were computed for these bytes, else computed now.
    const digest = sha256(markdown);
    const texts = new Map();
    const quotations = ledger?.quotations?.checkedSha256 === digest ? ledger.quotations
      : (await this.#describe(userId, project.id, where.tree, where.rel, markdown, texts)).quotations;
    const labelAt = new Map((quotations?.records ?? []).map((/** @type {any} */ record) => [record.index, record]));
    const cited = [...new Set(page.links.filter((link) => link.kind === "source").map((link) => knowledgeSourceIdOfUri(link.uri)).filter(Boolean))];
    const titles = await this.#titles(userId, project.id, /** @type {string[]} */ (cited));
    const links = page.links.map((link) => {
      if (link.kind === "page") {
        const target = byPath.get(/** @type {string} */ (link.path));
        return { kind: "page", text: link.text, path: link.path, sourceId: target?.pageSourceId ?? null, title: target?.title ?? null, exists: Boolean(target), index: link.index, end: link.end };
      }
      if (link.kind === "source") {
        const sourceId = knowledgeSourceIdOfUri(link.uri);
        const label = labelAt.get(link.index);
        return { kind: "source", text: link.text, sourceId, title: sourceId ? titles.get(sourceId) ?? null : null, available: Boolean(sourceId && titles.has(sourceId)),
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
    return {
      sourceId: source.id, tree: where.tree, path: where.rel, slug: where.rel, type: page.type, title: page.title, description: page.description, tags: page.tags,
      markdown, sha256: digest, frontmatter: page.frontmatter, body: page.body, links,
      sources: cited.map((id) => ({ sourceId: id, title: titles.get(/** @type {string} */ (id)) ?? null, available: titles.has(/** @type {string} */ (id)) })),
      quotations: quotations?.counts ? { present: quotations.counts.present, absent: quotations.counts.absent, none: quotations.counts.noQuotation, sourceMissing: quotations.counts.sourceMissing } : null,
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
    // In path order, so a graph's nodes come out the same way every time it is read.
    const records = (await this.#pageRecords(userId, project.id, { tree })).sort((left, right) => (left.payload.path < right.payload.path ? -1 : 1));
    /** @type {{ path: string, content: string, record: any }[]} */
    const files = [];
    for (const row of records) {
      const content = await this.entries.readPage(project, tree, row.payload.path).catch(() => null);
      if (content != null) files.push({ path: row.payload.path, content, record: row.payload });
    }
    return files;
  }

  /**
   * `{ nodes, links }` of a project: the pages and the links between them (`wiki`), or the entities and the relations
   * between them (`kg`), with every source and every piece of evidence mapped back to the knowledge-base document it names.
   * @param {string} userId @param {any} project @param {"wiki" | "kg"} kind
   */
  async graph(userId, project, kind) {
    const files = await this.#files(userId, project, kind);
    const byPath = new Map(files.map((file) => [file.path, file.record]));
    const documentOf = (/** @type {string} */ uri) => knowledgeSourceIdOfUri(uri);
    if (kind === "wiki") {
      const graph = wikiPagesToGraph(files, { root: this.resources.treeUri(userId, project.id, "wiki") });
      const titles = await this.#titles(userId, project.id, graph.nodes.flatMap((node) => node.sources.map((source) => documentOf(source.uri) ?? "")));
      return {
        kind, nodes: graph.nodes.map((node) => {
          const record = byPath.get(node.path);
          const cited = [...new Set(node.sources.map((source) => documentOf(source.uri)).filter(Boolean))];
          return { id: node.id, path: node.path, title: node.title, type: node.type, description: node.description, tags: node.tags, degree: node.degree, sourceId: record?.pageSourceId ?? null,
            stale: record?.stale?.sources ?? [], userEdited: Boolean(record?.userEdits?.blocks?.length), sources: cited.map((id) => ({ sourceId: id, title: titles.get(/** @type {string} */ (id)) ?? null })) };
        }),
        links: graph.links, unresolved: graph.unresolved.length, problems: [],
      };
    }
    const graph = knowledgeGraphToGraph(files);
    const named = [...graph.nodes.flatMap((node) => node.sources), ...graph.links.flatMap((link) => link.evidence)].map((uri) => documentOf(uri) ?? "");
    const titles = await this.#titles(userId, project.id, named);
    const map = (/** @type {string[]} */ uris) => [...new Set(uris.map((uri) => documentOf(uri)).filter(Boolean))].map((id) => ({ sourceId: id, title: titles.get(/** @type {string} */ (id)) ?? null }));
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
    const kg = await this.#files(user.id, project, "kg");
    const wiki = await this.#files(user.id, project, "wiki");
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
    const roots = this.resources.roots(userId, project.id);
    return { files, roots: { wiki: roots.wiki, kg: roots.kg, sources: roots.sources, library: roots.library } };
  }

  /**
   * The state of a project's compile, in the words a page shows.
   * @param {string} userId @param {string} projectId
   */
  async summary(userId, projectId) {
    const { value } = await this.#state(userId, projectId);
    const pages = await this.#pageRecords(userId, projectId);
    const wiki = pages.filter((row) => row.payload.tree === "wiki");
    const kg = pages.filter((row) => row.payload.tree === "kg");
    const readable = this.enabled ? (await this.#readableSources(userId, projectId)).length : 0;
    const ready = this.engine?.ready?.("knowledge") ?? null;
    const run = value.run;
    const running = run ? (run.step === "wiki" || run.step === "kg" ? run[run.step] : null) : null;
    const pending = Object.keys(value.pending ?? {}).length;
    const state = !this.enabled ? "disabled"
      : run ? "compiling"
        : value.limited?.wiki ? "page_limit"
          : ready && !ready.ok ? "engine_unavailable"
            : pending ? (readable < this.config.knowledgePagesMinSources && !pages.length ? "below_threshold" : "queued")
              : value.lastError ? "failed" : wiki.length ? "compiled" : readable < this.config.knowledgePagesMinSources ? "below_threshold" : "idle";
    return {
      enabled: this.enabled, state,
      engine: ready ? { ok: ready.ok, code: ready.code } : null,
      stage: run ? { tree: run.step === "kg" || run.step === "kg-start" ? "kg" : "wiki", step: run.step, task: running?.stage ?? null, status: running?.status ?? null, startedAt: run.startedAt } : null,
      pages: wiki.length, graphFiles: kg.length,
      typedPages: { wiki: wiki.filter((row) => row.payload.typed).length, kg: kg.filter((row) => row.payload.typed).length },
      pageLimit: KNOWLEDGE_PAGE_SUBMIT_LIMIT, engineLimit: KNOWLEDGE_PAGE_ENGINE_LIMIT, limited: value.limited ?? { wiki: false, kg: false },
      stale: pages.filter((row) => row.payload.stale?.sources?.length).length,
      userEdited: pages.filter((row) => row.payload.userEdits?.blocks?.length).length,
      quotations: wiki.reduce((sum, row) => ({ present: sum.present + (row.payload.quotations?.counts?.present ?? 0), absent: sum.absent + (row.payload.quotations?.counts?.absent ?? 0),
        none: sum.none + (row.payload.quotations?.counts?.noQuotation ?? 0) }), { present: 0, absent: 0, none: 0 }),
      held: 0, pending, readable, minSources: this.config.knowledgePagesMinSources, round: value.round, language: value.language ?? null,
      compiledAt: value.compiledAt, lastRound: value.lastRound, lastError: value.lastError, writeBacksQueued: (value.writeBacks ?? []).length,
    };
  }

  status() { return { enabled: this.enabled, ...this.counters }; }
}
