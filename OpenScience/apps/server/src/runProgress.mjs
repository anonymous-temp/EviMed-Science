/**
 * What a run is doing, assembled from what was observed — the one aggregate
 * every progress surface renders (`run/progress`, C5).
 *
 * Hidden knowledge: nothing here is a workflow. The phases are labels on tool
 * calls the kernel reported (`phaseOfToolCall`), the deliverable states are the
 * run's own plan index, and the children are sessions the kernel itself says
 * were created under this run. Nothing asks the model to announce progress
 * (principle 12), and a plain question that makes no tool call shows no phase
 * at all.
 *
 * It exists because the same facts used to reach the researcher three ways
 * that disagreed: the runs page polled a plan the ledger had scoped to the
 * parent's own tool calls (so a delegated item read 「待开始」 for its whole
 * life), the event stream carried the kernel's events with no aggregate, and
 * the stall monitor counted the parent only. One function now computes the
 * picture, the ledger stores it, and the stream publishes it.
 *
 * Pure functions only, so the reduction is testable without a run around it.
 *
 * @module runProgress
 */

import { PLAN_ITEM_STATES, RUN_ACTIVITY_PHASES, phaseOfToolCall, summarizeRunPhases } from "@evimed/domain";
import { socketToolResult } from "./dshRuntimeAdapter.mjs";

/** The deliverable states a run record carries (C3): the plan item states a
 *  reader needs, plus the two only the end of a run can decide. */
export const RUN_DELIVERABLE_STATUSES = Object.freeze(["planned", "delegated", "submitted", "rejected", "accepted", "delivered", "failed"]);

/** How many deliverables a record keeps. A plan is a handful of items; the
 *  ledger is a 1 MiB file every run shares. */
const maxDeliverables = 12;
/** How many children one progress snapshot names. */
const maxChildren = 16;
const maxTitle = 80;

/**
 * @typedef {{ id: string, title: string, capability?: string, status: string, attempts: number,
 *   lastVerdict?: 'pass'|'issues'|'unverified', mustFixCount?: number, childSessionId?: string }} RunDeliverable
 * @typedef {{ childSessionId: string, deliverableId?: string, state: 'running'|'idle'|'done'|'failed', lastActivityAt: string | null }} RunProgressChild
 * @typedef {{ requests: number, inputTokens: number, cachedInputTokens: number, outputTokens: number, costCny: number }} RunUsage
 * @typedef {{
 *   deliverables: RunDeliverable[],
 *   phaseCounts: Record<string, number>,
 *   reachedPhases: string[],
 *   currentPhase: string | null,
 *   sources: { searched: number, included: number, fullText: number },
 *   claims: { total: number, verified: number },
 *   children: RunProgressChild[],
 *   usage?: RunUsage,
 *   startedAt: string | null,
 *   updatedAt: string,
 * }} RunProgress
 * @typedef {{ callId: string, tool: string, input: Record<string, string> | null, phase: string | null, ok: boolean | null, fullText: boolean,
 *   at: number | null, claimTotals?: { deliverableId: string, total: number, verified: number } }} ObservedCall
 */

/** The argument keys a phase label reads (a write is `write` only inside
 *  `deliverables/`). Nothing else of a call's input is kept: it can hold a
 *  whole document, and this lives in memory for the life of a run. */
const PHASE_INPUT_KEYS = Object.freeze(["filePath", "file_path", "path", "target"]);

/** @param {any} input @returns {Record<string, string> | null} */
function phaseInput(input) {
  if (!input || typeof input !== "object") return null;
  /** @type {Record<string, string>} */
  const kept = {};
  for (const key of PHASE_INPUT_KEYS) {
    if (typeof input[key] === "string" && input[key]) kept[key] = input[key].slice(0, 300);
  }
  return Object.keys(kept).length ? kept : null;
}

