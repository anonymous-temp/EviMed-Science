/**
 * The control plane's adapter to the agent kernel.
 *
 * Hidden knowledge: everything about the wire protocol between the control
 * plane and a project's runtime container, and the translation from the
 * kernel's vocabulary into ours.
 *
 * Two rules shape it.
 *
 * First, **the ledger must not learn the kernel's vocabulary**. It used to read
 * OpenCode's shapes directly — `message.info.role`, `parts[].state.status` —
 * which put the kernel inside the delivery decision. Everything here normalizes
 * into `@evimed/domain`'s `RunTranscript` and `RunEvent`, and the ledger, the
 * gate and the browser read only those.
 *
 * Second, **method names matching does not mean frame shapes match**. The wire
 * protocol carries no version field and its own documentation says client and
 * host ship together. So the allow-list is derived from the seam manifest, and
 * the normalizers are the assertion targets of golden frames recorded per
 * pinned version — the only check that can catch a reshaped frame.
 *
 * @module dshRuntimeAdapter
 */

import {
  EMPTY_TRANSCRIPT,
  narrateToolCall,
  normalizeTurnEndKind,
  turnEndErrorCode,
} from "@evimed/domain";
import { SEAMS, toArgs, toTurnEnd, toUsage } from "@evimed/harness-port";

import { HttpError } from "./security.mjs";

/**
 * Methods the control plane may call. Derived, never restated (§5.5).
 *
 * The gateway's own pseudo-endpoints are listed separately in the manifest and
 * folded in here, because they are not service methods: the gateway claims
 * `$events/result` before any method lookup, so it obeys neither the
 * `namespace/method` grammar nor the `unaryArgs` contract that describes a
 * typert call. Putting it among the service methods would have meant relaxing
 * the grammar check that proves 0.1.2 renamed every method from dotted to
 * slashed — losing a real guarantee to accommodate one endpoint that was never
 * of that kind.
 */
export const ALLOWED_WIRE_METHODS = Object.freeze(
  new Set([...SEAMS.wire.unary, ...Object.values(SEAMS.wire.gatewayEndpoints)]),
);

/** Methods explicitly refused, so a new one cannot arrive by being unlisted. */
export const DENIED_WIRE_METHODS = Object.freeze(new Set(SEAMS.wire.denied));

/**
 * Decodes one non-`emit` host frame into the interaction it represents.
 *
 * Pure, and separate from the pump, because this is the shape a golden frame
 * can pin. Recorded live from 0.1.2-alpha.3 by driving a run into a sandbox
 * escalation:
 *
 *   { type: "waterfall", event: "approval/request",
 *     eventId: "ba9a5930-…", agentId: "session-acbc4383-…",
 *     request: { toolName: "bash", callId: "call_…",
 *                reason: "escalate sandbox to danger-full-access: …" } }
 *
 * `agentId` is the **session id**, not an opaque agent handle — that is what
 * makes a question routable to the run that asked it, and it is the single
 * fact a reader is most likely to get wrong from the field's name.
 *
 * @param {Record<string, any>} frame
 * @returns {{ kind: 'approval'|'question', eventId: string, sessionId: string, request: Record<string, any> }
 *          | { kind: 'withdrawn', eventId: string }
 *          | null}
 */
export function decodeHostInteraction(frame) {
  if (frame?.type === "cancel") {
    const eventId = String(frame.eventId ?? "");
    return eventId ? { kind: "withdrawn", eventId } : null;
  }
  if (frame?.type !== "waterfall") return null;
  const events = SEAMS.wire.hostInteractionEvents;
  const kind = Object.keys(events).find((name) => events[name] === frame.event);
  // An unlisted waterfall is not decoded into a guess. The caller declines it,
  // which is the only answer that neither invents a decision nor leaves the
  // kernel holding a tool call open.
  if (!kind) return null;
  const eventId = String(frame.eventId ?? "");
  const sessionId = String(frame.agentId ?? "");
  if (!eventId) return null;
  return {
    kind: /** @type {'approval'|'question'} */ (kind),
    eventId,
    sessionId,
    request: frame.request && typeof frame.request === "object" ? frame.request : {},
  };
}

/**
 * @param {string} method
 * @returns {boolean}
 */
export function isAllowedWireMethod(method) {
  return ALLOWED_WIRE_METHODS.has(String(method));
}

/**
 * The kernel's own error codes, mapped to ours. A code we do not know lands on
 * a named unknown rather than on a generic failure, so a protocol change is
 * visible in metrics instead of being folded into "the runtime is unhappy".
 */
