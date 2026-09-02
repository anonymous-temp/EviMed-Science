import { create } from "zustand";
import {
  RuntimeClient,
  DEFAULT_RUNTIME_URL,
  type AgentInfo,
  type CommandInfo,
  type HistoryMessage,
  type RuntimeEvent,
  type PermissionAskedEvent,
  type PermissionReply,
  type QuestionAskedEvent,
  type SessionMeta,
  type SkillInfo,
  type ToolCallStatus,
} from "@ai4s/sdk";
import type { ArtifactBlock, RuntimeStatus, ThreadBlock } from "@ai4s/shared";
import {
  detectTools as probeTools,
  getApprovalMode,
  isTauri,
  logDebug,
  newDatedWorkspace,
  runtimePassword,
  setApprovalMode as persistApprovalMode,
  setWorkspace,
  startRuntime,
  workspacePath,
  type ApprovalMode,
  type ToolStatus,
} from "./tauri";
import {
  fetchWithWebAuth,
  fetchWebMe,
  dispatchWebAgentRun,
  getWebProjectId,
  hasCommandBackend,
  hasWebApi,
  listWebResearchAgents,
  listWebAgentRuns,
  listWebResearchSessions,
  putWebResearchSession,
  setWebProjectId,
  type WebResearchAgent,
  type WebResearchSession,
  type WebResearchSessionSelection,
} from "./apiClient";
import { kernelReset } from "./kernel";
import { moveScrollMemory } from "./scrollMemory";
import { artifactWorkspaceKey, deriveArtifact } from "./artifacts";
import { provenanceInputFromEvent, recordProvenance } from "./provenance";
import { recordRun, runInputFromEvent } from "./runs";
import { splitReview } from "./review";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Keeps the retired kernel's name because it is persisted state, not source:
// renaming it would silently discard the runtime URL every existing install
// has already saved.
const URL_KEY = "ai4s.opencodeUrl";
const HIDDEN_KEY = "ai4s.hiddenExamples";
/** Local session-title overrides (inline rename) — see sessionTitles below. */
const TITLE_KEY = "ai4s.sessionTitles";

function userFacingRuntimeError(error: unknown): string {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
  if (errorCode) {
    const known: Record<string, string> = {
      // Never name a model here. This said "DeepSeek V4 Pro" while the
      // deployment was running V4 Flash, so the message told the reader to go
      // configure something that was already configured, under the wrong name.
      // Which model is certified is a deployment fact, not a UI string.
      model_provider_not_configured: "科研模型尚未配置，请在服务端完成模型配置后重试。",
      // Said "Too many running runtimes for this user; limit is 2." — a server
      // term for a state the reader can act on, in the wrong language.
      runtime_limit_exceeded: "同时进行的分析任务已达上限。请等待正在执行的任务完成后再提交，分析通常需要数十分钟。",
      runtime_mcp_config_collision: "科研工具配置发生冲突，请联系管理员检查运行时配置。",
      runtime_bootstrap_failed: "科研服务启动失败，请联系管理员检查运行时配置。",
      runtime_model_provider_unavailable: "科研模型服务当前不可用，请稍后重试。",
    };
    const knownMessage = known[errorCode];
    if (knownMessage) return `${knownMessage}（错误码：${errorCode}）`;
  }
  const message = error instanceof Error ? error.message : String(error);
  // The desktop shell bundles no agent kernel any more: `spawn_sidecar` in
  // src-tauri answers every local start with this code, and this is the only
  // place the person running the app ever sees it. Matched on the code and not
  // on the sentence, so the Rust side can reword its developer-facing text
  // without silently dropping an English string into a Chinese UI.
  if (/^local_agent_kernel_removed\b/.test(message)) {
    return "此版本的桌面客户端不再内置智能体运行时。请使用托管部署，或在本机启动 evimed-web 本地配置（pnpm dev:evimed）后连接。";
  }
  if (/Runtime did not reconnect after creating the session folder/i.test(message)) {
    return "创建任务空间后未能连接科研服务，请重试或联系管理员。";
  }
  if (/Could not open the runtime event stream|Runtime \/event returned/i.test(message)) {
    return "无法连接 EviMed 科研服务。";
  }
  if (/Model not found|ProviderModelNotFoundError/i.test(message)) {
    return `科研模型配置无效：${message}`;
  }
  return message;
}

function initialUrl(): string {
  if (typeof window === "undefined") return DEFAULT_RUNTIME_URL;
  return window.localStorage.getItem(URL_KEY) ?? DEFAULT_RUNTIME_URL;
}
function initialHidden(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function initialSessionTitles(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TITLE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  loaded: boolean;
}

/** What a session's right pane shows: an artifact inspector, the Files
 *  browser, or nothing. The two are mutually exclusive — one pane. */
export interface PaneState {
  artifact: ArtifactBlock | null;
  showFiles: boolean;
}

interface RuntimeState {
  status: RuntimeStatus;
  serverUrl: string;
  sessions: SessionMeta[];
  /** Local session-title overrides from inline rename, by session id.
   *  TODO: persist server-side once the SDK grows a session rename/update
   *  method (RuntimeClient has none today) — until then overrides live in
   *  localStorage and win over the server title at display time. */
  sessionTitles: Record<string, string>;
  /** Set (or, with an empty title, clear) a session's local title override. */
  renameSession: (id: string, title: string) => void;
  currentId: string | null;
  threads: Record<string, Thread>;
  skills: SkillInfo[];
  agents: AgentInfo[];
  /** Slash commands the runtime can run ("/" palette): config commands,
   *  skills and MCP prompts, one merged list from GET /command. */
  commands: CommandInfo[];
  /** Configured default model ("provider/model"), or null when unset. */
  defaultModel: string | null;
  researchAgents: WebResearchAgent[];
  researchSessionBindings: Record<string, WebResearchSession>;
  /** Hosted run currently accounting for each active runtime turn. */
  activeAgentRuns: Record<string, string>;
  draftResearchAgent: WebResearchAgent | null;
  specialtySelectionPending: boolean;
  loadResearchAgents: () => Promise<WebResearchAgent[]>;
  startSpecialistDraft: (agentId: string) => Promise<void>;
  /** The composer's approval switch: "approve" (dangerous commands prompt)
   *  or "full" (everything in-workspace runs). Loaded from OpenCode config. */
  approvalMode: ApprovalMode;
  /** Persist a new approval mode (restarts the sidecar) and reconnect. */
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  tools: ToolStatus[];
  hiddenExamples: string[];
  error: string | null;
  /** Pending interactive requests the agent is blocked on, newest last. */
  questions: QuestionAskedEvent[];
  permissions: PermissionAskedEvent[];
  /** Subagent session → the session whose task tool spawned it, learned from
   *  task tool events (live) and the session list (recovery after reload). */
  sessionParents: Record<string, string>;
  /** Right-pane state per session (DRAFT_KEY for a draft) — each session keeps
   *  its own open artifact / Files browser and gets it back when reopened.
   *  In-memory only: an app restart returns every session to a closed pane. */
  panes: Record<string, PaneState>;
  openArtifact: (a: ArtifactBlock) => void;
  closeArtifact: () => void;
  setShowFiles: (show: boolean) => void;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: PermissionReply) => Promise<void>;
  setServerUrl: (url: string) => void;
  loadCatalog: () => Promise<void>;
  detectTools: () => Promise<void>;
  connect: () => Promise<void>;
  connectRetry: (tries?: number) => Promise<void>;
  bootstrap: () => Promise<boolean>;
  disconnect: () => void;
  resetProjectState: () => void;
  switchHostedProject: (projectId: string) => Promise<void>;
  /** Drop all account/project-derived browser memory after hosted logout. */
  clearHostedSession: () => void;
  refreshSessions: () => Promise<void>;
  startDraft: (agent?: WebResearchAgent | null) => void;
  /** Active workspace display path. Desktop stores an absolute local path;
   *  hosted Web stores a scoped `/workspace/<project>` display path. */
  workspace: string | null;
  /** True when the user explicitly picked the active folder for the next new
   *  session; false means a new session gets its own fresh dated folder. */
  workspacePinned: boolean;
  /** A deliberate workspace move is in flight (event-stream reconnect into the
   *  new folder). The UI must not present it as a disconnection — no status
   *  flip, no Connect button, no help card. Real failures surface after the
   *  retry window is exhausted, once this clears. */
  switching: boolean;
  /** A sendPrompt is in flight (click → POST accepted). Locks the composer. */
  sending: boolean;
  /** Sessions with an active turn (send accepted, session.idle not yet seen).
   *  Drives the composer lock and the "Working…" indicator. */
  runningSessions: Record<string, true>;
  /** Sessions whose current turn is a user-typed "!" shell command. Their bash
   *  output shows inline in the thread — the output IS the result the user
   *  asked for. Agent bash steps stay quiet single-line log entries. */
  shellTurns: Record<string, true>;
  /** Switch to an existing folder, or (with `dated`) create a new dated one. */
  switchWorkspace: (target: { path: string } | { dated: string }) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<string | null>;
  /** Run a "!" shell command directly in the session's workspace folder —
   *  no model turn; the output folds into the thread as a bash tool row. */
  runShell: (command: string) => Promise<string | null>;
  /** Run a "/" slash command (config command / skill / MCP prompt). */
  runCommand: (name: string, args?: string) => Promise<string | null>;
  /** Interrupt the current session's running turn (Stop button / Esc). */
  interrupt: () => Promise<void>;
  /** Check every session holding a running lock against the server: if its
   *  turn is actually over (idle was missed — SSE reconnect windows, the
   *  directory-scoped event stream), reload the missed history and unlock. */
  reconcileRunning: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  hideExample: (id: string) => void;
  installSkill: (text: string) => Promise<string | null>;
}

