import { createHash, randomUUID } from "node:crypto";
import { identifierShapesIn, maskIdentifiers } from "@evimed/domain";
import { contentHash, lineFingerprint, memoryLines } from "./nativeMemoryOverlay.mjs";
import { MEMORY_SEGMENT_OF_TYPE, PROJECT_MEMORY_TYPES, nativeMemoryFile, platformSessionOf } from "./openVikingSessions.mjs";
import { HttpError } from "./security.mjs";

/**
 * The memory page, the memory map and the account's own operations for an account whose memory is on OpenViking's native
 * engine (2026-10-13).
 *
 * The engine holds the memories as files its own extraction writes; this module reads them, presents them in the shape the
 * page already reads for the legacy path (`publicRecord` in researchMemory.mjs — so the page changes little), and carries out
 * the person's edits, deletions and requests on them. What the engine has no place for is the overlay's
 * (`nativeMemoryOverlay.mjs`): revisions, the rejection list, project tags, source labels, the commit ledger.
 *
 * Hidden knowledge, each measured on v0.5.0 (`lab/memory/RESULTS.md` part 三):
 *  - **A record is a file, and the profile is a document.** Every type but the profile is one file per topic, project or
 *    entity; `profile.md` is one file whose lines are the facts. The profile is therefore served as one record per line,
 *    each naming its document, and an edit of a line is an edit of the document under the document's compare-and-swap.
 *  - **No compare-and-swap upstream.** `content/write` replaces without asking; `version` here is derived from the hash of
 *    the text this module last read, and every edit reads the file again and refuses a version that is not the current one.
 *  - **A new memory goes in through the engine** (`remember`: a session with one message and a commit), never as
 *    `content/write mode=create`: a created file carries no type and no tags and later extraction never updates it.
 *    The one place a file is created here is the undo of a forget, and what that loses is said there.
 *  - **Counts are counted here.** The engine's `stats/memories` is the whole account's.
 *
 * What the legacy path has and this one does not (owner-accepted, README §5.4 of the course correction): no line of the
 * profile has its own origin, validity interval, confidence or conflict record; a revision is a file's, not a fact's; and
 * nothing is "pending" for the person to confirm — the engine writes, the person edits or deletes, and every change can be
 * undone in one step.
 *
 * @module nativeMemoryStore
 */

/**
 * What names the conversations a memory came out of: for each `{ projectId, sessionId }` (a platform conversation and the project
 * it was held in), its title, or `null` when the conversation was deleted. A conversation it cannot say anything about is absent.
 * @typedef {(userId: string, refs: { projectId: string, sessionId: string }[]) => Promise<Record<string, string | null>>} ConversationTitles
 */

/** The legacy kind the page labels a native type by; `nativeType` carries the engine's own. */
export const LEGACY_KIND_OF_TYPE = Object.freeze({
  profile: "profile",
  preferences: "preference",
  corrections: "correction",
  decisions: "decision",
  follow_ups: "follow_up",
  project_facts: "project_fact",
  project_context: "project_fact",
  entities: "project_fact",
});

/** What a native memory's id looks like: a file's, or a profile line's (the file's id and the line's fingerprint). */
export const NATIVE_RECORD_ID = /^nm_[a-f0-9]{24}(?:_[a-f0-9]{12})?$/;

/** The line the platform writes into a memory file when a source it names changed; never a statement, never rejected. */
export const SOURCE_LABEL_PREFIX = "> 来源变更：";

const AS_OF = /\s*[(（]as of (\d{4}-\d{2}-\d{2})[)）]\s*$/i;
const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/** @param {string} uri */
export function nativeFileId(uri) {
  return `nm_${sha256(uri).slice(0, 24)}`;
}

/** A compare-and-swap token the page already knows how to send back: a positive integer from the text's hash. @param {string} hash */
export function versionOfHash(hash) {
  return Number.parseInt(String(hash).slice(0, 12), 16) + 1;
}

/** A label line, or a statement: label lines are the platform's and are not shown as facts. @param {string} line */
const isLabelLine = (line) => line.trim().startsWith(SOURCE_LABEL_PREFIX.trim());

/** The statements of a body, without the platform's label lines. @param {string} body */
function statements(body) {
  return memoryLines(String(body ?? "").split("\n").filter((line) => !isLabelLine(line)).join("\n"));
}

/** What a file is called on the page: the card's title for a project, else the topic or entity name in its file name. */
function titleOf(type, relPath, body) {
  if (type === "profile") return "";
  if (type === "project_context") {
    const heading = /^#\s+(.+)$/m.exec(String(body ?? ""));
    if (heading) return heading[1].trim();
  }
  return relPath.split("/").at(-1)?.replace(/\.md$/, "") ?? relPath;
}

