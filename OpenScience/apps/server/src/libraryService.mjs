import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sourceFileFormat, sourceOriginOf } from "@evimed/domain";
import { DOCUMENT_MEMORY_LAYER, SOURCE_PUBLICATION_RECORD_TYPE, withdrawDerivedMemory } from "./derivedMemory.mjs";
import { LIBRARY_PROJECT_ID } from "./internalProjects.mjs";
import { LIBRARY_ALL_PROJECTS, effectiveProjects, libraryRecordCovers, libraryRecordProjects, libraryViewsRoot, ordinaryHolderProjects, parseLibraryProjects } from "./libraryScope.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { HttpError, assertNoSymlinkPath, readJson, safeId, sendJson, writeFileAtomicNoFollow } from "./security.mjs";
import { sourceIndexDocument, sourceParserRevision, sourceReadable } from "./sourceService.mjs";

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
 *   capture. It is the master: what a runtime mounts read-only at /workspace/library
 *   is its project's view of it (below). The copy is why an entry whose source is
 *   gone stays readable: it turns `detached`, and the index documents it is
 *   searched through are held for it (`heldIndexKeys`). Since 2026-10-28 that
 *   no longer follows from deleting documents — an entry goes with the last
 *   document that holds its bytes, a deleted project's or a deleted source's
 *   (`SourceService.remove`, `libraryProjectDeleted`) — and is what an entry written
 *   earlier, or a source that went another way, can still be. What goes with a
 *   project is what lived in the project — the understanding a capsule
 *   publication reads.
 * - The records are account-level `preferences` product documents
 *   (`recordType: "library-item"`): every change is a revision, a removal can
 *   be restored, and an account export carries them.
 * - Publishing into the capsule is automatic and labelled (plan §3.10), and
 *   keyed by the document rather than by a library entry: it happens to every
 *   document the platform reads, whether or not the researcher chose to keep
 *   that one across projects. What a document says — its summary and its key
 *   claims — becomes a fact carrying its verbatim quotes and saying in its
 *   own words whose it is — never a preference, never an instruction. It
 *   all lands in the capsule's `sources` layer, which no method mount and no
 *   share reads (`capsuleMethods.mjs`, `NEVER_SHARED_LAYERS`), stamped with
 *   the document's project: it is recalled there and nowhere else, and the
 *   capsule page does not list it (2026-09-24).
 *   Every entry is a capsule revision the capsule's own undo takes back.
 * - Which projects an entry applies to is the record's `projects` (2026-10-28): `"all"` — also what a record written before
 *   the field existed means — or a list of ordinary projects of the account (`libraryScope.mjs` holds the rule and the
 *   one check every scope asks). The account's own `library/` directory is the master the copies are made from and is
 *   never mounted: each project that has a runtime gets `library-views/<projectId>/<sourceId>/index.md`, real copies of
 *   exactly the entries that apply to it, and that directory is what /workspace/library is. A change to a record,
 *   a deleted record, a replaced document and a deleted project all bring the views to the new truth before the call answers
 *   (a narrowing removes first and writes after), and the convergence pass repairs whatever a failure left behind.
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
const PROCESSING_STATUSES = Object.freeze(["queued", "parsing"]);
/** Copies one convergence pass rewrites; the rest wait for the next pass. */
const COPIES_PER_PASS = 10;
/** One page of product records (`ProductDocuments.list` allows 100). */
const PAGE = 100;
/** The most one capsule entry may hold (`CapsuleService.addEntry`). */
const ENTRY_MAX_CHARS = 20_000;
/** The most anchors one entry carries, as the understanding contract allows. */
const ENTRY_MAX_ANCHORS = 8;
/** The most entries one document puts in the capsule: its summary and its
 *  first eleven claims. */
export const DOCUMENT_MEMORY_MAX_ENTRIES = 12;
/**
 * Which rule a publication was written under, kept on its ledger. 2 (from
 * 2026-09-24): the summary and the quote-anchored claims, capped, each
 * stamped with its document and project. 1 (unmarked): every template field
 * and claim plus the method drafts, unstamped.
 * `scripts/ops/republish-source-memory.mjs` brings older ones up to it.
 */
export const PUBLICATION_RULE = 2;

/** @param {"all" | string[]} left @param {"all" | string[]} right */
function sameProjects(left, right) {
  if (left === LIBRARY_ALL_PROJECTS || right === LIBRARY_ALL_PROJECTS) return left === right;
  return left.length === right.length && left.every((id) => right.includes(id));
}

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The host directory of an account's personal library: the master the projects' directories are made from. It is never
 * mounted into a runtime — what a runtime mounts at /workspace/library is its own project's directory
 * (`projectLibraryViewDir`, `libraryScope.mjs`).
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
  if (own && (sourceReadable(own.payload) || PROCESSING_STATUSES.includes(own.payload.status))) return own;
  return candidates.find((candidate) => sourceReadable(candidate.payload)) ?? own ?? candidates[0];
}

