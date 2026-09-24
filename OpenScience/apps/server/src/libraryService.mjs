import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sourceFileFormat } from "@evimed/domain";
import { SOURCE_PUBLICATION_RECORD_TYPE, withdrawDerivedMemory } from "./derivedMemory.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { HttpError, assertNoSymlinkPath, readJson, safeId, sendJson, writeFileAtomicNoFollow } from "./security.mjs";
import { sourceIndexDocument, sourceParserRevision } from "./sourceService.mjs";

/**
 * The personal library (plan §3.2 #4–5): the documents a researcher keeps
 * across projects — readable, never writable, by every run of theirs, searched
 * by `kb_search` beside the project's own, and publishable into their capsule.
 *
 * Hidden knowledge:
 *
 * - An entry is a document, not a source. A source belongs to one project (its
 *   id hashes the project with the file's SHA-256), so the same PDF in two
 *   projects is two sources and one library entry, keyed by the SHA-256. The
 *   entry answers with the source it was added from (`sourceId`, also the name
 *   of its directory) and every project that holds the document (`projects`).
 * - The library keeps its own copy: `<dataDir>/users/<user>/library/<sourceId>/index.md`,
 *   the same Markdown a project's knowledge base holds, written from the frozen
 *   capture. The runtime mounts the directory read-only at /workspace/library.
 *   The copy is why deleting a project does not empty the library: the entry
 *   turns `detached`, its copy stays readable, and the index documents it is
 *   searched through are held for it (`heldIndexKeys`). What goes with the
 *   project is only what lived in the project — the understanding a capsule
 *   publication reads.
 * - The records are account-level `preferences` product documents
 *   (`recordType: "library-item"`): every change is a revision, a removal can
 *   be restored, and an account export carries them.
 * - Publishing into the capsule is automatic and labelled (plan §3.10), and
 *   keyed by the document rather than by a library entry: it happens to every
 *   document the platform reads, whether or not the researcher chose to keep
 *   that one across projects. What a document says becomes a fact carrying its
 *   verbatim quotes and saying in its own words whose it is — never a
 *   preference, never an instruction. It
 *   all lands in the capsule's `sources` layer, which no method mount and no
 *   share reads (`capsuleMethods.mjs`, `NEVER_SHARED_LAYERS`), so a method the
 *   document describes is a draft a recall can show, not a skill a run loads.
 *   Every entry is a capsule revision the capsule's own undo takes back.
 */

const RECORD_KIND = "preferences";
export const LIBRARY_RECORD_TYPE = "library-item";
/** The other `preferences` record this service writes: what of one document's
 *  understanding is already in the capsule. Keyed by the document so it exists
 *  whether or not the researcher ever put that document in their library.
 *  Defined beside the withdrawal that reads it (`derivedMemory.mjs`): deleting
 *  the document, or its project, withdraws exactly the entries it lists. */
export const PUBLICATION_RECORD_TYPE = SOURCE_PUBLICATION_RECORD_TYPE;

/** @param {string} sourceId */
function publicationId(sourceId) {
  return `source-publication:${sourceId}`;
}
const COPY_FILE = "index.md";
const SOURCE_ID = /^src_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const READY_STATUSES = Object.freeze(["complete", "needs_attention"]);
const PROCESSING_STATUSES = Object.freeze(["queued", "parsing"]);
/** Copies one convergence pass rewrites; the rest wait for the next pass. */
const COPIES_PER_PASS = 10;
/** One page of product records (`ProductDocuments.list` allows 100). */
const PAGE = 100;
/** The most one capsule entry may hold (`CapsuleService.addEntry`). */
const ENTRY_MAX_CHARS = 20_000;
/** The most anchors one entry carries, as the understanding contract allows. */
const ENTRY_MAX_ANCHORS = 8;

/** How a known slot of an understanding is named in the capsule. */
const SLOT_LABELS = Object.freeze({
  doi: "DOI",
  design: "研究设计",
  population: "研究人群",
  interventionExposure: "干预或暴露",
  outcomes: "结局指标",
  effectEstimates: "效应估计",
  limitations: "局限",
  purpose: "目的",
  applicability: "适用范围",
  inputs: "所需输入",
  steps: "步骤",
  checks: "核查",
  pitfalls: "容易出错的地方",
  topic: "主题",
  decisions: "决定",
  actions: "行动项",
  openQuestions: "待解决的问题",
  keyInformation: "关键信息",
});

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The host directory of an account's personal library. The runtime mounts it
 * read-only at /workspace/library — `runtimeManager`'s `personalLibraryDir`
 * names the same directory, and the two must agree.
 * @param {{ dataDir: string }} config @param {string} userId
 */
export function userLibraryDir(config, userId) {
  return path.join(config.dataDir, "users", safeId(String(userId), "user id"), "library");
}

