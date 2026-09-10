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

import { DshRuntimeAdapter, decodeHostInteraction, sessionListItems } from "./dshRuntimeAdapter.mjs";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { DshMux } from "./dshMux.mjs";
import { readRuntimeResponseBody, requestRuntime } from "./runtimeManager.mjs";
import { HttpError } from "./security.mjs";

/** A `$events/result` acknowledgement is a fixed, tiny envelope; anything
 *  larger is not a reply this path should be reading into memory. */
const MAX_UNARY_REPLY_BYTES = 64 * 1024;

/** How long to wait before retrying a dropped or refused mux connection. */
export const RUNTIME_DOWNLINK_RECONNECT_MS = 2_000;
// How often the kernel is asked which sessions it holds. Fast enough that a
// person who starts a conversation in the browser application sees it in the
// ledger while they are still in it; slow enough to be one small call.
export const ADOPTION_SWEEP_MS = 15_000;

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
 * One unary kernel call over the same runtime the mux is dialled on.
 *
 * Deliberately not routed through `RuntimeManager.callKernel`: that method
 * belongs to the request/response side, which owns a runtime's lifecycle and
 * will wake a stopped container to serve a call. This path must not — it exists
 * to answer a question a *running* kernel asked, and waking a runtime to reply
 * to a question it can no longer be holding is worse than failing.
 *
 * @param {{ url: string, socketPath?: string|null, cookie?: string|null, authority?: string|null }} runtime
 * @param {string} method
 * @param {Record<string, any>} payload
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, value?: any, error?: any }>}
 */
export async function callRuntimeUnary(runtime, method, payload, options = {}) {
  const target = new URL(`${runtime.url}/api/${method}`);
  const body = Buffer.from(JSON.stringify({
    type: "client-request",
    rpcId: `pump-${randomBytes(6).toString("hex")}`,
    method,
    payload: { args: payload ?? {} },
  }), "utf8");
  const response = await requestRuntime(runtime, target, {
    method: "POST",
    headers: { ...(runtime.cookie ? { cookie: runtime.cookie } : {}), "content-type": "application/json" },
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {});
    return { ok: false, error: { code: "gateway/internal", message: `Kernel answered HTTP ${response.status} for ${method}.` } };
  }
  let parsed = null;
  try {
    parsed = JSON.parse((await readRuntimeResponseBody(response.body, MAX_UNARY_REPLY_BYTES)).toString("utf8"));
  } catch {
    // A body that is not JSON is not an outcome. Reported as a named failure
    // rather than parsed into `undefined`, which the adapter would map onto a
    // protocol mismatch and blame the wire for a proxy's error page.
    return { ok: false, error: { code: "gateway/internal", message: "Kernel reply was not JSON." } };
  }
  return parsed?.result ?? { ok: false, error: { code: "gateway/internal", message: "Kernel reply carried no result." } };
}

