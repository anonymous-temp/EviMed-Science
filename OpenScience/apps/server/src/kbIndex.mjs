import path from "node:path";
import { workspaceLayout } from "@evimed/domain";
import { chunkDocument, embeddingText, estimateTokens, trigramTerms, tsqueryLiteral, tsvectorLiteral } from "./kbChunker.mjs";
import { migrateKnowledgeBaseIndex } from "./kbPersistence.mjs";
import { searchTokens } from "./memoryRecallPolicy.mjs";
import { HttpError } from "./security.mjs";
import { sourceParserRevision } from "./sourceService.mjs";

/**
 * Knowledge-base search: the index a run's `kb_search` reads, and the worker
 * that keeps it equal to the sources.
 *
 * Hidden knowledge, and the rulings it follows (plan §3.2):
 *
 * - It is a tool the model chooses, never a retrieval forced into every turn
 *   (principle 12). A library small enough to read whole is answered with the
 *   list of files to read, and that advice lives in the result, not in control
 *   flow (principle 7): Anthropic's guidance is not to retrieve under ~200K
 *   tokens, and with a 1M context and a 98% cache hit rate reading is cheaper
 *   than being wrong about what retrieval missed.
 * - Past that it is hybrid: CJK-pair and word terms in a `tsvector` (the same
 *   tokenizer recall uses), trigram similarity for drug names and misspellings,
 *   and cosine similarity over embeddings, fused by reciprocal rank (k = 60 —
 *   the constant the RRF paper settled on and memory recall uses) and then
 *   reranked by `qwen3-rerank` with an instruction about this kind of question.
 *   A leg whose extension or key is missing is skipped and the result says
 *   which ran; a reranker that fails keeps the fused order.
 * - Every hit carries UTF-16 offsets into the captured text — the text a
 *   quotation is checked against — and the snippet is exactly that slice.
 * - The index is derived. The worker indexes any searchable source whose text
 *   it does not hold, fills vectors in bounded batches so a long document is
 *   keyword-searchable at once, and drops index documents no live source still
 *   names. `pnpm rebuild:kb-index` empties and refills it.
 * - It reads no memory: notes and records are the memory port's (principle 18).
 */

/** The rank-fusion constant (Cormack et al., 2009), as memory recall uses. */
export const KB_RRF_K = 60;
/** How many candidates each leg contributes, and how many the reranker sees. */
const LEG_LIMIT = 50;
const RERANK_CANDIDATES = 30;
/** How much text one hit quotes: a passage, not a page. */
const SNIPPET_CHARS = 700;
/** Chunks embedded per worker pass: ten requests of ten. */
const EMBED_BATCH = 100;
/** How many chunk rows one insert statement carries. */
const INSERT_BATCH = 200;
/** A source whose indexing failed is not retried before this. */
const FAILURE_BACKOFF_MS = 5 * 60_000;
const SEARCHABLE_STATUSES = Object.freeze(["complete", "needs_attention"]);

/** What the reranker is asked to rank for (English, per qwen3-rerank's docs). */
export const KB_RERANK_INSTRUCT = "Given a question from a clinical pharmacist or medical researcher, rank passages from their own documents by how directly each answers it; exact drug names, doses and abbreviations matter";

/** The SQL twin of `sourceParserRevision`: the key a source's text is indexed
 *  under, read from its stored analysis. */
const REVISION_SQL = `coalesce(d.payload->'analysis'->>'parserRevision',
  (d.payload->'analysis'->'extractor'->>'name') || '@' || (d.payload->'analysis'->'extractor'->>'version'))`;

/** An index document some live source can re-derive. */
const DERIVABLE_SQL = `EXISTS (SELECT 1 FROM evimed_product.documents d WHERE d.user_id=k.user_id AND d.kind='source' AND d.deleted_at IS NULL
  AND d.payload->'fingerprint'->>'sha256'=k.sha256 AND d.payload->'analysis'->>'textSha256'=k.text_sha256
  AND ${REVISION_SQL}=k.parser_revision)`;