const WIRE_ERROR_CODES = Object.freeze({
  // 0.1.2 namespaced every code: `session-not-found` became `session/not-found`
  // and the transport-level ones moved under `gateway/`. Each name below was
  // confirmed to exist in the 0.1.2 sources; a stale bare code would not error,
  // it would fold every kernel failure into the unknown branch and report a
  // protocol mismatch for a session that simply does not exist.
  //
  // A session the kernel has never heard of has produced nothing, which is a
  // different fact from "the session failed" and callers act on it differently:
  // reading the history of a not-yet-started run is normal, and folding it into
  // a generic session error made a run that had simply not begun look broken.
  "session/not-found": "runtime_session_not_found",
  "session/conflict": "runtime_session_error",
  "session/disposed": "runtime_session_error",
  "session/agent-busy": "runtime_session_error",
  "session/model-unavailable": "runtime_session_error",
  "session/fork-unavailable": "runtime_session_error",
  "agent-preset/not-found": "runtime_preset_unavailable",
  "agent-preset/invalid": "runtime_preset_unavailable",
  "agent-preset/locked": "runtime_preset_unavailable",
  "agent-preset/conflict": "runtime_preset_unavailable",
  "workspace/not-found": "runtime_session_error",
  // Transport-level refusals. `arguments-invalid`, `input-invalid` and
  // `signature-invalid` all mean this control plane sent something the wire
  // does not accept — a protocol mismatch on our side, which is exactly what
  // that code is for and what it should keep saying out loud.
  "gateway/bad-request": "runtime_wire_protocol_mismatch",
  "gateway/arguments-invalid": "runtime_wire_protocol_mismatch",
  "gateway/input-invalid": "runtime_wire_protocol_mismatch",
  "gateway/signature-invalid": "runtime_wire_protocol_mismatch",
  "gateway/cancelled": "runtime_canceled",
  "gateway/internal": "runtime_session_error",
});

/**
 * @param {{ code?: string, message?: string }} error
 * @returns {{ code: string, message: string }}
 */
export function mapWireError(error) {
  const code = String(error?.code ?? "");
  const mapped = WIRE_ERROR_CODES[/** @type {keyof typeof WIRE_ERROR_CODES} */ (code)];
  if (mapped) return { code: mapped, message: String(error?.message ?? code) };
  return { code: "runtime_wire_protocol_mismatch", message: `unknown kernel error "${code}": ${error?.message ?? ""}` };
}

/**
 * One call into a container's kernel.
 *
 * @typedef {object} WireTransport
 * @property {(method: string, payload: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{ ok: boolean, value?: any, error?: any }>} call
 * @property {(endpoint: string, args: Record<string, unknown>, options: { signal: AbortSignal }) => AsyncIterable<Record<string, any>>} stream
 */