/** @param {unknown} value */
function librarySourceId(value) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) throw new HttpError(400, "library_source_invalid", "Invalid source id.");
  return value;
}

/**
 * What the library shows and searches of a source, read from its record.
 * @param {{ id: string, payload: any }} source
 */
export function describeLibrarySource(source) {
  const payload = source.payload ?? {};
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const analysis = payload.analysis ?? {};
  const name = path.posix.basename(String(payload.paths?.[0] ?? source.id));
  const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim().slice(0, 500) : name;
  const authors = Array.isArray(metadata.authors)
    ? metadata.authors.filter((/** @type {unknown} */ author) => typeof author === "string" && author.trim())
      .map((/** @type {string} */ author) => author.trim().slice(0, 200)).slice(0, 50)
    : [];
  const doi = typeof metadata.doi === "string" && metadata.doi.trim() ? metadata.doi.trim() : null;
  return {
    title, authors, doi,
    doiStatus: doi ? (metadata.doiCheck?.status === "verified" ? "verified" : "unconfirmed") : null,
    kind: typeof payload.docType === "string" ? payload.docType : "other",
    format: sourceFileFormat(name) || null,
    name,
    pageCount: Number.isSafeInteger(analysis.pageCount) && analysis.pageCount > 0 ? analysis.pageCount : null,
    // The capture's own estimate; an older capture has only its unit count.
    tokens: Number.isSafeInteger(analysis.tokenEstimate) ? analysis.tokenEstimate : Math.round((Number(analysis.unitCount) || 0) * 8000 / 2),
    index: typeof analysis.textSha256 === "string" ? { parserRevision: sourceParserRevision(analysis), textSha256: analysis.textSha256 } : null,
  };
}

/** What a copy was written from: the source, its generation, its text and the
 *  metadata its header shows. A change in any of them is a new copy.
 * @param {{ id: string, payload: any }} source */
function copyKey(source) {
  const analysis = source.payload.analysis ?? {};
  return digest(JSON.stringify([source.id, source.payload.generation ?? null, sourceParserRevision(analysis),
    analysis.textSha256 ?? null, source.payload.metadata ?? null])).slice(0, 32);
}

/**
 * The live source an entry reads through: the one it was added from while that
 * one can be read, else a ready copy of the same document in another project,
 * else whatever is left of the one it was added from.
 * @param {any[]} candidates the live sources with the entry's SHA-256, newest first @param {any} record
 */
function resolveSource(candidates, record) {
  if (!candidates?.length) return null;
  const wanted = record.payload.source?.id ?? record.payload.sourceId;
  const own = candidates.find((candidate) => candidate.id === wanted);
  if (own && [...READY_STATUSES, ...PROCESSING_STATUSES].includes(own.payload.status)) return own;
  return candidates.find((candidate) => READY_STATUSES.includes(candidate.payload.status)) ?? own ?? candidates[0];
}

/** @param {any} record @param {any} source @returns {"ready" | "processing" | "failed" | "detached"} */
function entryStatus(record, source) {
  const status = source?.payload.status;
  if (!source || status === "missing") return record.payload.copy ? "detached" : "failed";
  if (READY_STATUSES.includes(status)) return record.payload.copy?.key === copyKey(source) ? "ready" : "processing";
  if (PROCESSING_STATUSES.includes(status)) return "processing";
  return "failed";
}

/** The browser's view of one entry (`GET /api/library`): `projects` are the
 * projects holding the document and `sourceIds` their sources, so a project's
 * source card can tell whether its document is in the library.
 * @param {any} record @param {any[]} candidates the live sources holding the document */
function entryView(record, candidates) {
  const payload = record.payload;
  const source = resolveSource(candidates, record);
  const described = source ? describeLibrarySource(source) : payload.snapshot ?? {};
  return {
    sourceId: payload.sourceId,
    title: String(described.title ?? payload.sourceId),
    ...(described.authors?.length ? { authors: described.authors } : {}),
    ...(described.doi ? { doi: described.doi, doiStatus: described.doiStatus } : {}),
    kind: String(described.kind ?? "other"),
    ...(described.format ? { format: described.format } : {}),
    addedAt: payload.addedAt,
    projects: [...new Set(candidates.map((candidate) => String(candidate.projectId)))].sort(),
    sourceIds: candidates.map((candidate) => String(candidate.id)).sort(),
    ...(described.pageCount ? { pageCount: described.pageCount } : {}),
    status: entryStatus(record, source),
    ...(payload.published ? { published: { at: payload.published.at, capsuleId: payload.published.capsuleId,
      facts: payload.published.facts, methods: payload.published.methods } } : {}),
  };
}

