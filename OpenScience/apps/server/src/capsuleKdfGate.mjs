/**
 * Who may run a capsule password derivation, and in what order.
 *
 * A password-wrapped pack costs a memory-hard derivation (scrypt) to seal and to open, paid on a pool thread of this one
 * process by whoever sent the request. The process runs one derivation at a time, because each holds up to 128 MiB. Until
 * 2026-10-10 that was a single slot and a second request was refused at once, so one account sending requests back to back
 * (each with a pack it had built itself) kept every other account's preview, import and link redemption at 429 for as long
 * as it liked (review C-10).
 *
 * Hidden knowledge:
 * - **One place per account.** An account has at most one request in the gate, running or waiting. Its next request while
 *   that one is there is refused by name and takes nobody else's place; once the first is done, the next one joins the back.
 * - **Arrival order is round-robin.** With one place per account, first come first served is also a turn for every account
 *   that is waiting: an account that has just been served is behind all of them. Nobody is ranked, so nobody needs a score.
 * - **Waiting is bounded in length and in time.** A line longer than `maxWaiting`, or a wait past `maxWaitMs`, is refused
 *   rather than held: a refusal tells a client to come back, an unbounded queue tells it nothing and holds a connection.
 * - **No identity means one shared account.** A caller that names none (a script, a test) is one account among the others,
 *   so the process-wide rule of one derivation at a time still holds for it.
 *
 * Every refusal is the same code the container always used (`capsule_password_busy`) with the `reason` it was refused for,
 * so a caller that only knew the code still reads it right and a counter can tell the three apart.
 *
 * The three limits are the deployment's (review C4e): `OPEN_SCIENCE_CAPSULE_KDF_CONCURRENCY`, `_MAX_WAITING` and `_MAX_WAIT_MS`
 * in `config.mjs`, set once at start through `configure` (`capsuleContainer.mjs` holds the process's one gate). The numbers
 * below are what the gate was built with and what the configuration defaults to.
 *
 * @module capsuleKdfGate
 */

/** The gate's limits as it was built: one derivation at a time, six accounts waiting, ten seconds of waiting. */
export const KDF_GATE_DEFAULTS = Object.freeze({ concurrency: 1, maxWaiting: 6, maxWaitMs: 10_000 });

/** The reasons a request is refused, in the words the operator's counter uses. */
export const KDF_REFUSAL_REASONS = Object.freeze(["account_busy", "queue_full", "waited_out"]);

/** @typedef {typeof KDF_REFUSAL_REASONS[number]} KdfRefusalReason */

/** @param {KdfRefusalReason} reason @returns {Error & { code: string, reason: KdfRefusalReason, retryAfterSeconds: number }} */
function refusal(reason) {
  const message = reason === "account_busy" ? "This account already has a capsule password operation in progress."
    : "Capsule password operations are busy; try again shortly.";
  return Object.assign(new Error(message), { code: "capsule_password_busy", reason, retryAfterSeconds: 2 });
}

export class PasswordKdfGate {
  /** @type {Set<string>} */ #held = new Set();
  /** @type {{ key: string, resume: () => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> | null }[]} */ #waiting = [];
  #running = 0;

  /**
   * @param {{ concurrency?: number, maxWaiting?: number, maxWaitMs?: number }} [options] the derivations that may run at once,
   *   the accounts that may wait for one, and how long one may wait
   */
  constructor({ concurrency = KDF_GATE_DEFAULTS.concurrency, maxWaiting = KDF_GATE_DEFAULTS.maxWaiting, maxWaitMs = KDF_GATE_DEFAULTS.maxWaitMs } = {}) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
    this.maxWaitMs = maxWaitMs;
  }

  /** The limits the gate runs on now. */
  get limits() { return { concurrency: this.concurrency, maxWaiting: this.maxWaiting, maxWaitMs: this.maxWaitMs }; }

  /**
   * Set the limits from the deployment's configuration. Meant for start, before the first request: a request that is already
   * running or waiting keeps the place it has, and the new limits apply to the requests that come after. A value that is no
   * limit (not a whole number, or below its minimum: one derivation, an empty line, a wait of a millisecond) leaves that limit
   * as it was — the configuration has already refused it by name, and a gate must never be left unable to run anything.
   * @param {{ concurrency?: unknown, maxWaiting?: unknown, maxWaitMs?: unknown }} limits
   */
  configure({ concurrency, maxWaiting, maxWaitMs }) {
    if (Number.isSafeInteger(concurrency) && /** @type {number} */ (concurrency) >= 1) this.concurrency = /** @type {number} */ (concurrency);
    if (Number.isSafeInteger(maxWaiting) && /** @type {number} */ (maxWaiting) >= 0) this.maxWaiting = /** @type {number} */ (maxWaiting);
    if (Number.isSafeInteger(maxWaitMs) && /** @type {number} */ (maxWaitMs) >= 1) this.maxWaitMs = /** @type {number} */ (maxWaitMs);
  }

  /** How many derivations are running and how many requests are waiting. */
  get load() { return { running: this.#running, waiting: this.#waiting.length }; }

  /**
   * Run one derivation when it is this account's turn.
   * @template T
   * @param {string | null | undefined} account the account the work is for; none is one shared account
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async run(account, task) {
    const key = typeof account === "string" ? account : "";
    if (this.#held.has(key)) throw refusal("account_busy");
    const free = this.#running < this.concurrency && this.#waiting.length === 0;
    if (!free && this.#waiting.length >= this.maxWaiting) throw refusal("queue_full");
    this.#held.add(key);
    try {
      if (free) this.#running += 1;
      else await this.#wait(key);
      try { return await task(); } finally { this.#release(); }
    } finally {
      this.#held.delete(key);
    }
  }

  /** Join the back of the line. Resolves when the place has been handed over (and counted as running), rejects on a spent wait. @param {string} key */
  #wait(key) {
    return new Promise((resolve, reject) => {
      const entry = { key, resume: () => resolve(undefined), reject, timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null) };
      entry.timer = setTimeout(() => {
        const index = this.#waiting.indexOf(entry);
        if (index >= 0) { this.#waiting.splice(index, 1); reject(refusal("waited_out")); }
      }, this.maxWaitMs);
      entry.timer.unref?.();
      this.#waiting.push(entry);
    });
  }

  /** A derivation is done: its place passes to the one that has waited longest, or is given back. */
  #release() {
    const next = this.#waiting.shift();
    if (!next) { this.#running -= 1; return; }
    if (next.timer) clearTimeout(next.timer);
    next.resume();
  }
}
