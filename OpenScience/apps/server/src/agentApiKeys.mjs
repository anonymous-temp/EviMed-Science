import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./security.mjs";

/**
 * Account-level API keys: the credential an agent that is not ours presents.
 *
 * Hidden knowledge: until this existed the control plane had exactly two
 * inbound identities, and neither could be given to anybody. A browser session
 * cookie belongs to a logged-in person in a browser; a workload token is minted
 * per runtime container, lives minutes, and is bound to one project the control
 * plane chose. An external agent has neither and can be handed neither, which
 * is why "can another agent call our memory API" had the answer "no" for a
 * reason that had nothing to do with the memory API.
 *
 * Four properties, each of which is the reason for a line below:
 *
 *  - **The secret leaves once.** Stored as a SHA-256 digest, returned in full
 *    only from `create`. A key an operator can read back is a key a database
 *    dump hands over, and there is no repair for that but rotation.
 *  - **The prefix is not the secret.** The first twelve characters are stored
 *    in the clear so a person can tell two keys apart in a list and revoke the
 *    right one. Losing that is how revocation becomes "rotate everything".
 *  - **Lookup is by digest, not by scan.** Presenting a key is one indexed
 *    read, and the comparison is constant time, so the store cannot be used as
 *    an oracle for how close a guess was.
 *  - **Scope is a property of the key, not of the request.** A key carries its
 *    scopes and, optionally, the one project it may touch. A caller cannot
 *    widen either by asking.
 *
 * And one kind of key that speaks for more than one person. An **integration
 * key** (`subjects: true`) is held by an institution — the TCM CDSS behind a
 * hospital's HIS — and a request made with it may name the doctor it is for in
 * an `X-Subject` header. Each doctor is an account of its own
 * (`subjectAccount`), because every memory table is keyed by account: scoping
 * reads and writes by a column the tables do not have would be a filter each
 * query must remember, and the one that forgets leaks one doctor's habits into
 * another's prescriptions. Absent the header, the key's own account — the
 * institution — is the one read and written, which is the 甲方 plan's
 * 「未传入时，个性化内容按机构或科室级生效」. A subject account has no password
 * and no identity provider (`auth_type = 'subject'`), so nobody can sign in as
 * one; it is reached only through its institution's key, and it goes when the
 * institution's account goes.
 *
 * @module agentApiKeys
 */

const migrations = new WeakMap();

/** What a key may do. Closed on purpose: a scope a caller can invent is not a
 * scope. `memory.read` recalls and lists; `memory.write` proposes — and what it
 * proposes is still pending, which is the external API's own rule.
 * `memory.manage` is the person's own dashboard: confirming, editing,
 * forgetting and undoing memories, stopping and restoring methods, the
 * switches. A key carries it only when its holder's requests come from that
 * person's own clicks, and it is never a default. `memory.observe` posts what
 * a person actually did — a prescription edit — which the platform counts
 * into habits that take effect (agentMemoryObservations.mjs). */
export const AGENT_KEY_SCOPES = Object.freeze(["memory.read", "memory.write", "memory.manage", "memory.observe"]);

