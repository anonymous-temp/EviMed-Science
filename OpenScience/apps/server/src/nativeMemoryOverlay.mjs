import { createHash } from "node:crypto";
import { migrateResearchMemory } from "./researchMemoryPersistence.mjs";
import {
  NATIVE_COMMIT_ORIGINS, NATIVE_REVISION_ACTORS, NATIVE_REVISION_CHANGES, NATIVE_TEXT_LIMIT, migrateNativeMemory,
} from "./nativeMemoryPersistence.mjs";
import { HttpError } from "./security.mjs";

/**
 * The overlay store of the native memory engine (`nativeMemoryPersistence.mjs` says what it holds and why).
 *
 * Nothing here decides anything about a memory's text: the engine wrote it, the person edited it, and this keeps what
 * happened to it so the page can show a timeline, undo a change, and tell a write-back from something new. Every method
 * takes the platform's user id and every row is that account's.
 *
 * @module nativeMemoryOverlay
 */

/** sha256 of a memory body, as the page's compare-and-swap reads it. @param {unknown} body */
export function contentHash(body) {
  return createHash("sha256").update(String(body ?? "").replace(/\r\n/g, "\n").trim()).digest("hex");
}

/**
 * The statements of a memory body: its lines that say something, each without the bullet, heading mark or as-of date the
 * template dresses it in. A heading is kept as a line of its own only for a file that has nothing else.
 * @param {unknown} body @returns {string[]}
 */
