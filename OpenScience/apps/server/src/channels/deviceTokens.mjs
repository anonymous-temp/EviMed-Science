import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../security.mjs";
import { migrateChannels } from "./store.mjs";

/**
 * Device tokens: how a non-browser client — the own app, when it exists —
 * signs in (plan §3.6, reserved behind `OPEN_SCIENCE_APP_API_ENABLED`, off).
 *
 * Hidden knowledge: the control plane authenticates a browser by a session
 * cookie plus a CSRF token, and CSRF exists only because a browser attaches
 * the cookie to requests another site makes. A native client holds a bearer
 * token instead; nothing attaches it for anyone, so CSRF does not apply to it
 * — the same reasoning the agent memory API's keys already rest on.
 *
 * Built the way `agentApiKeys.mjs` is, for the same reasons: the secret leaves
 * once and is stored as a SHA-256 digest; the prefix is kept so a person can
 * tell devices apart and revoke the right one; lookup is one indexed read with
 * a constant-time compare; and every refusal is one code, so a caller cannot
 * tell "no such token" from "revoked" from "expired".
 *
 * A device token opens the run API and the event stream — the same routes the
 * web uses — and nothing else: `DEVICE_TOKEN_ROUTES` is the closed list. It
 * can never mint another token, delete the account or change a credential;
 * those stay behind a browser session.
 *
 * @module channels/deviceTokens
 */

export const DEVICE_TOKEN_PREFIX = "evd_";
const PREFIX_LENGTH = DEVICE_TOKEN_PREFIX.length + 8;
/** A token lives this long unless its holder asks for less; a lost phone is
 *  what revocation is for, and an expiry makes forgetting to revoke bounded. */
export const DEVICE_TOKEN_DEFAULT_DAYS = 90;
export const DEVICE_TOKEN_MAX_DAYS = 365;

/**
 * The routes a device token is accepted on: `[method, path pattern]`. The run
 * API, the event stream, the files a run delivered, the inbox and the push
 * token intake — what a phone app needs to ask, watch and read.
 * @type {ReadonlyArray<readonly [string, RegExp]>}
 */
export const DEVICE_TOKEN_ROUTES = Object.freeze([
  ["GET", /^\/api\/me$/],
  ["GET", /^\/api\/projects$/],
  ["GET", /^\/api\/research-sessions$/],
  ["PUT", /^\/api\/research-sessions\/[^/]+$/],
  ["GET", /^\/api\/agent-runs$/],
  ["POST", /^\/api\/agent-runs\/dispatch$/],
  ["PATCH", /^\/api\/agent-runs\/[^/]+$/],
  ["POST", /^\/api\/agent-runs\/[^/]+\/(?:steer|cancel)$/],
  ["GET", /^\/api\/runs\/[^/]+\/(?:events|usage)$/],
  ["POST", /^\/api\/runs\/[^/]+\/interactions\/[^/]+$/],
  ["GET", /^\/api\/files\/(?:preview|download)\/.+$/],
  ["GET", /^\/api\/inbox(?:\/unread-count)?$/],
  ["POST", /^\/api\/inbox\/[^/]+\/read$/],
  ["POST", /^\/api\/im\/app\/push-tokens$/],
  ["DELETE", /^\/api\/im\/app\/push-tokens\/[^/]+$/],
]);

/** @param {string} method @param {string} pathname */
export function deviceTokenRouteAllowed(method, pathname) {
  const verb = String(method ?? "GET").toUpperCase();
  return DEVICE_TOKEN_ROUTES.some(([allowed, pattern]) => allowed === verb && pattern.test(pathname));
}

/** @param {string} secret */
function digestOf(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** @param {unknown} value */
function iso(value) {
  if (value == null) return null;
  const time = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

/** @param {any} row */
function record(row) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: iso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
  };
}

export class DeviceTokenStore {
  /** @param {any} database @param {{ now?: () => Date }} [options] */
  constructor(database, { now = () => new Date() } = {}) {
    this.database = database;
    this.now = now;
  }

