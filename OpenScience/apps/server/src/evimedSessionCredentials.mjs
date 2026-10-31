import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** A separate purpose key keeps account credentials out of other gateway protocols. @param {any} config @param {string} purpose */
function keyOf(config, purpose) {
  const secret = config.modelGatewaySigningSecret;
  if (typeof secret !== "string" || secret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from(`evimed-session-${purpose}-v1`), 32));
}

/** @param {any} config */
export const evimedSessionEncryptionAvailable = config => keyOf(config, "credential") !== null;

/** @param {any} config @param {string} purpose @param {string} binding @param {string} userId @param {unknown} value */
function seal(config, purpose, binding, userId, value) {
  const key = keyOf(config, purpose);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${purpose}\0${binding}\0${userId}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

/** @param {any} config @param {string} purpose @param {string} binding @param {string} userId @param {unknown} packed */
function open(config, purpose, binding, userId, packed) {
  const key = keyOf(config, purpose);
  if (!key || typeof packed !== "string" || packed.length > 20_000 || !/^[A-Za-z0-9_-]+$/.test(packed)) return null;
  try {
    const bytes = Buffer.from(packed, "base64url");
    if (bytes.length < 29) return null;
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${purpose}\0${binding}\0${userId}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
  } catch { return null; }
}

/** @param {unknown} value @returns {value is string} */
function usableCredential(value) {
  // eslint-disable-next-line no-control-regex -- credentials are one bounded opaque header value
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[\0-\x1f\x7f]/.test(value);
}

/** The ciphertext belongs to one durable session and expires with it. @param {any} config @param {string} binding @param {string} userId @param {number} expiresAt @param {unknown} credential */
export function sealEvimedSessionCredential(config, binding, userId, expiresAt, credential) {
  if (!usableCredential(credential)) return null;
  return seal(config, "credential", binding, userId, { credential, expiresAt });
}

/** @param {any} config @param {string} binding @param {string} userId @param {number} expiresAt @param {unknown} packed */
export function openEvimedSessionCredential(config, binding, userId, expiresAt, packed) {
  const value = open(config, "credential", binding, userId, packed);
  return value && value.expiresAt === expiresAt && expiresAt > Date.now() && usableCredential(value.credential) ? value.credential : null;
}

/** Only fixed detail parameters, never the account credential, travel in this browser reference. @param {any} config @param {{binding:string,userId:string,expiresAt:number}} session @param {string} category @param {Record<string, string>} parameters */
export function sealEvimedSearchReference(config, session, category, parameters) {
  return seal(config, "search-reference", session.binding, session.userId, {
    category, parameters, expiresAt: Math.min(session.expiresAt, Date.now() + 60 * 60_000),
  });
}

/** @param {any} config @param {{binding:string,userId:string}} session @param {string} category @param {unknown} reference */
export function openEvimedSearchReference(config, session, category, reference) {
  const value = open(config, "search-reference", session.binding, session.userId, reference);
  return value && value.category === category && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()
    && value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters) ? value.parameters : null;
}