/** @param {string} value */
function bounded(value) {
  if (value.length <= ENTRY_MAX_CHARS) return value;
  let end = ENTRY_MAX_CHARS - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return `${value.slice(0, end)}…`;
}

/** @param {string} label @param {any} method */
function methodDraft(label, method) {
  /** @param {unknown} items @param {boolean} numbered */
  const list = (items, numbered) => (Array.isArray(items) ? items : [])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${String(item).trim()}`);
  const steps = list(method.steps, true);
  const checks = list(method.checks, false);
  const pitfalls = list(method.pitfalls, false);
  return [
    `方法草稿（整理自资料${label}；这是这份资料的做法，不是你的方法，也没有验证过）：${String(method.title).trim()}`,
    ...(typeof method.description === "string" && method.description.trim() ? [method.description.trim()] : []),
    ...(typeof method.whenToUse === "string" && method.whenToUse.trim() ? [`适用情形：${method.whenToUse.trim()}`] : []),
    ...(steps.length ? ["步骤：", ...steps] : []),
    ...(checks.length ? ["核查：", ...checks] : []),
    ...(pitfalls.length ? ["容易出错的地方：", ...pitfalls] : []),
  ].join("\n");
}

/**
 * What one understanding of a document becomes in a capsule: its known slots
 * and its claims as facts (`project_fact`), its methods as labelled drafts
 * (`analysis`), each carrying the verbatim quotes it rests on — and nothing
 * else. Every entry says whose words it holds in its own text, so a recall
 * that shows only the content still reads 「据资料《…》」 and never as the
 * researcher's own view (principle 18).
 *
 * Keyed by content, so publishing one understanding twice adds nothing and a
 * re-read document replaces exactly what changed.
 *
 * @param {{ title: string, sourceId: string, understanding: any }} input
 * @returns {{ key: string, factKind: "project_fact" | "analysis", content: string, provenance: { type: "source", id: string, excerpt: string }[] }[]}
 */
export function libraryCapsuleEntries({ title, sourceId, understanding }) {
  const label = `《${String(title ?? "").trim() || sourceId}》`;
  /** @param {unknown} evidence */
  const anchors = (evidence) => (Array.isArray(evidence) ? evidence : [])
    .filter((anchor) => typeof anchor?.quote === "string" && anchor.quote.trim() && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end))
    .slice(0, ENTRY_MAX_ANCHORS)
    .map((anchor) => ({ type: /** @type {const} */ ("source"), id: `${sourceId}#${anchor.start}-${anchor.end}`, excerpt: anchor.quote.trim().slice(0, 2000) }));
  const seen = new Set();
  /** @type {{ key: string, factKind: "project_fact" | "analysis", content: string, provenance: { type: "source", id: string, excerpt: string }[] }[]} */
  const entries = [];
  /** @param {"project_fact" | "analysis"} factKind @param {string} content @param {unknown} evidence */
  const push = (factKind, content, evidence) => {
    const body = bounded(content);
    const key = digest(`${factKind}\0${body}`).slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, factKind, content: body, provenance: anchors(evidence) });
  };
  for (const [slot, value] of Object.entries(understanding?.slots ?? {})) {
    if (value?.state !== "known" || typeof value.value !== "string" || !value.value.trim()) continue;
    push("project_fact", `据资料${label}，${SLOT_LABELS[/** @type {keyof typeof SLOT_LABELS} */ (slot)] ?? slot}：${value.value.trim()}`, value.evidence);
  }
  for (const claim of Array.isArray(understanding?.claims) ? understanding.claims : []) {
    if (typeof claim?.statement !== "string" || !claim.statement.trim()) continue;
    push("project_fact", `据资料${label}：${claim.statement.trim()}`, claim.evidence);
  }
  for (const method of Array.isArray(understanding?.methods) ? understanding.methods : []) {
    if (typeof method?.title !== "string" || !method.title.trim()) continue;
    push("analysis", methodDraft(label, method), method.evidence);
  }
  return entries;
}

export class LibraryService {
  /** The publication each account has running (`#exclusive`). @type {Map<string, Promise<unknown>>} */
  #publishing = new Map();