/** @param {unknown} value @returns {Record<string, any> | null} */
function jsonObject(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One tool call, reduced to what the aggregate counts.
 *
 * `ok` is null while the call is open. A full text counts only when the tool
 * answered with a preserved artifact: a fetch that came back
 * `full_text_not_available` completed as a call and preserved nothing, and
 * counting it would say the run read a paper it never had.
 *
 * @param {{ callId?: string, tool?: string, input?: any, status?: string, output?: any, at?: number | null, phase?: string | null }} call
 * @returns {ObservedCall}
 */
export function observedCall(call) {
  const tool = String(call.tool ?? "");
  const input = call.input && typeof call.input === "object" ? call.input : null;
  const kept = phaseInput(input);
  const phase = call.phase === undefined ? phaseOfToolCall(tool, kept) : call.phase;
  const status = String(call.status ?? "pending");
  /** @type {boolean | null} */
  let ok = null;
  let fullText = false;
  /** @type {ObservedCall['claimTotals']} */
  let claimTotals;
  if (status === "error") ok = false;
  else if (status === "completed") {
    // An MCP tool answers bare JSON `{status, data, artifacts}`; a socket tool
    // answers rendered text (`ok\n<JSON>` / `failed: <code>`). Either way the
    // call can have "completed" and still have failed.
    const mcp = jsonObject(call.output);
    const socket = mcp ? null : socketToolResult(call.output);
    ok = mcp ? mcp.status !== "error" : socket ? socket.ok === true : true;
    if (phase === "fulltext" && mcp && ok) fullText = Array.isArray(mcp.artifacts) && mcp.artifacts.length > 0;
    // The claim tool reports the package's running totals with every write
    // (C7), which is cheaper and fresher than re-reading the matrix.
    if (socket?.ok && tool === "evimed_claim_upsert") {
      const totals = socket.data?.totals;
      const deliverableId = String(input?.deliverableId ?? "");
      if (deliverableId && Number.isSafeInteger(totals?.total) && Number.isSafeInteger(totals?.verified)) {
        claimTotals = { deliverableId, total: totals.total, verified: totals.verified };
      }
    }
  }
  const at = Number(call.at);
  return {
    callId: String(call.callId ?? ""),
    tool,
    input: kept,
    phase: phase ?? null,
    ok,
    fullText,
    at: Number.isFinite(at) && at > 0 ? at : null,
    ...(claimTotals ? { claimTotals } : {}),
  };
}

/**
 * Every tool call in a session history, in the message shape the ledger reads
 * (`transcriptToLedgerMessages`).
 * @param {readonly any[]} messages @returns {ObservedCall[]}
 */
export function observedCallsFromHistory(messages) {
  /** @type {ObservedCall[]} */
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool") continue;
      calls.push(observedCall({
        // A call with no id is keyed by its place in the history, which is
        // stable from one read to the next; a key that changed per read would
        // count the same call once per poll.
        callId: part.callID ?? part.callId ?? `index:${calls.length}`,
        tool: part.tool,
        input: part.state?.input,
        status: part.state?.status,
        output: part.state?.output,
        at: part.state?.completedAt ?? message?.info?.time?.created,
      }));
    }
  }
  return calls;
}

/**
 * Folds one live kernel event into a session's call map. Replays are welcome:
 * a call is keyed by its id, so seeing it twice changes nothing.
 * @param {Map<string, ObservedCall>} calls
 * @param {import('@evimed/domain').RunEvent} event
 * @param {number} now
 * @returns {boolean} whether the map changed
 */
export function foldToolEvent(calls, event, now) {
  if (event.type === "tool/call") {
    const key = event.callId || `seq:${event.seq}`;
    if (calls.has(key)) return false;
    calls.set(key, observedCall({ callId: event.callId, tool: event.tool, input: event.input, status: "pending", at: now, ...(event.phase === undefined ? {} : { phase: event.phase }) }));
    return true;
  }
  if (event.type === "tool/result") {
    const key = event.callId || `seq:${event.seq}`;
    const open = calls.get(key);
    const next = observedCall({
      callId: event.callId,
      tool: event.tool || open?.tool,
      input: open?.input ?? null,
      status: event.status,
      output: event.output,
      at: now,
      phase: open ? open.phase : (event.phase ?? null),
    });
    calls.set(key, next);
    return true;
  }
  return false;
}