/** @param {any} record @param {any} source @returns {"ready" | "processing" | "failed" | "detached"} */
function entryStatus(record, source) {
  const status = source?.payload.status;
  if (!source || status === "missing") return record.payload.copy ? "detached" : "failed";
  if (sourceReadable(source.payload)) return record.payload.copy?.key === copyKey(source) ? "ready" : "processing";
  if (PROCESSING_STATUSES.includes(status)) return "processing";
  return "failed";
}

/** The browser's view of one entry (`GET /api/library`): `projects` are the
 * projects holding the document and `sourceIds` their sources, so a project's
 * source card can tell whether its document is in the library. `libraryProjects`
 * is what the record says (`"all"` or a list of project ids) and `appliesTo` what
 * that makes of the document: `"all"`, or every project it is read in — the ones
 * holding it and the ones the record names. `revision` is what a change is
 * sent back against (`expectedRevision`).
 * @param {any} record @param {any[]} candidates the live sources holding the document */
function entryView(record, candidates) {
  const payload = record.payload;
  const source = resolveSource(candidates, record);
  const described = source ? describeLibrarySource(source) : payload.snapshot ?? {};
  return {
    sourceId: payload.sourceId,
    revision: record.revision,
    libraryProjects: libraryRecordProjects(payload),
    appliesTo: effectiveProjects({ holders: ordinaryHolderProjects(candidates.map((candidate) => candidate.projectId)), record: payload }),
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

/**
 * What one understanding of a document becomes in a capsule: its summary, and
 * its key claims each with the verbatim quotes it rests on — at most
 * `DOCUMENT_MEMORY_MAX_ENTRIES`, all `project_fact`, and nothing else. Every
 * entry says whose words it holds in its own text, so a recall that shows
 * only the content still reads 「据资料《…》」 and never as the researcher's own
 * view (principle 18).
 *
 * What it no longer carries, and why (2026-09-24): the template fields — 研究
 * 设计, 研究人群, 效应估计, 局限 … — became one entry each, and a document
 * that was not a paper filled them with sentences about their own absence
 * (「据资料《8.11医学测评.pdf》，研究设计：本文档没有研究设计——它不是研究
 * 报告…」, thirty entries from one product-test record). A template field is a
 * column of the understanding, shown with the document; a memory is a fact
 * worth recalling in a conversation. Method drafts went with them: they were
 * listed under 「关于你」, as if the document's procedure were the
 * researcher's own.
 *
 * Keyed by content, so publishing one understanding twice adds nothing and a
 * re-read document replaces exactly what changed.
 *
 * @param {{ title: string, sourceId: string, understanding: any }} input
 * @returns {{ key: string, factKind: "project_fact", content: string, provenance: { type: "source", id: string, excerpt: string }[] }[]}
 */
export function libraryCapsuleEntries({ title, sourceId, understanding }) {
  const label = `《${String(title ?? "").trim() || sourceId}》`;
  /** @param {unknown} evidence */
  const anchors = (evidence) => (Array.isArray(evidence) ? evidence : [])
    .filter((anchor) => typeof anchor?.quote === "string" && anchor.quote.trim() && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end))
    .slice(0, ENTRY_MAX_ANCHORS)
    .map((anchor) => ({ type: /** @type {const} */ ("source"), id: `${sourceId}#${anchor.start}-${anchor.end}`, excerpt: anchor.quote.trim().slice(0, 2000) }));
  const seen = new Set();
  /** @type {{ key: string, factKind: "project_fact", content: string, provenance: { type: "source", id: string, excerpt: string }[] }[]} */
  const entries = [];
  /** @param {string} content @param {{ type: "source", id: string, excerpt: string }[]} provenance */
  const push = (content, provenance) => {
    if (entries.length >= DOCUMENT_MEMORY_MAX_ENTRIES) return;
    const body = bounded(content);
    const key = digest(`project_fact\0${body}`).slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, factKind: "project_fact", content: body, provenance });
  };
  const summary = typeof understanding?.summary === "string" ? understanding.summary.trim() : "";
  if (summary) push(`资料${label}的摘要：${summary}`, []);
  for (const claim of Array.isArray(understanding?.claims) ? understanding.claims : []) {
    if (typeof claim?.statement !== "string" || !claim.statement.trim()) continue;
    // A key claim is a quote-anchored one; the contract already demands an
    // anchor for every claim, and one that lost its anchors is not written.
    const provenance = anchors(claim.evidence);
    if (provenance.length === 0) continue;
    push(`据资料${label}：${claim.statement.trim()}`, provenance);
  }
  return entries;
}

export class LibraryService {
  /** The publication each account has running (`#exclusive`). @type {Map<string, Promise<unknown>>} */
  #publishing = new Map();

