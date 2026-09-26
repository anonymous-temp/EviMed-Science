import { createHash } from "node:crypto";
import { HttpError, clearSessionCookie, parseCookies } from "./security.mjs";

/**
 * The `evimed` login mode: the EviMed shell's signed-in user becomes a Science
 * session without signing in twice (fusion plan 2026-09-26 §9.2, step one).
 *
 * The shell calls `POST /api/auth/evimed/session` with the credential its own
 * user is already carrying. The control plane introspects that credential
 * **server side** against EviMed's user endpoint, and on success mints its own
 * session with the same machinery every other login path uses
 * (`store.createSession`) — one session format, one cookie, one CSRF token.
 *
 * Hidden knowledge:
 *
 * - **The EviMed credential is never stored and never travels downstream.** It
 *   exists for the length of one introspection call. It is not written to a
 *   user row, a session row, the security ledger or the error ledger, and no
 *   runtime container ever receives it; what the runtime gets is a session of
 *   ours, as always. The cache below is keyed by a hash of the credential, not
 *   by the credential.
 * - **The shell can hand it over two ways, and needs both across the
 *   migration.** Today EviMed keeps its token in `localStorage` and in a
 *   JS-readable `name1` cookie on `.evimed.com`, so the shell can put it in the
 *   request body. After EviMed's P0-2 — the prerequisite §9.2 names — the
 *   credential becomes HttpOnly and the shell cannot read it any more; then the
 *   browser attaches it to this same-origin request itself and the cookie is
 *   the only path left. The body is preferred when present because it is the
 *   explicit one.
 * - **An identity is whoever EviMed says the credential belongs to.** The
 *   business code is checked, not only the HTTP status: EviMed answers HTTP 200
 *   with `code: 401` in the body for an expired token, so a status-only check
 *   would have provisioned an account for the word "unauthorized".
 * - **A user id of ours is a hash, not EviMed's number.** `evimed_<40 hex>` of
 *   the introspection origin and EviMed's user id, so the account id is a safe
 *   directory name, is stable across renames, and carries no EviMed identifier
 *   into our filesystem, ledgers or exports.
 * - **The account kind is recorded as `evimed`.** Step two of §9.2 moves these
 *   accounts to real OIDC; folding them into `oidc` now would leave that
 *   migration unable to tell them apart.
 * - **Off is off.** Unless `OPEN_SCIENCE_EVIMED_AUTH_ENABLED` is on (or
 *   `OPEN_SCIENCE_AUTH_MODE=evimed`, which turns it on), both routes answer 404
 *   and nothing else in the control plane changes.
 *
 * @module evimedAuthService
 */

/** Where the shell exchanges its credential for a session of ours. */
export const EVIMED_SESSION_PATH = "/api/auth/evimed/session";
/** Where EviMed's own sign-out revokes that session. */
export const EVIMED_LOGOUT_PATH = "/api/auth/evimed/logout";

/**
 * EviMed's own session cookie, on `.evimed.com` with path `/` — so a
 * same-origin call from the shell (plan §9.9 puts Science behind
 * `www.evimed.com/api/*`) carries it without the page having to read it. The
 * name is a fact of the shell rather than a deployment choice, so it is written
 * here instead of becoming a fifth configuration key.
 */
const EVIMED_CREDENTIAL_COOKIE = "name1";

/** A credential is an opaque token in a header: bounded, one line. */
const MAX_CREDENTIAL_BYTES = 4096;
/** An identity document is small; anything larger is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** How many introspection results the cache may hold at once. */
const MAX_CACHE_ENTRIES = 512;
/** Envelope codes EviMed's APIs use for success. */
const SUCCESS_CODES = new Set(["0", "200", "ok", "success", "true"]);
/** Where an identity record names the user, most specific first. */
const USER_ID_FIELDS = ["userId", "id", "sub", "uid"];
/**
 * Where it names them for a reader. Deliberately none of EviMed's login
 * fields: this product registers by phone, so `phone` and `userName` are both
 * commonly the number itself, and an account name is written into a user row,
 * every ledger line and every export. An account nobody named is "EviMed User",
 * which is a worse name and not a phone number.
 */
const DISPLAY_NAME_FIELDS = ["nickName", "nickname", "name", "realName"];