export class DshRuntimeAdapter {
  /**
   * @param {WireTransport} transport
   * @param {{ agentPreset?: string, idGenerator?: () => string }} [options]
   */
  constructor(transport, options = {}) {
    this.transport = transport;
    // There is one composition and adding a second is a design change, not a
    // configuration change (§9.2). It is a constructor default rather than a
    // config field for exactly that reason.
    this.agentPreset = options.agentPreset ?? "evimed-universal";
    this.newId = options.idGenerator ?? (() => `rpc_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  }

  /**
   * @param {string} method @param {Record<string, unknown>} payload @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<any>}
   */
  async call(method, payload, options = {}) {
    if (!isAllowedWireMethod(method)) {
      // Refusing here as well as at the proxy is deliberate: the proxy protects
      // the browser, and this protects the control plane from itself.
      throw new HttpError(403, "runtime_method_forbidden", `Kernel method ${method} is not on the allow-list.`);
    }
    const result = await this.transport.call(method, payload, options);
    if (result?.ok) return result.value;
    const mapped = mapWireError(result?.error ?? {});
    throw new HttpError(502, mapped.code, mapped.message);
  }

  /**
   * Proves the kernel's `/api` surface is mounted and this control plane is
   * authenticated to it.
   *
   * 0.1.2 removed `host.describe` with the rest of ApiProxy, so there is no
   * "describe the host" call left to probe with. `session/list` is the right
   * replacement rather than the nearest one: it is a real wire call, so it
   * answers the question a readiness probe actually has — is the protocol up —
   * and because 0.1.2 authenticates on loopback it also proves the cookie. A
   * probe that only checked for a listening port would pass against a kernel
   * that will refuse every subsequent call as unauthenticated.
   *
   * Host facts themselves now arrive once, in the `$events` stream's opening
   * `ready` frame; nothing here needs them.
   *
   * @param {{ signal?: AbortSignal }} [options] @returns {Promise<Record<string, any>>}
   */
  async describe(options = {}) {
    const value = await this.call("session/list", { _request: {} }, options);
    return { sessions: Array.isArray(value?.items) ? value.items.length : 0 };
  }

  /**
   * Every session the kernel holds, with the head sequence and running flag it
   * publishes for each.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  async listSessions(options = {}) {
    const value = await this.call("session/list", { _request: {} }, options);
    return Array.isArray(value?.items) ? value.items : [];
  }

  /**
   * @param {{ cwd: string, sessionId?: string, signal?: AbortSignal }} input
   * @returns {Promise<{ sessionId: string, agentPreset: string }>}
   */
  async createSession({ cwd, sessionId, signal }) {
    const value = await this.call(
      "session/create",
      { request: { cwd, agentPreset: this.agentPreset, ...(sessionId ? { sessionId } : {}) } },
      { signal },
    );
    return { sessionId: String(value?.sessionId ?? ""), agentPreset: String(value?.agentPreset ?? this.agentPreset) };
  }

  /**
   * Sends a prompt.
   *
   * There is no `system` parameter on this protocol, which is the one gap the
   * migration had to close: the research context used to travel as `system` on
   * every dispatch. It now reaches the run as a workspace file the socket reads
   * and injects at session start, so it is model-visible *and* logged — the
   * invariant a side channel would have broken.
   *
   * @param {{ sessionId: string, text: string, mode?: 'queue'|'steer', signal?: AbortSignal }} input
   * @returns {Promise<{ accepted: boolean }>}
   */
  async prompt({ sessionId, text, mode = "queue", signal }) {
    // `requestId` is required by 0.1.2 and is the client's own identity for
    // this submission: the kernel echoes it on the queued message so a client
    // can retire its local echo. Minted here rather than defaulted by the
    // kernel, because two dispatches sharing one id would be indistinguishable
    // in the queue.
    const value = await this.call(
      "session/prompt",
      { request: { requestId: this.newId(), sessionId, mode, content: [{ type: "text", text }] } },
      { signal },
    );
    return { accepted: Boolean(value?.accepted) };
  }

  /** @param {{ sessionId: string, signal?: AbortSignal }} input @returns {Promise<void>} */
  async cancel({ sessionId, signal }) {
    await this.call("session/cancel", { request: { sessionId } }, { signal });
  }

  /** @param {{ sessionId: string, atSeq?: number, signal?: AbortSignal }} input @returns {Promise<{ sessionId: string }>} */
  async fork({ sessionId, atSeq, signal }) {
    const value = await this.call("session/fork", { request: { sessionId, ...(atSeq == null ? {} : { atSeq }) } }, { signal });
    return { sessionId: String(value?.sessionId ?? "") };
  }

  /**
   * Reads the whole transcript the gate must grade.
   *
   * Paging is followed to the beginning rather than taking the tail page: the
   * gate's question-by-question check reads the entire run, and a truncated
   * transcript would silently mark the earliest work as never done.
   *
   * @param {{ sessionId: string, maxMessages?: number, maxPages?: number, signal?: AbortSignal }} input
   * @returns {Promise<import('@evimed/domain').RunTranscript>}
   */
  async transcript({ sessionId, maxMessages = 200, maxPages = 50, signal }) {
    // Pages joined with `flat()`, never spread into `unshift`. A page carries
    // every assistant/chunk delta between its messages, and a real run produced
    // one of 130k events; spreading passes each element as a call argument, so
    // `entries.unshift(...pageEntries)` threw `Maximum call stack size
    // exceeded`. The control plane's copy of this loop hit it first and left a
    // finished run reading `running` for an hour, one identical log line per
    // poll.
    // 0.1.2 requires the caller to name the sequence it is reading through, and
    // a number past the end returns nothing rather than the tail — asking for
    // "everything" with a large constant reads as an empty run, which is the
    // failure this whole file exists to make impossible. The head sequence is
    // published per session by `session/list` as `projections.asOfSeq`.
    const head = (await this.listSessions({ signal })).find((item) => String(item?.sessionId) === String(sessionId));
    const throughSeq = Number(head?.projections?.asOfSeq ?? NaN);
    if (!Number.isFinite(throughSeq)) {
      // Not an empty transcript: the kernel does not know this session, which
      // is a different fact and one the gate must not grade as "produced
      // nothing".
      throw new HttpError(502, "runtime_session_not_found", `The kernel published no head sequence for session ${sessionId}.`);
    }
    /** @type {Record<string, any>[][]} */
    const pages = [];
    /** @type {number | undefined} */
    let beforeSeq;
    for (let page = 0; page < maxPages; page += 1) {
      const value = await this.call(
        "session/page",
        { request: { address: { kind: "session", sessionId }, throughSeq, maxMessages, ...(beforeSeq == null ? {} : { beforeSeq }) } },
        { signal },
      );
      const pageEntries = Array.isArray(value?.records) ? value.records : [];
      pages.unshift(pageEntries);
      if (!value?.hasMore || !pageEntries.length) break;
      const firstSeq = Number(pageEntries[0]?.event?.seq ?? NaN);
      if (!Number.isFinite(firstSeq)) break;
      beforeSeq = firstSeq;
    }
    return normalizeTranscript(sessionId, pages.flat());
  }

  /** @param {{ sessionId: string, signal?: AbortSignal }} input @returns {Promise<Record<string, any>[]>} */
  async subagents({ sessionId, signal }) {
    const value = await this.call("subagents/list", { parentSessionId: sessionId }, { signal });
    return Array.isArray(value?.items) ? value.items : [];
  }

  /**
   * The kernel publishes no `session.status` method; running state arrives on
   * the host event stream instead. A caller that wants a synchronous answer
   * gets it from the last frame this adapter saw, and "we have not been told"
   * is a distinct answer from "idle" — treating them the same is what made a
   * dead run look like a working one.
   * @param {string} sessionId
   * @returns {'busy'|'idle'|'unknown'}
   */
  runningStatus(sessionId) {
    const known = this.runningBySession?.get(String(sessionId));
    if (known === undefined) return "unknown";
    return known ? "busy" : "idle";
  }

  /**
   * Answers one question the kernel asked on the host stream.
   *
   * The reply is an ordinary RPC (`$events/result`) rather than a frame back
   * up the stream, and the gateway validates it with exact-key equality: an
   * outcome carrying one field more than its kind allows is refused as
   * "invalid Remote event result", not ignored. All four shapes below were
   * probed against a running 0.1.2-alpha.3 kernel, including the refusals —
   * the frame this replaces in our fixtures was hand-written and named an
   * event (`tools/pre-execute`) the kernel never sends.
   *
   * `next` is not "do nothing". The gateway settles a waterfall as `next` only
   * once every client it delivered to has declined, so declining is how a
   * control plane that cannot route a question hands it back instead of
   * holding the run open. Not replying at all is the one option that stalls
   * the kernel.
   *
   * @param {{ eventId: string, outcome: { kind: 'result', value?: unknown } | { kind: 'next' } | { kind: 'rejected', error: unknown }, signal?: AbortSignal }} input
   * @returns {Promise<void>}
   */
  async answerHostEvent({ eventId, outcome, signal }) {
    const clientId = this.clientId ?? null;
    if (!clientId) {
      // Named rather than swallowed: no client id means the `$events` stream
      // never opened or has been replaced, so the pending question belongs to
      // a generation that no longer exists. Answering it would be refused by
      // the gateway anyway, and reporting nothing would look like success.
      throw new HttpError(409, "runtime_host_stream_unavailable", "The kernel's host event stream is not subscribed, so there is nothing to answer on.");
    }
    if (!SEAMS.wire.hostInteractionOutcomeKinds.includes(String(outcome?.kind))) {
      throw new HttpError(400, "runtime_interaction_outcome_invalid", `Outcome kind ${String(outcome?.kind)} is not one the kernel accepts.`);
    }
    await this.call(SEAMS.wire.gatewayEndpoints.hostInteractionResult, { clientId, eventId: String(eventId), outcome }, { signal });
  }

  /**
   * Subscribes to the host stream and keeps running state current.
   * @param {{ signal: AbortSignal, onEvent?: (frame: Record<string, any>) => void }} input
   * @returns {Promise<void>}
   */
  async watchHost({ signal, onEvent }) {
    this.runningBySession = this.runningBySession ?? new Map();
    for await (const frame of this.transport.stream(SEAMS.wire.streamEndpoints.events, {}, { signal })) {
      // `ready` carries the host facts `host.describe` used to answer, and it
      // arrives exactly once per connection generation.
      if (frame?.type === "ready") {
        this.hostInfo = frame.host ?? null;
        // The gateway mints one client id per `$events` subscription and
        // refuses any result that does not carry it back — a reply keyed by
        // the event alone is rejected with "identifies no active event
        // stream". So this is not diagnostic data: without it there is no way
        // to answer a question the kernel asks, and the id exists only here.
        this.clientId = typeof frame.clientId === "string" ? frame.clientId : null;
        onEvent?.(frame);
        continue;
      }
      if (frame?.type !== "emit") {
        // `waterfall` is the kernel asking this control plane a question it
        // expects an answer to, and `cancel` is it withdrawing one. Both are
        // surfaced rather than filtered: the kernel holds the tool call open
        // until every client it delivered to has replied, so dropping a
        // waterfall silently stalls the run at the moment it asked for help.
        onEvent?.(frame);
        continue;
      }
      // Two argument shapes, transcribed from a live recording rather than
      // assumed: `api-session/added(summary)` puts an OBJECT in args[0], while
      // `api-session/status(sessionId, running)` and
      // `api-session/removed(sessionId)` are POSITIONAL — args[0] is a bare
      // string. Reading `args[0].sessionId` for all three finds `undefined` on
      // the positional ones, so every status change is dropped and a running
      // session reads `idle` forever off the opening summary. Nothing errors,
      // nothing logs: the failure looks exactly like nothing having happened.
      const args = Array.isArray(frame.args) ? frame.args : [];
      const [first, second] = args;
      const summary = first && typeof first === "object" ? first : null;
      const sessionId = String(summary?.sessionId ?? (typeof first === "string" ? first : ""));
      if (sessionId) {
        if (frame.event === "api-session/status") this.runningBySession.set(sessionId, Boolean(second));
        else if (frame.event === "api-session/added") this.runningBySession.set(sessionId, Boolean(summary?.running));
        else if (frame.event === "api-session/removed") this.runningBySession.delete(sessionId);
      }
      onEvent?.(frame);
    }
  }

  /**
   * Follows one session and yields decoded RunEvents for it.
   *
   * 0.1.2 has no multiplexed all-sessions stream: a session's events arrive on
   * the stream opened for that session and no longer carry a session id, so
   * the pairing is whatever opened the stream. That is why the id is an
   * argument here — inferring it from a frame is no longer possible, and a
   * decoder that quietly used an empty string would attribute every subagent's
   * events to nobody.
   *
   * The opening `snapshot` is replayed as events too. It is not redundant with
   * the transcript endpoint: a tab that connects mid-run gets the window it
   * missed from here, in the same vocabulary as everything after it.
   *
   * @param {{ sessionId: string, signal: AbortSignal }} input
   * @returns {AsyncGenerator<{ sessionId: string, event: import('@evimed/domain').RunEvent }>}
   */
  async *watchSession({ sessionId, signal }) {
    const args = { request: { address: { kind: "session", sessionId } } };
    for await (const frame of this.transport.stream(SEAMS.wire.streamEndpoints.session, args, { signal })) {
      if (frame?.type === "snapshot") {
        for (const record of Array.isArray(frame.records) ? frame.records : []) {
          const decoded = decodeSessionFrame(sessionId, record);
          if (decoded) yield decoded;
        }
        continue;
      }
      const decoded = decodeSessionFrame(sessionId, frame);
      if (decoded) yield decoded;
    }
  }
}

/* ------------------------------------------------------------ normalizers */

/**
 * Turns a page of history entries into the transcript the gate reads.
 *
 * The pairing of `tool/call` with `tool/result` by `callId` is the part that
 * matters: a call whose result never arrived stays `pending` rather than
 * silently becoming a success, which is how a run that died mid-tool used to
 * look complete.
 *
 * @param {string} sessionId
 * @param {readonly Record<string, any>[]} entries
 * @returns {import('@evimed/domain').RunTranscript}
 */
export function normalizeTranscript(sessionId, entries) {
  if (!Array.isArray(entries) || !entries.length) return { ...EMPTY_TRANSCRIPT, sessionId };
  /** @type {import('@evimed/domain').TranscriptMessage[]} */
  const messages = [];
  /** @type {Map<string, Record<string, any>>} */
  const pendingCalls = new Map();
  /** @type {{ sessionId: string, parentSessionId: string, label: string, capability: string }[]} */
  const subagents = [];
  /** @type {{ kind: string, code?: string, subCode?: string } | null} */
  let turnEnd = null;
  let lastSeq = -1;

  for (const entry of entries) {
    const event = entry?.event ?? entry;
    if (!event || typeof event !== "object") continue;
    const seq = Number(event.seq ?? -1);
    if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq);
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const time = Number(event.time ?? 0) || 0;
    switch (event.type) {
      case "user/message": {
        messages.push({
          role: "user",
          // `plugin` is how an injected context is told apart from something the
          // user typed — the difference the injection is logged for.
          source: /** @type {any} */ (String(data?.source?.kind ?? "user")),
          seq,
          time,
          turn: Number(data.turn ?? 0),
          step: Number(data.step ?? 0),
          parts: contentParts(data.content),
          usage: null,
          interrupted: false,
        });
        break;
      }
      case "assistant/message": {
        const parts = contentParts(data?.message?.content);
        messages.push({
          role: "assistant",
          source: "system",
          seq,
          time,
          turn: Number(data.turn ?? 0),
          step: Number(data.step ?? 0),
          parts,
          usage: data.usage ? toUsage(data.usage) : null,
          interrupted: data.interrupted === true,
        });
        break;
      }
      case "tool/call": {
        /** @type {import('@evimed/domain').TranscriptToolCall} */
        const part = {
          type: "tool",
          tool: String(data.name ?? ""),
          callId: String(data.callId ?? ""),
          // A call is pending until its result arrives. A call whose result
          // never arrives stays pending, which is how a run that died mid-tool
          // reads as unfinished rather than as done.
          status: "pending",
          input: toArgs(data.arguments),
          output: "",
          error: null,
        };
        pendingCalls.set(part.callId, part);
        messages.push({
          role: "tool",
          source: "system",
          seq,
          time,
          turn: Number(data.turn ?? 0),
          step: Number(data.step ?? 0),
          parts: [part],
          usage: null,
          interrupted: false,
        });
        break;
      }
      case "tool/result": {
        // The pinned kernel's live frames carry the call id at
        // `message.source.callId` and the text nested inside a
        // `tool-result` block — not at `message.callId` with a flat text
        // block, which is what the first golden fixture said and what this
        // read used to trust. On a real run every one of the 60 tool calls
        // stayed `pending` with empty output while the run's own state file
        // showed three gate runs: the results were all there, one level away.
        // Both shapes are read, because the fixture shape is also the mock
        // runtime's, and a normalizer that drops one of them fails silently.
        const message = data?.message ?? {};
        const callId = String(
          message?.callId
            ?? message?.source?.callId
            ?? (Array.isArray(message?.content)
              ? message.content.find((block) => block?.toolCallId)?.toolCallId
              : undefined)
            ?? data?.callId
            ?? "",
        );
        const part = pendingCalls.get(callId);
        const error = data.error ? { name: String(data.error.name ?? ""), code: String(data.error.code ?? "") } : null;
        const output = toolResultText(message?.content);
        if (part) {
          part.status = error ? "error" : "completed";
          part.output = output;
          part.error = error;
          if (data.meta !== undefined) part.meta = data.meta;
          pendingCalls.delete(callId);
        }
        break;
      }
      case "subagent/descriptor": {
        subagents.push({
          sessionId: String(data.sessionId ?? data.id ?? ""),
          parentSessionId: String(data.parentSession ?? ""),
          label: String(data.label ?? ""),
          capability: String(data.capability ?? data.label ?? ""),
        });
        break;
      }
      case "turn/end": {
        const end = toTurnEnd(event);
        const mapped = turnEndErrorCode(end.kind === "unknown" ? String(end.rawKind ?? "") : end.kind);
        turnEnd = {
          kind: normalizeTurnEndKind(end.kind),
          ...(mapped.errorCode ? { code: mapped.errorCode } : {}),
          ...(mapped.subCode ? { subCode: mapped.subCode } : {}),
        };
        break;
      }
      default:
        break;
    }
  }

