/**
 * The long connections: one outbound WebSocket per bound Feishu app.
 *
 * Hidden knowledge, from the platform and from the SDK's WSClient source:
 *
 *  - Long connection is for self-built apps only (a store app must use HTTP
 *    callbacks), it is outbound — the host opens nothing beyond 80/443 — and
 *    it runs in cluster mode: with several clients per app, one random client
 *    receives each event. Two control-plane replicas holding the same app is
 *    therefore safe; the durable inbound row is what makes it correct.
 *  - The acknowledgement is sent when the event handler's promise settles,
 *    and Feishu re-pushes anything not acknowledged within 3 seconds. The
 *    handler here only records the event (one insert); a throw sends a 500
 *    and Feishu retries, which is the right outcome for a failed insert.
 *  - The SDK reconnects on its own, and gives up in two ways that must be
 *    answered here: `onError` after exhausted retries or a refused
 *    connection config (a reset secret, a deleted app), and — silently — a
 *    `start()` that returns without connecting when the app id is malformed.
 *    A watchdog covers the second; both schedule a restart with backoff.
 *
 * @module channels/feishu/connection
 */

import { SecretScrubber, describeError, sdkLogger } from "./redact.mjs";

/** How long a start may take to report ready before it counts as failed. */
const CONNECT_TIMEOUT_MS = 30_000;
/** The first restart delay after a failure, doubled per consecutive failure. */
const BASE_BACKOFF_MS = 30_000;
/** The longest a failed app waits before trying again. */
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * @typedef {{ state: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped', errorCode: string | null,
 *   since: string, retryAt: string | null, failures: number }} ConnectionStatus
 */

export class FeishuConnections {
  /**
   * @param {{ loadSdk: () => Promise<any>, resolveSecret: (binding: any) => Promise<string | null>,
   *   onEvent: (binding: any, payload: any) => Promise<void>, scrubber?: SecretScrubber,
   *   now?: () => number, setTimeout?: typeof globalThis.setTimeout, clearTimeout?: typeof globalThis.clearTimeout,
   *   write?: (line: string) => void }} input
   */
  constructor({ loadSdk, resolveSecret, onEvent, scrubber = new SecretScrubber(), now = Date.now,
    setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout,
    write = (line) => { process.stderr.write(line); } }) {
    this.loadSdk = loadSdk;
    this.resolveSecret = resolveSecret;
    this.onEvent = onEvent;
    this.scrubber = scrubber;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.write = write;
    /** @type {Map<string, any>} bindingId -> connection record */
    this.connections = new Map();
    this.closed = false;
  }

  /**
   * Make the live set match the bindings: start what is missing, restart
   * what changed (a re-scan gives the same account a new app), stop the rest.
   * @param {readonly any[]} bindings active Feishu bindings
   */
  async sync(bindings) {
    if (this.closed) return;
    const wanted = new Map(bindings.map((binding) => [binding.id, binding]));
    for (const [id, record] of [...this.connections]) {
      const binding = wanted.get(id);
      if (!binding || binding.metadata?.appId !== record.appId || binding.metadata?.tenantBrand !== record.tenantBrand) {
        await this.stop(id);
      }
    }
    for (const binding of wanted.values()) {
      if (!this.connections.has(binding.id)) await this.#start(binding);
    }
  }

  /** @param {string} bindingId @returns {ConnectionStatus | null} */
  status(bindingId) {
    const record = this.connections.get(bindingId);
    if (!record) return null;
    return {
      state: record.state, errorCode: record.errorCode, since: new Date(record.since).toISOString(),
      retryAt: record.retryAt ? new Date(record.retryAt).toISOString() : null, failures: record.failures,
    };
  }

  /** @param {string} bindingId */
  async stop(bindingId) {
    const record = this.connections.get(bindingId);
    if (!record) return;
    this.connections.delete(bindingId);
    this.#teardown(record);
  }

  async closeAll() {
    this.closed = true;
    for (const id of [...this.connections.keys()]) await this.stop(id);
  }

