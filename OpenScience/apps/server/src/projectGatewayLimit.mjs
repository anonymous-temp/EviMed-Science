/**
 * What one project's runtime may ask of a gateway that spends something outside
 * this process: the public-source gateway (an official source's patience, a
 * 16 MiB body held in memory per request) and the web-search gateway (an
 * engine's rate, and DeepSeek's per-request price).
 *
 * A runtime's token is readable by the model from its shell and is bound to its
 * account and project, so it cannot be used as anyone else. It could be used
 * without bound: a loop, or a fan-out of sub-agents, against a gateway whose
 * only limits were global (web reading's per-site pacing and concurrency, the
 * DeepSeek client's account-wide pacer). Two limits close that, per project:
 *
 *  - requests in one minute (a fixed window, as the memory gateway counts them);
 *  - requests in flight at once, for the gateway whose bodies are held in memory.
 *
 * Each protects a resource and none changes what is asked (principle 15): a
 * refused request is told which limit and, for the rate, when to come back.
 * Both count in `open_science_gateway_project_limits_total`.
 *
 * @module projectGatewayLimit
 */

import { KeyedConcurrencyGate } from "./webReadLimits.mjs";

/** The gateways that use the limit, as the metric's `gateway` label. */
export const PROJECT_GATEWAY_LIMIT_GATEWAYS = Object.freeze(["sources", "search"]);

const SERIES = Object.freeze([
  ["rate", "refused"],
  ["concurrency", "queued"],
  ["concurrency", "refused"],
]);

/** @type {Map<string, number>} `gateway|limit|action` -> count; every series exists from the start at zero. */
const counts = new Map(PROJECT_GATEWAY_LIMIT_GATEWAYS.flatMap((gateway) => SERIES.map(([limit, action]) => [`${gateway}|${limit}|${action}`, 0])));

/** @param {string} gateway @param {string} limit @param {string} action @param {number} [by] */
function count(gateway, limit, action, by = 1) {
  const key = `${gateway}|${limit}|${action}`;
  if (by > 0 && counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + by);
}

/** The test hook: counters are process state. */
export function resetProjectGatewayLimitMetrics() {
  for (const key of counts.keys()) counts.set(key, 0);
}

/**
 * @returns {{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }}
 */
export function projectGatewayLimitMetricFamily() {
  return {
    name: "open_science_gateway_project_limits_total",
    help: "Requests a project's runtime made to a gateway that spends outside resources, held by a per-project limit: refused over the minute's ceiling, or queued or refused behind its in-flight cap.",
    type: "counter",
    series: [...counts].map(([key, value]) => {
      const [gateway, limit, action] = key.split("|");
      return { value, labels: { gateway, limit, action } };
    }),
  };
}

const BUSY_CODE = "project_gateway_busy";
const noRelease = () => {};

/**
 * @param {{ gateway: "sources" | "search", ratePerMinute: number, concurrency?: number, queue?: number, now?: () => number }} options
 *   `ratePerMinute` 0 turns the ceiling off; `concurrency` 0 (the default) means no in-flight cap.
 */
export function createProjectGatewayLimit({ gateway, ratePerMinute, concurrency = 0, queue = 0, now = Date.now }) {
  const ceiling = Math.max(0, Math.floor(Number(ratePerMinute) || 0));
  const inFlight = Math.max(0, Math.floor(Number(concurrency) || 0));
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  const waiting = Math.max(0, Math.floor(Number(queue) || 0));
  const gates = inFlight > 0 ? new KeyedConcurrencyGate({ limit: inFlight, maxQueue: waiting, busyCode: BUSY_CODE }) : null;
  /** @param {{ userId?: unknown, projectId?: unknown }} identity */
  const keyOf = (identity) => `${String(identity?.userId ?? "")}\u0000${String(identity?.projectId ?? "")}`;

  return {
    ceiling,
    concurrency: inFlight,
    queue: waiting,
    /**
     * One request against the project's minute. Every authenticated request counts, a malformed one included: a flood of
     * those is the loop this exists for.
     * @param {{ userId?: unknown, projectId?: unknown }} identity
     * @returns {{ retryAfterSeconds: number } | null} `null` when the request is within the minute's ceiling, else when to come back
     */
    admit(identity) {
      if (!ceiling) return null;
      const at = now();
      if (windows.size > 10_000) for (const [name, window] of windows) if (window.until <= at) windows.delete(name);
      const key = keyOf(identity);
      const held = windows.get(key);
      const window = !held || held.until <= at ? { until: at + 60_000, count: 0 } : held;
      window.count += 1;
      windows.set(key, window);
      if (window.count <= ceiling) return null;
      count(gateway, "rate", "refused");
      return { retryAfterSeconds: Math.max(1, Math.ceil((window.until - at) / 1000)) };
    },
    /**
     * A place among the project's in-flight requests: waits in the project's own queue, and answers `null` when that queue is
     * full. The function it resolves to gives the place back; call it once, in a `finally`. Another project's requests are
     * never behind this one's.
     * @param {{ userId?: unknown, projectId?: unknown }} identity @param {AbortSignal} [signal]
     * @returns {Promise<(() => void) | null>}
     */
    async enter(identity, signal) {
      if (!gates) return noRelease;
      /** @type {() => void} */
      let release = noRelease;
      const held = new Promise((resolve) => { release = () => resolve(undefined); });
      const before = { ...gates.counts };
      const started = new Promise((resolve, reject) => {
        gates.run(keyOf(identity), () => { resolve(true); return held; }, signal ? { signal } : {}).catch((error) => {
          if (error?.code === BUSY_CODE) resolve(false);
          else reject(error);
        });
      });
      // The gate counts synchronously, before it first waits: read what this request did to it.
      count(gateway, "concurrency", "queued", gates.counts.queued - before.queued);
      count(gateway, "concurrency", "refused", gates.counts.refused - before.refused);
      return (await started) ? release : null;
    },
  };
}
