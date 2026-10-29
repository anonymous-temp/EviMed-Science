import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendSetCookie, HttpError, parseCookies, shouldUseSecureCookies } from "./security.mjs";
import { validateEvimedAuthSettings } from "./evimedAuthService.mjs";

/** The team owns credentials, SMS, captcha and recovery; these routes only adapt its wire. */
export const EVIMED_ACCOUNT_PATHS = Object.freeze({
  captchaUrl: "/api/auth/evimed/captcha",
  sendCodeUrl: "/api/auth/evimed/send-code",
  passwordLoginUrl: "/api/auth/evimed/password-login",
  smsLoginUrl: "/api/auth/evimed/sms-login",
  registerUrl: "/api/auth/evimed/register",
  verifyCodeUrl: "/api/auth/evimed/verify-code",
  resetPasswordUrl: "/api/auth/evimed/reset-password",
});
const ACCOUNT_PATHS = Object.freeze(/** @type {string[]} */ (Object.values(EVIMED_ACCOUNT_PATHS)));
const FLOW_COOKIE = "os_evimed_account";
const FLOW_PATH = "/api/auth/evimed";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FLOW_BYTES = 3000;
const MAX_UPSTREAM_COOKIES = 16;
/** Private diagnostics contain only generated labels and bounded scalar facts, never provider text or credentials.
 * @type {WeakMap<Error, string>} */
const FAILURE_DETAILS = new WeakMap();

/** Only errors created by this adapter may add detail to the private security audit. @param {unknown} error */
export function evimedAccountFailureDetail(error) {
  return error instanceof Error ? FAILURE_DETAILS.get(error) ?? "" : "";
}

/** Classify bounded provider text in memory; only this closed label reaches the audit. @param {Record<string, any>} answer */
function refusalReason(answer) {
  const message = [answer.msg, answer.message].filter(value => typeof value === "string").map(value => value.slice(0, 512)).join(" ");
  if (/频繁|次数(?:过多|太多|超限)|尝试次数|账号(?:已)?锁定|too many|rate.?limit/i.test(message)) return "rate_limit";
  if (/验证码|滑块|拼图|captcha|verification code|challenge/i.test(message)) return "challenge";
  if (/账号或密码|用户名或密码|密码(?:不正确|错误)|用户(?:名)?(?:不存在|未注册)|账号(?:不存在|未注册)|(?:invalid|incorrect|wrong) (?:user(?:name)?|password|credentials)|(?:user|account)(?:name)? (?:does not exist|not found)/i.test(message)) return "credentials";
  if (/参数(?:错误|无效|不正确|不能为空|缺失)|请求参数|invalid (?:input|parameter|argument)|missing (?:input|parameter|argument)/i.test(message)) return "invalid_input";
  if (/服务器|系统(?:异常|错误|繁忙)|服务(?:异常|不可用|错误)|service unavailable|internal server|server error/i.test(message)) return "service";
  return "other";
}

/**
 * A provider refusal is still refused exactly as before; its safe shape helps distinguish it from session verification.
 * @param {string} pathname
 * @param {number} httpStatus
 * @param {Record<string, any>} answer
 * @param {boolean} login
 */
function accountRefusal(pathname, httpStatus, answer, login) {
  const error = new HttpError(login ? 401 : 400, login ? "evimed_credential_rejected" : "evimed_account_rejected", "The EviMed account request was refused.");
  const code = typeof answer.code === "number" || typeof answer.code === "string" ? String(answer.code).trim() : "";
  const detail = {
    stage: "account-response",
    operation: ACCOUNT_PATHS.includes(pathname) ? pathname.slice(FLOW_PATH.length + 1) : "unknown",
    httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    businessCode: /^\d{1,6}$/.test(code) ? Number(code) : null,
    success: answer.success === true ? "true" : answer.success === false ? "false" : Object.hasOwn(answer, "success") ? "other" : "missing",
    tokenPresent: [answer.token, answer.data?.token, answer.data?.access_token].some(value => typeof value === "string" && value.trim().length > 0),
    reason: refusalReason(answer),
  };
  FAILURE_DETAILS.set(error, JSON.stringify(detail));
  return error;
}

/** @param {string} pathname */
export const isEvimedAccountPath = (pathname) => ACCOUNT_PATHS.includes(pathname);

