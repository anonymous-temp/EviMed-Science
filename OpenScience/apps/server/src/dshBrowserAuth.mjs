/**
 * The kernel's browser-session cookie, minted by the control plane.
 *
 * DSH 0.1.2 authenticates every `/api` request, including on loopback —
 * 0.1.1 did not, and our runtime sent nothing. The kernel's own path to a
 * credential is a launch token it prints on stdout and exchanges for a signed
 * cookie, which would mean scraping a container's log for a secret and racing
 * its boot.
 *
 * It does not have to be that. The cookie is an HMAC over a small payload,
 * keyed by a secret the kernel reads from `$DSH_HOME/.credentials.yaml` — a
 * file this control plane already writes, atomically, at 0600, because the
 * workload token lives there too. So the secret is ours to choose, and the
 * cookie is ours to mint: deterministic, available before the container has
 * booted, and never once printed.
 *
 * Both halves of the format below are the kernel's, transcribed from its
 * `browser-auth.ts` and then verified against a running 0.1.2 binary rather
 * than trusted from source:
 *
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(json) + "." + base64url(hmac_sha256(secret, base64url(json)))
 *   json  = {"version":1,"authority":<host header>,"issuedAt":<ms>,"expiresAt":<ms>}
 *
 * `authority` is the request's own `Host` header, not the URL we dialled: the
 * kernel derives the cookie name from what it received, so a cookie minted for
 * `127.0.0.1:8080` is silently ignored by a request that arrives as
 * `runtime:8080`. Getting that wrong reads as "not authenticated" with no
 * mention of a name mismatch, so the authority is a required argument here
 * rather than something inferred from a URL.
 *
 * @module dshBrowserAuth
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

/** The kernel's credential record key for this secret. */
export const BROWSER_SESSION_CREDENTIAL_KEY = "client-connection/browser-session";

/** Bytes the kernel requires; a secret of any other length is refused outright. */
export const BROWSER_SESSION_SECRET_BYTES = 32;

/** The kernel's cookie payload version. */
const COOKIE_PAYLOAD_VERSION = 1;

/** The kernel's stored-secret payload version. */
const STORED_SECRET_VERSION = 1;

/** @param {Buffer} value @returns {string} */
function base64url(value) {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * A fresh browser-session secret in the kernel's own encoding.
 * @returns {string}
 */
export function generateBrowserSessionSecret() {
  return base64url(randomBytes(BROWSER_SESSION_SECRET_BYTES));
}

/**
 * @param {string} secret base64url, 32 bytes decoded
 * @returns {Buffer}
 */
function decodeSecret(secret) {
  const text = String(secret ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("browser-session secret must be base64url.");
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64");
  if (decoded.byteLength !== BROWSER_SESSION_SECRET_BYTES) {
    throw new Error(`browser-session secret must decode to ${BROWSER_SESSION_SECRET_BYTES} bytes, got ${decoded.byteLength}.`);
  }
  return decoded;
}

/**
 * The cookie name for one authority.
 * @param {string} authority the exact `Host` header the kernel will receive
 * @returns {string}
 */
export function browserSessionCookieName(authority) {
  const host = String(authority ?? "").trim();
  if (!host) throw new Error("browser-session cookie needs the authority it will be sent to.");
  return `dsh-auth-${base64url(createHash("sha256").update(host).digest())}`;
}

/**
 * One `Cookie` header value the kernel will accept.
 *
 * @param {{ secret: string, authority: string, now?: number, lifetimeMs?: number }} input
 * @returns {string}
 */
export function browserSessionCookie({ secret, authority, now = Date.now(), lifetimeMs = 24 * 60 * 60 * 1000 }) {
  const key = decodeSecret(secret);
  const host = String(authority ?? "").trim();
  if (!host) throw new Error("browser-session cookie needs the authority it will be sent to.");
  const issuedAt = Math.floor(now);
  const expiresAt = issuedAt + Math.floor(lifetimeMs);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new Error("browser-session cookie lifetime is outside the safe timestamp range.");
  }
  const body = base64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority: host,
    issuedAt,
    expiresAt,
  }), "utf8"));
  const signature = base64url(createHmac("sha256", key).update(body).digest());
  return `${browserSessionCookieName(host)}=v1.${body}.${signature}`;
}

/**
 * The credential record the kernel reads this secret from.
 *
 * Returned as data rather than rendered here so the one place that knows the
 * credentials file's YAML shape stays `dshProfilePatch.mjs`.
 *
 * @param {{ secret: string }} input
 * @returns {{ key: string, record: { kind: "grant", payload: { version: number, secret: string } } }}
 */
export function browserSessionCredentialRecord({ secret }) {
  decodeSecret(secret);
  return {
    key: BROWSER_SESSION_CREDENTIAL_KEY,
    record: { kind: "grant", payload: { version: STORED_SECRET_VERSION, secret } },
  };
}
