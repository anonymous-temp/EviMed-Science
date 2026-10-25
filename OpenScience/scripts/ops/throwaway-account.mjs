/**
 * A throwaway account for a script that has to be signed in: the UI walk and the three acceptance drivers.
 *
 * Hidden knowledge:
 *
 * - **Nothing signs in as a fixed account any more** (owner, 2026-10-25). The account the walk and the drivers used to sign in as was
 *   also the account its owner worked in, so every run left its sessions, its `acceptance-*` projects and its memories among the
 *   owner's own; it was deleted, and production keeps no test account. A run now registers its own account through the product's own
 *   self-registration (`POST /api/auth/register`, which signs the new account in by the same call), uses it, and deletes it through the
 *   product's own `DELETE /api/account` — on success, on failure and on abort. The password is made here, held in this closure and
 *   never printed, written or passed on: an account that was not deleted cannot be signed in to again by anyone, so a leak is a failure
 *   the caller reports (`close()` says which account), never a silent leftover.
 * - The deletion needs the session's CSRF token and the exact id as a confirmation, as the account page's own deletion does, and the
 *   control plane answers 409 `account_busy` while a task of the account is still queued or running: `stop` is the caller's hook to
 *   stop what it started (a run it dispatched) before the first try, and the deletion is asked again a few times with a short wait.
 *   The deletion itself stops the account's runtimes and removes its memory, projects, documents and files. A session that ended (401)
 *   is signed in again with the password the account was made with and the deletion asked once more.
 * - Two transports, because the callers hold their session in two ways: `fetchTransport` keeps the cookie itself (the drivers that
 *   send their own `fetch` use `account.headers` for the same session), `contextTransport` sends through a Playwright context, whose
 *   cookie jar is the session the browser pages then use.
 * - A leftover is named by its id: `<prefix>-<UTC yyyymmddHHMM>-<6 hex>`. The prefix says which script made it (`walk`, `acc`), the
 *   time says when, and an operator who finds one the script could not delete knows nobody owns it.
 *
 * Build to delete: once the control plane can mint an account that expires by itself, the deletion half goes.
 *
 * @module throwaway-account
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";

/** The product's own routes: registration signs in, deletion needs the session, its CSRF token and the exact id. */
export const REGISTER_ROUTE = "/api/auth/register";
export const LOGIN_ROUTE = "/api/auth/login";
export const ACCOUNT_ROUTE = "/api/account";

/** How many times the deletion is asked and how long it waits between asks (the control plane refuses while a task is active). */
export const DELETE_ATTEMPTS = 6;
export const DELETE_WAIT_MS = 5_000;

/**
 * The signals that end a script early. Each ends in the account's deletion and then the exit a shell reports for that signal.
 */
const SIGNALS = /** @type {const} */ ([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]);

/**
 * `<prefix>-<UTC yyyymmddHHMM>-<6 hex>`: an id the product accepts (a letter or digit first, then letters, digits, `_` and `-`, at most 64).
 * @param {string} prefix @param {Date} [now] @param {(size: number) => Buffer} [random]
 */
