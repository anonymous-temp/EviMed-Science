/**
 * The shell's half of what the kernel's page shows about a run: the run bound
 * to the conversation on screen, folded from the run's own event stream into
 * the one state the frame's cards and panels draw (C9 `run-state`), and the
 * claims and sources of its report (`evidence`).
 *
 * Why the shell and not the frame: the page on the runtime origin has no
 * session of the control plane's and must not get one. The run ledger, the
 * event stream and the file boundary are the shell's, so the shell reads them
 * and hands the frame values — never a path it could fetch, never a token.
 *
 * Hidden knowledge:
 *
 *  - A conversation is bound to the most recent run whose `sessionId` is its
 *    root session. A child's view (a delegated subagent) is the same run, which
 *    is why the caller passes the root session, not the one on screen.
 *  - The stream sends `run/state` first on every attach, so a finished run
 *    speaks at once; `run/progress` is the aggregate every progress surface
 *    renders (C5) and `deliverable/update` carries each planned item and, once
 *    accepted, its receipt — the files the gate took, which are artifacts
 *    before the ledger's own artifact list is final.
 *  - The frame redraws on every message, so the state is sent at most twice a
 *    second (the latest one always arrives), and the evidence — a matrix of up
 *    to hundreds of claims — only when the report it comes from changed.
 */
import { useEffect, useRef } from "react";
import { listWebAgentRuns, type WebAgentRun } from "./apiClient";
import { readArtifact, readClaimVerification } from "./artifactFile";
import { claimMatrixPathFor, parseClaimMatrix, type ClaimVerification } from "./claimCitations";
import { subscribeRunEvents, type RunStreamEvent } from "./runEvents";
import { listSources, type SourceRecord } from "./sourceClient";

/** One deliverable as the frame reads it (C3 `deliverables[]`). */
export interface FrameDeliverable {
  id: string;
  title: string;
  capability?: string;
  status: string;
  attempts: number;
  lastVerdict?: "pass" | "issues" | "unverified";
  mustFixCount?: number;
  childSessionId?: string;
}

/** The run state the frame receives (C9 `run-state`, plus the run's files and its session). */
export interface FrameRunState {
  runId: string | null;
  sessionId?: string;
  state?: string;
  phase?: string | null;
  verification?: string | null;
  title?: string | null;
  progress?: Record<string, unknown> | null;
  claimSummary?: Record<string, unknown> | null;
  artifacts?: string[];
  unverifiedArtifacts?: string[];
  updatedAt?: string;
}

/** The claims and sources behind a run's report (the frame's `evidence`). */
export interface FrameEvidence {
  runId: string;
  reportPath: string;
  matrixPath: string;
  claims: Array<{ claimId: string; claim: string; claimType: string; status: string; sourceTitle?: string; identifier?: string; url?: string; sourceType?: string }>;
  sources: Array<{ title: string; identifier?: string; url?: string; sourceType?: string; claims: number }>;
}

const REPORT_NAME = "clinical-evidence-report.md";
const MAX_CLAIMS = 400;
const MAX_CLAIM_TEXT = 300;
const MAX_SOURCES = 200;

/** The run bound to a conversation: the most recent one on its root session. */
export function boundRunFor(runs: readonly WebAgentRun[], sessionId: string | null | undefined): WebAgentRun | null {
  if (!sessionId) return null;
  const mine = runs.filter((run) => run.sessionId === sessionId);
  if (!mine.length) return null;
  const at = (run: WebAgentRun) => Date.parse(run.startedAt || run.createdAt) || 0;
  return mine.reduce((latest, run) => (at(run) > at(latest) ? run : latest));
}

/** Plan items of a running run, where the ledger has no deliverables of its own yet. */
function deliverablesFromPlan(run: WebAgentRun): FrameDeliverable[] {
  return (run.planItems ?? []).map((item) => ({ id: item.id, title: item.title, status: item.status, attempts: item.attempts }));
}