  /**
   * @param {{ documents: any, sources: any, capsules?: any, libraryDir: (userId: string) => string,
   *   maxItems?: number, now?: () => Date, report?: (code: string) => void }} options
   */
  constructor({ documents, sources, capsules = null, libraryDir, maxItems = 1000, now = () => new Date(), report = () => {} }) {
    if (!documents?.database || !sources || typeof libraryDir !== "function") {
      throw new TypeError("The personal library needs the product database, the source service and its directory rule.");
    }
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100_000) throw new TypeError("The library size limit must be a positive integer.");
    this.documents = documents;
    this.database = documents.database;
    this.sources = sources;
    this.capsules = capsules;
    this.libraryDir = libraryDir;
    this.maxItems = maxItems;
    this.now = now;
    this.report = report;
    this.lastError = null;
    this.counters = { added: 0, removed: 0, copiesWritten: 0, copiesRemoved: 0, copyFailures: 0, published: 0 };
  }

  /** Every entry of an account, newest first. @param {string} userId */
  async list(userId) {
    const records = await this.#records(userId);
    const live = await this.#liveSources(userId, records.map((record) => record.payload.sha256));
    const items = records.map((record) => entryView(record, live.get(record.payload.sha256) ?? []))
      .sort((left, right) => String(right.addedAt).localeCompare(String(left.addedAt)));
    return { items, maxItems: this.maxItems };
  }

  /**
   * Add a project's source to the library; adding a document the library
   * already holds (from this project or another) answers with that entry.
   * @param {string} userId @param {unknown} sourceId
   * @returns {Promise<{ item: ReturnType<typeof entryView>, created: boolean }>}
   */
  async add(userId, sourceId) {
    const source = await this.documents.get(userId, "source", librarySourceId(sourceId));
    if (!source) throw new HttpError(404, "library_source_invalid", "The source is unavailable.");
    const sha256 = String(source.payload.fingerprint?.sha256 ?? "");
    if (!SHA256.test(sha256)) throw new HttpError(409, "library_source_invalid", "The source has no content digest.");
    const id = `library:${sha256}`;
    let record = await this.documents.get(userId, RECORD_KIND, id, { includeDeleted: true });
    let created = false;
    if (!record || record.deletedAt) {
      if (await this.#count(userId) >= this.maxItems) {
        throw new HttpError(409, "library_full", `The personal library holds at most ${this.maxItems} documents.`);
      }
      const payload = {
        recordType: LIBRARY_RECORD_TYPE, sourceId: source.id, sha256, addedAt: this.now().toISOString(),
        source: { id: source.id, projectId: source.projectId }, snapshot: describeLibrarySource(source), copy: null,
        // A document removed and added back keeps what it already published,
        // so publishing it again adds nothing twice.
        published: record?.payload.published ?? null,
      };
      try {
        if (record) {
          const restored = await this.documents.restore(userId, RECORD_KIND, id, record.revision);
          record = await this.documents.put(userId, RECORD_KIND, id, payload, { expectedRevision: restored.revision });
        } else {
          record = await this.documents.put(userId, RECORD_KIND, id, payload, { expectedRevision: 0 });
        }
        created = true;
        this.counters.added += 1;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
        // A concurrent request added it first; its entry is this one.
        record = await this.documents.get(userId, RECORD_KIND, id);
        if (!record) throw error;
      }
    }
    // Resolved among every live copy, so adding a document again from another
    // project leaves the entry reading the copy it already reads.
    const candidates = (await this.#liveSources(userId, [sha256])).get(sha256) ?? [source];
    record = await this.#refresh(userId, record, candidates);
    return { item: entryView(record, candidates), created };
  }

  /** Take a document out of the library. The record is kept as a restorable
   *  revision; the copy goes at once, so no later run reads it.
   * @param {string} userId @param {unknown} sourceId */
  async remove(userId, sourceId) {
    const record = await this.#requireEntry(userId, sourceId);
    await this.documents.remove(userId, RECORD_KIND, record.id, record.revision);
    this.counters.removed += 1;
    // A copy that could not be deleted now goes with the next convergence pass.
    await this.#removeCopy(userId, record.payload.sourceId).catch((error) => this.#failed(error));
    return { sourceId: record.payload.sourceId, removed: true };
  }

  /**
   * The library's documents as the knowledge-base search scopes them: the
   * copy's own description and index key, and the path a run reads it at.
   * @param {string} userId
   */
  async searchScope(userId) {
    return (await this.#records(userId)).map((record) => {
      const payload = record.payload;
      const snapshot = payload.snapshot ?? {};
      return {
        sourceId: payload.sourceId, title: String(snapshot.title ?? payload.sourceId),
        status: payload.copy ? "ready" : "processing",
        path: `library/${payload.sourceId}/${COPY_FILE}`,
        searchable: Boolean(payload.copy && snapshot.index),
        sha256: payload.sha256, parserRevision: snapshot.index?.parserRevision ?? null, textSha256: snapshot.index?.textSha256 ?? null,
        tokens: Number.isSafeInteger(snapshot.tokens) ? snapshot.tokens : 0, pages: snapshot.pageCount ?? null,
      };
    });
  }

  /**
   * The index documents the library's copies are searched through, for one
   * account or all of them. The index keeps these even when no project names
   * the document any more.
   * @param {string | null} userId
   * @returns {Promise<{ userId: string, sha256: string, parserRevision: string, textSha256: string }[]>}
   */
  async heldIndexKeys(userId) {
    await migrateProductStore(this.database);
    const rows = (await this.database.query(`SELECT user_id, payload FROM evimed_product.documents
      WHERE kind='preferences' AND deleted_at IS NULL AND payload @> $2::jsonb AND ($1::text IS NULL OR user_id=$1)
        AND jsonb_typeof(payload->'copy')='object'`, [userId, JSON.stringify({ recordType: LIBRARY_RECORD_TYPE })])).rows;
    return rows.filter((row) => SHA256.test(String(row.payload.sha256)) && typeof row.payload.snapshot?.index?.textSha256 === "string")
      .map((row) => ({ userId: row.user_id, sha256: row.payload.sha256,
        parserRevision: String(row.payload.snapshot.index.parserRevision), textSha256: row.payload.snapshot.index.textSha256 }));
  }

  /**
   * One convergence pass: every entry's copy follows its source (a re-parse,
   * corrected metadata, a project copy that replaced a deleted one), a bounded
   * number of copies per pass, and a copy no entry names any more is removed.
   * @param {{ userId?: string | null }} [options]
   */
  async syncCopies({ userId = null } = {}) {
    await migrateProductStore(this.database);
    const rows = (await this.database.query(`SELECT user_id, id, revision, payload FROM evimed_product.documents
      WHERE kind='preferences' AND deleted_at IS NULL AND payload @> $2::jsonb AND ($1::text IS NULL OR user_id=$1)
      ORDER BY user_id, created_at, id`, [userId, JSON.stringify({ recordType: LIBRARY_RECORD_TYPE })])).rows;
    /** @type {Map<string, any[]>} */
    const byUser = new Map();
    for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), { id: row.id, revision: row.revision, payload: row.payload }]);
    const totals = { written: 0, removed: 0, failed: 0 };
    let budget = COPIES_PER_PASS;
    for (const [owner, records] of byUser) {
      const present = await this.#presentCopies(owner);
      const live = await this.#liveSources(owner, records.map((record) => record.payload.sha256));
      for (const record of records) {
        const candidates = live.get(record.payload.sha256) ?? [];
        const source = resolveSource(candidates, record);
        if (!source || !READY_STATUSES.includes(source.payload.status)) continue;
        if (record.payload.copy?.key === copyKey(source) && present.has(record.payload.sourceId)) continue;
        if (budget <= 0) break;
        budget -= 1;
        const failures = this.counters.copyFailures;
        await this.#refresh(owner, record, candidates, present);
        if (this.counters.copyFailures > failures) totals.failed += 1;
        else totals.written += 1;
      }
      const named = new Set(records.map((record) => record.payload.sourceId));
      for (const name of present) {
        if (named.has(name) || !SOURCE_ID.test(name)) continue;
        await this.#removeCopy(owner, name).then(() => { totals.removed += 1; }, (error) => this.#failed(error));
      }
    }
    return totals;
  }

  /**
   * Bring the copy of the document a just-published source holds up to date,
   * if the library has it. Called when a source finishes; never throws.
   * @param {string} userId @param {string} sourceId
   */
  async refreshSource(userId, sourceId) {
    try {
      const source = await this.documents.get(userId, "source", librarySourceId(sourceId));
      const sha256 = String(source?.payload.fingerprint?.sha256 ?? "");
      if (!SHA256.test(sha256)) return null;
      const record = await this.documents.get(userId, RECORD_KIND, `library:${sha256}`);
      if (!record) return null;
      return await this.#refresh(userId, record, (await this.#liveSources(userId, [sha256])).get(sha256) ?? []);
    } catch (error) {
      this.#failed(error);
      return null;
    }
  }

  /**
   * A document's current understanding, in the researcher's memory capsule:
   * facts with their quotes, methods as labelled drafts, all in the `sources`
   * layer and in effect at once.
   *
   * Called by the source worker when an understanding is published, never by a
   * button. There was a button — 「放进胶囊」, once per document, beside
   * 「加入资料库」 — and it asked the researcher to do by hand the one thing the
   * platform had just finished doing: the understanding was already computed,
   * already quote-anchored, already theirs. Both were deleted on 2026-09-20
   * (owner ruling: everything takes effect automatically, labelled and
   * reversible, with no per-item approval). The label is 「来自资料」, which the
   * capsule row already derives from the source provenance each entry carries,
   * and every entry can be edited, stopped or undone like any other.
   *
   * Publishing again adds only what changed; what a re-read no longer says is
   * retired — kept as "was said once", never deleted — unless the researcher
   * has already corrected or retired it themselves. Idempotent by that
   * bookkeeping, so the worker may call it more than once for one generation.
   *
   * @param {string} userId @param {unknown} sourceId
   */
  async publishSourceUnderstanding(userId, sourceId) {
    if (!this.capsules) throw new HttpError(503, "library_unavailable", "The memory capsule is unavailable on this deployment.");
    const id = String(sourceId ?? "");
    if (!/^src_[a-f0-9]{32}$/.test(id)) throw new HttpError(400, "library_payload_invalid", "That is not a document id.");
    return this.#exclusive(userId, async () => {
      const source = await this.sources.get(userId, id).catch(() => null);
      if (!source) throw new HttpError(409, "library_source_removed", "That document is gone.");
      const understanding = (await this.sources.getUnderstanding(userId, id)).current;
      if (!understanding) throw new HttpError(409, "library_understanding_missing", "The document has no understanding to publish yet.");
      const entries = libraryCapsuleEntries({ title: describeLibrarySource(source).title, sourceId: id, understanding });
      const capsule = await this.#targetCapsule(userId);
      const ledgerId = publicationId(id);
      const ledger = await this.documents.get(userId, RECORD_KIND, ledgerId);
      /** @type {Record<string, string>} */
      const previous = ledger?.payload.capsuleId === capsule.id ? ledger.payload.entries ?? {} : {};
      /** @type {Record<string, string>} */
      const entryIds = {};
      let added = 0;
      let kept = 0;
      let retired = 0;
      for (const entry of entries) {
        if (previous[entry.key]) {
          // Published before: kept as it is, even if the researcher has since
          // retired or deleted it — publishing again never overrules them.
          entryIds[entry.key] = previous[entry.key];
          kept += 1;
          continue;
        }
        let written = await this.capsules.addEntry(userId, capsule.id, { factKind: entry.factKind, layer: "sources",
          content: entry.content, origin: "inferred", provenance: entry.provenance });
        if (written.payload.status !== "approved") {
          written = await this.capsules.updateEntry(userId, capsule.id, written.id, { status: "approved", expectedRevision: written.revision });
        }
        entryIds[entry.key] = written.id;
        added += 1;
      }
      for (const [key, entryId] of Object.entries(previous)) {
        if (entryIds[key]) continue;
        const existing = await this.documents.get(userId, "fact", entryId);
        if (!existing || existing.payload.capsuleId !== capsule.id || existing.payload.status !== "approved" || existing.payload.correctedAt) continue;
        try {
          await this.capsules.updateEntry(userId, capsule.id, entryId, { status: "retired", expectedRevision: existing.revision });
          retired += 1;
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
        }
      }
      const facts = entries.filter((entry) => entry.factKind === "project_fact").length;
      const methods = entries.length - facts;
      // The bookkeeping is keyed by the document, not by a library entry: the
      // personal library is a place a researcher chooses to put something, and
      // this happens to every document the platform reads.
      const latest = await this.documents.get(userId, RECORD_KIND, ledgerId);
      await this.documents.put(userId, RECORD_KIND, ledgerId, {
        recordType: PUBLICATION_RECORD_TYPE, sourceId: id, capsuleId: capsule.id,
        generation: understanding.generation, at: this.now().toISOString(), facts, methods, entries: entryIds,
      }, { expectedRevision: latest?.revision ?? 0 });
      this.counters.published += 1;
      // The document may have been deleted while this ran — a researcher who
      // uploads a file and removes it at once. Its deletion withdrew what it
      // could see then; what this publication wrote afterwards, the ledger
      // just written included, goes now rather than on the orphan sweep's
      // next cycle. Only a definite "not there" counts: a failed read is not
      // a deletion.
      const gone = await this.sources.get(userId, id).then(() => false, (/** @type {any} */ error) => error?.code === "source_not_found");
      if (gone && typeof this.database.transaction === "function") {
        await this.database.transaction((/** @type {any} */ client) => withdrawDerivedMemory(client, userId, { sourceIds: [id], reason: "source_deleted" }))
          .catch((/** @type {any} */ error) => this.#failed(error));
      }
      return { sourceId: id, capsuleId: capsule.id, capsuleTitle: String(capsule.payload.title ?? ""),
        generation: understanding.generation, facts, methods, added, kept, retired };
    });
  }

  /**
   * The capsule a publication writes into: the account's one capsule
   * (`CapsuleService.ownCapsule` — one capsule per person, 「我的记忆胶囊」),
   * made and made primary when there is none, with every reference capsule
   * left active beside it. A primary capsule that someone else shared is never
   * written into, and never quietly replaced by a publication either.
   * @param {string} userId
   */
  async #targetCapsule(userId) {
    const active = await this.capsules.active(userId, null);
    for (const item of active.items) {
      if (item.mode !== "own") continue;
      const capsule = await this.capsules.get(userId, item.capsuleId).catch(() => null);
      if (capsule?.payload.imported) {
        throw new HttpError(409, "library_capsule_unavailable", "The account's primary capsule is someone else's; documents are published only into your own.");
      }
    }
    const capsule = await this.capsules.ownCapsule(userId, { create: true });
    if (!capsule) throw new HttpError(503, "library_unavailable", "The memory capsule is unavailable on this deployment.");
    return capsule;
  }

  /**
   * One publication per account at a time: two at once would publish one
   * understanding twice. A second one while the first runs is refused at once
   * (409 `library_publish_busy`), never queued.
   *
   * The guard holds no database connection. It was a PostgreSQL advisory lock
   * taken inside a transaction that stayed open while the publication ran,
   * and the publication's own reads and writes take pooled connections of
   * their own: as many concurrent publishes as the pool has connections (ten),
   * of any well-formed id, left every connection either waiting on the lock or
   * holding it while waiting for a second one, and every other tenant's
   * queries failed with "timeout exceeded when trying to connect" (security
   * review 2026-09-20). It is this process's map because the API is one
   * process (one `open-science-web` container); a second replica would need a
   * lease row, not a lock held on a pooled connection.
   * @template T @param {string} userId @param {() => Promise<T>} work @returns {Promise<T>} */
  async #exclusive(userId, work) {
    if (this.#publishing.has(userId)) {
      throw new HttpError(409, "library_publish_busy", "A publication from this library is already running; try again when it finishes.");
    }
    const running = work();
    this.#publishing.set(userId, running);
    try {
      return await running;
    } finally {
      this.#publishing.delete(userId);
    }
  }

  /** @param {string} userId @param {unknown} sourceId */
  async #requireEntry(userId, sourceId) {
    const key = librarySourceId(sourceId);
    const page = await this.documents.list(userId, RECORD_KIND, { limit: 1, filter: { recordType: LIBRARY_RECORD_TYPE, sourceId: key } });
    if (page.items[0]) return page.items[0];
    // Named by another project's copy of a document the library holds.
    const source = await this.documents.get(userId, "source", key);
    const sha256 = String(source?.payload.fingerprint?.sha256 ?? "");
    const record = SHA256.test(sha256) ? await this.documents.get(userId, RECORD_KIND, `library:${sha256}`) : null;
    if (record) return record;
    throw new HttpError(404, "library_item_not_found", "This document is not in the personal library.");
  }

  /** @param {string} userId */
  async #records(userId) {
    /** @type {any[]} */
    const records = [];
    let cursor = null;
    do {
      const page = await this.documents.list(userId, RECORD_KIND, { limit: PAGE, cursor, filter: { recordType: LIBRARY_RECORD_TYPE } });
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && records.length < this.maxItems);
    return records.slice(0, this.maxItems);
  }

  /** @param {string} userId */
  async #count(userId) {
    const result = await this.database.query(`SELECT count(*)::integer AS count FROM evimed_product.documents
      WHERE user_id=$1 AND kind='preferences' AND deleted_at IS NULL AND payload @> $2::jsonb`,
    [userId, JSON.stringify({ recordType: LIBRARY_RECORD_TYPE })]);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** The live sources holding each document, newest first.
   * @param {string} userId @param {unknown[]} sha256s @returns {Promise<Map<string, any[]>>} */
  async #liveSources(userId, sha256s) {
    /** @type {Map<string, any[]>} */
    const bySha = new Map();
    const wanted = [...new Set(sha256s.map(String).filter((value) => SHA256.test(value)))];
    if (!wanted.length) return bySha;
    const rows = (await this.database.query(`SELECT id, project_id, payload, revision FROM evimed_product.documents
      WHERE user_id=$1 AND kind='source' AND deleted_at IS NULL AND payload->'fingerprint'->>'sha256'=ANY($2::text[])
      ORDER BY updated_at DESC, id`, [userId, wanted])).rows;
    for (const row of rows) {
      const sha256 = row.payload.fingerprint.sha256;
      bySha.set(sha256, [...(bySha.get(sha256) ?? []), { id: row.id, projectId: row.project_id, payload: row.payload, revision: row.revision }]);
    }
    return bySha;
  }

  /**
   * Write an entry's copy from the source it resolves to, when that source is
   * readable and the copy is not already its current one. A failure leaves the
   * entry and its previous copy as they were for the next pass.
   * @param {string} userId @param {any} record @param {any[]} candidates @param {Set<string> | null} [present]
   */
  async #refresh(userId, record, candidates, present = null) {
    const source = resolveSource(candidates, record);
    if (!source || !READY_STATUSES.includes(source.payload.status)) return record;
    const key = copyKey(source);
    const exists = present ? present.has(record.payload.sourceId) : await this.#copyExists(userId, record.payload.sourceId);
    if (record.payload.copy?.key === key && exists) return record;
    try {
      const capture = await this.sources.loadCapture(userId, source);
      if (!capture) return record;
      const document = sourceIndexDocument({ original: source.payload.paths?.[0] ?? source.id, sha256: record.payload.sha256,
        extractor: capture.extractor ?? { name: "unknown", version: "0", parser: "unknown" },
        text: capture.input.text, pageMap: capture.pageMap, metadata: capture.metadata });
      await this.#writeCopy(userId, record.payload.sourceId, document);
      this.counters.copiesWritten += 1;
      return await this.documents.put(userId, RECORD_KIND, record.id, { ...record.payload,
        source: { id: source.id, projectId: source.projectId }, snapshot: describeLibrarySource(source),
        copy: { key, at: this.now().toISOString() } }, { expectedRevision: record.revision });
    } catch (error) {
      this.counters.copyFailures += 1;
      this.#failed(error);
      return record;
    }
  }

  /** @param {string} userId */
  async #root(userId) {
    const dir = this.libraryDir(userId);
    // `<dataDir>/users`: nothing between it and the library may be a link.
    await assertNoSymlinkPath(path.dirname(path.dirname(dir)), dir, { allowMissingTail: true });
    return dir;
  }

  /** @param {string} userId @param {string} name @param {string} document */
  async #writeCopy(userId, name, document) {
    const dir = await this.#root(userId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomicNoFollow(dir, path.join(dir, librarySourceId(name), COPY_FILE), document, { encoding: "utf8", mode: 0o600 });
  }

  /** @param {string} userId @param {string} name */
  async #copyExists(userId, name) {
    const dir = await this.#root(userId);
    return fs.lstat(path.join(dir, librarySourceId(name), COPY_FILE)).then((stat) => stat.isFile(), () => false);
  }

  /** @param {string} userId @param {string} name */
  async #removeCopy(userId, name) {
    const dir = await this.#root(userId);
    const target = path.join(dir, librarySourceId(name));
    await assertNoSymlinkPath(dir, target, { allowMissingTail: true });
    await fs.rm(target, { recursive: true, force: true });
    this.counters.copiesRemoved += 1;
  }

  /** The copy directories on disk for an account. @param {string} userId */
  async #presentCopies(userId) {
    const dir = await this.#root(userId);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  }

  /** @param {unknown} error */
  #failed(error) {
    this.lastError = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "library_copy_failed";
    this.report(this.lastError);
  }
}