/** An index document the personal library's copy of a document is searched
 *  through; $2–$5 are the held keys' user, sha256, revision and text digest. */
const HELD_SQL = `EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS h(user_id, sha256, parser_revision, text_sha256)
  WHERE h.user_id=k.user_id AND h.sha256=k.sha256 AND h.parser_revision=k.parser_revision AND h.text_sha256=k.text_sha256)`;

/** One index document's identity, the same whichever side names it.
 * @param {{ sha256: string, parser_revision?: string, parserRevision?: string, text_sha256?: string, textSha256?: string }} row */
function keyOf(row) {
  return `${row.sha256}\u0000${row.parser_revision ?? row.parserRevision}\u0000${row.text_sha256 ?? row.textSha256}`;
}

/** A window of a chunk around where the question's terms occur, never cutting
 *  a surrogate pair. Offsets stay absolute.
 * @param {string} content @param {number} start @param {string[]} terms */
function snippetWindow(content, start, terms) {
  if (content.length <= SNIPPET_CHARS) return { start, end: start + content.length, snippet: content };
  const lower = content.toLowerCase();
  let at = -1;
  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    at = lower.indexOf(term);
    if (at !== -1) break;
  }
  let from = at === -1 ? 0 : Math.max(0, Math.min(content.length - SNIPPET_CHARS, at - Math.floor(SNIPPET_CHARS / 3)));
  let to = from + SNIPPET_CHARS;
  if (from > 0 && content.charCodeAt(from) >= 0xDC00 && content.charCodeAt(from) <= 0xDFFF) from += 1;
  if (to < content.length && content.charCodeAt(to - 1) >= 0xD800 && content.charCodeAt(to - 1) <= 0xDBFF) to -= 1;
  return { start: start + from, end: start + to, snippet: content.slice(from, to) };
}

export class KnowledgeBaseIndex {
  /**
   * @param {{ database: any, sources: any, embedder?: any, rerank?: any, dimension: number,
   *   smallLibraryTokens?: number, reconcileMs?: number, canRun?: () => boolean, report?: (code: string) => void }} options
   */
  constructor({ database, sources, embedder = null, rerank = null, dimension, smallLibraryTokens = 150_000, reconcileMs = 60_000,
    canRun = () => true, report = () => {} }) {
    if (!database || !sources) throw new TypeError("The knowledge-base index needs the product database and the source service.");
    this.database = database;
    this.sources = sources;
    this.embedder = embedder;
    this.rerank = rerank;
    this.dimension = dimension;
    this.smallLibraryTokens = smallLibraryTokens;
    this.reconcileMs = reconcileMs;
    // Maintenance (a restore, an export) pauses background writers; the index
    // waits for it like every other worker rather than racing it.
    this.canRun = canRun;
    this.report = report;
    /** @type {any} */
    this.library = null;
    this.timer = null;
    this.wakeTimer = null;
    this.running = null;
    this.closed = false;
    this.lastError = null;
    this.capabilities = null;
    /** @type {Map<string, number>} source key → retry-after epoch ms */
    this.backoff = new Map();
    this.counters = { indexedDocuments: 0, indexFailures: 0, embeddedChunks: 0, searches: 0, searchFailures: 0, smallLibraryAnswers: 0 };
  }

  /**
   * The personal library joins the search scope (plan §3.2 #4). It answers
   * three questions, and the index asks it nothing else: which of its copies a
   * run may search (`searchScope`), which index documents those copies are
   * searched through (`heldIndexKeys` — kept when no project names them any
   * more), and a convergence pass over its copies (`syncCopies`).
   * @param {{ searchScope: (userId: string) => Promise<any[]>, heldIndexKeys: (userId: string | null) => Promise<{ userId: string, sha256: string, parserRevision: string, textSha256: string }[]>, syncCopies: (options: { userId?: string | null }) => Promise<any> } | null} library
   */
  useLibrary(library) { this.library = library; return this; }

