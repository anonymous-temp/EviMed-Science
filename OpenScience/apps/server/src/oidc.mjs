import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import {
  appendSetCookie,
  HttpError,
  parseCookies,
  shouldUseSecureCookies,
} from "./security.mjs";

const flowCookieName = "os_oidc_flow";
const flowCookiePath = "/api/auth/oidc";
const callbackPath = "/api/auth/oidc/callback";
const maxFlowCookieBytes = 4096;
const placeholderPattern = /^(?:change|replace|example|placeholder|secret|test)(?:[-_ ].*)?$/i;

function configError(code, message) {
  return new HttpError(503, code, message);
}

function normalizedStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function validatePublicOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw configError("oidc_public_url_invalid", "OIDC requires a valid public application URL.");
  }
  if (!value || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw configError("oidc_public_url_origin_required", "OIDC requires the public URL to be an origin.");
  }
  return url.origin;
}

export function validateOidcSettings(config) {
  if (config.authMode !== "oidc") {
    throw configError("oidc_auth_mode_disabled", "OIDC authentication is not enabled.");
  }

  let issuer;
  try {
    issuer = new URL(String(config.oidcIssuer ?? ""));
  } catch {
    throw configError("oidc_issuer_invalid", "OIDC issuer is invalid.");
  }
  if (!config.oidcIssuer) throw configError("oidc_issuer_missing", "OIDC issuer is required.");
  if (!['https:', 'http:'].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw configError("oidc_issuer_invalid", "OIDC issuer is invalid.");
  }
  if (config.production && issuer.protocol !== "https:") {
    throw configError("oidc_issuer_https_required", "Production OIDC issuer must use HTTPS.");
  }

  const clientId = String(config.oidcClientId ?? "").trim();
  if (!clientId || clientId.length > 512 || /[\r\n\0]/.test(clientId)) {
    throw configError("oidc_client_id_invalid", "OIDC client id is missing or invalid.");
  }
  const clientAuthMethod = String(config.oidcClientAuthMethod ?? "client_secret_basic").trim();
  if (!["client_secret_basic", "client_secret_post"].includes(clientAuthMethod)) {
    throw configError("oidc_client_auth_method_invalid", "OIDC client authentication method is invalid.");
  }
  if (config.oidcClientSecretError) {
    throw configError(config.oidcClientSecretError, "OIDC client secret could not be loaded.");
  }
  const clientSecret = String(config.oidcClientSecret ?? "");
  if (!clientSecret) throw configError("oidc_client_secret_missing", "OIDC client secret is required.");
  if (
    Buffer.byteLength(clientSecret, "utf8") < 8 ||
    Buffer.byteLength(clientSecret, "utf8") > 8192 ||
    clientSecret !== clientSecret.trim() ||
    /[\r\n\0]/.test(clientSecret) ||
    placeholderPattern.test(clientSecret)
  ) {
    throw configError("oidc_client_secret_invalid", "OIDC client secret is invalid or uses a placeholder value.");
  }
  if (config.oidcFlowSecretError) {
    throw configError(config.oidcFlowSecretError, "OIDC flow secret could not be loaded.");
  }
  const flowSecret = String(config.oidcFlowSecret ?? "");
  if (
    Buffer.byteLength(flowSecret, "utf8") < 32 ||
    Buffer.byteLength(flowSecret, "utf8") > 8192 ||
    flowSecret !== flowSecret.trim() ||
    /[\r\n\0]/.test(flowSecret) ||
    placeholderPattern.test(flowSecret.trim())
  ) {
    throw configError("oidc_flow_secret_weak", "OIDC flow secret must contain at least 32 non-placeholder bytes.");
  }
  if (flowSecret === clientSecret) {
    throw configError("oidc_secret_reuse_forbidden", "OIDC flow and client secrets must be different.");
  }

  const scopes = normalizedStringList(config.oidcScopes);
  if (!scopes.includes("openid") || scopes.some((scope) => !/^[A-Za-z0-9:._/-]{1,128}$/.test(scope))) {
    throw configError("oidc_scopes_invalid", "OIDC scopes must include openid and contain only safe values.");
  }
  const label = String(config.oidcLabel ?? "").trim();
  if (!label || label.length > 80 || /[\0\r\n]/.test(label)) {
    throw configError("oidc_label_invalid", "OIDC login label is invalid.");
  }
  const groupClaim = String(config.oidcGroupClaim ?? "groups").trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(groupClaim)) {
    throw configError("oidc_group_claim_invalid", "OIDC group claim is invalid.");
  }
  const allowedGroups = normalizedStringList(config.oidcAllowedGroups);
  if (allowedGroups.some((group) => group.length > 256 || /[\0\r\n]/.test(group))) {
    throw configError("oidc_allowed_groups_invalid", "OIDC allowed groups are invalid.");
  }
  const allowedEmailDomains = normalizedStringList(config.oidcAllowedEmailDomains).map((domain) => domain.toLowerCase());
  if (allowedEmailDomains.some((domain) => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || domain.includes(".."))) {
    throw configError("oidc_allowed_email_domains_invalid", "OIDC allowed email domains are invalid.");
  }

  const timeoutMs = Number(config.oidcTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw configError("oidc_timeout_invalid", "OIDC timeout must be between 1000 and 60000 milliseconds.");
  }
  const flowTtlMs = Number(config.oidcFlowTtlMs);
  if (!Number.isSafeInteger(flowTtlMs) || flowTtlMs < 60_000 || flowTtlMs > 30 * 60_000) {
    throw configError("oidc_flow_ttl_invalid", "OIDC flow TTL must be between 1 and 30 minutes.");
  }

  const publicOrigin = validatePublicOrigin(config.publicUrl);
  if (config.production && !publicOrigin.startsWith("https://")) {
    throw configError("oidc_public_url_https_required", "Production OIDC callback must use HTTPS.");
  }

  return {
    issuer,
    clientId,
    clientAuthMethod,
    clientSecret,
    flowSecret,
    scopes,
    label,
    groupClaim,
    allowedGroups,
    allowedEmailDomains,
    timeoutMs,
    flowTtlMs,
    publicOrigin,
    callbackUrl: new URL(callbackPath, publicOrigin).href,
  };
}