/** @param {any} req @param {number} limit */
async function addBody(req, limit) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "sourceId")) {
    throw new HttpError(400, "library_payload_invalid", "Send { sourceId } and nothing else.");
  }
  return value;
}

/**
 * The personal library's routes (account-authenticated):
 *
 *   GET    /api/library                                  → { items: [...], maxItems }
 *   POST   /api/library                { sourceId }      → 201 the new entry, 200 the entry it already was
 *   DELETE /api/library/:sourceId                        → { sourceId, removed: true }
 *
 * The per-document 「放进胶囊」 route is gone (2026-09-20): a document's
 * understanding reaches the capsule when it is understood, not when somebody
 * presses a button per file. `publishSourceUnderstanding` is what the source
 * worker calls instead.
 *
 * @param {{ store: any, service: LibraryService | null, maxJsonBytes: number }} dependencies
 */
export function createLibraryRoutes({ store, service, maxJsonBytes }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/library" && !url.pathname.startsWith("/api/library/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "library_unavailable", "The personal library is unavailable on this deployment.");
    const method = req.method ?? "GET";
    if (url.pathname === "/api/library" && method === "GET") {
      sendJson(res, 200, { data: await service.list(user.id) });
      return true;
    }
    if (url.pathname === "/api/library" && method === "POST") {
      const { item, created } = await service.add(user.id, (await addBody(req, maxJsonBytes)).sourceId);
      sendJson(res, created ? 201 : 200, { data: item });
      return true;
    }
    const match = /^\/api\/library\/(src_[a-f0-9]{32})$/.exec(url.pathname);
    if (match && method === "DELETE") {
      sendJson(res, 200, { data: await service.remove(user.id, match[1]) });
      return true;
    }
    throw new HttpError(404, "not_found", "Library route not found.");
  };
}

/**
 * The library as the server composes it: the service (null without a product
 * database), its routes, and the index it joins.
 * @param {{ config: any, store: any, documents: any, sources: any, capsules?: any, kbIndex?: any, report?: (code: string) => void }} dependencies
 */
export function createLibrary({ config, store, documents, sources, capsules = null, kbIndex = null, report = () => {} }) {
  const service = documents?.database && sources ? new LibraryService({ documents, sources, capsules,
    libraryDir: (userId) => userLibraryDir(config, userId), maxItems: config.libraryMaxItems, report }) : null;
  kbIndex?.useLibrary(service);
  return { service, routes: createLibraryRoutes({ store, service, maxJsonBytes: config.maxJsonBytes }) };
}
