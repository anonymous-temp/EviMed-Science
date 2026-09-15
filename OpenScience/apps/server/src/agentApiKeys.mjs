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
 * @module agentApiKeys
 */

const migrations = new WeakMap();

/** What a key may do. Closed on purpose: a scope a caller can invent is not a
 * scope. `memory.read` recalls and lists; `memory.write` proposes — and what it
 * proposes is still pending, which is the external API's own rule. */
export const AGENT_KEY_SCOPES = Object.freeze(["memory.read", "memory.write"]);

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
`;

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
   * @param {{ name: string, scopes?: string[], projectId?: string | null, expiresInDays?: number | null }} input
   * @returns {Promise<{ key: string } & ReturnType<typeof record>>}
   */
  async create(userId, input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120) throw new HttpError(400, "agent_key_name_invalid", "An API key needs a name of 1–120 characters.");
    const scopes = [...new Set(Array.isArray(input.scopes) && input.scopes.length ? input.scopes : ["memory.read"])];
    if (scopes.some((scope) => !AGENT_KEY_SCOPES.includes(scope))) {
      throw new HttpError(400, "agent_key_scope_invalid", `Scopes must be drawn from: ${AGENT_KEY_SCOPES.join(", ")}.`);
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
      `INSERT INTO evimed_agent.api_keys (id,user_id,project_id,name,key_prefix,key_digest,scopes,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [id, userId, input.projectId ?? null, name, secret.slice(0, PREFIX_LENGTH), digestOf(secret), JSON.stringify(scopes), expiresAt],
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
   * @returns {Promise<{ userId: string, keyId: string, projectId: string | null, scopes: string[] }>}
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
    };
  }
}