function flowKey(secret) {
  return createHash("sha256").update("open-science-oidc-flow\0").update(secret).digest();
}

function flowAad(settings) {
  return Buffer.from(`v1\0${settings.issuer.href}\0${settings.clientId}\0${settings.clientAuthMethod}`, "utf8");
}

export function sealOidcFlow(flow, settings) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", flowKey(settings.flowSecret), iv);
  cipher.setAAD(flowAad(settings));
  const plaintext = Buffer.from(JSON.stringify(flow), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, encrypted, tag].map((part) => part.toString("base64url")).join(".");
}

export function openOidcFlow(value, settings, now = Date.now()) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxFlowCookieBytes) {
    throw new HttpError(400, "oidc_flow_invalid", "OIDC login flow is invalid or expired.");
  }
  const parts = value.split(".");
  if (parts.length !== 3) throw new HttpError(400, "oidc_flow_invalid", "OIDC login flow is invalid or expired.");
  try {
    const [iv, encrypted, tag] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", flowKey(settings.flowSecret), iv);
    decipher.setAAD(flowAad(settings));
    decipher.setAuthTag(tag);
    const flow = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
    if (
      flow?.version !== 1 ||
      typeof flow.issuedAt !== "number" ||
      flow.issuedAt > now + 30_000 ||
      now - flow.issuedAt > settings.flowTtlMs ||
      typeof flow.state !== "string" ||
      typeof flow.nonce !== "string" ||
      typeof flow.codeVerifier !== "string" ||
      typeof flow.returnTo !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return flow;
  } catch {
    throw new HttpError(400, "oidc_flow_invalid", "OIDC login flow is invalid or expired.");
  }
}

function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 2048) return "/settings";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\0\r\n]/.test(value)) {
    return "/settings";
  }
  return value;
}