let client: RuntimeClient | null = null;
/** Unhook the current client's status listener BEFORE closing it — teardown
 *  emits "offline", and a reconnect attempt must not flash that at the user. */
let clientStatusUnsub: (() => void) | null = null;
function teardownClient() {
  clientStatusUnsub?.();
  clientStatusUnsub = null;
  client?.close();
  client = null;
}
const emptyThread = (): Thread => ({ blocks: [], index: {}, loaded: false });
/** Threads key for the draft conversation — its blocks move to the real
 *  session id once the session exists, so the page never visibly resets. */
export const DRAFT_KEY = "draft";
/** One bounded retry for the first POSTs after a sidecar restart — the old
 *  connection occasionally dies mid-handshake ("Load failed"). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(600);
    return await fn();
  }
}
/** Tool calls already written to provenance — success events can repeat per callId. */
const recordedProvenance = new Set<string>();
/** Tool calls already persisted to the local reproducibility ledger. */
const recordedRuns = new Set<string>();

/** Sessions the user just interrupted: the thread already shows "Interrupted",
 *  so the abort's own trailing events (an "aborted" error, session.idle) must
 *  not add a second line. Consumed by the idle event; a new turn clears it. */
const interruptedSessions = new Set<string>();
let hostedRunRefresh: Promise<void> | null = null;
let hostedRunGeneration = 0;
let draftSelectionGeneration = 0;
type SpecialtySelectionOutcome = {
  status: "completed" | "cancelled";
  generation: number;
};

let pendingSpecialtySelection: {
  generation: number;
  promise: Promise<SpecialtySelectionOutcome>;
  canceled: Promise<SpecialtySelectionOutcome>;
  cancel: () => void;
} | null = null;

function cancelPendingSpecialtySelection() {
  pendingSpecialtySelection?.cancel();
  pendingSpecialtySelection = null;
}

async function awaitPendingSpecialtySelection(): Promise<SpecialtySelectionOutcome> {
  const pending = pendingSpecialtySelection;
  if (!pending) return { status: "completed", generation: draftSelectionGeneration };
  const outcome = await Promise.race([pending.promise, pending.canceled]);
  if (outcome.status === "cancelled" || outcome.generation !== draftSelectionGeneration) {
    return { status: "cancelled", generation: outcome.generation };
  }
  return outcome;
}

/** Server-side truth for "is this session's turn over": the last message is an
 *  assistant message that has finished streaming (time.completed set). A last
 *  USER message means a turn was accepted but not yet answered — still running. */
export function turnIsOver(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && !!last.completed;
}

/** Last SSE arrival per session (monotonic sequence, not wall time). Lets a
 *  failed sync POST tell "the connection died but the turn is alive" (events
 *  kept arriving after the POST began) from "the send never took" — WKWebView
 *  kills any fetch at ~60 s, long before a long agent turn finishes. */
let sseSeq = 0;
const sseLast = new Map<string, number>();

/** Coalescing for live bash output: a running tool emits an event per stdout
 *  write (a progress bar redraws dozens of times a second) — fold at most one
 *  partial-output update per interval per call, latest event wins. */
const LIVE_FOLD_MS = 250;
const liveFoldLast = new Map<string, number>();
const liveFoldPending = new Map<
  string,
  { sessionId: string; timer: number; event: Extract<RuntimeEvent, { type: "tool.updated" }> }
>();

/** Coalescing for streamed agent text: text.updated fires per token and every
 *  fold re-renders the whole ReactMarkdown block — buffer per text part and
 *  apply the accumulated text at most once per LIVE_FOLD_MS (latest wins).
 *  Any other event flushes the buffer first, so block order matches arrival
 *  order and a turn's end/interrupt always applies the final text state. */
const textFoldLast = new Map<string, number>();
const textFoldPending = new Map<
  string,
  { sessionId: string; timer: number; event: Extract<RuntimeEvent, { type: "text.updated" }> }
>();

/** Apply every buffered text fold for a session NOW (timer or not), in arrival
 *  order. Called before any non-text event folds, and at turn end/interrupt,
 *  so the terminal text state is always complete. */
function flushTextFolds(sessionId: string, set: StoreSet) {
  const events: Extract<RuntimeEvent, { type: "text.updated" }>[] = [];
  for (const [partId, p] of textFoldPending) {
    if (p.sessionId !== sessionId) continue;
    window.clearTimeout(p.timer);
    textFoldPending.delete(partId);
    textFoldLast.set(partId, Date.now());
    events.push(p.event);
  }
  if (events.length === 0) return;
  set((s) => {
    const cur = s.threads[sessionId] ?? emptyThread();
    let folded: FoldState = { blocks: cur.blocks, index: cur.index };
    for (const ev of events) folded = foldEvent(folded, ev, { shellTurn: !!s.shellTurns[sessionId] });
    return { threads: { ...s.threads, [sessionId]: { ...cur, ...folded, loaded: true } } };
  });
}

/** Drop a session's buffered text folds WITHOUT applying them — only where the
 *  thread is being replaced by full server history (which already carries the
 *  final text), so a late timer can't append a duplicate block. */
function clearTextFolds(sessionId: string) {
  for (const [partId, p] of textFoldPending) {
    if (p.sessionId !== sessionId) continue;
    window.clearTimeout(p.timer);
    textFoldPending.delete(partId);
    textFoldLast.delete(partId);
  }
}

/** Drop a session's queued partial folds — when its turn ends (idle, error,
 *  interrupt) a late timer must not fold a stale "running" event into a
 *  thread the history reload may have rebuilt. */
function clearLiveFolds(sessionId: string) {
  for (const [callId, p] of liveFoldPending) {
    if (p.sessionId !== sessionId) continue;
    window.clearTimeout(p.timer);
    liveFoldPending.delete(callId);
    liveFoldLast.delete(callId);
  }
}

function clearRuntimeEphemera() {
  for (const pending of liveFoldPending.values()) clearTimeout(pending.timer);
  liveFoldPending.clear();
  liveFoldLast.clear();
  for (const pending of textFoldPending.values()) clearTimeout(pending.timer);
  textFoldPending.clear();
  textFoldLast.clear();
  recordedProvenance.clear();
  interruptedSessions.clear();
  sseLast.clear();
  sseSeq = 0;
  hostedRunRefresh = null;
}

function newHostedDispatchId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `turn_${random.slice(0, 48)}`;
}

async function refreshHostedRuns(set: StoreSet, markRunning = false): Promise<void> {
  if (!hasWebApi) return;
  if (hostedRunRefresh) return hostedRunRefresh;
  const generation = hostedRunGeneration;
  const request = listWebAgentRuns().then((runs) => {
    if (generation !== hostedRunGeneration) return;
    const running = runs.filter((run) => run.status === "running");
    const activeAgentRuns = Object.fromEntries(running.map((run) => [run.sessionId, run.id]));
    set((state) => ({
      activeAgentRuns,
      ...(markRunning ? {
        runningSessions: {
          ...state.runningSessions,
          ...Object.fromEntries(running.map((run) => [run.sessionId, true as const])),
        },
      } : {}),
    }));
  }).finally(() => {
    if (hostedRunRefresh === request) hostedRunRefresh = null;
  });
  hostedRunRefresh = request;
  return request;
}

/** Resolve a (possibly nested) subagent session to its top-level session —
 *  a subagent's question/permission belongs to the conversation the user sees. */
export function rootSessionOf(parents: Record<string, string>, sessionId: string): string {
  let cur = sessionId;
  for (let hop = 0; parents[cur] && hop < 10; hop++) cur = parents[cur];
  return cur;
}

type StoreSet = {
  (partial: Partial<RuntimeState>): void;
  (fn: (s: RuntimeState) => Partial<RuntimeState>): void;
};
type StoreGet = () => RuntimeState;

