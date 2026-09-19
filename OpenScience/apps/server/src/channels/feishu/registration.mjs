/*
 * Adapted from xmanrui/dsh-im (src/channels/feishu/registration-manager.mjs),
 * MIT License, Copyright (c) 2026 xmanrui. The attempt state machine, the
 * supersede/cancel/expiry handling and the rule that the App Secret never
 * becomes manager state are theirs; the Chinese states and the provider-error
 * mapping are ours.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: the above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND.
 */

/**
 * One researcher's scan-to-create attempt: the SDK's OAuth 2.0 device flow
 * (`registerApp`, RFC 8628), driven for a browser that polls our status.
 *
 * Hidden knowledge, both from the SDK's own source:
 *
 *  - The link must be the one the SDK builds. `registerApp` takes the
 *    platform's `verification_uri_complete` and adds `from=sdk`, `tp=sdk` and
 *    `source`; the bare URI opens a page that says the link has expired. So
 *    the page renders `qrCodeUrl` exactly as `onQRCodeReady` handed it over.
 *  - A Lark (international) tenant is detected mid-poll and the SDK switches
 *    its polling domain itself (`domain_switched`); the credentials it returns
 *    then belong to open.larksuite.com, which the binding records.
 *
 * `start()` does not wait for the scan. The browser polls `status()` until a
 * terminal state; the App Secret goes straight to `onCredentials` and is never
 * part of any state a status call can return.
 *
 * Saving is not a point of no return. `onCredentials` is handed the attempt:
 * `current()` says whether it is still the one in force — not cancelled,
 * superseded or expired — and `context` is what `start()` was given for it,
 * so the saver can ask both again immediately before it writes anything.
 * Cancelling used to stop only the state shown: a save already under way
 * went on and bound the bot (security review 2026-09-20).
 *
 * @module channels/feishu/registration
 */

const ACTIVE_STATES = new Set(["starting", "qr_ready", "polling", "slow_down", "domain_switched", "saving"]);
const SDK_POLLING_STATES = new Set(["polling", "slow_down", "domain_switched"]);

export const REGISTRATION_STATES = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  QR_READY: "qr_ready",
  POLLING: "polling",
  SLOW_DOWN: "slow_down",
  DOMAIN_SWITCHED: "domain_switched",
  SAVING: "saving",
  SUCCEEDED: "succeeded",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  ERROR: "error",
});

/** What a terminal state tells the researcher, in their words. */
const MESSAGES = Object.freeze({
  access_denied: "你在飞书里拒绝了这次授权。需要时可以重新扫码。",
  expired_token: "二维码已过期，请重新生成。",
  abort: "已取消创建。",
  invalid_credentials: "飞书返回的机器人凭据不完整，请重新扫码。",
  credentials_callback_failed: "机器人已在飞书创建，但 EviMed 没能保存它。请重新扫码。",
});

/**
 * The public face of a failure. The SDK passes through any poll error the
 * platform sends besides the four RFC 8628 ones — a tenant whose
 * administrator does not allow members to create apps, a data-residency
 * tenant this flow does not serve — and its description is the platform's
 * own sentence for the person, so it is shown, bounded, rather than replaced
 * by a guess. Network and SDK errors are not copied: they can reflect a
 * request, and a request is where a secret would be.
 * @param {any} error
 */
export function registrationFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "registration_failed";
  if (Object.hasOwn(MESSAGES, code)) return { code, message: MESSAGES[/** @type {keyof typeof MESSAGES} */ (code)] };
  const isProviderError = typeof error?.code === "string" && typeof error?.description === "string" && !(error instanceof Error);
  if (isProviderError && /^[a-z0-9_]{1,64}$/.test(code)) {
    const description = error.description.replace(/\s+/g, " ").trim().slice(0, 160);
    return { code, message: `飞书没有完成创建（${code}）${description ? `：${description}` : "。"}` };
  }
  return { code: "registration_failed", message: "暂时无法连接飞书完成创建，请稍后重试。" };
}

/** @param {unknown} value */
function expirySeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError("registerApp onQRCodeReady returned an invalid expireIn");
  return seconds;
}

export class RegistrationManager {
  #registerApp;
  #onCredentials;
  #now;
  #setTimeout;
  #clearTimeout;
  #attempt = 0;
  /** @type {any} */
  #active = null;
  /** @type {Record<string, any>} */
  #snapshot;

