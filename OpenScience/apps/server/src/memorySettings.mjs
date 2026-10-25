import { HttpError } from "./security.mjs";
import { MEMORY_PAUSED_PROJECT_LIMIT, migrateMemorySettings } from "./memorySettingsPersistence.mjs";

/**
 * An account's own say over its memory, on the control-plane database: the switches, the reset instant, and the state of each
 * conversation's memory.
 *
 * What an account's memories are is OpenViking's (`nativeMemoryStore.mjs` reads and edits them, `nativeMemoryOverlay.mjs` keeps
 * the PostgreSQL facts about them). This store holds what is not a memory and has no place in the engine: whether learning or
 * recall is paused for the account or for one project, when the account last reset, which shared capsule a conversation is trying,
 * and what profile a conversation was last handed. It was `MemorySettingsStore`, the home of the platform's own structured
 * records, until the legacy memory engine was deleted (2026-10-25); the records, their relations, usage counters, recall and
 * extraction went with it.
 *
 * Every limit is counted in characters, the unit the routes validate in.
 */

const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** A session id as the kernel writes one. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** @param {string} field */
function invalid(field) {
  return new HttpError(400, "memory_payload_invalid", `${field} is invalid.`);
}

/**
 * When something happened, to the second.
 *
 * Whole seconds, formatted the way the retired service's protojson formatted them (`2026-09-11T06:51:44Z`).
 * @param {unknown} value @returns {string|null}
 */
export function memoryInstant(value) {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value : new Date(String(value));
  const milliseconds = time.getTime();
  if (!Number.isFinite(milliseconds)) return null;
  return `${new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString().slice(0, 19)}Z`;
}

/** @param {unknown} value */
function assertUserId(value) {
  const id = String(value ?? "");
  if (!id.trim() || id.length > 200 || [...id].some((character) => character.charCodeAt(0) < 32)) {
    throw invalid("userId");
  }
  return id;
}

/** The switches an account has set, or every switch off when it has set none.
 *  @param {any} row */
function publicSettings(row) {
  return {
    learningPaused: row?.learning_paused === true,
    recallPaused: row?.recall_paused === true,
    pausedProjects: Array.isArray(row?.paused_projects) ? row.paused_projects.map(String) : [],
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** @param {unknown} value */
function pausedProjectList(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "memory_settings_invalid", "pausedProjects must be a list of project ids.");
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()))];
  if (ids.some((id) => !projectIdPattern.test(id))) {
    throw new HttpError(400, "memory_settings_invalid", "pausedProjects holds something that is not a project id.");
  }
  if (ids.length > MEMORY_PAUSED_PROJECT_LIMIT) {
    throw new HttpError(400, "memory_settings_invalid", `At most ${MEMORY_PAUSED_PROJECT_LIMIT} projects can be paused.`);
  }
  return ids;
}

/**
 * Whether memory may be written, and read, for one account in one project —
 * and, given a session, in one conversation.
 *
 * Read through a function rather than off the store directly because not every
 * store has the switches: a deployment without the control-plane database has
 * no memory to pause, and the doubles the tests use predate them.
 * Both read as "nothing paused", which is the behaviour before the switches.
 *
 * A conversation trying someone else's capsule (`trial`) neither writes nor
 * recalls this researcher's memory: it reads the pack alone (build spec
 * §9.4-5 「该会话只读这个包」), so what it shows is the pack's effect and not
 * the pack mixed with the researcher's own. It read the researcher's memory
 * until 2026-09-29. 无痕 used to be the third thing read here; it was deleted on
 * 2026-09-20 with the bar that was its only control, and the account-level
 * recall pause is the remaining switch.
 *
 * @param {any} store @param {string} userId @param {string | null} projectId @param {string | null} [sessionId]
 * @returns {Promise<{ learning: boolean, recall: boolean, trial: boolean }>} true = paused
 */
