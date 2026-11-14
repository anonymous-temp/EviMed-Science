import { personalMemoryTravels } from './openVikingLayout.mjs';
import { createHash, randomUUID } from "node:crypto";
import { migrateMemorySettings } from "./memorySettingsPersistence.mjs";
import {
  NATIVE_COMMIT_ORIGINS, NATIVE_REVISION_ACTORS, NATIVE_REVISION_CHANGES, NATIVE_TEXT_LIMIT, migrateNativeMemory,
} from "./nativeMemoryPersistence.mjs";
import { platformSessionOf } from "./openVikingSessions.mjs";
import { HttpError } from "./security.mjs";

/** The catch-all project: it has no single subject, so its files are no project's (`residentProfile.mjs` names it the same). */
const CATCH_ALL_PROJECT_ID = "default";
import { OPENVIKING_KNOWN_MEMORY_TYPES, OPENVIKING_PROJECT_MEMORY_TYPES, userRootUri } from './openVikingLayout.mjs';

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

/** The original conversation set behind one line, flattened when a merge inherits it. @param {any} origin @returns {any[]} */
export function originalSources(origin) {
  return origin ? Array.isArray(origin.sources) && origin.sources.length ? origin.sources : [origin] : [];
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
  if (!OPENVIKING_KNOWN_MEMORY_TYPES.includes(memoryType) || namespaceId !== null && !/^gp-[a-f0-9]{24}$/.test(namespaceId)) {
    throw new HttpError(403, 'memory_scope_denied', 'The memory rejection scope is invalid.');
  }
  return namespaceId === null ? memoryType : `${namespaceId}:${memoryType}`;
}

/** @param {any} row */
function publicCommit(row) {
  return {
    userId: String(row.user_id), archiveUri: String(row.archive_uri), engineSession: String(row.engine_session),
    projectId: row.project_id ?? null, projectCreatedAt:row.project_created_at??null, ...(row.source_session?{sourceSession:row.source_session}:{}), origin: String(row.origin), taskId: row.task_id ?? null, state: String(row.state),
    operations: Number(row.operations) || 0, error: String(row.error ?? ""), attempts: Number(row.attempts) || 0,
    nextAttemptAt: instant(row.next_attempt_at), replayedAs: row.replayed_as ?? null, pendingText: row.pending_text ?? null,
    extraction: row.extraction && typeof row.extraction === "object" && !Array.isArray(row.extraction) ? row.extraction : {},
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), ingestedAt: instant(row.ingested_at), nativeIngestedAt: instant(row.native_ingested_at),
  };
}

/** @param {any} row */
function publicRevision(row) {
  return {
    id: String(row.id), uri: String(row.uri), memoryType: String(row.memory_type), change: String(row.change), actor: String(row.actor),
    reason: String(row.reason ?? ""), before: row.before ?? null, after: row.after ?? null, archiveUri: row.archive_uri ?? null,
    engineSession: row.engine_session ?? null, projectId: row.project_id ?? null, sourceProjectId:row.source_project_id??null, sourceProjectCreatedAt:row.source_project_created_at??null, undoneAt: instant(row.undone_at), changedAt: instant(row.changed_at),
  };
}

/** @param {any} row */
function publicFile(row) {
  return {
    uri: String(row.uri), memoryType: String(row.memory_type), projectId: row.project_id ?? null, sensitive: row.sensitive === true,
    contentHash: row.content_hash ?? null, body: row.body ?? null, labels: Array.isArray(row.labels) ? row.labels : [],
    lastRecalledAt: instant(row.last_recalled_at), recallCount: Number(row.recall_count) || 0,
    lastUsedAt: instant(row.last_used_at), usedCount: Number(row.used_count) || 0,
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at),
  };
}

/** Query-only original-authorship resolver, shared by the worker ledger and read-only archive replay. */
export async function readNativeMemoryOriginalSources(query, userId, archiveUris) {
    if (!archiveUris.length) return [];
    const result = await query(`WITH RECURSIVE edges AS (
      SELECT replayed_as AS child,archive_uri AS parent FROM evimed_memory.native_commits WHERE user_id=$1 AND replayed_as IS NOT NULL
      UNION SELECT copy_archive_uri,source_archive_uri FROM evimed_memory.native_source_copies WHERE user_id=$1
    ), lineage(uri) AS (
      SELECT unnest($2::text[]) UNION SELECT e.parent FROM edges e JOIN lineage l ON e.child=l.uri
    ) SELECT l.uri AS archive_uri,c.engine_session,c.project_id,c.project_created_at FROM lineage l
      LEFT JOIN evimed_memory.native_commits c ON c.user_id=$1 AND c.archive_uri=l.uri
      WHERE NOT EXISTS(SELECT 1 FROM edges e WHERE e.child=l.uri)
      AND COALESCE(c.origin,'') NOT IN ('promotion','replay','tool')
      AND COALESCE(c.engine_session,'') NOT LIKE 'mcp-store-%'
      AND NOT EXISTS(SELECT 1 FROM evimed_memory.native_admissions a WHERE a.user_id=$1
        AND (a.archive_uri=l.uri OR a.engine_session=c.engine_session))`, [owner(userId), archiveUris]);
    return result.rows.map(row => ({ archiveUri: row.archive_uri, engineSession: row.engine_session,
      projectId: row.project_id, projectCreatedAt: row.project_created_at }));
}