/** The frame's state as the ledger record gives it, before any event. */
export function runStateFromRecord(run: WebAgentRun): FrameRunState {
  const record = run as WebAgentRun & { title?: string | null; progress?: Record<string, unknown> | null;
    claimSummary?: Record<string, unknown> | null; deliverables?: FrameDeliverable[]; updatedAt?: string };
  const progress = record.progress && typeof record.progress === "object"
    ? record.progress
    : { deliverables: record.deliverables ?? deliverablesFromPlan(run), startedAt: run.startedAt ?? null, updatedAt: run.finishedAt ?? run.startedAt ?? null };
  return {
    runId: run.id,
    sessionId: run.sessionId,
    state: run.status,
    phase: run.phase ?? null,
    verification: run.verification ?? null,
    title: record.title ?? run.question ?? null,
    progress,
    claimSummary: record.claimSummary ?? null,
    artifacts: [...(run.artifacts ?? [])],
    unverifiedArtifacts: [...(run.unverifiedArtifacts ?? [])],
    updatedAt: run.finishedAt ?? run.lastProgressAt ?? run.startedAt,
  };
}

/** An event's own fields, without its envelope. */
function payloadOf(event: RunStreamEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "seq" && key !== "time" && key !== "type"));
}

/** Folds one stream event into the frame's state; events it does not read leave the state as it was. */
export function foldRunEvent(state: FrameRunState, event: RunStreamEvent): FrameRunState {
  const at = event.time || state.updatedAt;
  if (event.type === "run/state") {
    return {
      ...state,
      state: typeof event.state === "string" ? event.state : state.state,
      phase: typeof event.phase === "string" ? event.phase : state.phase ?? null,
      verification: typeof event.verification === "string" ? event.verification : state.verification ?? null,
      updatedAt: at,
    };
  }
  if (event.type === "run/progress") {
    const progress = payloadOf(event);
    // A progress frame without deliverables keeps the ones the item frames gave.
    const deliverables = Array.isArray(progress.deliverables) ? progress.deliverables : state.progress?.deliverables;
    return { ...state, progress: { ...progress, ...(deliverables ? { deliverables } : {}) }, updatedAt: at };
  }
  if (event.type === "deliverable/update" && typeof event.id === "string" && event.id) {
    const previous = Array.isArray(state.progress?.deliverables) ? (state.progress?.deliverables as FrameDeliverable[]) : [];
    const current = previous.find((item) => item.id === event.id);
    const receipt = event.receipt && typeof event.receipt === "object" ? event.receipt as { files?: Array<{ path?: unknown }>; attempt?: unknown } : null;
    const next: FrameDeliverable = {
      ...current,
      id: event.id,
      title: typeof event.title === "string" && event.title ? event.title : current?.title ?? event.id,
      ...(typeof event.capability === "string" && event.capability ? { capability: event.capability } : {}),
      status: typeof event.status === "string" ? event.status : current?.status ?? "planned",
      attempts: Math.max(current?.attempts ?? 0, typeof receipt?.attempt === "number" ? receipt.attempt : 0),
      ...(typeof event.childSessionId === "string" && event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    };
    const deliverables = current ? previous.map((item) => (item.id === event.id ? next : item)) : [...previous, next];
    // The files a receipt names were accepted by the gate: they are the
    // run's artifacts already, whatever the ledger's list says so far.
    const accepted = (receipt?.files ?? []).map((file) => file?.path).filter((path): path is string => typeof path === "string" && path.length > 0);
    const artifacts = accepted.length ? [...new Set([...(state.artifacts ?? []), ...accepted])] : state.artifacts;
    return { ...state, progress: { ...(state.progress ?? {}), deliverables }, artifacts, updatedAt: at };
  }
  return state;
}

/**
 * At most one send per interval, the latest state always arriving: the first
 * send goes at once, anything within the interval is held and the last of it
 * goes at the interval's end.
 */
export function createThrottledSender<T>(send: (value: T) => void, intervalMs = 500) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    last = Date.now();
    send(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer) return;
      const wait = last + intervalMs - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** The report a run delivered (accepted first, then written but not accepted). */
export function reportPathOf(state: FrameRunState): string | null {
  const paths = [...(state.artifacts ?? []), ...(state.unverifiedArtifacts ?? [])];
  return paths.find((path) => path.split("/").pop() === REPORT_NAME) ?? null;
}

/** The claims and cited sources of a matrix, bounded for the channel. */
export function frameEvidenceFrom(runId: string, reportPath: string, matrixPath: string, matrixText: string,
  verification: ClaimVerification | null): FrameEvidence {
  const statuses = new Map((verification?.claims ?? []).map((claim) => [claim.claimId, String(claim.status)]));
  const matrix = parseClaimMatrix(matrixText);
  // `sourceType` rides in the matrix when the run wrote it (C8); the parser
  // does not keep it, so it is read beside it.
  const types = new Map<string, string>();
  try {
    const parsed = JSON.parse(matrixText) as { claims?: Array<Record<string, unknown>> };
    for (const claim of parsed.claims ?? []) {
      if (typeof claim?.claimId === "string" && typeof claim.sourceType === "string") types.set(claim.claimId, claim.sourceType);
    }
  } catch { /* an unreadable matrix has no claims either */ }
  const claims: FrameEvidence["claims"] = [];
  const sources = new Map<string, FrameEvidence["sources"][number]>();
  for (const claim of matrix.values()) {
    if (claims.length >= MAX_CLAIMS) break;
    const text = claim.claim.length > MAX_CLAIM_TEXT ? `${claim.claim.slice(0, MAX_CLAIM_TEXT - 1)}…` : claim.claim;
    claims.push({
      claimId: claim.claimId,
      claim: text,
      claimType: claim.claimType,
      status: statuses.get(claim.claimId) ?? "unchecked",
      ...(claim.sourceTitle ? { sourceTitle: claim.sourceTitle } : {}),
      ...(claim.identifier ? { identifier: claim.identifier } : {}),
      ...(claim.sourceUrl ? { url: claim.sourceUrl } : {}),
      ...(types.get(claim.claimId) ? { sourceType: types.get(claim.claimId) } : {}),
    });
    const cited = [claim, ...(claim.supportingSources ?? [])];
    for (const source of cited) {
      const key = source.identifier || source.sourceUrl || source.sourceTitle;
      if (!key) continue;
      const known = sources.get(key);
      if (known) { known.claims += 1; continue; }
      if (sources.size >= MAX_SOURCES) continue;
      sources.set(key, {
        title: source.sourceTitle || source.identifier || key,
        ...(source.identifier ? { identifier: source.identifier } : {}),
        ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
        ...(source === claim && types.get(claim.claimId) ? { sourceType: types.get(claim.claimId) } : {}),
        claims: 1,
      });
    }
  }
  return { runId, reportPath, matrixPath, claims, sources: [...sources.values()] };
}

/** Reads the evidence behind a report, or null when there is no matrix beside it. */
export async function readFrameEvidence(runId: string, reportPath: string): Promise<FrameEvidence | null> {
  const matrixPath = claimMatrixPathFor(reportPath);
  if (!matrixPath) return null;
  const file = await readArtifact(matrixPath, "workspace");
  if (!file || file.encoding !== "utf8") return null;
  const verification = await readClaimVerification(matrixPath, "workspace").catch(() => null);
  return frameEvidenceFrom(runId, reportPath, matrixPath, file.data, verification);
}

export interface FrameRunBindingOptions {
  /** The root session of the conversation on screen; null while none is open. */
  sessionId: string | null;
  /** Off until the frame's bridge is listening. */
  enabled: boolean;
  postRunState: (state: FrameRunState) => void;
  postEvidence: (evidence: FrameEvidence | null) => void;
  /** How often the ledger is asked for a newer run while none is running. */
  pollMs?: number;
}

/**
 * Keeps the frame's run state current for the conversation on screen: binds
 * the run, follows its stream, re-reads its record when it ends, and looks for
 * a newer run while the bound one is not running (a follow-up question in the
 * same conversation is a new run). Clears the frame's state when the
 * conversation changes or has no run.
 */
export function useFrameRunBinding({ sessionId, enabled, postRunState, postEvidence, pollMs = 20_000 }: FrameRunBindingOptions): void {
  const posts = useRef({ postRunState, postEvidence });
  posts.current = { postRunState, postEvidence };

  useEffect(() => {
    if (!enabled || !sessionId) {
      if (enabled) { posts.current.postRunState({ runId: null }); posts.current.postEvidence(null); }
      return undefined;
    }
    let active = true;
    let state: FrameRunState = { runId: null };
    let unsubscribe: (() => void) | null = null;
    let evidenceKey = "";
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const sender = createThrottledSender<FrameRunState>((value) => posts.current.postRunState(value));

    const refreshEvidence = () => {
      const reportPath = reportPathOf(state);
      const key = reportPath && state.runId ? `${state.runId}:${reportPath}:${state.state}:${(state.artifacts ?? []).length}` : "";
      if (key === evidenceKey) return;
      evidenceKey = key;
      if (!reportPath || !state.runId) { posts.current.postEvidence(null); return; }
      const runId = state.runId;
      void readFrameEvidence(runId, reportPath).then((evidence) => {
        if (active && state.runId === runId) posts.current.postEvidence(evidence);
      }).catch(() => { /* the tabs say there is nothing yet; the next change reads again */ if (active) evidenceKey = ""; });
    };
    const publish = () => { sender.push(state); refreshEvidence(); };

    const bind = (run: WebAgentRun | null) => {
      if (!active) return;
      if (!run) {
        if (state.runId !== null) { state = { runId: null }; publish(); }
        else if (!unsubscribe) { sender.push(state); posts.current.postEvidence(null); }
        return;
      }
      const sameRun = state.runId === run.id;
      state = sameRun ? { ...runStateFromRecord(run), progress: state.progress ?? runStateFromRecord(run).progress } : runStateFromRecord(run);
      publish();
      if (sameRun && unsubscribe) return;
      unsubscribe?.();
      unsubscribe = subscribeRunEvents(run.id, (event) => {
        if (!active || state.runId !== run.id) return;
        const before = state.state;
        state = foldRunEvent(state, event);
        publish();
        // The end of a run is when its record carries the final files and title.
        if (event.type === "run/state" && before === "running" && state.state !== "running") schedule(0);
      });
    };

    const lookup = async () => {
      try {
        const runs = await listWebAgentRuns();
        bind(boundRunFor(runs, sessionId));
      } catch { /* the ledger is unreachable for now; the next poll asks again */ }
      if (active && state.state !== "running") schedule(pollMs);
    };
    function schedule(ms: number) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => { pollTimer = null; void lookup(); }, ms);
    }

    void lookup();
    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
      unsubscribe?.();
      sender.cancel();
    };
  }, [sessionId, enabled, pollMs]);
}