/** @param {string} code @param {string} message */
function configError(code, message) {
  return new HttpError(503, code, message);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The settings the mode needs, each checked at the moment it is used so a
 * misconfiguration is one named code rather than a failure at the first call.
 * @param {Record<string, any>} config
 * @returns {{ introspectUrl: URL, apiKey: string, timeoutMs: number, cacheTtlMs: number }}
 */
export function validateEvimedAuthSettings(config) {
  if (!config?.evimedAuthEnabled) {
    throw configError("evimed_auth_disabled", "EviMed authentication is not enabled.");
  }
  const configured = String(config.evimedUserIntrospectUrl ?? "");
  if (!configured) {
    throw configError("evimed_introspect_url_missing", "EviMed authentication requires the user introspection URL.");
  }
  let introspectUrl;
  try {
    introspectUrl = new URL(configured);
  } catch {
    throw configError("evimed_introspect_url_invalid", "The EviMed user introspection URL is invalid.");
  }
  if (
    !["https:", "http:"].includes(introspectUrl.protocol) ||
    introspectUrl.username ||
    introspectUrl.password ||
    introspectUrl.hash
  ) {
    throw configError("evimed_introspect_url_invalid", "The EviMed user introspection URL is invalid.");
  }
  if (config.production && introspectUrl.protocol !== "https:") {
    throw configError("evimed_introspect_https_required", "Production EviMed introspection must use HTTPS.");
  }
  // The shared EviMed platform key (`OPEN_SCIENCE_EVIMED_API_KEY_FILE`), which
  // this deployment already loads once for the EviMed evidence connector. The
  // login mode authenticates its server-to-server call with that same key
  // rather than introducing a second copy of one secret. A key that cannot be
  // read is a fault and is named; no key at all is not — the introspection
  // endpoint may not require one, and a deployment that has not placed it yet
  // must still be able to sign a researcher in.
  const keyError = config.publicSourceCredentialErrors?.evimedEvidence;
  if (keyError) throw configError(String(keyError), "The EviMed platform key could not be loaded.");
  const apiKey = String(config.publicSourceCredentials?.evimedEvidence ?? "");
  if (/[\r\n\0]/.test(apiKey)) {
    throw configError("evimed_api_key_invalid", "The EviMed platform key is invalid.");
  }
  const timeoutMs = Math.floor(Number(config.evimedIntrospectTimeoutMs));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw configError("evimed_introspect_timeout_invalid", "EviMed introspection timeout must be between 1000 and 60000 milliseconds.");
  }
  const cacheTtlMs = Math.floor(Number(config.evimedIntrospectCacheTtlMs));
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 600_000) {
    throw configError("evimed_introspect_cache_ttl_invalid", "EviMed introspection cache TTL must be between 0 and 600000 milliseconds.");
  }
  return { introspectUrl, apiKey, timeoutMs, cacheTtlMs };
}

/**
 * The account id one EviMed user gets here: derived from the introspection
 * origin and EviMed's own id, so two deployments pointing at different EviMed
 * installations never collide, and nothing of EviMed's identifier is written
 * down. 40 hex characters plus the prefix fits `safeId`.
 * @param {{ introspectUrl: URL }} settings @param {string} subject
 */
export function evimedUserId(settings, subject) {
  const digest = createHash("sha256")
    .update(settings.introspectUrl.origin)
    .update("\0")
    .update(String(subject))
    .digest("hex");
  return `evimed_${digest.slice(0, 40)}`;
}

/** @param {unknown} value */
function credentialShape(value) {
  if (typeof value !== "string") return "";
  const credential = value.trim();
  if (!credential || Buffer.byteLength(credential, "utf8") > MAX_CREDENTIAL_BYTES) return "";
  // It is placed in a request header, so a control character in it would be a
  // header injection rather than a bad password.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the intent
  if (/[\0-\x1f\x7f]/.test(credential)) return "";
  return credential;
}

/**
 * The credential the shell is presenting, from the request body it sent or the
 * cookie the browser attached. Never logged, never returned.
 * @param {any} req @param {unknown} body
 */
export function evimedCredentialFrom(req, body) {
  const fromBody = isObject(body) ? credentialShape(body.token) : "";
  if (fromBody) return fromBody;
  const fromCookie = credentialShape(parseCookies(String(req?.headers?.cookie ?? "")).get(EVIMED_CREDENTIAL_COOKIE));
  if (fromCookie) return fromCookie;
  throw new HttpError(400, "evimed_credential_missing", "An EviMed credential is required.");
}

/** @param {unknown} value */
function trimmedText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
  return String(value).replace(/[\0-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Who the introspection answer says is asking, or nothing.
 *
 * "Nothing" covers every shape that is not an identity: an envelope whose code
 * is not a success, a missing record, a record with no user id. They share one
 * outcome on purpose — whatever the endpoint meant, the control plane could not
 * learn who is asking, and the one thing it must not then do is mint a session.
 *
 * @param {unknown} payload
 * @returns {{ userId: string, name: string } | null}
 */
export function evimedIdentityOf(payload) {
  if (!isObject(payload)) return null;
  // EviMed's APIs answer HTTP 200 with the business result inside; an expired
  // token arrives as `code: 401`, and `success: false` is the other form.
  if (Object.hasOwn(payload, "code") && !SUCCESS_CODES.has(String(payload.code).trim().toLowerCase())) return null;
  if (payload.success === false) return null;
  const record = isObject(payload.data) ? payload.data : payload;
  const userId = USER_ID_FIELDS.map((field) => trimmedText(record[field], 128)).find(Boolean) ?? "";
  if (!userId) return null;
  const name = DISPLAY_NAME_FIELDS.map((field) => trimmedText(record[field], 128)).find(Boolean) ?? "";
  return { userId, name: name || "EviMed User" };
}

/** @param {any} response */
async function boundedJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new HttpError(502, "evimed_introspect_failed", "The EviMed user endpoint answered with too much data.");
    }
    chunks.push(buffer);
  }
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * What readiness reports about this login path: enough to see that it is wired
 * to something, and no secret. Throws the named configuration failure when it
 * is on and cannot work.
 * @param {Record<string, any>} config
 */