export function memoryLines(body) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const statements = lines.filter((line) => !/^#{1,6}\s/.test(line));
  return (statements.length ? statements : lines).map((line) => line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

/**
 * What identifies one statement whatever it is dressed in: lower-cased, whitespace collapsed, without the trailing
 * `(as of YYYY-MM-DD)` the profile template writes. Exact equality after that and nothing looser — whether two differently
 * worded lines say the same thing is language, and is not decided here.
 * @param {unknown} line @returns {string} sha256 hex
 */
export function lineFingerprint(line) {
  const text = String(line ?? "").replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(text).digest("hex");
}

const bounded = (/** @type {unknown} */ value, /** @type {number} */ limit) => (value == null ? null : String(value).slice(0, limit));
const instant = (/** @type {unknown} */ value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** @param {unknown} userId */
function owner(userId) {
  const text = String(userId ?? "");
  if (!USER_ID.test(text)) throw new HttpError(400, "memory_user_invalid", "The memory owner is invalid.");
  return text;
}

/** @param {any} row */
function publicCommit(row) {
  return {
    userId: String(row.user_id), archiveUri: String(row.archive_uri), engineSession: String(row.engine_session),
    projectId: row.project_id ?? null, origin: String(row.origin), taskId: row.task_id ?? null, state: String(row.state),
    operations: Number(row.operations) || 0, error: String(row.error ?? ""), attempts: Number(row.attempts) || 0,
    nextAttemptAt: instant(row.next_attempt_at), replayedAs: row.replayed_as ?? null, pendingText: row.pending_text ?? null,
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), ingestedAt: instant(row.ingested_at),
  };
}

/** @param {any} row */
function publicRevision(row) {
  return {
    id: String(row.id), uri: String(row.uri), memoryType: String(row.memory_type), change: String(row.change), actor: String(row.actor),
    reason: String(row.reason ?? ""), before: row.before ?? null, after: row.after ?? null, archiveUri: row.archive_uri ?? null,
    engineSession: row.engine_session ?? null, projectId: row.project_id ?? null, undoneAt: instant(row.undone_at), changedAt: instant(row.changed_at),
  };
}

/** @param {any} row */
function publicFile(row) {
  return {
    uri: String(row.uri), memoryType: String(row.memory_type), projectId: row.project_id ?? null, sensitive: row.sensitive === true,
    contentHash: row.content_hash ?? null, body: row.body ?? null, labels: Array.isArray(row.labels) ? row.labels : [],
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at),
  };
}

export class NativeMemoryOverlay {
  /** @param {{ database?: any }} dependencies */
  constructor({ database = null } = {}) {
    this.database = database ?? null;
  }

  get configured() { return Boolean(this.database); }

  /** @param {string} text @param {any[]} [values] */
  async #query(text, values = []) {
    if (!this.database) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    await migrateResearchMemory(this.database);
    await migrateNativeMemory(this.database);
    return this.database.query(text, values);
  }

  async migrate() { await this.#query("SELECT 1"); }

  // ---------------------------------------------------------------- accounts

  /** @param {string} userId */
  async account(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_accounts WHERE user_id=$1", [owner(userId)]);
    const row = result.rows[0];
    return { registeredAt: instant(row?.registered_at), scannedAt: instant(row?.scanned_at), migratedAt: instant(row?.migrated_at) };
  }

  /** @param {string} userId @param {"registered_at" | "scanned_at" | "migrated_at"} column */
  async #stamp(userId, column) {
    await this.#query(`INSERT INTO evimed_memory.native_accounts (user_id, ${column}) VALUES ($1, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET ${column}=clock_timestamp(), updated_at=date_trunc('second', clock_timestamp())`, [owner(userId)]);
  }
  /** The engine's admin routes know this account from now on. @param {string} userId */
  noteRegistered(userId) { return this.#stamp(userId, "registered_at"); }
  /** @param {string} userId */
  noteScanned(userId) { return this.#stamp(userId, "scanned_at"); }
  /** @param {string} userId */
  noteMigrated(userId) { return this.#stamp(userId, "migrated_at"); }

  /** The account was erased from the engine: whatever it is next is a new registration. @param {string} userId */
  async forgetAccount(userId) {
    await this.#query("DELETE FROM evimed_memory.native_accounts WHERE user_id=$1", [owner(userId)]);
  }

  // ----------------------------------------------------------------- commits

  /**
   * One commit the engine accepted. Written once per archive: a second sighting (the scan finding what the gateway
   * recorded) fills what the first did not know and never moves the state back.
   * @param {{ userId: string, archiveUri: string, engineSession: string, projectId?: string | null, origin: string, taskId?: string | null, state?: string, error?: string, pendingText?: string | null, attempts?: number }} commit `attempts`: how many replays the conversation behind this commit has had already (a replay's own commit carries the count on, so the cap bounds the chain)
   */
  async recordCommit({ userId, archiveUri, engineSession, projectId = null, origin, taskId = null, state = "pending", error = "", pendingText = null, attempts = 0 }) {
    if (!NATIVE_COMMIT_ORIGINS.includes(origin)) throw new HttpError(500, "memory_commit_invalid", "Unknown commit origin.");
    const result = await this.#query(`INSERT INTO evimed_memory.native_commits AS c (user_id, archive_uri, engine_session, project_id, origin, task_id, state, error, next_attempt_at, pending_text, attempts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'failed' THEN clock_timestamp() END, $9, $10)
      ON CONFLICT (user_id, archive_uri) DO UPDATE SET
        task_id = COALESCE(c.task_id, EXCLUDED.task_id), project_id = COALESCE(c.project_id, EXCLUDED.project_id), updated_at = clock_timestamp()
      RETURNING *, (xmax = 0) AS inserted`,
    [owner(userId), String(archiveUri), String(engineSession), projectId, origin, taskId, state, String(error ?? "").slice(0, 400),
      pendingText == null ? null : String(pendingText).slice(0, 2_000), Math.max(0, Math.min(100, Math.trunc(Number(attempts)) || 0))]);
    return { ...publicCommit(result.rows[0]), inserted: result.rows[0].inserted === true };
  }

  /** @param {string} userId @param {string} archiveUri */
  async commit(userId, archiveUri) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND archive_uri=$2", [owner(userId), String(archiveUri)]);
    return result.rows[0] ? publicCommit(result.rows[0]) : null;
  }

  /** The archives of one account the ledger already holds. @param {string} userId @returns {Promise<Set<string>>} */
  async knownArchives(userId) {
    const result = await this.#query("SELECT archive_uri FROM evimed_memory.native_commits WHERE user_id=$1", [owner(userId)]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.archive_uri)));
  }

  /**
   * The commits something is still owed for: a diff to read (`pending`), or a replay that is due (`failed`).
   * @param {{ limit?: number, userId?: string | null, now?: Date | null }} [options] `now`: the moment a replay is due by (the database's clock when absent)
   */
  async openCommits({ limit = 50, userId = null, now = null } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits
      WHERE ((state = 'pending') OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= COALESCE($3::timestamptz, clock_timestamp()))))
        AND ($2::text IS NULL OR user_id = $2)
      ORDER BY created_at LIMIT $1`, [Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 50)), userId == null ? null : owner(userId), now ? now.toISOString() : null]);
    return result.rows.map(publicCommit);
  }

  /** The commits of one account still being worked on, newest first: what the page shows as 「正在记住」. @param {string} userId */
  async pendingCommits(userId, { origins = ["page"], limit = 20 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND state IN ('pending', 'failed') AND origin = ANY($2::text[])
      ORDER BY created_at DESC LIMIT $3`, [owner(userId), origins, limit]);
    return result.rows.map(publicCommit);
  }

  /** @param {string} userId @param {string} archiveUri @param {{ operations?: number }} [outcome] */
  async completeCommit(userId, archiveUri, { operations = 0 } = {}) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='completed', operations=$3, error='', next_attempt_at=NULL, pending_text=NULL,
      ingested_at=clock_timestamp(), updated_at=clock_timestamp() WHERE user_id=$1 AND archive_uri=$2 AND state IN ('pending', 'failed')`,
    [owner(userId), String(archiveUri), Math.max(0, Math.trunc(Number(operations)) || 0)]);
  }

  /** The extraction failed: a replay is owed at `nextAttemptAt`. @param {string} userId @param {string} archiveUri @param {{ error?: string, nextAttemptAt?: Date | null }} failure */
  async failCommit(userId, archiveUri, { error = "", nextAttemptAt = null } = {}) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='failed', error=$3, next_attempt_at=COALESCE($4::timestamptz, clock_timestamp()),
      updated_at=clock_timestamp() WHERE user_id=$1 AND archive_uri=$2 AND state IN ('pending', 'failed')`,
    [owner(userId), String(archiveUri), String(error ?? "").slice(0, 400), nextAttemptAt ? nextAttemptAt.toISOString() : null]);
  }

  /** One replay was tried. @param {string} userId @param {string} archiveUri @param {{ nextAttemptAt: Date, error?: string }} attempt @returns {Promise<number>} attempts so far */
  async noteReplayAttempt(userId, archiveUri, { nextAttemptAt, error = "" }) {
    const result = await this.#query(`UPDATE evimed_memory.native_commits SET attempts=attempts+1, next_attempt_at=$3, error=CASE WHEN $4 = '' THEN error ELSE $4 END,
      updated_at=clock_timestamp() WHERE user_id=$1 AND archive_uri=$2 RETURNING attempts`,
    [owner(userId), String(archiveUri), nextAttemptAt.toISOString(), String(error ?? "").slice(0, 400)]);
    return Number(result.rows[0]?.attempts) || 0;
  }

  /** @param {string} userId @param {string} archiveUri @param {string} replayedAs the archive that carries the same messages now */
  async markReplayed(userId, archiveUri, replayedAs) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='replayed', replayed_as=$3, next_attempt_at=NULL, pending_text=NULL, updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri=$2`, [owner(userId), String(archiveUri), String(replayedAs)]);
  }

  /** @param {string} userId @param {string} archiveUri @param {string} reason */
  async abandonCommit(userId, archiveUri, reason) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='abandoned', error=$3, next_attempt_at=NULL, pending_text=NULL, updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri=$2`, [owner(userId), String(archiveUri), String(reason ?? "").slice(0, 400)]);
  }

  /** How the ledger stands, for readiness: commits by state, and the oldest one still owed something. */
  async commitTotals() {
    const result = await this.#query(`SELECT state, count(*)::int AS commits, min(created_at) AS oldest FROM evimed_memory.native_commits GROUP BY state`);
    /** @type {Record<string, number>} */
    const byState = {};
    let oldestOpen = null;
    for (const row of result.rows) {
      byState[String(row.state)] = Number(row.commits);
      if (["pending", "failed"].includes(String(row.state)) && row.oldest && (!oldestOpen || row.oldest < oldestOpen)) oldestOpen = row.oldest;
    }
    return { byState, oldestOpenAt: instant(oldestOpen) };
  }

  // --------------------------------------------------------------- revisions

  /**
   * One change of one file. A change read from an archive's diff is written once however often the diff is read.
   * @returns {Promise<ReturnType<typeof publicRevision> | null>} null when this archive's change was already there
   */
  async addRevision({ userId, uri, memoryType, change, actor, reason = "", before = null, after = null, archiveUri = null, engineSession = null, projectId = null, changedAt = null }) {
    if (!NATIVE_REVISION_CHANGES.includes(change) || !NATIVE_REVISION_ACTORS.includes(actor)) throw new HttpError(500, "memory_revision_invalid", "Unknown revision change or actor.");
    const result = await this.#query(`INSERT INTO evimed_memory.native_revisions
      (user_id, uri, memory_type, change, actor, reason, before, after, archive_uri, engine_session, project_id, changed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, clock_timestamp()))
      ON CONFLICT (user_id, archive_uri, uri, change) WHERE archive_uri IS NOT NULL DO NOTHING RETURNING *`,
    [owner(userId), String(uri), String(memoryType), change, actor, String(reason ?? "").slice(0, 200), bounded(before, NATIVE_TEXT_LIMIT), bounded(after, NATIVE_TEXT_LIMIT),
      archiveUri, engineSession, projectId, changedAt]);
    return result.rows[0] ? publicRevision(result.rows[0]) : null;
  }

  /** @param {string} userId @param {string} uri @param {{ limit?: number }} [options] newest first */
  async revisionsOf(userId, uri, { limit = 32 } = {}) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri=$2 ORDER BY id DESC LIMIT $3",
      [owner(userId), String(uri), Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 32))]);
    return result.rows.map(publicRevision);
  }

  /** The revisions of many files in one read, newest first per file. @param {string} userId @param {readonly string[]} uris */
  async revisionsOfMany(userId, uris, { perFile = 32 } = {}) {
    /** @type {Map<string, ReturnType<typeof publicRevision>[]>} */
    const byUri = new Map();
    if (!uris.length) return byUri;
    const result = await this.#query(`SELECT * FROM (SELECT r.*, row_number() OVER (PARTITION BY uri ORDER BY id DESC) AS position
      FROM evimed_memory.native_revisions r WHERE user_id=$1 AND uri = ANY($2::text[])) ranked WHERE position <= $3 ORDER BY uri, id DESC`,
    [owner(userId), [...uris], Math.max(1, Math.min(200, perFile))]);
    for (const row of result.rows) {
      const list = byUri.get(String(row.uri)) ?? [];
      list.push(publicRevision(row));
      byUri.set(String(row.uri), list);
    }
    return byUri;
  }

  /** What changed by itself since a moment, newest first. @param {string} userId @param {{ since?: string | null, engineSession?: string | null, actors?: string[], limit?: number }} [options] */
  async recentRevisions(userId, { since = null, engineSession = null, actors = ["engine"], limit = 20 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_revisions
      WHERE user_id=$1 AND ($2::timestamptz IS NULL OR changed_at > $2) AND ($3::text IS NULL OR engine_session = $3) AND actor = ANY($4::text[])
        AND undone_at IS NULL
      ORDER BY id DESC LIMIT $5`, [owner(userId), since, engineSession, actors, Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 20))]);
    return result.rows.map(publicRevision);
  }

  /** Every revision of an account inside a range, oldest first: the timeline and the map's events. */
  async revisionsBetween(userId, { from = null, to = null, limit = 5_000 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1
      AND ($2::timestamptz IS NULL OR changed_at >= $2) AND ($3::timestamptz IS NULL OR changed_at <= $3) ORDER BY id LIMIT $4`,
    [owner(userId), from, to, Math.max(1, Math.min(20_000, limit))]);
    return result.rows.map(publicRevision);
  }

  /** @param {string} userId @param {string} id */
  async revision(userId, id) {
    if (!/^\d{1,18}$/.test(String(id))) return null;
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND id=$2", [owner(userId), String(id)]);
    return result.rows[0] ? publicRevision(result.rows[0]) : null;
  }

  /** @param {string} userId @param {string} id */
  async markUndone(userId, id) {
    await this.#query("UPDATE evimed_memory.native_revisions SET undone_at=clock_timestamp() WHERE user_id=$1 AND id=$2", [owner(userId), String(id)]);
  }

  /** A person deleted this memory: its text leaves the history too (what was changed, and when, stays). @param {string} userId @param {string} uri */
  async forgetText(userId, uri) {
    await this.#query("UPDATE evimed_memory.native_revisions SET before=NULL, after=NULL WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
  }

  /**
   * A person deleted some lines of a memory that stays (a line of the profile): those lines leave every revision of the file
   * the history holds, the rest of each text stays.
   * @param {string} userId @param {string} uri @param {readonly string[]} lines
   */
  async scrubLines(userId, uri, lines) {
    const prints = new Set(lines.map(lineFingerprint));
    if (!prints.size) return 0;
    const scrub = (/** @type {string | null} */ text) => (text === null ? null
      : text.split("\n").filter((line) => !prints.has(lineFingerprint(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")))).join("\n"));
    const rows = await this.#query("SELECT id, before, after FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
    let changed = 0;
    for (const row of rows.rows) {
      const before = scrub(row.before);
      const after = scrub(row.after);
      if (before === row.before && after === row.after) continue;
      await this.#query("UPDATE evimed_memory.native_revisions SET before=$3, after=$4 WHERE user_id=$1 AND id=$2", [owner(userId), String(row.id), before, after]);
      changed += 1;
    }
    return changed;
  }

  // ------------------------------------------------------------------- files

  /**
   * What the overlay knows of one file, written or refreshed. `projectId`, `body` and `sensitive` are left as they are
   * when not given.
   * @param {{ userId: string, uri: string, memoryType: string, projectId?: string | null, body?: string | null, sensitive?: boolean }} file
   */
  async upsertFile({ userId, uri, memoryType, projectId = undefined, body = undefined, sensitive = undefined }) {
    const text = body === undefined || body === null ? null : String(body).slice(0, NATIVE_TEXT_LIMIT);
    const result = await this.#query(`INSERT INTO evimed_memory.native_files AS f (user_id, uri, memory_type, project_id, body, content_hash, sensitive)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::boolean, false))
      ON CONFLICT (user_id, uri) DO UPDATE SET
        memory_type = EXCLUDED.memory_type,
        project_id = CASE WHEN $8::boolean THEN EXCLUDED.project_id ELSE f.project_id END,
        body = CASE WHEN $9::boolean THEN EXCLUDED.body ELSE f.body END,
        content_hash = CASE WHEN $9::boolean THEN EXCLUDED.content_hash ELSE f.content_hash END,
        sensitive = COALESCE($7::boolean, f.sensitive),
        updated_at = clock_timestamp()
      RETURNING *`,
    [owner(userId), String(uri), String(memoryType), projectId ?? null, text, text === null ? null : contentHash(text), sensitive ?? null,
      projectId !== undefined, body !== undefined && body !== null]);
    return publicFile(result.rows[0]);
  }

  /** @param {string} userId @param {string} uri */
  async file(userId, uri) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_files WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
    return result.rows[0] ? publicFile(result.rows[0]) : null;
  }

  /** @param {string} userId @returns {Promise<Map<string, ReturnType<typeof publicFile>>>} by URI */
  async files(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_files WHERE user_id=$1", [owner(userId)]);
    return new Map(result.rows.map((/** @type {any} */ row) => [String(row.uri), publicFile(row)]));
  }

  /** @param {string} userId @param {string} uri */
  async removeFile(userId, uri) {
    await this.#query("DELETE FROM evimed_memory.native_files WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
    await this.#query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
  }

  /** The files recall leaves out, newest first, at most what the engine's `exclude_uris` takes. @param {string} userId */
  async sensitiveUris(userId, limit = 200) {
    const result = await this.#query("SELECT uri FROM evimed_memory.native_files WHERE user_id=$1 AND sensitive ORDER BY updated_at DESC LIMIT $2",
      [owner(userId), Math.max(1, Math.min(200, limit))]);
    return result.rows.map((/** @type {any} */ row) => String(row.uri));
  }

  /** @param {string} userId @param {string} uri @param {any[]} labels the source labels now written into the file */
  async setLabels(userId, uri, labels) {
    await this.#query("UPDATE evimed_memory.native_files SET labels=$3::jsonb, updated_at=clock_timestamp() WHERE user_id=$1 AND uri=$2",
      [owner(userId), String(uri), JSON.stringify(labels.slice(0, 16))]);
  }

  /** The files of one project, by the tag the overlay keeps. @param {string} userId @param {string} projectId */
  async projectFiles(userId, projectId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_files WHERE user_id=$1 AND project_id=$2", [owner(userId), String(projectId)]);
    return result.rows.map(publicFile);
  }

  /** The gateway forwarded a conversation's first message: the project it is held in is recorded, once. @param {string} userId @param {string} engineSession @param {string | null} projectId */
  async noteSession(userId, engineSession, projectId) {
    await this.#query(`INSERT INTO evimed_memory.native_sessions (user_id, engine_session, project_id) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, engine_session) DO UPDATE SET project_id = COALESCE(evimed_memory.native_sessions.project_id, EXCLUDED.project_id)`,
    [owner(userId), String(engineSession), projectId]);
  }

  /** The project an engine session was held in: as noted when it began, else as its earlier commits recorded. @param {string} userId @param {string} engineSession */
  async projectOfSession(userId, engineSession) {
    const result = await this.#query(`SELECT project_id FROM (
        SELECT project_id, 0 AS rank, created_at FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2
        UNION ALL SELECT project_id, 1, created_at FROM evimed_memory.native_commits WHERE user_id=$1 AND engine_session=$2) found
      WHERE project_id IS NOT NULL ORDER BY rank, created_at DESC LIMIT 1`, [owner(userId), String(engineSession)]);
    return result.rows[0]?.project_id ?? null;
  }

  /** The engine sessions of one project, as the gateway and the ledger saw them. @param {string} userId @param {string} projectId @returns {Promise<string[]>} */
  async projectSessions(userId, projectId) {
    const result = await this.#query(`SELECT engine_session FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2
      UNION SELECT engine_session FROM evimed_memory.native_sessions WHERE user_id=$1 AND project_id=$2`, [owner(userId), String(projectId)]);
    return result.rows.map((/** @type {any} */ row) => String(row.engine_session));
  }

  // ----------------------------------------------------------------- sources

  /** Replace what one file is recorded as naming, keeping the state of a source it still names. */
  async setSources(userId, uri, sources) {
    const kept = sources.slice(0, 16);
    await this.#query(`DELETE FROM evimed_memory.native_sources WHERE user_id=$1 AND uri=$2
      AND NOT ((source_type, source_id) IN (SELECT * FROM unnest($3::text[], $4::text[])))`,
    [owner(userId), String(uri), kept.map((/** @type {any} */ source) => source.type), kept.map((/** @type {any} */ source) => source.id)]);
    for (const source of kept) {
      await this.#query(`INSERT INTO evimed_memory.native_sources (user_id, uri, source_type, source_id) VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING`, [owner(userId), String(uri), source.type, source.id]);
    }
  }

  /** The sources the given files name, with the state each is in. @param {string} userId @param {readonly string[]} [uris] every file when absent */
  async sources(userId, uris = undefined) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_sources WHERE user_id=$1 AND ($2::text[] IS NULL OR uri = ANY($2::text[])) ORDER BY uri, source_type, source_id`,
      [owner(userId), uris ? [...uris] : null]);
    return result.rows.map((/** @type {any} */ row) => ({ uri: String(row.uri), type: String(row.source_type), id: String(row.source_id), state: String(row.state), stateAt: instant(row.state_at) }));
  }

  /** The links to one source, across every account or within one. @param {{ type: string, id: string }} source */
  async filesNaming(source, { userId = null } = {}) {
    const result = await this.#query(`SELECT user_id, uri, state FROM evimed_memory.native_sources WHERE source_type=$1 AND source_id=$2 AND ($3::text IS NULL OR user_id=$3)`,
      [source.type, source.id, userId == null ? null : owner(userId)]);
    return result.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), uri: String(row.uri), state: String(row.state) }));
  }

  /** @param {string} userId @param {string} uri @param {{ type: string, id: string }} source @param {string} state */
  async markSource(userId, uri, source, state) {
    await this.#query(`UPDATE evimed_memory.native_sources SET state=$5, state_at=clock_timestamp() WHERE user_id=$1 AND uri=$2 AND source_type=$3 AND source_id=$4`,
      [owner(userId), String(uri), source.type, source.id, state]);
  }

  /** Every recorded link, a page at a time: what the source sweep walks. */
  async sourceLinks({ after = "", limit = 200 } = {}) {
    const result = await this.#query(`SELECT user_id, uri, source_type, source_id, state FROM evimed_memory.native_sources
      WHERE (user_id || E'\\x1f' || uri || E'\\x1f' || source_type || E'\\x1f' || source_id) > $1
      ORDER BY (user_id || E'\\x1f' || uri || E'\\x1f' || source_type || E'\\x1f' || source_id) LIMIT $2`, [String(after), Math.max(1, Math.min(1_000, limit))]);
    return result.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), uri: String(row.uri), type: String(row.source_type), id: String(row.source_id), state: String(row.state),
      cursor: `${row.user_id}\u001f${row.uri}\u001f${row.source_type}\u001f${row.source_id}` }));
  }

  // -------------------------------------------------------------- rejections

  /** The person removed these lines from a memory of this type. @param {string} userId @param {string} memoryType @param {string} uri @param {readonly string[]} lines */
  async reject(userId, memoryType, uri, lines) {
    const prints = [...new Set(lines.map(lineFingerprint))].slice(0, 500);
    if (!prints.length) return 0;
    await this.#query(`INSERT INTO evimed_memory.native_rejections (user_id, memory_type, fingerprint, uri)
      SELECT $1, $2, print, $3 FROM unnest($4::text[]) AS print ON CONFLICT (user_id, memory_type, fingerprint) DO UPDATE SET rejected_at=clock_timestamp()`,
    [owner(userId), String(memoryType), String(uri).slice(0, 600), prints]);
    return prints.length;
  }

  /** The person wrote these lines themselves: they are no longer something to remove. */
  async unreject(userId, memoryType, lines) {
    const prints = [...new Set(lines.map(lineFingerprint))];
    if (!prints.length) return;
    await this.#query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2 AND fingerprint = ANY($3::text[])", [owner(userId), String(memoryType), prints]);
  }

  /** @param {string} userId @param {string} memoryType @returns {Promise<Set<string>>} */
  async rejectedFingerprints(userId, memoryType) {
    const result = await this.#query("SELECT fingerprint FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2", [owner(userId), String(memoryType)]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.fingerprint)));
  }

  // -------------------------------------------------------------------- reset

  /**
   * 「重置记忆」: everything the overlay holds of the account's memories. The ledger of commits goes too — a conversation
   * that was already archived is not replayed into an account that asked to start from nothing.
   * @param {string} userId @returns {Promise<{ files: number, revisions: number, commits: number }>}
   */
  async purgeUser(userId) {
    const id = owner(userId);
    const files = await this.#query("DELETE FROM evimed_memory.native_files WHERE user_id=$1", [id]);
    const revisions = await this.#query("DELETE FROM evimed_memory.native_revisions WHERE user_id=$1", [id]);
    const commits = await this.#query("DELETE FROM evimed_memory.native_commits WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_sessions WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1", [id]);
    return { files: files.rowCount ?? 0, revisions: revisions.rowCount ?? 0, commits: commits.rowCount ?? 0 };
  }

  /** A project was deleted: what the overlay holds of its files and its conversations. @param {string} userId @param {string} projectId */
  async purgeProject(userId, projectId) {
    const id = owner(userId);
    const files = await this.#query("DELETE FROM evimed_memory.native_files WHERE user_id=$1 AND project_id=$2 RETURNING uri", [id, String(projectId)]);
    const uris = files.rows.map((/** @type {any} */ row) => String(row.uri));
    if (uris.length) {
      await this.#query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1 AND uri = ANY($2::text[])", [id, uris]);
      await this.#query("DELETE FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri = ANY($2::text[])", [id, uris]);
    }
    await this.#query("DELETE FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2", [id, String(projectId)]);
    await this.#query("DELETE FROM evimed_memory.native_sessions WHERE user_id=$1 AND project_id=$2", [id, String(projectId)]);
    return { files: uris };
  }
}