function appendFlowCookie(res, value, req, config, maxAgeSeconds) {
  const secure = shouldUseSecureCookies(req, config);
  appendSetCookie(
    res,
    [
      `${flowCookieName}=${encodeURIComponent(value)}`,
      `Path=${flowCookiePath}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
      secure ? "Secure" : "",
    ].filter(Boolean).join("; "),
  );
}

function redirect(res, status, location) {
  res.writeHead(status, {
    Location: location,
    "Cache-Control": "no-store",
    "Content-Length": "0",
  });
  res.end();
}

function claimStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return [];
}

function authorizeClaims(claims, settings) {
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  if (!subject || subject.length > 512 || /[\0\r\n]/.test(subject)) {
    throw new HttpError(403, "oidc_subject_invalid", "Identity provider returned an invalid subject.");
  }
  if (settings.allowedGroups.length > 0) {
    const groups = new Set(claimStrings(claims[settings.groupClaim]));
    if (!settings.allowedGroups.some((group) => groups.has(group))) {
      throw new HttpError(403, "oidc_group_forbidden", "This identity is not in an allowed group.");
    }
  }
  if (settings.allowedEmailDomains.length > 0) {
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
    if (claims.email_verified !== true || !settings.allowedEmailDomains.includes(domain)) {
      throw new HttpError(403, "oidc_email_forbidden", "This identity does not have an allowed verified email domain.");
    }
  }
  return subject;
}

function displayName(claims) {
  for (const key of ["name", "preferred_username", "email"]) {
    if (typeof claims?.[key] !== "string") continue;
    // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
    const value = claims[key].replace(/[\0-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 128);
    if (value) return value;
  }
  return "EviMed User";
}

function externalUserId(settings, subject) {
  const digest = createHash("sha256")
    .update(settings.issuer.href)
    .update("\0")
    .update(subject)
    .digest("hex");
  return `oidc_${digest.slice(0, 48)}`;
}

export class OidcService {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.discoveryPromise = null;
  }

  settings() {
    return validateOidcSettings(this.config);
  }

  methods() {
    if (this.config.authMode === "development") return { mode: "development" };
    // Whether the login page offers to create an account. It is reported here
    // rather than inferred in the browser because a build cannot know what a
    // deployment accepts, and a register form that 403s is worse than none.
    if (this.config.authMode === "local") {
      return { mode: "local", selfRegistration: Boolean(this.config.selfRegistrationEnabled) };
    }
    const settings = this.settings();
    return {
      mode: "oidc",
      oidc: {
        label: settings.label,
        startUrl: "/api/auth/oidc/start",
      },
    };
  }

  async client(settings) {
    if (!this.discoveryPromise) {
      const execute = this.config.production ? [] : [oidc.allowInsecureRequests];
      const clientAuthentication = settings.clientAuthMethod === "client_secret_post"
        ? oidc.ClientSecretPost(settings.clientSecret)
        : oidc.ClientSecretBasic(settings.clientSecret);
      this.discoveryPromise = oidc.discovery(
        settings.issuer,
        settings.clientId,
        {
          client_secret: settings.clientSecret,
          token_endpoint_auth_method: settings.clientAuthMethod,
        },
        clientAuthentication,
        { timeout: Math.ceil(settings.timeoutMs / 1000), execute },
      ).catch((error) => {
        this.discoveryPromise = null;
        throw error;
      });
    }
    try {
      return await this.discoveryPromise;
    } catch {
      throw new HttpError(503, "oidc_provider_unavailable", "Identity provider is unavailable.");
    }
  }

  async start(req, res) {
    const settings = this.settings();
    const client = await this.client(settings);
    const requestUrl = new URL(req.url ?? "/", settings.publicOrigin);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const flow = {
      version: 1,
      issuedAt: Date.now(),
      state,
      nonce,
      codeVerifier,
      returnTo: safeReturnTo(requestUrl.searchParams.get("returnTo")),
    };
    appendFlowCookie(res, sealOidcFlow(flow, settings), req, this.config, settings.flowTtlMs / 1000);
    const authorizationUrl = oidc.buildAuthorizationUrl(client, {
      redirect_uri: settings.callbackUrl,
      response_type: "code",
      scope: settings.scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    redirect(res, 302, authorizationUrl.href);
  }

  async callback(req, res) {
    const settings = this.settings();
    const cookie = parseCookies(req.headers.cookie ?? "").get(flowCookieName);
    appendFlowCookie(res, "", req, this.config, 0);
    const flow = openOidcFlow(cookie, settings);
    const client = await this.client(settings);
    const incoming = new URL(req.url ?? callbackPath, settings.publicOrigin);
    const currentUrl = new URL(`${incoming.pathname}${incoming.search}`, settings.publicOrigin);
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch {
      throw new HttpError(401, "oidc_callback_failed", "OIDC callback validation failed.");
    }
    const claims = tokens.claims();
    const subject = authorizeClaims(claims, settings);
    const user = await this.store.upsertOidcUser(externalUserId(settings, subject), displayName(claims));
    await this.store.createSession(user, req, res);
    redirect(res, 303, safeReturnTo(flow.returnTo));
    return user;
  }
}