export class NativeMemoryOverlay {
  /** @param {{ database?: any, deferredSummaryRebuildEnabled?: boolean }} dependencies */
  constructor({ database = null, deferredSummaryRebuildEnabled = false } = {}) {
    /** @type {((userId:string,uri:string,body:string|null,namespaceId?:string|null)=>Promise<string|null>)|null} */
    this.memoryForgetBody = null;
    this.deferredSummaryRebuildEnabled = deferredSummaryRebuildEnabled === true;
    this.database = database ?? null;
    /** @type {any} */ this.sourceDeletion = null;
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

  /** Durable maintenance must outlive any caller transaction that changed the external engine.
   * @param {string} userId @param {readonly string[]} directories */
  async queueSummaryInvalidation(userId, directories) {
    const tickets = directories.map(directory => ({ directory, generation: randomUUID() }));
    await this.database.withoutTransactionClient(() => this.#query(`INSERT INTO evimed_memory.native_summary_invalidations (user_id,directory,generation)
      SELECT $1,t.directory,t.generation FROM jsonb_to_recordset($2::jsonb) AS t(directory text,generation text)
      ON CONFLICT (user_id,directory) DO UPDATE SET generation=EXCLUDED.generation`, [owner(userId), JSON.stringify(tickets)]));
    return tickets;
  }

  /** @param {string} userId @returns {Promise<{directory:string,generation:string}[]>} */
  async pendingSummaryInvalidations(userId) {
    const result = await this.#query('SELECT directory,generation FROM evimed_memory.native_summary_invalidations WHERE user_id=$1 ORDER BY directory', [owner(userId)]);
    return result.rows.map(row => ({ directory:String(row.directory), generation:String(row.generation) }));
  }

  /** Acknowledgement is independent too, and never clears a newer concurrent write.
   * @param {string} userId @param {readonly {directory:string,generation:string}[]} tickets */
  async completeSummaryInvalidation(userId, tickets) {
    await this.database.withoutTransactionClient(async () => {
      for (const {directory,generation} of tickets) await this.#query(`DELETE FROM evimed_memory.native_summary_invalidations
        WHERE user_id=$1 AND directory=$2 AND generation=$3`, [owner(userId),directory,generation]);
    });
  }

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
        UNION SELECT user_id FROM evimed_memory.native_summary_invalidations
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
        OR EXISTS (SELECT 1 FROM evimed_memory.native_summary_invalidations WHERE user_id=$1)
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
   * @param {{ userId: string, archiveUri: string, engineSession: string, sourceSession?: string | null, projectId?: string | null, projectCreatedAt?: string | null, origin: string, taskId?: string | null, state?: string, error?: string, pendingText?: string | null, attempts?: number }} commit `attempts`: how many replays the conversation behind this commit has had already (a replay's own commit carries the count on, so the cap bounds the chain)
   */
  async recordCommit({ userId, archiveUri, engineSession, sourceSession = null, projectId = null, projectCreatedAt=undefined, origin, taskId = null, state = "pending", error = "", pendingText = null, attempts = 0 }) {
    if (!NATIVE_COMMIT_ORIGINS.includes(origin)) throw new HttpError(500, "memory_commit_invalid", "Unknown commit origin.");
    if(projectCreatedAt===undefined)projectCreatedAt=projectId?(await this.#query('SELECT created_at::text AS created FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[owner(userId),projectId])).rows[0]?.created??null:null;
    const result = await this.#query(`INSERT INTO evimed_memory.native_commits AS c (user_id, archive_uri, engine_session, project_id, origin, task_id, state, error, next_attempt_at, pending_text, attempts,project_created_at,source_session)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'failed' THEN clock_timestamp() END, $9, $10,$11,$12)
      ON CONFLICT (user_id, archive_uri) DO UPDATE SET
        task_id = COALESCE(c.task_id, EXCLUDED.task_id), project_id = COALESCE(c.project_id, EXCLUDED.project_id),
        project_created_at = CASE WHEN EXCLUDED.source_session IS NOT NULL AND (c.project_id IS NULL OR c.project_id=EXCLUDED.project_id)
          THEN COALESCE(c.project_created_at,EXCLUDED.project_created_at) ELSE c.project_created_at END,
        source_session = COALESCE(c.source_session, EXCLUDED.source_session), updated_at = clock_timestamp()
      RETURNING *, (xmax = 0) AS inserted`,
    [owner(userId), String(archiveUri), String(engineSession), projectId, origin, taskId, state, String(error ?? "").slice(0, 400),
      pendingText == null ? null : String(pendingText).slice(0, 2_000), Math.max(0, Math.min(100, Math.trunc(Number(attempts)) || 0)),projectCreatedAt,sourceSession]);
    await this.linkSourceCopies(userId,archiveUri);
    return { ...publicCommit(result.rows[0]), inserted: result.rows[0].inserted === true };
  }

  /** Repairable from the durable conversation binding if either writer crashed or
   * both commits arrived concurrently before their counterpart was visible.
   * @param {string} userId @param {string} archiveUri */
  async linkSourceCopies(userId,archiveUri) {
    // Either archive can arrive first. Preserve the gateway's conversation binding even
    // when remember paraphrased the message and exact-message copy discovery cannot link it.
    await this.#query(`INSERT INTO evimed_memory.native_source_copies(user_id,source_archive_uri,copy_archive_uri)
      SELECT s.user_id,s.archive_uri,c.archive_uri FROM evimed_memory.native_commits c
      JOIN evimed_memory.native_commits s ON s.user_id=c.user_id AND s.engine_session=c.source_session
        AND s.project_id=c.project_id AND s.project_created_at::timestamptz=c.project_created_at::timestamptz
        AND split_part(s.archive_uri,'/sessions/',1)=split_part(c.archive_uri,'/sessions/',1)
      WHERE c.user_id=$1 AND (s.archive_uri=$2 OR c.archive_uri=$2)
        AND s.engine_session LIKE 'dsh-%'
      ON CONFLICT DO NOTHING`,[owner(userId),archiveUri]);
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

  /** Exact retained archive receipts identify producers, never truth or human authorship. */
  async attributionCommits(userId,archiveUris) {
    if(!archiveUris.length)return new Map();
    const result=await this.#query('SELECT archive_uri,origin FROM evimed_memory.native_commits WHERE user_id=$1 AND archive_uri=ANY($2::text[])',[owner(userId),archiveUris]);
    return new Map(result.rows.map(row=>[String(row.archive_uri),String(row.origin)]));
  }

  /** Preserve the real conversation sources behind an observation promotion.
   * @param {string} userId @param {string} archiveUri @param {string[]} originals */
  async linkRemovalSources(userId, archiveUri, originals) {
    if (!originals.length) return;
    await this.#query(`INSERT INTO evimed_memory.native_source_copies(user_id,source_archive_uri,copy_archive_uri)
      SELECT s.user_id,s.archive_uri,c.archive_uri FROM evimed_memory.native_commits s
      JOIN evimed_memory.native_commits c ON c.user_id=s.user_id AND c.archive_uri=$2
      WHERE s.user_id=$1 AND s.archive_uri=ANY($3::text[]) AND s.archive_uri<>c.archive_uri
        AND split_part(s.archive_uri,'/sessions/',1)=split_part(c.archive_uri,'/sessions/',1)
      ON CONFLICT DO NOTHING`, [owner(userId), archiveUri, originals]);
  }

  /** Resolve copied/replayed messages to original authorship, never their later processing time.
   * Promotion and outside-agent candidates are not statements by the person.
   * @param {string} userId @param {string[]} archiveUris */
  async removalOrigins(userId, archiveUris) {
    return readNativeMemoryOriginalSources((text, values) => this.#query(text, values), userId, archiveUris);
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

  /** Advisory checks retry independently after the commit has settled; they never hold delivery. */
  async retryableForgetChecks({ userId = null, limit = 20 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits WHERE ($1::text IS NULL OR user_id=$1)
      AND state='completed' AND extraction->'forgetRequests'->>'state'='failed'
      AND COALESCE((extraction->'forgetRequests'->>'attempts')::int,0)<3
      AND updated_at<clock_timestamp()-interval '1 minute' ORDER BY updated_at LIMIT $2`, [userId, limit]);
    return result.rows.map(publicCommit);
  }