/** @param {unknown} value @returns {number} */
function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * The plan, as the record keeps it (C3).
 *
 * Read from the run's own plan index and delivery receipt while the run is
 * going, and decided against the run's outcome once it has ended — which is
 * the part a finished run's page could not show before: which item was
 * rejected, how many times it was submitted, and what became of it.
 *
 * `terminal` is null while the run is running. At the end:
 *   - an accepted item of a delivered run is `delivered` (verdict `pass`);
 *   - an item whose files shipped without an acceptance is `delivered` with
 *     verdict `unverified` — the files reached the reader, the gate did not
 *     pass them (2026-09-17: a verdict never withholds a delivery);
 *   - an item that was worked on and shipped nothing is `failed`; one that was
 *     never started stays `planned`.
 *
 * @param {Record<string, any> | null | undefined} projection the run's (scoped) `.evimed-run/state.json`
 * @param {Record<string, any> | null | undefined} receipt a validated delivery receipt, or null
 * @param {{ status: string, artifacts?: readonly string[], unverifiedArtifacts?: readonly string[] } | null} [terminal]
 * @returns {RunDeliverable[]}
 */
export function runDeliverables(projection, receipt, terminal = null) {
  const items = Array.isArray(projection?.plan?.items) ? projection.plan.items : [];
  const accepted = new Set((receipt?.entries ?? []).map((/** @type {any} */ entry) => String(entry?.deliverableId ?? "")).filter(Boolean));
  const children = Array.isArray(projection?.subagents) ? projection.subagents : [];
  const shipped = [...(terminal?.artifacts ?? []), ...(terminal?.unverifiedArtifacts ?? [])];
  /** @type {RunDeliverable[]} */
  const deliverables = [];
  const seen = new Set();
  const place = (/** @type {any} */ item, /** @type {string} */ id) => {
    const raw = String(item?.status ?? "planned");
    const attempts = count(item?.attempts);
    // The plan index writes the last verdict's issues as `issues` (the
    // socket's `publicItem`); `lastIssues` is the socket's in-memory name,
    // read too so neither spelling reads as "no issues".
    const issues = Array.isArray(item?.issues) ? item.issues : Array.isArray(item?.lastIssues) ? item.lastIssues : [];
    const mustFixCount = issues.filter((/** @type {any} */ issue) => issue && typeof issue === "object" && (issue.severity ?? "required") === "required").length;
    // Whichever child the item was last delegated to: the plan index keys a
    // retry over its first attempt, so the last row is the live one.
    const child = [...children].reverse().find((row) => String(row?.deliverableId ?? "") === id);
    const childSessionId = text(child?.childSessionId ?? item?.childSessionId, 200);
    let status = raw === "queued" ? "planned" : PLAN_ITEM_STATES.includes(raw) ? raw : "planned";
    if (accepted.has(id)) status = "accepted";
    /** @type {RunDeliverable['lastVerdict']} */
    let lastVerdict = status === "accepted" ? "pass" : attempts > 0 ? "issues" : undefined;
    if (terminal) {
      const filesShipped = shipped.some((file) => typeof file === "string" && file.startsWith(`deliverables/${id}/`));
      if (status === "accepted") {
        status = terminal.status === "succeeded" ? "delivered" : "accepted";
      } else if (filesShipped) {
        status = "delivered";
        lastVerdict = "unverified";
      } else if (status !== "planned") {
        status = "failed";
      }
    }
    deliverables.push({
      id,
      title: text(item?.title, maxTitle) || id,
      ...(text(item?.capability, 80) ? { capability: text(item?.capability, 80) } : {}),
      status,
      attempts,
      ...(lastVerdict ? { lastVerdict } : {}),
      ...(mustFixCount > 0 && status !== "accepted" && status !== "delivered" ? { mustFixCount } : {}),
      ...(childSessionId ? { childSessionId } : {}),
    });
  };
  for (const item of items) {
    const id = text(item?.id, 120);
    if (!id || seen.has(id) || deliverables.length >= maxDeliverables) continue;
    seen.add(id);
    place(item, id);
  }
  // A receipt entry with no plan item behind it is still a delivered package —
  // the same rule `deliverableFrames` follows.
  for (const entry of receipt?.entries ?? []) {
    const id = text(/** @type {any} */ (entry)?.deliverableId, 120);
    if (!id || seen.has(id) || deliverables.length >= maxDeliverables) continue;
    seen.add(id);
    place({ id, capability: /** @type {any} */ (entry)?.capability, status: "accepted", attempts: /** @type {any} */ (entry)?.attempt }, id);
  }
  return deliverables;
}

