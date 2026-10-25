import { createHash, randomUUID } from "node:crypto";
import { identifierShapesIn, maskIdentifiers } from "@evimed/domain";
import { actOf, duplicatesOf, withoutJudged } from "./nativeMemoryForgetEverywhere.mjs";
import { recordForgetDuplicates } from "./nativeMemoryMetrics.mjs";
import { contentHash, lineFingerprint, memoryLines } from "./nativeMemoryOverlay.mjs";
import { MEMORY_SEGMENT_OF_TYPE, OBSERVATIONS_SEGMENT, PROJECT_MEMORY_TYPES, nativeMemoryFile, parseArchiveUri, platformSessionOf, unfinishedArchives } from "./openVikingSessions.mjs";
import { HttpError } from "./security.mjs";

/**
 * The memory page, the memory map and the account's own operations over an account's memory: OpenViking's native engine
 * (2026-10-13), which is the only place an account's memory lives since the legacy engine was deleted (2026-10-25).
 *
 * The engine holds the memories as files its own extraction writes; this module reads them, presents them in the record shape
 * the page reads (the shape the platform's own PostgreSQL records had, so the page changed little when it moved), and carries out
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
 * What the legacy records had and this does not (owner-accepted, README §5.4 of the course correction): no line of the
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

/** The kind the page labels a native type by (`memoryKinds.mjs`); `nativeType` carries the engine's own. A file's type is where it lives
 *  (`nativeMemoryFile`): the corrections template writes under `preferences/corrections/`, and that is `corrections` here. */