/** @param {Record<string, any>} config */
export function validateEvimedAccountSettings(config) {
  const auth = validateEvimedAuthSettings(config);
  let baseUrl;
  try { baseUrl = new URL(String(config.evimedAccountApiBaseUrl ?? "")); }
  catch { throw new HttpError(503, "evimed_account_url_invalid", "The EviMed account API URL is invalid."); }
  if (!["https:", "http:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new HttpError(503, "evimed_account_url_invalid", "The EviMed account API URL is invalid.");
  }
  if (config.production && baseUrl.protocol !== "https:") {
    throw new HttpError(503, "evimed_account_https_required", "Production EviMed account requests require HTTPS.");
  }
  if (baseUrl.origin !== auth.introspectUrl.origin) {
    throw new HttpError(503, "evimed_account_origin_invalid", "The EviMed account API must share the identity endpoint's origin.");
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
  return { baseUrl, timeoutMs: auth.timeoutMs };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const invalid = () => new HttpError(400, "evimed_account_invalid_input", "The EviMed account request is invalid.");
const failed = () => new HttpError(502, "evimed_account_failed", "The EviMed account service returned an invalid response.");

/** @param {Record<string, any>} body @param {string[]} keys */
function fields(body, keys) {
  if (!object(body) || Object.keys(body).some((key) => !keys.includes(key))) throw invalid();
}
/** @param {unknown} value */
function phoneOf(value) {
  if (typeof value !== "string" || !/^1[3-9]\d{9}$/.test(value)) throw invalid();
  return value;
}
/** @param {unknown} value */
function codeOf(value) {
  if (typeof value !== "string" || !/^\d{4,6}$/.test(value)) throw invalid();
  return value;
}
/** @param {unknown} value @param {boolean} [setting] */
function passwordOf(value, setting = false) {
  if (typeof value !== "string" || !value.length || value.length > 4096) throw invalid();
  if (setting && !/^(?![0-9]+$)(?![a-zA-Z]+$)[0-9A-Za-z]{6,16}$/.test(value)) throw invalid();
  return value;
}

/** @param {Response} response @param {number} limit */
async function responseBytes(response, limit) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw failed();
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } catch { throw failed(); }
}

/** @param {Response} response */
async function accountJson(response) {
  try {
    const payload = JSON.parse((await responseBytes(response, MAX_RESPONSE_BYTES)).toString("utf8"));
    if (!object(payload)) throw failed();
    return payload;
  } catch { throw failed(); }
}

/** @param {Record<string, any>} payload */
function loginToken(payload) {
  const candidates = [payload.token, payload.data?.token, payload.data?.access_token];
  const token = candidates.find((value) => typeof value === "string" && value.trim().length);
  // Never let createSession fall back to a different, already-present browser cookie.
  // eslint-disable-next-line no-control-regex -- a token must remain one opaque header value
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > 4096 || /[\0-\x1f\x7f]/.test(token)) throw failed();
  return token.trim();
}

/** @param {Record<string, any>} payload @param {(value: string) => Promise<string>} imageOf */
async function captchaOf(payload, imageOf) {
  const data = payload.data;
  if (!object(data)) throw failed();
  /** @type {Record<string, string | number>} */
  const result = {};
  for (const key of ["canvasSrc", "blockSrc"]) {
    const value = data[key];
    if (typeof value !== "string" || !value.length || value.length > MAX_RESPONSE_BYTES / 2) throw failed();
    result[key] = await imageOf(value);
  }
  for (const key of ["blockX", "blockY", "canvasWidth", "canvasHeight", "blockWidth", "blockHeight"]) {
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 4096) throw failed();
    result[key] = value;
  }
  if (Number(result.canvasWidth) < 1 || Number(result.canvasHeight) < 1 || Number(result.blockWidth) < 1 || Number(result.blockHeight) < 1) throw failed();
  return result;
}

export class EvimedAccountService {
  /** @param {Record<string, any>} config @param {any} auth @param {{ fetchImpl?: typeof globalThis.fetch }} [options] */
  constructor(config, auth, { fetchImpl } = {}) {
    this.config = config;
    this.auth = auth;
    this.fetch = fetchImpl ?? globalThis.fetch;
    // A restart ends pending captcha/recovery flows. No cookie jar or credential is stored on disk or shared between browsers.
    this.flowKey = randomBytes(32);
  }

  get enabled() { return Boolean(this.config.evimedAuthEnabled && this.config.evimedAccountApiBaseUrl); }

  loginMethod() {
    if (!this.enabled) return {};
    validateEvimedAccountSettings(this.config);
    return { account: EVIMED_ACCOUNT_PATHS };
  }