/** Replace transient interactive requests with the runtime's current truth.
 *  SSE frames are not replayed by every OpenCode version, so reconnecting must
 *  also remove requests that resolved while the browser was offline. */
async function refreshInteractiveRequests(c: RuntimeClient, set: StoreSet): Promise<void> {
  const [questions, permissions] = await Promise.all([
    c.listQuestions(),
    c.listPermissions(),
  ]);
  if (client !== c) return;
  set({ questions, permissions });
}

async function refreshSessionIndex(c: RuntimeClient, set: StoreSet): Promise<void> {
  const sessions = await c.listSessions();
  if (client !== c) return;
  set((s) => {
    const sessionParents = { ...s.sessionParents };
    for (const meta of sessions) if (meta.parentId) sessionParents[meta.id] = meta.parentId;
    return { sessions, sessionParents };
  });
}

/** Recover state that may have changed while an established SSE connection was
 *  down. EventSource reconnects the transport; these reads repair missed state. */
async function recoverAfterEventReconnect(
  c: RuntimeClient,
  set: StoreSet,
  get: StoreGet,
): Promise<void> {
  void logDebug("event stream reconnected; recovering runtime state");
  await Promise.allSettled([
    refreshSessionIndex(c, set),
    refreshInteractiveRequests(c, set),
    refreshHostedRuns(set, true),
  ]);
  if (client !== c) return;
  await get().reconcileRunning();
}

async function loadHostedResearchBindings(): Promise<WebResearchSession[]> {
  if (!hasWebApi) return [];
  return listWebResearchSessions();
}

function localResearchBinding(
  sessionId: string,
  selection: WebResearchSessionSelection,
  agent: WebResearchAgent | null,
): WebResearchSession {
  const now = new Date().toISOString();
  return selection.mode === "specialist" && agent
    ? {
        sessionId,
        mode: "specialist",
        agentId: agent.id,
        agentVersion: agent.version,
        runtimeAgent: agent.runtimeAgent,
        createdAt: now,
        updatedAt: now,
      }
    : {
        sessionId,
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        createdAt: now,
        updatedAt: now,
      };
}

async function ensureResearchSessionBinding(
  sessionId: string,
  set: StoreSet,
  get: StoreGet,
): Promise<WebResearchSession> {
  const cached = get().researchSessionBindings[sessionId];
  if (cached) return cached;

  if (hasWebApi) {
    const persisted = (await loadHostedResearchBindings()).find((record) => record.sessionId === sessionId);
    if (persisted) {
      set((state) => ({
        researchSessionBindings: { ...state.researchSessionBindings, [sessionId]: persisted },
      }));
      return persisted;
    }
  }

  const draftAgent = get().draftResearchAgent;
  const selection: WebResearchSessionSelection = draftAgent
    ? { mode: "specialist", agentId: draftAgent.id, agentVersion: draftAgent.version }
    : { mode: "open-domain" };
  const binding = hasWebApi
    ? await putWebResearchSession(sessionId, selection)
    : localResearchBinding(sessionId, selection, draftAgent);
  set((state) => ({
    researchSessionBindings: { ...state.researchSessionBindings, [sessionId]: binding },
    draftResearchAgent: null,
  }));
  return binding;
}

async function restoreResearchSessionBinding(
  sessionId: string,
  set: StoreSet,
  get: StoreGet,
): Promise<WebResearchSession | null> {
  const cached = get().researchSessionBindings[sessionId];
  if (cached) return cached;
  if (!hasWebApi) return null;
  const binding = (await loadHostedResearchBindings()).find((record) => record.sessionId === sessionId) ?? null;
  if (binding) {
    set((state) => ({
      researchSessionBindings: { ...state.researchSessionBindings, [sessionId]: binding },
    }));
  }
  return binding;
}

function blankDraftState(
  state: RuntimeState,
  agent: WebResearchAgent | null,
): Partial<RuntimeState> {
  const threads = { ...state.threads };
  delete threads[DRAFT_KEY];
  const panes = { ...state.panes };
  delete panes[DRAFT_KEY];
  return {
    currentId: null,
    workspacePinned: false,
    threads,
    panes,
    draftResearchAgent: agent,
    error: null,
  };
}

/**
 * The one send lifecycle (new → input → send → response), shared by plain
 * prompts, "!" shell commands and "/" slash commands:
 *   1. `echo` lands in the thread IMMEDIATELY — on a draft under DRAFT_KEY,
 *      grafted onto the real session id later, so the page never resets.
 *   2. `sending` is true from click until the POST is accepted (locks the
 *      composer); the session sits in `runningSessions` while the turn runs.
 *   3. Failures land as a red status line inside the conversation.
 * `syncTurn` marks endpoints whose POST resolves only when the turn is OVER
 * (shell/command, unlike prompt_async) — their running lock is set BEFORE the
 * POST and cleared when it settles, because session.idle arrives before the
 * POST resolves and a lock set afterwards would never clear.
 * `shell` additionally marks the turn in `shellTurns` for its duration, so
 * the event fold shows the bash output inline.
 */
async function performTurn(
  set: StoreSet,
  get: StoreGet,
  echo: string,
  post: (sid: string) => Promise<void>,
  syncTurn: boolean,
  shell = false,
): Promise<string | null> {
  if (!client) {
    set({ error: "尚未连接 EviMed 科研服务。" });
    return null;
  }
  if (get().sending) return null; // one send at a time
  set({ sending: true });
  try {
    if (pendingSpecialtySelection) {
      const selection = await awaitPendingSpecialtySelection();
      if (selection.status === "cancelled") return null;
    }
    const echoKey = get().currentId ?? DRAFT_KEY;
    set((s) => {
      const cur = s.threads[echoKey] ?? emptyThread();
      return {
        threads: {
          ...s.threads,
          [echoKey]: { ...cur, loaded: true, blocks: [...cur.blocks, { kind: "user", text: echo }] },
        },
      };
    });
    let id = get().currentId;
    if (!id) {
      // Lazy-create the session on the first message (#3). Unless the user
      // pinned a folder via the workspace switcher, a new session gets its
      // own fresh dated folder (~/Documents/EviMed/<date-time>) first,
      // so its files never pile up in the bare base folder.
      if ((isTauri || hasCommandBackend) && !get().workspacePinned) {
        set({ switching: true });
        try {
          await newDatedWorkspace(datedWorkspaceName());
          await kernelReset().catch(() => {});
          // Hosted workspace switches intentionally stop the old runtime.
          // Start the replacement explicitly so bootstrap/configuration errors
          // reach the conversation immediately instead of being hidden behind
          // the long EventSource reconnect window.
          if (hasWebApi) {
            const url = await startRuntime();
            if (url) set({ serverUrl: url });
          }
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect after creating the session folder.");
        }
      }
      id = await withRetry(() => client!.createSession());
      set((s) => {
        // Graft the draft conversation (and its pane) onto the real session id.
        const threads = { ...s.threads, [id!]: s.threads[DRAFT_KEY] ?? emptyThread() };
        delete threads[DRAFT_KEY];
        const panes = { ...s.panes };
        if (panes[DRAFT_KEY]) {
          panes[id!] = panes[DRAFT_KEY];
          delete panes[DRAFT_KEY];
        }
        return { currentId: id, threads, panes };
      });
      moveScrollMemory(`chat:${DRAFT_KEY}`, `chat:${id}`);
      void get().refreshSessions();
    }
    const sid = id;
    await ensureResearchSessionBinding(sid, set, get);
    interruptedSessions.delete(sid); // a fresh turn folds its events normally
    void logDebug(`turn → ${sid}`);
    set((s) => ({
      runningSessions: { ...s.runningSessions, [sid]: true },
      ...(shell ? { shellTurns: { ...s.shellTurns, [sid]: true as const } } : {}),
    }));
    const mark = sseSeq;
    try {
      await post(sid);
    } catch (err) {
        // The POST rejected — but shell/command POSTs are held open for the
        // WHOLE turn, and WKWebView kills any fetch at ~60 s. If SSE kept
        // streaming this session since the POST began, the turn is alive
        // server-side: keep the running lock (session.idle or a session error
        // will clear it) and don't report a failure that didn't happen.
      if ((sseLast.get(sid) ?? 0) > mark) {
        void logDebug(`turn POST dropped mid-turn, still running → ${sid}`);
        return sid;
      }
      if (hasWebApi) {
        await refreshHostedRuns(set).catch(() => {});
        if (get().activeAgentRuns[sid]) {
          void logDebug(`turn dispatch response lost after server acceptance → ${sid}`);
          return sid;
        }
      }
        // A genuinely failed POST produces no events — drop both flags here.
        // (On success the session.idle event clears the shell flag, never the
        // POST settling: SSE frames and the POST response race on separate
        // connections, and the bash-output event may land after the POST
        // resolves.)
      set((s) => {
        const runningSessions = { ...s.runningSessions };
        const shellTurns = { ...s.shellTurns };
        delete runningSessions[sid];
        delete shellTurns[sid];
        return { runningSessions, shellTurns };
      });
      await refreshHostedRuns(set);
      throw err;
    }
    if (syncTurn) {
      set((s) => {
        const runningSessions = { ...s.runningSessions };
        delete runningSessions[sid];
        return { runningSessions };
      });
      await refreshHostedRuns(set);
    }
    void logDebug("turn OK");
    return sid;
  } catch (err) {
    await refreshHostedRuns(set);
    const msg = userFacingRuntimeError(err);
    void logDebug(`turn FAILED: ${msg}`);
    // The failure belongs next to the message that caused it.
    const key = get().currentId ?? DRAFT_KEY;
    set((s) => {
      const cur = s.threads[key] ?? emptyThread();
      return {
        // Turn failures already render beside the triggering user message;
        // keeping the same text in the page-level banner duplicates it.
        error: null,
        threads: {
          ...s.threads,
          [key]: {
            ...cur,
            loaded: true,
            blocks: [
              ...cur.blocks,
              // The failed turn's own text rides along — the status line
              // renders a resend button from it (normal send path).
              { kind: "status-line", text: `发送失败：${msg}`, tone: "error", retryText: echo },
            ],
          },
        },
      };
    });
    return get().currentId;
  } finally {
    set({ sending: false });
  }
}