  /**
   * @param {{ registerApp: (options: Record<string, any>) => Promise<any>,
   *   onCredentials: (result: { client_id: string, client_secret: string, user_info?: Record<string, any> },
   *     attempt: { context: any, current: () => boolean }) => Promise<Record<string, any> | void>,
   *   now?: () => number, setTimeout?: typeof globalThis.setTimeout, clearTimeout?: typeof globalThis.clearTimeout }} input
   */
  constructor({ registerApp, onCredentials, now = Date.now, setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout }) {
    if (typeof registerApp !== "function") throw new TypeError("RegistrationManager requires a registerApp function");
    if (typeof onCredentials !== "function") throw new TypeError("RegistrationManager requires an onCredentials function");
    this.#registerApp = registerApp;
    this.#onCredentials = onCredentials;
    this.#now = now;
    this.#setTimeout = setTimer;
    this.#clearTimeout = clearTimer;
    this.#snapshot = this.#makeSnapshot(null, REGISTRATION_STATES.IDLE);
  }

  /** @param {Record<string, any>} options what `registerApp` is asked for
   *  @param {any} [context] the caller's own facts about this attempt, handed back with its credentials */
  start(options = {}, context = null) {
    this.#supersedeActiveAttempt();
    const run = {
      id: ++this.#attempt,
      controller: new AbortController(),
      qrCodeUrl: null,
      expiresAt: null,
      pollIntervalSeconds: null,
      /** @type {any} */
      expiryTimer: null,
      context,
    };
    this.#active = run;
    this.#snapshot = this.#makeSnapshot(run, REGISTRATION_STATES.STARTING);
    const request = {
      ...options,
      signal: run.controller.signal,
      onQRCodeReady: (/** @type {any} */ info) => this.#onQRCodeReady(run, info),
      onStatusChange: (/** @type {any} */ info) => this.#onStatusChange(run, info),
    };
    // A microtask, so a synchronous throw and a rejection take the same path
    // and start() never blocks on the SDK.
    void Promise.resolve().then(() => this.#registerApp(request)).then(
      (result) => this.#onSucceeded(run, result),
      (error) => this.#onFailed(run, error),
    );
    return this.status();
  }