export async function memoryPausedFor(store, userId, projectId, sessionId = null) {
  if (typeof store?.settings !== "function" || store.configured === false) {
    return { learning: false, recall: false, trial: false };
  }
  const settings = await store.settings(userId);
  const projectPaused = Boolean(projectId) && settings.pausedProjects.includes(String(projectId));
  // A conversation id this store cannot hold has no state. Any other failure
  // is the store's, and propagates.
  const session = sessionId && projectId && typeof store.sessionState === "function"
    ? await store.sessionState(userId, projectId, sessionId).catch((/** @type {any} */ error) => {
      if (error?.code === "memory_session_invalid") return { trialCapsuleId: null };
      throw error;
    })
    : { trialCapsuleId: null };
  // A conversation trying someone else's capsule (「试用一次」) writes nothing
  // into this researcher's memory and reads nothing out of it.
  const trial = Boolean(session.trialCapsuleId);
  return {
    learning: settings.learningPaused || projectPaused || trial,
    recall: settings.recallPaused || projectPaused || trial,
    trial,
  };
}

/**
 * Whether a conversation's run was over before the account reset its memory (`MemorySettingsStore.noteReset`).
 *
 * The run's finish, or its start when the ledger has no finish. A run whose time cannot be read is not placed before
 * anything: a rule that needs the metadata to be present before it lets anything through is one missing field away from a
 * platform that quietly stops learning.
 * @param {{ finishedAt?: unknown, startedAt?: unknown } | null | undefined} run @param {string | null | undefined} resetAt
 * @returns {boolean}
 */
export function endedBeforeReset(run, resetAt) {
  if (!resetAt) return false;
  const reset = Date.parse(resetAt);
  const ended = Date.parse(String(run?.finishedAt ?? run?.startedAt ?? ""));
  return Number.isFinite(reset) && Number.isFinite(ended) && ended < reset;
}

/** @param {unknown} value */
function assertSessionId(value) {
  const id = String(value ?? "");
  if (!SESSION_ID.test(id)) throw new HttpError(400, "memory_session_invalid", "The session id is invalid.");
  return id;
}

/** @param {unknown} value */
function assertProjectId(value) {
  const id = String(value ?? "").trim();
  if (!projectIdPattern.test(id)) throw new HttpError(400, "memory_session_invalid", "The project id is invalid.");
  return id;
}

/** @param {any} row */
function publicSessionState(row) {
  return {
    trialCapsuleId: typeof row?.trial_capsule_id === "string" ? row.trial_capsule_id : null,
    updatedAt: row?.updated_at ? memoryInstant(row.updated_at) : null,
  };
}

/**
 * What a database failure means to a caller.
 *
 * A connection that is down is 503 and nothing else: chat and autopilot read
 * this code to decide between degrading and refusing, and a store that
 * is merely unreachable must never look like a rejected payload. A constraint
 * the store's own validation should have caught first is the opposite case —
 * the payload really is invalid — and it says so rather than hiding behind an
 * outage code.
 * @param {any} error
 */
function memoryDatabaseError(error) {
  if (error instanceof HttpError) return error;
  const code = String(error?.code ?? "");
  if (code === "23505") return new HttpError(409, "memory_conflict", "That memory setting changed while this write was in flight.");
  if (code.startsWith("23")) return new HttpError(400, "memory_payload_invalid", "The memory settings store refused this write.");
  if (code === "57014" || code === "ETIMEDOUT" || error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new HttpError(503, "memory_timeout", "The memory settings store did not answer in time.");
  }
  return new HttpError(503, "memory_unavailable", "The memory settings store is unavailable.");
}

export class MemorySettingsStore {
  /** @param {any} _config @param {{ database?: any }} [options] */
  constructor(_config, { database = null } = {}) {
    this.database = database ?? null;
  }

  /** The store exists exactly when the control-plane database does: a deployment without one has no switches to hold. */
  get configured() {
    return Boolean(this.database);
  }