  /** Successful conversation-tool removals since this session's preceding commit. */
  async forgetToolRevisions(userId, engineSession, archiveUri) {
    const result = await this.#query(`SELECT r.* FROM evimed_memory.native_revisions r
      JOIN evimed_memory.native_commits c ON c.user_id=r.user_id AND c.archive_uri=$3
      WHERE r.user_id=$1 AND r.engine_session=$2 AND r.actor='conversation' AND r.reason LIKE 'forgotten in a conversation%'
      AND split_part(r.uri,'/memories/',1)=split_part(c.archive_uri,'/sessions/',1)
      AND r.changed_at<=c.created_at AND r.changed_at>COALESCE((SELECT max(p.created_at) FROM evimed_memory.native_commits p
        WHERE p.user_id=c.user_id AND p.engine_session=c.engine_session AND p.created_at<c.created_at
        AND split_part(p.archive_uri,'/sessions/',1)=split_part(c.archive_uri,'/sessions/',1)),'-infinity'::timestamptz)`, [owner(userId), engineSession, archiveUri]);
    return result.rows.map(publicRevision);
  }

  /** Stable request keys prevent retained commit context and retries from executing the same human request twice. */
  async forgetRequestKeys(userId, userRoot) {
    const result = await this.#query(`SELECT extraction->'forgetRequests' AS result FROM evimed_memory.native_commits
      WHERE user_id=$1 AND archive_uri LIKE $2 || '/sessions/%' AND extraction ? 'forgetRequests'`, [owner(userId), scopedRoot(userRoot)]);
    return new Set(result.rows.flatMap(row => [...(row.result?.requests ?? []), ...(row.result?.claims ?? [])].map(item => item.key).filter(Boolean)));
  }

  /** Pending confirmations live with their settled commit, not in the extraction queue. */
  async forgetRequestCommits(userId) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_commits WHERE user_id=$1
      AND state='completed' AND extraction->'forgetRequests'->'requests' @> '[{"status":"pending"}]'::jsonb ORDER BY created_at DESC`, [owner(userId)]);
    return result.rows.map(publicCommit);
  }

  async setForgetRequests(userId, archiveUri, result) {
    await this.#query(`UPDATE evimed_memory.native_commits SET extraction=jsonb_set(COALESCE(extraction,'{}'::jsonb),'{forgetRequests}',$3::jsonb), updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri=$2`, [owner(userId), archiveUri, JSON.stringify(result)]);
  }

  /**
   * @param {string} userId @param {string} archiveUri
   * @param {{ operations?: number, extraction?: Record<string, any> | null }} [outcome] `extraction`: what the engine said the
   *   extraction did (`extractionFacts`), kept as it came; absent, the row keeps what it had
   */
  async completeCommit(userId, archiveUri, { operations = 0, extraction = null } = {}) {
    await this.#query(`UPDATE evimed_memory.native_commits SET state='completed', operations=$3, error='', next_attempt_at=NULL, pending_text=NULL,
      extraction=COALESCE($4::jsonb, extraction) || CASE WHEN extraction ? 'forgetRequests' THEN jsonb_build_object('forgetRequests',extraction->'forgetRequests') ELSE '{}'::jsonb END, ingested_at=clock_timestamp(), updated_at=clock_timestamp()
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

  /** Complete coverage: an unbounded outbox cannot be declared quiet from its first page. Replayed and abandoned commits are terminal (a replay's successor is a row of its own). */
  async hasUnprovenNativeWrites(userId) {
    const result=await this.#query("SELECT 1 FROM evimed_memory.native_commits WHERE user_id=$1 AND state IN ('pending','failed') AND native_ingested_at IS NULL AND ingested_at IS NULL LIMIT 1",[owner(userId)]);
    return result.rows.length>0;
  }
  /** Native extraction ingestion is separate from the optional raw-history indexing outbox. */
  async noteNativeIngested(userId,archiveUri) {
    await this.#query('UPDATE evimed_memory.native_commits SET native_ingested_at=COALESCE(native_ingested_at,clock_timestamp()) WHERE user_id=$1 AND archive_uri=$2',[owner(userId),archiveUri]);
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

  /** A content/source-bound receipt makes retries auditable without spending the judging budget again. */
  async instructionCheck(userId, fingerprint) {
    const result = await this.#query('SELECT result FROM evimed_memory.native_instruction_checks WHERE user_id=$1 AND fingerprint=$2', [owner(userId), fingerprint]);
    return result.rows[0]?.result ?? null;
  }

  /** Instruction review must not share the settlement queue's page limit: an older broken summary can strand later writes. */
  async instructionCommits(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_commits WHERE user_id=$1 AND state='pending' ORDER BY created_at,archive_uri", [owner(userId)]);
    return result.rows.map(publicCommit);
  }

  /** The first verdict stays; `replace` is only for a person's latest decision about one line (`lineDecisionKey`).
   * @param {string} userId @param {string} fingerprint @param {unknown} result @param {{replace?:boolean}} [options] */
  async recordInstructionCheck(userId, fingerprint, result, { replace = false } = {}) {
    await this.#query(`INSERT INTO evimed_memory.native_instruction_checks(user_id,fingerprint,result) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(user_id,fingerprint) DO ${replace ? 'UPDATE SET result=EXCLUDED.result' : 'NOTHING'}`, [owner(userId), fingerprint, JSON.stringify(result)]);
  }

  /** Disputed lines stay outside active recall, with the same recoverable revision authority as Undo. */
  async pendingInstructionRevisions(userId) {
    const rows = await this.#query(`SELECT r.* FROM evimed_memory.native_revisions r WHERE user_id=$1 AND actor='platform'
      AND reason LIKE '%pasted_instruction_pending%' AND undone_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM evimed_memory.native_revisions newer WHERE newer.user_id=r.user_id AND newer.uri=r.uri
        AND newer.id>r.id AND newer.actor='user') ORDER BY id DESC LIMIT 100`, [owner(userId)]);
    const checks = await this.#query("SELECT result->'pendingKeys' AS keys FROM evimed_memory.native_instruction_checks WHERE user_id=$1 AND result ? 'pendingKeys'", [owner(userId)]);
    const prints = new Map();
    for (const row of checks.rows) for (const key of row.keys ?? []) {
      const held = prints.get(key.uri) ?? new Set(); held.add(key.fingerprint); prints.set(key.uri, held);
    }
    return (await this.protectRevisions(userId, rows.rows.map(publicRevision))).map(row => ({ ...row, pendingFingerprints: prints.get(row.uri) ?? null }));
  }

  /**
   * One change of one file. A change read from an archive's diff is written once however often the diff is read.
   * @returns {Promise<ReturnType<typeof publicRevision> | null>} null when this archive's change was already there
   */
  async addRevision({ userId, uri, memoryType, change, actor, reason = "", before = null, after = null, archiveUri = null, engineSession = null, projectId = null, sourceProjectId=null,sourceProjectCreatedAt=undefined, changedAt = null }) {
    if (!NATIVE_REVISION_CHANGES.includes(change) || !NATIVE_REVISION_ACTORS.includes(actor)) throw new HttpError(500, "memory_revision_invalid", "Unknown revision change or actor.");
    if(sourceProjectCreatedAt===undefined&&archiveUri&&engineSession){
      const source=(await this.#query('SELECT project_id,project_created_at FROM evimed_memory.native_commits WHERE user_id=$1 AND archive_uri=$2 AND engine_session=$3',[owner(userId),archiveUri,engineSession])).rows[0];
      sourceProjectId=sourceProjectId??source?.project_id??null;sourceProjectCreatedAt=source?.project_created_at??null;
    }
    const result = await this.#query(`INSERT INTO evimed_memory.native_revisions
      (user_id, uri, memory_type, change, actor, reason, before, after, archive_uri, engine_session, project_id, changed_at,source_project_id,source_project_created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, clock_timestamp()),$13,$14)
      ON CONFLICT (user_id, archive_uri, uri, change) WHERE archive_uri IS NOT NULL DO NOTHING RETURNING *`,
    [owner(userId), String(uri), String(memoryType), change, actor, String(reason ?? "").slice(0, 200), bounded(before, NATIVE_TEXT_LIMIT), bounded(after, NATIVE_TEXT_LIMIT),
      archiveUri, engineSession, projectId, changedAt,sourceProjectId,sourceProjectCreatedAt]);
    return result.rows[0] ? publicRevision(result.rows[0]) : null;
  }

  async protectRevisions(userId,rows) { return this.sourceDeletion ? this.sourceDeletion.redactRevisions(userId,rows) : rows; }
  /** @param {string} userId @param {string} uri @param {{ limit?: number }} [options] newest first */
  async revisionsOf(userId, uri, { limit = 32 } = {}) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND uri=$2 ORDER BY id DESC LIMIT $3",
      [owner(userId), String(uri), Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 32))]);
    return this.protectRevisions(userId,result.rows.map(publicRevision));
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
        AND ((change = 'deleted') OR (change = 'updated' AND after IS NOT NULL
          AND (reason LIKE 'forgotten on the memory page%' OR reason LIKE 'forgotten by conversation request%')))
      ORDER BY id DESC LIMIT $2`, [owner(userId), Math.max(1, Math.min(1_000, Math.trunc(Number(limit)) || 300))]);
    return this.protectRevisions(userId,result.rows.map(publicRevision));
  }

  /** The revisions of many files in one read, newest first per file. @param {string} userId @param {readonly string[]} uris */
  async revisionsOfMany(userId, uris, { perFile = 32 } = {}) {
    /** @type {Map<string, ReturnType<typeof publicRevision>[]>} */
    const byUri = new Map();
    if (!uris.length) return byUri;
    const result = await this.#query(`SELECT * FROM (SELECT r.*, row_number() OVER (PARTITION BY uri ORDER BY id DESC) AS position
      FROM evimed_memory.native_revisions r WHERE user_id=$1 AND uri = ANY($2::text[])) ranked WHERE position <= $3 ORDER BY uri, id DESC`,
    [owner(userId), [...uris], Math.max(1, Math.min(200, perFile))]);
    for (const row of await this.protectRevisions(userId,result.rows.map(publicRevision))) {
      const list = byUri.get(String(row.uri)) ?? [];
      list.push(row);
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
    return this.protectRevisions(userId,result.rows.map(publicRevision));
  }

  /** Exact admission lineage is not the dashboard's bounded recent-changes list.
   * @param {string} userId @param {string} archiveUri */
  async admissionRevisions(userId, archiveUri) {
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND archive_uri=$2 ORDER BY id", [owner(userId), archiveUri]);
    return this.protectRevisions(userId,result.rows.map(publicRevision));
  }

  /** Every revision of an account inside a range, oldest first: the timeline and the map's events. */
  async revisionsBetween(userId, { from = null, to = null, limit = 5_000 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1
      AND ($2::timestamptz IS NULL OR changed_at >= $2) AND ($3::timestamptz IS NULL OR changed_at <= $3) ORDER BY id LIMIT $4`,
    [owner(userId), from, to, Math.max(1, Math.min(20_000, limit))]);
    return this.protectRevisions(userId,result.rows.map(publicRevision));
  }

  /** @param {string} userId @param {string} id */
  async revision(userId, id) {
    if (!/^\d{1,18}$/.test(String(id))) return null;
    const result = await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND id=$2", [owner(userId), String(id)]);
    return result.rows[0] ? (await this.protectRevisions(userId,[publicRevision(result.rows[0])]))[0] : null;
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
  async scrubLines(userId, uri, lines, {sourceDeleted=false}={}) {
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
      await this.#query("UPDATE evimed_memory.native_revisions SET before=$3, after=$4,reason=CASE WHEN $5 THEN reason||' [source-deleted]' ELSE reason END WHERE user_id=$1 AND id=$2", [owner(userId), String(row.id), before, after,sourceDeleted]);
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
      if (!/^(?:evimed-replay-|mcp-store-|evimed-page-)/.test(session) || !archive) return null;
      const parent = await this.#query(`SELECT engine_session, archive_uri FROM evimed_memory.native_commits WHERE user_id=$1 AND (replayed_as=$2 OR archive_uri IN
        (SELECT source_archive_uri FROM evimed_memory.native_source_copies WHERE user_id=$1 AND copy_archive_uri=$2)) LIMIT 1`, [owner(userId), archive]);
      if (!parent.rows[0]) return null;
      session = String(parent.rows[0].engine_session);
      archive = String(parent.rows[0].archive_uri);
    }
    return null;
  }

  /** Freeze one exact native source scope before any destructive cleanup. A shared engine session alias is never deletion authority. */
  async conversationSourceScope(userId,projectId,sessionIds,userRoot,projectCreatedAt) {
    scopedRoot(userRoot);
    const ids=sessionIds.map(id=>`dsh-${id}`);
    const commits=await this.#query(`WITH RECURSIVE source AS (
      SELECT archive_uri,engine_session,replayed_as FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2 AND engine_session=ANY($3::text[]) AND left(archive_uri,length($4)+10)=$4||'/sessions/'
      UNION SELECT c.archive_uri,c.engine_session,c.replayed_as FROM evimed_memory.native_commits c JOIN source s ON (c.archive_uri=s.replayed_as OR EXISTS
        (SELECT 1 FROM evimed_memory.native_source_copies x WHERE x.user_id=c.user_id AND x.source_archive_uri=s.archive_uri AND x.copy_archive_uri=c.archive_uri)) WHERE c.user_id=$1 AND c.project_id=$2 AND left(c.archive_uri,length($4)+10)=$4||'/sessions/'
    ) SELECT c.* FROM evimed_memory.native_commits c WHERE c.user_id=$1 AND left(c.archive_uri,length($4)+10)=$4||'/sessions/'
      AND (c.engine_session=ANY($3::text[]) OR c.engine_session IN (SELECT engine_session FROM source))`,[owner(userId),projectId,ids,userRoot]);
    const sessionIdsFound=[...new Set([...ids,...commits.rows.map(row=>String(row.engine_session))])];
    const registry=userRoot===userRootUri(userId)?(await this.#query('SELECT project_id,project_created_at FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=ANY($2::text[])',[owner(userId),sessionIdsFound])).rows:[];
    const origins=(await this.#query(`SELECT o.project_id,o.project_created_at FROM evimed_memory.native_line_origins o WHERE o.user_id=$1 AND left(o.uri,length($2)+1)=$2||'/' AND o.engine_session=ANY($3::text[])`,[owner(userId),userRoot,sessionIdsFound])).rows;
    const rows=[...commits.rows,...registry,...origins];
    let verified=!rows.some(row=>row.project_id!==projectId||!row.project_created_at);
    for(const epoch of new Set(rows.map(row=>row.project_created_at).filter(Boolean))) {
      if(!(await this.#query('SELECT $1::timestamptz=$2::timestamptz AS same',[epoch,projectCreatedAt])).rows[0].same)verified=false;
    }
    if(!verified)throw new HttpError(409,'memory_source_lineage_unverified','The native source session has unknown or conflicting incarnation authority.');
    return {archiveUris:commits.rows.map(row=>String(row.archive_uri)),engineSessions:[...new Set([...commits.rows.map(row=>String(row.engine_session)),...(registry.length?ids:[])])]};
  }

  /** Pending extractions and their replay text cannot re-enrol a deliberately deleted source.
   * @param {string} userId @param {string} projectId @param {string[]} sessionIds */
  async withdrawConversationSource(userId, projectId, sessionIds, userRoot,projectCreatedAt=null) {
    const proof=projectCreatedAt?await this.conversationSourceScope(userId,projectId,sessionIds,userRoot,projectCreatedAt):null;
    scopedRoot(userRoot);
    const sessions = sessionIds.map(id => `dsh-${id}`);
    const removed = await this.#query(`WITH RECURSIVE sources AS (
      SELECT archive_uri,replayed_as FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2 AND engine_session=ANY($3::text[])
        AND left(archive_uri,length($4)+10)=$4||'/sessions/'
      UNION SELECT c.archive_uri,c.replayed_as FROM evimed_memory.native_commits c JOIN sources s ON (c.archive_uri=s.replayed_as OR EXISTS
        (SELECT 1 FROM evimed_memory.native_source_copies x WHERE x.user_id=c.user_id AND x.source_archive_uri=s.archive_uri AND x.copy_archive_uri=c.archive_uri))
        WHERE c.user_id=$1 AND c.project_id=$2 AND left(c.archive_uri,length($4)+10)=$4||'/sessions/'
    ) UPDATE evimed_memory.native_commits SET native_ingested_at=CASE WHEN state='completed' THEN COALESCE(native_ingested_at,ingested_at,clock_timestamp()) ELSE native_ingested_at END,state='abandoned',pending_text=NULL,error='source_conversation_deleted',updated_at=clock_timestamp()
      WHERE user_id=$1 AND archive_uri IN (SELECT archive_uri FROM sources) AND ($5::text[] IS NULL OR archive_uri=ANY($5::text[])) RETURNING engine_session`, [owner(userId), projectId, sessions, userRoot,proof?.archiveUris??null]);
    if (userRoot === userRootUri(userId)) await this.#query(`UPDATE evimed_memory.native_admissions SET state='cancelled',pending_text=NULL,error='source_conversation_deleted',
      updated_at=clock_timestamp() WHERE user_id=$1 AND project_id=$2 AND engine_session=ANY($3::text[])`, [owner(userId), projectId, sessions]);
    return [...new Set(removed.rows.map(row => row.engine_session))];
  }

  /** Raw consolidation receipts are inspected before source scrubbing can remove their inputs. */
  async consolidationRevisions(userId,userRoot) {
    scopedRoot(userRoot);
    const rows=await this.#query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND left(uri,length($2)+1)=$2||'/' AND reason LIKE 'consolidation%' ORDER BY id",[owner(userId),userRoot]);
    return rows.rows.map(publicRevision);
  }
  /** Source-bound historical revisions remain relevant after their current origin or file was removed.
   * @param {string} userId @param {string} projectId @param {string[]} sessionIds @param {string} userRoot */
  async sourceRevisions(userId, projectId, sessionIds, userRoot,projectCreatedAt=null) {
    scopedRoot(userRoot);
    const result = await this.#query(`WITH RECURSIVE sources AS (
      SELECT archive_uri,engine_session,replayed_as FROM evimed_memory.native_commits WHERE user_id=$1 AND project_id=$2
        AND engine_session=ANY($3::text[]) AND left(archive_uri,length($4)+10)=$4||'/sessions/'
        AND ($5::timestamptz IS NULL OR project_created_at::timestamptz=$5::timestamptz OR project_created_at IS NULL AND created_at>=$5::timestamptz AND NOT EXISTS(SELECT 1 FROM evimed_control.projects p WHERE p.user_id=$1 AND p.id=$2 AND p.created_at>$5::timestamptz AND native_commits.created_at>=p.created_at))
      UNION SELECT c.archive_uri,c.engine_session,c.replayed_as FROM evimed_memory.native_commits c JOIN sources s ON (c.archive_uri=s.replayed_as OR EXISTS
        (SELECT 1 FROM evimed_memory.native_source_copies x WHERE x.user_id=c.user_id AND x.source_archive_uri=s.archive_uri AND x.copy_archive_uri=c.archive_uri))
        WHERE c.user_id=$1 AND c.project_id=$2 AND left(c.archive_uri,length($4)+10)=$4||'/sessions/'
        AND ($5::timestamptz IS NULL OR c.project_created_at::timestamptz=$5::timestamptz OR c.project_created_at IS NULL AND c.created_at>=$5::timestamptz AND NOT EXISTS(SELECT 1 FROM evimed_control.projects p WHERE p.user_id=$1 AND p.id=$2 AND p.created_at>$5::timestamptz AND c.created_at>=p.created_at))
    ) SELECT r.* FROM evimed_memory.native_revisions r LEFT JOIN evimed_memory.native_commits c
      ON c.user_id=r.user_id AND c.archive_uri=r.archive_uri AND c.engine_session=r.engine_session
      WHERE r.user_id=$1 AND left(r.uri,length($4)+1)=$4||'/' AND (
        r.engine_session=ANY($3::text[]) AND COALESCE(r.source_project_id,r.project_id,c.project_id)=$2
        OR EXISTS(SELECT 1 FROM sources s WHERE s.archive_uri=r.archive_uri AND s.engine_session=r.engine_session)) AND ($5::timestamptz IS NULL OR COALESCE(r.source_project_created_at,CASE WHEN c.created_at<=r.changed_at THEN c.project_created_at END)::timestamptz=$5::timestamptz
        OR r.source_project_created_at IS NULL AND (c.project_created_at IS NULL OR c.created_at>r.changed_at) AND LEAST(r.changed_at,c.created_at)>=$5::timestamptz
          AND NOT EXISTS(SELECT 1 FROM evimed_control.projects p WHERE p.user_id=$1 AND p.id=$2 AND p.created_at>$5::timestamptz AND LEAST(r.changed_at,c.created_at)>=p.created_at)) ORDER BY r.id`,
    [owner(userId),projectId,sessionIds.map(id=>`dsh-${id}`),userRoot,projectCreatedAt]);
    return result.rows.map(publicRevision);
  }

  // ------------------------------------------------------------ line origins

  /**
   * Keep the per-line origin index of one file in step with its text: a line that is no longer in `after` loses its row, and — when an
   * `origin` is given — each line `after` has and `before` did not is recorded as brought by it (the first row of a line stays: the
   * line's source is the first commit that brought it). With no `origin` (the person's own edit, a restore, a platform check) lines only leave.
   * @param {string} userId @param {string} uri
   * @param {{ after: string, before?: string, origin?: { revisionId?: string | number | null, engineSession?: string | null, archiveUri?: string | null, projectId?: string | null, projectCreatedAt?:string|null, at?: string | null } | null }} change
   */
  async syncOrigins(userId, uri, { after, before = "", origin = null }) {
    const prints = (/** @type {string} */ text) => [...new Set(memoryLines(String(text ?? "").split("\n").filter((line) => !LABEL_LINE.test(line.trim())).join("\n")).map(lineFingerprint))];
    const present = prints(after);
    await this.#query("DELETE FROM evimed_memory.native_line_origins WHERE user_id=$1 AND uri=$2 AND NOT (fingerprint = ANY($3::text[]))", [owner(userId), String(uri), present]);
    if (!origin) return;
    let projectCreatedAt=origin.projectCreatedAt;
    if(projectCreatedAt===undefined)projectCreatedAt=origin.projectId?(await this.#query('SELECT created_at::text AS created FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[owner(userId),origin.projectId])).rows[0]?.created??null:null;
    const had = new Set(prints(before));
    const brought = present.filter((print) => !had.has(print));
    if (!brought.length) return;
    await this.#query(`INSERT INTO evimed_memory.native_line_origins (user_id, uri, fingerprint, revision_id, engine_session, archive_uri, project_id, added_at,project_created_at)
      SELECT $1, $2, print, $4::bigint, $5, $6, $7, COALESCE($8::timestamptz, clock_timestamp()),$9 FROM unnest($3::text[]) AS brought(print)
      ON CONFLICT (user_id, uri, fingerprint) DO NOTHING`,
    [owner(userId), String(uri), brought, origin.revisionId == null ? null : String(origin.revisionId), origin.engineSession ?? null, origin.archiveUri ?? null, origin.projectId ?? null, origin.at ?? null,projectCreatedAt]);
  }

  /**
   * The origins of the lines of these files, by file and line fingerprint.
   * @param {string} userId @param {readonly string[]} uris
   * @returns {Promise<Map<string, Map<string, { revisionId: string | null, engineSession: string | null, archiveUri: string | null, projectId: string | null, projectCreatedAt:string|null, addedAt: string | null, sources?: any[] }>>>}
   */
  async originsOf(userId, uris) {
    /** @type {Map<string, Map<string, any>>} */
    const byUri = new Map();
    if (!uris.length) return byUri;
    const result = await this.#query("SELECT o.*,COALESCE(o.project_id,c.project_id) AS project_id,COALESCE(o.project_created_at,CASE WHEN c.created_at<=o.added_at THEN c.project_created_at END) AS source_epoch FROM evimed_memory.native_line_origins o LEFT JOIN evimed_memory.native_commits c ON c.user_id=o.user_id AND c.archive_uri=o.archive_uri AND c.engine_session=o.engine_session WHERE o.user_id=$1 AND o.uri = ANY($2::text[])", [owner(userId), [...uris]]);
    for (const row of result.rows) {
      const lines = byUri.get(String(row.uri)) ?? new Map();
      lines.set(String(row.fingerprint), { revisionId: row.revision_id == null ? null : String(row.revision_id), engineSession: row.engine_session ?? null,
        archiveUri: row.archive_uri ?? null, projectId: row.project_id ?? null, projectCreatedAt:row.source_epoch??null, addedAt: instant(row.added_at),
        ...(Array.isArray(row.sources) && row.sources.length ? { sources: row.sources } : {}) });
      byUri.set(String(row.uri), lines);
    }
    const linked = await this.#query(`SELECT copies.copy_archive_uri,s.archive_uri,s.engine_session,s.project_id,s.project_created_at
      FROM evimed_memory.native_source_copies copies JOIN evimed_memory.native_commits s
        ON s.user_id=copies.user_id AND s.archive_uri=copies.source_archive_uri
      WHERE copies.user_id=$1 AND copies.copy_archive_uri=ANY($2::text[])`,
    [owner(userId),result.rows.flatMap(row=>[row.archive_uri,...(row.sources??[]).map(source=>source.archiveUri)]).filter(Boolean)]);
    for (const lines of byUri.values()) for (const origin of lines.values()) {
      // A plain first origin is the parent object itself. Snapshot it before
      // attaching sources so merge/undo provenance remains JSON-serializable.
      const sources=originalSources(origin).map(source=>{const copy={...source};delete copy.sources;return copy;});
      const inherited=linked.rows.filter(row=>sources.some(source=>source.archiveUri===row.copy_archive_uri));
      if(inherited.length) origin.sources=[...sources,...inherited.map(row=>({archiveUri:row.archive_uri,engineSession:row.engine_session,
        projectId:row.project_id,projectCreatedAt:row.project_created_at,addedAt:origin.addedAt}))];
    }
    return byUri;
  }

  /** Attach the snapshotted conversation sources to each changed line, preserving unchanged lines' first origins.
   * @param {string} userId @param {string} uri @param {Map<string, any[]>} lines */
  async inheritOrigins(userId, uri, lines) {
    for (const [fingerprint, sources] of lines) {
      if (!sources.length) continue;
      const first = sources[0];
      await this.#query(`INSERT INTO evimed_memory.native_line_origins
        (user_id,uri,fingerprint,revision_id,engine_session,archive_uri,project_id,project_created_at,added_at,sources)
        VALUES($1,$2,$3,$4::bigint,$5,$6,$7,$8,COALESCE($9::timestamptz,clock_timestamp()),$10::jsonb)
        ON CONFLICT(user_id,uri,fingerprint) DO NOTHING`,
      [owner(userId),uri,fingerprint,first.revisionId ?? null,first.engineSession ?? null,first.archiveUri ?? null,
        first.projectId ?? null,first.projectCreatedAt ?? null,first.addedAt ?? null,JSON.stringify(sources)]);
    }
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
    return this.protectRevisions(userId,result.rows.map(publicRevision));
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

  /** Successful explicit reads, once per file per call. Rewrites preserve these columns; deletion removes them.
   * @param {string} userId @param {readonly string[]} uris @returns {Promise<number>} */
  async noteUsed(userId, uris) {
    const unique = [...new Set(uris.map(String))].slice(0, 50);
    if (!unique.length) return 0;
    const result = await this.#query(`UPDATE evimed_memory.native_files SET last_used_at=clock_timestamp(), used_count=used_count+1
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
    const withdrawn = this.sourceDeletion ? await this.sourceDeletion.hiddenMemoryUris(userId) : [];
    const uris = [...new Set([...result.rows.map(row => String(row.uri)), ...withdrawn])];
    if (uris.length > bound) throw new HttpError(503, "memory_index_listing_too_large", "The complete privacy set exceeds its safe recall bound.");
    return uris;
  }

  /**
   * The files of a project type (card, decisions, working facts, open items, recent work) that belong to a named project other than
   * `projectId`: what a conversation of `projectId` does not read (a project's rules and facts are its own, 2026-10-27). The catch-all
   * project's files are no project's and stay readable everywhere; a conversation in the catch-all reads no named project's.
   * @param {string} userId @param {string} projectId @param {number} [limit]
   * @param {{peopleAcrossProjects?: boolean, memoryRoot?: string}} [options]
   * @returns {Promise<string[]>}
   */
  async otherProjectUris(userId, projectId, limit = 10000, { peopleAcrossProjects = false, memoryRoot = "" } = {}) {
    const bound = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 10000));
    const result = await this.#query(`SELECT uri FROM evimed_memory.native_files WHERE user_id=$1 AND memory_type=ANY($2::text[])
      AND project_id IS NOT NULL AND project_id<>$3 AND project_id<>$4 ORDER BY uri LIMIT $5`,
    [owner(userId), [...OPENVIKING_PROJECT_MEMORY_TYPES], String(projectId ?? ""), CATCH_ALL_PROJECT_ID, bound + 1]);
    if (result.rows.length > bound) throw new HttpError(503, "memory_index_listing_too_large", "The complete set of other projects' files exceeds its safe recall bound.");
    return result.rows.map((/** @type {any} */ row) => String(row.uri))
      .filter(uri => !personalMemoryTravels(uri, memoryRoot, peopleAcrossProjects));
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
  async noteSession(userId, engineSession, projectId,projectCreatedAt=undefined) {
    if(projectCreatedAt===undefined)projectCreatedAt=projectId?(await this.#query('SELECT created_at::text AS created FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[owner(userId),projectId])).rows[0]?.created??null:null;
    const result=await this.#query(`INSERT INTO evimed_memory.native_sessions AS held (user_id, engine_session, project_id,project_created_at) VALUES ($1, $2, $3,$4)
      ON CONFLICT (user_id, engine_session) DO UPDATE SET project_id=held.project_id, project_created_at=COALESCE(held.project_created_at,EXCLUDED.project_created_at)
      -- A binding made before the incarnation stamp existed (NULL) takes the incoming one; a stamped one must match exactly.
      WHERE held.project_id IS NOT DISTINCT FROM EXCLUDED.project_id AND (held.project_created_at IS NULL OR held.project_created_at::timestamptz IS NOT DISTINCT FROM EXCLUDED.project_created_at::timestamptz) RETURNING project_id`,
    [owner(userId), String(engineSession), projectId,projectCreatedAt]);
    if(!result.rows.length)throw new HttpError(403,'memory_scope_denied','The native session belongs to another project incarnation.');
  }

  /** A read may inspect an existing exact binding but never create or reassign it. */
  async assertSessionScope(userId,engineSession,projectId,projectCreatedAt=undefined) {
    if(projectCreatedAt===undefined)projectCreatedAt=(await this.#query('SELECT created_at::text AS created FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[owner(userId),projectId])).rows[0]?.created??null;
    const result=await this.#query('SELECT 1 FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2 AND project_id=$3 AND project_created_at::timestamptz IS NOT DISTINCT FROM $4::timestamptz',[owner(userId),engineSession,projectId,projectCreatedAt]);
    // A binding written before the stamp existed takes the project's current one (the same exact-project rule, written once).
    if(!result.rows.length&&projectCreatedAt)result.rows=(await this.#query('UPDATE evimed_memory.native_sessions SET project_created_at=$4 WHERE user_id=$1 AND engine_session=$2 AND project_id=$3 AND project_created_at IS NULL RETURNING 1',[owner(userId),engineSession,projectId,projectCreatedAt])).rows;
    if(!result.rows.length)throw new HttpError(403,'memory_scope_denied','The native session scope is unavailable.');
  }

  async projectEpochOfSession(userId,engineSession,{userRoot=userRootUri(userId)}={}) {
    const root=scopedRoot(userRoot);const result=await this.#query(`WITH found AS (
      SELECT project_id,project_created_at FROM evimed_memory.native_sessions WHERE user_id=$1 AND engine_session=$2 AND $4::boolean
      UNION ALL SELECT project_id,project_created_at FROM evimed_memory.native_commits WHERE user_id=$1 AND engine_session=$2 AND left(archive_uri,length($3)+10)=$3||'/sessions/')
      SELECT min(f.project_created_at) AS project_created_at FROM found f LEFT JOIN evimed_control.projects p ON p.user_id=$1 AND p.id=f.project_id
      HAVING count(DISTINCT f.project_created_at::timestamptz)=1 AND bool_and(f.project_created_at IS NOT NULL AND p.created_at=f.project_created_at::timestamptz)`,[owner(userId),engineSession,root,root===userRootUri(userId)]);return result.rows[0]?.project_created_at??null;
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
   * text (`normalisedStatement`, without truncation), because recognising a reworded repeat needs the words: a line that contains
   * it, or that a model judges to say the same, is taken out again. The text is the account's own, read by nothing but that
   * recognition. A dated restatement authorizes its write; only explicit undo, reset or account erasure lifts the rejection.
   *
   * `origin` says how the lines were removed: `edit` — the person's own edit of a file replaced them, so their old words may still be drawn as
   * what the memory used to say — or `forget` (the default: a forget, a delete, an undo, the engine's repeat taken out again), which no
   * reader may draw. A line is `edit` only while every rejection of it was one: a forget of the same words, by whatever file, makes it `forget`
   * for good, and a row from before the column has none and is read as `forget`.
   * @param {string} userId @param {string} memoryType @param {string} uri @param {readonly string[]} lines @param {{ origin?: "edit" | "forget" }} [options]
   */
  async reject(userId, memoryType, uri, lines, { origin = "forget" } = {}) {
    /** @type {Map<string, string>} */
    const unique = new Map();
    for (const line of lines) { const print = lineFingerprint(line); if (!unique.has(print)) unique.set(print, normalisedStatement(line)); }
    const prints = [...unique.keys()];
    if (!prints.length) return 0;
    await this.#query(`INSERT INTO evimed_memory.native_rejections (user_id, memory_type, fingerprint, uri, text, origin)
      SELECT $1, $2, print, $3, text, $6 FROM unnest($4::text[], $5::text[]) AS rejected(print, text)
      ON CONFLICT (user_id, memory_type, fingerprint) DO UPDATE SET rejected_at=clock_timestamp(), text=COALESCE(EXCLUDED.text, evimed_memory.native_rejections.text),
        origin=CASE WHEN EXCLUDED.origin = 'edit' AND evimed_memory.native_rejections.origin = 'edit' THEN 'edit' ELSE 'forget' END`,
    [owner(userId), String(memoryType), String(uri).slice(0, 600), prints, prints.map((print) => unique.get(print) ?? ""), origin === "edit" ? "edit" : "forget"]);
    return prints.length;
  }

  /** Claim only new intent fingerprints inside the caller's rejection/history transaction.
   * The unique key serializes concurrent tool/settlement calls without holding locks during scans.
   * Existing removals retain their date and undo authority; RETURNING owns the revision's before-image.
   * @param {string} userId @param {string} memoryType @param {string} uri @param {readonly string[]} lines */
  async claimForgetIntent(userId, memoryType, uri, lines) {
    const unique = new Map(lines.map(line => [lineFingerprint(line), line]));
    const prints = [...unique.keys()].sort();
    if (!prints.length) return [];
    const result = await this.#query(`INSERT INTO evimed_memory.native_rejections (user_id,memory_type,fingerprint,uri,text,origin)
      SELECT $1,$2,print,$3,text,'forget' FROM unnest($4::text[],$5::text[]) AS rejected(print,text)
      ON CONFLICT (user_id,memory_type,fingerprint) DO UPDATE SET origin='forget', uri=EXCLUDED.uri,
        text=EXCLUDED.text, rejected_at=clock_timestamp()
      WHERE evimed_memory.native_rejections.origin='edit' RETURNING fingerprint`,
    [owner(userId), String(memoryType), uri, prints, prints.map(print => normalisedStatement(unique.get(print)))]);
    const inserted = new Set(result.rows.map(row => row.fingerprint));
    return [...unique].filter(([print]) => inserted.has(print)).map(([, line]) => line);
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

  /** All removals in one native namespace, across categories and without a paging cap.
   * Moving a fact from a preference to a project card cannot change its removal authority.
   * @param {string} userId @param {string|null} [namespaceId] */
  async removals(userId, namespaceId = null) {
    const types = OPENVIKING_KNOWN_MEMORY_TYPES.map(type => nativeMemoryRejectionType(type, namespaceId));
    const result = await this.#query(`SELECT memory_type, fingerprint, text, rejected_at FROM evimed_memory.native_rejections
      WHERE user_id=$1 AND memory_type = ANY($2::text[]) ORDER BY rejected_at DESC`, [owner(userId), types]);
    return result.rows.map(row => ({ memoryType: row.memory_type, fingerprint: row.fingerprint, text: row.text, rejectedAt: instant(row.rejected_at) }));
  }

  /**
   * The lines the person removed from memories of this type, with the words each had when there are any (a rejection made before the
   * words were kept has only its fingerprint and can only be met by an exact repeat), and how each was removed (`origin`: `edit` only when
   * the person's own edit replaced it, else `forget`, which a row from before the column is read as). Newest first.
   * @param {string} userId @param {string} memoryType @param {{ limit?: number }} [options]
   * @returns {Promise<{ fingerprint: string, text: string | null, origin: "edit" | "forget" }[]>}
   */
  async rejectedLines(userId, memoryType, { limit = 300 } = {}) {
    const result = await this.#query("SELECT fingerprint, text, origin FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type=$2 ORDER BY rejected_at DESC LIMIT $3",
      [owner(userId), String(memoryType), Math.max(1, Math.min(1_000, Math.trunc(Number(limit)) || 300))]);
    return result.rows.map((/** @type {any} */ row) => ({ fingerprint: String(row.fingerprint), text: typeof row.text === "string" && row.text ? row.text : null,
      origin: row.origin === "edit" ? "edit" : "forget" }));
  }

  /**
   * The lines the person forgot or deleted, of the memories of these types: the rejections that were not an edit replacing a line (`origin` is
   * anything but `edit`; a row from before the column counts). What no reader may show out of the history of any file. Newest first.
   * @param {string} userId @param {readonly string[]} memoryTypes @param {{ limit?: number }} [options]
   * @returns {Promise<{ fingerprint: string, text: string | null, origin: "forget" }[]>}
   */
  async forgottenLines(userId, memoryTypes, { limit = 2_000 } = {}) {
    if (!memoryTypes.length) return [];
    const result = await this.#query("SELECT fingerprint, text FROM evimed_memory.native_rejections WHERE user_id=$1 AND memory_type = ANY($2::text[]) AND origin IS DISTINCT FROM 'edit' ORDER BY rejected_at DESC LIMIT $3",
      [owner(userId), memoryTypes.map(String), Math.max(1, Math.min(5_000, Math.trunc(Number(limit)) || 2_000))]);
    return result.rows.map((/** @type {any} */ row) => ({ fingerprint: String(row.fingerprint), text: typeof row.text === "string" && row.text ? row.text : null, origin: "forget" }));
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