  status() {
    this.#expireIfNeeded();
    const snapshot = { ...this.#snapshot };
    if (snapshot.error) snapshot.error = { ...snapshot.error };
    const run = this.#active;
    if (run && run.expiresAt !== null && ACTIVE_STATES.has(snapshot.state)) {
      snapshot.remainingSeconds = Math.max(0, Math.ceil((run.expiresAt - this.#now()) / 1000));
    }
    return snapshot;
  }

  cancel() {
    const run = this.#active;
    if (!run) return this.status();
    this.#finish(run, REGISTRATION_STATES.CANCELLED, { error: registrationFailure({ code: "abort" }) });
    run.controller.abort();
    return this.status();
  }

  /** Whether an attempt is still waiting for the scan or saving its result. */
  get active() {
    return this.#active !== null;
  }

  /** @param {any} run @param {string} state @param {Record<string, any>} [extra] */
  #makeSnapshot(run, state, extra = {}) {
    /** @type {Record<string, any>} */
    const snapshot = { state, attempt: run?.id ?? this.#attempt, updatedAt: new Date(this.#now()).toISOString(), ...extra };
    if (run?.qrCodeUrl && ACTIVE_STATES.has(state) && state !== REGISTRATION_STATES.SAVING) {
      snapshot.qrCodeUrl = run.qrCodeUrl;
      snapshot.expiresAt = new Date(run.expiresAt).toISOString();
    }
    if (run?.pollIntervalSeconds != null && ACTIVE_STATES.has(state)) snapshot.pollIntervalSeconds = run.pollIntervalSeconds;
    return snapshot;
  }

  /** @param {any} run @param {string} state @param {Record<string, any>} [extra] */
  #setState(run, state, extra = {}) {
    if (this.#active !== run) return;
    this.#snapshot = this.#makeSnapshot(run, state, extra);
  }

  /** @param {any} run @param {any} info */
  #onQRCodeReady(run, info) {
    if (this.#active !== run) return;
    if (typeof info?.url !== "string" || !info.url) throw new TypeError("registerApp onQRCodeReady returned an invalid URL");
    const seconds = expirySeconds(info.expireIn);
    run.qrCodeUrl = info.url;
    run.expiresAt = this.#now() + seconds * 1000;
    this.#clearExpiryTimer(run);
    run.expiryTimer = this.#setTimeout(() => this.#expire(run), seconds * 1000);
    run.expiryTimer?.unref?.();
    this.#setState(run, REGISTRATION_STATES.QR_READY);
  }

  /** @param {any} run @param {any} info */
  #onStatusChange(run, info) {
    if (this.#active !== run || !SDK_POLLING_STATES.has(info?.status)) return;
    if (info.status === REGISTRATION_STATES.SLOW_DOWN && Number.isFinite(Number(info.interval))) {
      run.pollIntervalSeconds = Number(info.interval);
    }
    this.#setState(run, info.status);
  }

  /** @param {any} run @param {any} result */
  async #onSucceeded(run, result) {
    // Credentials that arrive after the code's own expiry are refused like
    // any other expired attempt, even if the expiry timer has not fired yet.
    this.#expireIfNeeded();
    if (this.#active !== run) return;
    const clientId = result?.client_id;
    const clientSecret = result?.client_secret;
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
      this.#finish(run, REGISTRATION_STATES.ERROR, { error: registrationFailure({ code: "invalid_credentials" }) });
      return;
    }
    // Once the credentials exist the QR code is spent: drop it before the
    // save, so the `saving` status no longer offers a link to scan again.
    this.#clearExpiryTimer(run);
    run.qrCodeUrl = null;
    run.expiresAt = null;
    this.#setState(run, REGISTRATION_STATES.SAVING);
    let outcome;
    try {
      outcome = await this.#onCredentials({
        client_id: clientId,
        client_secret: clientSecret,
        user_info: result.user_info && typeof result.user_info === "object" ? { ...result.user_info } : undefined,
      }, { context: run.context, current: () => this.#active === run });
    } catch (error) {
      const code = typeof (/** @type {any} */ (error)?.code) === "string" ? /** @type {any} */ (error).code : "credentials_callback_failed";
      const message = typeof (/** @type {any} */ (error)?.publicMessage) === "string"
        ? /** @type {any} */ (error).publicMessage : MESSAGES.credentials_callback_failed;
      if (this.#active === run) this.#finish(run, REGISTRATION_STATES.ERROR, { error: { code, message } });
      return;
    }
    if (this.#active === run) this.#finish(run, REGISTRATION_STATES.SUCCEEDED, outcome && typeof outcome === "object" ? { result: outcome } : {});
  }

  /** @param {any} run @param {any} error */
  #onFailed(run, error) {
    if (this.#active !== run) return;
    const failure = registrationFailure(error);
    const state = failure.code === "expired_token" ? REGISTRATION_STATES.EXPIRED
      : failure.code === "abort" ? REGISTRATION_STATES.CANCELLED : REGISTRATION_STATES.ERROR;
    this.#finish(run, state, { error: failure });
  }

  #expireIfNeeded() {
    const run = this.#active;
    if (run && run.expiresAt !== null && this.#now() >= run.expiresAt) this.#expire(run);
  }

  /** @param {any} run */
  #expire(run) {
    if (this.#active !== run) return;
    this.#finish(run, REGISTRATION_STATES.EXPIRED, { error: registrationFailure({ code: "expired_token" }) });
    run.controller.abort();
  }

  /** @param {any} run @param {string} state @param {Record<string, any>} [extra] */
  #finish(run, state, extra = {}) {
    if (this.#active !== run) return;
    this.#clearExpiryTimer(run);
    this.#snapshot = this.#makeSnapshot(run, state, extra);
    this.#active = null;
  }

  /** @param {any} run */
  #clearExpiryTimer(run) {
    if (run.expiryTimer !== null) {
      this.#clearTimeout(run.expiryTimer);
      run.expiryTimer = null;
    }
  }

  #supersedeActiveAttempt() {
    const previous = this.#active;
    if (!previous) return;
    this.#clearExpiryTimer(previous);
    this.#active = null;
    previous.controller.abort();
  }
}
