import { createHash } from "node:crypto";
import { migrateMemorySettings } from "./memorySettingsPersistence.mjs";
import {
  NATIVE_COMMIT_ORIGINS, NATIVE_REVISION_ACTORS, NATIVE_REVISION_CHANGES, NATIVE_TEXT_LIMIT, migrateNativeMemory,
} from "./nativeMemoryPersistence.mjs";
import { platformSessionOf } from "./openVikingSessions.mjs";
import { HttpError } from "./security.mjs";

/** The catch-all project: it has no single subject, so its files are no project's (`residentProfile.mjs` names it the same). */
const CATCH_ALL_PROJECT_ID = "default";
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_PROJECT_MEMORY_TYPES, userRootUri } from './openVikingLayout.mjs';

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
 * A statement as it is compared: lower-cased, whitespace collapsed, without the trailing `(as of YYYY-MM-DD)` the profile template
 * writes. What `lineFingerprint` hashes, and what a rejected line keeps so that a reworded version can be recognised.
 * @param {unknown} line @returns {string}
 */
export function normalisedStatement(line) {
  return String(line ?? "").replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * What identifies one statement whatever it is dressed in: `normalisedStatement`, hashed. Exact equality after that and nothing
 * looser — whether two differently worded lines say the same thing is language, and is decided elsewhere
 * (`nativeMemoryRejections.mjs`: a containing line in code, a similar one by the model).
 * @param {unknown} line @returns {string} sha256 hex
 */
export function lineFingerprint(line) {
  return createHash("sha256").update(normalisedStatement(line)).digest("hex");
}

/** The platform's own label line in a memory file (a source that changed), which is never a statement (`nativeMemoryStore.SOURCE_LABEL_PREFIX`). */
const LABEL_LINE = /^>\s*来源变更：/;

/** @param {any} row */
function tombstoneRow(row) {
  return { archiveUri: String(row.archive_uri), engineSession: String(row.engine_session), taskId: row.task_id ?? null, resetAt: instant(row.reset_at), state: String(row.state) };
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

/** Callers supply only a root resolved by the trusted context registry. This
 * syntactic check keeps the SQL prefix literal; it is not namespace authority.
 */
function scopedRoot(value) {
  if (typeof value !== 'string' || !/^viking:\/\/user\/(?:u|gp)-[a-f0-9]{24}$/.test(value)) {
    throw new HttpError(403, 'memory_scope_denied', 'A canonical native memory root is required.');
  }
  return value;
}

/** Rejections share the existing table but never cross native namespaces. */
export function nativeMemoryRejectionType(memoryType, namespaceId = null) {
  if (!OPENVIKING_MEMORY_TYPES.includes(memoryType) || namespaceId !== null && !/^gp-[a-f0-9]{24}$/.test(namespaceId)) {
    throw new HttpError(403, 'memory_scope_denied', 'The memory rejection scope is invalid.');
  }
  return namespaceId === null ? memoryType : `${namespaceId}:${memoryType}`;
}

/** @param {any} row */
function publicCommit(row) {
  return {
    userId: String(row.user_id), archiveUri: String(row.archive_uri), engineSession: String(row.engine_session),
    projectId: row.project_id ?? null, origin: String(row.origin), taskId: row.task_id ?? null, state: String(row.state),
    operations: Number(row.operations) || 0, error: String(row.error ?? ""), attempts: Number(row.attempts) || 0,
    nextAttemptAt: instant(row.next_attempt_at), replayedAs: row.replayed_as ?? null, pendingText: row.pending_text ?? null,
    extraction: row.extraction && typeof row.extraction === "object" && !Array.isArray(row.extraction) ? row.extraction : {},
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
    lastRecalledAt: instant(row.last_recalled_at), recallCount: Number(row.recall_count) || 0,
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
    await migrateMemorySettings(this.database);
    await migrateNativeMemory(this.database);
    return this.database.query(text, values);
  }

  async migrate() { await this.#query("SELECT 1"); }

  /** External candidates are admitted once per immutable revision, before any extracting session is touched.
   * @param {string} userId @param {any} input */
  async queueAdmission(userId, input) {
    const result = await this.#query(`INSERT INTO evimed_memory.native_admissions
      (user_id,candidate_id,candidate_revision,engine_session,project_id,pending_text,account_created_at)
      SELECT id,$2,$3,$4,$5,$6,created_at FROM evimed_control.users WHERE id=$1
      ON CONFLICT (user_id,candidate_id,candidate_revision) DO UPDATE SET candidate_id=EXCLUDED.candidate_id
      RETURNING *`, [owner(userId), input.candidateId, input.revision, input.engineSession, input.projectId ?? null, input.text]);
    if (!result.rows[0]) throw new HttpError(404, "memory_admission_gone", "The account no longer exists.");
    return admissionRow(result.rows[0]);
  }

  /** @param {string} userId @param {string} candidateId @param {number} revision */
  async admission(userId, candidateId, revision) {
    const result = await this.#query(`SELECT a.* FROM evimed_memory.native_admissions a JOIN evimed_control.users u
      ON u.id=a.user_id AND u.created_at=a.account_created_at WHERE a.user_id=$1 AND a.candidate_id=$2 AND a.candidate_revision=$3`,
    [owner(userId), candidateId, revision]);
    return result.rows[0] ? admissionRow(result.rows[0]) : null;
  }

  /** A short lease serializes confirmations and worker recovery. Expired submissions are inspected, never blindly resent.
   * @param {string} userId @param {string} candidateId @param {number} revision */
  async claimAdmission(userId, candidateId, revision) {
    const result = await this.#query(`UPDATE evimed_memory.native_admissions a SET lease_until=clock_timestamp()+interval '2 minutes',
      updated_at=clock_timestamp() FROM evimed_control.users u WHERE a.user_id=$1 AND a.candidate_id=$2 AND a.candidate_revision=$3
      AND u.id=a.user_id AND u.created_at=a.account_created_at AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp()) RETURNING a.*`,
    [owner(userId), candidateId, revision]);
    return result.rows[0] ? admissionRow(result.rows[0]) : null;
  }

  /** @param {string} userId @param {string} candidateId @param {number} revision @param {any} patch */
  async updateAdmission(userId, candidateId, revision, patch) {
    const result = await this.#query(`UPDATE evimed_memory.native_admissions a SET
      state=COALESCE($4,state), phase=COALESCE($5,phase), archive_uri=COALESCE($6,archive_uri), task_id=COALESCE($7,task_id),
      record_ids=COALESCE($8::jsonb,record_ids),error=COALESCE($9,error),
      pending_text=CASE WHEN $4 IN ('completed','cancelled') THEN NULL ELSE pending_text END,
      lease_until=CASE WHEN $10 THEN NULL ELSE lease_until END,updated_at=clock_timestamp()
      FROM evimed_control.users u WHERE a.user_id=$1 AND a.candidate_id=$2 AND a.candidate_revision=$3
      AND u.id=a.user_id AND u.created_at=a.account_created_at RETURNING a.*`,
    [owner(userId), candidateId, revision, patch.state ?? null, patch.phase ?? null, patch.archiveUri ?? null, patch.taskId ?? null,
      patch.recordIds ? JSON.stringify(patch.recordIds) : null, patch.error ?? null, patch.release === true]);
    if (!result.rows[0]) throw new HttpError(404, "memory_admission_gone", "This admission no longer belongs to the account.");
    return admissionRow(result.rows[0]);
  }

  /** @param {string} userId */
  async openAdmissions(userId) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_admissions WHERE user_id=$1 AND state NOT IN ('completed','cancelled')
      ORDER BY created_at LIMIT 50`, [owner(userId)]);
    return result.rows.map(admissionRow);
  }

  /** Recheck the current owner, project and immutable candidate revision before extraction or a retry.
   * @param {string} userId @param {any} admission */
  async admissionAuthority(userId, admission) {
    // The settings row is optional (an account that never changed a switch has none), the account is not.
    const policy = await this.#query(`SELECT s.learning_paused,s.paused_projects FROM evimed_control.users u
      LEFT JOIN evimed_memory.settings s ON s.user_id=u.id WHERE u.id=$1`, [owner(userId)]);
    const settings = policy.rows[0];
    if (!settings) return { allowed: false, state: "cancelled", reason: "account_unavailable" };
    if (settings.learning_paused || (admission.projectId && (settings.paused_projects ?? []).includes(admission.projectId))) {
      return { allowed: false, state: "suspended", reason: "learning_paused" };
    }
    if (admission.projectId) {
      const project = await this.#query("SELECT 1 FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [userId, admission.projectId]);
      if (!project.rows.length) return { allowed: false, state: "cancelled", reason: "project_unavailable" };
    }
    // A candidate is a note of the capsule that an outside agent proposed; it is admitted only as the revision that was read.
    const found = await this.#query("SELECT revision,project_id,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND id=$2 AND deleted_at IS NULL", [userId, admission.candidateId]);
    const candidate = found.rows[0];
    if (!candidate || candidate.revision !== admission.revision || candidate.payload?.status !== "candidate"
      || candidate.payload?.transfer || candidate.project_id !== admission.projectId) {
      return { allowed: false, state: "cancelled", reason: "candidate_changed" };
    }
    return { allowed: true, state: null, reason: null };
  }

  /** A replay keeps the original candidate's authorization, including through the existing commit replay chain.
   * @param {string} userId @param {any} commit */
  async admissionOfCommit(userId, commit) {
    const result = await this.#query(`WITH RECURSIVE lineage AS (
      SELECT archive_uri,engine_session FROM evimed_memory.native_commits WHERE user_id=$1 AND archive_uri=$2
      UNION SELECT c.archive_uri,c.engine_session FROM evimed_memory.native_commits c JOIN lineage l ON c.replayed_as=l.archive_uri WHERE c.user_id=$1
    ) SELECT a.* FROM evimed_memory.native_admissions a JOIN lineage l ON a.engine_session=l.engine_session OR a.archive_uri=l.archive_uri
      WHERE a.user_id=$1 LIMIT 1`, [owner(userId), commit.archiveUri]);
    return result.rows[0] ? admissionRow(result.rows[0]) : null;
  }

  // ---------------------------------------------------------------- accounts

  /** @param {string} userId */
  async account(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_accounts WHERE user_id=$1", [owner(userId)]);
    const row = result.rows[0];
    return { registeredAt: instant(row?.registered_at), scannedAt: instant(row?.scanned_at) };
  }

  /**
   * The accounts the memory plane knows: every account with a row in one of the overlay's per-account tables — registered with the
   * engine by the gateway, the page or this worker, a conversation noted, a commit or an admission recorded. The worker's pass is over
   * these; an account none of them has ever touched has nothing in the engine to scan, to settle or to erase.
   * @param {{ limit?: number }} [options] @returns {Promise<string[]>}
   */
  async accounts({ limit = 100_000 } = {}) {
    const result = await this.#query(`SELECT user_id FROM (
        SELECT user_id FROM evimed_memory.native_accounts UNION SELECT user_id FROM evimed_memory.native_commits
        UNION SELECT user_id FROM evimed_memory.native_sessions UNION SELECT user_id FROM evimed_memory.native_admissions
      ) known ORDER BY user_id LIMIT $1`, [Math.max(1, Math.min(1_000_000, Math.trunc(Number(limit)) || 100_000))]);
    return result.rows.map((/** @type {any} */ row) => String(row.user_id));
  }

  /**
   * Whether the memory plane has ever touched this account (`accounts`): whether the engine can hold anything of it that a deletion
   * owes it. An account that never used memory is erased without asking the engine, so that a deletion does not depend on a service
   * the account never used.
   * @param {string} userId @returns {Promise<boolean>}
   */
  async touched(userId) {
    const result = await this.#query(`SELECT (EXISTS (SELECT 1 FROM evimed_memory.native_accounts WHERE user_id=$1)
        OR EXISTS (SELECT 1 FROM evimed_memory.native_commits WHERE user_id=$1)
        OR EXISTS (SELECT 1 FROM evimed_memory.native_sessions WHERE user_id=$1)
        OR EXISTS (SELECT 1 FROM evimed_memory.native_admissions WHERE user_id=$1)) AS held`, [owner(userId)]);
    return result.rows[0]?.held === true;
  }

  // ---------------------------------------------------------- consolidation

  /** What the account's consolidation (`nativeMemoryConsolidation.mjs`) has recorded. @param {string} userId */
  async consolidationState(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_accounts WHERE user_id=$1", [owner(userId)]);
    const row = result.rows[0];
    return {
      consolidatedAt: instant(row?.consolidated_at), checkedAt: instant(row?.consolidation_checked_at), fingerprint: /** @type {string | null} */ (row?.consolidation_fingerprint ?? null),
      task: /** @type {string | null} */ (row?.consolidation_task ?? null), startedAt: instant(row?.consolidation_started_at),
    };
  }

  /**
   * Take the account's consolidation for `leaseMs`, or learn that another worker holds it. A lease, not a lock: it runs out by itself.
   * @param {string} userId @param {number} leaseMs @returns {Promise<boolean>}
   */
  async claimConsolidation(userId, leaseMs) {
    const result = await this.#query(`INSERT INTO evimed_memory.native_accounts AS a (user_id, consolidation_lease_until) VALUES ($1, clock_timestamp() + ($2::int * interval '1 millisecond'))
      ON CONFLICT (user_id) DO UPDATE SET consolidation_lease_until = clock_timestamp() + ($2::int * interval '1 millisecond')
        WHERE a.consolidation_lease_until IS NULL OR a.consolidation_lease_until < clock_timestamp()
      RETURNING user_id`, [owner(userId), Math.max(1_000, Math.min(3_600_000, Math.trunc(Number(leaseMs)) || 60_000))]);
    return result.rows.length === 1;
  }

  /** The files were looked at at `at` and nothing was asked of the engine; the lease is let go. @param {string} userId @param {Date} at */
  async noteConsolidationChecked(userId, at) {
    await this.#query(`INSERT INTO evimed_memory.native_accounts (user_id, consolidation_checked_at) VALUES ($1, $2::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET consolidation_checked_at=$2::timestamptz, consolidation_lease_until=NULL, updated_at=date_trunc('second', clock_timestamp())`, [owner(userId), at.toISOString()]);
  }

  /** A consolidation is in the engine's hands: its task, and the lease let go. @param {string} userId @param {string} taskId @param {Date} at */
  async noteConsolidationSubmitted(userId, taskId, at) {
    await this.#query(`INSERT INTO evimed_memory.native_accounts (user_id, consolidation_task, consolidation_started_at, consolidation_checked_at) VALUES ($1, $2, $3::timestamptz, $3::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET consolidation_task=$2, consolidation_started_at=$3::timestamptz, consolidation_checked_at=$3::timestamptz, consolidation_lease_until=NULL,
        updated_at=date_trunc('second', clock_timestamp())`, [owner(userId), String(taskId), at.toISOString()]);
  }

  /**
   * The task is over and its files are read in. `fingerprint` is the shape of what it left (the next consolidation waits for a change
   * from it); a run that did not succeed records neither it nor a time of completion, and is asked again at the next due time.
   * @param {string} userId @param {{ fingerprint?: string | null, succeeded: boolean, at: Date }} outcome
   */
  async noteConsolidationDone(userId, { fingerprint = null, succeeded, at }) {
    await this.#query(`UPDATE evimed_memory.native_accounts SET consolidation_task=NULL, consolidation_started_at=NULL, consolidation_lease_until=NULL,
        consolidation_checked_at=$4::timestamptz, consolidated_at=CASE WHEN $2 THEN $4::timestamptz ELSE consolidated_at END,
        consolidation_fingerprint=CASE WHEN $2 THEN $3 ELSE consolidation_fingerprint END, updated_at=date_trunc('second', clock_timestamp())
      WHERE user_id=$1`, [owner(userId), succeeded === true, fingerprint, at.toISOString()]);
  }

  /** @param {string} userId @param {"registered_at" | "scanned_at"} column */
  async #stamp(userId, column) {
    await this.#query(`INSERT INTO evimed_memory.native_accounts (user_id, ${column}) VALUES ($1, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET ${column}=clock_timestamp(), updated_at=date_trunc('second', clock_timestamp())`, [owner(userId)]);
  }
  /** The engine's admin routes know this account from now on. @param {string} userId */
  noteRegistered(userId) { return this.#stamp(userId, "registered_at"); }
  /** @param {string} userId */
  noteScanned(userId) { return this.#stamp(userId, "scanned_at"); }

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

  /** Every commit the ledger holds of one engine session, oldest first. @param {string} userId @param {string} engineSession */
  async commitsOfSession(userId, engineSession, { userRoot = userRootUri(userId) } = {}) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND engine_session=$2 AND archive_uri LIKE $3 || '/sessions/%' ORDER BY created_at",
      [owner(userId), String(engineSession), scopedRoot(userRoot)]);
    return result.rows.map(publicCommit);
  }

  /** The archives of one account the ledger already holds. @param {string} userId @returns {Promise<Set<string>>} */
  async knownArchives(userId, { userRoot = null } = {}) {
    const result = await this.#query("SELECT archive_uri FROM evimed_memory.native_commits WHERE user_id=$1 AND ($2::text IS NULL OR archive_uri LIKE $2 || '/sessions/%')",
      [owner(userId), userRoot == null ? null : scopedRoot(userRoot)]);
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
  async pendingCommits(userId, { origins = ["page"], limit = 20, userRoot = null } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND state IN ('pending', 'failed') AND origin = ANY($2::text[])
      AND ($4::text IS NULL OR archive_uri LIKE $4 || '/sessions/%')
      ORDER BY created_at DESC LIMIT $3`, [owner(userId), origins, limit, userRoot == null ? null : scopedRoot(userRoot)]);
    return result.rows.map(publicCommit);
  }

  /**
   * @param {string} userId @param {string} archiveUri
   * @param {{ operations?: number, extraction?: Record<string, any> | null }} [outcome] `extraction`: what the engine said the
   *   extraction did (`extractionFacts`), kept as it came; absent, the row keeps what it had
   */
  async completeCommit(userId, archiveUri, { operations = 0, extraction = null } = {}) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='completed', operations=$3, error='', next_attempt_at=NULL, pending_text=NULL,
      extraction=COALESCE($4::jsonb, extraction), ingested_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri=$2 AND state IN ('pending', 'failed')`,
    [owner(userId), String(archiveUri), Math.max(0, Math.trunc(Number(operations)) || 0), extraction ? JSON.stringify(extraction) : null]);
  }

  /**
   * What the extraction of an already settled commit said about itself, filled in after the fact (the operator's report
   * reading an archive the worker settled before the ledger kept it). A row that has it is left alone.
   * @param {string} userId @param {string} archiveUri @param {Record<string, any>} extraction @returns {Promise<boolean>} whether a row was filled
   */
  async setExtraction(userId, archiveUri, extraction) {
    const result = await this.#query(`UPDATE evimed_memory.native_commits SET extraction=$3::jsonb, updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri=$2 AND state='completed' AND extraction='{}'::jsonb`, [owner(userId), String(archiveUri), JSON.stringify(extraction ?? {})]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The commits of one account, newest first: what an operator reads to see what each one did.
   * @param {string} userId @param {{ limit?: number, since?: Date | string | null }} [options]
   */
  async commitsOf(userId, { limit = 50, since = null } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at DESC LIMIT $2`, [owner(userId), Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 50)), since ? new Date(since).toISOString() : null]);
    return result.rows.map(publicCommit);
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

  /**
   * What the person (or a conversation, at the person's word) forgot and can still take back, newest first: a deleted file whose text was
   * kept for the undo, and a profile edit that took lines out for the same reason. A hard delete keeps no text and is not here, nor is
   * what the platform's own checks removed, nor a forget that was already undone.
   * @param {string} userId @param {{ limit?: number }} [options]
   */
  async forgottenRevisions(userId, { limit = 300 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_revisions
      WHERE user_id=$1 AND undone_at IS NULL AND actor IN ('user', 'conversation') AND before IS NOT NULL
        AND ((change = 'deleted') OR (change = 'updated' AND after IS NOT NULL AND reason LIKE 'forgotten on the memory page%'))
      ORDER BY id DESC LIMIT $2`, [owner(userId), Math.max(1, Math.min(1_000, Math.trunc(Number(limit)) || 300))]);
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

  /** What changed by itself since a moment, newest first. A bare session retains
   * personal-engine semantics; project callers pass their registered root.
   * @param {string} userId @param {{ since?: string | null, engineSession?: string | null, actors?: string[], limit?: number, userRoot?: string | null }} [options] */
  async recentRevisions(userId, { since = null, engineSession = null, actors = ["engine"], limit = 20, userRoot = engineSession == null ? null : userRootUri(userId) } = {}) {
    const root = engineSession != null || userRoot != null ? scopedRoot(userRoot) : null;
    const result = await this.#query(`SELECT * FROM evimed_memory.native_revisions
      WHERE user_id=$1 AND ($2::timestamptz IS NULL OR changed_at > $2) AND ($3::text IS NULL OR engine_session = $3) AND actor = ANY($4::text[])
        AND undone_at IS NULL AND ($6::text IS NULL OR uri LIKE $6 || '/%')
      ORDER BY id DESC LIMIT $5`, [owner(userId), since, engineSession, actors, Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 20)), root]);
    return result.rows.map(publicRevision);
  }

  /** Exact admission lineage is not the dashboard's bounded recent-changes list.
   * @param {string} userId @param {string} archiveUri */
  async admissionRevisions(userId, archiveUri) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND archive_uri=$2 ORDER BY id", [owner(userId), archiveUri]);
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
    await this.#query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri=$2", [owner(userId), String(uri)]);
  }

  /** The account's observation files (`observations/…`): notes kept to see whether a choice comes back, never listed as memories. @param {string} userId */
  async observationFiles(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_files WHERE user_id=$1 AND memory_type='observations' ORDER BY updated_at", [owner(userId)]);
    return result.rows.map(publicFile);
  }

  /**
   * Which platform conversation an engine session's writes came from: the session of the plugin (`dsh-<conversation>`), or, for a
   * replay of a failed extraction (a new session holding the messages of the old one), the conversation of the commit it replays, however
   * many replays deep. Null for anything that is no conversation (the page's own sessions, an outside agent's candidate).
   * @param {string} userId @param {string | null} engineSession @param {string | null} [archiveUri] the archive the write came from
   * @returns {Promise<string | null>}
   */
  async conversationOf(userId, engineSession, archiveUri = null) {
    let session = engineSession ? String(engineSession) : null;
    let archive = archiveUri ? String(archiveUri) : null;
    for (let depth = 0; session && depth < 12; depth += 1) {
      const conversation = platformSessionOf(session);
      if (conversation) return conversation;
      if (!session.startsWith("evimed-replay-") || !archive) return null;
      const parent = await this.#query("SELECT engine_session, archive_uri FROM evimed_memory.native_commits WHERE user_id=$1 AND replayed_as=$2 LIMIT 1", [owner(userId), archive]);
      if (!parent.rows[0]) return null;
      session = String(parent.rows[0].engine_session);
      archive = String(parent.rows[0].archive_uri);
    }
    return null;
  }

  // ------------------------------------------------------------ line origins

  /**
   * Keep the per-line origin index of one file in step with its text: a line that is no longer in `after` loses its row, and — when an
   * `origin` is given — each line `after` has and `before` did not is recorded as brought by it (the first row of a line stays: the
   * line's source is the first commit that brought it). With no `origin` (the person's own edit, a restore, a platform check) lines only leave.
   * @param {string} userId @param {string} uri
   * @param {{ after: string, before?: string, origin?: { revisionId?: string | number | null, engineSession?: string | null, archiveUri?: string | null, projectId?: string | null, at?: string | null } | null }} change
   */
  async syncOrigins(userId, uri, { after, before = "", origin = null }) {
    const prints = (/** @type {string} */ text) => [...new Set(memoryLines(String(text ?? "").split("\n").filter((line) => !LABEL_LINE.test(line.trim())).join("\n")).map(lineFingerprint))];
    const present = prints(after);
    await this.#query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri=$2 AND NOT (fingerprint = ANY($3::text[]))", [owner(userId), String(uri), present]);
    if (!origin) return;
    const had = new Set(prints(before));
    const brought = present.filter((print) => !had.has(print));
    if (!brought.length) return;
    await this.#query(`INSERT INTO evimed_memory.native_line_origins (user_id, uri, fingerprint, revision_id, engine_session, archive_uri, project_id, added_at)
      SELECT $1, $2, print, $4::bigint, $5, $6, $7, COALESCE($8::timestamptz, clock_timestamp()) FROM unnest($3::text[]) AS brought(print)
      ON CONFLICT (user_id, uri, fingerprint) DO NOTHING`,
    [owner(userId), String(uri), brought, origin.revisionId == null ? null : String(origin.revisionId), origin.engineSession ?? null, origin.archiveUri ?? null, origin.projectId ?? null, origin.at ?? null]);
  }

  /**
   * The origins of the lines of these files, by file and line fingerprint.
   * @param {string} userId @param {readonly string[]} uris
   * @returns {Promise<Map<string, Map<string, { revisionId: string | null, engineSession: string | null, archiveUri: string | null, projectId: string | null, addedAt: string | null }>>>}
   */
  async originsOf(userId, uris) {
    /** @type {Map<string, Map<string, any>>} */
    const byUri = new Map();
    if (!uris.length) return byUri;
    const result = await this.#query("SELECT * FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri = ANY($2::text[])", [owner(userId), [...uris]]);
    for (const row of result.rows) {
      const lines = byUri.get(String(row.uri)) ?? new Map();
      lines.set(String(row.fingerprint), { revisionId: row.revision_id == null ? null : String(row.revision_id), engineSession: row.engine_session ?? null,
        archiveUri: row.archive_uri ?? null, projectId: row.project_id ?? null, addedAt: instant(row.added_at) });
      byUri.set(String(row.uri), lines);
    }
    return byUri;
  }

  /** Whether the account's older revisions were read into the origin index, and the mark that they were. @param {string} userId */
  async originsIndexed(userId) {
    const result = await this.#query("SELECT origins_indexed_at FROM evimed_memory.native_accounts WHERE user_id=$1", [owner(userId)]);
    return Boolean(result.rows[0]?.origins_indexed_at);
  }

  /** @param {string} userId */
  async noteOriginsIndexed(userId) {
    await this.#query(`INSERT INTO evimed_memory.native_accounts (user_id, origins_indexed_at) VALUES ($1, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET origins_indexed_at=clock_timestamp()`, [owner(userId)]);
  }

  /** Every revision of one account, oldest first, for the one-time read into the origin index. @param {string} userId @param {{ afterId?: string, limit?: number }} [options] */
  async revisionsForIndex(userId, { afterId = "0", limit = 500 } = {}) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND id > $2::bigint AND undone_at IS NULL ORDER BY id LIMIT $3",
      [owner(userId), /^\d{1,18}$/.test(String(afterId)) ? String(afterId) : "0", Math.max(1, Math.min(2_000, limit))]);
    return result.rows.map(publicRevision);
  }

  // ------------------------------------------------------------ last recalled

  /**
   * A memory search or read through the gateway returned these files: their `last_recalled_at` moves to now and `recall_count` by one.
   * A file the overlay holds no row of is not made one here. For a later decision about retention (owner decision 6 of 2026-10-25 leaves
   * the period unset): nothing reads it for behaviour.
   * @param {string} userId @param {readonly string[]} uris @returns {Promise<number>} files noted
   */
  async noteRecalled(userId, uris) {
    const unique = [...new Set(uris.map(String))].slice(0, 50);
    if (!unique.length) return 0;
    const result = await this.#query(`UPDATE evimed_memory.native_files SET last_recalled_at=clock_timestamp(), recall_count=recall_count+1
      WHERE user_id=$1 AND uri = ANY($2::text[])`, [owner(userId), unique]);
    return result.rowCount ?? 0;
  }

  // -------------------------------------------------------- reset tombstones

  /**
   * A reset found these commits not finished: whatever the engine writes from them after the reset is taken out again, however late.
   * @param {string} userId @param {readonly { archiveUri: string, engineSession: string, taskId?: string | null }[]} commits @param {Date} resetAt
   */
  async tombstoneCommits(userId, commits, resetAt) {
    for (const commit of commits.slice(0, 500)) {
      await this.#query(`INSERT INTO evimed_memory.native_reset_tombstones (user_id, archive_uri, engine_session, task_id, reset_at) VALUES ($1, $2, $3, $4, $5::timestamptz)
        ON CONFLICT (user_id, archive_uri) DO NOTHING`, [owner(userId), String(commit.archiveUri).slice(0, 600), String(commit.engineSession), commit.taskId ?? null, resetAt.toISOString()]);
    }
  }

  /** @param {string} userId @returns {Promise<{ archiveUri: string, engineSession: string, taskId: string | null, resetAt: string | null, state: string }[]>} */
  async openTombstones(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_reset_tombstones WHERE user_id=$1 AND state='open' ORDER BY created_at LIMIT 200", [owner(userId)]);
    return result.rows.map(tombstoneRow);
  }

  /** The tombstone of one archive, in any state, or null. @param {string} userId @param {string} archiveUri */
  async tombstone(userId, archiveUri) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_reset_tombstones WHERE user_id=$1 AND archive_uri=$2", [owner(userId), String(archiveUri)]);
    return result.rows[0] ? tombstoneRow(result.rows[0]) : null;
  }

  /** @param {string} userId @param {string} archiveUri @param {"swept" | "unknown"} state @param {number} [removed] */
  async closeTombstone(userId, archiveUri, state, removed = 0) {
    await this.#query("UPDATE evimed_memory.native_reset_tombstones SET state=$3, removed=$4, updated_at=clock_timestamp() WHERE user_id=$1 AND archive_uri=$2",
      [owner(userId), String(archiveUri), state, Math.max(0, Math.trunc(removed))]);
  }

  /** The accounts with a tombstone still open: the worker visits them even when nothing else of them is known. @returns {Promise<string[]>} */
  async accountsWithOpenTombstones() {
    const result = await this.#query("SELECT DISTINCT user_id FROM evimed_memory.native_reset_tombstones WHERE state='open' LIMIT 1000");
    return result.rows.map((/** @type {any} */ row) => String(row.user_id));
  }

  // ----------------------------------------------------------------- imports

  /**
   * What the page's import split out of a pasted text, held for the person to review. `statements` are `{ id, text, tier, offered, ticked }`.
   * @param {string} userId @param {{ id: string, statements: any[], leftOut: number, ttlMs?: number }} offer
   */
  async createImport(userId, { id, statements, leftOut, ttlMs = 3_600_000 }) {
    await this.#query(`INSERT INTO evimed_memory.native_imports (id, user_id, statements, left_out, expires_at)
      VALUES ($1, $2, $3::jsonb, $4, clock_timestamp() + ($5::int * interval '1 millisecond'))`, [id, owner(userId), JSON.stringify(statements), Math.max(0, leftOut), Math.max(60_000, Math.trunc(ttlMs))]);
  }

  /** @param {string} userId @param {string} id @returns {Promise<{ id: string, statements: any[], leftOut: number, state: string, saved: number, createdAt: string | null, expired: boolean } | null>} */
  async importOffer(userId, id) {
    const result = await this.#query("SELECT *, (expires_at < clock_timestamp()) AS expired FROM evimed_memory.native_imports WHERE user_id=$1 AND id=$2", [owner(userId), String(id)]);
    const row = result.rows[0];
    return row ? { id: String(row.id), statements: Array.isArray(row.statements) ? row.statements : [], leftOut: Number(row.left_out) || 0, state: String(row.state), saved: Number(row.saved) || 0,
      createdAt: instant(row.created_at), expired: row.expired === true } : null;
  }

  /**
   * Take the offer for saving, once: the statements are dropped from the row and it reads `saved`. A second caller gets nothing.
   * @param {string} userId @param {string} id @param {number} saved @returns {Promise<boolean>}
   */
  async markImportSaved(userId, id, saved) {
    const result = await this.#query(`UPDATE evimed_memory.native_imports SET state='saved', saved=$3, statements='[]'::jsonb
      WHERE user_id=$1 AND id=$2 AND state='offered' AND expires_at >= clock_timestamp()`, [owner(userId), String(id), Math.max(0, Math.trunc(saved))]);
    return (result.rowCount ?? 0) === 1;
  }

  /** How many offers the account made since `since`: the import's own rate limit. @param {string} userId @param {Date} since */
  async importsSince(userId, since) {
    const result = await this.#query("SELECT count(*)::int AS n FROM evimed_memory.native_imports WHERE user_id=$1 AND created_at >= $2::timestamptz", [owner(userId), since.toISOString()]);
    return Number(result.rows[0]?.n) || 0;
  }

  /** Offers past their hour are deleted, saved ones after a day (what was saved is the engine's now). @returns {Promise<number>} */
  async deleteExpiredImports() {
    const result = await this.#query("DELETE FROM evimed_memory.native_imports WHERE expires_at < clock_timestamp() - interval '1 day' OR (state='offered' AND expires_at < clock_timestamp())");
    return result.rowCount ?? 0;
  }

  /** Complete bounded sensitive-file set. Overflow refuses recall rather than silently dropping exclusions. @param {string} userId */
  async sensitiveUris(userId, limit = 10000) {
    const bound = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 10000));
    const result = await this.#query("SELECT uri FROM evimed_memory.native_files WHERE user_id=$1 AND sensitive ORDER BY uri LIMIT $2",
      [owner(userId), bound + 1]);
    if (result.rows.length > bound) throw new HttpError(503, "memory_index_listing_too_large", "The complete sensitive-file set exceeds its safe recall bound.");
    return result.rows.map((/** @type {any} */ row) => String(row.uri));
  }

  /**
   * The files of a project type (card, decisions, working facts, open items, recent work) that belong to a named project other than
   * `projectId`: what a conversation of `projectId` does not read (a project's rules and facts are its own, 2026-10-27). The catch-all
   * project's files are no project's and stay readable everywhere; a conversation in the catch-all reads no named project's.
   * @param {string} userId @param {string} projectId @param {number} [limit]
   * @returns {Promise<string[]>}
   */
  async otherProjectUris(userId, projectId, limit = 10000) {
    const bound = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 10000));
    const result = await this.#query(`SELECT uri FROM evimed_memory.native_files WHERE user_id=$1 AND memory_type=ANY($2::text[])
      AND project_id IS NOT NULL AND project_id<>$3 AND project_id<>$4 ORDER BY uri LIMIT $5`,
    [owner(userId), [...OPENVIKING_PROJECT_MEMORY_TYPES], String(projectId ?? ""), CATCH_ALL_PROJECT_ID, bound + 1]);
    if (result.rows.length > bound) throw new HttpError(503, "memory_index_listing_too_large", "The complete set of other projects' files exceeds its safe recall bound.");
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
  async projectOfSession(userId, engineSession, { userRoot = userRootUri(userId) } = {}) {
    const root = scopedRoot(userRoot);
    const result = await this.#query(`SELECT project_id FROM (
        SELECT project_id, 0 AS rank, created_at FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2 AND $4::boolean
        UNION ALL SELECT project_id, 1, created_at FROM evimed_memory.native_commits WHERE user_id=$1 AND engine_session=$2 AND archive_uri LIKE $3 || '/sessions/%') found
      WHERE project_id IS NOT NULL ORDER BY rank, created_at DESC LIMIT 1`, [owner(userId), String(engineSession), root, root === userRootUri(userId)]);
    return result.rows[0]?.project_id ?? null;
  }

  /**
   * The project each of these engine sessions was held in, as the gateway noted it when the session began, else as the commits of
   * it recorded. A session with no project (or one the overlay never saw) is absent.
   * @param {string} userId @param {readonly string[]} engineSessions @returns {Promise<Map<string, string>>}
   */
  async sessionProjects(userId, engineSessions) {
    /** @type {Map<string, string>} */
    const found = new Map();
    const names = [...new Set(engineSessions.map(String))].slice(0, 500);
    if (!names.length) return found;
    const result = await this.#query(`SELECT DISTINCT ON (engine_session) engine_session, project_id FROM (
        SELECT engine_session, project_id, 0 AS rank, created_at FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session = ANY($2::text[])
        UNION ALL SELECT engine_session, project_id, 1, created_at FROM evimed_memory.native_commits WHERE user_id=$1 AND engine_session = ANY($2::text[])) rows
      WHERE project_id IS NOT NULL ORDER BY engine_session, rank, created_at DESC`, [owner(userId), names]);
    for (const row of result.rows) found.set(String(row.engine_session), String(row.project_id));
    return found;
  }

  /** The engine sessions of one project, as the gateway and the ledger saw them. @param {string} userId @param {string} projectId @returns {Promise<string[]>} */
  async projectSessions(userId, projectId, { userRoot = userRootUri(userId) } = {}) {
    const root = scopedRoot(userRoot);
    const result = await this.#query(`SELECT engine_session FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2 AND archive_uri LIKE $3 || '/sessions/%'
      UNION SELECT engine_session FROM evimed_memory.native_sessions WHERE user_id=$1 AND project_id=$2 AND $4::boolean`,
    [owner(userId), String(projectId), root, root === userRootUri(userId)]);
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

  /**
   * The person removed these lines from a memory of this type. Each is kept as its fingerprint (exact repeats) and as its normalised
   * text (`normalisedStatement`, at most 400 characters), because recognising a reworded repeat needs the words: a line that contains
   * it, or that a model judges to say the same, is taken out again. The text is the account's own, read by nothing but that
   * recognition, and goes with the rejection (a restatement by the person, a reset, the account).
   * @param {string} userId @param {string} memoryType @param {string} uri @param {readonly string[]} lines
   */
  async reject(userId, memoryType, uri, lines) {
    /** @type {Map<string, string>} */
    const unique = new Map();
    for (const line of lines) { const print = lineFingerprint(line); if (!unique.has(print)) unique.set(print, normalisedStatement(line).slice(0, 400)); }
    const prints = [...unique.keys()].slice(0, 500);
    if (!prints.length) return 0;
    await this.#query(`INSERT INTO evimed_memory.native_rejections (user_id, memory_type, fingerprint, uri, text)
      SELECT $1, $2, print, $3, text FROM unnest($4::text[], $5::text[]) AS rejected(print, text)
      ON CONFLICT (user_id, memory_type, fingerprint) DO UPDATE SET rejected_at=clock_timestamp(), text=COALESCE(EXCLUDED.text, evimed_memory.native_rejections.text)`,
    [owner(userId), String(memoryType), String(uri).slice(0, 600), prints, prints.map((print) => unique.get(print) ?? "")]);
    return prints.length;
  }

  /** The person wrote these lines themselves: they are no longer something to remove. */
  async unreject(userId, memoryType, lines) {
    const prints = [...new Set(lines.map(lineFingerprint))];
    if (!prints.length) return;
    await this.#query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2 AND fingerprint = ANY($3::text[])", [owner(userId), String(memoryType), prints]);
  }

  /** One rejection lifted by its fingerprint: the person said the same again in their own words. @param {string} userId @param {string} memoryType @param {readonly string[]} fingerprints */
  async unrejectFingerprints(userId, memoryType, fingerprints) {
    const prints = [...new Set(fingerprints.map(String))].filter((print) => /^[a-f0-9]{64}$/.test(print));
    if (!prints.length) return;
    await this.#query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2 AND fingerprint = ANY($3::text[])", [owner(userId), String(memoryType), prints]);
  }

  /**
   * The lines the person removed from memories of this type, with the words each had when there are any (a rejection made before the
   * words were kept has only its fingerprint and can only be met by an exact repeat). Newest first.
   * @param {string} userId @param {string} memoryType @param {{ limit?: number }} [options] @returns {Promise<{ fingerprint: string, text: string | null }[]>}
   */
  async rejectedLines(userId, memoryType, { limit = 300 } = {}) {
    const result = await this.#query("SELECT fingerprint, text FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2 ORDER BY rejected_at DESC LIMIT $3",
      [owner(userId), String(memoryType), Math.max(1, Math.min(1_000, Math.trunc(Number(limit)) || 300))]);
    return result.rows.map((/** @type {any} */ row) => ({ fingerprint: String(row.fingerprint), text: typeof row.text === "string" && row.text ? row.text : null }));
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
    await this.#query("DELETE FROM evimed_memory.native_admissions WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_sessions WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1", [id]);
    await this.#query("DELETE FROM evimed_memory.native_imports WHERE user_id=$1", [id]);
    // The tombstones stay: they are what a reset leaves behind on purpose, for the extraction it could not wait for.
    return { files: files.rowCount ?? 0, revisions: revisions.rowCount ?? 0, commits: commits.rowCount ?? 0 };
  }

  /** One registered project namespace was removed from the engine. The caller
   * resolves its authority before invoking this URI-scoped cleanup; the public
   * project id and native session name are deliberately not deletion keys.
   */
  async purgeNamespace(userId, userRoot) {
    const id = owner(userId), root = scopedRoot(userRoot);
    if (!root.startsWith('viking://user/gp-')) throw new HttpError(403, 'memory_scope_denied', 'Only a registered project namespace may be purged here.');
    await this.migrate();
    return this.database.transaction(async client => {
      const values = [id, root];
      const files = await client.query("DELETE FROM evimed_memory.native_files WHERE user_id=$1 AND uri LIKE $2 || '/%'", values);
      const revisions = await client.query("DELETE FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri LIKE $2 || '/%'", values);
      const commits = await client.query("DELETE FROM evimed_memory.native_commits WHERE user_id=$1 AND archive_uri LIKE $2 || '/sessions/%'", values);
      await client.query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1 AND uri LIKE $2 || '/%'", values);
      await client.query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri LIKE $2 || '/%'", values);
      await client.query("DELETE FROM evimed_memory.native_rejections WHERE user_id=$1 AND (uri LIKE $2 || '/%' OR memory_type LIKE $3 || ':%')", [id, root, root.split('/').at(-1)]);
      return { files: files.rowCount ?? 0, revisions: revisions.rowCount ?? 0, commits: commits.rowCount ?? 0 };
    });
  }

  /** The personal engine's legacy project tags. Registered project namespaces
   * have their own exact cleanup and cannot be selected by a reused public id.
   * @param {string} userId @param {string} projectId
   */
  async purgeProject(userId, projectId) {
    const id = owner(userId), values = [id, String(projectId), userRootUri(userId)];
    await this.migrate();
    return this.database.transaction(async client => {
      const files = await client.query("DELETE FROM evimed_memory.native_files WHERE user_id=$1 AND project_id=$2 AND uri LIKE $3 || '/memories/%' RETURNING uri", values);
      const uris = files.rows.map((/** @type {any} */ row) => String(row.uri));
      if (uris.length) {
        await client.query("DELETE FROM evimed_memory.native_sources WHERE user_id=$1 AND uri = ANY($2::text[])", [id, uris]);
        await client.query("DELETE FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri = ANY($2::text[])", [id, uris]);
        await client.query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri = ANY($2::text[])", [id, uris]);
      }
      await client.query("DELETE FROM evimed_memory.native_revisions WHERE user_id=$1 AND project_id=$2 AND uri LIKE $3 || '/memories/%'", values);
      // The external-memory admissions of the project's notes (2026-10-23): personal-engine rows, labelled with the project only.
      await client.query("DELETE FROM evimed_memory.native_admissions WHERE user_id=$1 AND project_id=$2", values.slice(0, 2));
      await client.query("DELETE FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2 AND archive_uri LIKE $3 || '/sessions/%'", values);
      await client.query("DELETE FROM evimed_memory.native_sessions WHERE user_id=$1 AND project_id=$2", values.slice(0, 2));
      return { files: uris };
    });
  }
}

/** @param {any} row */
function admissionRow(row) {
  return { userId: row.user_id, candidateId: row.candidate_id, revision: row.candidate_revision,
    engineSession: row.engine_session, projectId: row.project_id, text: row.pending_text,
    state: row.state, phase: row.phase, archiveUri: row.archive_uri, taskId: row.task_id,
    recordIds: row.record_ids ?? [], error: row.error, createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}