  /** Anonymous JSON calls cannot use a session CSRF token; browser origin checks protect their flow cookie. @param {any} req */
  assertOrigin(req) {
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "csrf_required", "A same-origin account request is required.");
    const origin = req.headers.origin;
    if (origin) {
      let originUrl;
      try { originUrl = new URL(origin); } catch { throw new HttpError(403, "csrf_required", "A same-origin account request is required."); }
      const requestOrigin = `${shouldUseSecureCookies(req, this.config) ? "https" : "http"}://${req.headers.host}`;
      let publicOrigin = "";
      try { publicOrigin = new URL(this.config.publicUrl).origin; } catch { /* An unconfigured local deployment uses its request origin. */ }
      const local = !this.config.production && ["localhost", "127.0.0.1", "[::1]"].includes(originUrl.hostname) && ["http:", "https:"].includes(originUrl.protocol);
      if (originUrl.origin !== (publicOrigin || requestOrigin) && !local) throw new HttpError(403, "csrf_required", "A same-origin account request is required.");
    }
    if (req.method !== "GET" && !/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      throw new HttpError(400, "invalid_json", "Account requests require a JSON object.");
    }
  }

  /** @param {any} req @returns {{ expiresAt: number, cookies: Record<string, string>, phone?: string }} */
  readFlow(req) {
    const empty = () => ({ expiresAt: Date.now() + FLOW_TTL_MS, cookies: {} });
    const sealed = parseCookies(String(req.headers.cookie ?? "")).get(FLOW_COOKIE);
    if (!sealed || sealed.length > 4096) return empty();
    try {
      const packed = Buffer.from(sealed, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.flowKey, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(FLOW_PATH));
      decipher.setAuthTag(packed.subarray(12, 28));
      const state = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
      if (!object(state) || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now() || !object(state.cookies)) return empty();
      return { expiresAt: state.expiresAt, cookies: state.cookies, ...(typeof state.phone === "string" ? { phone: state.phone } : {}) };
    } catch { return empty(); }
  }

  /** @param {any} req @param {any} res @param {{ expiresAt: number, cookies: Record<string, string>, phone?: string }} flow @param {boolean} [clear] */
  writeFlow(req, res, flow, clear = false) {
    let sealed = "";
    if (!clear) {
      const json = Buffer.from(JSON.stringify(flow));
      if (json.length > MAX_FLOW_BYTES) throw failed();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.flowKey, iv);
      cipher.setAAD(Buffer.from(FLOW_PATH));
      const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
      sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    }
    appendSetCookie(res, `${FLOW_COOKIE}=${sealed}; Path=${FLOW_PATH}; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.max(1, Math.floor((flow.expiresAt - Date.now()) / 1000))}${shouldUseSecureCookies(req, this.config) ? "; Secure" : ""}`);
  }

  /** Only opaque cookie pairs from this fixed upstream are retained, encrypted in this browser's temporary flow cookie.
   * @param {Response} response @param {{ cookies: Record<string, string> }} flow */
  updateCookies(response, flow) {
    for (const cookie of response.headers.getSetCookie()) {
      const match = cookie.match(/^([!#$%&'*+.^_`|~\da-z-]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)(?:;|$)/i);
      if (!match || match[0].length > 2048) throw failed();
      const expires = cookie.match(/;\s*expires\s*=\s*([^;]+)/i)?.[1];
      if (/;\s*max-age\s*=\s*0(?:;|$)/i.test(cookie) || (expires && Date.parse(expires) <= Date.now())) delete flow.cookies[match[1]];
      else flow.cookies[match[1]] = match[2];
    }
    if (Object.keys(flow.cookies).length > MAX_UPSTREAM_COOKIES) throw failed();
  }

  /** Keep captcha images inside the application's existing data-image CSP, without opening an image proxy.
   * @param {string} value @param {{ baseUrl: URL, timeoutMs: number }} settings @param {{ cookies: Record<string, string> }} flow */
  async imageOf(value, settings, flow) {
    if (/^data:image\/(?:png|jpe?g|webp);base64,[a-z\d+/=\r\n]+$/i.test(value)) return value;
    let url;
    try { url = new URL(value, settings.baseUrl); } catch { throw failed(); }
    if (url.origin !== settings.baseUrl.origin || url.username || url.password || url.hash) throw failed();
    let response;
    try {
      response = await this.fetch(url, {
        headers: {
          accept: "image/png,image/jpeg,image/webp", client: "pc",
          ...(Object.keys(flow.cookies).length ? { cookie: Object.entries(flow.cookies).map(([key, cookie]) => `${key}=${cookie}`).join("; ") } : {}),
        },
        redirect: "error", signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch { throw new HttpError(503, "evimed_account_unreachable", "The EviMed captcha image is unreachable."); }
    const mime = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw failed();
    const bytes = await responseBytes(response, MAX_RESPONSE_BYTES / 2);
    if (!bytes.length) throw failed();
    this.updateCookies(response, flow);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  /** @param {any} req @param {any} res @param {URL} url @param {Record<string, any>} body */
  async execute(req, res, url, body) {
    if (!this.enabled) throw new HttpError(404, "auth_method_disabled", "EviMed account authentication is disabled.");
    const settings = validateEvimedAccountSettings(this.config);
    this.assertOrigin(req);
    if (url.pathname !== EVIMED_ACCOUNT_PATHS.captchaUrl && url.search) throw invalid();
    let flow = this.readFlow(req);
    let path;
    let payload;
    let login = false;
    if (url.pathname === EVIMED_ACCOUNT_PATHS.captchaUrl) {
      if ([...url.searchParams.keys()].some((key) => key !== "phoneNumber") || url.searchParams.getAll("phoneNumber").length !== 1) throw invalid();
      const phone = phoneOf(url.searchParams.get("phoneNumber"));
      flow = { expiresAt: Date.now() + FLOW_TTL_MS, cookies: {}, phone };
      path = "system/captcha/get";
      payload = { phoneNumber: phone };
    } else if (url.pathname === EVIMED_ACCOUNT_PATHS.sendCodeUrl) {
      fields(body, ["purpose", "phone", "xcode"]);
      const phone = phoneOf(body.phone);
      path = "system/verifycode/send";
      if (body.purpose === "login") {
        const xcode = typeof body.xcode === "number" ? String(body.xcode) : body.xcode;
        if (typeof xcode !== "string" || !/^\d{1,4}(?:\.\d{1,4})?$/.test(xcode) || flow.phone !== phone) throw invalid();
        payload = { mark: 0, receiver: phone, xcode };
      } else if (body.purpose === "register" && body.xcode === undefined) payload = { mark: 1, prefix: "86", receiver: phone };
      else if (body.purpose === "reset" && body.xcode === undefined) payload = { mark: 2, receiver: phone };
      else throw invalid();
    } else if (url.pathname === EVIMED_ACCOUNT_PATHS.passwordLoginUrl) {
      fields(body, ["username", "password"]);
      if (typeof body.username !== "string" || !body.username.trim() || body.username.length > 128) throw invalid();
      path = "auth/login";
      payload = { username: body.username.trim(), password: passwordOf(body.password) };
      login = true;
    } else {
      fields(body, url.pathname === EVIMED_ACCOUNT_PATHS.smsLoginUrl || url.pathname === EVIMED_ACCOUNT_PATHS.verifyCodeUrl ? ["phone", "code"] : ["phone", "code", "password"]);
      const phone = phoneOf(body.phone);
      const code = codeOf(body.code);
      if (url.pathname === EVIMED_ACCOUNT_PATHS.smsLoginUrl) { path = "auth/loginByCode"; payload = { vcode: code, receiver: phone }; login = true; }
      else if (url.pathname === EVIMED_ACCOUNT_PATHS.registerUrl) { path = "system/user/register"; payload = { code, mobile: phone, pwd: passwordOf(body.password, true) }; }
      else if (url.pathname === EVIMED_ACCOUNT_PATHS.verifyCodeUrl) { path = "system/verifycode/check"; payload = { code, prefix: "86", receiver: phone }; }
      else if (url.pathname === EVIMED_ACCOUNT_PATHS.resetPasswordUrl) { path = "system/user/resetpwd"; payload = { code, newPwd: passwordOf(body.password, true), receiver: phone }; }
      else throw new HttpError(404, "not_found", "EviMed account route not found.");
    }
    const destination = new URL(path, settings.baseUrl);
    const isCaptcha = url.pathname === EVIMED_ACCOUNT_PATHS.captchaUrl;
    if (isCaptcha) destination.searchParams.set("phoneNumber", String(url.searchParams.get("phoneNumber")));
    let response;
    try {
      response = await this.fetch(destination, {
        method: isCaptcha ? "GET" : "POST",
        headers: {
          accept: "application/json", client: "pc",
          ...(!isCaptcha ? { "content-type": "application/json" } : {}),
          ...(Object.keys(flow.cookies).length ? { cookie: Object.entries(flow.cookies).map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
        },
        ...(!isCaptcha ? { body: JSON.stringify(payload) } : {}),
        redirect: "error", signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch { throw new HttpError(503, "evimed_account_unreachable", "The EviMed account service is unreachable."); }
    if ([401, 403].includes(response.status)) throw new HttpError(401, "evimed_credential_rejected", "The EviMed credential was rejected.");
    if (response.status === 429) throw new HttpError(429, "auth_rate_limited", "Too many EviMed account requests.");
    if (!response.ok) throw failed();
    const answer = await accountJson(response);
    if (String(answer.code) !== "200" || answer.success === false) {
      throw accountRefusal(url.pathname, response.status, answer, login);
    }
    if (login) {
      const session = await this.auth.createSession(req, res, { token: loginToken(answer) });
      this.writeFlow(req, res, flow, true);
      return { data: session, userId: session.user.id };
    }
    const finished = url.pathname === EVIMED_ACCOUNT_PATHS.registerUrl || url.pathname === EVIMED_ACCOUNT_PATHS.resetPasswordUrl;
    if (!finished) this.updateCookies(response, flow);
    const data = isCaptcha ? await captchaOf(answer, (value) => this.imageOf(value, settings, flow)) : true;
    this.writeFlow(req, res, flow, finished);
    return { data, userId: null };
  }
}
