/**
 * The live wire from a project's kernel to the browser's SSE stream.
 *
 * Hidden knowledge: nothing in this control plane used to open the kernel's
 * downlink. `DshRuntimeAdapter` decoded it and was tested against a scripted
 * transport, but no production code ever constructed a real one — so
 * `run/event`, and everything a browser reads that only rides `run/event`
 * (the live transcript, tool calls, subagent starts), had no publisher.
 * `run/state` alone kept working because it is published from the ledger's own
 * state machine, not from the kernel's stream.
 *
 * DSH 0.1.2 changed the shape of that wire. There is no all-sessions stream
 * any more: one WebSocket carries independently cancellable logical streams,
 * and a session's events arrive on the stream opened for that session. So this
 * pump now owns a pairing it never had to hold before — which session each
 * open stream belongs to — and opening one is a decision rather than a
 * subscription. It follows exactly the sessions the ledger says are running,
 * plus the subagent sessions those runs spawn.
 *
 * A dropped mux reconnects rather than failing the run: `session/prompt` and
 * `session/page` are unary calls this pump never touches, so a run keeps
 * working from the request/response side even while this side is between
 * connections. What is lost during a gap is made whole again by the transcript
 * endpoint any (re)connecting tab reads first — this pump is the addition for
 * a tab that is already open, never the source of truth.
 *
 * @module dshEventPump
 */

import { DshRuntimeAdapter } from "./dshRuntimeAdapter.mjs";
import { DshMux } from "./dshMux.mjs";

/** How long to wait before retrying a dropped or refused mux connection. */
export const RUNTIME_DOWNLINK_RECONNECT_MS = 2_000;

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Opens one multiplexed connection to a runtime's kernel.
 *
 * Separate from the pump so a test can hand in a scripted mux, and so the one
 * place that knows how to dial a kernel stays one place.
 *
 * @param {{ url: string, socketPath?: string|null, cookie?: string|null, authority?: string|null }} runtime
 * @param {{ signal: AbortSignal }} options
 * @returns {Promise<DshMux>}
 */
export async function openRuntimeMux(runtime, { signal }) {
  const mux = new DshMux(runtime);
  await mux.connect({ signal });
  return mux;
}

/**
 * @typedef {object} PumpProjectState
 * @property {AbortController} controller
 * @property {Map<string, string>} rootSessions - kernel sessionId -> run id, for a run's own top-level session
 * @property {Map<string, { runId: string, label: string, capability: string }>} childSessions - kernel sessionId -> owning run, for a subagent's session
 * @property {Map<string, AbortController>} follows - kernel sessionId -> the follow stream open for it
 * @property {(() => void) | null} resync - wakes the follow reconciler when the session maps change
 */

/**
 * Subscribes to each attached project's kernel downlink and republishes what
 * it decodes onto that run's SSE channel.
 *
 * One instance is shared across every project a server process serves, the
 * same way `RunEventHub` is: `attach`/`detach` mirror a runtime's own start
 * and stop, and `noteRun` mirrors the ledger's own state-change notification
 * — this class adds no lifecycle a caller does not already have a hook for.
 */
export class RuntimeEventPump {
  /**
   * @param {{ runEvents: import("./runEventStream.mjs").RunEventHub, isDshKernel: boolean, openMux?: typeof openRuntimeMux, reconnectDelayMs?: number }} options
   */
  constructor({ runEvents, isDshKernel, openMux = openRuntimeMux, reconnectDelayMs = RUNTIME_DOWNLINK_RECONNECT_MS }) {
    this.runEvents = runEvents;
    this.isDshKernel = isDshKernel;
    this.openMux = openMux;
    this.reconnectDelayMs = reconnectDelayMs;
    /** @type {Map<string, PumpProjectState>} */
    this.projects = new Map();
  }