  /** @param {any} binding */
  async #start(binding) {
    /** @type {any} */
    const record = {
      bindingId: binding.id,
      appId: binding.metadata?.appId ?? null,
      tenantBrand: binding.metadata?.tenantBrand ?? "feishu",
      state: "connecting", errorCode: null, since: this.now(), retryAt: null, failures: 0,
      client: null, watchdog: null, retryTimer: null, generation: 0,
    };
    this.connections.set(binding.id, record);
    await this.#connect(record, binding);
  }

  /** @param {any} record @param {any} binding */
  async #connect(record, binding) {
    const generation = ++record.generation;
    const current = () => this.connections.get(record.bindingId) === record && record.generation === generation && !this.closed;
    this.#set(record, "connecting", null);
    let sdk;
    let secret;
    try {
      sdk = await this.loadSdk();
      secret = await this.resolveSecret(binding);
    } catch (error) {
      if (current()) this.#fail(record, binding, "feishu_connection_setup_failed", error);
      return;
    }
    if (!current()) return;
    if (!secret || !record.appId) {
      this.#fail(record, binding, "feishu_secret_missing", null);
      return;
    }
    // Added, never removed: the API clients share this scrubber, and scrubbing
    // a retired secret from a log line costs nothing.
    this.scrubber.add(secret);
    const logger = sdkLogger(this.scrubber, this.write);
    const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel?.warn, logger }).register({
      "im.message.receive_v1": async (/** @type {any} */ payload) => {
        if (!current()) return;
        await this.onEvent(binding, payload);
      },
    });
    let client;
    try {
      client = new sdk.WSClient({
        appId: record.appId,
        appSecret: secret,
        domain: record.tenantBrand === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu,
        loggerLevel: sdk.LoggerLevel?.warn,
        logger,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        onReady: () => { if (current()) this.#ready(record); },
        onReconnected: () => { if (current()) this.#ready(record); },
        onReconnecting: () => { if (current()) this.#set(record, "reconnecting", null); },
        onError: (/** @type {any} */ error) => {
          if (current()) this.#fail(record, binding, "feishu_connection_failed", error);
        },
      });
    } catch (error) {
      this.#fail(record, binding, "feishu_connection_failed", error);
      return;
    }
    record.client = client;
    record.watchdog = this.setTimer(() => {
      if (current() && record.state === "connecting") this.#fail(record, binding, "feishu_connect_timeout", null);
    }, CONNECT_TIMEOUT_MS);
    record.watchdog?.unref?.();
    try {
      await client.start({ eventDispatcher: dispatcher });
    } catch (error) {
      if (current()) this.#fail(record, binding, "feishu_connection_failed", error);
    }
  }

  /** @param {any} record */
  #ready(record) {
    if (record.watchdog) { this.clearTimer(record.watchdog); record.watchdog = null; }
    record.failures = 0;
    record.retryAt = null;
    this.#set(record, "connected", null);
  }

  /** @param {any} record @param {any} binding @param {string} code @param {unknown} error */
  #fail(record, binding, code, error) {
    this.#teardown(record, { keepRecord: true });
    record.failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(record.failures - 1, 10));
    record.retryAt = this.now() + delay;
    this.#set(record, "failed", code);
    this.write(`feishu connection ${record.bindingId} ${code}${error ? `: ${describeError(error, this.scrubber)}` : ""}; retry in ${Math.round(delay / 1000)}s\n`);
    record.retryTimer = this.setTimer(() => {
      record.retryTimer = null;
      if (this.connections.get(record.bindingId) === record && !this.closed) void this.#connect(record, binding);
    }, delay);
    record.retryTimer?.unref?.();
  }

  /** @param {any} record @param {string} state @param {string | null} code */
  #set(record, state, code) {
    if (record.state !== state) record.since = this.now();
    record.state = state;
    record.errorCode = code;
  }

  /** @param {any} record @param {{ keepRecord?: boolean }} [options] */
  #teardown(record, { keepRecord = false } = {}) {
    record.generation += 1;
    if (record.watchdog) { this.clearTimer(record.watchdog); record.watchdog = null; }
    if (record.retryTimer) { this.clearTimer(record.retryTimer); record.retryTimer = null; }
    const client = record.client;
    record.client = null;
    try { client?.close?.({ force: true }); } catch { /* a socket already gone needs no closing */ }
    if (!keepRecord) record.state = "stopped";
  }
}