  return {
    sessionId,
    messages: Object.freeze(messages),
    turnEnd,
    subagents: Object.freeze(subagents),
    lastSeq,
  };
}

/**
 * @param {unknown} content
 * @returns {import('@evimed/domain').TranscriptTextPart[]}
 */
function contentParts(content) {
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: String(content) }];
  /** @type {import('@evimed/domain').TranscriptTextPart[]} */
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = /** @type {Record<string, any>} */ (block);
    if (record.type === "text") parts.push({ type: "text", text: String(record.text ?? "") });
    else if (record.type === "reasoning") parts.push({ type: "reasoning", text: String(record.text ?? record.reasoning ?? "") });
  }
  return parts;
}

/**
 * The text of a tool result, whichever nesting the kernel used.
 *
 * Live `tool/result` frames wrap their text one level down:
 * `content: [{ type: "tool-result", content: [{ type: "text", text }] }]`.
 * The flat `[{ type: "text", text }]` shape also exists (the mock runtime,
 * and the fixture recorded before the live shape was observed). `contentText`
 * alone read the flat shape only, so live results decoded to "".
 * @param {unknown} content @returns {string}
 */
function toolResultText(content) {
  if (!Array.isArray(content)) return contentText(content);
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = /** @type {Record<string, any>} */ (block);
    if (record.type === "text") texts.push(String(record.text ?? ""));
    else if (Array.isArray(record.content)) {
      for (const inner of record.content) {
        if (inner && typeof inner === "object" && inner.type === "text") texts.push(String(inner.text ?? ""));
      }
    }
  }
  return texts.join("\n");
}