/**
 * The children a progress snapshot names, and what each is doing.
 *
 * Three observations, in order of authority: the kernel's own report that a
 * child session is running (its session list), the child's turn ending on its
 * own stream, and the run's plan index row for the delegation (which carries
 * the deliverable the child works on). The last is the model-adjacent one and
 * only ever names or labels a child; it never makes one look alive.
 *
 * @param {{
 *   projection?: Record<string, any> | null,
 *   kernelChildren?: readonly { sessionId: string, running: boolean }[],
 *   ended?: ReadonlyMap<string, string>,
 *   lastActivity?: ReadonlyMap<string, number>,
 * }} input
 * @returns {RunProgressChild[]}
 */
export function progressChildren({ projection = null, kernelChildren = [], ended = new Map(), lastActivity = new Map() }) {
  /** @type {Map<string, RunProgressChild>} */
  const children = new Map();
  const running = new Map(kernelChildren.map((child) => [child.sessionId, child.running === true]));
  const iso = (/** @type {string} */ id) => {
    const at = lastActivity.get(id);
    return Number.isFinite(at) && Number(at) > 0 ? new Date(Number(at)).toISOString() : null;
  };
  const stateOf = (/** @type {string} */ id, /** @type {string} */ settled) => {
    if (running.get(id) === true) return "running";
    const endKind = ended.get(id) ?? settled;
    if (endKind === "completed") return "done";
    if (["error", "aborted", "failed", "blocked", "max-tokens", "interrupted"].includes(endKind)) return "failed";
    if (running.get(id) === false) return "idle";
    return settled === "running" ? "running" : "idle";
  };
  for (const row of Array.isArray(projection?.subagents) ? projection.subagents : []) {
    const id = text(row?.childSessionId, 200);
    if (!id) continue;
    const deliverableId = text(row?.deliverableId, 120);
    children.set(id, {
      childSessionId: id,
      ...(deliverableId ? { deliverableId } : {}),
      state: /** @type {RunProgressChild['state']} */ (stateOf(id, String(row?.status ?? ""))),
      lastActivityAt: iso(id),
    });
  }
  for (const child of kernelChildren) {
    if (!child?.sessionId || children.has(child.sessionId)) continue;
    children.set(child.sessionId, {
      childSessionId: child.sessionId,
      state: /** @type {RunProgressChild['state']} */ (stateOf(child.sessionId, child.running ? "running" : "")),
      lastActivityAt: iso(child.sessionId),
    });
  }
  for (const id of ended.keys()) {
    if (children.has(id)) continue;
    children.set(id, { childSessionId: id, state: /** @type {RunProgressChild['state']} */ (stateOf(id, "")), lastActivityAt: iso(id) });
  }
  return [...children.values()].slice(0, maxChildren);
}

/**
 * The aggregate itself.
 *
 * `sources.searched` counts search calls; `included` counts the sources the
 * run's evidence ledger holds as readable (`ready` or `verified`), which is
 * what a reader means by "纳入"; `fullText` counts full texts a tool actually
 * preserved. Claims come from the claim tool's running totals when the run
 * used it, and otherwise from the delivered matrix (`matrixClaims`).
 *
 * @param {{
 *   deliverables: RunDeliverable[],
 *   calls: Iterable<ObservedCall>,
 *   projection?: Record<string, any> | null,
 *   matrixClaims?: { total: number, verified: number } | null,
 *   children: RunProgressChild[],
 *   usage?: RunUsage | null,
 *   startedAt: string | null,
 *   now: string,
 * }} input
 * @returns {RunProgress}
 */