/**
 * @typedef {object} PumpProjectState
 * @property {{ userId: string, id: string }} project
 * @property {AbortController} controller
 * @property {Map<string, string>} rootSessions - kernel sessionId -> run id, for a run's own top-level session
 * @property {Map<string, { runId: string, label: string, capability: string }>} childSessions - kernel sessionId -> owning run, for a subagent's session
 * @property {Map<string, string>} childOwners - first run that owned a child session, retained until the runtime detaches
 * @property {Map<string, { summary: Record<string, any>, runId: string|null }>} childAnnouncements - live HOST announcements bound to the run active when they arrived
 * @property {Map<string, number>} sessionHeads - highest trusted event sequence observed for each followed session
 * @property {Map<string, AbortController>} follows - kernel sessionId -> the follow stream open for it
 * @property {(() => void) | null} resync - wakes the follow reconciler when the session maps change
 * @property {Map<string, { runId: string, kind: 'approval'|'question', adapter: DshRuntimeAdapter }>} pending - kernel eventId -> the question awaiting a person
 * @property {Set<string>} adopting - sessions whose adoption is in flight, so a burst announces one run and not several
 * @property {Map<string, number>} adoptionHeads - successfully scanned log heads
 * @property {Map<string, number>} rootTurnSeqs - current native turn's start sequence
 * @property {Map<string, number>} rootTurnEnds - last sequence belonging to the mapped native turn
 * @property {Map<string, { runId: string, baseline: number|null, requests: Set<string>, active: boolean, admitted: boolean, pending: import('@evimed/domain').RunEvent|null }>} rootInputs - ordinary dispatch and repair input ownership
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
   * @param {{ runEvents: import("./runEventStream.mjs").RunEventHub, isDshKernel: boolean, openMux?: typeof openRuntimeMux, callUnary?: typeof callRuntimeUnary, reconnectDelayMs?: number, adoptSession?: (project: any, sessionId: string) => Promise<any>, adoptIntervalMs?: number, onRunActivity?: (project: any, runId: string, activity: { sessionId: string, seq: number, stream?: {attemptId: string, index: number} }) => void, onCompaction?: (project: any, runId: string, record: { seq: number, replaced: number, tokens: number }) => void }} options
   */
  constructor({
    runEvents,
    isDshKernel,
    openMux = openRuntimeMux,
    callUnary = callRuntimeUnary,
    reconnectDelayMs = RUNTIME_DOWNLINK_RECONNECT_MS,
    // Called with a session the kernel announced that no run owns. Default is
    // to ignore it, which is what this pump did before the runtime's own
    // browser application could create one.
    adoptSession = async () => null,
    adoptIntervalMs = ADOPTION_SWEEP_MS,
    onRunActivity = () => {},
    // The kernel is the only thing that knows a compaction happened, and this
    // pump is the only thing that hears the kernel. Nothing recorded it before,
    // which is why the compaction policy has never been measurable: the control
    // plane declares a 1,000,000-token context window while a run's budget is
    // 400,000, so pressure compaction is unreachable inside the budget and
    // nobody could tell that from "it happens and we do not log it".
    onCompaction = () => {},
  }) {
    this.adoptSession = adoptSession;
    this.runEvents = runEvents;
    this.isDshKernel = isDshKernel;
    this.openMux = openMux;
    // Injected for the same reason `openMux` is: the reply to a kernel
    // question is a call, so "did not answer" is only observable in a test if
    // the call is. A decline that is dropped rather than sent looks exactly
    // like a question that was handled.
    this.callUnary = callUnary;
    this.reconnectDelayMs = reconnectDelayMs;
    this.adoptIntervalMs = adoptIntervalMs;
    this.onRunActivity = onRunActivity;
    this.onCompaction = onCompaction;
    /** @type {Map<string, PumpProjectState>} */
    this.projects = new Map();
    /** Adoptions still writing, so `closeAll` can wait for them. @type {Set<Promise<void>>} */
    this.inFlightAdoptions = new Set();
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
    // The downlink and `decodeMuxFrame` are DSH's wire shapes. A runtime that
    // publishes no such stream must not be dialled: the loop below retries
    // forever and silently, so the failure would never surface and no reader
    // would ever be served. The hosted server passes true — DSH is the only
    // kernel — and this stays a parameter so the refusal is testable without
    // standing up a runtime that lacks the stream.
    if (!this.isDshKernel) return;
    const key = this.#key(project);
    if (this.projects.has(key)) return;
    const controller = new AbortController();
    /** @type {PumpProjectState} */
    const state = { project, controller, rootSessions: new Map(), childSessions: new Map(), childOwners: new Map(), childAnnouncements: new Map(), sessionHeads: new Map(), follows: new Map(), resync: null, pending: new Map(), adopting: new Set(), adoptionHeads: new Map(), rootTurnSeqs: new Map(), rootTurnEnds: new Map(), rootInputs: new Map() };
    this.projects.set(key, state);
    // On the project's own lifetime, not the mux's: a reconnect must not reset
    // the sweep's clock, and the kernel is reachable for `session/list` whether
    // or not the stream happens to be up.
    this.#adoptUnownedSessions(state, runtime, controller.signal).catch(() => {});
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
  async closeAll() {
    for (const project of [...this.projects.keys()]) {
      const state = this.projects.get(project);
      state?.controller.abort();
      this.projects.delete(project);
    }
    // Aborting stops the streams; it does not stop an adoption already writing
    // to a project's ledger. Waiting is what makes "closed" mean the pump has
    // stopped touching the data directory.
    await Promise.allSettled([...this.inFlightAdoptions]);
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
   * @param {{ id: string, sessionId?: string, status: string, nativeTurn?: { startSeq: number }, baselineCursor?: string|null, kernelRequestIds?: string[] }} run
   */
  noteRun(project, run) {
    const state = this.projects.get(this.#key(project));
    if (!state || !run?.sessionId) return;
    if (run.status === "running") {
      const seq = run.nativeTurn?.startSeq;
      const previousSeq = state.rootTurnSeqs.get(run.sessionId);
      const sameRun = state.rootSessions.get(run.sessionId) === run.id;
      if (seq != null && seq < (previousSeq ?? -1) && !sameRun) return;
      // The ledger can rebase a stable request identity after a kernel log
      // migration. Its new sequence must replace the same run's old boundary,
      // including activity watermarks; unrelated older runs still lose above.
      if (sameRun && seq != null && previousSeq != null && seq !== previousSeq) {
        state.sessionHeads.delete(run.sessionId);
        for (const [sessionId, child] of state.childSessions) {
          if (child.runId === run.id) state.sessionHeads.delete(sessionId);
        }
      }
      if (seq == null) {
        state.rootTurnSeqs.delete(run.sessionId);
        state.rootTurnEnds.delete(run.sessionId);
        const requests = new Set(run.kernelRequestIds ?? []);
        const existing = state.rootInputs.get(run.sessionId);
        if (existing?.runId === run.id) existing.requests = requests;
        else {
          const match = typeof run.baselineCursor === "string" ? /^seq_(\d+)$/.exec(run.baselineCursor) : null;
          const baseline = run.baselineCursor === null ? -1 : match ? Number(match[1]) : null;
          state.rootInputs.set(run.sessionId, { runId: run.id, baseline, requests,
            active: requests.size === 0 && baseline === -1, admitted: false, pending: null,
          });
        }
      } else {
        state.rootInputs.delete(run.sessionId);
      }
      if (seq != null && seq !== state.rootTurnSeqs.get(run.sessionId)) state.rootTurnEnds.delete(run.sessionId);
      state.rootSessions.set(run.sessionId, run.id);
      if (seq != null) state.rootTurnSeqs.set(run.sessionId, seq);
    } else if (state.rootSessions.get(run.sessionId) === run.id) {
      state.rootSessions.delete(run.sessionId);
      state.sessionHeads.delete(run.sessionId);
      for (const [sessionId, child] of state.childSessions) {
        if (child.runId === run.id) {
          state.childSessions.delete(sessionId);
          state.sessionHeads.delete(sessionId);
        }
      }
      for (const [sessionId, announcement] of state.childAnnouncements) {
        if (announcement.runId === run.id) state.childAnnouncements.delete(sessionId);
      }
    }
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
        // The mux carries streams; a unary call is an ordinary HTTP POST to
        // the same runtime. This transport used to refuse `call` outright,
        // which was true while the pump only listened. It answers now — the
        // kernel asks questions on the host stream and waits for the reply on
        // this path — so refusing would have made every approval unanswerable
        // for a reason no message would have named.
        const transport = {
          call: (method, payload, options) => this.callUnary(runtime, method, payload, options),
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
            adapter
              .watchHost({
                signal: generation.signal,
                onEvent: (frame) => this.#handleHostFrame(state, adapter, frame),
              })
              .catch(() => {}),
            this.#followSessions(state, adapter, generation.signal),
          ]);
        } finally {
          signal.removeEventListener("abort", stopGeneration);
          generation.abort();
          for (const controller of state.follows.values()) controller.abort();
          state.follows.clear();
          // Every pending question belonged to the connection that just ended,
          // and the kernel drops its side with it. Keeping them would let a
          // later answer address an event id the kernel has forgotten, and the
          // browser would be told its click worked.
          for (const [eventId, entry] of state.pending) {
            this.runEvents.publish(entry.runId, `${entry.kind}/requested`, { eventId, status: "withdrawn", reason: "runtime_disconnected" });
          }
          state.pending.clear();
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
              for await (const { event, replay } of adapter.watchSession({ sessionId, signal: controller.signal })) {
                this.#handle(state, sessionId, event, { replay });
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
   * Handles one frame from the host stream.
   *
   * Only the two waterfall events reach a person; everything else on this
   * stream is an `emit` the adapter has already folded into running state.
   *
   * The rule that shapes this method: **a question we do not surface must be
   * declined, never dropped.** The kernel holds the tool call open until every
   * client it delivered to answers, so a frame this control plane cannot route
   * — an unknown event, a session belonging to no live run, a run that ended
   * while the model was still asking — stalls the run for as long as it is
   * ignored. Declining hands the decision back to the kernel's own default,
   * which fails closed to `unavailable` and lets the run continue and report
   * why. That is the difference between a refused action and a hung one.
   *
   * @param {PumpProjectState} state
   * @param {DshRuntimeAdapter} adapter
   * @param {Record<string, any>} frame
   */
  /**
   * Committed user turns, including follow-ups in existing sessions, scanned on a sweep.
   *
   * Not driven by an announcement. `api-session/added` was the obvious trigger
   * and the mock runtime emits it, so the tests went green -- but alpha.5
   * announces nothing when a session is created through the unary
   * `session/create` the browser application uses: the `$events` stream carries
   * one `ready` frame and then silence. Nothing was ever adopted in production.
   * Asking the kernel what it holds is what it actually supports.
   *
   * Blank sessions are left alone. Opening the application creates one before
   * the person has said anything, and a ledger entry for a conversation that
   * does not exist is noise shaped like work.
   *
   * Tied to the project's attachment rather than to a mux generation. It lived
   * inside the generation's `Promise.race` first, which meant every reconnect
   * -- and the mux reconnects on its own schedule -- aborted the signal the
   * sweep's timer was waiting on. The interval never elapsed, so in production
   * the sweep ran exactly never while its unit test, whose fake mux never
   * reconnects, passed.
   *
   * @param {PumpProjectState} state
   * @param {{ url: string, socketPath?: string|null, cookie?: string|null }} runtime
   * @param {AbortSignal} signal
   */
  async #adoptUnownedSessions(state, runtime, signal) {
    while (!signal.aborted) {
      await delay(this.adoptIntervalMs, signal);
      if (signal.aborted) return;
      const reply = await this.callUnary(runtime, "session/list", { _request: {} }, { signal }).catch(() => null);
      const sessions = sessionListItems(reply?.ok ? reply.value : null);
      for (const summary of sessions) {
        if (signal.aborted) return;
        if (summary && typeof summary === "object" && this.#considerChildSession(state, summary)) {
          continue;
        }
        if (summary && typeof summary === "object" && !summary.blank) {
          this.#adopt(state, String(summary.sessionId ?? ""), summary);
        }
      }
    }
  }

  /**
   * Binds a kernel-owned child session to the currently active root run.
   * The host's `api-session/added` summary is the live path; `session/list`
   * supplies the same ancestry on reconnect. A completed historical child is
   * never rebound merely because its session remains in the catalogue.
   * @param {PumpProjectState} state
   * @param {Record<string, any>} summary
   * @param {{ liveRunId?: string }} [options]
   * @returns {boolean} whether the summary describes a child session
   */
  #considerChildSession(state, summary, options = {}) {
    const sessionId = String(summary?.sessionId ?? summary?.id ?? "");
    const parentSessionId = String(summary?.parentSessionId ?? summary?.parentSession ?? summary?.header?.parentSession ?? "");
    const origin = String(summary?.origin ?? summary?.header?.origin ?? "");
    if (!parentSessionId && origin !== "subagent") return false;
    if (!sessionId || !parentSessionId) return true;
    const parentChild = state.childSessions.get(parentSessionId);
    const rootRunId = state.rootSessions.get(parentSessionId);
    const currentRunId = parentChild?.runId ?? rootRunId;
    const liveRunId = String(options.liveRunId ?? "");
    const firstOwner = state.childOwners.get(sessionId);
    // A catalogue is recovery, not authority. An unknown child in
    // `session/list` may belong to an earlier run on the same root session, so
    // only a live HOST announcement or a parent-session descriptor may create
    // its first ownership record.
    const runId = liveRunId || firstOwner || "";
    if (!runId || currentRunId !== runId) return true;
    if (!liveRunId && summary?.running === false) return true;
    if (firstOwner && firstOwner !== runId) return true;
    if (rootRunId) {
      const input = state.rootInputs.get(parentSessionId);
      if (input && !input.active) return true;
    }
    const existing = state.childSessions.get(sessionId);
    if (existing && existing.runId !== runId) return true;
    if (!firstOwner) state.childOwners.set(sessionId, runId);
    state.childSessions.set(sessionId, {
      runId,
      label: String(summary?.label ?? existing?.label ?? ""),
      capability: String(summary?.capability ?? existing?.capability ?? ""),
    });
    const head = Number(summary?.projections?.asOfSeq ?? summary?.asOfSeq ?? NaN);
    // The catalogue/opening summary describes history. It seeds replay
    // suppression once; only a later session/follow event is fresh activity.
    if (Number.isSafeInteger(head) && head >= 0 && !state.sessionHeads.has(sessionId)) state.sessionHeads.set(sessionId, head);
    state.resync?.();
    return true;
  }

  /** Replays live HOST announcements only into the run they named at arrival. */
  #activateChildAnnouncements(state, parentSessionId, runId) {
    for (const announcement of state.childAnnouncements.values()) {
      const parent = String(
        announcement.summary?.parentSessionId
        ?? announcement.summary?.parentSession
        ?? announcement.summary?.header?.parentSession
        ?? "",
      );
      if (parent === parentSessionId && announcement.runId === runId) {
        this.#considerChildSession(state, announcement.summary, { liveRunId: runId });
      }
    }
  }

  /**
   * Advances only on a new sequence from a session the pump already mapped to
   * this run. Opening snapshots and reconnect replays stop at the stored high
   * water mark and therefore cannot keep a stalled child alive.
   * @param {PumpProjectState} state @param {string} sessionId @param {string} runId @param {number} seq
   */
  #noteRunActivity(state, sessionId, runId, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= (state.sessionHeads.get(sessionId) ?? -1)) return;
    state.sessionHeads.set(sessionId, seq);
    this.onRunActivity(state.project, runId, { sessionId, seq });
  }

  /**
   * Scans a changed root session for user turns not yet owned by the ledger.
   *
   * Serialised per session so a sweep landing on the previous one cannot create
   * two runs for it, and failures are swallowed: an adoption that cannot be
   * written is not a reason to drop the mux everything else rides on.
   * @param {PumpProjectState} state @param {string} sessionId @param {any} summary
   */
  #adopt(state, sessionId, summary) {
    if (!sessionId) return;
    if (state.childSessions.has(sessionId)) return;
    // A minted session can later be opened in the native UI. Its committed
    // input's request identity, not who created the session, decides ownership.
    // A subagent's session is already owned by its parent's run; adopting it
    // would file the same work twice.
    if (summary?.parentSessionId || summary?.origin === "subagent") return;
    const head = summary?.projections?.asOfSeq;
    if (Number.isSafeInteger(head) && state.adoptionHeads.get(sessionId) === head) return;
    if (state.adopting.has(sessionId)) return;
    state.adopting.add(sessionId);
    // Tracked, not fired and forgotten. An adoption writes to the project's
    // ledger, and a pump that closed without waiting for it left a write
    // landing in a directory the caller had already started removing.
    const inFlight = Promise.resolve(this.adoptSession(state.project, sessionId))
      .then((run) => {
        if (state.controller.signal.aborted) return;
        if (Number.isSafeInteger(head)) state.adoptionHeads.set(sessionId, head);
        if (run?.id) this.noteRun(state.project, run);
      })
      .catch(() => {
        // isolated: evimed_runtime_session_adoption_failed_total
      })
      .finally(() => {
        state.adopting.delete(sessionId);
        this.inFlightAdoptions.delete(inFlight);
      });
    this.inFlightAdoptions.add(inFlight);
  }

  #handleHostFrame(state, adapter, frame) {
    if (frame?.type === "emit" && frame.event === "api-session/added") {
      const summary = Array.isArray(frame.args) && frame.args[0] && typeof frame.args[0] === "object" ? frame.args[0] : null;
      if (summary) {
        const sessionId = String(summary.sessionId ?? summary.id ?? "");
        const parentSessionId = String(summary.parentSessionId ?? summary.parentSession ?? summary.header?.parentSession ?? "");
        const origin = String(summary.origin ?? summary.header?.origin ?? "");
        if (!parentSessionId && origin !== "subagent") return;
        const parentChild = state.childSessions.get(parentSessionId);
        const rootRunId = state.rootSessions.get(parentSessionId);
        const runId = parentChild?.runId ?? rootRunId ?? null;
        let active = true;
        if (rootRunId) {
          const input = state.rootInputs.get(parentSessionId);
          if (input && !input.active) active = false;
        }
        if (sessionId) state.childAnnouncements.set(sessionId, { summary, runId });
        if (runId && active) this.#considerChildSession(state, summary, { liveRunId: runId });
      }
    }
    if (frame?.type === "emit" && frame.event === "api-session/status") {
      const [rawSessionId, running] = Array.isArray(frame.args) ? frame.args : [];
      const sessionId = String(rawSessionId ?? "");
      const announced = state.childAnnouncements.get(sessionId);
      if (running === true && announced?.runId) {
        announced.summary = { ...announced.summary, running: true };
        this.#considerChildSession(state, announced.summary, { liveRunId: announced.runId });
      }
    }
    if (frame?.type === "emit" && frame.event === "api-session/removed") {
      const sessionId = String(Array.isArray(frame.args) ? frame.args[0] ?? "" : "");
      const removed = state.childSessions.delete(sessionId);
      const forgotten = state.childOwners.delete(sessionId);
      state.childAnnouncements.delete(sessionId);
      if (removed || forgotten) {
        state.sessionHeads.delete(sessionId);
        state.resync?.();
      }
    }
    const decoded = decodeHostInteraction(frame);
    if (!decoded) {
      if (frame?.type === "waterfall" && frame?.eventId) this.#decline(adapter, String(frame.eventId));
      return;
    }
    if (decoded.kind === "withdrawn") {
      const entry = state.pending.get(decoded.eventId);
      if (!entry) return;
      state.pending.delete(decoded.eventId);
      // The kernel gave up on its own — timed out, cancelled, or the agent's
      // context was released. The browser has a prompt on screen for a
      // decision that can no longer be delivered, so it is told, rather than
      // left with a button that will fail when pressed.
      this.runEvents.publish(entry.runId, `${entry.kind}/requested`, { eventId: decoded.eventId, status: "withdrawn", reason: "kernel_cancelled" });
      return;
    }
    const runId = state.rootSessions.get(decoded.sessionId) ?? state.childSessions.get(decoded.sessionId)?.runId;
    if (!runId) {
      // isolated: evimed_runtime_interaction_unrouted_total
      this.#decline(adapter, decoded.eventId);
      return;
    }
    state.pending.set(decoded.eventId, { runId, kind: decoded.kind, adapter });
    this.runEvents.publish(runId, `${decoded.kind}/requested`, {
      eventId: decoded.eventId,
      status: "pending",
      sessionId: decoded.sessionId,
      request: decoded.request,
    });
  }

  /**
   * Hands one question back to the kernel unanswered.
   * @param {DshRuntimeAdapter} adapter
   * @param {string} eventId
   */
  #decline(adapter, eventId) {
    adapter.answerHostEvent({ eventId, outcome: { kind: "next" } }).catch(() => {
      // isolated: evimed_runtime_interaction_decline_failures_total — the
      // reply races the connection that carried the question, and a decline
      // that arrives after the mux dropped is refused by a gateway that has
      // already forgotten the event. Nothing is owed to the caller here.
    });
  }

  /**
   * Delivers a person's answer to the kernel question it belongs to.
   *
   * Routed through the pump rather than straight to an adapter because the
   * pump is what holds the pairing: which connection delivered this event,
   * which run it belongs to, and whether it is still open. A route that
   * called the adapter directly would answer on whatever connection happened
   * to be current, which after a reconnect is a different one.
   *
   * @param {{ userId: string, id: string }} project
   * @param {{ runId: string, eventId: string, outcome: { kind: 'result', value?: unknown } | { kind: 'next' } | { kind: 'rejected', error: unknown } }} input
   * @returns {Promise<void>}
   */
  async answerInteraction(project, { runId, eventId, outcome }) {
    const state = this.projects.get(this.#key(project));
    const entry = state?.pending.get(String(eventId));
    if (!state || !entry) {
      throw new HttpError(404, "interaction_not_pending", "That question is no longer waiting for an answer.");
    }
    if (entry.runId !== String(runId)) {
      // The event id is the kernel's, not ours, so a caller could name a real
      // pending question that belongs to someone else's run. Checked here
      // because the route can only prove the run, not the question.
      throw new HttpError(404, "interaction_not_pending", "That question does not belong to this run.");
    }
    await entry.adapter.answerHostEvent({ eventId: String(eventId), outcome });
    state.pending.delete(String(eventId));
    this.runEvents.publish(entry.runId, `${entry.kind}/requested`, { eventId: String(eventId), status: "answered" });
  }

  /**
   * @param {PumpProjectState} state
   * @param {string} sessionId
   * @param {import('@evimed/domain').RunEvent} event
   * @param {{ replay?: boolean }} [options]
   */
  #handle(state, sessionId, event, options = {}) {
    const input = state.rootInputs.get(sessionId);
    if (input && !state.childSessions.has(sessionId)) {
      if (input.baseline != null && event.seq <= input.baseline) return;
      if (event.type === "turn/start") {
        input.pending = event;
        input.active = false;
        // A pre-request-id ledger can safely follow its first new turn after
        // a numeric baseline. Unknown legacy cursors cannot identify a turn.
        if (!input.requests.size && input.baseline != null && !input.admitted) {
          input.active = true;
          input.admitted = true;
          input.pending = null;
          this.#activateChildAnnouncements(state, sessionId, input.runId);
        }
      }
      if (event.type === "message/user" && event.source === "user" && input.requests.has(event.sourceRequestId)) {
        input.active = true;
        this.#activateChildAnnouncements(state, sessionId, input.runId);
        if (input.pending) this.runEvents.publish(input.runId, "run/event", { event: input.pending });
        input.pending = null;
      }
      if (!input.active) return;
      if (event.type === "turn/end") input.active = false;
    }
    const start = state.rootTurnSeqs.get(sessionId);
    if (start != null && !state.childSessions.has(sessionId)) {
      if (event.type === "turn/start" && event.seq > start) state.rootTurnEnds.set(sessionId, event.seq - 1);
      if (event.seq < start || event.seq > (state.rootTurnEnds.get(sessionId) ?? Infinity)) return;
      if (event.type === "turn/end") state.rootTurnEnds.set(sessionId, event.seq);
    }
    const runId = state.rootSessions.get(sessionId) ?? state.childSessions.get(sessionId)?.runId;
    if (event.type === "subagent/started" && runId) {
      // Registered under the parent's run, one hop at a time: a
      // grandchild's own `subagent/started` arrives on the child's session,
      // which by then is already in this map, so nesting resolves without
      // the ledger ever having to enumerate it.
      const firstOwner = state.childOwners.get(event.childSessionId);
      if (!firstOwner || firstOwner === runId) {
        state.childOwners.set(event.childSessionId, runId);
        state.childSessions.set(event.childSessionId, { runId, label: event.label, capability: event.capability });
        state.resync?.();
      }
    }
    if (!runId) return; // isolated: evimed_runtime_event_pump_unrouted_total
    if (!options.replay) {
      if (event.type === "assistant/delta" && event.stream) {
        // A stream index is not a durable log sequence. Keep the anchor and
        // attempt identity separate; reconnect baselines never reach this path.
        this.onRunActivity(state.project, runId, { sessionId, seq: event.seq, stream: event.stream });
      } else this.#noteRunActivity(state, sessionId, runId, event.seq);
    }
    this.runEvents.publish(runId, "run/event", { event });
    if (event.type === "compaction" && !options.replay) {
      try {
        this.onCompaction(state.project, runId, { seq: event.seq, replaced: event.replaced, tokens: event.estimatedTokens });
      } catch {
        // isolated: evimed_runtime_event_pump_compaction_record_failed_total
      }
    }
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