/** @param {unknown} content @returns {string} */
function contentText(content) {
  return contentParts(content).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

/**
 * Decodes one `session/follow` record, given the session it was opened for.
 *
 * @param {string} sessionId the session this stream was opened for
 * @param {Record<string, any>} frame
 * @returns {{ sessionId: string, event: import('@evimed/domain').RunEvent } | null}
 */
export function decodeSessionFrame(sessionId, frame) {
  if (!frame || typeof frame !== "object") return null;
  // A `session/follow` record is `{type:"event", event:{...}}`; the 0.1.1 mux
  // put the same inner event inside `{type:"session/event", sessionId, event}`.
  // Only the envelope changed, so the one decoder below still owns the
  // vocabulary and this adapts the wrapper rather than duplicating the switch.
  if (frame.type === "event" && frame.event && typeof frame.event === "object") {
    return decodeMuxFrame({ type: "session/event", sessionId: String(sessionId), event: frame.event });
  }
  // A `chunks` record is a run of assistant deltas already summarised by the
  // message that follows it; replaying it would double the text.
  if (frame.type === "chunks") return null;
  return null;
}

/**
 * Decodes one session event into the browser-facing union.
 *
 * An unrecognized frame becomes an `unknown` RunEvent carrying its raw type,
 * so a kernel that adds a frame shows up as a counted unknown in the trajectory
 * inspector rather than disappearing (§14 rule 12).
 *
 * @param {Record<string, any>} frame
 * @returns {{ sessionId: string, event: import('@evimed/domain').RunEvent } | null}
 */
export function decodeMuxFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  // `{type:"session/event", sessionId, event}` is this function's own shape,
  // built by `decodeSessionFrame` from what the mux delivers. The 0.1.1 wire
  // put the same inner event inside an RPC envelope on a stream that no longer
  // exists; the envelope changed, the vocabulary below did not, which is why
  // only one decoder was ever needed.
  const sessionId = String(frame.sessionId ?? "");
  if (frame.type !== "session/event") {
    if (frame.type === "session/jobs" || frame.type === "session/queue" || frame.type === "session/subscribed" || frame.type === "session/projection") return null;
    if (frame.type === "stream/error") return null;
    return null;
  }
  const event = frame.event ?? {};
  const seq = Number(event.seq ?? -1);
  const data = event.data && typeof event.data === "object" ? event.data : {};
  switch (event.type) {
    case "turn/start":
      return { sessionId, event: { type: "turn/start", seq, turn: Number(data.turn ?? 0) } };
    case "turn/end": {
      const end = toTurnEnd(event);
      const mapped = turnEndErrorCode(end.kind === "unknown" ? String(end.rawKind ?? "") : end.kind);
      return {
        sessionId,
        event: {
          type: "turn/end",
          seq,
          turn: Number(data.turn ?? 0),
          endKind: normalizeTurnEndKind(end.kind),
          ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
          ...(mapped.subCode ? { subCode: mapped.subCode } : {}),
        },
      };
    }
    case "step/start":
      return { sessionId, event: { type: "step/start", seq, turn: Number(data.turn ?? 0), step: Number(data.step ?? 0) } };
    case "step/end":
      return { sessionId, event: { type: "step/end", seq, turn: Number(data.turn ?? 0), step: Number(data.step ?? 0) } };
    case "user/message":
      return {
        sessionId,
        event: {
          type: "message/user",
          seq,
          text: contentText(data.content),
          source: /** @type {any} */ (String(data?.source?.kind ?? "user")),
        },
      };
    case "assistant/message": {
      const parts = contentParts(data?.message?.content);
      return {
        sessionId,
        event: {
          type: "message/assistant",
          seq,
          text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
          reasoning: parts.filter((part) => part.type === "reasoning").map((part) => part.text).join("\n"),
          usage: data.usage ? toUsage(data.usage) : null,
          interrupted: data.interrupted === true,
        },
      };
    }
    case "assistant/chunk": {
      const chunk = data.chunk && typeof data.chunk === "object" ? data.chunk : {};
      const kind = String(chunk.type ?? "").includes("reason") ? "reasoning" : "text";
      const text = String(chunk.text ?? chunk.delta ?? "");
      if (!text) return null;
      return { sessionId, event: { type: "assistant/delta", seq, kind: /** @type {any} */ (kind), text } };
    }
    case "tool/call": {
      const tool = String(data.name ?? "");
      const input = toArgs(data.arguments);
      return {
        sessionId,
        event: { type: "tool/call", seq, callId: String(data.callId ?? ""), tool, input, narration: narrateToolCall(tool, input).text },
      };
    }
    case "tool/result": {
      const tool = String(data?.message?.name ?? data.name ?? "");
      const status = data.error ? "error" : "completed";
      // Same two shapes as the transcript normalizer above; see the note there.
      const output = toolResultText(data?.message?.content);
      return {
        sessionId,
        event: {
          type: "tool/result",
          seq,
          callId: String(
            data?.message?.callId
              ?? data?.message?.source?.callId
              ?? (Array.isArray(data?.message?.content)
                ? data.message.content.find((block) => block?.toolCallId)?.toolCallId
                : undefined)
              ?? data.callId
              ?? "",
          ),
          tool,
          status: /** @type {any} */ (status),
          output,
          ...(data.error ? { errorCode: String(data.error.code ?? "") } : {}),
          narration: narrateToolCall(tool, {}, data.error ? undefined : { text: output }).text,
        },
      };
    }
    case "subagent/descriptor":
      return {
        sessionId,
        event: {
          type: "subagent/started",
          seq,
          childSessionId: String(data.sessionId ?? data.id ?? sessionId),
          capability: String(data.capability ?? data.label ?? ""),
          label: String(data.label ?? ""),
        },
      };
    case "tool-workflow/run-start":
    case "tool-workflow/run-end":
    case "tool-workflow/agent-start":
    case "tool-workflow/agent-end":
      return {
        sessionId,
        event: {
          type: "workflow/stage",
          seq,
          runId: String(data.runId ?? ""),
          stage: String(data.stage ?? data.label ?? ""),
          state: String(event.type).endsWith("end") ? "ended" : "started",
        },
      };
    case "compaction/end":
      return {
        sessionId,
        event: { type: "compaction", seq, replaced: Number(data.replaced ?? 0), estimatedTokens: Number(data.tokens ?? 0) },
      };
    default:
      return { sessionId, event: { type: "unknown", seq, rawType: String(event.type ?? "") } };
  }
}

