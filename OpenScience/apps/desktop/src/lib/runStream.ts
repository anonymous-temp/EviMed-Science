/**
 * The run stream: what the browser knows about a run in flight.
 *
 * Hidden knowledge: the browser speaks one vocabulary, and it is ours. It used
 * to consume a kernel's own event shapes — message parts, part states,
 * permission and question envelopes — proxied straight through, which meant the
 * frontend knew that kernel and every kernel change was a frontend change. The
 * control plane now decodes into `RunEvent` and forwards its own stream, so
 * this module knows about runs, deliverables, evidence and budgets, and about
 * no kernel at all.
 *
 * Three properties follow, and each is a deliberate choice rather than a
 * consequence:
 *
 * - the event union is closed and exhausted, so a variant we do not handle is
 *   counted and shown rather than dropped;
 * - resumption is by our own sequence number, so a reconnecting tab replays
 *   from where it was rather than from the beginning of the run;
 * - the run's own facts — a deliverable's verdict, an evidence state, the
 *   budget — arrive on the same channel as the kernel's, because to a reader
 *   they are one story.
 *
 * @module lib/runStream
 */

import { narrateToolCall, narrateRunEvent, errorCodeMessage } from "@evimed/domain";
import type { ThreadBlock, ToolCallStatus } from "@ai4s/shared";

/** One decoded run event. Mirrors `@evimed/domain`'s RunEvent union. */
export type RunEvent =
  | { type: "turn/start"; seq: number; turn: number }
  | { type: "turn/end"; seq: number; turn: number; endKind: string; errorCode?: string; subCode?: string }
  | { type: "step/start"; seq: number; turn: number; step: number }
  | { type: "step/end"; seq: number; turn: number; step: number }
  | { type: "message/user"; seq: number; text: string; source: "user" | "plugin" | "system" | "subagent" }
  | {
    type: "message/assistant";
    seq: number;
    text: string;
    reasoning: string;
    usage: { input: number; output: number; cacheHit: number; cacheMiss: number } | null;
    interrupted: boolean;
  }
  | { type: "assistant/delta"; seq: number; kind: "text" | "reasoning"; text: string }
  | { type: "tool/call"; seq: number; callId: string; tool: string; input: Record<string, unknown>; narration: string }
  | {
    type: "tool/result";
    seq: number;
    callId: string;
    tool: string;
    status: "completed" | "error";
    output: string;
    errorCode?: string;
    narration: string;
    durationMs?: number;
  }
  | { type: "subagent/started"; seq: number; childSessionId: string; capability: string; label: string }
  | { type: "workflow/stage"; seq: number; runId: string; stage: string; state: string }
  | { type: "compaction"; seq: number; replaced: number; estimatedTokens: number }
  | { type: "plan/updated"; seq: number; revision: number; deliverableCount: number }
  | { type: "unknown"; seq: number; rawType: string };

/** The envelope the control plane's SSE carries. */
export type RunStreamFrame =
  | { type: "run/state"; seq: number; time: string; state: string; errorCode: string | null; verification: string | null; attempts: number }
  | { type: "run/event"; seq: number; time: string; event: RunEvent }
  | { type: "subagent/update"; seq: number; time: string; childSessionId: string; label: string; capability: string; status: string; report?: string }
  | { type: "deliverable/update"; seq: number; time: string; id: string; contractKind: string; status: string; receipt?: unknown; issues?: RunIssue[] }
  // A snapshot, not a delta. The control plane only ever holds the aggregate:
  // the run's own projection (`.evimed-run/state.json`) counts evidence into
  // `{ total, byStatus }` and never carries per-record rows, so there was no
  // producer that could have filled the per-record shape this used to declare.
  // A snapshot is also the safer of the two on this channel — a delta applied
  // twice after a reconnect double-counts, and a snapshot applied twice is the
  // same snapshot.
  | { type: "evidence/update"; seq: number; time: string; total: number; byStatus: Record<string, number> }
  | { type: "budget/update"; seq: number; time: string; steps: number; tokens: number; children: number; limits: Record<string, number> }
  | { type: "stream/gap"; seq: number; time: string; since: number; resumedAt: number };

export interface RunIssue {
  code: string;
  message: string;
  severity: "required" | "advisory" | "optional";
  path?: string;
  line?: number;
}

export interface SubagentNode {
  childSessionId: string;
  label: string;
  capability: string;
  status: string;
  report?: string;
}

export interface DeliverableNode {
  id: string;
  contractKind: string;
  status: string;
  issues: RunIssue[];
  receipt?: unknown;
}

