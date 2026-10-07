/**
 * Public author handles: the only name an author has in a URL or a response another person can read (evidence-flywheel review
 * 2026-10-06; every public surface moved to it on 2026-10-06 after the public pages package, written earlier, still addressed authors
 * by account id).
 *
 * Hidden knowledge:
 *
 * - **The account id is the login name for a local account**, so it is a credential's half and an address book entry: it never
 *   appears in a page, a link, the sitemap, the API, the feed or another account's response. An author is `au_` and sixteen
 *   random hex digits, one per account, made on first need and the same ever after (`evimed_frontier.evidence_author_handles`;
 *   the row goes with the account).
 * - **Many at once, in one statement.** A page lists dozens of cards by several authors, so `authorHandlesFor` takes the whole set,
 *   reads the handles that exist and makes the missing ones in a single INSERT ... SELECT. A concurrent first need for the same
 *   account, or a collision of 64 random bits, loses to the row already there and is read back; an account that does not exist is
 *   simply absent from the answer.
 * - **A handle is looked up, an account id is never accepted.** `accountOfHandle` answers only a well-formed handle; an account id, a
 *   handle nobody holds and a malformed value are all the same `null`, so a page cannot be used to find out who has signed up.
 *
 * @module evidenceAuthorHandles
 */

import { randomBytes } from "node:crypto";
import { migrateEvidenceOrigins } from "./evidenceOrigins.mjs";

/** A public author handle: opaque, stable, random, one per account. */
export const EVIDENCE_AUTHOR_HANDLE = /^au_[a-f0-9]{16}$/;
/** Rounds of read-then-make before an account is given up on (a collision of 64 random bits needs one extra). */
const HANDLE_ATTEMPTS = 5;

const AUTHOR_HANDLES_SQL = `
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_author_handles (
 user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 handle text NOT NULL UNIQUE CHECK(handle ~ '^au_[a-f0-9]{16}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;
/** @type {WeakMap<object, Promise<void>>} */
const migrations = new WeakMap();

/** The handle table, made once per database; idempotent and safe to run twice. @param {any} database */
export async function migrateAuthorHandles(database) {
  await migrateEvidenceOrigins(database);
  if (!migrations.has(database)) {
    migrations.set(database, database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-evidence-author-handles-v1'))");
      await client.query(AUTHOR_HANDLES_SQL);
    }).catch((/** @type {unknown} */ error) => { migrations.delete(database); throw error; }));
  }
  await migrations.get(database);
}

/**
 * The handles of a set of accounts, made where missing. An account that does not exist has no entry.
 * @param {any} database @param {Iterable<unknown>} userIds
 * @returns {Promise<Map<string, string>>} account id → handle
 */
export async function authorHandlesFor(database, userIds) {
  const wanted = [...new Set([...userIds].filter((id) => typeof id === "string" && id).map(String))];
  /** @type {Map<string, string>} */
  const handles = new Map();
  if (!wanted.length) return handles;
  await migrateAuthorHandles(database);
  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
    const open = wanted.filter((id) => !handles.has(id));
    for (const row of (await database.query("SELECT user_id,handle FROM evimed_frontier.evidence_author_handles WHERE user_id=ANY($1::text[])", [open])).rows) {
      handles.set(String(row.user_id), String(row.handle));
    }
    const missing = open.filter((id) => !handles.has(id));
    if (!missing.length || attempt === HANDLE_ATTEMPTS - 1) break;
    // The join to users keeps an account that is gone from failing the whole statement on the foreign key.
    await database.query(
      `INSERT INTO evimed_frontier.evidence_author_handles(user_id,handle)
         SELECT u.id,t.handle FROM unnest($1::text[],$2::text[]) AS t(user_id,handle) JOIN evimed_control.users u ON u.id=t.user_id
       ON CONFLICT DO NOTHING`,
      [missing, missing.map(() => `au_${randomBytes(8).toString("hex")}`)],
    );
  }
  return handles;
}

/**
 * The account behind a handle, or null for anything that is not a handle somebody holds (an account id included).
 * @param {any} database @param {unknown} handle
 * @returns {Promise<{ id: string, name: string } | null>}
 */
export async function accountOfHandle(database, handle) {
  if (typeof handle !== "string" || !EVIDENCE_AUTHOR_HANDLE.test(handle)) return null;
  await migrateAuthorHandles(database);
  const row = (await database.query(
    "SELECT u.id,u.name FROM evimed_frontier.evidence_author_handles h JOIN evimed_control.users u ON u.id=h.user_id WHERE h.handle=$1", [handle])).rows[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}