/** The live runtime client (Settings talks to the runtime's config API directly). */
export function getClient(): RuntimeClient | null {
  return client;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  serverUrl: initialUrl(),
  sessions: [],
  sessionTitles: initialSessionTitles(),
  renameSession: (id, title) => {
    const sessionTitles = { ...get().sessionTitles };
    const trimmed = title.trim();
    if (trimmed) sessionTitles[id] = trimmed;
    else delete sessionTitles[id];
    if (typeof window !== "undefined") window.localStorage.setItem(TITLE_KEY, JSON.stringify(sessionTitles));
    set({ sessionTitles });
  },
  currentId: null,
  threads: {},
  skills: [],
  agents: [],
  commands: [],
  defaultModel: null,
  researchAgents: [],
  researchSessionBindings: {},
  activeAgentRuns: {},
  draftResearchAgent: null,
  specialtySelectionPending: false,
  approvalMode: "approve",
  tools: [],
  hiddenExamples: initialHidden(),
  error: null,
  questions: [],
  permissions: [],
  sessionParents: {},
  panes: {},
  workspace: null,
  workspacePinned: false,
  switching: false,
  sending: false,
  runningSessions: {},
  shellTurns: {},

  // All three write the CURRENT session's pane (DRAFT_KEY on a draft), keeping
  // the artifact inspector and the Files browser mutually exclusive.
  openArtifact: (artifact) =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      let resolved = artifact;
      // A report name mentioned in the final answer is a path-only artifact.
      // Prefer the newest content snapshot reconstructed from this session's
      // write/edit history so a later task cannot overwrite its preview.
      if (artifact.content === undefined) {
        const artifactKey = artifactWorkspaceKey(artifact.path);
        const snapshot = [...(s.threads[key]?.blocks ?? [])]
          .reverse()
          .find((block): block is ArtifactBlock => (
            block.kind === "artifact" &&
            block.content !== undefined &&
            artifactWorkspaceKey(block.path) === artifactKey
          ));
        if (snapshot) resolved = { ...artifact, content: snapshot.content };
      }
      return { panes: { ...s.panes, [key]: { artifact: resolved, showFiles: false } } };
    }),
  closeArtifact: () =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const showFiles = s.panes[key]?.showFiles ?? false;
      return { panes: { ...s.panes, [key]: { artifact: null, showFiles } } };
    }),
  setShowFiles: (show) =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const artifact = show ? null : (s.panes[key]?.artifact ?? null);
      return { panes: { ...s.panes, [key]: { artifact, showFiles: show } } };
    }),

  answerQuestion: async (requestId, answers) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.answerQuestion(requestId, answers);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rejectQuestion: async (requestId) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.rejectQuestion(requestId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  replyPermission: async (requestId, reply) => {
    const p = get().permissions.find((x) => x.requestId === requestId);
    if (!p || !client) return;
    // Identical pending asks (same session, action and resources — e.g. three
    // parallel reads into one folder) are ONE question to the user: answer
    // them all with one click instead of re-asking for each tool call.
    const sig = (x: PermissionAskedEvent) =>
      `${x.sessionId}|${x.action}|${x.resources.join("|")}`;
    const batch = get().permissions.filter((x) => sig(x) === sig(p));
    set((s) => ({ permissions: s.permissions.filter((x) => sig(x) !== sig(p)) }));
    try {
      await Promise.all(batch.map((x) => client!.replyPermission(x.requestId, reply)));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setServerUrl: (serverUrl) => {
    if (typeof window !== "undefined") window.localStorage.setItem(URL_KEY, serverUrl);
    set({ serverUrl });
  },

  loadCatalog: async () => {
    const c = client;
    if (!c) return;
    try {
      const [firstSkills, agents, defaultModel, commands] = await Promise.all([
        c.listSkills(),
        c.listAgents(),
        c.getDefaultModel().catch(() => null),
        c.listCommands().catch(() => []),
      ]);
      if (client !== c) return;
      set({ agents, defaultModel, commands });
      let skills = firstSkills;
      // The first workspace-scoped /api/skill call triggers OpenCode's lazy
      // instance init and can answer before the scan finishes — poll briefly.
      for (let i = 0; skills.length === 0 && i < 4; i++) {
        await sleep(400);
        skills = await c.listSkills();
        if (client !== c) return;
      }
      set({ skills });
    } catch {
      /* ignore transient failures */
    }
  },

  loadResearchAgents: async () => {
    if (!hasWebApi) return get().researchAgents;
    try {
      const researchAgents = await listWebResearchAgents();
      set({ researchAgents });
      return researchAgents;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  startSpecialistDraft: (agentId) => {
    cancelPendingSpecialtySelection();
    const generation = ++draftSelectionGeneration;
    set((state) => ({ ...blankDraftState(state, null), specialtySelectionPending: true }));
    const selectionPromise = (async (): Promise<SpecialtySelectionOutcome> => {
      let catalog = get().researchAgents;
      if (catalog.length === 0) {
        try {
          catalog = await listWebResearchAgents();
        } catch (err) {
          if (generation === draftSelectionGeneration && get().currentId === null) {
            set({ error: err instanceof Error ? err.message : String(err) });
            return { status: "completed", generation };
          }
          return { status: "cancelled", generation };
        }
      }
      if (generation !== draftSelectionGeneration || get().currentId !== null) {
        return { status: "cancelled", generation };
      }
      set({ researchAgents: catalog });
      const agent = catalog.find((item) => item.id === agentId);
      if (!agent) {
        set({ error: `Research agent "${agentId}" is unavailable.` });
        return { status: "completed", generation };
      }
      set({ draftResearchAgent: agent, error: null });
      return { status: "completed", generation };
    })();
    let cancel!: () => void;
    const canceled = new Promise<SpecialtySelectionOutcome>((resolve) => {
      cancel = () => resolve({ status: "cancelled", generation });
    });
    const pending = { generation, promise: selectionPromise, canceled, cancel };
    pendingSpecialtySelection = pending;
    void selectionPromise.finally(() => {
      if (pendingSpecialtySelection !== pending) return;
      pendingSpecialtySelection = null;
      set({ specialtySelectionPending: false });
    });
    return selectionPromise.then(() => undefined);
  },

  detectTools: async () => {
    try {
      set({ tools: await probeTools() });
    } catch {
      /* ignore */
    }
  },

  setApprovalMode: async (mode) => {
    // A deliberate restart, like switchWorkspace: `switching` keeps the UI
    // rendering as connected — no status flip, no page flash.
    set({ switching: true });
    try {
      await persistApprovalMode(mode); // writes the config; restarts the sidecar
      set({ approvalMode: mode });
      await get().connectRetry();
    } finally {
      set({ switching: false });
    }
  },

  connect: async () => {
    // Quiet teardown of any previous connection: within a (re)connect the
    // status must never pass through "offline" — on first boot the retry loop
    // runs for minutes (macOS TCC) and each flip repaints the whole page.
    teardownClient();
    // Scope skill discovery to the sidecar's workspace. In hosted Web the
    // proxy injects the real server workspace, so the browser never sends a
    // workspace directory to the runtime client.
    const directory = await workspacePath();
    set({ workspace: directory, approvalMode: await getApprovalMode() });
    // The bundled sidecar requires per-run Basic auth; browser dev (no Tauri)
    // gets null and connects to a user-run passwordless server.
    const password = await runtimePassword();
    const c = new RuntimeClient({
      baseUrl: get().serverUrl,
      directory: !hasWebApi ? (directory ?? undefined) : undefined,
      password: password ?? undefined,
      fetchImpl: hasWebApi ? fetchWithWebAuth : undefined,
      useEventSource: hasWebApi,
    });
    client = c;
    let openedOnce = false;
    clientStatusUnsub = c.onStatus((status) => {
      void logDebug(`status → ${status}`);
      set({ status });
      if (status === "ready") {
        if (openedOnce) void recoverAfterEventReconnect(c, set, get);
        openedOnce = true;
      }
    });
    c.onEvent((event) => {
      // text.updated fires per streamed token, and a running bash tool fires
      // per stdout write (tqdm redraws dozens of times a second) — logging
      // each one would flood debug.log with an IPC call per event.
      if (
        event.type !== "text.updated" &&
        !(event.type === "tool.updated" && event.status === "running")
      )
        void logDebug(`event ← ${event.type}${"sessionId" in event ? " " + event.sessionId : ""}`);
      if ("sessionId" in event && event.sessionId) sseLast.set(event.sessionId, ++sseSeq);
      if (event.type === "error") {
        // A session-scoped error belongs IN the conversation (a red status
        // line where the user is looking), and it ends that session's turn so
        // the composer unlocks. Errors without a session keep the banner.
        const sid = event.sessionId;
        const eventMessage = userFacingRuntimeError(event.message);
        // After a user interrupt the abort's own "aborted" error is expected —
        // the thread already says "Interrupted"; don't add a second red line.
        if (sid) {
          clearLiveFolds(sid);
          // Streamed text buffered so far is part of the terminal state.
          flushTextFolds(sid, set);
        }
        if (sid && interruptedSessions.has(sid)) return;
        if (sid) {
          void refreshHostedRuns(set);
          set((s) => {
            const cur = s.threads[sid] ?? emptyThread();
            const runningSessions = { ...s.runningSessions };
            delete runningSessions[sid];
            // The turn's last user message is what a resend replays.
            const retryText = [...cur.blocks].reverse().find((b) => b.kind === "user")?.text;
            return {
              runningSessions,
              threads: {
                ...s.threads,
                [sid]: {
                  ...cur,
                  loaded: true,
                  blocks: [
                    ...cur.blocks,
                    {
                      kind: "status-line",
                      text: eventMessage,
                      tone: "error",
                      ...(retryText ? { retryText } : {}),
                    },
                  ],
                },
              },
            };
          });
        } else {
          set({ error: event.message });
        }
        return;
      }
      // Interactive requests live outside the thread blocks (transient UI).
      switch (event.type) {
        case "question.asked":
          set((s) => ({
            questions: [...s.questions.filter((q) => q.requestId !== event.requestId), event],
          }));
          return;
        case "question.resolved":
          set((s) => ({ questions: s.questions.filter((q) => q.requestId !== event.requestId) }));
          return;
        case "permission.asked":
          set((s) => ({
            permissions: [
              ...s.permissions.filter((p) => p.requestId !== event.requestId),
              event,
            ],
          }));
          return;
        case "permission.resolved":
          set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== event.requestId) }));
          return;
      }
      const sid = event.sessionId;
      if (!sid) return;
      if (event.type === "session.idle") clearLiveFolds(sid);
      // The idle after a user interrupt: the thread already ends with
      // "Interrupted" — consume the guard, keep the locks clear, skip the fold.
      if (event.type === "session.idle" && interruptedSessions.delete(sid)) {
        flushTextFolds(sid, set); // the partial turn's text stays complete
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        void get().refreshSessions();
        return;
      }
      if (event.type === "session.idle") {
        void refreshHostedRuns(set);
      }
      // A task tool names the subagent session it spawned — remember the
      // parent link so the child's permission/question asks surface in THIS
      // conversation, and refresh the list so the child's title is known.
      if (
        event.type === "tool.updated" &&
        event.childSessionId &&
        get().sessionParents[event.childSessionId] !== sid
      ) {
        const child = event.childSessionId;
        set((s) => ({ sessionParents: { ...s.sessionParents, [child]: sid } }));
        void get().refreshSessions();
      }
      const applyFold = (ev: typeof event) =>
        set((s) => {
          const cur = s.threads[sid] ?? emptyThread();
          const folded = foldEvent(
            { blocks: cur.blocks, index: cur.index },
            ev,
            { shellTurn: !!s.shellTurns[sid] },
          );
          // The turn is over — unlock the composer and drop the "Working…" row.
          // The shell flag clears HERE (not when the POST settles): within the
          // SSE stream the bash-output event always precedes session.idle.
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          if (ev.type === "session.idle") {
            delete runningSessions[sid];
            delete shellTurns[sid];
          }
          return {
            runningSessions,
            shellTurns,
            threads: { ...s.threads, [sid]: { ...cur, ...folded, loaded: true } },
          };
        });
      // A running bash tool streams its stdout tail on every write — dozens
      // of events per second under a progress bar. Fold at most one partial
      // update per LIVE_FOLD_MS per call (latest wins); everything else
      // (status changes, completion) folds immediately and supersedes.
      if (event.type === "tool.updated") {
        if (event.status === "running" && event.partialOutput !== undefined) {
          const now = Date.now();
          const last = liveFoldLast.get(event.callId) ?? 0;
          if (now - last < LIVE_FOLD_MS) {
            const pending = liveFoldPending.get(event.callId);
            if (pending) pending.event = event;
            else {
              const callId = event.callId;
              const timer = window.setTimeout(() => {
                const p = liveFoldPending.get(callId);
                liveFoldPending.delete(callId);
                if (!p) return;
                liveFoldLast.set(callId, Date.now());
                flushTextFolds(sid, set); // streamed text arrived first
                applyFold(p.event);
              }, LIVE_FOLD_MS - (now - last));
              liveFoldPending.set(event.callId, { sessionId: sid, timer, event });
            }
            return;
          }
          liveFoldLast.set(event.callId, now);
        } else {
          const pending = liveFoldPending.get(event.callId);
          if (pending) {
            window.clearTimeout(pending.timer);
            liveFoldPending.delete(event.callId);
          }
          liveFoldLast.delete(event.callId);
        }
      }
      // Streamed agent text fires per token, and every fold re-renders the
      // whole Markdown block — buffer per part and fold at most once per
      // LIVE_FOLD_MS (latest accumulated text wins). The first delta folds
      // immediately so the block appears in place; a turn's end/interrupt
      // flushes the buffer (see flushTextFolds callers), so no text is lost.
      if (event.type === "text.updated") {
        const now = Date.now();
        const last = textFoldLast.get(event.partId) ?? 0;
        if (now - last < LIVE_FOLD_MS) {
          const pending = textFoldPending.get(event.partId);
          if (pending) pending.event = event;
          else {
            const timer = window.setTimeout(() => {
              flushTextFolds(sid, set);
            }, LIVE_FOLD_MS - (now - last));
            textFoldPending.set(event.partId, { sessionId: sid, timer, event });
          }
          return;
        }
        textFoldLast.set(event.partId, now);
      }
      // Any event follows the text that streamed before it — flush buffered
      // text folds first so block order matches arrival order.
      flushTextFolds(sid, set);
      applyFold(event);
      // A completed live write becomes a provenance version (once per call).
      if (event.type === "tool.updated" && !recordedProvenance.has(event.callId)) {
        const input = provenanceInputFromEvent(event);
        if (input) {
          recordedProvenance.add(event.callId);
          void recordProvenance(input, sid, get().defaultModel);
        }
      }
      if (event.type === "tool.updated" && !recordedRuns.has(event.callId)) {
        const run = runInputFromEvent(event);
        if (run) {
          recordedRuns.add(event.callId);
          void recordRun(run, sid, get().defaultModel);
        }
      }
      if (event.type === "session.idle") void get().refreshSessions();
    });
    try {
      void logDebug(`connect → ${get().serverUrl}`);
      await c.connect();
      if (client !== c) return;
      void logDebug("connect OK");
      set({ error: null });
      await get().refreshSessions();
      // Catalog (skills/agents/commands) fills in behind the page — a session
      // switch must not wait on it to show the conversation.
      void get().loadCatalog();
      // Every reconnect is a window where session.idle can have been missed
      // (the event stream is directory-scoped and torn down on purpose) —
      // check any session still holding a running lock against the server.
      if (hasWebApi) {
        void refreshHostedRuns(set, true).then(() => get().reconcileRunning()).catch((error) => {
          void logDebug(`agent run recovery FAILED: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        void get().reconcileRunning();
      }
    } catch (err) {
      if (client !== c) return;
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`connect FAILED: ${msg}`);
      set({ error: msg, status: "error" });
    }
  },

  // First boot can be slow far beyond the process spawn: on a fresh install
  // macOS TCC ("access Documents") blocks the sidecar until the user answers,
  // so the window must cover minutes, not seconds — giving up early strands
  // the user on an error screen that a single manual Connect would fix.
  // Failed attempts are masked (status AND error): workspace switches
  // reconnect the event stream on purpose, and flashing "could not open the
  // event stream" at the user mid-switch reads as breakage. The last error is
  // surfaced only if the whole retry window is exhausted.
  connectRetry: async (tries = 120) => {
    set({ status: "connecting" });
    let lastError: string | null = null;
    for (let i = 0; i < tries; i++) {
      await get().connect();
      if (get().status === "ready") return;
      lastError = get().error ?? lastError;
      set({ status: "connecting", error: null });
      // Quick retries first — the server is usually up within a second (a
      // reconnect finds it already listening); back off to 1 s for the long
      // tail (first boot blocked on macOS TCC can take minutes).
      await sleep(i < 8 ? 250 : 1000);
    }
    set({ status: "error", error: lastError });
  },

  bootstrap: async () => {
    void get().detectTools();
    if (!(isTauri || hasCommandBackend)) return false;
    void logDebug(isTauri ? "bootstrap: starting bundled runtime" : "bootstrap: starting hosted runtime");
    try {
      const url = await startRuntime();
      void logDebug(`bootstrap: runtime at ${url}`);
      if (url) set({ serverUrl: url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`bootstrap FAILED: ${msg}`);
      // The debug log keeps the raw text; the banner is what a person reads,
      // so it gets the translated wording — a start failure that shows only a
      // transport string is how "the app did nothing" gets reported to us.
      set({ error: userFacingRuntimeError(err) });
      return false;
    }
    await get().connectRetry();
    return get().status === "ready";
  },

  disconnect: () => {
    teardownClient();
    set({ status: "offline" });
  },

  resetProjectState: () => {
    hostedRunGeneration++;
    draftSelectionGeneration++;
    cancelPendingSpecialtySelection();
    teardownClient();
    clearRuntimeEphemera();
    // Title overrides are session-derived — they leave with the sessions
    // (hosted project switch / logout), not into the next account.
    if (typeof window !== "undefined") window.localStorage.removeItem(TITLE_KEY);
    set({
      status: "offline",
      serverUrl: hasWebApi ? "" : initialUrl(),
      sessions: [],
      sessionTitles: {},
      currentId: null,
      threads: {},
      skills: [],
      agents: [],
      commands: [],
      defaultModel: null,
      researchAgents: [],
      researchSessionBindings: {},
      activeAgentRuns: {},
      draftResearchAgent: null,
      specialtySelectionPending: false,
      approvalMode: "approve",
      tools: [],
      error: null,
      questions: [],
      permissions: [],
      sessionParents: {},
      panes: {},
      workspace: null,
      workspacePinned: false,
      switching: false,
      sending: false,
      runningSessions: {},
      shellTurns: {},
    });
  },

  clearHostedSession: () => {
    get().resetProjectState();
  },

  switchHostedProject: async (projectId) => {
    const previousProjectId = getWebProjectId();
    if (projectId === previousProjectId) return;
    get().resetProjectState();
    setWebProjectId(projectId);
    try {
      const me = await fetchWebMe();
      if (!me || me.project.id !== projectId) throw new Error("Project is not available.");
      if (!(await get().bootstrap())) throw new Error("Project runtime could not start.");
    } catch (error) {
      get().resetProjectState();
      setWebProjectId(previousProjectId);
      await get().bootstrap();
      throw error;
    }
  },

  refreshSessions: async () => {
    const c = client;
    if (!c) return;
    try {
      // The list also names each subagent session's parent — the recovery
      // path for parent links after a reload (no live task event to learn from).
      await refreshSessionIndex(c, set);
    } catch {
      /* ignore transient list failures */
    }
  },

  // "New" opens a blank draft — no session is created until the first message (#3).
  // A fresh draft also drops any pinned folder: back to the dated-folder default.
  startDraft: (agent = null) => {
    draftSelectionGeneration++;
    cancelPendingSpecialtySelection();
    set((state) => ({ ...blankDraftState(state, agent), specialtySelectionPending: false }));
  },

  switchWorkspace: async (target) => {
    set({ switching: true });
    try {
      if ("dated" in target) await newDatedWorkspace(target.dated);
      else await setWorkspace(target.path);
      // Reset the local kernel so it respawns in the new folder, then reconnect
      // the event stream scoped to it (connect() re-reads the active folder —
      // the sidecar itself keeps running). An explicit switch pins the folder,
      // so the next new session lands exactly there.
      await kernelReset().catch(() => {});
      set((s) => {
        // Back to a draft in the new folder — the draft pane must not carry
        // files from the previous folder. Session panes keep their memory.
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        return { currentId: null, panes, workspacePinned: true };
      });
      if (hasWebApi) {
        const url = await startRuntime();
        if (url) set({ serverUrl: url });
      }
      await get().connectRetry();
      await Promise.all([get().refreshSessions(), get().loadCatalog()]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ switching: false });
    }
  },

  openSession: async (id) => {
    draftSelectionGeneration++;
    cancelPendingSpecialtySelection();
    set({ currentId: id, draftResearchAgent: null, specialtySelectionPending: false });
    try {
      await Promise.all([
        restoreResearchSessionBinding(id, set, get),
        get().researchAgents.length > 0 ? Promise.resolve(get().researchAgents) : get().loadResearchAgents(),
      ]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!client) return;
    // Follow the session into its own workspace folder: record it as active and
    // reconnect the event stream scoped to it, so the agent, kernel and Files
    // all operate where the session's files live. Sessions with no recorded
    // folder, or that already match the active folder, skip this.
    const dir = get().sessions.find((s) => s.id === id)?.directory;
    // The hosted runtime always reports its container mount as `/workspace`.
    // That is not a user-selectable project folder; passing it back to the
    // hosted command boundary is both meaningless and correctly rejected.
    const isHostedRuntimeMount = hasWebApi && /^\/workspace\/?$/.test(dir ?? "");
    if (dir && dir !== get().workspace && !isHostedRuntimeMount) {
      set({ switching: true });
      try {
        await setWorkspace(dir).catch(() => {});
        await kernelReset().catch(() => {});
        await get().connectRetry();
      } finally {
        set({ switching: false });
      }
    }
    if (!client) return;
    // Recover any request the agent is blocked on (asked before connect/reload).
    // The endpoints are workspace-scoped and return the complete pending set.
    const activeClient = client;
    void refreshInteractiveRequests(activeClient, set).catch(() => {
      /* pending-request recovery is best-effort */
    });
    // A session reopened while "Working…" may have finished behind our back.
    void get().reconcileRunning();
    if (get().threads[id]?.loaded) return;
    try {
      const messages = await activeClient.getMessages(id);
      if (client !== activeClient) return;
      // Server history carries the final text — a buffered fold flushing into
      // the rebuilt thread would duplicate it.
      clearTextFolds(id);
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...historyToThread(messages, s.commands), loaded: true },
        },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  // The send lifecycle (new → input → send → response) is shared by plain
  // prompts, "!" shell commands and "/" slash commands — see performTurn.
  sendPrompt: (text) =>
    performTurn(
      set,
      get,
      text,
      async (sid) => {
        if (hasWebApi) {
          const run = await dispatchWebAgentRun(sid, text, newHostedDispatchId());
          set((state) => ({ activeAgentRuns: { ...state.activeAgentRuns, [sid]: run.id } }));
          return;
        }
        const binding = get().researchSessionBindings[sid];
        await client!.sendPrompt(
          sid,
          text,
          binding?.runtimeAgent ?? undefined,
          get().defaultModel,
        );
      },
      false,
    ),

  // No retry for shell/command: re-POSTing would run the command twice.
  runShell: (command) => {
    const agent = get().agents.find((a) => a.mode === "primary")?.name ?? "build";
    return performTurn(
      set,
      get,
      `! ${command}`,
      (sid) => client!.runShell(sid, command, agent),
      true,
      true,
    );
  },

  runCommand: (name, args) =>
    performTurn(
      set,
      get,
      args ? `/${name} ${args}` : `/${name}`,
      (sid) => client!.runCommand(sid, name, args),
      true,
    ),

  interrupt: async () => {
    const sid = get().currentId;
    if (!sid || !client || !get().runningSessions[sid]) return;
    try {
      await client.abortSession(sid);
    } catch {
      // The abort POST failing usually means the turn is already dead —
      // fall through: unlock locally either way so the user is never stuck.
    }
    interruptedSessions.add(sid);
    await refreshHostedRuns(set);
    // An interrupt ends the turn: apply the text streamed so far, then mark
    // it — neutral tone, only failures are red.
    flushTextFolds(sid, set);
    set((s) => {
      const runningSessions = { ...s.runningSessions };
      const shellTurns = { ...s.shellTurns };
      delete runningSessions[sid];
      delete shellTurns[sid];
      const cur = s.threads[sid] ?? emptyThread();
      return {
        runningSessions,
        shellTurns,
        threads: {
          ...s.threads,
          [sid]: {
            ...cur,
            loaded: true,
            blocks: [...cur.blocks, { kind: "status-line", text: "已中断", tone: "muted" }],
          },
        },
      };
    });
  },

  reconcileRunning: async () => {
    const c = client;
    const running = Object.keys(get().runningSessions);
    if (!c || running.length === 0) return;
    for (const sid of running) {
      try {
        const messages = await c.getMessages(sid);
        if (client !== c) return;
        // Still ours to answer for? The lock may have cleared while we fetched.
        if (!turnIsOver(messages) || !get().runningSessions[sid]) continue;
        const recoveredThread = historyToThread(messages, get().commands);
        await refreshHostedRuns(set);
        void logDebug(`reconcile: missed idle for ${sid} — unlocking`);
        // The rebuilt history already carries the final text — drop any
        // buffered fold so it can't append a duplicate block afterwards.
        clearTextFolds(sid);
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return {
            runningSessions,
            shellTurns,
            // The idle was missed, so the tail of the turn was too — replace
            // the thread with the full history rather than leave it stale.
            threads: {
              ...s.threads,
              [sid]: { ...recoveredThread, loaded: true },
            },
          };
        });
      } catch {
        /* best-effort — the next reconnect or poll tries again */
      }
    }
  },

  deleteSession: async (id) => {
    if (client) {
      try {
        await client.deleteSession(id);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      const runningSessions = { ...s.runningSessions };
      delete runningSessions[id];
      const panes = { ...s.panes };
      delete panes[id];
      const sessionTitles = { ...s.sessionTitles };
      delete sessionTitles[id];
      if (typeof window !== "undefined") window.localStorage.setItem(TITLE_KEY, JSON.stringify(sessionTitles));
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        threads,
        runningSessions,
        panes,
        sessionTitles,
        currentId: s.currentId === id ? null : s.currentId,
      };
    });
  },

  hideExample: (id) => {
    const next = Array.from(new Set([...get().hiddenExamples, id]));
    if (typeof window !== "undefined") window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    set({ hiddenExamples: next });
  },

  // Install a skill by asking the agent (#1).
  //
  // Unreachable in this build, and left standing rather than half-rewritten:
  // it drives the SDK client, which needs a kernel the browser can address
  // directly — the desktop shell no longer bundles one and the hosted
  // pass-through route is retired. The prompt below still names the retired
  // kernel's own skill and skill path, which is exactly why it cannot be
  // repointed by guesswork: whoever restores skill installation has to say
  // what the replacement writes, and where.
  installSkill: async (text) => {
    if (!client) {
      set({ error: "Connect the runtime first to install skills." });
      return null;
    }
    try {
      const id = await client.createSession();
      set((s) => ({ currentId: id, threads: { ...s.threads, [id]: { ...emptyThread(), loaded: true } } }));
      await get().refreshSessions();
      const prompt =
        "Install the following as an OpenCode skill for this project. Use the " +
        "customize-opencode skill. If it is a URL, fetch it; if it is Markdown, save it as " +
        "a skill file under .opencode/skills/<name>/SKILL.md. Then reply with the installed skill's name.\n\n---\n" +
        text;
      set((s) => {
        const cur = s.threads[id];
        return {
          threads: {
            ...s.threads,
            [id]: { ...cur, blocks: [...cur.blocks, { kind: "user", text: `Install skill:\n${text}` }] },
          },
        };
      });
      await client.sendPrompt(id, prompt);
      return id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
}));

/** Dated folder name like `2026-07-04-1615` for a fresh per-session workspace. */
export function datedWorkspaceName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export interface FoldState {
  blocks: ThreadBlock[];
  index: Record<string, number>;
}

/** Pure reducer: fold one normalized OpenCode event into a thread's blocks. */
/**
 * Tidy a tool-call title for the conversation: show workspace files by their
 * relative path (`demo/analyze.py`), not the full `/Users/.../EviMed/...`
 * absolute path, so the thread reads like a researcher's log, not a shell trace.
 * The workspace path never contains spaces (by design), so a space-free run
 * ending in `EviMed/` matches it whether or not it has a leading slash. The
 * legacy `OpenScience/` workspace remains recognized after an upgrade.
 * (OpenCode's write-tool titles drop it).
 */
export function tidyToolTitle(title: string): string {
  return title.replace(/[^\s]*(?:EviMed|OpenScience)\//g, "").trim() || title;
}

/**
 * De-noise a bash command for the one-line title: collapse whitespace and
 * strip leading `cd <dir> &&` / `cd <dir>;` hops (repeatedly), so the step
 * reads `python train.py --mode teacher`, not `cd output/very/long/path && …`.
 * The full command stays available in the expanded detail.
 */
export function humanizeCommand(command: string): string {
  let c = command.replace(/\s+/g, " ").trim();
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c || command.trim();
}

/**
 * Progress bars (tqdm, pip, curl) redraw lines with `\r` — keep only what
 * each line last drew so live output shows one updating line, not hundreds.
 */
export function foldCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Live-tail cap: enough for a handful of lines, tiny in the store. */
const LIVE_TAIL_MAX = 4_000;
/** Expanded-detail cap: plenty to read inline, never megabytes in the store. */
const DETAIL_MAX = 64_000;
const capTail = (t: string, max: number) => (t.length > max ? "…" + t.slice(-max) : t);
const capHead = (t: string, max: number) => (t.length > max ? t.slice(0, max) + "\n…" : t);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const EDIT_TOOLS = new Set(["edit", "str_replace_editor", "apply_patch"]);

/**
 * Verb + subject for a tool step ("Ran" + `python train.py …`, "Created" +
 * `demo/analyze.py`) — recognizable at a glance, Codex-style. Tools without
 * a natural verb keep the old title fallback chain (server title → command →
 * file path → tool name).
 */
export function toolPresentation(
  tool: string,
  title: string | undefined,
  input?: Record<string, unknown>,
  status?: ToolCallStatus,
): { verb?: string; title: string } {
  const command = str(input?.command);
  const filePath = str(input?.filePath) || str(input?.path);
  const fallback = tidyToolTitle(title?.trim() || command || filePath || tool || "tool");
  const file = filePath ? tidyToolTitle(filePath) : "";
  switch (tool) {
    case "bash":
      return { verb: "Ran", title: command ? humanizeCommand(tidyToolTitle(command)) : fallback };
    case "write":
    case "create":
      return { verb: "Created", title: file || fallback };
    case "edit":
    case "str_replace_editor":
    case "apply_patch":
      return { verb: "Edited", title: file || fallback };
    case "read":
      return { verb: "Read", title: file || fallback };
    case "grep":
    case "glob":
      return { verb: "Searched", title: str(input?.pattern) || fallback };
    case "list":
      return { verb: "Listed", title: file || fallback };
    case "webfetch":
      return {
        verb: status === "failed" ? "Fetch failed" : status === "running" || status === "pending" ? "Fetching" : "Fetched",
        title: str(input?.url) || fallback,
      };
    default:
      return { title: fallback };
  }
}

export function foldEvent(
  state: FoldState,
  event: RuntimeEvent,
  opts?: { shellTurn?: boolean },
): FoldState {
  const blocks = [...state.blocks];
  const index = { ...state.index };
  switch (event.type) {
    case "text.updated": {
      // A ```review fence in the agent's text becomes a structured reviewer card.
      const { clean, review } = splitReview(event.text);
      const key = `text:${event.partId}`;
      if (key in index) blocks[index[key]] = { kind: "agent", markdown: clean };
      else {
        blocks.push({ kind: "agent", markdown: clean });
        index[key] = blocks.length - 1;
      }
      if (review) {
        const rkey = `review:${event.partId}`;
        if (rkey in index) blocks[index[rkey]] = review;
        else {
          blocks.push(review);
          index[rkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "tool.updated": {
      // The interactive `question`/`permission` tools render as their own
      // answerable card (InteractionPrompt), not as a blank thread row. `todo*`
      // tools only report an opaque "N todos" count with no useful content —
      // pure noise in the conversation, so drop them.
      if (/question|permission|^ask$|todo/i.test(event.tool)) return { blocks, index };
      const key = `tool:${event.callId}`;
      const command = str(event.input?.command);
      const filePath = str(event.input?.filePath) || str(event.input?.path);
      const content = str(event.input?.content);
      // Some updates omit fields earlier ones carried (a task tool names its
      // subagent session once; time.start only rides the first events) —
      // carry them over from the previous version of the block.
      const prev = key in index ? blocks[index[key]] : undefined;
      const prevTool = prev?.kind === "tool-call" ? prev : undefined;
      const childSessionId = event.childSessionId ?? prevTool?.childSessionId;
      const startedAt = event.startedAt ?? prevTool?.startedAt;
      const endedAt = event.endedAt ?? prevTool?.endedAt;
      // Edit tools report a proper unified diff in metadata on completion;
      // until (or without) that, synthesize a minimal old→new view.
      const diff =
        event.diff ??
        prevTool?.diff ??
        (EDIT_TOOLS.has(event.tool) && (str(event.input?.oldString) || str(event.input?.newString))
          ? [
              ...str(event.input?.oldString).split("\n").map((l) => `- ${l}`),
              ...str(event.input?.newString).split("\n").map((l) => `+ ${l}`),
            ].join("\n")
          : undefined);
      const { verb, title } = toolPresentation(event.tool, event.title, event.input, event.status);
      const block: ThreadBlock = {
        kind: "tool-call",
        title,
        status: event.status,
        tool: event.tool,
        ...(verb ? { verb } : {}),
        ...(command ? { command } : {}),
        ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
        ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
        ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
        // Live stdout tail while running — the "is it alive?" signal.
        ...(event.status === "running" && event.partialOutput
          ? { partialOutput: capTail(foldCarriageReturns(event.partialOutput), LIVE_TAIL_MAX) }
          : {}),
        ...(event.output?.trim()
          ? { output: capTail(foldCarriageReturns(event.output), DETAIL_MAX).replace(/\s+$/, "") }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        // A user-typed "!" command ran for its output — its detail opens by
        // default. Agent bash steps stay quiet one-liners until expanded.
        ...(opts?.shellTurn && event.tool === "bash" && event.output?.trim()
          ? { outputSummary: event.output.replace(/\s+$/, "") }
          : {}),
      };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      // Surface a file the agent wrote as a traceable artifact (deduped by path).
      const artifact = deriveArtifact(event);
      if (artifact) {
        const akey = `artifact:${artifact.path}`;
        if (akey in index) blocks[index[akey]] = artifact;
        else {
          blocks.push(artifact);
          index[akey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "session.idle":
      blocks.push({ kind: "status-line", text: "已完成", tone: "done" });
      return { blocks, index };
    default:
      return state;
  }
}

/**
 * One-line live activity of a subagent, derived from its folded thread:
 * the latest tool step's title, a writing label while it streams text, and
 * a generic working label before anything is known (e.g. right after an
 * app reload). UI copy is Chinese per the product's language baseline.
 */
export function subagentActivity(blocks?: ThreadBlock[]): string {
  for (let i = (blocks?.length ?? 0) - 1; i >= 0; i--) {
    const b = blocks![i];
    if (b.kind === "tool-call") return b.title;
    if (b.kind === "agent") return "正在撰写…";
  }
  return "正在工作…";
}

function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

const INTERNAL_RECOVERY_PROMPT_PREFIXES = [
  "The server-side clinical evidence gate rejected the current package.",
];

function isInternalRecoveryPrompt(text: string): boolean {
  return INTERNAL_RECOVERY_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Convert loaded message history into thread blocks. */
export function historyToThread(messages: HistoryMessage[], commands?: CommandInfo[]): FoldState {
  const blocks: ThreadBlock[] = [];
  const artifactSnapshots = new Map<string, string>();
  // OpenCode stores a slash command's EXPANDED template as the user message,
  // with any typed arguments appended after it (no marker) — show the
  // "/name args" the user actually typed instead. Longest template first, so
  // one template being a prefix of another's expansion can't mis-attribute.
  const templates = (commands ?? [])
    .filter((c) => c.template?.trim())
    .map((c) => ({ name: c.name, template: c.template!.trim() }))
    .sort((a, b) => b.template.length - a.template.length);
  const asTypedCommand = (text: string): string | undefined => {
    const hit = templates.find((t) => text.startsWith(t.template));
    if (!hit) return undefined;
    const args = text.slice(hit.template.length).trim();
    return args ? `/${hit.name} ${args}` : `/${hit.name}`;
  };
  // A step frozen mid-run (the runtime restarted or the turn was killed before
  // it finished) must not spin forever in history — render it quietly and say
  // once, at the end, that the turn was interrupted.
  let interrupted = false;
  // A user-typed "!" command is recorded as a synthetic user text plus a bash
  // tool part on the next assistant message. Render it like the live path:
  // the "! cmd" echo and the output inline — never the synthetic marker text.
  let shellTurn = false;
  for (const m of messages) {
    if (m.role === "user") {
      shellTurn = m.parts.some((p) => p.type === "text" && p.synthetic);
      if (shellTurn) continue;
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      // Server-side specialist repair turns are implementation details sent
      // back into the runtime, not user-authored conversation. OpenCode history
      // carries no explicit origin marker for these turns, so keep the stable
      // fail-closed sentinel out of the restored SaaS transcript.
      if (isInternalRecoveryPrompt(text)) continue;
      const command = asTypedCommand(text);
      if (command) blocks.push({ kind: "user", text: command });
      else if (text) blocks.push({ kind: "user", text });
    } else {
      for (const p of m.parts) {
        if (p.type === "text" && p.text?.trim()) {
          const { clean, review } = splitReview(p.text);
          if (clean) blocks.push({ kind: "agent", markdown: clean });
          if (review) blocks.push(review);
        }
        else if (p.type === "tool") {
          // Interactive tools are surfaced by InteractionPrompt, not the thread;
          // `todo*` tools are opaque "N todos" noise — skip both.
          if (/question|permission|^ask$|todo/i.test(p.tool ?? "")) continue;
          const status = mapToolStatus(p.state?.status);
          const frozen = status === "running" || status === "pending";
          if (frozen) interrupted = true;
          const command = str(p.state?.input?.command);
          const filePath = str(p.state?.input?.filePath) || str(p.state?.input?.path);
          const content = str(p.state?.input?.content);
          const diff =
            str(p.state?.metadata?.diff) ||
            (EDIT_TOOLS.has(p.tool ?? "") &&
            (str(p.state?.input?.oldString) || str(p.state?.input?.newString))
              ? [
                  ...str(p.state?.input?.oldString).split("\n").map((l) => `- ${l}`),
                  ...str(p.state?.input?.newString).split("\n").map((l) => `+ ${l}`),
                ].join("\n")
              : "");
          const userShell = shellTurn && p.tool === "bash";
          if (userShell) blocks.push({ kind: "user", text: `! ${command}` });
          const { verb, title } = toolPresentation(p.tool ?? "", p.state?.title, p.state?.input, status);
          const toolOutput = str(p.state?.output) || str(p.state?.error);
          blocks.push({
            kind: "tool-call",
            title,
            status: frozen ? "pending" : status,
            tool: p.tool,
            ...(verb ? { verb } : {}),
            ...(command ? { command } : {}),
            ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
            ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
            ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
            ...(toolOutput.trim()
              ? { output: capTail(foldCarriageReturns(toolOutput), DETAIL_MAX).replace(/\s+$/, "") }
              : {}),
            ...(typeof p.state?.time?.start === "number" ? { startedAt: p.state.time.start } : {}),
            ...(typeof p.state?.time?.end === "number" ? { endedAt: p.state.time.end } : {}),
            ...(userShell && toolOutput.trim()
              ? { outputSummary: toolOutput.replace(/\s+$/, "") }
              : {}),
          });
          const artifact = deriveArtifact({
            type: "tool.updated",
            sessionId: "",
            callId: "",
            tool: p.tool ?? "",
            status,
            input: p.state?.input,
            output: p.state?.output,
          });
          if (artifact) {
            const artifactKey = artifactWorkspaceKey(artifact.path);
            const input = p.state?.input ?? {};
            if (status === "success" && typeof input.content === "string") {
              artifactSnapshots.set(artifactKey, input.content);
            } else if (status === "success" && EDIT_TOOLS.has(p.tool ?? "")) {
              const previous = artifactSnapshots.get(artifactKey);
              const oldText = typeof input.oldString === "string"
                ? input.oldString
                : typeof input.old_str === "string" ? input.old_str : undefined;
              const newText = typeof input.newString === "string"
                ? input.newString
                : typeof input.new_str === "string" ? input.new_str : undefined;
              if (previous !== undefined && oldText !== undefined && newText !== undefined) {
                if (previous.includes(oldText)) artifactSnapshots.set(artifactKey, previous.replace(oldText, newText));
                else artifactSnapshots.delete(artifactKey);
              }
            }
            const snapshot = artifactSnapshots.get(artifactKey);
            blocks.push(snapshot === undefined ? artifact : { ...artifact, content: snapshot });
          }
        }
      }
      shellTurn = false;
    }
  }
  if (interrupted) {
    blocks.push({
      kind: "status-line",
      text: "已中断——本轮任务尚未完成，可发送新消息继续。",
      tone: "muted",
    });
  }
  return { blocks, index: {} };
}
