/** Immutable, login-bound native UI frames. The cookie path is the project context. */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./security.mjs";

export const RUNTIME_UI_FRAME_COOKIE = "evimed_ui_frame";
const FRAME_ID = /^[A-Za-z0-9_-]{32}$/;
const DEVELOPMENT_KEYS = new WeakMap();
const SIGNING_DOMAIN = "evimed/runtime-ui/frame-cookie/v1";

function invalid(code = "runtime_ui_frame_invalid", status = 401) {
  return new HttpError(status, code, "A valid login-bound runtime UI frame is required.");
}

/** Reject ambiguous cookies instead of selecting an arbitrary Path's value. */
export function runtimeUiCookie(req, name) {
  const pairs = String(req.headers?.cookie ?? "").split(";")
    .map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
  if (pairs.length > 1) throw invalid();
  if (!pairs.length) return "";
  try { return decodeURIComponent(pairs[0].slice(name.length + 1)); } catch { throw invalid(); }
}

/** Same host and scheme allow host-only login and frame cookies on both ports. */
export function runtimeUiOrigins(config) {
  try {
    const shell = new URL(config.publicUrl);
    const ui = new URL(config.runtimeUiPublicOrigin);
    if (!["https:", "http:"].includes(shell.protocol) || shell.protocol !== ui.protocol
      || shell.hostname !== ui.hostname || shell.origin === ui.origin
      || [shell, ui].some((url) => url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      || (config.production && shell.protocol !== "https:")) throw new Error("origins");
    return { shellOrigin: shell.origin, uiOrigin: ui.origin };
  } catch { throw invalid("runtime_ui_origins_invalid", 503); }
}

/** Domain-separated from the protected gateway secret, stable across replicas and releases. */
function signingKey(config) {
  if (config.modelGatewaySigningSecretError) throw invalid("runtime_ui_signing_secret_invalid", 503);
  const material = String(config.modelGatewaySigningSecret ?? "");
  if (!material && !config.production) {
    if (!DEVELOPMENT_KEYS.has(config)) DEVELOPMENT_KEYS.set(config, randomBytes(32));
    return DEVELOPMENT_KEYS.get(config);
  }
  if (material !== material.trim() || Buffer.byteLength(material) < 32 || /[\r\n\0]/.test(material)) {
    throw invalid("runtime_ui_signing_secret_required", 503);
  }
  return Buffer.from(hkdfSync("sha256", material, "evimed/frame-signing", SIGNING_DOMAIN, 32));
}

export function assertRuntimeUiFrameConfiguration(config) {
  runtimeUiOrigins(config);
  signingKey(config);
}

function sessionFingerprint(req, config) {
  const cookie = runtimeUiCookie(req, config.sessionCookieName);
  if (!cookie) throw invalid("unauthorized");
  return createHash("sha256").update(`evimed/runtime-ui/login/v1\0${cookie}`).digest("base64url");
}

/** Parse the raw request target before URL normalization can hide traversal. */
export function parseRuntimeUiFramePath(target) {
  const path = String(target).split("?")[0];
  if (path.includes("\\") || /%(?:2e|2f|5c|00)/i.test(path) || /\/(?:\.|\.\.)(?:\/|$)/.test(path)) {
    throw invalid("runtime_ui_frame_path_invalid", 400);
  }
  const match = /^\/__evimed\/f\/([A-Za-z0-9_-]{32})\/(.*)$/s.exec(String(target));
  if (!match) throw invalid("runtime_ui_frame_required");
  return { frameId: match[1], prefix: `/__evimed/f/${match[1]}/`, suffix: `/${match[2]}` };
}

export function issueRuntimeUiFrame({ config, req, user, session, project, now = Date.now() }) {
  const { uiOrigin } = runtimeUiOrigins(config);
  const frameId = randomBytes(24).toString("base64url");
  const ttl = Number(config.runtimeUiFrameTtlMs ?? config.sessionTtlMs);
  const expiresAt = Math.min(Number(session.expiresAt), now + ttl);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || !user.id || !project.id || project.userId !== user.id) throw invalid();
  const prefix = `/__evimed/f/${frameId}/`;
  const claims = { version: 1, frameId, projectId: project.id, userId: user.id, authSessionHash: sessionFingerprint(req, config), audience: uiOrigin, issuedAt: now, expiresAt };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingKey(config)).update(payload).digest("base64url");
  const cookie = `${RUNTIME_UI_FRAME_COOKIE}=${payload}.${signature}; Path=${prefix}; HttpOnly; SameSite=Lax${uiOrigin.startsWith("https:") ? "; Secure" : ""}; Max-Age=${Math.max(1, Math.floor((expiresAt - now) / 1000))}`;
  return { frameId, prefix, frameUrl: `${uiOrigin}${prefix}`, expiresAt, cookie };
}

export function validateRuntimeUiFrame({ config, req, user, session, frameId, now = Date.now() }) {
  const ticket = runtimeUiCookie(req, RUNTIME_UI_FRAME_COOKIE);
  if (!ticket) throw invalid("runtime_ui_frame_required");
  if (ticket.length > 4096) throw invalid();
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!parts) throw invalid();
  const actual = Buffer.from(parts[2], "base64url");
  const expected = createHmac("sha256", signingKey(config)).update(parts[1]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || actual.toString("base64url") !== parts[2]) throw invalid();
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw invalid(); }
  if (!claims || claims.version !== 1 || !FRAME_ID.test(frameId) || claims.frameId !== frameId
    || claims.userId !== user.id || typeof claims.projectId !== "string" || !claims.projectId
    || claims.authSessionHash !== sessionFingerprint(req, config) || claims.audience !== runtimeUiOrigins(config).uiOrigin
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.issuedAt > now || claims.expiresAt <= claims.issuedAt || claims.expiresAt > session.expiresAt) throw invalid();
  if (claims.expiresAt <= now) throw invalid("runtime_ui_frame_expired");
  return claims;
}