export const PAGE_KIND_OF_TYPE = Object.freeze({
  profile: "profile",
  preferences: "preference",
  corrections: "correction",
  decisions: "decision",
  follow_ups: "follow_up",
  recent_work: "project_fact",
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

/** What the control plane says to the engine for a choice two conversations made: the person's explicit request to keep it as a preference about how
 * work is done (`keepRepeatedChoice`; the write-quality replay says it the same way). Named a preference because, said only as a choice to keep, the
 * engine wrote it into the profile in two of three lab samples (c22, 2026-10-25). @param {string} choice */
export const repeatedChoiceMessage = (choice) => `请记住我做事的一个偏好（我在两次不同的对话里都这样选，以后默认这样做）：${choice}`;

/** The id that ties together the revisions of one forget (`actOf` reads it back from a reason). */
const newAct = () => randomUUID().replace(/-/g, "").slice(0, 12);
/** The marker for a reason, or nothing when there is no act. @param {string | null} act */
const actSuffix = (act) => (act ? ` [act:${act}]` : "");

/** The most tasks the project card says were worked on last (`recent_work`). */
export const RECENT_WORK_LINES = 3;

/**
 * The card's 「最近在做」 row from a project's `recent_work` records: the newest file's lines first, three at most in all, each
 * a few words (the template writes no content of the work, and this cuts what is longer), joined into one sentence. Null when there are none.
 * @param {readonly any[]} records the project's `recent_work` records @returns {{ slot: string, recordId: string, text: string, updatedAt: string | null } | null}
 */
export function recentWorkRow(records) {
  const newestFirst = [...records].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  /** @type {string[]} */
  const lines = [];
  for (const record of newestFirst) {
    for (const line of statements(record.value)) {
      const text = line.replace(AS_OF, "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (text && !lines.includes(text)) lines.push(text);
      if (lines.length >= RECENT_WORK_LINES) break;
    }
    if (lines.length >= RECENT_WORK_LINES) break;
  }
  return lines.length ? { slot: "recent_work", recordId: newestFirst[0].id, text: lines.join("；"), updatedAt: newestFirst[0].updatedAt ?? null } : null;
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
 * the archive of the commit; the ledger names the project. A session the platform did not derive (a replay, the
 * page's own 「记住这一条」) is no conversation and is left out. There is no quotation: the engine keeps none, and none is made up.
 *
 * For one line of the profile (`line`), only the commit that brought that line counts, found by what the revision's text did to it
 * — so a conversation that merely touched the file is not named as the source of every line in it, and a line already there when
 * the oldest revision the overlay still holds was written names nothing rather than a guess.
 * @param {any[]} history a file's revisions, oldest first @param {Map<string, string>} sessionProjects by engine session
 * @param {{ line?: string | null }} [options]
 */
/** The sessions the platform itself opens to write a memory, and what the drawer says of what they wrote: 「从其他 AI 导入」 and 「你在两次对话里都这样做」. */
export const PLATFORM_SESSION_SOURCES = Object.freeze([
  { prefix: "evimed-import-", sourceType: "import", label: "从其他 AI 导入" },
  { prefix: "evimed-promote-", sourceType: "repetition", label: "你在两次对话里都这样做" },
]);

/**
 * One piece of evidence for a write by an engine session: the conversation (`conversationEvidence`'s item) when the plugin derived the
 * session from one, a labelled source when the platform opened it for an import or a promotion, nothing for any other session.
 * @param {{ engineSession?: string | null, archiveUri?: string | null, observedAt?: string | null, fingerprint: string, projectId?: string | null }} write
 * @param {string | null} projectId
 */
function sessionEvidence({ engineSession, archiveUri, observedAt, fingerprint }, projectId) {
  const session = String(engineSession ?? "");
  const conversationId = platformSessionOf(session);
  if (conversationId) {
    return {
      sourceType: "conversation", sourceRef: `sessions/${conversationId}/commits/${String(archiveUri ?? "").split("/").at(-1) || "archive"}`,
      quote: "", observedAt: observedAt ?? null, weight: 1, fingerprint, conversationId, ...(projectId ? { projectId } : {}),
    };
  }
  const platform = PLATFORM_SESSION_SOURCES.find((entry) => session.startsWith(entry.prefix));
  if (!platform) return null;
  return { sourceType: platform.sourceType, sourceRef: `${platform.sourceType === "import" ? "imports" : "repetitions"}/${session}`, quote: "", observedAt: observedAt ?? null, weight: 1, fingerprint, label: platform.label };
}

function conversationEvidence(history, sessionProjects, { line = null } = {}) {
  const print = line === null ? null : lineFingerprint(line);
  const printsOf = (/** @type {unknown} */ text) => new Set(memoryLines(text ?? "").map(lineFingerprint));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const evidence = [];
  for (const revision of history) {
    if (revision.actor !== "engine" || (revision.change !== "added" && revision.change !== "updated") || !revision.engineSession) continue;
    const projectId = sessionProjects.get(revision.engineSession) ?? revision.projectId ?? null;
    const item = sessionEvidence({ engineSession: revision.engineSession, archiveUri: revision.archiveUri, observedAt: revision.changedAt, fingerprint: `revision:${revision.id}` }, projectId);
    if (!item) continue;
    const key = /** @type {any} */ (item).conversationId ?? revision.engineSession;
    if (seen.has(key)) continue;
    if (print !== null && !(printsOf(revision.after).has(print) && !printsOf(revision.before).has(print))) continue;
    seen.add(key);
    evidence.push(item);
    if (evidence.length >= 8) break;
  }
  return evidence;
}
const BODY_ACCOUNTS = 100;

/**
 * The rows of a project's card (`{ slot, label?, recordId, text, updatedAt }`), read off the sections of the project's own project-context
 * files, whose headings are the card's words (the template writes them), then the project's last three tasks (`recent_work`).
 *
 * The labels the template has the engine write are Chinese in a Chinese conversation and these English ones in an English one
 * (`project_context.yaml`). A section whose heading is none of them — a card written in another language, or under a heading of the
 * model's own ("交付约定") — is a row of its own named by that heading, never dropped: it is what the person said about the project, and
 * the next conversation of the project is handed it as it is handed the rest.
 * `sections`: also the sections whose heading the closed list does not know, each as a row named by its heading (what a conversation of the
 * project is handed, `residentCard`); the memory page's 项目 tab keeps the card to the six slots and the clinical elements, as it always read it.
 * @param {readonly any[]} everything the account's records @param {string} projectId @param {{ sections?: boolean }} [options]
 * @returns {{ slot: string, label?: string, recordId: string, text: string, updatedAt: string | null }[]}
 */
export function projectCardRows(everything, projectId, { sections = false } = {}) {
  const records = everything.filter((record) => record.nativeType === "project_context" && record.scopeId === projectId);
  const SLOT_OF_HEADING = { "目标": "goal", "范围或对象": "subject", "材料与数据": "data_source", "阶段": "stage", "约束": "constraints",
    "goal": "goal", "scope": "subject", "materials and data": "data_source", "stage": "stage", "constraints": "constraints" };
  const SLOT_OF_ELEMENT = { "人群": "population", "干预或暴露": "intervention", "对照": "comparator", "结局": "outcome", "设计": "design",
    "population": "population", "intervention or exposure": "intervention", "comparator": "comparator", "outcome": "outcome", "design": "design" };
  const ELEMENTS = new Set(["研究要素", "study elements"]);
  /** @type {Map<string, { slot: string, label?: string, recordId: string, text: string, updatedAt: string | null }>} */
  const card = new Map();
  /** The sections the closed list does not know, by their own heading. @type {Map<string, { slot: string, label: string, recordId: string, text: string, updatedAt: string | null }>} */
  const others = new Map();
  for (const record of records) {
    let section = "";
    let sectionLabel = "";
    for (const line of String(record.value).split("\n")) {
      const trimmed = line.trim();
      const heading = /^##\s+(.+)$/.exec(trimmed);
      if (heading) { sectionLabel = heading[1].replace(/[（(].*$/, "").trim(); section = sectionLabel.toLowerCase(); continue; }
      const field = /^(?:领域|field)[：:]\s*(.+)$/i.exec(trimmed);
      if (field && !card.has("field")) { card.set("field", { slot: "field", recordId: record.id, text: field[1].trim(), updatedAt: record.updatedAt }); continue; }
      if (!/^[-*+]\s+\S/.test(trimmed)) continue;
      const item = trimmed.replace(/^[-*+]\s+/, "");
      const element = /^([^：:]{1,24})[：:]\s*(.+)$/.exec(item);
      const inElements = ELEMENTS.has(section) && element;
      const slot = inElements ? /** @type {Record<string, string>} */ (SLOT_OF_ELEMENT)[element[1].trim().toLowerCase()] : /** @type {Record<string, string>} */ (SLOT_OF_HEADING)[section];
      if (!slot) {
        if (sections && section && !ELEMENTS.has(section) && sectionLabel) {
          const held = others.get(sectionLabel);
          others.set(sectionLabel, held && held.recordId === record.id ? { ...held, text: `${held.text}；${item}`.slice(0, 600) }
            : held ?? { slot: "other", label: sectionLabel.slice(0, 24), recordId: record.id, text: item.slice(0, 600), updatedAt: record.updatedAt });
        }
        continue;
      }
      const value = inElements ? element[2].trim() : item;
      const held = card.get(slot);
      card.set(slot, held && held.recordId === record.id ? { ...held, text: `${held.text}；${value}`.slice(0, 600) } : held ?? { slot, recordId: record.id, text: value.slice(0, 600), updatedAt: record.updatedAt });
    }
  }
  const order = ["field", "goal", "subject", "data_source", "stage", "constraints", "population", "intervention", "comparator", "outcome", "design"];
  const rows = [...order.filter((slot) => card.has(slot)).map((slot) => /** @type {any} */ (card.get(slot))), ...[...others.values()].slice(0, 8)];
  // What the project was last worked on (`recent_work`), after the card's own rows: its own files, never the card's.
  const recent = recentWorkRow(everything.filter((record) => record.nativeType === "recent_work" && record.scopeId === projectId));
  return recent ? [...rows, recent] : rows;
}

/** The project's other standing files a conversation of it is handed (`residentCard`): the types, and the lines of each that one row carries. */
const PROJECT_EXTRA_TYPES = Object.freeze(["decisions", "project_facts", "follow_ups"]);
const PROJECT_EXTRA_LINES = 6;
const PROJECT_EXTRA_LINE_CHARS = 160;

/**
 * One row for each of the project's decisions, working facts and open items: the lines of its files, the most recently changed file first,
 * each cut short, six at most to a row. A project with none has no row.
 * @param {readonly any[]} everything @param {string} projectId
 * @returns {{ slot: string, recordId: string, text: string, updatedAt: string | null }[]}
 */
export function projectExtraRows(everything, projectId) {
  /** @type {{ slot: string, recordId: string, text: string, updatedAt: string | null }[]} */
  const rows = [];
  for (const type of PROJECT_EXTRA_TYPES) {
    const files = everything.filter((record) => record.nativeType === type && record.scopeId === projectId)
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    /** @type {string[]} */
    const lines = [];
    for (const record of files) {
      for (const line of statements(record.value)) {
        const text = line.replace(AS_OF, "").replace(/\s+/g, " ").trim().slice(0, PROJECT_EXTRA_LINE_CHARS);
        if (text && !lines.includes(text)) lines.push(text);
        if (lines.length >= PROJECT_EXTRA_LINES) break;
      }
      if (lines.length >= PROJECT_EXTRA_LINES) break;
    }
    if (lines.length) rows.push({ slot: type, recordId: files[0].id, text: lines.join("；"), updatedAt: files[0].updatedAt ?? null });
  }
  return rows;
}

export class NativeMemoryStore {
  /** @type {Map<string, { epoch: number, promise: Promise<any[]> }>} */
  #reading = new Map();
  /** @type {Map<string, Map<string, { modTime: string, size: number, body: string }>>} */
  #bodies = new Map();
  /** @type {Map<string, number>} what each account's writes have counted: a read begun before a write is not shared after it */
  #epochs = new Map();

  /**
   * @param {{ sessions: import("./openVikingSessions.mjs").OpenVikingSessions, overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
   *   now?: () => Date, conversationTitles?: ConversationTitles | null,
   *   rejectionJudge?: { same: (request: any) => Promise<{ same: Map<number, string>, stated: Set<number> }> } | null,
   *   report?: (line: string) => void }} dependencies
   *   `conversationTitles` names the conversations a memory came out of (the run ledger knows them; this store does not). `rejectionJudge` is the
   *   rejection list's own judge (`nativeMemoryRejections.mjs`), asked which other lines say what a forgotten one said
   *   (`nativeMemoryForgetEverywhere.mjs`); absent, only the lines that contain a forgotten line's words go with it.
   */
  constructor({ sessions, overlay, now = () => new Date(), conversationTitles = null, rejectionJudge = null, report = () => {} }) {
    this.sessions = sessions;
    this.overlay = overlay;
    this.now = now;
    this.conversationTitles = conversationTitles;
    this.rejectionJudge = rejectionJudge;
    this.report = report;
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
        lastRecalledAt: held?.lastRecalledAt ?? null, recallCount: held?.recallCount ?? 0,
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
    // The first commit that brought each line of the profile, kept beyond the revisions a file holds: an old line still names its source.
    const origins = await Promise.resolve().then(() => this.overlay.originsOf(userId, held.filter((file) => file.type === "profile").map((file) => file.uri))).catch(() => new Map());
    // The conversations the engine wrote these files in: its revisions name the engine session, the ledger names the project.
    const sessionProjects = await this.#sessionProjects(userId, revisions);
    const originProjects = await Promise.resolve().then(() => this.overlay.sessionProjects(userId, [...new Set([...origins.values()].flatMap((lines) => [...lines.values()].map((origin) => origin.engineSession).filter((name) => typeof name === "string" && platformSessionOf(name))))].map(String))).catch(() => new Map());
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
        // A line's own conversation is the one whose commit brought it, not every conversation that touched the file: from the index of
        // origins when it has the line, else from the revisions the overlay still holds (a line already there when the oldest of them was
        // written, and unknown to the index, names nothing rather than a guess).
        const origin = origins.get(file.uri)?.get(lineFingerprint(line)) ?? null;
        const fromIndex = origin ? sessionEvidence({ engineSession: origin.engineSession, archiveUri: origin.archiveUri, observedAt: origin.addedAt, fingerprint: origin.revisionId ? `revision:${origin.revisionId}` : `origin:${lineFingerprint(line).slice(0, 12)}` },
          (origin.engineSession ? originProjects.get(origin.engineSession) : null) ?? origin.projectId ?? null) : null;
        const evidence = fromIndex ? [fromIndex] : conversationEvidence(history, sessionProjects, { line });
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
      kind: /** @type {Record<string, string>} */ (PAGE_KIND_OF_TYPE)[file.type] ?? "project_fact",
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
      nativeType: file.type,
      uri: file.uri,
      contentHash: file.hash,
      // When a search or read through the gateway last returned the file and how often: recorded for a later decision, acted on by nothing.
      lastRecalledAt: file.lastRecalledAt ?? null,
      recallCount: file.recallCount ?? 0,
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
   * The memory page's list (`GET /api/memory/profile`), plus `pending`: what the person asked the page to remember that the engine
   * has not written yet.
   * @param {string} userId @param {{ holder?: { id: string, name: string } }} [options]
   */
  async profile(userId, { holder = undefined } = {}) {
    const files = await this.files(userId);
    const { titles, records: active } = await this.#withConversationTitles(userId, await this.records(userId, { files }));
    // What the person forgot rides in the same list as `status: "archived"`: the page's 「已忘记的内容」 reads it from there, and
    // every other reader leaves an archived memory out.
    const records = [...active, ...await this.forgotten(userId, { files }).catch(() => [])];
    /** @type {Record<string, any[]>} */
    const groups = {};
    for (const kind of new Set(Object.values(PAGE_KIND_OF_TYPE))) groups[kind] = [];
    for (const record of records) (groups[record.kind] ??= []).push(record);
    return {
      ...(holder ? { holder } : {}), records, groups, activeCount: active.length, pendingCount: 0, episodeCount: 0,
      conversations: titles, usage: {}, pending: await this.pending(userId),
    };
  }

  /** What the page asked the engine to remember and it has not written yet. @param {string} userId */
  async pending(userId) {
    return (await this.overlay.pendingCommits(userId, { origins: ["page"] })).map((commit) => ({
      id: commit.archiveUri, text: commit.pendingText ?? "", at: commit.createdAt, state: commit.state === "failed" ? "retrying" : "pending",
    }));
  }

  /**
   * The page's list read with filters (`GET /api/memory/records`): scopes, kinds and a project.
   * @param {string} userId @param {{ scopes?: string[], statuses?: string[], kinds?: string[], scopeId?: string, query?: string, pageSize?: number }} filters
   */
  async listRecords(userId, { scopes = [], statuses = [], kinds = [], scopeId = "", query = "", pageSize = 100 } = {}) {
    const words = String(query ?? "").trim().toLowerCase();
    return (await this.records(userId))
      .filter((record) => !statuses.length || statuses.includes(record.status))
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
   * The project tab's card (`GET /api/memory/projects/:id/overview` → `card`), as `{ slot, recordId, text, updatedAt }[]`: read off
   * the sections of the project's own project-context file, whose headings are the card's words (the template writes them).
   * @param {string} userId @param {string} projectId
   */
  async projectCard(userId, projectId) {
    return projectCardRows(await this.records(userId), projectId);
  }

  /**
   * What a conversation of the project is handed up front: the card's rows as the page shows them (and its other sections, each under its own
   * heading: 已定事项 among them), then what the project's other standing files say — its decisions, its working facts and what is still open — in rows of their own (`projectExtraRows`). A rule the person
   * stated for the project (its language, its format, its house style, a date they set) is a line of the card when the engine files it
   * there and a line of one of those files when it does not, and the plugin's own start-of-session listing names neither (it lists
   * `profile.md`, `preferences/` and `entities/`): without these rows it would reach a new conversation only if the model went looking.
   * The memory page's 项目 tab lists those files itself and keeps reading `projectCard`.
   * @param {string} userId @param {string} projectId
   */
  async residentCard(userId, projectId) {
    const everything = await this.records(userId);
    return [...projectCardRows(everything, projectId, { sections: true }), ...projectExtraRows(everything, projectId)];
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

  /**
   * The memory files that name a source, as rows the impact panel and the knowledge-change labelling read: the file's id, its scope
   * (a project's file or the account's), the kind the page files it under and the state of the link. Found by the recorded link and
   * nothing else (`overlay.filesNaming`).
   * @param {string} userId @param {{ type: string, id: string }} source
   * @returns {Promise<{ recordId: string, scope: string, scopeId: string, kind: string, status: string, state: string }[]>}
   */
  async dependentsOfSource(userId, source) {
    this.#assertConfigured();
    const rows = [];
    for (const link of await this.overlay.filesNaming(source, { userId })) {
      const file = await this.overlay.file(userId, link.uri);
      if (!file) continue;
      rows.push({
        recordId: nativeFileId(link.uri), scope: file.projectId ? "project" : "user", scopeId: file.projectId ?? "",
        kind: /** @type {Record<string, string>} */ (PAGE_KIND_OF_TYPE)[file.memoryType] ?? "project_fact", status: "active",
        state: link.state === "removed" ? "expired" : link.state,
      });
    }
    return rows;
  }

  /**
   * The memories of a list of ids, as the page's records: what a document's 「相关记忆」 panel says of each one it names. An id that is not
   * a memory of this account is left out.
   * @param {string} userId @param {readonly string[]} ids
   */
  async recordSummaries(userId, ids) {
    this.#assertConfigured();
    const wanted = new Set(ids.map(String));
    return (await this.records(userId)).filter((record) => wanted.has(record.id));
  }

  /** The sources one memory names, with the state each is in (`GET /api/memory/records/:id/sources`). @param {string} userId @param {string} id */
  async sourceLinks(userId, id) {
    const { file } = await this.#target(userId, id);
    return (await this.overlay.sources(userId, [file.uri])).map((source) => ({ type: source.type, id: source.id, state: source.state === "removed" ? "expired" : source.state }));
  }

  /**
   * What changed by itself since a moment (「刚记住了」): each item carries the version its
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
        kind: /** @type {Record<string, string>} */ (PAGE_KIND_OF_TYPE)[revision.memoryType] ?? "project_fact",
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
    // A line the person took out leaves the index of origins with it; one they wrote names no conversation.
    await this.overlay.syncOrigins(userId, file.uri, { after: next });
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
    // What else says the same is found first, so that the act the revisions share is named in the first of them.
    const plan = await this.#duplicatesPlan(userId, line ? [line.raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")] : statements(file.body));
    const act = plan.size ? newAct() : null;
    if (line) {
      const raw = file.body.split("\n");
      raw.splice(line.index, 1);
      const next = raw.join("\n");
      await this.#write(userId, file, next, { actor, reason: `${keepText ? "forgotten on the memory page" : "deleted on the memory page"}${actSuffix(act)}` });
      // A delete takes the line out of the history too; a forget keeps it for the undo.
      if (!keepText) await this.overlay.scrubLines(userId, file.uri, await this.#wordingsOf(userId, file.uri, line.raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")));
      const also = await this.#forgetDuplicates(userId, keepText ? plan : withoutJudged(plan), { act, keepText, actor });
      return { removed: true, uri: file.uri, hash: contentHash(next), ...(also ? { alsoForgot: also } : {}) };
    }
    const forgotten = await this.forgetFile(userId, file, { keepText, actor, reason: act ? `${keepText ? "forgotten on the memory page" : "deleted"}${actSuffix(act)}` : "" });
    // A delete takes only what code decided says the same; a forget, which can be undone, also what the judge did (`withoutJudged`).
    const also = await this.#forgetDuplicates(userId, keepText ? plan : withoutJudged(plan), { act, keepText, actor });
    return { ...forgotten, ...(also ? { alsoForgot: also } : {}) };
  }

  /**
   * The statements of the account's other memories that say what the removed ones said (`nativeMemoryForgetEverywhere.mjs`). A failure to
   * find them is no failure of the forget: nothing else goes, and it is said.
   * @param {string} userId @param {readonly string[]} removed @returns {Promise<Map<string, string[]>>} by file URI
   */
  async #duplicatesPlan(userId, removed) {
    try {
      const files = (await this.files(userId)).map((file) => ({ uri: file.uri, type: file.type, statements: statements(file.body) }));
      return await duplicatesOf({ files, removed, judge: this.rejectionJudge, userId });
    } catch (error) {
      this.report(`native memory forget duplicates: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      return new Map();
    }
  }

  /**
   * Take the planned statements out of the files that hold them, as revisions of the act the forget began (their words go on the
   * rejection list under their own type, and a restore of any one of them brings them all back, `#restoreAct`). A file that would be left
   * with no statement is forgotten whole.
   * @param {string} userId @param {Map<string, string[]>} plan @param {{ act: string | null, keepText: boolean, actor: string }} how
   * @returns {Promise<number>} statements taken out
   */
  async #forgetDuplicates(userId, plan, { act, keepText, actor }) {
    if (!plan.size || !act) return 0;
    let taken = 0;
    for (const [uri, lines] of plan) {
      try {
        const file = (await this.files(userId)).find((candidate) => candidate.uri === uri);
        if (!file) continue;
        const prints = new Set(lines.map(lineFingerprint));
        const kept = [];
        /** @type {string[]} */
        const removedHere = [];
        for (const raw of file.body.split("\n")) {
          const text = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
          if (text && !isLabelLine(raw) && !/^#{1,6}\s/.test(raw.trim()) && prints.has(lineFingerprint(text))) { removedHere.push(text); continue; }
          kept.push(raw);
        }
        if (!removedHere.length) continue;
        const next = kept.join("\n");
        const reason = `forgotten on the memory page, the same as another line${actSuffix(act)}`;
        if (!statements(next).length) {
          await this.forgetFile(userId, file, { keepText, actor, reason: keepText ? reason : `deleted${actSuffix(act)}` });
        } else {
          await this.#write(userId, file, next, { actor, reason: keepText ? reason : `deleted on the memory page${actSuffix(act)}` });
          if (!keepText) await this.overlay.scrubLines(userId, file.uri, removedHere);
        }
        // Whoever forgot them, what was removed stays removed: a conversation's forget rejects as the person's own does.
        await this.overlay.reject(userId, file.type, file.uri, removedHere);
        taken += removedHere.length;
      } catch (error) {
        this.report(`native memory forget duplicates: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      }
    }
    recordForgetDuplicates("removed", taken);
    return taken;
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
    const plan = await this.#duplicatesPlan(String(user.id), statements(file.body));
    const act = plan.size ? newAct() : null;
    await this.forgetFile(String(user.id), file, { keepText: true, actor: "conversation", reason: `forgotten in a conversation${actSuffix(act)}` });
    await this.#forgetDuplicates(String(user.id), plan, { act, keepText: true, actor: "conversation" });
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
      await this.#restoreText(userId, { uri, text: String(last.before), memoryType, projectId: last.projectId, revisionId: last.id, reason: "undo" });
      // A file forgotten with the lines elsewhere that said the same brings them back too.
      const act = actOf(last.reason);
      if (act) await this.#restoreAct(userId, act, last.id);
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
    await this.overlay.syncOrigins(userId, uri, { after: before });
    await this.overlay.markUndone(userId, last.id);
    // A line forgotten together with others that said the same: the undo of one is the undo of the act.
    const act = actOf(last.reason);
    if (act) await this.#restoreAct(userId, act, last.id);
    return { undone: "restored", record: await this.getRecord(userId, nativeFileId(uri)).catch(() => null), restored: [] };
  }

  /**
   * Put a forgotten file's text back as a file, and take the forget off the list of what can be undone, with one `replace`. A
   * file the engine has written again at this address since the person forgot it is overwritten by the restore: `create` is a
   * plain alias of `replace` from v0.5.1, so there is no guard to rely on, and the person asked for this text back (the race is
   * accepted, not prevented). `replace` on a missing file creates it, parents included (measured on v0.5.1.1, under `memories/`).
   * What a restore can give back is the text: the engine's own fields (its type) are not restored with it, and its later
   * extraction writes beside the file rather than into it.
   * @param {string} userId
   * @param {{ uri: string, text: string, memoryType: string, projectId?: string | null, revisionId: string, reason: string }} restore
   */
  async #restoreText(userId, { uri, text, memoryType, projectId = null, revisionId, reason }) {
    await this.#engine(() => this.sessions.replace(userId, uri, text));
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
      const kind = /** @type {Record<string, string>} */ (PAGE_KIND_OF_TYPE)[place.type] ?? "project_fact";
      const record = (/** @type {Record<string, any>} */ over) => ({
        scope: base.scope, scopeId: base.scopeId, kind, origin: "explicit", status: "archived", confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 0,
        createdAt: revision.changedAt, updatedAt: revision.changedAt, lastConfirmedAt: revision.changedAt, expiresAt: null, supersededBy: null, invalidSince: null, validFrom: null,
        evidence: [], revisions: [], nativeType: place.type, uri: revision.uri, forgottenRevision: revision.id, ...(actOf(revision.reason) ? { act: actOf(revision.reason) } : {}), ...over,
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
    const entry = (await this.forgotten(userId)).find((candidate) => candidate.id === id);
    const restored = await this.#restoreOne(userId, id, expectedVersion);
    // What went with it when it was forgotten (the lines elsewhere that said the same) comes back with it.
    if (entry?.act) await this.#restoreAct(userId, entry.act, entry.forgottenRevision);
    return restored;
  }

  /**
   * Bring back the other members of an act: what was forgotten with the line the person has just restored, each from the text its own forget
   * kept. A member that cannot come back (a changed document, an older restore) is left, said, and never undoes the restore that was asked for.
   * @param {string} userId @param {string} act @param {string} exceptRevision the revision already restored
   */
  async #restoreAct(userId, act, exceptRevision) {
    for (const member of (await this.forgotten(userId)).filter((entry) => entry.act === act && entry.forgottenRevision !== exceptRevision)) {
      try { await this.#restoreOne(userId, member.id, member.version); }
      catch (error) { this.report(`native memory restore with: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`); }
    }
  }

  /** @param {string} userId @param {string} id @param {number} expectedVersion */
  async #restoreOne(userId, id, expectedVersion) {
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

  /** Confirm one external candidate revision through the existing extracting session path.
   * The durable admission is created before the first engine side effect.
   * @param {string} userId @param {{ candidateId: string, revision: number, text: string, projectId?: string | null }} input */
  async admitCandidate(userId, input) {
    this.#assertConfigured();
    const text = String(input.text ?? "").trim();
    if (!text || text.length > 262144) throw new HttpError(400, "memory_payload_invalid", "The candidate is empty or too large.");
    if (identifierShapesIn(text).length) throw new HttpError(400, "memory_content_refused", "A memory cannot carry a credential or a personal identifier.");
    const engineSession = `evimed-external-${createHash("sha256").update(JSON.stringify([userId,input.candidateId,input.revision])).digest("hex").slice(0,48)}`;
    const admission = await this.overlay.queueAdmission(userId, { ...input, text, engineSession });
    return this.processAdmission(userId, admission);
  }

  /** Recover admissions after restart and attach every resulting native file, never assuming one candidate produces one fact.
   * @param {string} userId */
  async processAdmissions(userId) {
    for (const admission of await this.overlay.openAdmissions(userId)) await this.processAdmission(userId, admission);
  }

  /** @param {string} userId @param {any} admission */
  async processAdmission(userId, admission) {
    const receipt = (/** @type {any} */ row) => ({ candidateId: row.candidateId, revision: row.revision, state: row.state,
      engineSession: row.engineSession, archiveUri: row.archiveUri ?? null, taskId: row.taskId ?? null,
      recordIds: row.recordIds ?? [], ...(row.error ? { error: row.error } : {}) });
    if (["completed", "cancelled"].includes(admission.state)) return receipt(admission);
    let row = typeof this.overlay.claimAdmission === "function"
      ? await this.overlay.claimAdmission(userId, admission.candidateId, admission.revision) : admission;
    if (!row) return receipt((await this.overlay.admission(userId, admission.candidateId, admission.revision)) ?? admission);
    const save = async (/** @type {any} */ patch) => {
      row = await this.overlay.updateAdmission(userId, admission.candidateId, admission.revision, patch);
      return row;
    };
    /** @param {string | null} [unattemptedPhase] */
    const authorized = async (unattemptedPhase = null) => {
      if (typeof this.overlay.admissionAuthority !== "function") return true;
      const policy = await this.overlay.admissionAuthority(userId, row);
      if (policy.allowed) return true;
      await save({ state: policy.state, error: policy.reason, phase: unattemptedPhase, release: true });
      return false;
    };
    try {
      if (!await authorized()) return receipt(row);
      const commits = await this.overlay.commitsOfSession(userId, row.engineSession);
      if (!row.archiveUri && commits.length) await save({ archiveUri: commits[0].archiveUri, taskId: commits[0].taskId, state: "pending" });
      if (!row.archiveUri) {
        if (!await authorized()) return receipt(row);
        await this.sessions.register(userId);
        if (!await authorized()) return receipt(row);
        await this.sessions.createSession(userId, row.engineSession);
        await this.overlay.noteSession(userId, row.engineSession, row.projectId);
        const status = (await this.sessions.readSession(userId, row.engineSession))?.result;
        // A timed-out commit can already have archived the batch. Discover it before considering another write.
        if (Number(status?.commit_count) > 0) {
          const nodes = await this.sessions.tree(userId, `${this.sessions.sessionUri(userId,row.engineSession)}/history`, { showHidden: true });
          const archive = nodes.map((node) => parseArchiveUri(node.uri)).find(Boolean)?.archiveUri;
          if (!archive) { await save({ state: "uncertain", error: "commit_archive_not_visible", release: true }); return receipt(row); }
          const commit = await this.overlay.recordCommit({ userId, archiveUri: archive, engineSession: row.engineSession, projectId: row.projectId, origin: "tool" });
          await save({ archiveUri: archive, taskId: commit.taskId, state: "pending" });
        } else {
          if (!status || !Number.isFinite(Number(status.message_count))) throw new HttpError(503, "memory_engine_unavailable", "The session state could not be inspected.");
          if (Number(status.message_count) === 0) {
            // An uncertain append may still finish after its HTTP timeout. Zero messages is not proof it was refused.
            if (["message_submitting", "commit_submitting"].includes(row.phase)) {
              await save({ state: "uncertain", error: "submission_outcome_unknown", release: true }); return receipt(row);
            }
            const priorPhase = row.phase;
            await save({ state: "submitting", phase: "message_submitting", error: "" });
            // A denied final guard attempted no append; restore that fact before releasing this lease.
            if (!await authorized(priorPhase)) return receipt(row);
            await this.sessions.addMessage(userId, row.engineSession, { role: "user", parts: [{ type: "text", text: maskIdentifiers(row.text) }] });
          } else if (Number(status.message_count) !== 1) {
            await save({ state: "uncertain", error: "unexpected_session_messages", release: true }); return receipt(row);
          }
          const priorPhase = row.phase;
          await save({ state: "submitting", phase: "commit_submitting" });
          if (!await authorized(priorPhase)) return receipt(row);
          const result = (await this.sessions.commit(userId, row.engineSession))?.result;
          if (result?.status !== "accepted" || typeof result.archive_uri !== "string") throw new HttpError(503,"memory_engine_unavailable","The memory service did not accept the candidate.");
          const commit = await this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: row.engineSession,
            projectId: row.projectId, origin: "tool", taskId: result.task_id ?? null });
          await save({ state: "pending", archiveUri: commit.archiveUri, taskId: commit.taskId, error: "" });
          this.#touch(userId);
        }
      }
      // The existing native worker owns task settlement and replay. Follow its archive chain instead of extracting twice.
      let commit = typeof this.overlay.commit === "function" ? await this.overlay.commit(userId, row.archiveUri) : null;
      for (let depth = 0; commit?.state === "replayed" && commit.replayedAs && depth < 100; depth++) {
        await save({ archiveUri: commit.replayedAs });
        commit = await this.overlay.commit(userId, commit.replayedAs);
      }
      if (commit?.state === "completed") {
        const revisions = await this.overlay.admissionRevisions(userId, commit.archiveUri);
        await save({ state: "completed", recordIds: [...new Set(revisions.filter((revision) => revision.change !== "deleted").map((revision) => nativeFileId(revision.uri)))], error: "", release: true });
      } else {
        await save({ state: commit?.state === "abandoned" ? "failed" : "pending", error: commit?.error ?? "", release: true });
      }
      return receipt(row);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_admission_gone") throw error;
      await save({ state: ["message_submitting","commit_submitting"].includes(row.phase) ? "uncertain" : "failed",
        error: String(/** @type {any} */ (error)?.code ?? "memory_admission_failed").slice(0,200), release: true });
      return receipt(row);
    }
  }

  /**
   * 「记住这一条」 from the page: the person's words go to the engine the way a conversation's do — one session, one message,
   * a commit — so what is written has its type, its tags and its place among the memories the engine keeps updating. It
   * appears when the engine has written it (about twelve seconds); until then the page shows it as pending.
   * @param {string} userId @param {{ text: string, projectId?: string | null }} input
   */
  async remember(userId, { text, projectId = null }) {
    const words = String(text ?? "").trim();
    if (!words || words.length > 2_000) throw new HttpError(400, "memory_payload_invalid", "What to remember must be 1 to 2000 characters.");
    if (identifierShapesIn(words).length) throw new HttpError(400, "memory_content_refused", "A memory cannot carry a credential or a personal identifier.");
    const commit = await this.#submitWords(userId, { content: `请记住：${maskIdentifiers(words)}`, projectId, origin: "page", prefix: "evimed-page-", pendingText: words });
    return { pending: { id: commit.archiveUri, text: words, at: commit.createdAt, state: "pending" } };
  }

  /**
   * What the person kept from the other assistant's memory, one message to the engine in the form the templates read as an import
   * (`MEMORY_DECIDE_TEXT`): the statements they ticked as their own, and, apart, the ones they ticked from the keep-only-on-request tier,
   * which that is an explicit request to remember. The engine writes them under the same never-kept rules as anything else; this
   * is a session of its own (`evimed-import-…`) so that what it wrote reads 「从其他 AI 导入」 in the drawer.
   * @param {string} userId @param {{ ordinary: readonly string[], onRequest?: readonly string[] }} lines each one first-person statement
   * @returns {Promise<{ archiveUri: string }>}
   */
  async rememberImport(userId, { ordinary, onRequest = [] }) {
    const clean = (/** @type {readonly string[]} */ list) => list.map((line) => maskIdentifiers(String(line ?? "").replace(/\s+/g, " ").trim())).filter(Boolean);
    const plain = clean(ordinary);
    const asked = clean(onRequest);
    if (!plain.length && !asked.length) throw new HttpError(400, "memory_payload_invalid", "There is nothing to import.");
    const content = [
      "这是我在另一个 AI 助手里的记忆导出，请把它们导入到这里：",
      ...plain.map((line) => `- ${line}`),
      ...(asked.length ? ["我明确要求记住下面这几条：", ...asked.map((line) => `- ${line}`)] : []),
    ].join("\n");
    const commit = await this.#submitWords(userId, { content, projectId: null, origin: "import", prefix: "evimed-import-" });
    return { archiveUri: commit.archiveUri };
  }

  /**
   * A choice two different conversations made, as the person's explicit request to keep it (`nativeMemoryObservations.mjs`): the same
   * path as 「记住这一条」, in a session of its own (`evimed-promote-…`) so that the preference it writes reads 「你在两次对话里都这样做」.
   * @param {string} userId @param {string} choice the observation's own words, a line or a few
   * @returns {Promise<{ archiveUri: string }>}
   */
  async keepRepeatedChoice(userId, choice) {
    const words = maskIdentifiers(String(choice ?? "").replace(/\s+/g, " ").trim()).slice(0, 600);
    if (!words) throw new HttpError(400, "memory_payload_invalid", "There is nothing to keep.");
    const commit = await this.#submitWords(userId, { content: repeatedChoiceMessage(words), projectId: null, origin: "promotion", prefix: "evimed-promote-" });
    return { archiveUri: commit.archiveUri };
  }

  /**
   * One message to the engine in a session of its own, and its commit entered in the ledger: the one way a memory is written from
   * outside a conversation (the page, an import, a promotion), so the engine's own templates apply to all of them.
   * @param {string} userId @param {{ content: string, projectId: string | null, origin: "page" | "import" | "promotion", prefix: string, pendingText?: string | null }} write
   */
  async #submitWords(userId, { content, projectId, origin, prefix, pendingText = null }) {
    this.#assertConfigured();
    this.#touch(userId);
    const session = `${prefix}${randomUUID().replace(/-/g, "")}`;
    await this.#engine(async () => {
      await this.sessions.register(userId).catch(() => false);
      await this.sessions.createSession(userId, session, { timeoutMs: this.sessions.timeoutMs });
      await this.sessions.addMessage(userId, session, { role: "user", parts: [{ type: "text", text: content }] });
    });
    const answer = await this.#engine(() => this.sessions.commit(userId, session));
    const result = answer?.result ?? {};
    if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw new HttpError(503, "memory_engine_unavailable", "The memory service did not accept it.");
    return this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: session, projectId, origin,
      taskId: typeof result.task_id === "string" ? result.task_id : null, pendingText });
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
    // What the engine is still extracting is written down first, because the deletions below take its sessions and the overlay's ledger
    // with them and the extraction does not stop: whatever it writes after the reset is found by these tombstones and taken out
    // (`NativeMemoryWorker`'s sweep), however late it lands.
    await this.#tombstoneInFlight(userId);
    let files = 0;
    await this.#engine(async () => {
      for (const [type, segment] of Object.entries(MEMORY_SEGMENT_OF_TYPE)) {
        if (await this.sessions.remove(userId, `${root}/${segment}`, { recursive: type !== "profile" })) files += 1;
      }
      // The observations are the account's own too, though no page lists them: a reset leaves none behind.
      if (await this.sessions.remove(userId, `${root}/${OBSERVATIONS_SEGMENT}`, { recursive: true })) files += 1;
    });
    const sessions = await this.#deleteSessions(userId);
    const purged = await this.overlay.purgeUser(userId);
    return { files, sessions, revisions: purged.revisions };
  }

  /**
   * The commits a reset cannot wait for: the ledger's pending ones (with their tasks) and any archive of the engine's session tree that
   * nothing has finished yet (an idle commit the scan had not entered). A failure to list them is the reset's failure: it is run again.
   * @param {string} userId
   */
  async #tombstoneInFlight(userId) {
    const resetAt = this.now();
    const pending = (await this.overlay.openCommits({ userId, limit: 500, now: resetAt })).filter((commit) => commit.state === "pending");
    const known = new Set(pending.map((commit) => commit.archiveUri));
    const listed = await this.#engine(() => this.sessions.tree(userId, `${this.sessions.userRoot(userId)}/sessions`, { levelLimit: 4, showHidden: true }));
    const unseen = unfinishedArchives(listed).filter((archive) => !known.has(archive.archiveUri)).map((archive) => ({ archiveUri: archive.archiveUri, engineSession: archive.session, taskId: null }));
    await this.overlay.tombstoneCommits(userId, [...pending.map((commit) => ({ archiveUri: commit.archiveUri, engineSession: commit.engineSession, taskId: commit.taskId })), ...unseen], resetAt);
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