export function evimedAuthReadiness(config) {
  const settings = validateEvimedAuthSettings(config);
  return {
    introspectHost: settings.introspectUrl.host,
    platformKey: settings.apiKey ? "configured" : "none",
    timeoutMs: settings.timeoutMs,
    cacheTtlMs: settings.cacheTtlMs,
  };
}

export class EvimedAuthService {
  /**
   * @param {Record<string, any>} config
   * @param {any} store
   * @param {{ fetchImpl?: typeof globalThis.fetch }} [options]
   */
  constructor(config, store, { fetchImpl } = {}) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl ?? globalThis.fetch;
    /** Introspection results, keyed by a hash of the credential and never by
     *  the credential itself. It exists so a shell that reloads a few times in
     *  a row does not ask EviMed each time; what it costs is that a credential
     *  revoked upstream still exchanges for a session until the entry expires,
     *  which is why the TTL is a minute and not an hour. Failures are never
     *  cached.
     *  @type {Map<string, { identity: { userId: string, name: string }, expiresAt: number }>} */
    this.cache = new Map();
    this.counters = { introspections: 0, cacheHits: 0, rejected: 0, unreachable: 0 };
  }

  get enabled() {
    return Boolean(this.config?.evimedAuthEnabled);
  }

  settings() {
    return validateEvimedAuthSettings(this.config);
  }

  /** What `/api/auth/methods` adds when this login path is available. Nothing
   *  when it is not, so a deployment without it answers exactly as before. */
  loginMethod() {
    if (!this.enabled) return {};
    return { evimed: { sessionUrl: EVIMED_SESSION_PATH, logoutUrl: EVIMED_LOGOUT_PATH } };
  }

  /** @param {string} credential */
  #cacheKey(credential) {
    return createHash("sha256").update("evimed-introspection\0").update(credential).digest("hex");
  }

  /** @param {string} key */
  #cached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.counters.cacheHits += 1;
    return entry.identity;
  }

  /** @param {string} key @param {{ userId: string, name: string }} identity @param {number} ttlMs */
  #remember(key, identity, ttlMs) {
    if (ttlMs <= 0) return;
    this.cache.delete(key);
    this.cache.set(key, { identity, expiresAt: Date.now() + ttlMs });
    for (const stale of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      this.cache.delete(stale);
    }
  }

  /**
   * Exchange one EviMed credential for the identity behind it, server side.
   * @param {string} credential
   * @returns {Promise<{ userId: string, name: string }>}
   */
  async introspect(credential) {
    const settings = this.settings();
    const key = this.#cacheKey(credential);
    const cached = this.#cached(key);
    if (cached) return cached;
    let response;
    this.counters.introspections += 1;
    try {
      response = await this.fetch(settings.introspectUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          // The shell's own scheme: EviMed's API reads the user's credential
          // from a `token` header.
          token: credential,
          // The control plane's own identity as a server-side caller. Absent
          // when this deployment has no platform key.
          ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        // A redirect would carry the credential to whichever host the answer
        // named, so there is no following one.
        redirect: "error",
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch {
      this.counters.unreachable += 1;
      throw new HttpError(503, "evimed_introspect_unreachable", "The EviMed user endpoint is unreachable.");
    }
    if ([401, 403].includes(response.status)) {
      this.counters.rejected += 1;
      throw new HttpError(401, "evimed_credential_rejected", "The EviMed credential was rejected.");
    }
    if (!response.ok) {
      throw new HttpError(502, "evimed_introspect_failed", "The EviMed user endpoint failed.");
    }
    const identity = evimedIdentityOf(await boundedJson(response));
    if (!identity) {
      this.counters.rejected += 1;
      throw new HttpError(401, "evimed_credential_rejected", "The EviMed credential was rejected.");
    }
    this.#remember(key, identity, settings.cacheTtlMs);
    return identity;
  }

  /**
   * The whole exchange: introspect, provision on first sight, mint our session.
   * Nothing of the credential outlives this call.
   * @param {any} req @param {any} res @param {unknown} body
   * @returns {Promise<{ user: { id: string, name: string, tenantId: string }, csrfToken: string }>}
   */
  async createSession(req, res, body) {
    const settings = this.settings();
    const identity = await this.introspect(evimedCredentialFrom(req, body));
    const user = await this.store.upsertEvimedUser(evimedUserId(settings, identity.userId), identity.name);
    const session = await this.store.createSession(user, req, res);
    return { user: this.store.publicUser(user), csrfToken: session.csrfToken };
  }

  /**
   * Revoke the Science session, so EviMed's sign-out propagates here. The
   * caller has already been authenticated and CSRF-checked, exactly as
   * `/api/auth/logout` is: a logout nobody asked for is a nuisance worth
   * refusing.
   * @param {any} req @param {any} res
   */
  async endSession(req, res) {
    await this.store.logout(req);
    clearSessionCookie(res, this.config.sessionCookieName);
  }
}