/** One knowledge-base source the frame's `@` menu offers (`kb-result` items). */
export interface FrameKnowledgeItem {
  id: string;
  title: string;
  detail?: string;
}

const KNOWLEDGE_CACHE_MS = 30_000;
const knowledgeCache = new Map<string, { at: number; items: Promise<SourceRecord[]> }>();

/** The project's parsed sources, fetched at most every 30 s: the `@` menu asks on every keystroke. */
function parsedSources(projectId: string): Promise<SourceRecord[]> {
  const cached = knowledgeCache.get(projectId);
  if (cached && Date.now() - cached.at < KNOWLEDGE_CACHE_MS) return cached.items;
  const items = listSources(projectId, { status: "complete" }).then((page) => page.items.filter((item) => !item.deletedAt));
  knowledgeCache.set(projectId, { at: Date.now(), items });
  items.catch(() => { if (knowledgeCache.get(projectId)?.items === items) knowledgeCache.delete(projectId); });
  return items;
}

/** A source's name for a reader: its file's name, never its id. */
function sourceTitle(record: SourceRecord): string {
  const path = record.payload.paths?.[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1) || record.id;
}

/**
 * The `@` menu's answer for one query: the project's parsed sources whose name
 * or summary contains it, at most twenty. Only parsed sources, because the
 * reference points the run at the parsed text, which a queued source does not
 * have yet.
 */
export async function searchKnowledgeSources(projectId: string, query: string): Promise<FrameKnowledgeItem[]> {
  const needle = query.trim().toLowerCase();
  const records = await parsedSources(projectId);
  return records
    .filter((record) => /^src_[A-Za-z0-9_-]{1,120}$/.test(record.id))
    .map((record) => {
      const summary = record.payload.outputs?.summary?.trim();
      return { id: record.id, title: sourceTitle(record), ...(summary ? { detail: summary.length > 80 ? `${summary.slice(0, 79)}…` : summary } : {}) };
    })
    .filter((item) => !needle || item.title.toLowerCase().includes(needle) || (item.detail?.toLowerCase().includes(needle) ?? false))
    .slice(0, 20);
}

/** Forget cached source lists (tests; a project switch refetches anyway). */
export function forgetKnowledgeSources(): void {
  knowledgeCache.clear();
}