  /** @param {{ userId: string, id: string }} project @returns {string} */
  #key(project) {
    return `${project.userId}:${project.id}`;
  }

  /**
   * Starts watching a project's runtime, once. A second attach for a project
   * already attached is a no-op — the runtime that is up is the runtime this
   * pump is already reading.
   * @param {{ userId: string, id: string }} project
   * @param {{ url: string, socketPath?: string|null, password?: string|null }} runtime
   */
  attach(project, runtime) {
    // The downlink and `decodeMuxFrame` are DSH's wire shapes; the OpenCode
    // kernel this build can still select publishes no such stream, and
    // dialing it would just be a permanent, silently-retrying connection
    // failure for no reader.
    if (!this.isDshKernel) return;
    const key = this.#key(project);
    if (this.projects.has(key)) return;
    const controller = new AbortController();
    /** @type {PumpProjectState} */
    const state = { controller, rootSessions: new Map(), childSessions: new Map(), follows: new Map(), resync: null };
    this.projects.set(key, state);
    this.#run(project, runtime, state, controller.signal).catch(() => {
      // isolated: evimed_runtime_event_pump_fatal_total — the loop below
      // isolates every reconnect attempt already; reaching here at all means
      // it exited some other way, and neither the run's own state stream nor
      // its request/response calls depend on this pump.
    });
  }

  /**
   * Stops watching every project.
   *
   * Needed because this pump now holds a real socket per attached project. It
   * did not before: `watchSessions` was decoded and unit-tested, but no
   * production code ever opened a downlink, so there was nothing to leak and
   * nothing to close. The first thing that changed when this pump got a
   * transport was that a test process stopped exiting — every assertion
   * passed and the runner then sat on an open mux until it was killed, which
   * reads as "the suite hangs" and says nothing about a socket.
   */
  closeAll() {
    for (const project of [...this.projects.keys()]) {
      const state = this.projects.get(project);
      state?.controller.abort();
      this.projects.delete(project);
    }
  }

  /** Stops watching a project's runtime and forgets its session map. @param {{ userId: string, id: string }} project */
  detach(project) {
    const key = this.#key(project);
    const state = this.projects.get(key);
    if (!state) return;
    state.controller.abort();
    this.projects.delete(key);
  }

  /**
   * Keeps a project's session map current. Called from the same hook that
   * already publishes `run/state` on every run transition, so a fresh run's
   * session becomes routable the moment the ledger knows it, and a finished
   * run's stops being routed rather than silently accepting a kernel session
   * id a later, unrelated run might reuse.
   * @param {{ userId: string, id: string }} project
   * @param {{ id: string, sessionId?: string, status: string }} run
   */
  noteRun(project, run) {
    const state = this.projects.get(this.#key(project));
    if (!state || !run?.sessionId) return;
    if (run.status === "running") state.rootSessions.set(run.sessionId, run.id);
    else state.rootSessions.delete(run.sessionId);
    // A session added to the map is not followed until something opens a
    // stream for it. Before 0.1.2 the map was only a routing table over one
    // stream that already carried every session; now it decides what is
    // listened to at all, so every edit has to reach the reconciler.
    state.resync?.();
  }

  /**
   * @param {{ userId: string, id: string }} project
   * @param {{ url: string, socketPath?: string|null, password?: string|null }} runtime
   * @param {PumpProjectState} state
   * @param {AbortSignal} signal
   */
  async #run(project, runtime, state, signal) {
    while (!signal.aborted) {
      /** @type {DshMux | null} */
      let mux = null;
      try {
        mux = await this.openMux(runtime, { signal });
        const transport = {
          async call() {
            throw new Error("dshEventPump's transport does not support unary calls.");
          },
          stream: (endpoint, args, options) => /** @type {DshMux} */ (mux).open(endpoint, args, options),
        };
        const adapter = new DshRuntimeAdapter(transport);
        const generation = new AbortController();
        const stopGeneration = () => generation.abort();
        signal.addEventListener("abort", stopGeneration, { once: true });
        try {
          // The host stream and the per-session follows share one socket and
          // one generation: if the socket dies, both end, and the outer loop
          // rebuilds the whole set rather than leaving half of it attached to
          // a connection that is gone.
          await Promise.race([
            adapter.watchHost({ signal: generation.signal }).catch(() => {}),
            this.#followSessions(state, adapter, generation.signal),
          ]);
        } finally {
          signal.removeEventListener("abort", stopGeneration);
          generation.abort();
          for (const controller of state.follows.values()) controller.abort();
          state.follows.clear();
        }
        if (signal.aborted) return;
      } catch {
        // isolated: evimed_runtime_event_pump_reconnect_total — a dropped mux
        // reconnects; it never fails the run, which does not read through this
        // pump for anything the request/response path needs.
      } finally {
        mux?.close();
      }
      await delay(this.reconnectDelayMs, signal);
    }
  }

  /**
   * Keeps one follow stream open per session this project cares about, for as
   * long as the mux generation lasts.
   *
   * Reconciled rather than opened once: a run's session appears when the
   * ledger notes it and a subagent's appears mid-run, so the set this pump
   * must listen to is not knowable when the connection is made. It resolves
   * only when the generation ends, which is what makes it a peer of
   * `watchHost` in the race above.
   *
   * @param {PumpProjectState} state
   * @param {DshRuntimeAdapter} adapter
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async #followSessions(state, adapter, signal) {
    await new Promise((resolve) => {
      const reconcile = () => {
        if (signal.aborted) return;
        const wanted = new Set([...state.rootSessions.keys(), ...state.childSessions.keys()]);
        for (const sessionId of wanted) {
          if (state.follows.has(sessionId)) continue;
          const controller = new AbortController();
          state.follows.set(sessionId, controller);
          const stop = () => controller.abort();
          signal.addEventListener("abort", stop, { once: true });
          (async () => {
            try {
              for await (const { event } of adapter.watchSession({ sessionId, signal: controller.signal })) {
                this.#handle(state, sessionId, event);
              }
            } catch {
              // isolated: evimed_runtime_session_follow_failures_total — one
              // session's stream ending must not take the others with it; the
              // mux itself dying is what ends the generation.
            } finally {
              signal.removeEventListener("abort", stop);
              // Deleted only if this controller is still the registered one,
              // so a reconnect that already replaced it is not undone here.
              if (state.follows.get(sessionId) === controller) state.follows.delete(sessionId);
            }
          })();
        }
        for (const [sessionId, controller] of state.follows) {
          if (!wanted.has(sessionId)) {
            controller.abort();
            state.follows.delete(sessionId);
          }
        }
      };
      state.resync = reconcile;
      signal.addEventListener("abort", () => {
        state.resync = null;
        resolve(undefined);
      }, { once: true });
      reconcile();
    });
  }

  /**
   * @param {PumpProjectState} state
   * @param {string} sessionId
   * @param {import('@evimed/domain').RunEvent} event
   */
  #handle(state, sessionId, event) {
    const runId = state.rootSessions.get(sessionId) ?? state.childSessions.get(sessionId)?.runId;
    if (event.type === "subagent/started" && runId) {
      // Registered under the parent's run, one hop at a time: a
      // grandchild's own `subagent/started` arrives on the child's session,
      // which by then is already in this map, so nesting resolves without
      // the ledger ever having to enumerate it.
      state.childSessions.set(event.childSessionId, { runId, label: event.label, capability: event.capability });
      state.resync?.();
    }
    if (!runId) return; // isolated: evimed_runtime_event_pump_unrouted_total
    this.runEvents.publish(runId, "run/event", { event });
    if (event.type === "turn/end") {
      // The one lifecycle fact the mux stream carries that `run/event` alone
      // does not surface as a status: nothing else marks a subagent's own
      // session as finished, running or otherwise.
      const child = state.childSessions.get(sessionId);
      if (child) {
        this.runEvents.publish(runId, "subagent/update", {
          childSessionId: sessionId,
          label: child.label,
          capability: child.capability,
          status: event.endKind,
        });
      }
    }
  }
}
