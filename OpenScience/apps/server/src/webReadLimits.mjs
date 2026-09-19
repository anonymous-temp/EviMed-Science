/**
 * The limits web reading holds itself to: how often one site hears from us,
 * how many reads are in flight at once, and how many of them one project's
 * runtime holds. Each protects a resource — the site's patience, this host's
 * memory, the other projects' share — and none changes what is read
 * (principle 15). Each counts what it did, so an operator can see a limit
 * biting before a researcher reports a slow run.
 *
 * @module webReadLimits
 */

import { webReadError } from "./webReadNetwork.mjs";

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve(undefined);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Spaces requests to one host at least `intervalMs` apart (longer when the
 * site's robots.txt asks for a Crawl-delay). A request that would have to wait
 * longer than `maxWaitMs` is refused with a named code instead of queued: a
 * run fanning out over one regulator's list gets told to slow down, it does not
 * silently hold a gateway slot for a minute.
 */
export class HostPacer {
  /** @param {{ intervalMs: number, maxWaitMs?: number, now?: () => number, wait?: (ms: number, signal?: AbortSignal) => Promise<unknown> }} options */
  constructor({ intervalMs, maxWaitMs = 15_000, now = Date.now, wait = sleep }) {
    this.intervalMs = Math.max(0, Number(intervalMs) || 0);
    this.maxWaitMs = Math.max(0, Number(maxWaitMs) || 0);
    this.now = now;
    this.wait = wait;
    /** @type {Map<string, number>} next free slot per host */
    this.nextAt = new Map();
    this.counts = { waited: 0, refused: 0 };
  }

  /**
   * @param {string} host
   * @param {{ crawlDelayMs?: number | null, signal?: AbortSignal }} [options]
   */
  async acquire(host, { crawlDelayMs = null, signal } = {}) {
    const key = String(host).toLowerCase();
    const now = this.now();
    const slot = Math.max(now, this.nextAt.get(key) ?? 0);
    const waitMs = slot - now;
    if (waitMs > this.maxWaitMs) {
      this.counts.refused += 1;
      throw webReadError(429, "web_read_host_busy", "This site was read moments ago; wait a little before reading it again.", { retryable: true });
    }
    this.nextAt.set(key, slot + Math.max(this.intervalMs, Number(crawlDelayMs) || 0));
    // The table only needs hosts whose slot is still in the future.
    if (this.nextAt.size > 4_096) {
      for (const [name, at] of this.nextAt) if (at < now) this.nextAt.delete(name);
    }
    if (waitMs > 0) {
      this.counts.waited += 1;
      await this.wait(waitMs, signal);
    }
  }
}

/**
 * At most `limit` operations at once; up to `maxQueue` wait their turn and the
 * rest are refused. Used for plain reads (each can hold a 16 MiB body in
 * memory), HTML parses (each a thread with its own heap), renders (each is a
 * browser context in the one warm session), and one per project runtime.
 */
export class ConcurrencyGate {
  /**
   * @param {{ limit: number, maxQueue?: number, busyCode: string, busyMessage?: string,
   *   counts?: { queued: number, refused: number } }} options
   */
  constructor({ limit, maxQueue = 64, busyCode, busyMessage = "Too many web reads are in progress; retry shortly.", counts = { queued: 0, refused: 0 } }) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.maxQueue = Math.max(0, Math.floor(Number(maxQueue) || 0));
    this.busyCode = busyCode;
    this.busyMessage = busyMessage;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
    this.counts = counts;
  }

  /**
   * @template T
   * @param {() => Promise<T>} work
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(work, { signal } = {}) {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      if (this.queue.length >= this.maxQueue) {
        this.counts.refused += 1;
        throw webReadError(503, this.busyCode, this.busyMessage, { retryable: true });
      }
      this.counts.queued += 1;
      // The finishing operation hands its slot straight to the next waiter
      // (`active` never drops), so a newcomer arriving in between cannot slip
      // past the queue and push the count over the limit.
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        const entry = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(undefined);
        };
        this.queue.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * One ConcurrencyGate per key — per project runtime, for web reading — so one
 * caller's burst waits in its own queue instead of taking every shared slot.
 * A key's gate exists while it has work running or queued; the counts are all
 * the keys' together.
 */
export class KeyedConcurrencyGate {
  /** @param {{ limit: number, maxQueue?: number, busyCode: string, busyMessage?: string }} options */
  constructor(options) {
    this.options = options;
    /** @type {Map<string, ConcurrencyGate>} */
    this.gates = new Map();
    this.counts = { queued: 0, refused: 0 };
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} work
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(key, work, { signal } = {}) {
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new ConcurrencyGate({ ...this.options, counts: this.counts });
      this.gates.set(key, gate);
    }
    try {
      return await gate.run(work, { signal });
    } finally {
      if (gate.active === 0 && gate.queue.length === 0 && this.gates.get(key) === gate) this.gates.delete(key);
    }
  }
}