/**
 * Projects a transcript back into the message shape the run ledger has always
 * read.
 *
 * This exists for exactly one reason and has exactly one lifetime: the ledger
 * is 2,300 lines that read `message.info.role` and `parts[].state.status`, and
 * changing the kernel and the ledger's vocabulary in one step would have made a
 * failure impossible to attribute to either. So the kernel moves first behind
 * this projection, and the ledger moves to `RunTranscript` next — at which
 * point this function is deleted, not kept as a compatibility layer.
 *
 * @param {import('@evimed/domain').RunTranscript} transcript
 * @returns {Record<string, any>[]}
 */
export function transcriptToLedgerMessages(transcript) {
  // The turn's own ending, carried on the last message.
  //
  // `normalizeTranscript` decodes `turn/end` — the frame that says whether the
  // kernel stopped because it was done, refused, hit a token ceiling, or
  // errored — and this projection returned only `messages`, so the stop reason
  // was computed and dropped on every read. `readSessionHistory` hands the
  // control plane this array and nothing else, which is why "the run stopped"
  // and "the run was refused" and "the run ran out of tokens" all reached the
  // ledger as the same silence.
  //
  // It rides the last message because that is the only carrier this contract
  // has; `info.error` is set alongside it only when the ending actually maps
  // to an error, mirroring how `interrupted` already surfaces.
  const lastIndex = transcript.messages.length - 1;
  const turnEnd = transcript.turnEnd;
  return transcript.messages.map((message, index) => ({
    info: {
      // The ledger takes the last message's id as its baseline cursor, so every
      // message needs a stable one. Under this kernel the sequence number is
      // that identity: it is assigned by the log, monotonic, and survives a
      // reload, which is exactly what a cursor has to be.
      id: `seq_${message.seq}`,
      role: message.role === "tool" ? "assistant" : message.role,
      // An assembled assistant message is, by construction, a finished step:
      // the kernel emits it after the step closes. The ledger reads a completion
      // timestamp to tell a finished message from a streaming one, and without
      // it every run looked like it was still speaking.
      //
      // A tool message needs it for the same reason and did not get it. The
      // line above rewrites `tool` to `assistant` — which the ledger wants —
      // but the timestamp was only attached to messages that were already
      // assistant, so every tool message arrived as an assistant message that
      // `assistantFinished` reads as still streaming and the delivery gate
      // filters out. Artifacts, evidence provenance and skill loads are all
      // derived from tool parts, so the gate saw a run that called no tools:
      // no artifacts, no provenance, no skills, and nothing anywhere saying
      // the messages had been dropped rather than never made.
      //
      // A tool message is a record of a call that happened; whether the call
      // finished is `parts[].state.status`, which the gate reads separately.
      ...(message.role === "assistant" || message.role === "tool"
        ? { time: { created: message.time, completed: message.time } }
        : {}),
      ...(message.usage ? { usage: message.usage } : {}),
      ...(message.interrupted ? { error: { name: "interrupted" } } : {}),
      ...(turnEnd && index === lastIndex
        ? {
          turnEnd,
          ...(message.interrupted || !turnEnd.code ? {} : { error: { name: turnEnd.kind, code: turnEnd.code } }),
        }
        : {}),
    },
    parts: message.parts.map((part) => (part.type === "tool"
      ? {
        type: "tool",
        tool: part.tool,
        callID: part.callId,
        state: {
          status: part.status,
          input: part.input,
          output: part.output,
          ...(part.error ? { error: part.error.code } : {}),
          ...(part.meta === undefined ? {} : { metadata: part.meta }),
        },
      }
      : { type: part.type, text: part.text })),
  }));
}