/** Everything the browser knows about one run. */
export interface RunView {
  runId: string;
  /** Last frame sequence applied. Resumption asks for events after it. */
  seq: number;
  state: string;
  errorCode: string | null;
  verification: string | null;
  attempts: number;
  blocks: ThreadBlock[];
  subagents: SubagentNode[];
  deliverables: DeliverableNode[];
  evidence: { total: number; byStatus: Record<string, number> };
  budget: { steps: number; tokens: number; children: number; limits: Record<string, number> };
  /**
   * Events this build does not know how to render, by their raw name. Shown
   * rather than dropped: an event we silently ignore is a change we never learn
   * about until a user reports missing detail.
   */
  unknownEvents: Record<string, number>;
  /** A gap means the client fell further behind than the replay buffer. */
  missedRange: { since: number; resumedAt: number } | null;
}

/** @returns an empty view for a run nothing is known about yet */
export function emptyRunView(runId: string): RunView {
  return {
    runId,
    seq: 0,
    state: "reserved",
    errorCode: null,
    verification: null,
    attempts: 0,
    blocks: [],
    subagents: [],
    deliverables: [],
    evidence: { total: 0, byStatus: {} },
    budget: { steps: 0, tokens: 0, children: 0, limits: {} },
    unknownEvents: {},
    missedRange: null,
  };
}

const TOOL_STATUS: Record<string, ToolCallStatus> = {
  completed: "success",
  error: "failed",
};

/**
 * Applies one frame.
 *
 * Pure and total: it takes a view and a frame and returns a view. A reducer
 * that mutates is a reducer whose bugs only appear under a second subscriber,
 * and there are always two (the page and the runs list).
 */
export function applyRunFrame(view: RunView, frame: RunStreamFrame): RunView {
  // Frames are replayed on reconnect, so an already-applied one must be a
  // no-op rather than a duplicate block.
  if (frame.seq <= view.seq && frame.type !== "stream/gap") return view;
  const next: RunView = { ...view, seq: Math.max(view.seq, frame.seq) };
  switch (frame.type) {
    case "run/state":
      return { ...next, state: frame.state, errorCode: frame.errorCode, verification: frame.verification, attempts: frame.attempts };
    case "run/event":
      return applyRunEvent(next, frame.event);
    case "subagent/update": {
      const subagents = next.subagents.filter((node) => node.childSessionId !== frame.childSessionId);
      subagents.push({
        childSessionId: frame.childSessionId,
        label: frame.label,
        capability: frame.capability,
        status: frame.status,
        ...(frame.report ? { report: frame.report } : {}),
      });
      return { ...next, subagents };
    }
    case "deliverable/update": {
      const deliverables = next.deliverables.filter((node) => node.id !== frame.id);
      deliverables.push({
        id: frame.id,
        contractKind: frame.contractKind,
        status: frame.status,
        issues: frame.issues ?? [],
        ...(frame.receipt === undefined ? {} : { receipt: frame.receipt }),
      });
      return { ...next, deliverables };
    }
    case "evidence/update":
      return { ...next, evidence: { total: frame.total, byStatus: { ...frame.byStatus } } };
    case "budget/update":
      return { ...next, budget: { steps: frame.steps, tokens: frame.tokens, children: frame.children, limits: frame.limits } };
    case "stream/gap":
      return { ...next, missedRange: { since: frame.since, resumedAt: frame.resumedAt } };
    default: {
      // The union is closed; an unlisted frame is a control-plane bug, and it is
      // recorded rather than dropped so it shows up as one.
      const unknown = frame as { type?: string };
      return { ...next, unknownEvents: bump(next.unknownEvents, `frame:${unknown.type ?? "unnamed"}`) };
    }
  }
}