/** The sources a memory's text names: published works by DOI, knowledge-base documents by id. @param {string} text */
export function sourcesNamedIn(text) {
  /** @type {Map<string, { type: string, id: string }>} */
  const found = new Map();
  for (const match of String(text ?? "").matchAll(/\b10\.\d{4,9}\/[^\s"'<>，。；、）)\]]+/g)) {
    const id = match[0].replace(/[.,;:]+$/, "").toLowerCase();
    found.set(`doi:${id}`, { type: "doi", id });
  }
  for (const match of String(text ?? "").matchAll(/\bsrc_[a-f0-9]{32}\b/g)) found.set(`knowledge_source:${match[0]}`, { type: "knowledge_source", id: match[0] });
  return [...found.values()].slice(0, 16);
}

/** Run `fn` over items, at most `limit` at a time, in order. @template T, R @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn */
async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

/** An engine that did not answer is the memory service being unavailable, said so by name. @param {unknown} error */
function engineFailure(error) {
  const code = String(/** @type {any} */ (error)?.code ?? "");
  if (/^memory_index_(?:timeout|unavailable|upstream_error|auth_failed|response_invalid|url_|rate_limited)|_api_key_/.test(code)) {
    return new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
  }
  return error;
}

/**
 * What reading an account's memory costs the engine: one listing, then one read per file. The memory page asks for it three ways at
 * once (the list, a project's overview, what changed) and a conversation's tools ask again, so the same files were read three or four
 * times over, eight at a time, by one visit — on an account of a hundred files that is the page's first screen taking longer than a
 * browser's patience (the release walk of 2026-10-18: memory did not answer in 30 s on the owner's data).
 *
 *  - callers that arrive while a read of the same account is under way share it (nothing is kept once it ends: a read that begins after
 *    another has ended is its own, so nothing here is ever older than the call that asked);
 *  - a file whose `modTime` and size are what they were when it was last read is not read again; every write the store makes forgets the
 *    account's bodies, so the page that has just edited a memory reads it back as it is.
 */
const BODIES_PER_ACCOUNT = 400;

/**
 * The conversations a memory came out of, as the evidence the page's drawer already reads (`memorySource` takes the first one
 * for 「来源对话」): one per platform conversation whose commit the engine wrote the file in, oldest first — so the first is where
 * it began. The overlay holds what is needed and nothing more: each revision names the engine session (`dsh-<conversation>`) and
 * the archive of the commit; the ledger names the project. A session the platform did not derive (a migration, a replay, the
 * page's own 「记住这一条」) is no conversation and is left out. There is no quotation: the engine keeps none, and none is made up.
 *
 * For one line of the profile (`line`), only the commit that brought that line counts, found by what the revision's text did to it
 * — so a conversation that merely touched the file is not named as the source of every line in it, and a line already there when
 * the oldest revision the overlay still holds was written names nothing rather than a guess.
 * @param {any[]} history a file's revisions, oldest first @param {Map<string, string>} sessionProjects by engine session
 * @param {{ line?: string | null }} [options]
 */
function conversationEvidence(history, sessionProjects, { line = null } = {}) {
  const print = line === null ? null : lineFingerprint(line);
  const printsOf = (/** @type {unknown} */ text) => new Set(memoryLines(text ?? "").map(lineFingerprint));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const evidence = [];
  for (const revision of history) {
    if (revision.actor !== "engine" || (revision.change !== "added" && revision.change !== "updated") || !revision.engineSession) continue;
    const conversationId = platformSessionOf(revision.engineSession);
    if (!conversationId || seen.has(conversationId)) continue;
    if (print !== null && !(printsOf(revision.after).has(print) && !printsOf(revision.before).has(print))) continue;
    seen.add(conversationId);
    const projectId = sessionProjects.get(revision.engineSession) ?? revision.projectId ?? null;
    evidence.push({
      sourceType: "conversation", sourceRef: `sessions/${conversationId}/commits/${String(revision.archiveUri ?? "").split("/").at(-1) || "archive"}`,
      quote: "", observedAt: revision.changedAt ?? null, weight: 1, fingerprint: `revision:${revision.id}`, conversationId, ...(projectId ? { projectId } : {}),
    });
    if (evidence.length >= 8) break;
  }
  return evidence;
}
const BODY_ACCOUNTS = 100;

export class NativeMemoryStore {
  /** @type {Map<string, { epoch: number, promise: Promise<any[]> }>} */
  #reading = new Map();
  /** @type {Map<string, Map<string, { modTime: string, size: number, body: string }>>} */
  #bodies = new Map();
  /** @type {Map<string, number>} what each account's writes have counted: a read begun before a write is not shared after it */
  #epochs = new Map();

  /**
   * @param {{ sessions: import("./openVikingSessions.mjs").OpenVikingSessions, overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
   *   now?: () => Date, conversationTitles?: ConversationTitles | null }} dependencies
   *   `conversationTitles` names the conversations a memory came out of (the run ledger knows them; this store does not).
   */
  constructor({ sessions, overlay, now = () => new Date(), conversationTitles = null }) {
    this.sessions = sessions;
    this.overlay = overlay;
    this.now = now;
    this.conversationTitles = conversationTitles;
  }

  get configured() {
    return Boolean(this.sessions?.configured && this.overlay?.configured);
  }

  #assertConfigured() {
    if (!this.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
  }

  /** @template T @param {() => Promise<T>} fn */
  async #engine(fn) {
    try { return await fn(); } catch (error) { throw engineFailure(error); }
  }

  // ----------------------------------------------------------------- reading

  /** The account's own writes: its cached bodies and any read begun before now are not to be trusted after this. @param {string} userId */
  #touch(userId) {
    this.#epochs.set(userId, (this.#epochs.get(userId) ?? 0) + 1);
    this.#reading.delete(userId);
    this.#bodies.delete(userId);
  }

  /**
   * Every memory file of the account, with its body, type, project and what the overlay knows of it.
   * @param {string} userId
   */
  async files(userId) {
    this.#assertConfigured();
    const epoch = this.#epochs.get(userId) ?? 0;
    const running = this.#reading.get(userId);
    if (running && running.epoch === epoch) return running.promise;
    const promise = this.#readFiles(userId, epoch);
    const entry = { epoch, promise };
    this.#reading.set(userId, entry);
    const forget = () => { if (this.#reading.get(userId) === entry) this.#reading.delete(userId); };
    promise.then(forget, forget);
    return promise;
  }

  /** @param {string} userId @param {number} epoch */
  async #readFiles(userId, epoch) {
    const root = this.sessions.memoryRoot(userId);
    const nodes = await this.#engine(() => this.sessions.tree(userId, root, { levelLimit: 8 }));
    const known = await this.overlay.files(userId);
    const listed = nodes.filter((node) => !node.isDir).map((node) => ({ node, file: nativeMemoryFile(node.uri, root) })).filter((entry) => entry.file);
    const kept = this.#bodies.get(userId) ?? new Map();
    const files = await mapLimit(listed, 8, async ({ node, file }) => {
      const cached = node.modTime ? kept.get(node.uri) : undefined;
      const body = cached && cached.modTime === node.modTime && cached.size === node.size
        ? cached.body
        : (await this.#engine(() => this.sessions.read(userId, node.uri))) ?? "";
      if (node.modTime && !(cached && cached.body === body)) kept.set(node.uri, { modTime: node.modTime, size: node.size, body });
      const held = known.get(node.uri) ?? null;
      const tag = node.tags.find((item) => item.startsWith("project="))?.slice("project=".length) ?? null;
      return {
        uri: node.uri, relPath: /** @type {any} */ (file).relPath, type: /** @type {any} */ (file).type, body, hash: contentHash(body),
        projectId: tag ?? held?.projectId ?? null, sensitive: held?.sensitive === true, labels: held?.labels ?? [], modTime: node.modTime,
      };
    });
    // Only what is still true: a write since this read began has made these bodies old, and the listing is the engine's, not the cache's.
    if ((this.#epochs.get(userId) ?? 0) === epoch) {
      const present = new Set(listed.map(({ node }) => node.uri));
      for (const uri of kept.keys()) if (!present.has(uri)) kept.delete(uri);
      while (kept.size > BODIES_PER_ACCOUNT) kept.delete(/** @type {string} */ (kept.keys().next().value));
      this.#bodies.delete(userId);
      this.#bodies.set(userId, kept);
      while (this.#bodies.size > BODY_ACCOUNTS) this.#bodies.delete(/** @type {string} */ (this.#bodies.keys().next().value));
    }
    return files;
  }

  /**
   * The account's memories as records (`publicRecord`'s shape plus `engine`, `nativeType`, `uri`, `contentHash` and, for a
   * profile line, `document`), newest change first.
   * @param {string} userId @param {{ files?: any[] }} [options]
   */
  async records(userId, { files = undefined } = {}) {
    const held = files ?? await this.files(userId);
    const revisions = await this.overlay.revisionsOfMany(userId, held.map((file) => file.uri));
    const sources = await this.overlay.sources(userId, held.map((file) => file.uri));
    // The conversations the engine wrote these files in: its revisions name the engine session, the ledger names the project.
    const sessionProjects = await this.#sessionProjects(userId, revisions);
    /** @type {any[]} */
    const records = [];
    for (const file of held) {
      const history = (revisions.get(file.uri) ?? []).slice().reverse();
      const changed = sources.filter((source) => source.uri === file.uri && ["retracted", "changed", "expired", "removed"].includes(source.state));
      const base = this.#fileRecord(file, history, changed, conversationEvidence(history, sessionProjects));
      if (file.type !== "profile") { records.push(base); continue; }
      // The profile is one document; its lines are the items the page lists.
      for (const line of statements(file.body)) {
        const asOf = AS_OF.exec(line)?.[1] ?? null;
        // A line's own conversation is the one whose commit brought it, not every conversation that touched the file.
        const evidence = conversationEvidence(history, sessionProjects, { line });
        records.push({
          ...base, id: `${base.id}_${lineFingerprint(line).slice(0, 12)}`, key: `profile.md#${lineFingerprint(line).slice(0, 12)}`,
          value: line.replace(AS_OF, "").trim(), summary: "", lastConfirmedAt: asOf ? `${asOf}T00:00:00.000Z` : base.lastConfirmedAt,
          document: { id: base.id, uri: file.uri }, revisions: [], evidence, evidenceCount: evidence.length,
        });
      }
    }
    return records.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  }

  /**
   * The project each engine session named by these revisions was held in, for the sessions a platform conversation wrote.
   * A ledger that cannot answer names none: the evidence then carries no project and the link opens in the project in view.
   * @param {string} userId @param {Map<string, any[]>} revisions
   * @returns {Promise<Map<string, string>>}
   */
  async #sessionProjects(userId, revisions) {
    const names = new Set();
    for (const list of revisions.values()) for (const revision of list) if (revision.engineSession && platformSessionOf(revision.engineSession)) names.add(revision.engineSession);
    if (!names.size) return new Map();
    return this.overlay.sessionProjects(userId, [...names]).catch(() => new Map());
  }

  /**
   * What the conversations of the records on a page were about, by conversation id, and which of them are gone. Absent
   * resolver, absent titles: the page then says 「来源对话」 and nothing more. A conversation the person deleted is dropped from
   * the evidence of the records it names — a link to nothing is not provenance.
   * @param {string} userId @param {any[]} records
   * @returns {Promise<{ titles: Record<string, string>, records: any[] }>}
   */
  async #withConversationTitles(userId, records) {
    /** @type {Map<string, { projectId: string, sessionId: string }>} */
    const refs = new Map();
    for (const record of records) {
      for (const item of record.evidence ?? []) {
        if (item.sourceType !== "conversation" || !item.projectId) continue;
        refs.set(`${item.projectId}\u0000${item.conversationId}`, { projectId: item.projectId, sessionId: item.conversationId });
      }
    }
    if (!refs.size || typeof this.conversationTitles !== "function") return { titles: {}, records };
    /** @type {Record<string, string | null>} */
    let named = {};
    try { named = await this.#titlesCached(userId, [...refs.values()]); } catch { return { titles: {}, records }; }
    /** @type {Record<string, string>} */
    const titles = {};
    for (const [sessionId, title] of Object.entries(named)) if (typeof title === "string" && title) titles[sessionId] = title;
    const gone = new Set(Object.entries(named).filter(([, title]) => title === null).map(([sessionId]) => sessionId));
    if (!gone.size) return { titles, records };
    return { titles, records: records.map((record) => {
      const evidence = (record.evidence ?? []).filter((/** @type {any} */ item) => !(item.sourceType === "conversation" && gone.has(item.conversationId)));
      return evidence.length === (record.evidence ?? []).length ? record : { ...record, evidence, evidenceCount: evidence.length };
    }) };
  }

  /** @type {Map<string, { at: number, value: string | null }>} the resolver's answers for a minute: the ledger it reads is a file per project */
  #titleCache = new Map();

  /** @param {string} userId @param {{ projectId: string, sessionId: string }[]} refs @returns {Promise<Record<string, string | null>>} */
  async #titlesCached(userId, refs) {
    const now = this.now().getTime();
    /** @type {Record<string, string | null>} */
    const out = {};
    const missing = [];
    for (const ref of refs) {
      const held = this.#titleCache.get(`${userId}\u0000${ref.projectId}\u0000${ref.sessionId}`);
      if (!held || now - held.at >= 60_000) { missing.push(ref); continue; }
      if (held.value !== "") out[ref.sessionId] = held.value;
    }
    if (missing.length) {
      const answered = await /** @type {ConversationTitles} */ (this.conversationTitles)(userId, missing);
      for (const ref of missing) {
        // "": the resolver had nothing to say of this conversation (remembered, so that the ledger is not read again for it).
        const value = Object.hasOwn(answered, ref.sessionId) ? answered[ref.sessionId] : "";
        if (this.#titleCache.size > 2_000) this.#titleCache.clear();
        this.#titleCache.set(`${userId}\u0000${ref.projectId}\u0000${ref.sessionId}`, { at: now, value });
        if (value !== "") out[ref.sessionId] = value;
      }
    }
    return out;
  }

  /** @param {any} file @param {any[]} history oldest first @param {any[]} changed sources in a changed state @param {any[]} [evidence] the conversations that wrote it */
  #fileRecord(file, history, changed, evidence = []) {
    const first = history[0] ?? null;
    const last = history.at(-1) ?? null;
    const updatedAt = last?.changedAt ?? file.modTime ?? null;
    const projectScoped = PROJECT_MEMORY_TYPES.includes(file.type) && Boolean(file.projectId);
    return {
      id: nativeFileId(file.uri),
      scope: projectScoped ? "project" : "user",
      scopeId: projectScoped ? file.projectId : "",
      kind: /** @type {Record<string, string>} */ (LEGACY_KIND_OF_TYPE)[file.type] ?? "project_fact",
      key: file.relPath,
      value: file.body,
      summary: titleOf(file.type, file.relPath, file.body),
      // Whose words: the engine keeps only what the person stated (its templates' rule), and the page's own edit is theirs.
      origin: last?.actor === "user" ? "manual" : "explicit",
      status: "active",
      confidence: 1,
      importance: 0.5,
      sensitive: file.sensitive,
      evidenceCount: evidence.length,
      version: versionOfHash(file.hash),
      createdAt: first?.changedAt ?? file.modTime ?? null,
      updatedAt,
      lastConfirmedAt: updatedAt,
      expiresAt: null,
      supersededBy: null,
      invalidSince: null,
      validFrom: null,
      evidence,
      // What the file said before each change, oldest first, as the page's 「以前的版本」 reads them.
      revisions: history.filter((revision) => revision.before !== null).map((revision, index) => ({
        version: index + 1, value: String(revision.before ?? ""), summary: "", status: "active", changedAt: revision.changedAt,
        reason: revision.reason, by: revision.actor === "engine" ? "extraction" : revision.actor === "platform" ? "system" : "user",
      })),
      ...(changed.length ? { relations: { validity: { from: null, until: null }, caveats: [], conflicts: [],
        sources: changed.map((source) => ({ type: source.type, id: source.id, state: source.state === "removed" ? "expired" : source.state })) } } : {}),
      engine: "native",
      nativeType: file.type,
      uri: file.uri,
      contentHash: file.hash,
    };
  }

  /** One record by id, or 404. @param {string} userId @param {string} id */
  async getRecord(userId, id) {
    const found = (await this.records(userId)).find((record) => record.id === id);
    if (found) return found;
    // A document id (the whole profile) is addressable too.
    const files = await this.files(userId);
    const document = files.find((file) => nativeFileId(file.uri) === id);
    if (!document) throw new HttpError(404, "memory_not_found", "Memory not found.");
    // The document names every conversation that wrote it, as a file does (its lines each name their own).
    const history = (await this.overlay.revisionsOf(userId, document.uri, { limit: 32 })).slice().reverse();
    return this.#fileRecord(document, [], [], conversationEvidence(history, await this.#sessionProjects(userId, new Map([[document.uri, history]]))));
  }

  /** The file a record id names, read now, with the line a profile-line id names. @param {string} userId @param {string} id */
  async #target(userId, id) {
    if (!NATIVE_RECORD_ID.test(String(id))) throw new HttpError(404, "memory_not_found", "Memory not found.");
    const [fileId, line] = [String(id).slice(0, 27), String(id).length > 27 ? String(id).slice(28) : null];
    const files = await this.files(userId);
    const file = files.find((candidate) => nativeFileId(candidate.uri) === fileId);
    if (!file) throw new HttpError(404, "memory_not_found", "Memory not found.");
    if (line === null) return { file, line: null };
    const raw = file.body.split("\n");
    const index = raw.findIndex((text) => !isLabelLine(text) && !/^#{1,6}\s/.test(text.trim()) && text.trim()
      && lineFingerprint(text.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")).slice(0, 12) === line);
    if (index < 0) throw new HttpError(404, "memory_not_found", "Memory not found.");
    return { file, line: { index, raw: raw[index] } };
  }

  /**
   * The memory page's list (`GET /api/memory/profile`), in the legacy shape, plus `engine` and `pending`: what the person asked
   * the page to remember that the engine has not written yet.
   * @param {string} userId @param {{ holder?: { id: string, name: string } }} [options]
   */
  async profile(userId, { holder = undefined } = {}) {
    const files = await this.files(userId);
    const { titles, records: active } = await this.#withConversationTitles(userId, await this.records(userId, { files }));
    // What the person forgot rides in the same list as `status: "archived"`, as it does on the other engine: the page's 「已忘记的内容」
    // reads it from there, and every other reader leaves an archived memory out.
    const records = [...active, ...await this.forgotten(userId, { files }).catch(() => [])];
    /** @type {Record<string, any[]>} */
    const groups = {};
    for (const kind of new Set(Object.values(LEGACY_KIND_OF_TYPE))) groups[kind] = [];
    for (const record of records) (groups[record.kind] ??= []).push(record);
    return {
      ...(holder ? { holder } : {}), records, groups, activeCount: active.length, pendingCount: 0, episodeCount: 0,
      conversations: titles, usage: {}, engine: "native", pending: await this.pending(userId),
    };
  }

  /** What the page asked the engine to remember and it has not written yet. @param {string} userId */
  async pending(userId) {
    return (await this.overlay.pendingCommits(userId, { origins: ["page"] })).map((commit) => ({
      id: commit.archiveUri, text: commit.pendingText ?? "", at: commit.createdAt, state: commit.state === "failed" ? "retrying" : "pending",
    }));
  }

  /**
   * The page's list read with filters (`GET /api/memory/records`): scopes, kinds and a project, as the legacy route takes them.
   * @param {string} userId @param {{ scopes?: string[], kinds?: string[], scopeId?: string, query?: string, pageSize?: number }} filters
   */
  async listRecords(userId, { scopes = [], kinds = [], scopeId = "", query = "", pageSize = 100 } = {}) {
    const words = String(query ?? "").trim().toLowerCase();
    return (await this.records(userId))
      .filter((record) => !scopes.length || scopes.includes(record.scope))
      .filter((record) => !kinds.length || kinds.includes(record.kind))
      .filter((record) => !scopeId || record.scopeId === scopeId)
      .filter((record) => !words || `${record.summary}\n${record.value}`.toLowerCase().includes(words))
      .slice(0, Math.max(1, Math.min(500, Math.trunc(Number(pageSize)) || 100)));
  }

  /**
   * The page's search box: the words over every memory's text, unioned with the engine's own semantic search, each hit
   * resolved back to the record the page lists (a hit on the profile is the profile lines that share a word of the query).
   * @param {string} userId @param {string} query
   */
  async search(userId, query) {
    const text = String(query ?? "").trim();
    const records = (await this.#withConversationTitles(userId, await this.records(userId))).records;
    const lower = text.toLowerCase();
    const items = text ? records.filter((record) => `${record.summary}\n${record.value}`.toLowerCase().includes(lower)) : records;
    const seen = new Set(items.map((record) => record.id));
    let semantic = 0;
    if (text) {
      const hits = await this.#engine(() => this.sessions.find(userId, text, { target: this.sessions.memoryRoot(userId), limit: 25 })).catch(() => []);
      const words = lower.split(/\s+/).filter((word) => word.length >= 2);
      for (const hit of hits) {
        for (const record of records.filter((candidate) => candidate.uri === hit.uri)) {
          if (seen.has(record.id)) continue;
          if (record.document && words.length && !words.some((word) => record.value.toLowerCase().includes(word))) continue;
          seen.add(record.id);
          items.push(record);
          semantic += 1;
        }
      }
    }
    return { items, query: text, semantic, conversations: (await this.#withConversationTitles(userId, items)).titles, usage: {} };
  }

  /**
   * The project tab's card (`GET /api/memory/projects/:id/overview` → `card`), in the legacy card's shape
   * (`{ slot, recordId, text, updatedAt }[]`, `projectCard` in projectOverview.mjs): read off the sections of the project's
   * own project-context file, whose headings are the card's words (the template and the legacy card share them).
   * @param {string} userId @param {string} projectId
   */
  async projectCard(userId, projectId) {
    const records = (await this.records(userId)).filter((record) => record.nativeType === "project_context" && record.scopeId === projectId);
    // The labels the template has the engine write: Chinese in a Chinese conversation, these English ones in an English one
    // (`project_context.yaml`). Any other language writes translations of them, which this closed list does not read: that card
    // shows as the file it is, in full, on the memory page, and has no slots here.
    const SLOT_OF_HEADING = { "目标": "goal", "范围或对象": "subject", "材料与数据": "data_source", "阶段": "stage", "约束": "constraints",
      "goal": "goal", "scope": "subject", "materials and data": "data_source", "stage": "stage", "constraints": "constraints" };
    const SLOT_OF_ELEMENT = { "人群": "population", "干预或暴露": "intervention", "对照": "comparator", "结局": "outcome", "设计": "design",
      "population": "population", "intervention or exposure": "intervention", "comparator": "comparator", "outcome": "outcome", "design": "design" };
    const ELEMENTS = new Set(["研究要素", "study elements"]);
    /** @type {Map<string, { slot: string, recordId: string, text: string, updatedAt: string | null }>} */
    const card = new Map();
    for (const record of records) {
      let section = "";
      for (const line of String(record.value).split("\n")) {
        const trimmed = line.trim();
        const heading = /^##\s+(.+)$/.exec(trimmed);
        if (heading) { section = heading[1].replace(/[（(].*$/, "").trim().toLowerCase(); continue; }
        const field = /^(?:领域|field)[：:]\s*(.+)$/i.exec(trimmed);
        if (field && !card.has("field")) { card.set("field", { slot: "field", recordId: record.id, text: field[1].trim(), updatedAt: record.updatedAt }); continue; }
        if (!/^[-*+]\s+\S/.test(trimmed)) continue;
        const item = trimmed.replace(/^[-*+]\s+/, "");
        const element = /^([^：:]{1,24})[：:]\s*(.+)$/.exec(item);
        const inElements = ELEMENTS.has(section) && element;
        const slot = inElements ? /** @type {Record<string, string>} */ (SLOT_OF_ELEMENT)[element[1].trim().toLowerCase()] : /** @type {Record<string, string>} */ (SLOT_OF_HEADING)[section];
        if (!slot) continue;
        const value = inElements ? element[2].trim() : item;
        const held = card.get(slot);
        card.set(slot, held && held.recordId === record.id ? { ...held, text: `${held.text}；${value}`.slice(0, 600) } : held ?? { slot, recordId: record.id, text: value.slice(0, 600), updatedAt: record.updatedAt });
      }
    }
    const order = ["field", "goal", "subject", "data_source", "stage", "constraints", "population", "intervention", "comparator", "outcome", "design"];
    return order.filter((slot) => card.has(slot)).map((slot) => card.get(slot));
  }

  /**
   * The memories the timeline derives its memory events from (`memoryTimeline`): the account's own and this project's, newest
   * change first, each with the revisions the overlay holds as the page's 「以前的版本」.
   * @param {string} userId @param {{ projectId?: string, limit?: number }} [options]
   */
  async timelineRecords(userId, { projectId = "", limit = 1000 } = {}) {
    return (await this.records(userId))
      .filter((record) => !record.sensitive && (record.scope === "user" || !projectId || record.scopeId === projectId))
      .slice(0, Math.max(1, Math.min(5_000, Math.trunc(Number(limit)) || 1000)))
      // A file's name is not what changed: the timeline says the words the file held, as a revision's own states do.
      .map((record) => ({ ...record, summary: "" }));
  }

  /** What the map draws (`createNativeMemorySource`): the records, the sources they rest on, no conflicts, no usage. @param {string} userId */
  async mapMemories(userId) {
    const files = await this.files(userId);
    const records = (await this.records(userId, { files })).filter((record) => !record.sensitive);
    const sources = await this.overlay.sources(userId);
    const idOf = new Map(records.map((record) => [record.uri, record.id]));
    return {
      records,
      sources: sources.filter((source) => idOf.has(source.uri)).map((source) => ({
        recordId: /** @type {string} */ (idOf.get(source.uri)), type: source.type, id: source.id,
        state: source.state === "removed" ? "expired" : source.state, linkedAt: source.stateAt,
      })),
      conflicts: [],
      usage: {},
    };
  }

  /** The sources one memory names, with the state each is in (`GET /api/memory/records/:id/sources`). @param {string} userId @param {string} id */
  async sourceLinks(userId, id) {
    const { file } = await this.#target(userId, id);
    return (await this.overlay.sources(userId, [file.uri])).map((source) => ({ type: source.type, id: source.id, state: source.state === "removed" ? "expired" : source.state }));
  }

  /**
   * What changed by itself since a moment (「刚记住了」), in the legacy change shape: each item carries the version its
   * one-click undo names.
   * @param {string} userId @param {{ since?: string | null, sessionId?: string | null, limit?: number }} options
   */
  async changes(userId, { since = null, sessionId = null, limit = 20 } = {}) {
    if (since && !Number.isFinite(Date.parse(since))) throw new HttpError(400, "memory_payload_invalid", "since is invalid.");
    if (sessionId && !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new HttpError(400, "memory_payload_invalid", "sessionId is invalid.");
    // What the engine's consolidation did to the files is its tidying, not something it just learned: 「刚记住了」 does not say it.
    const revisions = (await this.overlay.recentRevisions(userId, { since, engineSession: sessionId ? `dsh-${sessionId}` : null, actors: ["engine"], limit: 50 }))
      .filter((revision) => revision.reason !== "consolidation");
    const files = await this.overlay.files(userId);
    /** @type {Set<string>} */
    const seen = new Set();
    const out = [];
    for (const revision of revisions) {
      if (revision.change === "deleted" || seen.has(revision.uri)) continue;
      const file = files.get(revision.uri);
      if (!file?.contentHash) continue;
      seen.add(revision.uri);
      const projectScoped = PROJECT_MEMORY_TYPES.includes(revision.memoryType) && Boolean(file.projectId);
      out.push({
        id: nativeFileId(revision.uri), key: revision.uri.slice(revision.uri.indexOf("/memories/") + "/memories/".length),
        kind: /** @type {Record<string, string>} */ (LEGACY_KIND_OF_TYPE)[revision.memoryType] ?? "project_fact",
        scope: projectScoped ? "project" : "user", scopeId: projectScoped ? file.projectId : "",
        summary: String(revision.after ?? "").replace(/\s+/g, " ").trim().slice(0, 200), status: "active",
        change: revision.change === "added" ? "created" : "updated", changedAt: revision.changedAt, version: versionOfHash(file.contentHash),
      });
      if (out.length >= Math.max(1, Math.min(50, Number(limit) || 20))) break;
    }
    return out;
  }

  // ----------------------------------------------------------------- writing

  /**
   * The person's own edit (`PATCH /api/memory/records/:id`): `value` replaces the file (a profile line replaces that line of
   * the document), `sensitive` keeps the file out of recall, `status: "archived"` is 「忘记」 with an undo. Compare-and-swap
   * on the text this module last read: a file that changed since is a 409, never an overwrite.
   * @param {string} userId @param {string} id @param {{ value?: string, sensitive?: boolean, status?: string, expectedVersion: number }} patch
   */
  async update(userId, id, { value = undefined, sensitive = undefined, status = undefined, expectedVersion }) {
    /** @type {{ file: any, line: any }} */
    let target;
    try {
      target = await this.#target(userId, id);
    } catch (error) {
      // A memory the person forgot is not on the page any more, and its restore is the same call as any other change of status.
      if (status === "active" && value === undefined && sensitive === undefined && /** @type {any} */ (error)?.code === "memory_not_found") return this.#restoreForgotten(userId, id, expectedVersion);
      throw error;
    }
    const { file, line } = target;
    if (versionOfHash(file.hash) !== expectedVersion) throw new HttpError(409, "memory_conflict", "Structured memory changed before this update was applied.");
    if (status !== undefined && status !== "active") {
      if (status !== "archived") throw new HttpError(400, "memory_engine_unsupported", "On this memory engine a memory is kept or forgotten.");
      const removed = await this.remove(userId, id, { keepText: true, actor: "user" });
      // The version the drawer's undo names: the document as it is now (a line forgotten), or the file as it was (a file gone).
      const forgotten = this.#fileRecord(file, [], []);
      return {
        ...forgotten, status: "archived", version: versionOfHash(removed.hash ?? file.hash),
        ...(line ? { id: String(id), value: line.raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(AS_OF, ""), document: { id: forgotten.id, uri: file.uri } } : {}),
      };
    }
    if (sensitive !== undefined) {
      if (typeof sensitive !== "boolean") throw new HttpError(400, "memory_sensitive_invalid", "sensitive must be a boolean.");
      await this.overlay.upsertFile({ userId, uri: file.uri, memoryType: file.type, sensitive });
    }
    if (value !== undefined) {
      const text = String(value).trim();
      if (!text) throw new HttpError(400, "memory_content_empty", "Structured memory value must not be empty.");
      if (identifierShapesIn(text).length) throw new HttpError(400, "memory_content_refused", "A memory cannot carry a credential or a personal identifier.");
      let next;
      if (line) {
        const raw = file.body.split("\n");
        const date = this.now().toISOString().slice(0, 10);
        raw[line.index] = `- ${text.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(AS_OF, "")} (as of ${date})`;
        next = raw.join("\n");
      } else {
        next = text;
      }
      await this.#write(userId, file, next, { actor: "user", reason: "edited on the memory page" });
    }
    return this.getRecord(userId, line ? `${nativeFileId(file.uri)}_${lineFingerprint(String(value ?? "").trim().replace(AS_OF, "")).slice(0, 12)}` : id)
      .catch(() => this.getRecord(userId, nativeFileId(file.uri)));
  }

  /**
   * Replace a file's text as `actor`, keep what it said before as a revision, and keep the rejection list in step: lines the
   * person removed are rejected (the engine writing them back verbatim removes them again), lines the person wrote are theirs.
   * @param {string} userId @param {any} file @param {string} next @param {{ actor: string, reason: string, change?: string }} how
   */
  async #write(userId, file, next, { actor, reason, change = "updated" }) {
    this.#touch(userId);
    await this.#engine(() => this.sessions.replace(userId, file.uri, next));
    const before = statements(file.body);
    const after = statements(next);
    const kept = new Set(after.map(lineFingerprint));
    if (actor === "user") {
      await this.overlay.reject(userId, file.type, file.uri, before.filter((text) => !kept.has(lineFingerprint(text))));
      await this.overlay.unreject(userId, file.type, after);
    }
    await this.overlay.addRevision({ userId, uri: file.uri, memoryType: file.type, change, actor, reason, before: file.body, after: next, projectId: file.projectId });
    await this.overlay.upsertFile({ userId, uri: file.uri, memoryType: file.type, body: next });
    await this.overlay.setSources(userId, file.uri, sourcesNamedIn(next));
    this.#touch(userId);
  }

  /**
   * Forget a memory: the file leaves the engine, every line of it goes on the rejection list, and the history keeps the text
   * only when the forget can be undone (`keepText`, the drawer's 「忘记」); a delete keeps none. A profile line is removed
   * from its document.
   * @param {string} userId @param {string} id @param {{ keepText?: boolean, actor?: string }} [options]
   * @returns {Promise<{ removed: boolean, uri: string, hash?: string }>} `hash`: the document's text now, when a line left it
   */
  async remove(userId, id, { keepText = false, actor = "user" } = {}) {
    const { file, line } = await this.#target(userId, id);
    if (line) {
      const raw = file.body.split("\n");
      raw.splice(line.index, 1);
      const next = raw.join("\n");
      await this.#write(userId, file, next, { actor, reason: keepText ? "forgotten on the memory page" : "deleted on the memory page" });
      // A delete takes the line out of the history too; a forget keeps it for the undo.
      if (!keepText) await this.overlay.scrubLines(userId, file.uri, await this.#wordingsOf(userId, file.uri, line.raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")));
      return { removed: true, uri: file.uri, hash: contentHash(next) };
    }
    return this.forgetFile(userId, file, { keepText, actor });
  }

  /**
   * A line and the wordings it had before the person's own edits made it what it is: an edit that took out exactly one line
   * and put exactly one in its place is one line changing, so deleting the line deletes its earlier wordings from the history
   * too. Nothing looser is guessed — whether two lines say the same thing is language.
   * @param {string} userId @param {string} uri @param {string} text
   */
  async #wordingsOf(userId, uri, text) {
    const wordings = [text];
    const prints = new Set([lineFingerprint(text)]);
    for (const revision of await this.overlay.revisionsOf(userId, uri, { limit: 200 })) {
      if (revision.actor !== "user" || revision.change !== "updated" || revision.before === null || revision.after === null) continue;
      const before = statements(revision.before);
      const after = statements(revision.after);
      const kept = new Set(after.map(lineFingerprint));
      const had = new Set(before.map(lineFingerprint));
      const removed = before.filter((candidate) => !kept.has(lineFingerprint(candidate)));
      const added = after.filter((candidate) => !had.has(lineFingerprint(candidate)));
      if (removed.length === 1 && added.length === 1 && prints.has(lineFingerprint(added[0]))) {
        wordings.push(removed[0]);
        prints.add(lineFingerprint(removed[0]));
      }
    }
    return wordings;
  }

  /** @param {string} userId @param {any} file @param {{ keepText?: boolean, actor?: string, reason?: string }} [options] */
  async forgetFile(userId, file, { keepText = false, actor = "user", reason = "" } = {}) {
    this.#touch(userId);
    const removed = await this.#engine(() => this.sessions.remove(userId, file.uri));
    await this.overlay.reject(userId, file.type, file.uri, statements(file.body));
    await this.overlay.addRevision({ userId, uri: file.uri, memoryType: file.type, change: "deleted", actor: /** @type {any} */ (actor),
      reason: reason || (keepText ? "forgotten on the memory page" : "deleted"), before: keepText ? file.body : null, after: null, projectId: file.projectId });
    if (!keepText) await this.overlay.forgetText(userId, file.uri);
    await this.overlay.removeFile(userId, file.uri);
    this.#touch(userId);
    return { removed, uri: file.uri };
  }

  /**
   * The conversation's `forget` tool, through the memory gateway (`memoryTool.forget`): the same forget as the page's, by URI,
   * with its undo — what the person asked a conversation to forget they can bring back from the page.
   * @param {any} user @param {any} _project @param {string} uri
   */
  async forget(user, _project, uri) {
    const files = await this.files(String(user.id));
    const file = files.find((candidate) => candidate.uri === uri);
    if (!file) return { removed: false };
    await this.forgetFile(String(user.id), file, { keepText: true, actor: "conversation", reason: "forgotten in a conversation" });
    return { removed: true };
  }

  /**
   * Undo the last change to a memory (`POST /api/memory/records/:id/undo`): an engine's addition is removed and its lines
   * rejected; an update goes back to what the file said before it (the lines it added rejected); a forget is restored.
   * The restored file of a forget is written as a new file: the engine's own fields (its type) are not restored with it,
   * and the engine's later extraction writes beside it rather than into it — what a restore can give back is the text.
   * @param {string} userId @param {string} id @param {{ expectedVersion?: number }} options
   */
  async undo(userId, id, { expectedVersion = 0 } = {}) {
    this.#touch(userId);
    if (!NATIVE_RECORD_ID.test(String(id))) throw new HttpError(404, "memory_not_found", "Memory not found.");
    const fileId = String(id).slice(0, 27);
    const files = await this.files(userId);
    const live = files.find((candidate) => nativeFileId(candidate.uri) === fileId) ?? null;
    if (live && expectedVersion > 0 && versionOfHash(live.hash) !== expectedVersion) {
      throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
    }
    const uri = live?.uri ?? (await this.#uriOfId(userId, fileId));
    if (!uri) throw new HttpError(404, "memory_not_found", "Memory not found.");
    const last = (await this.overlay.revisionsOf(userId, uri, { limit: 20 })).find((revision) => !revision.undoneAt);
    if (!last) throw new HttpError(409, "memory_conflict", "There is no change of this memory to undo.");
    const memoryType = last.memoryType;
    if (last.change === "deleted") {
      if (last.before === null) throw new HttpError(409, "memory_conflict", "A deleted memory keeps no text to restore.");
      await this.#restoreText(userId, { uri, text: String(last.before), memoryType, projectId: last.projectId, revisionId: last.id, reason: "undo", live: Boolean(live) });
      return { undone: "restored", record: await this.getRecord(userId, nativeFileId(uri)).catch(() => null), restored: [] };
    }
    if (!live) throw new HttpError(404, "memory_not_found", "Memory not found.");
    if (last.change === "added" || last.change === "restored" || last.before === null) {
      await this.forgetFile(userId, live, { keepText: false, actor: "user", reason: "undo" });
      await this.overlay.markUndone(userId, last.id);
      return { undone: "removed", record: null, restored: [] };
    }
    // An update: back to what it said, the lines the change brought rejected and the lines it took away the person's again.
    const before = String(last.before);
    const had = new Set(statements(before).map(lineFingerprint));
    await this.overlay.reject(userId, memoryType, uri, statements(live.body).filter((text) => !had.has(lineFingerprint(text))));
    await this.overlay.unreject(userId, memoryType, statements(before));
    await this.#engine(() => this.sessions.replace(userId, uri, before));
    await this.overlay.addRevision({ userId, uri, memoryType, change: "updated", actor: "user", reason: "undo", before: live.body, after: before, projectId: live.projectId });
    await this.overlay.upsertFile({ userId, uri, memoryType, body: before });
    await this.overlay.markUndone(userId, last.id);
    return { undone: "restored", record: await this.getRecord(userId, nativeFileId(uri)).catch(() => null), restored: [] };
  }

  /**
   * Put a forgotten file's text back as a file, and take the forget off the list of what can be undone. `replace` first, in both
   * cases. A file the engine has written again at this address since the person forgot it is overwritten by the restore: `create`
   * only refused that on v0.5.0 (409) and is a plain alias of `replace` from v0.5.1, so the guard cannot be relied on, and the
   * person asked for this text back (the race is accepted, not prevented). A forgotten file is gone, and v0.5.0's answer to `replace`
   * on a missing file is not recorded for these paths: a 404 is answered with `create`, which v0.5.0 does take. That fallback is dead
   * from v0.5.1.1 and goes with the pin. What a restore can give back is the text: the engine's own fields (its type) are not restored
   * with it, and its later extraction writes beside the file rather than into it.
   * @param {string} userId
   * @param {{ uri: string, text: string, memoryType: string, projectId?: string | null, revisionId: string, reason: string, live?: boolean }} restore
   */
  async #restoreText(userId, { uri, text, memoryType, projectId = null, revisionId, reason, live = false }) {
    if (live) await this.#engine(() => this.sessions.replace(userId, uri, text));
    else await this.#engine(async () => {
      const write = (/** @type {"replace" | "create"} */ mode) => this.sessions.client.request({ method: "POST", path: "/api/v1/content/write", userId, timeoutMs: 20_000,
        body: { uri, content: text, mode, wait: true } });
      try { await write("replace"); } catch (error) {
        if (/** @type {any} */ (error)?.code !== "memory_index_not_found") throw error;
        await write("create");
      }
    });
    await this.overlay.unreject(userId, memoryType, statements(text));
    await this.overlay.upsertFile({ userId, uri, memoryType, body: text, projectId: projectId ?? undefined });
    if (projectId) await this.#engine(() => this.sessions.setTags(userId, uri, [`project=${projectId}`])).catch(() => {});
    await this.overlay.addRevision({ userId, uri, memoryType, change: "restored", actor: "user", reason, before: null, after: text, projectId });
    await this.overlay.markUndone(userId, revisionId);
  }

  /**
   * What the person forgot and can bring back, as the records the page's 「已忘记的内容」 lists (`status: "archived"`): the files
   * whose forget kept their text, and the lines a profile edit took out for the same reason, newest first. The overlay's revisions
   * are the only record of them — the engine no longer holds the file — and a forget that was undone, a hard delete (no text kept),
   * and what the platform's own checks removed are not here. A file that is live again at the same address, and a line the document
   * says again, are not forgotten any more.
   * @param {string} userId @param {{ files?: any[] }} [options]
   * @returns {Promise<any[]>}
   */
  async forgotten(userId, { files = undefined } = {}) {
    const live = new Map((files ?? await this.files(userId)).map((file) => [file.uri, file]));
    const root = this.sessions.memoryRoot(userId);
    /** @type {Map<string, any>} */
    const found = new Map();
    for (const revision of await this.overlay.forgottenRevisions(userId)) {
      const place = nativeMemoryFile(revision.uri, root);
      if (!place) continue;
      const base = { revision, place, scope: PROJECT_MEMORY_TYPES.includes(place.type) && revision.projectId ? "project" : "user", scopeId: PROJECT_MEMORY_TYPES.includes(place.type) ? revision.projectId ?? "" : "" };
      const kind = /** @type {Record<string, string>} */ (LEGACY_KIND_OF_TYPE)[place.type] ?? "project_fact";
      const record = (/** @type {Record<string, any>} */ over) => ({
        scope: base.scope, scopeId: base.scopeId, kind, origin: "explicit", status: "archived", confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 0,
        createdAt: revision.changedAt, updatedAt: revision.changedAt, lastConfirmedAt: revision.changedAt, expiresAt: null, supersededBy: null, invalidSince: null, validFrom: null,
        evidence: [], revisions: [], engine: "native", nativeType: place.type, uri: revision.uri, forgottenRevision: revision.id, ...over,
      });
      if (revision.change === "deleted") {
        if (live.has(revision.uri)) continue;
        const id = nativeFileId(revision.uri);
        if (!found.has(id)) {
          const text = String(revision.before ?? "");
          found.set(id, record({ id, key: place.relPath, value: text, summary: titleOf(place.type, place.relPath, text), version: versionOfHash(contentHash(text)), contentHash: contentHash(text) }));
        }
        continue;
      }
      // A profile edit that forgot lines: the lines the revision took out, each a record of its own as it was while it lived.
      const after = new Set(statements(String(revision.after ?? "")).map(lineFingerprint));
      const present = new Set(statements(live.get(revision.uri)?.body ?? "").map(lineFingerprint));
      for (const raw of String(revision.before ?? "").split("\n")) {
        const text = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
        if (!text || isLabelLine(raw) || /^#{1,6}\s/.test(raw.trim())) continue;
        const print = lineFingerprint(text);
        if (after.has(print) || present.has(print)) continue;
        const id = `${nativeFileId(revision.uri)}_${print.slice(0, 12)}`;
        if (found.has(id)) continue;
        found.set(id, record({ id, key: `profile.md#${print.slice(0, 12)}`, value: text.replace(AS_OF, "").trim(), summary: "", raw: raw.trim(), version: versionOfHash(contentHash(text)),
          contentHash: contentHash(text), document: { id: nativeFileId(revision.uri), uri: revision.uri } }));
      }
    }
    return [...found.values()].slice(0, 100).map(({ raw: _raw, ...entry }) => entry);
  }

  /**
   * Bring one forgotten memory back: the file written again from the text its forget kept, or the profile line added to the profile
   * document again, and the forget taken off the list. The version the page sends is the forgotten memory's own, so a list the page
   * read before something else changed it is a 409 and never a guess.
   * @param {string} userId @param {string} id @param {number} expectedVersion
   */
  async #restoreForgotten(userId, id, expectedVersion) {
    const files = await this.files(userId);
    const entry = (await this.forgotten(userId, { files })).find((candidate) => candidate.id === id);
    if (!entry) throw new HttpError(404, "memory_not_found", "Memory not found.");
    if (entry.version !== expectedVersion) throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
    this.#touch(userId);
    const revisions = await this.overlay.revisionsOf(userId, entry.uri, { limit: 200 });
    const revision = revisions.find((candidate) => candidate.id === entry.forgottenRevision && !candidate.undoneAt);
    if (!revision) throw new HttpError(404, "memory_not_found", "Memory not found.");
    const memoryType = entry.nativeType;
    const projectId = revision.projectId ?? null;
    if (!entry.document) {
      // A file: written again from the text its forget kept.
      await this.#restoreText(userId, { uri: entry.uri, text: String(revision.before), memoryType, projectId, revisionId: revision.id, reason: "restored from forgotten" });
      return this.getRecord(userId, nativeFileId(entry.uri));
    }
    // A line: the line as the document had it, after the document's own lines.
    const raw = String(revision.before ?? "").split("\n").find((line) => lineFingerprint(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")) === lineFingerprint(entry.value));
    const line = (raw ?? `- ${entry.value}`).trim();
    const document = files.find((file) => file.uri === entry.uri);
    if (document) {
      const body = document.body.replace(/\s+$/, "");
      await this.#write(userId, document, `${body}\n${line}`, { actor: "user", reason: "restored from forgotten" });
      await this.overlay.markUndone(userId, revision.id);
    } else {
      // The document itself was forgotten since: it comes back with its headings and this one line.
      const headings = String(revision.before ?? "").split("\n").filter((text) => /^#{1,6}\s/.test(text.trim()));
      await this.#restoreText(userId, { uri: entry.uri, text: [...headings, line].join("\n"), memoryType, projectId, revisionId: revision.id, reason: "restored from forgotten" });
    }
    return this.getRecord(userId, id).catch(() => this.getRecord(userId, nativeFileId(entry.uri)));
  }

  /** @param {string} userId @param {string} fileId */
  async #uriOfId(userId, fileId) {
    for (const uri of (await this.overlay.files(userId)).keys()) if (nativeFileId(uri) === fileId) return uri;
    for (const revision of await this.overlay.recentRevisions(userId, { actors: ["engine", "user", "conversation", "platform"], limit: 100 })) {
      if (nativeFileId(revision.uri) === fileId) return revision.uri;
    }
    return null;
  }

  /**
   * 「记住这一条」 from the page: the person's words go to the engine the way a conversation's do — one session, one message,
   * a commit — so what is written has its type, its tags and its place among the memories the engine keeps updating. It
   * appears when the engine has written it (about twelve seconds); until then the page shows it as pending.
   * @param {string} userId @param {{ text: string, projectId?: string | null }} input
   */
  async remember(userId, { text, projectId = null }) {
    this.#assertConfigured();
    this.#touch(userId);
    const words = String(text ?? "").trim();
    if (!words || words.length > 2_000) throw new HttpError(400, "memory_payload_invalid", "What to remember must be 1 to 2000 characters.");
    if (identifierShapesIn(words).length) throw new HttpError(400, "memory_content_refused", "A memory cannot carry a credential or a personal identifier.");
    const session = `evimed-page-${randomUUID().replace(/-/g, "")}`;
    await this.#engine(async () => {
      await this.sessions.register(userId).catch(() => false);
      await this.sessions.createSession(userId, session, { timeoutMs: this.sessions.timeoutMs });
      await this.sessions.addMessage(userId, session, { role: "user", parts: [{ type: "text", text: `请记住：${maskIdentifiers(words)}` }] });
    });
    const answer = await this.#engine(() => this.sessions.commit(userId, session));
    const result = answer?.result ?? {};
    if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw new HttpError(503, "memory_engine_unavailable", "The memory service did not accept it.");
    const commit = await this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: session, projectId, origin: "page",
      taskId: typeof result.task_id === "string" ? result.task_id : null, pendingText: words });
    return { pending: { id: commit.archiveUri, text: words, at: commit.createdAt, state: "pending" } };
  }

  /**
   * The person's switch, as the engine's own policy: learning paused means the engine extracts nothing from what reaches
   * it (the gateway also stops forwarding). Always with the whole type allowlist (`OpenVikingSessions.setLearning`).
   * @param {string} userId @param {boolean} learning
   */
  async setLearning(userId, learning) {
    this.#assertConfigured();
    return this.#engine(() => this.sessions.setLearning(userId, learning));
  }

  // ------------------------------------------------------------ whole account

  /**
   * 「重置记忆」: every memory file and every session of the account in the engine, and everything the overlay holds of
   * them. The account stays registered; the derived index of PostgreSQL's records and the capsule facts beside the memories
   * are not native memory and are left to their own reset.
   * @param {string} userId
   */
  async reset(userId) {
    this.#assertConfigured();
    this.#touch(userId);
    const root = this.sessions.memoryRoot(userId);
    let files = 0;
    await this.#engine(async () => {
      for (const [type, segment] of Object.entries(MEMORY_SEGMENT_OF_TYPE)) {
        if (await this.sessions.remove(userId, `${root}/${segment}`, { recursive: type !== "profile" })) files += 1;
      }
    });
    const sessions = await this.#deleteSessions(userId);
    const purged = await this.overlay.purgeUser(userId);
    return { files, sessions, revisions: purged.revisions };
  }

  /** Every engine session of the account, deleted. @param {string} userId @param {(name: string) => boolean} [which] */
  async #deleteSessions(userId, which = () => true) {
    const root = `${this.sessions.userRoot(userId)}/sessions`;
    const listed = await this.#engine(() => this.sessions.tree(userId, root, { levelLimit: 1 }));
    let deleted = 0;
    for (const node of listed.filter((entry) => entry.isDir)) {
      const name = node.uri.slice(root.length + 1);
      if (!name || name.includes("/") || !which(name)) continue;
      if (await this.#engine(() => this.sessions.deleteSession(userId, name)).catch(() => false)) deleted += 1;
    }
    return deleted;
  }

  /**
   * A project was deleted: the memories tagged with it, and the sessions of its conversations. What is not tagged (the
   * profile, preferences, corrections) is the account's and stays.
   * @param {string} userId @param {string} projectId
   */
  async deleteProject(userId, projectId) {
    this.#assertConfigured();
    this.#touch(userId);
    const root = this.sessions.memoryRoot(userId);
    const tagged = await this.#engine(() => this.sessions.tree(userId, root, { levelLimit: 8, tags: [`project=${projectId}`] }));
    const fromOverlay = await this.overlay.projectFiles(userId, projectId);
    const uris = new Set([...tagged.filter((node) => !node.isDir).map((node) => node.uri), ...fromOverlay.map((file) => file.uri)]);
    let files = 0;
    for (const uri of uris) if (await this.#engine(() => this.sessions.remove(userId, uri))) files += 1;
    const engineSessions = new Set(await this.overlay.projectSessions(userId, projectId));
    const sessions = await this.#deleteSessions(userId, (name) => engineSessions.has(name));
    await this.overlay.purgeProject(userId, projectId);
    return { files, sessions };
  }

  /**
   * The account is being deleted: everything the engine holds of it (sessions, memories, vectors, usage rows), and the
   * overlay's record of its registration. Done when a request as the account stops answering 412.
   * @param {string} userId
   */
  async eraseAccount(userId) {
    this.#assertConfigured();
    this.#touch(userId);
    const erased = await this.#engine(() => this.sessions.eraseUser(userId));
    await this.overlay.purgeUser(userId).catch(() => null);
    await this.overlay.forgetAccount(userId).catch(() => null);
    return erased;
  }

  /** The account's memories as the engine's own pack, for the account export. @param {string} userId */
  async exportPack(userId) {
    this.#assertConfigured();
    return this.#engine(() => this.sessions.exportPack(userId));
  }
}