  async ready() {
    const capabilities = await migrateKnowledgeBaseIndex(this.database, { dimension: this.dimension });
    if (!this.capabilities && capabilities.vector && this.embedder?.configured) {
      // A model or width change since the vectors were written: those vectors
      // are not comparable with a new query's, so they are cleared for
      // re-embedding rather than searched.
      await this.database.query(`UPDATE evimed_kb.chunks c SET embedding=NULL FROM evimed_kb.documents d
        WHERE c.user_id=d.user_id AND c.sha256=d.sha256 AND c.parser_revision=d.parser_revision AND c.text_sha256=d.text_sha256
        AND d.embedding_model IS NOT NULL AND d.embedding_model<>$1 AND c.embedding IS NOT NULL`, [this.embedder.modelKey]);
      await this.database.query("UPDATE evimed_kb.documents SET embedding_model=NULL WHERE embedding_model IS NOT NULL AND embedding_model<>$1", [this.embedder.modelKey]);
    }
    this.capabilities = capabilities;
    return capabilities;
  }

  status() {
    return {
      capabilities: this.capabilities,
      embeddings: Boolean(this.embedder?.configured),
      rerank: Boolean(this.rerank?.configured),
      lastError: this.lastError,
      counters: { ...this.counters, ...(this.embedder ? { embedding: { ...this.embedder.counters } } : {}) },
    };
  }