export function assembleRunProgress({ deliverables, calls, projection = null, matrixClaims = null, children, usage = null, startedAt, now }) {
  // Oldest first, so `current` is the phase of the most recent labelled call
  // across the parent and every child.
  const list = [...calls].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  // The domain's one implementation, over the parent's and the children's
  // calls together: a delegated run does its searching in a child, and a
  // count of the parent alone would say it never searched.
  const { counts: phaseCounts, reached: reachedPhases, current: currentPhase } = summarizeRunPhases(list.map((call) => ({ tool: call.tool, input: call.input })));
  const byStatus = projection?.evidence?.byStatus && typeof projection.evidence.byStatus === "object" ? projection.evidence.byStatus : {};
  /** @type {Map<string, { total: number, verified: number }>} */
  const upserts = new Map();
  for (const call of list) if (call.claimTotals) upserts.set(call.claimTotals.deliverableId, call.claimTotals);
  // Since 2026-09-18 the plan index keeps each item's claim counts too
  // (`claims: {total, verified}`), which a run that restarted — or a reader
  // that never saw the claim tool's own calls — still has.
  const planned = (Array.isArray(projection?.plan?.items) ? projection.plan.items : [])
    .filter((/** @type {any} */ item) => item?.claims && typeof item.claims === "object");
  const claims = upserts.size
    ? [...upserts.values()].reduce((sum, value) => ({ total: sum.total + value.total, verified: sum.verified + value.verified }), { total: 0, verified: 0 })
    : planned.length
      ? planned.reduce((sum, /** @type {any} */ item) => ({ total: sum.total + count(item.claims.total), verified: sum.verified + count(item.claims.verified) }), { total: 0, verified: 0 })
      : { total: count(matrixClaims?.total), verified: count(matrixClaims?.verified) };
  return {
    deliverables,
    phaseCounts,
    // The phases this run actually reached, in order. A surface that renders
    // the six labels whatever happened tells a reader that 「筛选 0」 is a
    // thing the run did; only two tools carry that label and most runs never
    // call one.
    reachedPhases,
    currentPhase,
    sources: {
      searched: phaseCounts.search ?? 0,
      included: count(byStatus.ready) + count(byStatus.verified),
      fullText: list.filter((call) => call.fullText).length,
    },
    claims,
    children,
    ...(usage ? { usage } : {}),
    startedAt: startedAt ?? null,
    updatedAt: now,
  };
}

/** What changes when progress changes: everything but the clock.
 *  @param {RunProgress | null | undefined} progress */
export function progressDigest(progress) {
  if (!progress) return "";
  const { updatedAt: _updatedAt, ...rest } = progress;
  return JSON.stringify(rest);
}

/**
 * A deliverable list read back from the ledger. Non-throwing on a bad shape,
 * like every observational field: a ledger line that will not parse degrades
 * to "no plan recorded", never to an unreadable ledger.
 * @param {unknown} value @returns {RunDeliverable[] | undefined}
 */
export function normalizeStoredDeliverables(value) {
  if (!Array.isArray(value)) return undefined;
  /** @type {RunDeliverable[]} */
  const rows = [];
  for (const item of value.slice(0, maxDeliverables)) {
    if (!item || typeof item !== "object") continue;
    const id = text(item.id, 120);
    const status = String(item.status ?? "");
    if (!id || !RUN_DELIVERABLE_STATUSES.includes(status)) continue;
    const verdict = String(item.lastVerdict ?? "");
    rows.push({
      id,
      title: text(item.title, maxTitle) || id,
      ...(text(item.capability, 80) ? { capability: text(item.capability, 80) } : {}),
      status,
      attempts: count(item.attempts),
      ...(["pass", "issues", "unverified"].includes(verdict) ? { lastVerdict: /** @type {any} */ (verdict) } : {}),
      ...(count(item.mustFixCount) > 0 ? { mustFixCount: count(item.mustFixCount) } : {}),
      ...(text(item.childSessionId, 200) ? { childSessionId: text(item.childSessionId, 200) } : {}),
    });
  }
  return rows;
}

