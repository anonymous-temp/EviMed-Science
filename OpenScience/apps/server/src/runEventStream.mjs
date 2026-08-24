/**
 * The control plane's own event stream to the browser.
 *
 * Hidden knowledge: the browser never speaks to a kernel. It used to — a single
 * pass-through route proxied OpenCode's SSE straight into the page, which meant
 * the frontend knew OpenCode's message shapes, its approval modes and its part
 * states, and every kernel change was a frontend change.
 *
 * Now the control plane subscribes to the container, decodes into
 * `@evimed/domain`'s `RunEvent`, and forwards its own stream. Three properties
 * follow, and each of them is why this module exists rather than a proxy:
 *
 * - the browser's event union is ours, so it can be exhaustively switched and
 *   an unknown variant is counted and shown rather than silently dropped;
 * - resumption is by our sequence number, so a reconnecting tab replays from
 *   where it was rather than from the beginning;
 * - the run's own facts — deliverable verdicts, evidence states, budget — ride
 *   the same channel as the kernel's, because from a user's point of view they
 *   are one story.
 *
 * @module runEventStream
 */

/** Heartbeat interval. Long enough not to be noise, short enough to keep proxies from idling the connection out. */
const HEARTBEAT_MS = 25_000;

/** How many events one run keeps for a reconnecting client. */
const REPLAY_BUFFER = 500;

/**
 * @typedef {object} StreamEnvelope
 * @property {number} seq
 * @property {string} time
 * @property {string} type
 * @property {Record<string, any>} data
 */

/**
 * One run's fan-out: a bounded replay buffer plus the currently attached
 * responses.
 */
export class RunEventChannel {
  /** @param {string} runId */
  constructor(runId) {
    this.runId = runId;
    this.seq = 0;
    /** @type {StreamEnvelope[]} */
    this.buffer = [];
    /** @type {Set<{ write: (chunk: string) => void, close: () => void }>} */
    this.subscribers = new Set();
    this.closed = false;
  }

  /**
   * @param {string} type
   * @param {Record<string, any>} data
   * @param {() => Date} [now]
   * @returns {StreamEnvelope}
   */
  publish(type, data, now = () => new Date()) {
    const envelope = { seq: (this.seq += 1), time: now().toISOString(), type, data };
    this.buffer.push(envelope);
    // A bounded buffer is a deliberate limit, not an oversight: an unbounded one
    // turns a long run plus a closed laptop into a memory leak with a user's
    // name on it. A client that fell further behind than this re-reads the run.
    if (this.buffer.length > REPLAY_BUFFER) this.buffer.splice(0, this.buffer.length - REPLAY_BUFFER);
    for (const subscriber of this.subscribers) {
      // isolated: evimed_run_stream_write_failures_total — one dead socket must
      // not stop the other tabs watching the same run.
      try {
        subscriber.write(formatEvent(envelope));
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    return envelope;
  }

  /**
   * @param {{ write: (chunk: string) => void, close: () => void }} subscriber
   * @param {number} since
   * @returns {() => void}
   */
  subscribe(subscriber, since = 0) {
    const missed = this.buffer.filter((envelope) => envelope.seq > since);
    // A client that asks for a sequence older than the buffer is told so
    // explicitly, so it can re-read rather than believe it caught up.
    if (since > 0 && missed.length && missed[0].seq > since + 1) {
      subscriber.write(formatEvent({ seq: missed[0].seq - 1, time: new Date().toISOString(), type: "stream/gap", data: { since, resumedAt: missed[0].seq } }));
    }
    for (const envelope of missed) subscriber.write(formatEvent(envelope));
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close() {
    this.closed = true;
    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {
        // A socket that is already gone needs no closing.
      }
    }
    this.subscribers.clear();
  }
}

/**
 * The registry of live run channels.
 */
export class RunEventHub {
  constructor() {
    /** @type {Map<string, RunEventChannel>} */
    this.channels = new Map();
  }

  /** @param {string} runId @returns {RunEventChannel} */
  channel(runId) {
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = new RunEventChannel(runId);
      this.channels.set(runId, channel);
    }
    return channel;
  }

  /** @param {string} runId @param {string} type @param {Record<string, any>} data @returns {StreamEnvelope} */
  publish(runId, type, data) {
    return this.channel(runId).publish(type, data);
  }

  /** @param {string} runId */
  close(runId) {
    const channel = this.channels.get(runId);
    if (!channel) return;
    channel.close();
    this.channels.delete(runId);
  }

  /** Every open channel, so a shutdown can end them rather than dropping sockets. */
  closeAll() {
    for (const runId of [...this.channels.keys()]) this.close(runId);
  }
}

/**
 * The event types this stream publishes (§18.4). The browser exhausts this set;
 * an unlisted type is a bug in the publisher, not in the client.
 */
export const RUN_STREAM_EVENT_TYPES = Object.freeze([
  "run/state",
  "run/event",
  "subagent/update",
  "deliverable/update",
  "evidence/update",
  "budget/update",
  "approval/requested",
  "question/requested",
  "stream/gap",
]);

/**
 * @param {StreamEnvelope} envelope
 * @returns {string}
 */
export function formatEvent(envelope) {
  // `id:` is what makes Last-Event-ID resumption work in the browser's own
  // EventSource without any client code.
  return `id: ${envelope.seq}\nevent: ${envelope.type}\ndata: ${JSON.stringify({ seq: envelope.seq, time: envelope.time, ...envelope.data })}\n\n`;
}

/**
 * Attaches one HTTP response to a run's channel.
 *
 * @param {{ setHeader: Function, write: Function, end: Function, on: Function, flushHeaders?: Function }} res
 * @param {RunEventChannel} channel
 * @param {{ since?: number, heartbeatMs?: number }} [options]
 * @returns {() => void}
 */
export function attachRunStream(res, channel, options = {}) {
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  // Buffering proxies turn a live stream into a batch delivered at the end.
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  res.write(": open\n\n");

  const subscriber = {
    write: (chunk) => res.write(chunk),
    close: () => res.end(),
  };
  const detach = channel.subscribe(subscriber, Number(options.since ?? 0) || 0);
  const heartbeat = setInterval(() => {
    // isolated: evimed_run_stream_heartbeat_failures_total
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  let done = false;
  function cleanup() {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    detach();
  }
  res.on("close", cleanup);
  res.on("error", cleanup);
  return cleanup;
}

/**
 * Parses the resume position a client asked for. `Last-Event-ID` is what a
 * browser's own `EventSource` sends on reconnect without any client code, and
 * `?since=` is what a client that manages its own connection uses.
 * @param {{ headers?: Record<string, any> }} req
 * @param {URL} url
 * @returns {number}
 */
export function resumePosition(req, url) {
  const header = Number(req?.headers?.["last-event-id"]);
  if (Number.isSafeInteger(header) && header >= 0) return header;
  const query = Number(url?.searchParams?.get("since"));
  return Number.isSafeInteger(query) && query >= 0 ? query : 0;
}