  /**
   * Mint a token. The only moment it exists outside a digest.
   * @param {string} userId @param {{ name?: unknown, expiresInDays?: unknown }} input
   */
  async issue(userId, input) {
    const name = String(input?.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 120) throw new HttpError(400, "device_token_name_invalid", "A device token needs a name of 1–120 characters.");
    const days = input?.expiresInDays == null ? DEVICE_TOKEN_DEFAULT_DAYS : Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > DEVICE_TOKEN_MAX_DAYS) {
      throw new HttpError(400, "device_token_expiry_invalid", `expiresInDays must be an integer between 1 and ${DEVICE_TOKEN_MAX_DAYS}.`);
    }
    await migrateChannels(this.database);
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = `dvt_${randomBytes(9).toString("base64url")}`;
    const expiresAt = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    const { rows } = await this.database.query(`INSERT INTO evimed_channels.device_tokens
      (id,user_id,name,token_prefix,token_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, userId, name, token.slice(0, PREFIX_LENGTH), digestOf(token), expiresAt]);
    return { ...record(rows[0]), token };
  }

  /** @param {string} userId */
  async list(userId) {
    await migrateChannels(this.database);
    const { rows } = await this.database.query(`SELECT * FROM evimed_channels.device_tokens WHERE user_id=$1
      ORDER BY created_at DESC, id DESC LIMIT 200`, [userId]);
    return rows.map(record);
  }

  /** @param {string} userId @param {string} id */
  async revoke(userId, id) {
    await migrateChannels(this.database);
    const { rows } = await this.database.query(`UPDATE evimed_channels.device_tokens
      SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND id=$2 RETURNING *`, [userId, id]);
    if (!rows[0]) throw new HttpError(404, "device_token_not_found", "No such device token.");
    return record(rows[0]);
  }

  /**
   * The account a presented token belongs to, or a refusal with one code.
   * @param {unknown} presented @returns {Promise<{ userId: string, tokenId: string }>}
   */
  async resolve(presented) {
    const token = String(presented ?? "");
    const refusal = new HttpError(401, "device_token_invalid", "The device token is not valid.");
    if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length < 20 || token.length > 200) throw refusal;
    await migrateChannels(this.database);
    const { rows } = await this.database.query("SELECT * FROM evimed_channels.device_tokens WHERE token_digest=$1 LIMIT 1",
      [digestOf(token)]);
    const row = rows[0];
    if (!row) throw refusal;
    const stored = Buffer.from(String(row.token_digest), "utf8");
    const offered = Buffer.from(digestOf(token), "utf8");
    if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) throw refusal;
    if (row.revoked_at) throw refusal;
    if (Date.parse(iso(row.expires_at) ?? "") <= this.now().getTime()) throw refusal;
    // Best effort: a clock write must never decide whether a call is served.
    this.database.query("UPDATE evimed_channels.device_tokens SET last_used_at=clock_timestamp() WHERE id=$1", [row.id])
      .catch(() => {});
    return { userId: row.user_id, tokenId: row.id };
  }
}

/** Where a request authenticated by a device token keeps its account. */
export const DEVICE_REQUEST = Symbol.for("evimed.deviceRequest");

/**
 * The device-token step of a request, run before any route: nothing unless
 * the switch is on and the request presents a device token.
 *
 * With `OPEN_SCIENCE_APP_API_ENABLED` off this returns null for every request
 * — the header is not even read — so the API is exactly what it was. On, a
 * device token on a route outside the list is refused rather than ignored: a
 * client that presented one meant to use it, and falling through to cookie
 * auth would answer a confusing "login required".
 *
 * @param {{ config: any, tokens: DeviceTokenStore | null, userById: (id: string) => Promise<any> }} dependencies
 */
export function createDeviceAuthentication({ config, tokens, userById }) {
  /**
   * @param {any} req @param {string} pathname
   * @returns {Promise<any | null>} the account, or null for an ordinary request
   */
  return async function authenticateDevice(req, pathname) {
    if (config?.appApiEnabled !== true) return null;
    const header = String(req.headers?.authorization ?? "");
    const token = /^Bearer (\S+)$/.exec(header)?.[1] ?? "";
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
    if (!deviceTokenRouteAllowed(req.method ?? "GET", pathname)) {
      throw new HttpError(403, "device_token_route_forbidden", "A device token cannot be used on this route.");
    }
    if (!tokens) throw new HttpError(503, "device_tokens_unavailable", "Device tokens require the shared product store.");
    const { userId, tokenId } = await tokens.resolve(token);
    const user = await userById(userId);
    if (!user) throw new HttpError(401, "device_token_invalid", "The device token is not valid.");
    req[DEVICE_REQUEST] = { user, tokenId };
    return user;
  };
}