/**
 * A progress snapshot read back from the ledger, without its deliverables —
 * those are stored once, beside it, and put back by the reader.
 * @param {unknown} value @returns {Omit<RunProgress, 'deliverables'> | undefined}
 */
export function normalizeStoredProgress(value) {
  if (!value || typeof value !== "object") return undefined;
  const raw = /** @type {Record<string, any>} */ (value);
  /** @type {Record<string, number>} */
  const phaseCounts = Object.fromEntries(RUN_ACTIVITY_PHASES.map((phase) => [phase, count(raw.phaseCounts?.[phase])]));
  // Derived rather than trusted: a stored record from before this field exists
  // still knows which phases it reached, because its counts say so.
  const reachedPhases = RUN_ACTIVITY_PHASES.filter((phase) => phaseCounts[phase] > 0);
  const currentPhase = RUN_ACTIVITY_PHASES.includes(raw.currentPhase) ? raw.currentPhase : null;
  const children = (Array.isArray(raw.children) ? raw.children : []).slice(0, maxChildren).flatMap((/** @type {any} */ child) => {
    const id = text(child?.childSessionId, 200);
    if (!id) return [];
    const state = ["running", "idle", "done", "failed"].includes(child?.state) ? child.state : "idle";
    const at = typeof child?.lastActivityAt === "string" && Number.isFinite(Date.parse(child.lastActivityAt)) ? child.lastActivityAt : null;
    return [{ childSessionId: id, ...(text(child?.deliverableId, 120) ? { deliverableId: text(child.deliverableId, 120) } : {}), state, lastActivityAt: at }];
  });
  const usage = raw.usage && typeof raw.usage === "object" ? normalizeRunUsage(raw.usage) : undefined;
  const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null;
  if (!updatedAt) return undefined;
  return {
    phaseCounts,
    reachedPhases,
    currentPhase,
    sources: { searched: count(raw.sources?.searched), included: count(raw.sources?.included), fullText: count(raw.sources?.fullText) },
    claims: { total: count(raw.claims?.total), verified: count(raw.claims?.verified) },
    children,
    ...(usage ? { usage } : {}),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    updatedAt,
  };
}

/** @param {Record<string, any>} value @returns {RunUsage} */
export function normalizeRunUsage(value) {
  const cost = Number(value?.costCny);
  return {
    requests: count(value?.requests),
    inputTokens: count(value?.inputTokens),
    cachedInputTokens: count(value?.cachedInputTokens),
    outputTokens: count(value?.outputTokens),
    costCny: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) / 1e6 : 0,
  };
}

/**
 * What a claim matrix says about its own claims, for the record (C3).
 *
 * `total` counts every claim; `verified` those whose quotation was found in
 * the preserved source it names; `unverified` those whose quotation was not
 * found, whose source could not be read, or which name no quotation at all.
 * A derived claim is the analyst's own estimate — it has inputs, not a
 * quotation — so it is neither.
 *
 * @param {{ counts?: Record<string, number> } | null | undefined} verification a `claimVerification` result
 * @returns {{ total: number, verified: number, unverified: number } | null}
 */
export function claimSummaryOf(verification) {
  const counts = verification?.counts;
  if (!counts || typeof counts !== "object") return null;
  const total = Object.values(counts).reduce((sum, value) => sum + count(value), 0);
  if (!total) return null;
  return {
    total,
    verified: count(counts.verified),
    unverified: count(counts.quote_not_found) + count(counts.source_unavailable) + count(counts.no_quote),
  };
}