  /**
   * @param {{ documents: any, sources: any, capsules?: any, libraryDir: (userId: string) => string,
   *   viewsDir?: ((userId: string) => string) | null, projectGuard?: ((userId: string, projectId: string) => Promise<unknown>) | null,
   *   maxItems?: number, now?: () => Date, report?: (code: string) => void }} options
   *   `viewsDir`: where the account's per-project views are kept (`libraryViewsRoot`); without it no view is written and none
   *   is removed (a deployment that never mounts one). `projectGuard`: throws unless the project may be named in a record's list
   *   (`assertOrdinaryProject`); without it a list is refused rather than taken on trust.
   */
  constructor({ documents, sources, capsules = null, libraryDir, viewsDir = null, projectGuard = null, maxItems = 1000, now = () => new Date(), report = () => {} }) {
    if (!documents?.database || !sources || typeof libraryDir !== "function") {
      throw new TypeError("The personal library needs the product database, the source service and its directory rule.");
    }
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100_000) throw new TypeError("The library size limit must be a positive integer.");
    this.documents = documents;
    this.database = documents.database;
    this.sources = sources;
    this.capsules = capsules;
    this.libraryDir = libraryDir;
    this.viewsDir = viewsDir;
    this.projectGuard = projectGuard;
    this.maxItems = maxItems;
    this.now = now;
    this.report = report;
    this.lastError = null;
    this.counters = { added: 0, removed: 0, copiesWritten: 0, copiesRemoved: 0, copyFailures: 0, published: 0, viewsWritten: 0, viewsRemoved: 0, viewFailures: 0 };
  }

  /** Every entry of an account, newest first. @param {string} userId */
  async list(userId) {
    const records = await this.#records(userId);
    const live = await this.#liveSources(userId, records.map((record) => record.payload.sha256));
    const items = records.map((record) => entryView(record, live.get(record.payload.sha256) ?? []))
      .sort((left, right) => String(right.addedAt).localeCompare(String(left.addedAt)));
    return { items, maxItems: this.maxItems };
  }

  /** Read only a current authorized library copy; leftover files do not grant membership. With a `projectId` the copy is
   *  read as that project would: a document the record does not put in it answers null, as one that is not there.
   * @param {string} userId @param {string} sourceId @param {{ projectId?: string | null }} [options] @returns {Promise<string | null>} */
  async readCopyText(userId, sourceId, { projectId = null } = {}) {
    const work = async () => {
      let record;
      try { record = await this.#requireEntry(userId, sourceId); }
      catch (error) { if (/** @type {any} */ (error)?.status === 404) return null; throw error; }
      if (projectId !== null && !libraryRecordCovers(record.payload, projectId)) return null;
      if (!record.payload.copy) return null;
      const dir = await this.#root(userId);
      const file = path.join(dir, librarySourceId(record.payload.sourceId), COPY_FILE);
      try {
        await assertNoSymlinkPath(dir, file);
        return await fs.readFile(file, "utf8");
      } catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") return null; throw error; }
    };
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /**
   * Add a project's source to the library; adding a document the library
   * already holds (from this project or another) answers with that entry.
   * `projects` says where it applies (default `"all"` for a new entry); named for an
   * entry that already exists, it is a change (`setProjects`).
   * @param {string} userId @param {unknown} sourceId @param {{ projects?: "all" | string[] }} [options]
   * @returns {Promise<{ item: ReturnType<typeof entryView>, created: boolean }>}
   */
  async add(userId, sourceId, { projects } = {}) {
    if (projects !== undefined) await this.#guardProjects(userId, projects);
    const work = () => this.addCurrent(userId, sourceId, { projects });
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /**
   * Say where a document applies, creating its entry when it has none (`PUT /api/library/:sourceId`).
   * @param {string} userId @param {unknown} sourceId @param {unknown} projects `"all"` or a list of project ids
   * @param {{ expectedRevision?: unknown }} [options] the revision the caller read; a changed entry refuses with 409
   * @returns {Promise<{ item: ReturnType<typeof entryView>, created: boolean }>}
   */
  async setProjects(userId, sourceId, projects, { expectedRevision } = {}) {
    const parsed = parseLibraryProjects(projects);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || /** @type {number} */ (expectedRevision) < 1)) {
      throw new HttpError(400, "library_payload_invalid", "expectedRevision is the revision of the entry you read.");
    }
    await this.#guardProjects(userId, parsed);
    const work = () => this.addCurrent(userId, sourceId, { projects: parsed, expectedRevision: /** @type {number | undefined} */ (expectedRevision) });
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /** A list names only projects a document may be sent to; "all" names none. @param {string} userId @param {unknown} projects */
  async #guardProjects(userId, projects) {
    const parsed = parseLibraryProjects(projects);
    if (parsed === LIBRARY_ALL_PROJECTS || !parsed.length) return;
    if (typeof this.projectGuard !== "function") throw new HttpError(503, "library_unavailable", "The personal library cannot check projects on this deployment.");
    for (const id of parsed) await this.projectGuard(userId, id);
  }

  /** @param {string} userId @param {unknown} sourceId
   * @param {{personal?:boolean, projects?: "all" | string[], expectedRevision?: number}} [options] */
  async addCurrent(userId, sourceId, { personal = false, projects, expectedRevision } = {}) {
    const source = await this.documents.get(userId, "source", librarySourceId(sourceId));
    if (!source) throw new HttpError(404, "library_source_invalid", "The source is unavailable.");
    // A knowledge page quotes the documents of its own project; in another project those documents are not there to check it against.
    if (sourceOriginOf({ connectorType: source.payload.connector?.type, path: source.payload.paths?.[0] }) === "wiki") {
      throw new HttpError(409, "library_source_invalid", "A knowledge page belongs to its project; share the documents it quotes instead.");
    }
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
        recordType: LIBRARY_RECORD_TYPE, projects: projects ?? LIBRARY_ALL_PROJECTS,
        explicitRetention: !personal, personalSourceIds: personal ? [source.id] : [], sourceId: source.id, sha256, addedAt: this.now().toISOString(),
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
    if (!created && expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new HttpError(409, "product_revision_conflict", "The library entry changed; reload before changing it.");
    }
    if (!created && (personal || record.payload.explicitRetention === false || (projects !== undefined && !sameProjects(libraryRecordProjects(record.payload), projects)))) {
      // A narrowing leaves the views before the record says so: a failure then costs a project a document it should
      // have, which the next pass restores, never a project a document it should not.
      if (projects !== undefined) await this.#withdrawFromViews(userId, record.payload.sourceId, { ...record.payload, projects });
      record = await this.documents.put(userId, RECORD_KIND, id, { ...record.payload,
        ...(projects !== undefined ? { projects } : {}),
        explicitRetention: personal ? record.payload.explicitRetention !== false : true,
        personalSourceIds: personal ? [...new Set([...(record.payload.personalSourceIds ?? []), source.id])] : record.payload.personalSourceIds ?? [],
      }, { expectedRevision: record.revision });
    }
    // Resolved among every live copy, so adding a document again from another
    // project leaves the entry reading the copy it already reads.
    const candidates = (await this.#liveSources(userId, [sha256])).get(sha256) ?? [source];
    record = await this.#refresh(userId, record, candidates);
    // What an entry applies to is what each project's directory holds: the answer waits for them.
    await this.#convergeViews(userId, { strict: true });
    return { item: entryView(record, candidates), created };
  }

  /** Take a document out of the library. The record is kept as a restorable
   *  revision; the copy goes at once, so no later run reads it.
   * @param {string} userId @param {unknown} sourceId */
  async remove(userId, sourceId) {
    const work = () => this.removeCurrent(userId, sourceId);
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /** @param {string} userId @param {unknown} sourceId @param {{personal?:boolean}} [options] */
  async removeCurrent(userId, sourceId, { personal = false } = {}) {
    const record = await this.#requireEntry(userId, sourceId);
    if (personal) {
      const remaining = (record.payload.personalSourceIds ?? []).filter(id => id !== sourceId);
      if (record.payload.explicitRetention !== false || remaining.length) {
        await this.documents.put(userId, RECORD_KIND, record.id, { ...record.payload, personalSourceIds: remaining }, { expectedRevision: record.revision });
        return { sourceId, removed: false };
      }
    }
    // Out of every project's directory before the record goes: a failure here leaves the entry in place and the call
    // repeatable, where a record removed first would leave copies nothing names and nothing could be asked to remove.
    await this.#withdrawFromViews(userId, record.payload.sourceId, { ...record.payload, projects: [] });
    if (!personal) {
      record.payload.explicitUnshared = true;
      const saved = await this.documents.put(userId, RECORD_KIND, record.id, record.payload, { expectedRevision: record.revision });
      record.revision = saved.revision;
    }
    await this.documents.remove(userId, RECORD_KIND, record.id, record.revision);
    this.counters.removed += 1;
    // A copy that could not be deleted now goes with the next convergence pass.
    const removeCopy = () => this.#removeCopy(userId, record.payload.sourceId).catch((error) => this.#failed(error));
    if (this.sources.afterPublication) await this.sources.afterPublication(removeCopy);
    else await removeCopy();
    return { sourceId: record.payload.sourceId, removed: true };
  }

  /**
   * The library's documents as one project's knowledge-base search scopes them: the entries that apply to that project (a
   * record that names it, or says "all"), each with the copy's own description and index key and the path a run reads it at.
   * The project is required: a caller that wanted the whole account's library says so by asking for `accountScope`, and a
   * call that forgot its project gets an error rather than every document the account keeps.
   * @param {string} userId @param {string} projectId
   */
  async searchScope(userId, projectId) {
    if (typeof projectId !== "string" || !projectId) throw new TypeError("The library's search scope is a project's: name the project.");
    return this.#scopeOf((await this.#records(userId)).filter((record) => libraryRecordCovers(record.payload, projectId)));
  }

  /**
   * Every entry of the account whatever it applies to, for what works on the account's library as a whole and never reads
   * it on a project's behalf: the engine's copy of it, the page that lists it. Not a scope a run may be given.
   * @param {string} userId
   */
  async accountScope(userId) {
    return this.#scopeOf(await this.#records(userId));
  }

  /** @param {any[]} records */
  #scopeOf(records) {
    return records.map((record) => {
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
    if (userId && !byUser.has(userId)) byUser.set(userId, []);
    const totals = { written: 0, removed: 0, failed: 0 };
    let budget = COPIES_PER_PASS;
    for (const [owner] of byUser) {
      const work = async () => {
      const records = await this.#records(owner);
      const present = await this.#presentCopies(owner);
      const live = await this.#liveSources(owner, records.map((record) => record.payload.sha256));
      for (const record of records) {
        const candidates = live.get(record.payload.sha256) ?? [];
        const source = resolveSource(candidates, record);
        if (!source || !sourceReadable(source.payload)) continue;
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
        await this.#removeCopy(owner, name).then(() => { totals.removed += 1; }, (error) => { totals.failed += 1; this.#failed(error); });
      }
      // The projects' directories follow the records and the copies just brought up to date.
      await this.#convergeViews(owner, { records }).catch(() => { totals.failed += 1; });
      };
      if (typeof this.sources.withRegistrationLocks === "function") await this.sources.withRegistrationLocks([`library:${owner}`], work);
      else await work();
    }
    return totals;
  }

  /**
   * Bring the copy of the document a just-published source holds up to date,
   * if the library has it. Called when a source finishes; never throws.
   * @param {string} userId @param {string} sourceId
   */
  async refreshSource(userId, sourceId, { strict = false } = {}) {
    const work = () => this.refreshSourceCurrent(userId, sourceId, { strict });
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /** @param {string} userId @param {string} sourceId @param {{ strict?: boolean }} [options] */
  async refreshSourceCurrent(userId, sourceId, { strict = false } = {}) {
    try {
      const source = await this.documents.get(userId, "source", librarySourceId(sourceId));
      const sha256 = String(source?.payload.fingerprint?.sha256 ?? "");
      const record = SHA256.test(sha256) ? await this.documents.get(userId, RECORD_KIND, `library:${sha256}`) : null;
      const refreshed = record
        ? await this.#refresh(userId, record, (await this.#liveSources(userId, [sha256])).get(sha256) ?? [], null, strict) : null;
      // A document that is gone, or a copy just rewritten, reaches the projects' directories here too: this is the call
      // every source's lifecycle makes, and the one that sees a removal.
      await this.#convergeViews(userId, { strict });
      return refreshed;
    } catch (error) {
      this.#failed(error);
      if (strict) throw error;
      return null;
    }
  }

  /**
   * A project's directory of the library, made and brought to the entries that apply to it, before a runtime of the project
   * is started over it (`RuntimeManager`). Either the directory is right or there is none: a directory that could not be
   * brought right is removed, and only a directory that can be neither is an error — a runtime is never mounted over a view
   * that may still show a document it must not.
   * With `onlyIfMissing` a directory that is already there is taken as current — every change to a record and the convergence
   * pass keep the directories that exist right; this is for the caller that only needs one to exist (a dispatch counting what a
   * project's library holds), where a launch asks for the full pass.
   * @param {string} userId @param {string} projectId @param {{ onlyIfMissing?: boolean }} [options]
   * @returns {Promise<string | null>} the directory, or null where views are not kept
   */
  async ensureProjectView(userId, projectId, { onlyIfMissing = false } = {}) {
    const dir = this.viewsDir?.(userId);
    if (!dir) return null;
    const view = path.join(dir, safeId(projectId, "project id"));
    // Not under the account's library lock: a dispatch only asks whether the directory is there, and waiting behind a pass that
    // is copying documents would be the price of a question with an answer on disk.
    if (onlyIfMissing && await fs.lstat(view).then((stat) => stat.isDirectory() && !stat.isSymbolicLink(), () => false)) return view;
    const work = async () => {
      try {
        await this.#convergeViews(userId, { strict: true, only: [projectId] });
      } catch (error) {
        await this.dropProjectView(userId, projectId);
        this.#failed(error);
        return null;
      }
      return view;
    };
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /** A project's directory removed, for a project that is gone (its records' lists were pruned in the deletion's transaction).
   *  Removing what is not there is not an error. @param {string} userId @param {string} projectId */
  async dropProjectView(userId, projectId) {
    if (!this.viewsDir) return;
    const root = await this.#viewRoot(userId);
    const target = path.join(root, safeId(projectId, "project id"));
    await assertNoSymlinkPath(root, target, { allowMissingTail: true });
    await fs.rm(target, { recursive: true, force: true });
  }

  /**
   * A new version of a document inherits where the old one applied (`afterReplace`): the replacement's entry is made with the
   * old record's `projects`, and the old record goes once no project holds those bytes as a current document any more. An
   * entry the new bytes already have is left as it is — a scope someone set is never widened by a replacement. Safe to run
   * again: what is done is not done twice.
   * @param {string} userId @param {{ projectId: string, replaced: { sourceId: string, sha256: string }, by: { sourceId: string } }} event
   */
  async carryOver(userId, { projectId, replaced, by }) {
    // Personal storage carries its own entries (`createPersonalLibraryWriter`).
    if (projectId === LIBRARY_PROJECT_ID || !SHA256.test(String(replaced?.sha256))) return { carried: false, released: false };
    const work = async () => {
      const old = await this.documents.get(userId, RECORD_KIND, `library:${replaced.sha256}`);
      if (!old || old.payload.recordType !== LIBRARY_RECORD_TYPE) return { carried: false, released: false };
      const fresh = await this.documents.get(userId, "source", by.sourceId).catch(() => null);
      const freshSha = String(fresh?.payload.fingerprint?.sha256 ?? "");
      if (!fresh || !SHA256.test(freshSha) || freshSha === replaced.sha256) return { carried: false, released: false };
      let carried = false;
      if (!await this.documents.get(userId, RECORD_KIND, `library:${freshSha}`)) {
        await this.addCurrent(userId, fresh.id, { projects: libraryRecordProjects(old.payload) });
        carried = true;
      }
      // The old entry stays while another project still holds the old bytes as a current document.
      const holders = ((await this.#liveSources(userId, [replaced.sha256])).get(replaced.sha256) ?? [])
        .filter((candidate) => candidate.payload.publication?.current !== false);
      let released = false;
      if (!holders.length) {
        await this.removeCurrent(userId, old.payload.sourceId);
        released = true;
      }
      return { carried, released };
    };
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`library:${userId}`], work) : work();
  }

  /**
   * Whether every entry of the library applies to a project — what a compile that reads the library as a whole may rely on.
   * @param {string} userId @param {string} projectId
   */
  async appliesWhole(userId, projectId) {
    return (await this.#records(userId)).every((record) => libraryRecordCovers(record.payload, projectId));
  }

  /**
   * A document's current understanding, in the researcher's memory capsule:
   * its summary and its key claims with their quotes (`libraryCapsuleEntries`),
   * all in the `sources` layer, in effect at once, and each stamped with the
   * document and its project — so it is recalled in that project only, and is
   * shown with its document rather than listed on the capsule page
   * (`CapsuleService.recall`, `CapsuleService.mine`).
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
    const work = async () => {
      // Deletion uses account, jobs and source row locks; its withdrawal and
      // this publication must serialize before either reads the source.
      await this.sources.lockSourceMutation?.(userId, id);
      return this.publishSourceUnderstandingCurrent(userId, id);
    };
    return typeof this.sources.withRegistrationLocks === "function"
      ? this.sources.withRegistrationLocks([`source:${userId}:${id}`], work) : work();
  }

  /** @param {string} userId @param {string} id */
  async publishSourceUnderstandingCurrent(userId, id) {
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
        let written = await this.capsules.addEntry(userId, capsule.id, { factKind: entry.factKind, layer: DOCUMENT_MEMORY_LAYER,
          content: entry.content, origin: "inferred", provenance: entry.provenance,
          derivedFrom: { sourceId: id, projectId: source.projectId } }, { publicationKey: entry.key });
        if (written.deletedAt || written.payload.status === "retired" || written.payload.correctedAt) {
          entryIds[entry.key] = written.id;
          kept += 1;
          continue;
        }
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
      const facts = entries.length;
      // Method drafts are not published any more (`libraryCapsuleEntries`);
      // the count stays in the answer for the callers that read it.
      const methods = 0;
      // The bookkeeping is keyed by the document, not by a library entry: the
      // personal library is a place a researcher chooses to put something, and
      // this happens to every document the platform reads.
      const latest = await this.documents.get(userId, RECORD_KIND, ledgerId);
      await this.documents.put(userId, RECORD_KIND, ledgerId, {
        recordType: PUBLICATION_RECORD_TYPE, sourceId: id, projectId: source.projectId, capsuleId: capsule.id, rule: PUBLICATION_RULE,
        generation: understanding.generation, textSha256: source.payload.analysis?.textSha256 ?? null, sourceRevision: source.revision, at: this.now().toISOString(), facts, methods, entries: entryIds,
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
  async #refresh(userId, record, candidates, present = null, strict = false) {
    const source = resolveSource(candidates, record);
    if (!source || !sourceReadable(source.payload)) return record;
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
      if (strict) throw error;
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

  /** The directory that holds the account's per-project views, checked to have no link on its way (like the master).
   *  @param {string} userId */
  async #viewRoot(userId) {
    const dir = this.viewsDir?.(userId);
    if (!dir) throw new TypeError("This library keeps no per-project views.");
    await assertNoSymlinkPath(path.dirname(path.dirname(dir)), dir, { allowMissingTail: true });
    return dir;
  }

  /** The projects that have a directory now: the ones a runtime may be mounted over. @param {string} userId @returns {Promise<string[]>} */
  async #viewProjects(userId) {
    const root = await this.#viewRoot(userId);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    // Only a directory with a project's name is a view; anything else beside them is left alone and never mounted.
    return entries.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)).map((entry) => entry.name);
  }

  /**
   * Bring the projects' directories to the records: for each directory (and each project named), exactly the entries that
   * apply to the project and have a copy, every file a real copy of the master, and nothing else. Every project is tried
   * whatever another one did; the first failure is the answer when `strict`, otherwise it is only counted.
   * @param {string} userId @param {{ strict?: boolean, only?: string[] | null, records?: any[] | null }} [options]
   *   `only`: just these projects, made if they are not there; otherwise every directory that exists
   */
  async #convergeViews(userId, { strict = false, only = null, records = null } = {}) {
    if (!this.viewsDir) return;
    /** @type {unknown} */
    let failure = null;
    try {
      const root = await this.#viewRoot(userId);
      const wanted = records ?? await this.#records(userId);
      const present = await this.#presentCopies(userId);
      for (const projectId of only ?? await this.#viewProjects(userId)) {
        try { await this.#convergeView(userId, root, projectId, wanted, present); }
        catch (error) { failure ??= error; this.counters.viewFailures += 1; this.#failed(error); }
      }
    } catch (error) {
      failure ??= error;
      this.counters.viewFailures += 1;
      this.#failed(error);
    }
    if (failure && strict) throw failure;
  }

  /** @param {string} userId @param {string} root @param {string} projectId @param {any[]} records @param {Set<string>} present */
  async #convergeView(userId, root, projectId, records, present) {
    const view = path.join(root, safeId(projectId, "project id"));
    await assertNoSymlinkPath(root, view, { allowMissingTail: true });
    await fs.mkdir(view, { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(root, view);
    const master = await this.#root(userId);
    /** @type {Set<string>} */
    const wanted = new Set();
    for (const record of records) {
      const name = record.payload.sourceId;
      if (SOURCE_ID.test(name) && record.payload.copy && present.has(name) && libraryRecordCovers(record.payload, projectId)) wanted.add(name);
    }
    for (const entry of await fs.readdir(view, { withFileTypes: true })) {
      if (entry.isDirectory() && wanted.has(entry.name)) continue;
      await fs.rm(path.join(view, entry.name), { recursive: true, force: true });
      this.counters.viewsRemoved += 1;
    }
    for (const name of wanted) {
      const from = path.join(master, name, COPY_FILE);
      const to = path.join(view, name, COPY_FILE);
      await assertNoSymlinkPath(master, from);
      const source = await fs.lstat(from);
      const current = await fs.lstat(to).catch(() => null);
      // The view's file takes the master's modification time, so "the same copy" is a size and a time to compare.
      if (current?.isFile() && current.size === source.size && Math.abs(current.mtimeMs - source.mtimeMs) < 1) continue;
      await writeFileAtomicNoFollow(view, to, await fs.readFile(from), { mode: 0o600 });
      await fs.utimes(to, source.atime, source.mtime);
      this.counters.viewsWritten += 1;
    }
  }

  /**
   * Take one entry's copy out of every project's directory that a record (as it is about to be) does not put it in.
   * Throws when it cannot: a narrowing that did not reach the directories must not be taken as made.
   * @param {string} userId @param {string} sourceId @param {any} next the record's payload after the change
   */
  async #withdrawFromViews(userId, sourceId, next) {
    if (!this.viewsDir || !SOURCE_ID.test(String(sourceId))) return;
    const root = await this.#viewRoot(userId);
    for (const projectId of await this.#viewProjects(userId)) {
      if (libraryRecordCovers(next, projectId)) continue;
      const target = path.join(root, projectId, sourceId);
      await assertNoSymlinkPath(root, target, { allowMissingTail: true });
      await fs.rm(target, { recursive: true, force: true });
      this.counters.viewsRemoved += 1;
    }
  }

  /** @param {unknown} error */
  #failed(error) {
    this.lastError = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "library_copy_failed";
    this.report(this.lastError);
  }
}

/**
 * What a project's deletion does to the library's records, in the deletion's own transaction (2026-10-28): the project's id
 * leaves every record's list — so a project made later under the same name inherits nothing — and a record that only the
 * project's own documents held goes with them, exactly as it does when its last document is deleted by hand. A record that
 * says "all" or has no list is not the project's to change, and stays while any other document holds its bytes. Each change
 * is a revision, so a removal can be restored. The copies and the directories follow at the next convergence pass.
 * @param {{ query: (sql: string, values: unknown[]) => Promise<any> }} client @param {string} userId @param {string} projectId
 * @returns {Promise<{ pruned: number, released: number }>}
 */
export async function libraryProjectDeleted(client, userId, projectId) {
  const pruned = await client.query(`WITH changed AS (UPDATE evimed_product.documents SET
      payload=jsonb_set(payload,'{projects}',(payload->'projects')-$2::text),updated_at=clock_timestamp(),revision=revision+1
      WHERE user_id=$1 AND kind='preferences' AND deleted_at IS NULL AND payload->>'recordType'='library-item'
        AND jsonb_typeof(payload->'projects')='array' AND payload->'projects' ? $2::text
      RETURNING user_id,kind,id,revision,payload,deleted_at)
    INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at) SELECT * FROM changed`, [userId, projectId]);
  const released = await client.query(`WITH removed AS (UPDATE evimed_product.documents l SET deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
      WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL AND l.payload->>'recordType'='library-item'
        AND EXISTS (SELECT 1 FROM evimed_product.documents s WHERE s.user_id=l.user_id AND s.kind='source' AND s.deleted_at IS NULL AND s.project_id=$2::text
          AND l.id='library:'||(s.payload->'fingerprint'->>'sha256'))
        AND NOT EXISTS (SELECT 1 FROM evimed_product.documents s WHERE s.user_id=l.user_id AND s.kind='source' AND s.deleted_at IS NULL AND s.project_id<>$2::text
          AND coalesce(s.payload->'publication'->>'current','true') <> 'false' AND l.id='library:'||(s.payload->'fingerprint'->>'sha256'))
      RETURNING user_id,kind,id,revision,payload,deleted_at)
    INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at) SELECT * FROM removed`, [userId, projectId]);
  return { pruned: pruned.rowCount ?? 0, released: released.rowCount ?? 0 };
}

/** @param {any} req @param {number} limit @param {string[]} fields @param {string} sentence */
async function bodyOf(req, limit, fields, sentence) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new HttpError(400, "library_payload_invalid", sentence);
  }
  return value;
}

/**
 * The personal library's routes (account-authenticated):
 *
 *   GET    /api/library                                  → { items: [...], maxItems }
 *   POST   /api/library                { sourceId, projects? }  → 201 the new entry, 200 the entry it already was
 *   PUT    /api/library/:sourceId      { projects, expectedRevision? } → 201 the entry made, 200 the entry changed
 *   DELETE /api/library/:sourceId                        → { sourceId, removed: true }
 *
 * `projects` is `"all"` or a list of ordinary project ids of the account (`libraryScope.mjs`); an entry answers with
 * `libraryProjects` (what it says), `appliesTo` (where the document is read) and `revision`. DELETE returns the document to
 * the project that holds it and nowhere else.
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
      const body = await bodyOf(req, maxJsonBytes, ["sourceId", "projects"], "Send { sourceId, projects? } and nothing else.");
      const { item, created } = await service.add(user.id, body.sourceId, "projects" in body ? { projects: parseLibraryProjects(body.projects) } : {});
      sendJson(res, created ? 201 : 200, { data: item });
      return true;
    }
    const match = /^\/api\/library\/(src_[a-f0-9]{32})$/.exec(url.pathname);
    if (match && method === "PUT") {
      const body = await bodyOf(req, maxJsonBytes, ["projects", "expectedRevision"], "Send { projects, expectedRevision? } and nothing else.");
      if (!("projects" in body)) throw new HttpError(400, "library_projects_invalid", 'Send "all" or a list of project ids.');
      const { item, created } = await service.setProjects(user.id, match[1], body.projects, { expectedRevision: body.expectedRevision });
      sendJson(res, created ? 201 : 200, { data: item });
      return true;
    }
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
 * @param {{ config: any, store: any, documents: any, sources: any, capsules?: any, kbIndex?: any, projectGuard?: ((userId: string, projectId: string) => Promise<unknown>) | null, report?: (code: string) => void }} dependencies
 *   `projectGuard`: which projects a record may name (`assertOrdinaryProject`, composed where the GEO and study stores are)
 */
export function createLibrary({ config, store, documents, sources, capsules = null, kbIndex = null, projectGuard = null, report = () => {} }) {
  const service = documents?.database && sources ? new LibraryService({ documents, sources, capsules,
    libraryDir: (userId) => userLibraryDir(config, userId), viewsDir: (userId) => libraryViewsRoot(config, userId), projectGuard,
    maxItems: config.libraryMaxItems, report }) : null;
  kbIndex?.useLibrary(service);
  return { service, routes: createLibraryRoutes({ store, service, maxJsonBytes: config.maxJsonBytes }) };
}