  #assertConfigured() {
    if (!this.database) {
      throw new HttpError(503, "memory_unconfigured", "The memory settings store is not configured.");
    }
  }

  /** @param {string} text @param {any[]} values */
  async #query(text, values = []) {
    this.#assertConfigured();
    try {
      await migrateMemorySettings(this.database);
      return await this.database.query(text, values);
    } catch (error) {
      throw memoryDatabaseError(error);
    }
  }

  async status() {
    if (!this.database) {
      return { configured: false, connected: false, code: "memory_unconfigured" };
    }
    try {
      await migrateMemorySettings(this.database);
      await this.database.query("SELECT 1 FROM evimed_memory.settings LIMIT 1");
      return { configured: true, connected: true, code: null };
    } catch (error) {
      const code = ["42P01", "3F000"].includes(String(error?.code ?? ""))
        ? "memory_schema_unavailable"
        : memoryDatabaseError(error).code;
      return { configured: true, connected: false, code };
    }
  }

  // --------------------------------------------------------------- settings

  /**
   * The researcher's own switches (2026-09-16 review, M4④): stop learning new
   * memories, stop using memories in answers, and projects where neither
   * happens. Nothing is deleted by any of them; reset is a separate, explicit
   * act.
   * @param {string} userId
   */
  async settings(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.settings WHERE user_id=$1", [assertUserId(userId)]);
    return publicSettings(result.rows[0] ?? null);
  }

  /**
   * Whether the account still exists. A debounced commit of a conversation fires seconds after its turn, and an account deleted in
   * between (a throwaway account of an acceptance run) must cost the engine nothing: settings alone cannot say, because an account that
   * never changed a switch has no row either way.
   * @param {string} userId
   */
  async accountExists(userId) {
    const result = await this.#query("SELECT 1 FROM evimed_control.users WHERE id=$1", [assertUserId(userId)]);
    return result.rows.length === 1;
  }

  /**
   * Change some switches and leave the rest as they are, in one statement: two
   * tabs flipping different switches at once must both win.
   * @param {string} userId
   * @param {{ learningPaused?: unknown, recallPaused?: unknown, pausedProjects?: unknown }} patch
   */
  async updateSettings(userId, patch) {
    const owner = assertUserId(userId);
    /** @param {unknown} value @param {string} name */
    const flag = (value, name) => {
      if (value === undefined) return null;
      if (typeof value !== "boolean") throw new HttpError(400, "memory_settings_invalid", `${name} must be true or false.`);
      return value;
    };
    const learning = flag(patch?.learningPaused, "learningPaused");
    const recall = flag(patch?.recallPaused, "recallPaused");
    const projects = patch?.pausedProjects === undefined ? null : pausedProjectList(patch.pausedProjects);
    const result = await this.#query(`INSERT INTO evimed_memory.settings AS s
        (user_id, learning_paused, recall_paused, paused_projects, updated_at)
      VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::boolean, false), COALESCE($4::text[], '{}'),
        date_trunc('second', clock_timestamp()))
      ON CONFLICT (user_id) DO UPDATE SET
        learning_paused = COALESCE($2::boolean, s.learning_paused),
        recall_paused = COALESCE($3::boolean, s.recall_paused),
        paused_projects = COALESCE($4::text[], s.paused_projects),
        updated_at = date_trunc('second', clock_timestamp())
      RETURNING *`, [owner, learning, recall, projects]);
    return publicSettings(result.rows[0]);
  }

  /**
   * Record that the account asked to start from nothing, now (「重置记忆」). Taken before anything is deleted, so no
   * conversation that ended after it can be mistaken for one that ended before. The switches are left as they are.
   * @param {string} userId @returns {Promise<string>} the instant, to the millisecond
   */
  async noteReset(userId) {
    const result = await this.#query(`INSERT INTO evimed_memory.settings AS s (user_id, reset_at, updated_at)
      VALUES ($1, clock_timestamp(), date_trunc('second', clock_timestamp()))
      ON CONFLICT (user_id) DO UPDATE SET reset_at = clock_timestamp(), updated_at = date_trunc('second', clock_timestamp())
      RETURNING reset_at`, [assertUserId(userId)]);
    return new Date(result.rows[0].reset_at).toISOString();
  }

  /**
   * When the account last reset its memory, or null. What the native turn commit, the memory gateway and the learning loop hold a
   * conversation against (`endedBeforeReset`).
   * @param {string} userId @returns {Promise<string | null>}
   */
  async resetInstant(userId) {
    const result = await this.#query("SELECT reset_at FROM evimed_memory.settings WHERE user_id=$1", [assertUserId(userId)]);
    const at = result.rows[0]?.reset_at;
    return at ? new Date(at).toISOString() : null;
  }

  // --------------------------------------------------------------- sessions

  /**
   * One conversation's memory state; nothing set when it has none. All that is left of it is the shared capsule the conversation
   * is trying.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   */
  async sessionState(userId, projectId, sessionId) {
    const result = await this.#query(`SELECT * FROM evimed_memory.sessions
      WHERE user_id=$1 AND project_id=$2 AND session_id=$3`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId)]);
    return publicSessionState(result.rows[0] ?? null);
  }

  /**
   * The conversations of one project that are trying a shared capsule, by
   * session id — what the conversation lists mark with 「试用 ·」.
   * @param {string} userId @param {string} projectId @returns {Promise<Set<string>>}
   */
  async trialSessions(userId, projectId) {
    const result = await this.#query(`SELECT session_id FROM evimed_memory.sessions
      WHERE user_id=$1 AND project_id=$2 AND trial_capsule_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1000`,
    [assertUserId(userId), assertProjectId(projectId)]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.session_id)));
  }

  /**
   * Mark a conversation as trying a shared capsule, or end the trial (`null`).
   * @param {string} userId @param {string} projectId @param {string} sessionId
   * @param {{ trialCapsuleId?: unknown }} patch
   */
  async updateSessionState(userId, projectId, sessionId, patch) {
    const owner = assertUserId(userId);
    const project = assertProjectId(projectId);
    const session = assertSessionId(sessionId);
    const trialGiven = patch?.trialCapsuleId !== undefined;
    if (trialGiven && patch.trialCapsuleId !== null
      && (typeof patch.trialCapsuleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(patch.trialCapsuleId))) {
      throw new HttpError(400, "memory_session_invalid", "The trial capsule id is invalid.");
    }
    const result = await this.#query(`INSERT INTO evimed_memory.sessions AS s (user_id, project_id, session_id, trial_capsule_id)
      VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN $5::text ELSE NULL END)
      ON CONFLICT (user_id, project_id, session_id) DO UPDATE SET
        trial_capsule_id = CASE WHEN $4::boolean THEN $5::text ELSE s.trial_capsule_id END,
        updated_at = date_trunc('second', clock_timestamp())
      RETURNING *`,
    [owner, project, session, trialGiven, trialGiven ? patch.trialCapsuleId : null]);
    return publicSessionState(result.rows[0]);
  }

  /**
   * What this conversation was last handed of the resident profile, and when the kernel last compacted it (review M6): the
   * digest of the block it was given, when, and the compaction that came after — a compaction takes the block out of the
   * history it was written into, so the next dispatch hands it over again.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   *
   * `compactedSince` is whether the compaction came after the hand-over, decided by the database at its own precision: the two
   * instants below are milliseconds, and a compaction in the millisecond of a hand-over is later than it.
   * @returns {Promise<{ digest: string | null, deliveredAt: string | null, compactedAt: string | null, compactedSince: boolean }>}
   */
  async residentState(userId, projectId, sessionId) {
    const result = await this.#query(`SELECT resident_digest, resident_delivered_at, compacted_at, resident_memos,
        (compacted_at IS NOT NULL AND (resident_delivered_at IS NULL OR compacted_at > resident_delivered_at)) AS compacted_since
      FROM evimed_memory.sessions WHERE user_id=$1 AND project_id=$2 AND session_id=$3`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId)]);
    const row = result.rows[0];
    return {
      digest: typeof row?.resident_digest === "string" ? row.resident_digest : null,
      deliveredAt: row?.resident_delivered_at ? new Date(row.resident_delivered_at).toISOString() : null,
      compactedAt: row?.compacted_at ? new Date(row.compacted_at).toISOString() : null,
      compactedSince: row?.compacted_since === true,
      /** What the block held, as `{ id, kind, scope }` (the run record's own shape), for the run a turn typed in the kernel's composer becomes. */
      memos: Array.isArray(row?.resident_memos) ? row.resident_memos : [],
    };
  }

  /**
   * The conversation was handed the profile whose digest this is, now. Called after the prompt that carried it was accepted,
   * so a dispatch that failed leaves the next one to hand it over.
   * @param {string} userId @param {string} projectId @param {string} sessionId @param {string} digest
   * @param {readonly { id: string, kind?: string, scope?: string }[]} [memos] what the block held, for the run record
   */
  async noteResidentDelivered(userId, projectId, sessionId, digest, memos = []) {
    if (!/^[a-f0-9]{64}$/.test(String(digest))) throw invalid("digest");
    const held = memos.slice(0, 40).map((memo) => ({ id: String(memo.id).slice(0, 200), ...(memo.kind ? { kind: String(memo.kind).slice(0, 60) } : {}), ...(memo.scope ? { scope: String(memo.scope).slice(0, 60) } : {}) }));
    await this.#query(`INSERT INTO evimed_memory.sessions AS s (user_id, project_id, session_id, resident_digest, resident_delivered_at, resident_memos)
      VALUES ($1, $2, $3, $4, clock_timestamp(), $5::jsonb)
      ON CONFLICT (user_id, project_id, session_id) DO UPDATE SET resident_digest = $4, resident_delivered_at = clock_timestamp(), resident_memos = $5::jsonb,
        updated_at = date_trunc('second', clock_timestamp())`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId), digest, JSON.stringify(held)]);
  }

  /**
   * The kernel compacted this conversation, now. A conversation that was never handed the profile has nothing to lose, and
   * the row this writes says nothing until one is.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   */
  async noteCompaction(userId, projectId, sessionId) {
    await this.#query(`INSERT INTO evimed_memory.sessions AS s (user_id, project_id, session_id, compacted_at)
      VALUES ($1, $2, $3, clock_timestamp())
      ON CONFLICT (user_id, project_id, session_id) DO UPDATE SET compacted_at = clock_timestamp(),
        updated_at = date_trunc('second', clock_timestamp())`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId)]);
  }

  // ------------------------------------------------------- deletion, export

  /**
   * What a deleted project leaves behind in this store: the state of each of its conversations. The engine's own memory of the
   * project is `NativeMemoryStore.deleteProject`'s, and the capsule's notes go with the capsule service.
   * @param {string} userId @param {string} projectId
   */
  async deleteProjectState(userId, projectId) {
    const owner = assertUserId(userId);
    const scopeId = String(projectId ?? "").trim();
    if (!scopeId) throw new HttpError(400, "memory_payload_invalid", "projectId is required.");
    const states = await this.#query("DELETE FROM evimed_memory.sessions WHERE user_id=$1 AND project_id=$2 RETURNING session_id", [owner, scopeId]);
    return { conversations: Number(states.rowCount ?? 0) };
  }

  /**
   * What this store holds about an account, for its export: the switches. The memories themselves are the engine's and travel as
   * its own pack (`memory/native-memory.zip`). A database that still carries legacy structured records the retirement did not drop
   * (`legacyMemoryRetirement.mjs` keeps them when it finds any) hands them over too: everything held about a person is in their copy.
   * @param {string} userId
   */
  async exportUserMemory(userId) {
    const owner = assertUserId(userId);
    const settings = await this.settings(owner);
    const present = await this.#query("SELECT to_regclass('evimed_memory.records') AS table_name");
    const legacy = present.rows[0]?.table_name
      ? (await this.#query(`SELECT id, scope, scope_id, kind, key, value, summary, origin, status, sensitive, created_at, updated_at
          FROM evimed_memory.records WHERE user_id=$1 ORDER BY created_at, id`, [owner])).rows
      : [];
    return { version: 2, settings, ...(legacy.length ? { legacyRecords: legacy } : {}) };
  }

  /**
   * What a reset removes from this store: the topic grouping a model made of the account's memories names what they were
   * about, so it goes with them. The switches stay: a reset is a clean slate, not a change of mind about learning.
   * @param {string} userId
   */
  async purgeUserMemory(userId) {
    await this.#query("DELETE FROM evimed_memory.topic_sets WHERE user_id=$1", [assertUserId(userId)]);
    return {};
  }
}
