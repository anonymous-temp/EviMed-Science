import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { recordShareRefused } from "./capsuleShareMetrics.mjs";

/**
 * Share links and deliveries of a memory capsule inside the platform (evidence-flywheel plan §7, F17a and F17b, 2026-10-05).
 *
 * Hidden knowledge:
 *
 * - **The documents ledger is one account's; a share is two accounts'.** A snapshot belongs to its author and a link or a
 *   delivery is read by somebody else, so the relation lives in a schema of its own (`evimed_share`), created by this
 *   module's idempotent migration, with a cascade from both accounts: deleting an account takes its links, its deliveries
 *   and every use of them with it.
 * - **The token is the only credential and it is never stored.** 24 random bytes (192 bits) travel in the address
 *   `/app/memory/shared/<token>`; the row holds its SHA-256. A token of that entropy needs no salt, and a database reader
 *   learns nothing they could redeem. It is shown once, in the answer that creates the link.
 * - **A link opens one snapshot and only that snapshot.** It is bound to the snapshot's manifest hash, so a newer snapshot of
 *   the same capsule is a different pack that needs its own link; revoking the snapshot (or the link) ends it at once.
 * - **A use is one account's first look, not a click.** The cap counts distinct signed-in accounts, so reading the preview
 *   twice does not burn it, and the check-and-count is one statement: two accounts racing for the last use cannot both get it.
 * - **The pack of a link is sealed with a password the platform chose.** A link has no list of recipients to seal for, so the
 *   snapshot behind it is sealed under a random secret kept in the row; the recipient never types it and never holds a file.
 *   The secret protects nothing the database does not already hold in the clear (the capsule's facts), and it dies with the
 *   link.
 * - **The owner's account id never leaves.** What a redeemer is shown is the pack's own card — the author's display name.
 *
 * @module capsuleShareLinks
 */

export const SHARE_LINK_TOKEN_BYTES = 24;
/** The most unrevoked, unexpired links one account holds at once. */
export const SHARE_LINKS_PER_ACCOUNT = 50;
const DAY_MS = 86_400_000;

const SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_share;
CREATE TABLE IF NOT EXISTS evimed_share.links (
 id text PRIMARY KEY,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 owner_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 capsule_id text NOT NULL, snapshot_id text NOT NULL,
 manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
 archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
 archive_secret text NOT NULL,
 max_uses integer NOT NULL CHECK (max_uses > 0), uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS share_links_owner_idx ON evimed_share.links(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_links_snapshot_idx ON evimed_share.links(snapshot_id);
CREATE TABLE IF NOT EXISTS evimed_share.link_uses (
 link_id text NOT NULL REFERENCES evimed_share.links(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 first_used_at timestamptz NOT NULL DEFAULT clock_timestamp(), imported_at timestamptz,
 PRIMARY KEY (link_id, user_id)
);
CREATE TABLE IF NOT EXISTS evimed_share.deliveries (
 id text PRIMARY KEY,
 snapshot_id text NOT NULL,
 owner_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 capsule_id text NOT NULL,
 manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
 archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'delivered' CHECK (state IN ('delivered','opened','imported','declined','withdrawn','taken_down')),
 notice_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 opened_at timestamptz, imported_at timestamptz, closed_at timestamptz,
 UNIQUE (snapshot_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS share_deliveries_recipient_idx ON evimed_share.deliveries(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_deliveries_owner_idx ON evimed_share.deliveries(owner_id, created_at DESC);
`;
const migrations = new WeakMap();

/** @param {any} database */
export async function migrateCapsuleShare(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-capsule-share-v1'))");
    await client.query(SQL);
  });
  migrations.set(database, attempt);
  try { await attempt; } catch (error) { migrations.delete(database); throw error; }
}

/** @param {string} token */
export const shareTokenHash = (token) => createHash("sha256").update(token, "utf8").digest("hex");
/** A token as the address carries it: unguessable and URL-safe. */
export const newShareToken = () => randomBytes(SHARE_LINK_TOKEN_BYTES).toString("base64url");
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32}$/;

/** @param {any} row */
function linkView(row, now = Date.now()) {
  const expired = Date.parse(row.expires_at) <= now;
  return {
    id: row.id, capsuleId: row.capsule_id, snapshotId: row.snapshot_id, manifestSha256: row.manifest_sha256,
    uses: Number(row.uses), maxUses: Number(row.max_uses), importedCount: Number(row.imported_count ?? 0),
    expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    state: row.revoked_at ? "revoked" : expired ? "expired" : Number(row.uses) >= Number(row.max_uses) ? "exhausted" : "active",
  };
}

export class CapsuleShareLinks {
  /**
   * @param {{ database: any, ttlDays?: number, maxUses?: number, now?: () => number }} options
   */
  constructor({ database, ttlDays = 30, maxUses = 20, now = Date.now }) {
    this.database = database;
    this.ttlDays = ttlDays;
    this.maxUses = maxUses;
    this.now = now;
  }

  /**
   * A new link for a snapshot its owner just sealed for it. The token is in this answer and nowhere else.
   * @param {string} ownerId @param {{ capsuleId: string, snapshotId: string, manifestSha256: string, archiveSha256: string, secret: string }} snapshot
   * @param {{ ttlDays?: number, maxUses?: number }} [asked]
   */
  async create(ownerId, snapshot, asked = {}) {
    await migrateCapsuleShare(this.database);
    const ttlDays = asked.ttlDays ?? this.ttlDays;
    const maxUses = asked.maxUses ?? this.maxUses;
    if (!Number.isSafeInteger(ttlDays) || ttlDays < 1 || ttlDays > this.ttlDays
      || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > this.maxUses) {
      throw new HttpError(400, "capsule_payload_invalid", "Invalid link expiry or use cap.");
    }
    const live = await this.database.query(
      "SELECT count(*)::integer AS n FROM evimed_share.links WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()", [productId(ownerId, "user")]);
    if (live.rows[0].n >= SHARE_LINKS_PER_ACCOUNT) throw new HttpError(409, "capsule_share_links_limit", "Too many active share links.");
    const token = newShareToken();
    const id = `lnk_${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(this.now() + ttlDays * DAY_MS).toISOString();
    const row = (await this.database.query(`INSERT INTO evimed_share.links
      (id,token_hash,owner_id,capsule_id,snapshot_id,manifest_sha256,archive_sha256,archive_secret,max_uses,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, shareTokenHash(token), ownerId, snapshot.capsuleId, snapshot.snapshotId, snapshot.manifestSha256, snapshot.archiveSha256, snapshot.secret, maxUses, expiresAt])).rows[0];
    return { token, path: `/app/memory/shared/${token}`, link: linkView(row, this.now()) };
  }

  /**
   * The owner's links, newest first, with how often each was used and how many redeemers kept it.
   * @param {string} ownerId @param {{ capsuleId?: string | null }} [options]
   */
  async list(ownerId, { capsuleId = null } = {}) {
    await migrateCapsuleShare(this.database);
    const rows = (await this.database.query(`SELECT l.*, (SELECT count(*) FROM evimed_share.link_uses u WHERE u.link_id=l.id AND u.imported_at IS NOT NULL)::integer AS imported_count
      FROM evimed_share.links l WHERE l.owner_id=$1 AND ($2::text IS NULL OR l.capsule_id=$2) ORDER BY l.created_at DESC, l.id LIMIT 100`,
    [productId(ownerId, "user"), capsuleId])).rows;
    return rows.map((row) => linkView(row, this.now()));
  }

  /** @param {string} ownerId @param {string} linkId */
  async revoke(ownerId, linkId) {
    await migrateCapsuleShare(this.database);
    const row = (await this.database.query(
      "UPDATE evimed_share.links SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND owner_id=$2 RETURNING *", [productId(linkId, "link"), productId(ownerId, "user")])).rows[0];
    if (!row) throw new HttpError(404, "capsule_share_not_found", "The share is unavailable.");
    return linkView(row, this.now());
  }

  /** Every link of a snapshot ends with it. @param {string} ownerId @param {readonly string[]} snapshotIds */
  async revokeForSnapshots(ownerId, snapshotIds) {
    if (!snapshotIds.length) return 0;
    await migrateCapsuleShare(this.database);
    const result = await this.database.query(
      "UPDATE evimed_share.links SET revoked_at=clock_timestamp() WHERE owner_id=$1 AND snapshot_id=ANY($2::text[]) AND revoked_at IS NULL", [ownerId, snapshotIds]);
    return result.rowCount ?? 0;
  }

  /**
   * Redeem a token for a signed-in account: the link's snapshot and the secret that opens it, and a use counted for this
   * account if it has none yet. An unknown token and a malformed one are the same answer. The owner reading their own link
   * counts no use: the cap guards other people's looks.
   * @param {string} userId @param {unknown} token
   * @returns {Promise<{ link: ReturnType<typeof linkView> & { ownerId: string }, secret: string, firstUse: boolean }>}
   */
  async redeem(userId, token) {
    await migrateCapsuleShare(this.database);
    if (typeof token !== "string" || !TOKEN_FORMAT.test(token)) throw new HttpError(404, "capsule_share_not_found", "The share is unavailable.");
    return this.database.transaction(async (/** @type {any} */ client) => {
      const found = (await client.query("SELECT * FROM evimed_share.links WHERE token_hash=$1 FOR UPDATE", [shareTokenHash(token)])).rows[0];
      if (!found) throw new HttpError(404, "capsule_share_not_found", "The share is unavailable.");
      const refuse = (/** @type {string} */ reason, /** @type {number} */ status, /** @type {string} */ code) => {
        recordShareRefused(reason);
        return new HttpError(status, code, "This share link can no longer be used.");
      };
      if (found.revoked_at) throw refuse("link_revoked", 410, "capsule_share_link_revoked");
      if (Date.parse(found.expires_at) <= this.now()) throw refuse("link_expired", 410, "capsule_share_link_expired");
      let firstUse = false;
      if (found.owner_id !== userId) {
        const seen = await client.query("SELECT 1 FROM evimed_share.link_uses WHERE link_id=$1 AND user_id=$2", [found.id, userId]);
        if (!seen.rowCount) {
          if (Number(found.uses) >= Number(found.max_uses)) throw refuse("link_exhausted", 410, "capsule_share_link_exhausted");
          await client.query("INSERT INTO evimed_share.link_uses(link_id,user_id) VALUES($1,$2)", [found.id, userId]);
          found.uses = Number((await client.query("UPDATE evimed_share.links SET uses=uses+1 WHERE id=$1 RETURNING uses", [found.id])).rows[0].uses);
          firstUse = true;
        }
      }
      return { link: { ...linkView(found, this.now()), ownerId: found.owner_id }, secret: found.archive_secret, firstUse };
    });
  }

  /** A redeemer imported the pack. @param {string} userId @param {string} linkId */
  async markImported(userId, linkId) {
    await migrateCapsuleShare(this.database);
    await this.database.query("UPDATE evimed_share.link_uses SET imported_at=COALESCE(imported_at,clock_timestamp()) WHERE link_id=$1 AND user_id=$2", [linkId, userId]);
  }
}