const KEY_PREFIX = "evk_";
const PREFIX_LENGTH = KEY_PREFIX.length + 8;

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_agent;
CREATE TABLE IF NOT EXISTS evimed_agent.api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 8 AND 32),
  key_digest text NOT NULL UNIQUE CHECK (char_length(key_digest) = 64),
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scopes)='array'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz(3),
  expires_at timestamptz(3),
  revoked_at timestamptz(3),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_api_keys_account_idx ON evimed_agent.api_keys(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_api_keys_project_fk_idx ON evimed_agent.api_keys(user_id,project_id);

-- 2026-09-27. An integration key speaks for the people behind an institution,
-- one account each, so it cannot also be pinned to one of the institution's
-- projects: those are the institution's, not the doctors'.
ALTER TABLE evimed_agent.api_keys ADD COLUMN IF NOT EXISTS subjects boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_agent.api_keys DROP CONSTRAINT IF EXISTS api_keys_subjects_unbound;
ALTER TABLE evimed_agent.api_keys ADD CONSTRAINT api_keys_subjects_unbound CHECK (NOT subjects OR project_id IS NULL);

-- The account each subject an institution named has. The subject itself is
-- never stored: the HIS identifier is the integrator's, and a digest is all a
-- lookup needs.
CREATE TABLE IF NOT EXISTS evimed_agent.subjects (
  owner_user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  subject_digest text NOT NULL CHECK (char_length(subject_digest) = 64),
  user_id text NOT NULL UNIQUE REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, subject_digest)
);
`;

/**
 * What an `X-Subject` may be: an opaque, printable identifier. The 甲方 plan
 * asks the HIS for 「不含个人信息的内部标识」, so this is a shape check, not a
 * judgement about what the value means.
 */
export const AGENT_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,127}$/;

/** The account id of one subject of one institution. Deterministic, so two
 *  first requests for the same doctor land on one account, and prefixed so no
 *  sign-in path can mint it (`evimed_` and OIDC ids never start this way, and
 *  either would be refused as an identity collision if one did).
 *  @param {string} ownerUserId @param {string} subject */
export function subjectAccountId(ownerUserId, subject) {
  return `subj_${subjectDigest(ownerUserId, subject).slice(0, 40)}`;
}

/** @param {string} ownerUserId @param {string} subject */
function subjectDigest(ownerUserId, subject) {
  return createHash("sha256").update(`${ownerUserId}\u0000${subject}`, "utf8").digest("hex");
}

/** @param {unknown} value @returns {string} */
export function assertAgentSubject(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!AGENT_SUBJECT_PATTERN.test(text)) {
    throw new HttpError(400, "agent_subject_invalid", "X-Subject must be 1–128 printable characters: letters, digits and . _ : @ / + = -.");
  }
  return text;
}

/** @param {any} database */
export async function migrateAgentApiKeys(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-agent-keys-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
  return attempt;
}

/** @param {string} secret */
function digestOf(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** @param {any} row */
function record(row) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id ?? null,
    // An integration key: requests may name the person they are for.
    subjects: row.subjects === true,
    keyPrefix: row.key_prefix,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : row.last_used_at ?? null,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at ?? null,
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at ?? null,
  };
}

export class AgentApiKeyStore {
  /** @param {any} database */
  constructor(database) {
    this.database = database;
  }

  /**
   * Mint a key. The only moment its secret exists outside a hash.
   * @param {string} userId
   * @param {{ name: string, scopes?: string[], projectId?: string | null, expiresInDays?: number | null, subjects?: boolean }} input
   * @returns {Promise<{ key: string } & ReturnType<typeof record>>}
   */
  async create(userId, input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120) throw new HttpError(400, "agent_key_name_invalid", "An API key needs a name of 1–120 characters.");
    const scopes = [...new Set(Array.isArray(input.scopes) && input.scopes.length ? input.scopes : ["memory.read"])];
    if (scopes.some((scope) => !AGENT_KEY_SCOPES.includes(scope))) {
      throw new HttpError(400, "agent_key_scope_invalid", `Scopes must be drawn from: ${AGENT_KEY_SCOPES.join(", ")}.`);
    }
    if (input.subjects != null && typeof input.subjects !== "boolean") {
      throw new HttpError(400, "agent_key_payload_invalid", "subjects must be a boolean.");
    }
    const subjects = input.subjects === true;
    if (subjects && input.projectId != null) {
      throw new HttpError(400, "agent_key_subjects_unbound", "An integration key speaks for many people and cannot be bound to one project.");
    }
    const days = input.expiresInDays == null ? null : Number(input.expiresInDays);
    if (days != null && (!Number.isInteger(days) || days < 1 || days > 730)) {
      throw new HttpError(400, "agent_key_expiry_invalid", "expiresInDays must be an integer between 1 and 730.");
    }
    await migrateAgentApiKeys(this.database);
    const secret = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = `agk_${randomBytes(9).toString("base64url")}`;
    const expiresAt = days == null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    const { rows } = await this.database.query(
      `INSERT INTO evimed_agent.api_keys (id,user_id,project_id,name,key_prefix,key_digest,scopes,expires_at,subjects)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [id, userId, input.projectId ?? null, name, secret.slice(0, PREFIX_LENGTH), digestOf(secret), JSON.stringify(scopes), expiresAt, subjects],
    );
    // The one time. Every later read of this row returns the record without it.
    return { ...record(rows[0]), key: secret };
  }

  /** @param {string} userId @returns {Promise<any[]>} */
  async list(userId) {
    await migrateAgentApiKeys(this.database);
    const { rows } = await this.database.query(
      "SELECT * FROM evimed_agent.api_keys WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200",
      [userId],
    );
    return rows.map(record);
  }

  /** @param {string} userId @param {string} id @returns {Promise<any>} */
  async revoke(userId, id) {
    await migrateAgentApiKeys(this.database);
    const { rows } = await this.database.query(
      "UPDATE evimed_agent.api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND id=$2 RETURNING *",
      [userId, id],
    );
    if (!rows[0]) throw new HttpError(404, "agent_key_not_found", "No such API key.");
    return record(rows[0]);
  }

  /**
   * Resolve a presented secret, or refuse.
   *
   * One indexed read on the digest rather than a scan and a per-row compare:
   * the comparison below is constant time so an attacker cannot learn how close
   * a guess was, and refusals are one code — a caller must not be able to tell
   * "no such key" from "revoked" from "expired", because that difference is an
   * account-enumeration oracle and tells a legitimate holder nothing they
   * cannot get from their own key list.
   *
   * @param {string | null | undefined} presented
   * @returns {Promise<{ userId: string, keyId: string, projectId: string | null, scopes: string[], subjects: boolean }>}
   */
  async resolve(presented) {
    const secret = String(presented ?? "");
    const refusal = new HttpError(401, "agent_key_invalid", "The API key is not valid.");
    if (!secret.startsWith(KEY_PREFIX) || secret.length < 20 || secret.length > 200) throw refusal;
    await migrateAgentApiKeys(this.database);
    const { rows } = await this.database.query(
      "SELECT * FROM evimed_agent.api_keys WHERE key_digest=$1 LIMIT 1",
      [digestOf(secret)],
    );
    const row = rows[0];
    if (!row) throw refusal;
    const stored = Buffer.from(String(row.key_digest), "utf8");
    const offered = Buffer.from(digestOf(secret), "utf8");
    if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) throw refusal;
    if (row.revoked_at) throw refusal;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw refusal;
    // Best effort: a clock write must never decide whether a call is served.
    this.database.query("UPDATE evimed_agent.api_keys SET last_used_at=clock_timestamp() WHERE id=$1", [row.id])
      .catch(() => {});
    return {
      userId: row.user_id,
      keyId: row.id,
      projectId: row.project_id ?? null,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      subjects: row.subjects === true,
    };
  }

  /**
   * The account one subject of one institution reads and writes, made on first
   * use. The institution must still exist; the account is created in the same
   * transaction as the row that says whose it is, so there is never an account
   * no institution owns.
   *
   * An account already holding the id that is not this institution's subject
   * is refused rather than adopted. The id space makes that a collision nobody
   * can arrange, and adopting it would hand a stranger's memory to a key.
   *
   * @param {string} ownerUserId @param {string} subject an `assertAgentSubject` value
   * @returns {Promise<{ userId: string, created: boolean }>}
   */
  async subjectAccount(ownerUserId, subject) {
    const text = assertAgentSubject(subject);
    await migrateAgentApiKeys(this.database);
    const digest = subjectDigest(ownerUserId, text);
    const id = subjectAccountId(ownerUserId, text);
    return this.database.transaction(async (/** @type {any} */ client) => {
      // The store's own identity lock, so a sign-in racing this insert on the
      // same id serialises behind it.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${id}`]);
      const owner = await client.query("SELECT 1 FROM evimed_control.users WHERE id=$1 FOR KEY SHARE", [ownerUserId]);
      if (owner.rowCount !== 1) throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");
      const known = await client.query(
        "SELECT user_id FROM evimed_agent.subjects WHERE owner_user_id=$1 AND subject_digest=$2",
        [ownerUserId, digest],
      );
      if (known.rows[0]) return { userId: String(known.rows[0].user_id), created: false };
      const taken = await client.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [id]);
      if (taken.rowCount) throw new HttpError(409, "agent_subject_conflict", "This subject cannot be given an account.");
      await client.query("DELETE FROM evimed_control.deleted_users WHERE id=$1", [id]);
      await client.query(
        "INSERT INTO evimed_control.users(id, name, password_hash, auth_type) VALUES ($1, $2, NULL, 'subject')",
        [id, `subject ${digest.slice(0, 8)}`],
      );
      await client.query(
        "INSERT INTO evimed_agent.subjects(owner_user_id, subject_digest, user_id) VALUES ($1, $2, $3)",
        [ownerUserId, digest, id],
      );
      return { userId: id, created: true };
    });
  }

  /**
   * The subject account of this institution named by this subject, or null —
   * a lookup that never creates one.
   * @param {string} ownerUserId @param {string} subject
   * @returns {Promise<string | null>}
   */
  async findSubjectAccount(ownerUserId, subject) {
    const text = assertAgentSubject(subject);
    await migrateAgentApiKeys(this.database);
    const { rows } = await this.database.query(
      "SELECT user_id FROM evimed_agent.subjects WHERE owner_user_id=$1 AND subject_digest=$2",
      [ownerUserId, subjectDigest(ownerUserId, text)],
    );
    return rows[0] ? String(rows[0].user_id) : null;
  }

  /**
   * Every subject account an institution holds, with the generation account
   * deletion checks against: what has to go before the institution does.
   * @param {string} ownerUserId
   * @returns {Promise<{ userId: string, accountCreatedAt: string }[]>}
   */
  async subjectAccounts(ownerUserId) {
    await migrateAgentApiKeys(this.database);
    const { rows } = await this.database.query(
      `SELECT s.user_id, u.created_at::text AS account_created_at FROM evimed_agent.subjects s
         JOIN evimed_control.users u ON u.id = s.user_id
        WHERE s.owner_user_id=$1 ORDER BY s.user_id`,
      [ownerUserId],
    );
    return rows.map((row) => ({ userId: String(row.user_id), accountCreatedAt: String(row.account_created_at) }));
  }
}