export function throwawayId(prefix, now = new Date(), random = randomBytes) {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error(`a throwaway account's prefix is a short lowercase word, not ${JSON.stringify(prefix)}`);
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${prefix}-${stamp}-${random(3).toString("hex")}`;
}

/** A password no one will ever type: 32 characters from 24 random bytes. @param {(size: number) => Buffer} [random] */
export function throwawayPassword(random = randomBytes) {
  return random(24).toString("base64url");
}

/**
 * What one request answered, as the helper reads it: the status, the parsed body (null when it was not JSON) and the cookies it set.
 * @typedef {{ status: number, body: any, cookies: string[] }} Answer
 * What the helper sends: the transport adds the base and the session.
 * @typedef {(request: { method: "POST" | "DELETE", route: string, headers?: Record<string, string>, body?: unknown }) => Promise<Answer>} Transport
 */

/**
 * A transport over `fetch`, with the session kept here: the cookie a response sets is sent on the calls after it.
 * @param {string} base @param {{ timeoutMs?: number }} [options]
 * @returns {Transport}
 */
export function fetchTransport(base, { timeoutMs = 30_000 } = {}) {
  /** @type {Map<string, string>} */ const jar = new Map();
  return async ({ method, route, headers = {}, body }) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(`${base}${route}`, {
      method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    /** @type {any} */ let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const cookies = response.headers.getSetCookie?.() ?? [];
    for (const entry of cookies) {
      const [pair] = entry.split(";");
      const at = pair.indexOf("=");
      if (at > 0) {
        const value = pair.slice(at + 1);
        // An expired cookie the server clears is not a session to keep.
        if (value === "" || /;\s*max-age=0\b/i.test(entry)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), value);
      }
    }
    return { status: response.status, body: parsed, cookies };
  };
}

/**
 * A transport through a Playwright browser context: its cookie jar is the session the context's pages are signed in with.
 * @param {any} context a Playwright `BrowserContext` @param {string} base @param {{ timeoutMs?: number }} [options]
 * @returns {Transport}
 */
export function contextTransport(context, base, { timeoutMs = 30_000 } = {}) {
  return async ({ method, route, headers = {}, body }) => {
    const response = await context.request[method.toLowerCase()](`${base}${route}`, {
      headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { data: body }), timeout: timeoutMs,
    });
    const parsed = await response.json().catch(() => null);
    const cookies = (response.headersArray?.() ?? []).filter((/** @type {{ name: string }} */ header) => header.name.toLowerCase() === "set-cookie")
      .map((/** @type {{ value: string }} */ header) => header.value);
    return { status: response.status(), body: parsed, cookies };
  };
}

/** The product's refusal as a short phrase: its code, else its status. @param {Answer} answer */
function refusal(answer) {
  const code = answer.body && typeof answer.body === "object" && typeof answer.body.code === "string" ? answer.body.code : "";
  return code ? `${answer.status} ${code}` : String(answer.status);
}

/**
 * What a registration that did not leave a usable session says. `account` is set when the account may exist.
 */
export class ThrowawayAccountError extends Error {
  /** @param {string} message @param {string | null} [account] */
  constructor(message, account = null) {
    super(message);
    this.name = "ThrowawayAccountError";
    this.account = account;
  }
}

/**
 * Register an account and keep what is needed to delete it. The id is on the line `account created:`; the password is never printed.
 *
 * `close()` ends the account (idempotent, so a `finally` and a signal may both call it) and says so on one line, `account deleted:`, or,
 * when it could not, on a `FAIL` line naming the account; it returns `{ deleted, reason }` and never throws, so a caller's own `finally`
 * cannot be cut short by it. A script that is interrupted deletes the account before it exits (`onSignal` runs after, for what the
 * script still has to close — the browser needs its session for the deletion, so it is closed after).
 *
 * @param {{ base: string, send: Transport, prefix: string, say?: (line: string) => void, sleep?: (ms: number) => Promise<unknown>,
 *   stop?: (account: { id: string }) => Promise<unknown>, onSignal?: () => Promise<unknown>, attempts?: number, waitMs?: number,
 *   now?: () => Date, random?: (size: number) => Buffer, signals?: boolean }} options
 * @returns {Promise<{ id: string, csrfToken: string, cookie: string, headers: Record<string, string>, close: () => Promise<{ deleted: boolean, reason: string | null }> }>}
 */
export async function openThrowawayAccount({
  base, send, prefix, say = (line) => console.log(line), sleep = sleepFor, stop, onSignal, attempts = DELETE_ATTEMPTS, waitMs = DELETE_WAIT_MS,
  now = () => new Date(), random = randomBytes, signals = true,
}) {
  const id = throwawayId(prefix, now(), random);
  const password = throwawayPassword(random);
  const origin = { origin: base };
  /** @type {Answer} */ let registered;
  try {
    registered = await send({ method: "POST", route: REGISTER_ROUTE, headers: origin, body: { username: id, password, name: id } });
  } catch (error) {
    // The request may have been answered after it was given up: the account may exist, and nothing here can sign in to it.
    throw new ThrowawayAccountError(`registering ${id} did not complete (${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}); the account may exist`, id);
  }
  if (registered.status !== 201) {
    const why = refusal(registered);
    throw new ThrowawayAccountError(`registering ${id} was refused (${why})${/self_registration_disabled/.test(why) ? ": this deployment does not take new accounts, and a walk or a driver has no other way in" : ""}`, why.startsWith("5") ? id : null);
  }
  let csrfToken = String(registered.body?.data?.csrfToken ?? "");
  if (!csrfToken) throw new ThrowawayAccountError(`registering ${id} left no session to delete it with`, id);
  const cookie = registered.cookies.map((entry) => entry.split(";")[0]).join("; ");
  say(`account created: ${id}`);

  /** @type {Promise<{ deleted: boolean, reason: string | null }> | null} */ let closing = null;
  /** @type {Array<[string, (...args: any[]) => void]>} */ const handlers = [];
  const removeHandlers = () => { for (const [signal, handler] of handlers) process.off(signal, handler); handlers.length = 0; };

  const remove = async () => {
    removeHandlers();
    if (stop) await stop({ id }).catch((error) => say(`INFO account ${id}: what the script started could not be stopped first (${String(error?.message ?? error).slice(0, 100)})`));
    /** @type {string} */ let reason = "no attempt was made";
    let signedInAgain = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      /** @type {Answer} */ let answer;
      try {
        answer = await send({ method: "DELETE", route: ACCOUNT_ROUTE, headers: { ...origin, "x-open-science-csrf": csrfToken }, body: { confirm: id, password } });
      } catch (error) {
        answer = { status: 0, body: { code: "transport" }, cookies: [] };
        reason = `the request did not complete (${String(/** @type {any} */ (error)?.message ?? error).slice(0, 80)})`;
      }
      if (answer.status === 200) { say(`account deleted: ${id}`); return { deleted: true, reason: null }; }
      if (answer.status !== 0) reason = refusal(answer);
      if (answer.status === 401 && !signedInAgain) {
        // The session ended before the deletion: sign in with the password the account was made with, take its new CSRF token, ask again.
        signedInAgain = true;
        const again = await send({ method: "POST", route: LOGIN_ROUTE, headers: origin, body: { username: id, password } }).catch(() => null);
        const token = String(again?.body?.data?.csrfToken ?? "");
        if (again?.status === 200 && token) { csrfToken = token; continue; }
        reason = `${reason}; and signing in again answered ${again?.status ?? "nothing"}`;
        break;
      }
      // Busy, unreachable or overloaded: wait and ask again. Anything else is the product's answer to this request, not a reason to wait.
      const transient = answer.status === 0 || answer.status === 409 || answer.status === 429 || answer.status >= 500;
      if (!transient || attempt === attempts) break;
      await sleep(waitMs);
    }
    say(`FAIL account ${id} was NOT deleted (${reason}); nobody can sign in to it again, so an operator has to remove it`);
    return { deleted: false, reason };
  };
  const close = () => (closing ??= remove());

  if (signals) {
    for (const [signal, code] of SIGNALS) {
      const handler = () => { void close().then(() => onSignal?.()).catch(() => {}).finally(() => process.exit(code)); };
      handlers.push([signal, handler]);
      process.on(signal, handler);
    }
  }
  return { id, csrfToken, cookie, headers: { ...(cookie ? { cookie } : {}), "x-open-science-csrf": csrfToken }, close };
}