  start() {
    this.closed = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.reconcileMs);
    this.timer.unref?.();
    this.wake();
  }

  /** Ask for a pass soon — after a source finishes, say — without stacking them. */
  wake() {
    if (this.wakeTimer || this.closed) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; void this.tick(); }, 250);
    this.wakeTimer.unref?.();
  }

  async tick() {
    if (this.running) return this.running;
    if (!this.canRun()) return null;
    this.running = this.sync().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "kb_index_failed";
      this.report(this.lastError);
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.running;
  }

  /**
   * One convergence pass: index what is missing, fill vectors, drop what no
   * source names any more, and bring the library's copies up to date.
   * @param {{ userId?: string | null, limit?: number }} [options]
   */
  async sync({ userId = null, limit = 10 } = {}) {
    const capabilities = await this.ready();
    const pending = await this.database.query(`SELECT d.user_id, d.id, d.project_id, d.payload, d.revision FROM evimed_product.documents d
      WHERE d.kind='source' AND d.deleted_at IS NULL AND d.payload->>'status'=ANY($3::text[])
        AND d.payload->'analysis'->>'textSha256' IS NOT NULL
        AND ($1::text IS NULL OR d.user_id=$1)
        AND NOT EXISTS (SELECT 1 FROM evimed_kb.documents k WHERE k.user_id=d.user_id AND k.sha256=d.payload->'fingerprint'->>'sha256'
          AND k.text_sha256=d.payload->'analysis'->>'textSha256' AND k.parser_revision=${REVISION_SQL})
      ORDER BY d.updated_at, d.id LIMIT $2`, [userId, Math.max(1, limit * 4), [...SEARCHABLE_STATUSES]]);
    let indexed = 0;
    let failed = 0;
    const seen = new Set();
    for (const row of pending.rows) {
      if (indexed + failed >= limit) break;
      const key = keyOf({ sha256: row.payload.fingerprint?.sha256, parserRevision: sourceParserRevision(row.payload.analysis), textSha256: row.payload.analysis?.textSha256 });
      const backoffKey = `${row.user_id}\u0000${key}`;
      if (seen.has(backoffKey) || (this.backoff.get(backoffKey) ?? 0) > Date.now()) continue;
      seen.add(backoffKey);
      try {
        await this.indexSource(row);
        this.backoff.delete(backoffKey);
        indexed += 1;
      } catch (error) {
        failed += 1;
        this.counters.indexFailures += 1;
        this.lastError = typeof error?.code === "string" ? error.code : "kb_index_failed";
        this.backoff.set(backoffKey, Date.now() + FAILURE_BACKOFF_MS);
      }
    }
    const embedded = capabilities.vector && this.embedder?.configured ? await this.#embedMissing(userId) : 0;
    const removed = await this.#collect(userId);
    const library = this.library ? await this.library.syncCopies({ userId }).catch(() => null) : null;
    if (!failed) this.lastError = null;
    return { indexed, failed, embedded, removed, ...(library ? { library } : {}) };
  }

  /**
   * Index one source's captured text: chunks and terms in one transaction, so
   * a search never sees half a document. Vectors follow in bounded batches.
   * @param {{ user_id: string, id: string, project_id: string, payload: any, revision?: number }} row
   */
  async indexSource(row) {
    const source = { id: row.id, projectId: row.project_id, payload: row.payload, revision: row.revision };
    const capture = await this.sources.loadCapture(row.user_id, source);
    if (!capture) throw new HttpError(409, "kb_capture_unavailable", "The source has no current capture to index.");
    const text = capture.input.text;
    const title = String(row.payload.metadata?.title || path.posix.basename(String(row.payload.paths?.[0] ?? row.id))).slice(0, 1000);
    const chunks = chunkDocument({ text, pageMap: capture.pageMap, title }).map((chunk) => {
      const content = text.slice(chunk.start, chunk.end);
      return { ...chunk, content, lexemes: tsvectorLiteral(`${chunk.prefix}\n${content}`) };
    });
    const key = { sha256: row.payload.fingerprint.sha256, revision: sourceParserRevision(row.payload.analysis), textSha256: row.payload.analysis.textSha256 };
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kb:${row.user_id}:${key.sha256}:${key.revision}:${key.textSha256}`]);
      await client.query("DELETE FROM evimed_kb.documents WHERE user_id=$1 AND sha256=$2 AND parser_revision=$3 AND text_sha256=$4",
        [row.user_id, key.sha256, key.revision, key.textSha256]);
      await client.query(`INSERT INTO evimed_kb.documents(user_id,sha256,parser_revision,text_sha256,title,char_count,token_estimate,chunk_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.user_id, key.sha256, key.revision, key.textSha256, title, text.length, estimateTokens(text), chunks.length]);
      for (let at = 0; at < chunks.length; at += INSERT_BATCH) {
        const batch = chunks.slice(at, at + INSERT_BATCH);
        await client.query(`INSERT INTO evimed_kb.chunks(user_id,sha256,parser_revision,text_sha256,ordinal,start_offset,end_offset,page,heading_path,context_prefix,content,lexemes)
          SELECT $1,$2,$3,$4,x.ordinal,x.start_offset,x.end_offset,x.page,x.heading_path,x.context_prefix,x.content,x.lexemes::tsvector
          FROM unnest($5::integer[],$6::integer[],$7::integer[],$8::integer[],$9::text[],$10::text[],$11::text[],$12::text[])
            AS x(ordinal,start_offset,end_offset,page,heading_path,context_prefix,content,lexemes)`,
        [row.user_id, key.sha256, key.revision, key.textSha256, batch.map((chunk) => chunk.ordinal), batch.map((chunk) => chunk.start),
          batch.map((chunk) => chunk.end), batch.map((chunk) => chunk.page), batch.map((chunk) => chunk.headingPath),
          batch.map((chunk) => chunk.prefix), batch.map((chunk) => chunk.content), batch.map((chunk) => chunk.lexemes)]);
      }
    });
    this.counters.indexedDocuments += 1;
    return { chunks: chunks.length };
  }

  /** Vectors for chunks that have none, a bounded batch per pass; a document
   *  is marked embedded once its last chunk is. @param {string | null} userId */
  async #embedMissing(userId) {
    const rows = (await this.database.query(`SELECT c.user_id, c.sha256, c.parser_revision, c.text_sha256, c.ordinal, c.context_prefix, c.content
      FROM evimed_kb.chunks c JOIN evimed_kb.documents d USING (user_id, sha256, parser_revision, text_sha256)
      WHERE c.embedding IS NULL AND d.embedding_model IS NULL AND ($1::text IS NULL OR c.user_id=$1)
      ORDER BY d.indexed_at, c.ordinal LIMIT $2`, [userId, EMBED_BATCH])).rows;
    if (!rows.length) return 0;
    let vectors;
    try {
      vectors = await this.embedder.embedDocuments(rows.map((row) => embeddingText({ prefix: row.context_prefix }, row.content)));
    } catch (error) {
      // Keyword search already works for these chunks; vectors wait for the next pass.
      this.lastError = typeof error?.code === "string" ? error.code : "kb_embedding_failed";
      return 0;
    }
    await this.database.transaction(async (client) => {
      for (const [index, row] of rows.entries()) {
        await client.query(`UPDATE evimed_kb.chunks SET embedding=$6::vector WHERE user_id=$1 AND sha256=$2 AND parser_revision=$3 AND text_sha256=$4 AND ordinal=$5`,
          [row.user_id, row.sha256, row.parser_revision, row.text_sha256, row.ordinal, `[${vectors[index].join(",")}]`]);
      }
      await client.query(`UPDATE evimed_kb.documents d SET embedding_model=$1 WHERE d.embedding_model IS NULL AND ($2::text IS NULL OR d.user_id=$2)
        AND NOT EXISTS (SELECT 1 FROM evimed_kb.chunks c WHERE c.user_id=d.user_id AND c.sha256=d.sha256
          AND c.parser_revision=d.parser_revision AND c.text_sha256=d.text_sha256 AND c.embedding IS NULL)`, [this.embedder.modelKey, userId]);
    });
    this.counters.embeddedChunks += rows.length;
    return rows.length;
  }

  /** Drop index documents no live source names any more, except those the
   *  personal library still searches its copy of a document through.
   *  @param {string | null} userId */
  async #collect(userId) {
    const held = await this.#heldKeys(userId);
    const result = await this.database.query(`DELETE FROM evimed_kb.documents k WHERE ($1::text IS NULL OR k.user_id=$1)
      AND NOT ${DERIVABLE_SQL} AND NOT ${HELD_SQL}`, [userId, ...held]);
    return result.rowCount ?? 0;
  }

  /** The library's held index keys, as the four parallel arrays `HELD_SQL`
   *  reads. @param {string | null} userId */
  async #heldKeys(userId) {
    const keys = this.library ? await this.library.heldIndexKeys(userId) : [];
    return [keys.map((key) => key.userId), keys.map((key) => key.sha256), keys.map((key) => key.parserRevision), keys.map((key) => key.textSha256)];
  }

  /** Empty the index for these accounts (all when none are named) and refill
   *  it until nothing is pending. What no source can re-derive — the library's
   *  copy of a document whose every project copy is gone — is kept: emptying
   *  it would lose that document's search for good.
   *  @param {{ userIds?: string[] | null }} [options] */
  async rebuild({ userIds = null } = {}) {
    await this.ready();
    for (const scope of userIds ?? [null]) {
      const held = await this.#heldKeys(scope);
      await this.database.query(`DELETE FROM evimed_kb.documents k WHERE ($1::text IS NULL OR k.user_id=$1)
        AND (${DERIVABLE_SQL} OR NOT ${HELD_SQL})`, [scope, ...held]);
    }
    this.backoff.clear();
    const totals = { indexed: 0, failed: 0, embedded: 0 };
    for (const scope of userIds ?? [null]) {
      for (let pass = 0; pass < 10_000; pass += 1) {
        const result = await this.sync({ userId: scope, limit: 20 });
        totals.indexed += result.indexed;
        totals.failed += result.failed;
        totals.embedded += result.embedded;
        if (!result.indexed && !result.embedded) break;
      }
    }
    return totals;
  }

  /**
   * The documents a run may search: its project's sources and the user's
   * library, each with the path a run reads it at. The library answers for its
   * own entries — a copy it holds is searchable even once no project does.
   * @param {string} userId @param {string} projectId @param {string[] | null} sourceIds
   */
  async #scope(userId, projectId, sourceIds) {
    const rows = (await this.database.query(`SELECT id, project_id, payload FROM evimed_product.documents
      WHERE user_id=$1 AND project_id=$2 AND kind='source' AND deleted_at IS NULL
      ORDER BY created_at, id`, [userId, projectId])).rows;
    const project = rows.map((row) => {
      const payload = row.payload;
      const artifact = typeof payload.outputs?.artifactPath === "string" ? payload.outputs.artifactPath : "";
      const readPath = artifact.startsWith("knowledge-base/") ? `${workspaceLayout.knowledgeDir}/${artifact.slice("knowledge-base/".length)}` : null;
      const analysis = payload.analysis ?? {};
      return {
        sourceId: row.id, origin: "project",
        title: String(payload.metadata?.title || path.posix.basename(String(payload.paths?.[0] ?? row.id))),
        status: payload.status, path: readPath,
        searchable: SEARCHABLE_STATUSES.includes(payload.status) && typeof analysis.textSha256 === "string" && Boolean(readPath),
        sha256: payload.fingerprint?.sha256, parserRevision: sourceParserRevision(analysis), textSha256: analysis.textSha256,
        tokens: Number.isSafeInteger(analysis.tokenEstimate) ? analysis.tokenEstimate : Math.round((Number(analysis.unitCount) || 0) * 8000 / 2),
        pages: analysis.pageCount ?? null,
      };
    });
    /** @type {any[]} */
    const library = this.library ? (await this.library.searchScope(userId)).map((/** @type {any} */ entry) => ({ ...entry, origin: "library" })) : [];
    const wanted = sourceIds?.length ? new Set(sourceIds) : null;
    /** @param {{ sourceId: string }} entry */
    const named = (entry) => !wanted || wanted.has(entry.sourceId);
    // One document, one entry: a document the project holds is read from the
    // project's own copy and the library's copy of it is left out — unless the
    // library's is the only one ready to read.
    /** @type {any[]} */
    const scope = project.filter(named);
    for (const entry of library.filter(named)) {
      const at = scope.findIndex((other) => other.origin === "project" && other.sha256 === entry.sha256);
      if (at === -1) scope.push(entry);
      else if (!scope[at].searchable && entry.searchable) scope[at] = entry;
    }
    return scope;
  }

  /**
   * Answer one `kb_search`.
   * @param {{ userId: string, projectId: string, query: string, limit?: number, sourceIds?: string[] | null }} request
   */
  async search({ userId, projectId, query, limit = 8, sourceIds = null }) {
    this.counters.searches += 1;
    try {
      return await this.#search({ userId, projectId, query, limit, sourceIds });
    } catch (error) {
      this.counters.searchFailures += 1;
      throw error;
    }
  }

  /** @param {{ userId: string, projectId: string, query: string, limit: number, sourceIds: string[] | null }} request */
  async #search({ userId, projectId, query, limit, sourceIds }) {
    const capabilities = await this.ready();
    const scope = await this.#scope(userId, projectId, sourceIds);
    const searchable = scope.filter((entry) => entry.searchable);
    const waiting = scope.filter((entry) => !entry.searchable).map((entry) => ({ sourceId: entry.sourceId, title: entry.title, status: entry.status }));
    const tokens = searchable.reduce((sum, entry) => sum + entry.tokens, 0);
    const library = { documents: scope.length, searchable: searchable.length, tokens };
    if (!searchable.length) {
      return { mode: "empty", query, library, hits: [], waiting,
        note: waiting.length ? "No document in this knowledge base has finished parsing yet; the listed ones are still being processed." : "This knowledge base has no documents." };
    }
    if (tokens < this.smallLibraryTokens) {
      this.counters.smallLibraryAnswers += 1;
      return { mode: "small-library", query, library, hits: [], waiting,
        files: searchable.map((entry) => ({ sourceId: entry.sourceId, title: entry.title, path: entry.path, tokens: entry.tokens,
          ...(entry.pages ? { pages: entry.pages } : {}), origin: entry.origin })),
        note: `This knowledge base is small (about ${tokens} tokens in ${searchable.length} documents): read the listed files directly instead of searching — a search would only show fragments of what reading gives whole.` };
    }
    const indexed = new Set((await this.database.query(`SELECT sha256, parser_revision, text_sha256 FROM evimed_kb.documents
      WHERE user_id=$1 AND sha256=ANY($2::text[])`, [userId, searchable.map((entry) => entry.sha256)])).rows.map(keyOf));
    const ready = searchable.filter((entry) => indexed.has(keyOf(entry)));
    const indexing = searchable.filter((entry) => !indexed.has(keyOf(entry)))
      .map((entry) => ({ sourceId: entry.sourceId, title: entry.title, status: "indexing", path: entry.path }));
    if (!ready.length) {
      return { mode: "indexing", query, library, hits: [], waiting: [...waiting, ...indexing],
        note: "The index is still being built for these documents; read them directly at the listed paths for now." };
    }
    const scopeArrays = [ready.map((entry) => entry.sha256), ready.map((entry) => entry.parserRevision), ready.map((entry) => entry.textSha256)];
    const scopeCte = "WITH scope AS (SELECT * FROM unnest($2::text[], $3::text[], $4::text[]) AS s(sha256, parser_revision, text_sha256))";
    /** @type {Record<string, string[]>} */
    const legs = {};
    const tsquery = tsqueryLiteral(query);
    if (tsquery) {
      legs.keyword = (await this.database.query(`${scopeCte}
        SELECT c.sha256, c.parser_revision, c.text_sha256, c.ordinal FROM evimed_kb.chunks c JOIN scope USING (sha256, parser_revision, text_sha256)
        WHERE c.user_id=$1 AND c.lexemes @@ $5::tsquery
        ORDER BY ts_rank(c.lexemes, $5::tsquery, 1) DESC, c.sha256, c.ordinal LIMIT $6`, [userId, ...scopeArrays, tsquery, LEG_LIMIT]))
        .rows.map((row) => `${keyOf(row)}\u0000${row.ordinal}`);
    }
    const words = trigramTerms(query);
    if (capabilities.trigram && words.length) {
      legs.trigram = (await this.database.query(`${scopeCte}
        SELECT c.sha256, c.parser_revision, c.text_sha256, c.ordinal, max(word_similarity(t.term, c.content)) AS score
        FROM evimed_kb.chunks c JOIN scope USING (sha256, parser_revision, text_sha256) JOIN unnest($5::text[]) AS t(term) ON t.term <% c.content
        WHERE c.user_id=$1 GROUP BY c.sha256, c.parser_revision, c.text_sha256, c.ordinal
        ORDER BY score DESC, c.sha256, c.ordinal LIMIT $6`, [userId, ...scopeArrays, words, LEG_LIMIT]))
        .rows.map((row) => `${keyOf(row)}\u0000${row.ordinal}`);
    }
    let vectorNote = null;
    if (capabilities.vector && this.embedder?.configured) {
      try {
        const vector = await this.embedder.embedQuery(query);
        legs.vector = await this.database.transaction(async (client) => {
          if (capabilities.iterativeScan) await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
          const rows = (await client.query(`${scopeCte}
            SELECT c.sha256, c.parser_revision, c.text_sha256, c.ordinal FROM evimed_kb.chunks c JOIN scope USING (sha256, parser_revision, text_sha256)
            WHERE c.user_id=$1 AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $5::vector LIMIT $6`,
          [userId, ...scopeArrays, `[${vector.join(",")}]`, LEG_LIMIT])).rows;
          return rows.map((row) => `${keyOf(row)}\u0000${row.ordinal}`);
        });
      } catch (error) {
        vectorNote = typeof error?.code === "string" ? error.code : "kb_embedding_failed";
      }
    }
    /** @type {Map<string, { score: number, first: number }>} */
    const fused = new Map();
    for (const [name, ranked] of Object.entries(legs)) {
      ranked.forEach((candidate, index) => {
        const entry = fused.get(candidate) ?? { score: 0, first: Number.MAX_SAFE_INTEGER };
        entry.score += 1 / (KB_RRF_K + index + 1);
        if (name === "keyword") entry.first = Math.min(entry.first, index);
        fused.set(candidate, entry);
      });
    }
    const ordered = [...fused.entries()].sort((left, right) => right[1].score - left[1].score || left[1].first - right[1].first)
      .slice(0, RERANK_CANDIDATES);
    const legCounts = Object.fromEntries(Object.entries(legs).map(([name, ranked]) => [name, ranked.length]));
    const mode = legs.vector ? "hybrid" : "keyword";
    if (!ordered.length) {
      return { mode, query, library, legs: legCounts, reranked: false, hits: [], waiting: [...waiting, ...indexing],
        note: "Nothing in the searched documents matched; this is not evidence the documents are silent on it — read them if the question needs certainty." };
    }
    const keys = ordered.map(([candidate]) => candidate.split("\u0000"));
    const rows = (await this.database.query(`SELECT c.sha256, c.parser_revision, c.text_sha256, c.ordinal, c.start_offset, c.end_offset, c.page, c.context_prefix, c.content
      FROM evimed_kb.chunks c JOIN unnest($2::text[], $3::text[], $4::text[], $5::integer[]) AS k(sha256, parser_revision, text_sha256, ordinal)
        USING (sha256, parser_revision, text_sha256, ordinal) WHERE c.user_id=$1`,
    [userId, keys.map((key) => key[0]), keys.map((key) => key[1]), keys.map((key) => key[2]), keys.map((key) => Number(key[3]))])).rows;
    const byCandidate = new Map(rows.map((row) => [`${keyOf(row)}\u0000${row.ordinal}`, row]));
    const candidates = ordered.map(([candidate, entry]) => ({ candidate, score: entry.score, row: byCandidate.get(candidate) })).filter((item) => item.row);
    let order = candidates.map((_, index) => index);
    let reranked = false;
    if (this.rerank?.configured && candidates.length > 1) {
      order = await this.rerank.order(query, candidates.map((item) => `${item.row.context_prefix}\n${item.row.content}`));
      reranked = !this.rerank.lastError;
    }
    // A document in both the project and the library is cited as the
    // project's: that is the copy the run's workspace already holds.
    /** @type {Map<string, any>} */
    const owners = new Map();
    for (const entry of ready) {
      const existing = owners.get(keyOf(entry));
      if (!existing || (existing.origin !== "project" && entry.origin === "project")) owners.set(keyOf(entry), entry);
    }
    const terms = searchTokens(query);
    const hits = [];
    for (const index of order) {
      if (hits.length >= limit) break;
      const { row, score } = candidates[index];
      const owner = owners.get(keyOf(row));
      if (!owner) continue;
      const window = snippetWindow(row.content, row.start_offset, terms);
      // A chunk never crosses a page (`chunkDocument`), so its page is the
      // page of every offset in it — the same answer `sourcePageForOffset`
      // gives for the snippet's start, without reading the page map again.
      const page = Number.isSafeInteger(row.page) ? row.page : null;
      hits.push({ sourceId: owner.sourceId, title: owner.title, ...(page ? { page } : {}), start: window.start, end: window.end,
        snippet: window.snippet, score: Math.round(score * 10_000) / 10_000, path: owner.path, origin: owner.origin,
        ...(row.context_prefix ? { section: row.context_prefix } : {}) });
    }
    return { mode, query, library, legs: legCounts, reranked, hits, waiting: [...waiting, ...indexing],
      ...(vectorNote ? { vectorSkipped: vectorNote } : {}),
      note: "Each snippet is the exact text at start–end (UTF-16 offsets) of the document's parsed text; quote it verbatim and read the document at `path` for context." };
  }
}