/**
 * Delete every account an institution's integration keys made (`subjectAccount`),
 * each the way an account is deleted: the derived recall copies first — an
 * index emptied for rows that still exist costs a degraded recall, the other
 * order leaves copies of deleted memory — then the rows, under the same index
 * and capsule hooks the account-deletion route uses. Only `subject` accounts:
 * the list is read from the mapping, and a row that is not one is skipped
 * rather than trusted.
 *
 * `only` names one of them: the integrator forgetting one person
 * (`DELETE /api/agent-memory/v1/subject`), by the same path.
 *
 * @param {{ apiKeys: AgentApiKeyStore | null, store: any, memorySubstrate: any, memoryIndexing?: any, capsuleTransfers?: any }} services
 * @param {string} ownerId @param {{ only?: string | null }} [options]
 * @returns {Promise<number>} how many accounts were deleted
 */
export async function deleteSubjectAccounts({ apiKeys, store, memorySubstrate, memoryIndexing = null, capsuleTransfers = null }, ownerId, { only = null } = {}) {
  if (!apiKeys) return 0;
  let deleted = 0;
  for (const { userId, accountCreatedAt } of await apiKeys.subjectAccounts(ownerId)) {
    if (only !== null && userId !== only) continue;
    const subject = await store.userById(userId);
    if (!subject || subject.authType !== "subject") continue;
    // Owed to the index in the deletion's own transaction when the deployment
    // keeps a ledger for it (`prepareAccountDeletion`); otherwise one attempt,
    // never waited on: the index holds derived copies only.
    await memoryIndexing?.withdrawals?.migrate();
    if (!memoryIndexing?.withdrawals) void Promise.resolve(memorySubstrate.forgetUser(userId)).catch(() => false);
    await store.deleteUser(subject, {
      beforeLock: memoryIndexing ? (/** @type {string} */ id, /** @type {any} */ client) => memoryIndexing.lockAccountDeletion(id, client) : null,
      beforeDelete: async (/** @type {string} */ id, /** @type {any} */ client) => {
        if (memoryIndexing) await memoryIndexing.prepareAccountDeletion(id, accountCreatedAt, client);
        if (capsuleTransfers) await capsuleTransfers.prepareAccountDeletion(id, client);
      },
    });
    if (capsuleTransfers) await capsuleTransfers.finishAccountDeletion(userId);
    void memoryIndexing?.withdrawals?.drain?.().catch(() => {});
    deleted += 1;
  }
  return deleted;
}