/**
 * The reverse projection, for the kernel that is on its way out.
 *
 * It exists so callers can read one vocabulary during the coexistence window
 * rather than branching on the kernel at every read site — which is how the
 * old vocabulary would have spread instead of shrinking.
 *
 * @param {string} sessionId
 * @param {readonly Record<string, any>[]} messages
 * @returns {import('@evimed/domain').RunTranscript}
 */
export function legacyMessagesToTranscript(sessionId, messages) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    sessionId,
    messages: Object.freeze(list.map((message, index) => {
      const role = String(message?.info?.role ?? message?.role ?? "assistant");
      const parts = Array.isArray(message?.parts) ? message.parts : [];
      return {
        role: /** @type {any} */ (role === "user" ? "user" : role === "tool" ? "tool" : "assistant"),
        source: /** @type {any} */ (role === "user" ? "user" : "system"),
        seq: index,
        time: Number(message?.info?.time?.completed ?? 0) || 0,
        turn: 0,
        step: 0,
        parts: Object.freeze(parts.map((part) => (part?.type === "tool"
          ? {
            type: "tool",
            tool: String(part.tool ?? ""),
            callId: String(part.callID ?? part.callId ?? ""),
            status: /** @type {any} */ (part?.state?.status === "error" ? "error" : part?.state?.status === "completed" ? "completed" : "pending"),
            input: part?.state?.input && typeof part.state.input === "object" ? part.state.input : {},
            output: String(part?.state?.output ?? ""),
            error: part?.state?.error ? { name: "ToolError", code: String(part.state.error) } : null,
            ...(part?.state?.metadata === undefined ? {} : { meta: part.state.metadata }),
          }
          : { type: /** @type {any} */ (part?.type === "reasoning" ? "reasoning" : "text"), text: String(part?.text ?? "") }))),
        usage: message?.info?.usage ?? null,
        interrupted: Boolean(message?.info?.error),
      };
    })),
    turnEnd: null,
    subagents: Object.freeze([]),
    lastSeq: list.length - 1,
  };
}