/** @param counts @param key @returns a new count map with `key` incremented */
function bump(counts: Record<string, number>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/**
 * Folds one run event into the visible blocks.
 *
 * The switch is exhaustive on purpose: TypeScript's `never` check at the bottom
 * is what makes adding a variant to the union a compile error here rather than
 * a silently missing card in the page.
 */
export function applyRunEvent(view: RunView, event: RunEvent): RunView {
  const blocks = [...view.blocks];
  switch (event.type) {
    case "message/user": {
      // Context the system injected is shown as such, not as something the user
      // typed: the difference is the whole reason the injection is logged.
      blocks.push(event.source === "user"
        ? { kind: "user", text: event.text }
        : { kind: "status-line", text: `系统注入的上下文：${truncate(event.text, 80)}`, tone: "muted" } as ThreadBlock);
      return { ...view, blocks };
    }
    case "message/assistant": {
      if (event.text.trim()) blocks.push({ kind: "agent", markdown: event.text });
      return { ...view, blocks };
    }
    case "assistant/delta": {
      // The streaming tail is its own block so it can be replaced wholesale when
      // the assembled message lands, rather than accumulating twice.
      const last = blocks.at(-1);
      if (event.kind === "text" && last?.kind === "agent") {
        blocks[blocks.length - 1] = { kind: "agent", markdown: last.markdown + event.text };
      } else if (event.kind === "text") {
        blocks.push({ kind: "agent", markdown: event.text });
      }
      return { ...view, blocks };
    }
    case "tool/call": {
      blocks.push({
        kind: "tool-call",
        title: event.narration || narrateToolCall(event.tool, event.input).text,
        status: "running",
        tool: event.tool,
        callId: event.callId,
      } as ThreadBlock);
      return { ...view, blocks };
    }
    case "tool/result": {
      const index = blocks.findLastIndex((block) => block.kind === "tool-call" && (block as { callId?: string }).callId === event.callId);
      if (index >= 0) {
        const existing = blocks[index] as ThreadBlock & { title: string };
        blocks[index] = {
          ...existing,
          status: TOOL_STATUS[event.status] ?? "warning",
          title: event.narration || existing.title,
          ...(event.errorCode ? { meta: errorCodeMessage(event.errorCode) } : {}),
        } as ThreadBlock;
      }
      return { ...view, blocks };
    }
    case "subagent/started": {
      const subagents = view.subagents.some((node) => node.childSessionId === event.childSessionId)
        ? view.subagents
        : [...view.subagents, { childSessionId: event.childSessionId, label: event.label, capability: event.capability, status: "running" }];
      blocks.push({ kind: "status-line", text: narrateRunEvent({ type: "subagent/started", capability: event.capability }).text, tone: "muted" } as ThreadBlock);
      return { ...view, blocks, subagents };
    }
    case "compaction": {
      // A compaction marker is added, never a replacement of what came before:
      // the reader keeps seeing the history the model no longer has.
      blocks.push({ kind: "status-line", text: narrateRunEvent({ type: "compaction", replaced: event.replaced }).text, tone: "muted" } as ThreadBlock);
      return { ...view, blocks };
    }
    case "plan/updated": {
      blocks.push({ kind: "status-line", text: narrateRunEvent({ type: "plan/updated", deliverableCount: event.deliverableCount }).text, tone: "muted" } as ThreadBlock);
      return { ...view, blocks };
    }
    case "turn/end": {
      if (event.errorCode) {
        blocks.push({ kind: "status-line", text: errorCodeMessage(event.errorCode), tone: "error" } as ThreadBlock);
      }
      return { ...view, blocks };
    }
    case "workflow/stage":
    case "turn/start":
    case "step/start":
    case "step/end":
      return view;
    case "unknown":
      return { ...view, unknownEvents: bump(view.unknownEvents, event.rawType || "unnamed") };
    default: {
      // Exhaustiveness: adding a variant to RunEvent must break this line.
      const exhaustive: never = event;
      return { ...view, unknownEvents: bump(view.unknownEvents, `unhandled:${String((exhaustive as { type?: string })?.type)}`) };
    }
  }
}

/** @param text @param max @returns text truncated for a one-line status */
function truncate(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Subscribes to a run's event stream.
 *
 * `EventSource` is used deliberately: it reconnects on its own and replays with
 * `Last-Event-ID`, which the server honours, so a laptop that slept catches up
 * without any client code. The one thing a caller must handle is the gap frame,
 * which says the client fell further behind than the server's replay buffer and
 * should re-read the run.
 */
export interface RunStreamHandle {
  close: () => void;
}

export function openRunStream(
  runId: string,
  options: {
    apiBase?: string;
    since?: number;
    onFrame: (frame: RunStreamFrame) => void;
    onError?: (error: unknown) => void;
    /** Injectable for tests; defaults to the platform EventSource. */
    factory?: (url: string) => EventSource;
  },
): RunStreamHandle {
  const base = options.apiBase ?? "/api";
  const query = options.since ? `?since=${encodeURIComponent(String(options.since))}` : "";
  const url = `${base}/runs/${encodeURIComponent(runId)}/events${query}`;
  const source = (options.factory ?? ((target: string) => new EventSource(target, { withCredentials: true })))(url);

  const forward = (raw: MessageEvent) => {
    // isolated: a malformed frame must not take down a live view.
    try {
      options.onFrame(JSON.parse(raw.data) as RunStreamFrame);
    } catch (error) {
      options.onError?.(error);
    }
  };
  for (const type of RUN_STREAM_FRAME_TYPES) source.addEventListener(type, forward as EventListener);
  source.onerror = (error) => options.onError?.(error);
  return { close: () => source.close() };
}

/** Every frame type the control plane emits (§18.4). */
export const RUN_STREAM_FRAME_TYPES = [
  "run/state",
  "run/event",
  "subagent/update",
  "deliverable/update",
  "evidence/update",
  "budget/update",
  "stream/gap",
] as const;

/**
 * Folds a whole transcript into blocks.
 *
 * This is what a page load and a reconnect use: the live stream carries what
 * happened *since* you attached, and the transcript carries what happened
 * before. Both produce the same blocks, from the same reducer, so a reloaded
 * conversation and a watched one cannot drift.
 */
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  source: "user" | "plugin" | "system" | "subagent";
  seq: number;
  time: number;
  turn: number;
  step: number;
  parts: Array<
    | { type: "text" | "reasoning"; text: string }
    | {
      type: "tool";
      tool: string;
      callId: string;
      status: "pending" | "completed" | "error";
      input: Record<string, unknown>;
      output: string;
      error: { name: string; code: string } | null;
    }
  >;
  usage: { input: number; output: number; cacheHit: number; cacheMiss: number } | null;
  interrupted: boolean;
}

export interface RunTranscript {
  sessionId: string;
  messages: TranscriptMessage[];
  turnEnd: { kind: string; code?: string; subCode?: string } | null;
  subagents: { sessionId: string; parentSessionId: string; label: string; capability: string }[];
  lastSeq: number;
}

/**
 * @param transcript the run as the control plane serves it
 * @returns a view built from the same reducer the live stream uses
 */
export function transcriptToRunView(runId: string, transcript: RunTranscript): RunView {
  // Every field the control plane sends is read defensively here. This is the
  // one place a browser parses a payload it did not construct, and a page that
  // throws on an unexpected message shows nothing at all — strictly worse than
  // a page that shows the messages it did understand.
  const events: RunEvent[] = [];
  for (const message of transcript.messages ?? []) {
    if (message.role === "user") {
      events.push({
        type: "message/user",
        seq: message.seq,
        text: (message.parts ?? []).filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n"),
        source: message.source,
      });
      continue;
    }
    for (const part of (message.parts ?? [])) {
      if (part.type === "tool") {
        events.push({
          type: "tool/call",
          seq: message.seq,
          callId: part.callId,
          tool: part.tool,
          input: part.input,
          narration: narrateToolCall(part.tool, part.input).text,
        });
        // A call whose result never arrived stays pending, which is how a run
        // that died mid-tool reads as unfinished rather than as done.
        if (part.status === "pending") continue;
        events.push({
          type: "tool/result",
          seq: message.seq,
          callId: part.callId,
          tool: part.tool,
          status: part.status,
          output: part.output,
          ...(part.error ? { errorCode: part.error.code } : {}),
          narration: narrateToolCall(part.tool, part.input, part.error ? undefined : { text: part.output }).text,
        });
        continue;
      }
      if (part.type === "text" && part.text.trim()) {
        events.push({
          type: "message/assistant",
          seq: message.seq,
          text: part.text,
          reasoning: "",
          usage: message.usage,
          interrupted: message.interrupted,
        });
      }
    }
  }
  const view = events.reduce(applyRunEvent, { ...emptyRunView(runId), seq: 0 });
  const subagents = (transcript.subagents ?? []).map((node) => ({
    childSessionId: node.sessionId,
    label: node.label,
    capability: node.capability,
    status: "completed",
  }));
  const withEnd = transcript.turnEnd?.code
    ? applyRunEvent(view, {
      type: "turn/end",
      seq: transcript.lastSeq,
      turn: 0,
      endKind: transcript.turnEnd.kind,
      errorCode: transcript.turnEnd.code,
    })
    : view;
  return { ...withEnd, seq: Math.max(0, transcript.lastSeq), subagents };
}

/**
 * Whether a run is still working.
 *
 * "We have not been told" is not "idle": treating the two the same is what let
 * a dead run look like a working one, and a working one look finished.
 */
/**
 * The statuses the control plane actually publishes on `run/state`.
 *
 * Not `@evimed/domain`'s `RUN_PHASES`. Those name nine *projected* phases,
 * including `accepted` and `degraded` — computed fresh on every read, never
 * stored (§7.1.1, decision 2026-08-24 #20) — while the run ledger's own,
 * authoritative field is the four below, published on `run.status` verbatim.
 * Listing the domain's nine-value set here meant a succeeded run was never
 * recognized as finished — the browser held its subscription open and showed
 * a spinner on a delivered run, forever. The SSE frame does carry the
 * projection too, as a sibling field (`phase`), for whatever reads it — but
 * stream settlement is decided on `state`, the same field the frontend has
 * always kept the true, load-bearing terminal check pinned to.
 */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "canceled"] as const;

export function runIsSettled(view: RunView): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(view.state);
}
