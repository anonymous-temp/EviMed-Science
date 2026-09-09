/**
 * The command boundary: `POST /api/commands/:command` on the control plane.
 *
 * There used to be a second one — Tauri IPC into a packaged desktop shell —
 * and every caller branched on which was present. The shell is gone, so the
 * branch is gone with it rather than staying as a constant that is always
 * false and a code path nothing can reach.
 */
import { ERROR_DETAIL_FIELDS, knownErrorCodeMessage } from "@evimed/domain";

const rawWebApiBase = import.meta.env.VITE_OPEN_SCIENCE_API_URL?.trim() ?? "";

export const webApiBase = rawWebApiBase.replace(/\/+$/, "");
const PROJECT_KEY = "openScience.projectId";
const CSRF_HEADER = "X-Open-Science-CSRF";
export const WEB_SESSION_ENDED_EVENT = "open-science:web-session-ended";
export const WEB_SESSION_STARTED_EVENT = "open-science:web-session-started";
let webCsrfToken: string | null = null;
let webCsrfRefresh: Promise<string | null> | null = null;

export const hasWebApi = webApiBase.length > 0;

export class BackendUnavailableError extends Error {
  constructor(command: string) {
    super(`No backend is configured for command "${command}".`);
    this.name = "BackendUnavailableError";
  }
}

/** The three ceilings the usage ledger enforces. They are not interchangeable:
 *  the two account ceilings are rolling windows over the last 24 hours and the
 *  last 7 days (`openCostWindows` in usageLedger.mjs, measured in SQL as
 *  `created_at >= now - interval`), so spend ages out continuously instead of
 *  resetting at midnight; a run ceiling is about this one task. Which one
 *  refused decides what the researcher can do next, so it is named. */
export type WebUsageBudgetWindow = "day" | "week" | "run";

/** The currencies the ledger prices in. A closed set, mirroring the control
 *  plane's declaration: a currency outside it is not renamed to CNY here — the
 *  whole bag is dropped, because an amount shown under the wrong currency is
 *  worse than no amount at all. */
export type WebUsageBudgetCurrency = "CNY";

/** What a 402 `usage_budget_exceeded` refusal carries.
 *  `requested` is absent when the ceiling refused admission before pricing. */
export interface WebUsageBudgetDetails {
  window: WebUsageBudgetWindow;
  limit: number;
  committed: number;
  requested?: number;
  currency: WebUsageBudgetCurrency;
  /** How long until this ceiling starts freeing itself. Declared for the two
   *  `credits_*` codes only; `usage_budget_exceeded` states it in a header
   *  instead, which `WebApiError.retryAfterSeconds` reads either way. */
  retryAfterSeconds?: number;
}

export interface WebUsageBudgetRefusal extends WebUsageBudgetDetails {
  /** When this browser saw the refusal. */
  observedAt: string;
}

/** The Chinese name of each ceiling. The two account ceilings say the window
 *  they measure, not a calendar period: nothing resets at midnight or on
 *  Monday. */
export const webUsageBudgetWindowLabels: Record<WebUsageBudgetWindow, string> = {
  day: "近 24 小时额度",
  week: "近 7 天额度",
  run: "单次任务额度",
};

/**
 * The declared specifics of a refusal, or null.
 *
 * Driven by `@evimed/domain`'s `ERROR_DETAIL_FIELDS`, which is the same table
 * the control plane filters the outgoing body against. It used to be restated
 * here — one code, `usage_budget_exceeded`, with its window and currency sets
 * spelled out a second time — and the copies disagreed: the two codes this
 * deployment actually raises (`credits_daily_limit_reached`,
 * `credits_weekly_limit_reached`) reached the browser with the ceiling, the
 * amount and the reset moment computed and then dropped, leaving 「请重试」 as
 * the advice for a ceiling retrying cannot clear.
 *
 * Anything the wire holds beyond the declared keys is dropped rather than
 * handed to a component to interpret, and a value outside a declared closed set
 * is dropped rather than substituted — an amount printed under a currency
 * nobody said it was in is worse than no amount at all.
 */
function parseWebApiErrorDetails(code: string | null, value: unknown): WebUsageBudgetDetails | null {
  const table = ERROR_DETAIL_FIELDS as unknown as Record<string, Record<string, "number" | readonly string[]> | undefined>;
  const shape = code ? table[code] : undefined;
  if (!shape || !value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const accepted: Record<string, number | string> = {};
  for (const [key, rule] of Object.entries(shape)) {
    const candidate = raw[key];
    if (rule === "number") {
      if (typeof candidate === "number" && Number.isFinite(candidate)) accepted[key] = candidate;
    } else if (typeof candidate === "string" && rule.includes(candidate)) {
      accepted[key] = candidate;
    }
  }
  // Every declared shape names these four. A bag missing one is dropped whole
  // rather than rendered with a hole: 「上限 undefined」 is not a sentence, and
  // the registry's own sentence for the code is a better answer than a broken
  // one. The two casts are what the loop above already proved — the value came
  // out of the closed set the domain declared for this key.
  const window = accepted.window;
  const currency = accepted.currency;
  if (typeof window !== "string" || typeof currency !== "string"
    || typeof accepted.limit !== "number" || typeof accepted.committed !== "number") return null;
  return {
    window: window as WebUsageBudgetWindow,
    limit: accepted.limit,
    committed: accepted.committed,
    currency: currency as WebUsageBudgetCurrency,
    ...(typeof accepted.requested === "number" ? { requested: accepted.requested } : {}),
    ...(typeof accepted.retryAfterSeconds === "number" ? { retryAfterSeconds: accepted.retryAfterSeconds } : {}),
  };
}

/**
 * How long the control plane says this refusal will keep refusing, in seconds.
 *
 * `Retry-After` is a header (`sendError` in `apps/server/src/security.mjs`) and
 * every client path here read only the JSON body, so a 402 that had already
 * computed the moment the ceiling frees up arrived carrying nothing but
 * "please retry" — advice that provably cannot work while the window is full.
 * Both forms RFC 9110 allows are read: delta-seconds, which is what the control
 * plane sends, and an HTTP-date, because an intermediary may rewrite the first
 * into the second.
 *
 * CROSS-ORIGIN: `Retry-After` is not a CORS-safelisted response header. A
 * deployment serving this bundle from an origin other than the API must name it
 * in `Access-Control-Expose-Headers` or this reads null — which is not an
 * error, the hint is simply omitted and the sentence stands on its own.
 */
export function webRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 30 * 24 * 60 * 60);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

let lastUsageBudgetRefusal: WebUsageBudgetRefusal | null = null;

/** The last budget refusal this page load saw, anywhere in the app. The
 *  refusal is raised on whichever page tried to spend and is read on the
 *  account page, which is where a researcher goes to find out what happened.
 *
 *  In memory only, and deliberately not presented as more than that: a reload
 *  or a second tab starts blank, and a refusal raised inside a server-side
 *  worker (an autopilot episode, a source-understanding job) never passes
 *  through a browser at all. The durable answer is for `/api/account/usage` to
 *  report the configured ceilings and the current rolling committed spend, so
 *  the account page can state the position without a remembered exception;
 *  that endpoint carries neither today. */
export function lastWebUsageBudgetRefusal(): WebUsageBudgetRefusal | null {
  return lastUsageBudgetRefusal;
}

/** One Chinese sentence naming the ceiling and the amounts behind it. */
export function describeWebUsageBudget(details: WebUsageBudgetDetails): string {
  const money = (value: number) => `${value.toFixed(2)} ${details.currency}`;
  const spent = `上限 ${money(details.limit)}，已占用 ${money(details.committed)}`;
  const asked = details.requested === undefined ? "" : `，本次请求还需 ${money(details.requested)}`;
  return `${webUsageBudgetWindowLabels[details.window]}已达上限：${spent}${asked}。`;
}

export class WebApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  /** The machine-readable specifics the control plane declared for this code,
   *  or null for the codes that declare none — see `ERROR_DETAIL_FIELDS`. */
  readonly details: WebUsageBudgetDetails | null;
  /** Seconds until this refusal is worth attempting again, from the
   *  `Retry-After` header or from the declared details, or null when the
   *  control plane said nothing about time. Never invented: a hint nobody sent
   *  would be a promise this client cannot keep. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    envelope: {
      status: number; code?: string | null; requestId?: string | null; details?: unknown;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = "WebApiError";
    this.status = envelope.status;
    this.code = envelope.code ?? null;
    this.requestId = envelope.requestId ?? null;
    this.details = parseWebApiErrorDetails(this.code, envelope.details);
    // The header first: it is what every refusal with a retryAfterSeconds
    // carries today, across all sixteen status classes, while the body detail
    // exists only for the two credits codes that declare it.
    this.retryAfterSeconds = typeof envelope.retryAfterSeconds === "number" && Number.isFinite(envelope.retryAfterSeconds)
      ? Math.max(0, envelope.retryAfterSeconds)
      : this.details?.retryAfterSeconds ?? null;
    // Remembered here, at the one place every client path constructs the
    // error, rather than at each catch site: "every caller remembers it" is
    // how this detail was lost in the first place.
    if (this.details) lastUsageBudgetRefusal = { ...this.details, observedAt: new Date().toISOString() };
  }
}

/**
 * A wait in the units a person thinks in.
 *
 * Rounded up, always: a sentence that promises the ceiling frees earlier than
 * it does sends the researcher back to be refused a second time, which is the
 * retry loop this whole change exists to stop.
 */
export function describeWebRetryAfter(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${rest} 分钟`;
}

/**
 * What the refusal's own clock adds to its sentence, or null.
 *
 * A spend ceiling gets different words from a rate limit because it *is* a
 * different fact. Both account ceilings are rolling windows (`spendAdmission`
 * in `usageMetering.mjs` measures the last 24 hours and the last 7 days), and
 * the moment it reports is when the oldest charge inside the window ages out —
 * the earliest the refusal can lift, freeing that one charge's worth and no
 * more. Saying 「N 分钟后恢复」 would be a promise the ledger never made;
 * naming it as the start of a gradual release is what the number actually
 * means, and it also rules out the reading that budgets reset at midnight.
 */
export function webRetryAfterHint(error: WebApiError): string | null {
  if (error.retryAfterSeconds === null) return null;
  const wait = describeWebRetryAfter(error.retryAfterSeconds);
  const code = error.code ?? "";
  // A spend ceiling only: a runtime hold or a rate limit does free completely
  // at its stated time, and telling someone their 额度 is releasing when the
  // autopilot merely holds the runtime would be a different false claim.
  const spendCeiling = error.details !== null || code === "usage_budget_exceeded" || /^credits_/.test(code);
  if (spendCeiling) return `${wait}后额度开始释放（按滚动窗口逐笔释放，不是整点清零）。`;
  return `请在${wait}后重试。`;
}

/**
 * What an HTTP status alone can honestly say.
 *
 * The last resort, reached only when the registry has no sentence for the code
 * and the surface offered no wording of its own. It exists because the previous
 * last resort was 「操作未完成，请重试。」 for all sixteen status classes the
 * control plane raises — including 413 (a file over the size ceiling) and 503
 * (a connector the deployment has not configured), where retrying is advice
 * that provably cannot work and, per the over-refusal research, costs more
 * trust than the refusal itself.
 */
function webStatusMessage(status: number): string {
  if (status === 401) return "登录已失效，请重新登录。";
  if (status === 402) return "额度上限已到，这次请求没有开始。";
  if (status === 403) return "当前账号没有执行这项操作的权限。";
  if (status === 404) return "这条记录已不存在，请刷新后再试。";
  if (status === 409) return "内容已发生变化，请刷新后再试。";
  if (status === 413) return "内容超过了本次请求的大小上限，请拆分后再试。";
  if (status === 423) return "所需资源正被占用，暂时无法执行。";
  if (status === 429) return "请求过于频繁，已被暂时限流。";
  if (status === 400 || status === 422) return "这次请求没有被接受，请检查填写的内容。";
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  return "操作未完成，请重试。";
}

/** What a surface may say instead of the shared wording, when it knows more. */
export interface WebErrorMessageOverrides {
  /** By error code, for codes the registry has no sentence for. Delete an entry
   *  the day the registry gains that code: the registry wins here on purpose. */
  codes?: Record<string, string>;
  /** By HTTP status, for facts no error code expresses — a revision conflict is
   *  the only real one, and it reads differently on a document than on a
   *  notification. */
  statuses?: Record<number, string>;
  /** For a failure that never reached the control plane at all: a dropped
   *  connection, an invalid response. */
  fallback?: string;
}

/**
 * One Chinese sentence for any refusal, from the one dictionary.
 *
 * The order is most-specific-first and every step is a fact rather than a
 * guess: the declared numbers, then the registry's sentence for the code, then
 * whatever the surface knows about that code or status, then the status alone.
 *
 * This function exists because four independent tables of Chinese error strings
 * shipped in this bundle at once and disagreed — `runtime_canceled` had two
 * different sentences — while the registry that holds them all rendered zero
 * pixels. A surface that needs different words supplies them through
 * `overrides` and stays one caller of one dictionary.
 */
export function webErrorMessage(error: unknown, overrides: WebErrorMessageOverrides = {}): string {
  if (!(error instanceof WebApiError)) return overrides.fallback ?? "操作未完成，请重试。";
  const code = error.code ?? "";
  const head = error.details
    ? describeWebUsageBudget(error.details)
    : knownErrorCodeMessage(code)
      ?? overrides.codes?.[code]
      ?? overrides.statuses?.[error.status]
      ?? webStatusMessage(error.status);
  const hint = webRetryAfterHint(error);
  return hint ? `${head}${hint}` : head;
}

export type WebTaskStatus =
  | "queued"
  | "running"
  | "canceling"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export interface WebTask {
  id: string;
  command: string;
  status: WebTaskStatus;
  userId: string;
  projectId: string;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface WebAuditRecord {
  createdAt: string;
  userId: string;
  projectId: string;
  action?: string;
  command: string | null;
  status: "started" | "completed" | "failed";
  target?: string | null;
  bytes?: number | null;
  error: string | null;
}

export interface WebTaskEvent {
  taskId: string;
  command: string;
  userId: string;
  projectId: string;
  status: WebTaskStatus;
  event: string;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface WebRuntimeEvent {
  createdAt: string;
  userId: string;
  projectId: string;
  event: string;
  method?: string;
  target?: string;
  status?: number | null;
  durationMs?: number;
  streaming?: boolean;
  kind?: string;
  sandboxMode?: string;
  networkMode?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  pid?: number | null;
  error?: string;
}

export interface WebErrorEvent {
  createdAt: string;
  requestId: string | null;
  method: string | null;
  route: string;
  status: number;
  code: string;
  projectId: string | null;
}

export interface WebSecurityEvent {
  createdAt: string;
  action: string;
  status: "completed" | "failed";
  username: string | null;
  userId: string | null;
  code: string | null;
}

export interface WebProject {
  id: string;
  name: string;
}

export interface WebPluginConfiguration {
  revision: number;
  enabled: boolean;
  /** Whatever the plugin's own schema declares; empty for a plugin with no settings. */
  settings: Record<string, number>;
}

/**
 * What the control plane last recorded about a newer build, and when.
 *
 * `unknown` is a first-class answer, not a fallback: nothing on the request
 * path asks upstream, so an absent, stale or unobserved record means nobody
 * knows — which must never be shown as "up to date".
 */
export interface WebPluginAvailability {
  state: "unknown" | "current" | "update-available";
  checkedAt: string | null;
  reason: string;
}

export interface WebPluginState {
  id: string;
  binaryVersion: string;
  /** The tools this bundle registers, as the compatibility record lists them. */
  tools: string[];
  /** The settings this build accepts, with the deployment's own ceilings applied. */
  settingsSchema: Record<string, { min: number; max: number }>;
  availableUpdate: { version: string; recordedAt: string; source: string } | null;
  availability: WebPluginAvailability;
  desired: WebPluginConfiguration | null;
  effective: WebPluginConfiguration | null;
  phase: "saved" | "pending" | "applying" | "effective" | "rolled_back" | "unavailable" | "failed";
  error: string | null;
  /** The saved configuration is exactly the removal state: disabled, defaults. */
  removed: boolean;
  limits: { minTimeoutMs: number; maxTimeoutMs: number };
}

export interface WebResearchAgentOutput {
  path: string;
  required: boolean;
}

export interface WebResearchAgent {
  id: string;
  version: string;
  title: string;
  category: string;
  description: string;
  skill: string;
  estimatedMinutes: [number, number];
  starterPrompts: string[];
  requiredInputs: string[];
  optionalInputs: string[];
  requiredTools: string[];
  optionalTools: string[];
  dataSources: string[];
  outputs: WebResearchAgentOutput[];
  completionChecks: string[];
  runtimeAgent: string;
}

export type WebResearchSessionSelection =
  | { mode: "open-domain" }
  | { mode: "specialist"; agentId: string; agentVersion: string };

export interface WebResearchSession {
  sessionId: string;
  mode: "open-domain" | "specialist";
  agentId: string | null;
  agentVersion: string | null;
  runtimeAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebMemoryStatus {
  configured: boolean;
  connected: boolean;
  code: string | null;
  account?: string | null;
  structured?: boolean;
}

export interface WebResearchMemory {
  id: string;
  content: string;
  state: "normal" | "archived";
  pinned: boolean;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export type WebStructuredMemoryKind =
  | "profile"
  | "preference"
  | "behavior"
  | "project_fact"
  | "analysis"
  | "decision"
  | "correction"
  | "follow_up"
  | "run_summary";

export interface WebStructuredMemory {
  id: string;
  scope: "user" | "project" | "session" | "organization";
  scopeId: string;
  kind: WebStructuredMemoryKind;
  key: string;
  value: string;
  summary: string;
  origin: "explicit" | "inferred" | "system" | "manual";
  status: "active" | "pending" | "superseded" | "archived";
  confidence: number;
  importance: number;
  sensitive: boolean;
  evidenceCount: number;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastConfirmedAt: string | null;
  expiresAt: string | null;
  evidence: Array<{
    sourceType: string;
    sourceRef: string;
    quote: string;
    observedAt: string | null;
    weight: number;
    fingerprint: string;
  }>;
  revisions: Array<{
    version: number;
    value: string;
    summary: string;
    status: "active" | "pending" | "superseded" | "archived";
    changedAt: string | null;
    reason: string;
  }>;
}

export interface WebMemoryProfile {
  records: WebStructuredMemory[];
  groups: Record<WebStructuredMemoryKind, WebStructuredMemory[]>;
  activeCount: number;
  pendingCount: number;
}

export type WebAgentRunStatus = "running" | "succeeded" | "failed" | "canceled";

/**
 * A read derived from `status` (plus dispatch/verification/progress), never a
 * second status of its own — the control plane computes it fresh on every
 * read and nothing assigns it directly (§7.1.1, decision 2026-08-24 #20).
 * `degraded` is the one this page groups by: delivered, but with something —
 * unresolved verification, or a partial delivery — a person should look at.
 */
export type WebRunPhase =
  | "reserved" | "dispatched" | "running" | "delivering" | "repairing"
  | "accepted" | "degraded" | "failed" | "canceled";

export interface WebAgentRun {
  id: string;
  dispatchId: string | null;
  // The question as asked, truncated. A run list keyed only by id is a list of
  // hashes.
  question?: string | null;
  dispatchStatus: "dispatching" | "accepted" | "unknown" | "rejected";
  sessionId: string;
  mode: "open-domain" | "specialist";
  agentId: string | null;
  agentVersion: string | null;
  runtimeAgent: string | null;
  effectiveAgentId?: string | null;
  effectiveAgentVersion?: string | null;
  effectiveRuntimeAgent?: string | null;
  // Which rule chose that agent: `matched:<id>`, `llm:<confidence>`,
  // `unrouted:open-domain`, or `session-binding`.
  effectiveRouteReason?: string | null;
  model: string;
  status: WebAgentRunStatus;
  phase?: WebRunPhase;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  /** Files the delivery gate accepted. Only these are graded output, and the
   *  control plane reads verification results and agenda deltas out of this
   *  list — which is why ungraded files are a separate field rather than a
   *  wider meaning for this one. */
  artifacts: string[];
  /** Files the run wrote under `deliverables/` that no gate accepted. Present
   *  on every run this build records; `[]` means none were written. Older
   *  ledger rows omit it, which is why `undeliveredFiles` distinguishes an
   *  absent field from an empty one. */
  unverifiedArtifacts?: string[];
  // "unverified" when a clinical package finished with only process-documentation
  // or presentation gaps and was delivered rather than discarded.
  // "unchecked" when a layer of the gate did not run at all — most often the
  // per-question coverage comparison, whose brief lives in server memory and is
  // lost on restart. Null means every layer ran and none of them objected, so
  // "not checked" must never be reported as null.
  verification?: "unverified" | "unchecked" | null;
  // Human-readable gate reasons attached to a failed or unverified run.
  qualityNotices?: string[];
  // Liveness for a run that legitimately takes tens of minutes.
  observedMessages?: number;
  observedToolCalls?: number;
  lastProgressAt?: string | null;
  /** How many repair rounds the delivery gate and the run went through, and
   *  the same number split by what was repaired. Both are folded from the
   *  ledger's `learning` event (`normalizeRepairRounds`, agentRuns.mjs) and
   *  have been on the wire since the repair loop shipped. */
  attempts?: number;
  repairRounds?: { content: number; structural: number };
  /** How many times the researcher steered this run mid-flight. */
  corrections?: number;
  /**
   * The phase projection's own diagnostics, attached by `AgentRuns.list()`
   * (agentRuns.mjs:2593). Typed here because the server already sends them and
   * an untyped field is invisible to `tsc` — a later reader would otherwise
   * need a second wire change to see what is already arriving.
   *
   * NOT researcher-facing, and a surface that renders them verbatim is a new
   * defect of exactly the kind this change removes: `phaseNotices` entries are
   * internal state-machine diagnostics in English of the form
   * `illegal_state_transition: running -> succeeded` (agentRuns.mjs:643). They
   * belong in a support affordance — a title attribute, a diagnostics drawer —
   * beside the run id, never in the outcome sentence.
   */
  phaseIllegalTransitions?: number;
  phaseNotices?: string[];
}


/**
 * What a client can report about a deliverable it produced.
 *
 * Two facts, and only these two: the researcher kept this file, and the
 * researcher revised it. The pair of them is what the control plane distils
 * into a candidate method — an edit with no adoption behind it is somebody
 * rewriting work they rejected, and there is no lesson in that.
 */
export type WebDeliverableFeedbackTrigger = "deliverable-adopted" | "deliverable-edited";

export interface WebDeliverableFeedback {
  trigger: WebDeliverableFeedbackTrigger;
  /** The run that produced the file. The server refuses an id no run in the
   * current project answers to, because the id is copied into the lesson. */
  runId: string;
  /** Workspace-relative path of the deliverable. */
  path: string;
  /** What the researcher changed and why. Only an edit carries one, and it is
   * the whole readable content of the lesson — without it the candidate method
   * says so and asks for it. */
  summary?: string;
}

export interface WebFeedbackEvent {
  id: string;
  projectId: string | null;
  runId: string | null;
  trigger: string;
  subject: { type: string; id: string };
  detail: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export interface WebFeedbackRecord {
  event: WebFeedbackEvent;
  /** The distillation job the event completed the evidence for, when it did. */
  distillJobId: string | null;
}

export type WebFileRoot = "workspace" | "base";

export interface WebMetrics {
  createdAt: string;
  server: {
    pid: number;
    uptimeSeconds: number;
    memory: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      externalBytes: number;
    };
    cpu: {
      userMicros: number;
      systemMicros: number;
    };
    loadAverage: number[];
  };
  project: {
    id: string;
    name: string;
    storage: {
      usedBytes: number;
      maxBytes: number | null;
    };
  };
  tasks: {
    total: number;
    active: number;
    queued: number;
    byStatus: Record<WebTaskStatus, number>;
  };
  runtime: {
    running: boolean;
    kind: string | null;
    startedAt: string | null;
    pid: number | null;
    exitedAt: string | null;
    sandboxMode?: string;
    networkMode?: string | null;
    containerName?: string | null;
    stale?: boolean;
    lastEvent?: string | null;
    lastUpdatedAt?: string | null;
    error?: string | null;
  };
}

export interface WebReadinessCheck {
  ok: boolean;
  code?: string;
  skipped?: boolean;
  required?: boolean;
  mode?: string;
  origin?: string;
  secure?: boolean;
  users?: number;
  sandboxMode?: string;
  networkMode?: string;
  networkEgress?: string;
  networkPolicy?: string;
  explicit?: boolean;
  securityHeaders?: boolean;
  corsOriginCount?: number;
  maxFileBytes?: number;
  maxProjectBytes?: number;
  maxConcurrentTasks?: number;
  maxQueuedTasks?: number;
  maxRuntimeProxyConnections?: number;
  runtimeQuotaCheckIntervalMs?: number;
  retentionDays?: number;
  encrypted?: boolean;
  restoreDrill?: boolean;
  tracked?: boolean;
  releaseId?: string;
  appVersion?: string;
  revision?: string;
  createdAt?: string;
  skills?: number;
  images?: number;
  [key: string]: unknown;
}

export interface WebReadiness {
  ok: boolean;
  checks: Record<string, WebReadinessCheck>;
}

export interface WebAuthMethods {
  mode: "development" | "local" | "oidc";
  /** Whether this deployment accepts new accounts. Only ever true for `local`. */
  selfRegistration?: boolean;
  oidc?: {
    label: string;
    startUrl: string;
  };
}

export function getWebProjectId(): string {
  if (typeof window === "undefined") return "default";
  const bound = window.sessionStorage.getItem(PROJECT_KEY);
  if (bound) return bound;
  // The remembered default initializes a new tab once. Another tab's project
  // switch cannot retarget this tab's API headers or native frame.
  const selected = window.localStorage.getItem(PROJECT_KEY) || "default";
  window.sessionStorage.setItem(PROJECT_KEY, selected);
  return selected;
}

export function setWebProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(PROJECT_KEY, projectId);
  window.localStorage.setItem(PROJECT_KEY, projectId);
}

function clearWebSessionState(): void {
  webCsrfToken = null;
  webCsrfRefresh = null;
  // A ceiling belongs to the account that hit it, so it leaves with the session.
  lastUsageBudgetRefusal = null;
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(PROJECT_KEY);
    window.localStorage.removeItem(PROJECT_KEY);
  }
}

function notifyWebSessionEnded(): void {
  clearWebSessionState();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT));
}

function notifyWebSessionStarted(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT));
}

function rememberCsrfToken(value: unknown): void {
  if (value && typeof value === "object" && "csrfToken" in value) {
    const token = (value as { csrfToken?: unknown }).csrfToken;
    if (typeof token === "string" && token.length > 0) webCsrfToken = token;
  }
}

async function ensureWebCsrfToken(): Promise<string | null> {
  if (!hasWebApi || webCsrfToken) return webCsrfToken;
  if (!webCsrfRefresh) {
    webCsrfRefresh = fetch(apiUrl("/me"), {
      credentials: "include",
      headers: { "X-Open-Science-Project": getWebProjectId() },
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
        rememberCsrfToken(body?.data);
        return webCsrfToken;
      })
      .finally(() => {
        webCsrfRefresh = null;
      });
  }
  return webCsrfRefresh;
}

export function getWebApiRequestHeaders(): Record<string, string> {
  return {
    "X-Open-Science-Project": getWebProjectId(),
    ...(webCsrfToken ? { [CSRF_HEADER]: webCsrfToken } : {}),
  };
}

export async function fetchWithWebAuth(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("X-Open-Science-Project")) {
    headers.set("X-Open-Science-Project", getWebProjectId());
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    await ensureWebCsrfToken();
    if (webCsrfToken && !headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, webCsrfToken);
  }
  const response = await fetch(input, {
    ...init,
    credentials: init.credentials ?? "include",
    headers,
  });
  if (response.status === 401) notifyWebSessionEnded();
  return response;
}

function commandUrl(command: string): string {
  return apiUrl(`/commands/${encodeURIComponent(command)}`);
}

function apiUrl(path: string): string {
  const apiRoot = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  return `${apiRoot}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const envelope = body && typeof body === "object" ? body as Record<string, unknown> : null;
    const message = envelope && typeof envelope.error === "string"
      ? envelope.error
      : typeof body === "string" && body
        ? body
        : `HTTP ${res.status}`;
    throw new WebApiError(message, {
      status: res.status,
      code: envelope && typeof envelope.code === "string" ? envelope.code : null,
      requestId: envelope && typeof envelope.requestId === "string" ? envelope.requestId : null,
      details: envelope?.details,
      // The body is not the whole refusal: the reset moment travels as a
      // header, and reading only the JSON is how "近 3 小时后额度开始释放"
      // became "请重试" on the one surface where retrying cannot work.
      retryAfterSeconds: webRetryAfterSeconds(res.headers),
    });
  }

  if (body && typeof body === "object" && "data" in body) {
    rememberCsrfToken((body as { data: unknown }).data);
    return (body as { data: T }).data;
  }
  return body as T;
}

async function invokeWebCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const res = await fetchWithWebAuth(commandUrl(command), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Open-Science-Project": getWebProjectId(),
    },
    body: JSON.stringify(args ?? {}),
  });
  return parseApiResponse<T>(res);
}

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (hasWebApi) {
    return invokeWebCommand<T>(command, args);
  }
  throw new BackendUnavailableError(command);
}

export async function loginWeb(username: string, password: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("auth.login");
  const res = await fetch(apiUrl("/auth/login"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  await parseApiResponse<{ user: { id: string; name: string }; csrfToken?: string }>(res);
  notifyWebSessionStarted();
}

/**
 * Create an account and sign in with it, in one call.
 *
 * The server signs the new account in itself, so this settles the same way a
 * login does — including the session-started event the shell listens for.
 */
export async function registerWeb(username: string, password: string, name?: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("auth.register");
  const res = await fetch(apiUrl("/auth/register"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, ...(name ? { name } : {}) }),
  });
  await parseApiResponse<{ user: { id: string; name: string }; csrfToken?: string }>(res);
  notifyWebSessionStarted();
}

export async function loginDevelopmentWeb(): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("auth.devLogin");
  const res = await fetch(apiUrl("/auth/dev-login"), {
    method: "POST",
    credentials: "include",
  });
  await parseApiResponse<{ user: { id: string; name: string } }>(res);
  notifyWebSessionStarted();
}

export async function logoutWeb(): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("auth.logout");
  const res = await fetchWithWebAuth(apiUrl("/auth/logout"), { method: "POST" });
  await parseApiResponse<boolean>(res);
  notifyWebSessionEnded();
}

export async function fetchWebAuthMethods(): Promise<WebAuthMethods> {
  if (!hasWebApi) throw new BackendUnavailableError("auth.methods");
  const res = await fetch(apiUrl("/auth/methods"), {
    credentials: "include",
  });
  return parseApiResponse<WebAuthMethods>(res);
}

export function getWebOidcStartUrl(returnTo = "/app/settings"): string {
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/app/settings";
  return `${apiUrl("/auth/oidc/start")}?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

/**
 * What this deployment serves as its session surface.
 *
 * A deployment decision, not a build flag. It carries no kernel name: `/api/me`
 * still reports one and the browser deliberately ignores it, because the
 * frontend knowing which kernel is running is how a kernel change became a
 * frontend change (AGENTS.md: the browser never reaches a kernel).
 */
export interface WebRuntimeProfile {
  /** Separate native application origin; each frame pins one authenticated project. */
  uiOrigin: string;
}

/**
 * The deployment's runtime profile, remembered from the last `/api/me`.
 *
 * Empty until the control plane answers. A missing native origin displays an
 * explicit unavailable state rather than selecting another prompt path.
 */
let runtimeProfile: WebRuntimeProfile = { uiOrigin: "" };

function rememberRuntimeProfile(profile: (WebRuntimeProfile & { sessionView?: string }) | undefined): void {
  if (!profile) return;
  // `sessionView` used to gate this whole assignment, from when it chose
  // between two views. There is one view now, and a field nothing reads must
  // not decide whether a field everything reads is kept — the server dropping
  // it would have silently taken `uiOrigin` with it, and the session surface
  // would have quietly reverted with nothing to point at.
  //
  // A missing origin is an unavailable native surface, represented explicitly.
  runtimeProfile = { uiOrigin: typeof profile.uiOrigin === "string" ? profile.uiOrigin : "" };
}

/** @returns what this deployment serves as its session surface */
export function webRuntimeProfile(): WebRuntimeProfile {
  return runtimeProfile;
}

export interface WebRuntimeUiFrame {
  frameId: string;
  frameUrl: string;
  expiresAt: number;
  renewalToken: string;
}

/** Create one immutable native frame through the authenticated control plane. */
export async function createWebRuntimeUiFrame(projectId: string): Promise<WebRuntimeUiFrame> {
  const res = await fetchWithWebAuth(apiUrl("/runtime-ui/frames"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
  });
  return parseApiResponse<WebRuntimeUiFrame>(res);
}

/** Renew the original login/project binding; the proof never travels into the native document. */
export async function renewWebRuntimeUiFrame(frame: WebRuntimeUiFrame): Promise<WebRuntimeUiFrame> {
  const res = await fetchWithWebAuth(apiUrl(`/runtime-ui/frames/${encodeURIComponent(frame.frameId)}/renew`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ renewalToken: frame.renewalToken }),
  });
  return parseApiResponse<WebRuntimeUiFrame>(res);
}

/** Release only this frame's browser cookie; logout owns authority revocation. */
export async function releaseWebRuntimeUiFrame(frameId: string): Promise<void> {
  const res = await fetchWithWebAuth(apiUrl(`/runtime-ui/frames/${encodeURIComponent(frameId)}`), {
    method: "DELETE", keepalive: true,
  });
  await parseApiResponse(res);
}

export async function fetchWebMe(): Promise<{
  user: { id: string; name: string; tenantId?: string };
  tenant?: { id: string; model: "individual-account"; role: "owner" };
  project: WebProject;
  projects: WebProject[];
  csrfToken?: string;
  runtime?: WebRuntimeProfile;
} | null> {
  if (!hasWebApi) return null;
  const res = await fetchWithWebAuth(apiUrl("/me"), {
    credentials: "include",
    headers: { "X-Open-Science-Project": getWebProjectId() },
  });
  if (res.status === 401) {
    clearWebSessionState();
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: {
      user: { id: string; name: string; tenantId?: string };
      tenant?: { id: string; model: "individual-account"; role: "owner" };
      project: WebProject;
      projects: WebProject[];
      csrfToken?: string;
      runtime?: WebRuntimeProfile;
    };
  };
  rememberCsrfToken(body.data);
  rememberRuntimeProfile(body.data.runtime);
  return body.data;
}

export async function listWebProjects(): Promise<WebProject[]> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.list");
  const res = await fetchWithWebAuth(apiUrl("/projects"));
  return parseApiResponse<WebProject[]>(res);
}

/** Both the path and header keep an in-flight operation bound to its original project. */
async function webPluginRequest<T>(projectId: string, suffix: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithWebAuth(apiUrl(`/projects/${encodeURIComponent(projectId)}/plugins${suffix}`), {
    method,
    signal,
    headers: {
      "X-Open-Science-Project": projectId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseApiResponse<T>(res);
}

/** The plugin id is a path segment, so it is encoded like one. */
const pluginPath = (pluginId: string, suffix = "") => `/${encodeURIComponent(pluginId)}${suffix}`;

export async function listWebPlugins(projectId: string, signal?: AbortSignal): Promise<WebPluginState[]> {
  return (await webPluginRequest<{ plugins: WebPluginState[] }>(projectId, "", "GET", undefined, signal)).plugins;
}

export function saveWebPlugin(projectId: string, pluginId: string, input: { expectedRevision: number; enabled: boolean; settings: Record<string, number> }, signal?: AbortSignal): Promise<WebPluginState> {
  // Named fields, not the caller's object: the server refuses a request body
  // carrying anything outside the three it declares, so what is sent is built
  // from what this signature promises. `settings` passes through whole because
  // its keys are the plugin's own schema, which this layer does not know.
  return webPluginRequest(projectId, pluginPath(pluginId), "PUT", {
    expectedRevision: input.expectedRevision, enabled: input.enabled, settings: input.settings,
  }, signal);
}

export async function listWebPluginRevisions(projectId: string, pluginId: string, signal?: AbortSignal): Promise<WebPluginConfiguration[]> {
  return (await webPluginRequest<{ items: WebPluginConfiguration[] }>(projectId, pluginPath(pluginId, "/revisions"), "GET", undefined, signal)).items;
}

export function rollbackWebPlugin(projectId: string, pluginId: string, input: { expectedRevision: number; targetRevision: number }, signal?: AbortSignal): Promise<WebPluginState> {
  return webPluginRequest(projectId, pluginPath(pluginId, "/rollback"), "POST", {
    expectedRevision: input.expectedRevision, targetRevision: input.targetRevision,
  }, signal);
}

export function retryWebPlugin(projectId: string, pluginId: string, signal?: AbortSignal): Promise<WebPluginState> {
  return webPluginRequest(projectId, pluginPath(pluginId, "/retry"), "POST", {}, signal);
}

/**
 * Stop this project using a plugin.
 *
 * Not a deletion: the binary ships inside the runtime image, so what this
 * removes is the project's use of it — disabled, configuration back to its
 * defaults, recorded as a revision the history keeps.
 */
export function removeWebPlugin(projectId: string, pluginId: string, input: { expectedRevision: number }, signal?: AbortSignal): Promise<WebPluginState> {
  return webPluginRequest(projectId, pluginPath(pluginId), "DELETE", { expectedRevision: input.expectedRevision }, signal);
}

export async function createWebProject(id: string, name = id): Promise<WebProject> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.create");
  const res = await fetchWithWebAuth(apiUrl("/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  return parseApiResponse<WebProject>(res);
}

/**
 * Answers one question the kernel raised during a run.
 *
 * The id is the kernel's `eventId`, carried through the stream untouched: the
 * control plane proves the run belongs to the caller's project before it will
 * route an answer, and the event id alone would otherwise let a reply address
 * a question asked in a project the caller cannot see.
 *
 * A `deny` and a failed send are not the same outcome. This throws on failure
 * so the card can say the run is still waiting, rather than clearing itself on
 * a reply that never arrived.
 * @param runId @param eventId @param decision @param answer text, for `answer`
 */
export async function answerRunInteraction(
  runId: string,
  eventId: string,
  decision: "allow" | "deny" | "answer",
  answer?: string,
): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("runs.interactions.answer");
  const res = await fetchWithWebAuth(
    apiUrl(`/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(eventId)}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, ...(answer ? { answer } : {}) }),
    },
  );
  await parseApiResponse<{ eventId: string; accepted: boolean }>(res);
}

export async function listWebResearchAgents(): Promise<WebResearchAgent[]> {
  if (!hasWebApi) throw new BackendUnavailableError("agents.list");
  const res = await fetchWithWebAuth(apiUrl("/agents"));
  return parseApiResponse<WebResearchAgent[]>(res);
}

export async function fetchMemoryStatus(): Promise<WebMemoryStatus> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.status");
  const res = await fetchWithWebAuth(apiUrl("/memory/status"));
  return parseApiResponse<WebMemoryStatus>(res);
}

export async function listResearchMemories(state: "normal" | "archived" = "normal"): Promise<WebResearchMemory[]> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.list");
  const res = await fetchWithWebAuth(apiUrl(`/memory/memos?state=${encodeURIComponent(state)}`));
  return parseApiResponse<WebResearchMemory[]>(res);
}

export async function createResearchMemory(content: string): Promise<WebResearchMemory> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.create");
  const res = await fetchWithWebAuth(apiUrl("/memory/memos"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return parseApiResponse<WebResearchMemory>(res);
}

export async function updateResearchMemory(
  id: string,
  update: Partial<Pick<WebResearchMemory, "content" | "pinned" | "state">>,
): Promise<WebResearchMemory> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.update");
  const res = await fetchWithWebAuth(apiUrl(`/memory/memos/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return parseApiResponse<WebResearchMemory>(res);
}

export async function deleteResearchMemory(id: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.delete");
  const res = await fetchWithWebAuth(apiUrl(`/memory/memos/${encodeURIComponent(id)}`), { method: "DELETE" });
  await parseApiResponse<boolean>(res);
}

export async function fetchMemoryProfile(): Promise<WebMemoryProfile> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.profile");
  const res = await fetchWithWebAuth(apiUrl("/memory/profile"));
  return parseApiResponse<WebMemoryProfile>(res);
}

export async function updateStructuredMemory(
  record: WebStructuredMemory,
  update: Partial<Pick<WebStructuredMemory, "value" | "summary" | "status" | "importance" | "sensitive">>,
): Promise<WebStructuredMemory> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.record.update");
  const res = await fetchWithWebAuth(apiUrl(`/memory/records/${encodeURIComponent(record.id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...update, expectedVersion: record.version }),
  });
  return parseApiResponse<WebStructuredMemory>(res);
}

export async function deleteStructuredMemory(id: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("memory.record.delete");
  const res = await fetchWithWebAuth(apiUrl(`/memory/records/${encodeURIComponent(id)}`), { method: "DELETE" });
  await parseApiResponse<boolean>(res);
}

export async function listWebResearchSessions(): Promise<WebResearchSession[]> {
  if (!hasWebApi) throw new BackendUnavailableError("researchSessions.list");
  const res = await fetchWithWebAuth(apiUrl("/research-sessions"));
  return parseApiResponse<WebResearchSession[]>(res);
}

export async function putWebResearchSession(
  sessionId: string,
  selection: WebResearchSessionSelection,
): Promise<WebResearchSession> {
  if (!hasWebApi) throw new BackendUnavailableError("researchSessions.put");
  const res = await fetchWithWebAuth(apiUrl(`/research-sessions/${encodeURIComponent(sessionId)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  });
  return parseApiResponse<WebResearchSession>(res);
}

export async function listWebAgentRuns(): Promise<WebAgentRun[]> {
  if (!hasWebApi) throw new BackendUnavailableError("agentRuns.list");
  const res = await fetchWithWebAuth(apiUrl("/agent-runs"));
  return parseApiResponse<WebAgentRun[]>(res);
}

export async function dispatchWebAgentRun(
  sessionId: string,
  text: string,
  dispatchId: string,
): Promise<WebAgentRun> {
  if (!hasWebApi) throw new BackendUnavailableError("agentRuns.dispatch");
  const res = await fetchWithWebAuth(apiUrl("/agent-runs/dispatch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, dispatchId, text }),
  });
  return parseApiResponse<WebAgentRun>(res);
}


/**
 * Report what the researcher did with a deliverable.
 *
 * The other half of the feedback ledger. The memory routes record their own
 * events server-side, but nothing can observe an adoption or an edit from the
 * server: only the page that shows the file knows the researcher kept it or
 * revised it, so this call is the only way those two facts are ever recorded —
 * and they are the only two the distillation producer reads.
 *
 * The body is exactly the four fields the route accepts; it refuses any other
 * with 400. The content digest is not among them and must not be: the server
 * reads the deliverable out of the workspace and digests it there, so an edit
 * that changed nothing cannot be reported as one.
 */
export async function reportWebDeliverableFeedback(input: WebDeliverableFeedback): Promise<WebFeedbackRecord> {
  if (!hasWebApi) throw new BackendUnavailableError("feedback.record");
  const summary = input.summary?.trim() ?? "";
  const res = await fetchWithWebAuth(apiUrl("/feedback/events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trigger: input.trigger,
      runId: input.runId,
      path: input.path,
      ...(summary ? { summary } : {}),
    }),
  });
  return parseApiResponse<WebFeedbackRecord>(res);
}

export async function exportWebProject(projectId: string): Promise<Blob> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.export");
  const res = await fetchWithWebAuth(apiUrl(`/projects/${encodeURIComponent(projectId)}/export`));
  if (!res.ok) await parseApiResponse<never>(res);
  return res.blob();
}

export interface WebUsageSummary {
  /** Start of the period the totals cover (the current calendar month, UTC). */
  since: string;
  calls: number;
  cost: number;
  currency: string;
  promptTokens: number;
  completionTokens: number;
  /** Calls whose model the price list did not know — counted, not priced. */
  unpricedCalls: number;
  byModel: { model: string; calls: number; cost: number }[];
  reservedCalls?: number;
  uncertainCalls?: number;
  reservedCost?: number;
  priceVersions?: string[];
}

/** One external data source, with where its credential comes from for this
 *  account. The credential itself is never read back. */
export interface WebConnector {
  id: string;
  title: string;
  kind: "api-key" | "jwt" | "email";
  unlocks: string;
  obtainUrl: string;
  capabilities: string[];
  keyless: boolean;
  validityDays: number | null;
  source: "deployment" | "user" | "none";
  own: { updatedAt: string; expiresAt: string | null; expired: boolean } | null;
  needsAttention: boolean;
}

export async function fetchWebConnectors(): Promise<WebConnector[]> {
  if (!hasWebApi) throw new BackendUnavailableError("connectors.list");
  const res = await fetchWithWebAuth(apiUrl("/connectors"));
  return parseApiResponse<WebConnector[]>(res);
}

export async function saveWebConnectorCredential(connector: string, value: string): Promise<{ expiresAt: string | null }> {
  if (!hasWebApi) throw new BackendUnavailableError("connectors.save");
  const res = await fetchWithWebAuth(apiUrl(`/connectors/${encodeURIComponent(connector)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return parseApiResponse<{ connector: string; source: "user"; expiresAt: string | null }>(res);
}

export async function removeWebConnectorCredential(connector: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("connectors.remove");
  const res = await fetchWithWebAuth(apiUrl(`/connectors/${encodeURIComponent(connector)}`), { method: "DELETE" });
  await parseApiResponse<{ connector: string; removed: boolean }>(res);
}

export async function fetchWebAccountUsage(): Promise<WebUsageSummary> {
  if (!hasWebApi) throw new BackendUnavailableError("account.usage");
  const res = await fetchWithWebAuth(apiUrl("/account/usage"));
  return parseApiResponse<WebUsageSummary>(res);
}

export async function exportWebAccount(): Promise<Blob> {
  if (!hasWebApi) throw new BackendUnavailableError("account.export");
  const res = await fetchWithWebAuth(apiUrl("/account/export"));
  if (!res.ok) await parseApiResponse<never>(res);
  return res.blob();
}

export function webFileDownloadUrl(path: string, root?: WebFileRoot): string {
  if (!hasWebApi) throw new BackendUnavailableError("files.download");
  const params = new URLSearchParams({
    root: root === "base" ? "base" : "workspace",
    projectId: getWebProjectId(),
  });
  return apiUrl(`/files/download/${encodeURIComponent(path.replace(/\\/g, "/"))}?${params.toString()}`);
}

export async function downloadWebFile(path: string, root?: WebFileRoot): Promise<Blob> {
  const res = await fetchWithWebAuth(webFileDownloadUrl(path, root));
  if (!res.ok) await parseApiResponse<never>(res);
  return res.blob();
}

export async function deleteWebProject(projectId: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.delete");
  const res = await fetchWithWebAuth(apiUrl(`/projects/${encodeURIComponent(projectId)}`), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: projectId }),
  });
  await parseApiResponse<{ id: string }>(res);
}

export async function deleteWebAccount(confirm: string, password?: string): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("account.delete");
  const res = await fetchWithWebAuth(apiUrl("/account"), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm,
      ...(password ? { password } : {}),
    }),
  });
  await parseApiResponse<{ id: string }>(res);
  notifyWebSessionEnded();
}

export async function createWebTask(
  command: string,
  args?: Record<string, unknown>,
): Promise<WebTask> {
  if (!hasWebApi) throw new BackendUnavailableError("tasks.create");
  const res = await fetchWithWebAuth(apiUrl("/tasks"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Open-Science-Project": getWebProjectId(),
    },
    body: JSON.stringify({ command, args: args ?? {} }),
  });
  return parseApiResponse<WebTask>(res);
}

export async function listWebTasks(): Promise<WebTask[]> {
  if (!hasWebApi) throw new BackendUnavailableError("tasks.list");
  const res = await fetchWithWebAuth(apiUrl("/tasks"));
  return parseApiResponse<WebTask[]>(res);
}

export async function fetchWebTask(id: string): Promise<WebTask> {
  if (!hasWebApi) throw new BackendUnavailableError("tasks.get");
  const res = await fetchWithWebAuth(apiUrl(`/tasks/${encodeURIComponent(id)}`));
  return parseApiResponse<WebTask>(res);
}

export async function cancelWebTask(id: string): Promise<WebTask> {
  if (!hasWebApi) throw new BackendUnavailableError("tasks.cancel");
  const res = await fetchWithWebAuth(apiUrl(`/tasks/${encodeURIComponent(id)}/cancel`), {
    method: "POST",
  });
  return parseApiResponse<WebTask>(res);
}

export async function listWebAuditLog(limit = 100): Promise<WebAuditRecord[]> {
  if (!hasWebApi) throw new BackendUnavailableError("logs.audit");
  const res = await fetchWithWebAuth(apiUrl(`/logs/audit?limit=${encodeURIComponent(String(limit))}`));
  return parseApiResponse<WebAuditRecord[]>(res);
}

export async function listWebTaskEvents(limit = 100): Promise<WebTaskEvent[]> {
  if (!hasWebApi) throw new BackendUnavailableError("logs.tasks");
  const res = await fetchWithWebAuth(apiUrl(`/logs/tasks?limit=${encodeURIComponent(String(limit))}`));
  return parseApiResponse<WebTaskEvent[]>(res);
}

export async function listWebRuntimeEvents(limit = 100): Promise<WebRuntimeEvent[]> {
  if (!hasWebApi) throw new BackendUnavailableError("logs.runtime");
  const res = await fetchWithWebAuth(apiUrl(`/logs/runtime?limit=${encodeURIComponent(String(limit))}`));
  return parseApiResponse<WebRuntimeEvent[]>(res);
}

export async function listWebErrorEvents(limit = 100): Promise<WebErrorEvent[]> {
  if (!hasWebApi) throw new BackendUnavailableError("logs.errors");
  const res = await fetchWithWebAuth(apiUrl(`/logs/errors?limit=${encodeURIComponent(String(limit))}`));
  return parseApiResponse<WebErrorEvent[]>(res);
}

export async function listWebSecurityEvents(limit = 100): Promise<WebSecurityEvent[]> {
  if (!hasWebApi) throw new BackendUnavailableError("logs.security");
  const res = await fetchWithWebAuth(apiUrl(`/logs/security?limit=${encodeURIComponent(String(limit))}`));
  return parseApiResponse<WebSecurityEvent[]>(res);
}

export async function fetchWebMetrics(): Promise<WebMetrics> {
  if (!hasWebApi) throw new BackendUnavailableError("metrics");
  const res = await fetchWithWebAuth(apiUrl("/metrics"));
  return parseApiResponse<WebMetrics>(res);
}

export async function startWebRuntime(): Promise<string> {
  if (!hasWebApi) throw new BackendUnavailableError("runtime.start");
  return invokeWebCommand<string>("start_runtime");
}

export async function stopWebRuntime(): Promise<void> {
  if (!hasWebApi) throw new BackendUnavailableError("runtime.stop");
  await invokeWebCommand<null>("stop_runtime");
}

export async function restartWebRuntime(): Promise<string> {
  if (!hasWebApi) throw new BackendUnavailableError("runtime.restart");
  return invokeWebCommand<string>("restart_runtime");
}

/**
 * Creates a run session through the control plane.
 *
 * The browser asks the control plane, never a kernel. That is the property the
 * retired pass-through cost us: with a proxied kernel the page had to know the
 * kernel's protocol, so every kernel change was a frontend change.
 */
export async function createWebRuntimeSession(): Promise<{ id: string; kernel: string }> {
  if (!hasWebApi) throw new BackendUnavailableError("runtime.session.create");
  const res = await fetchWithWebAuth(apiUrl("/runtime/sessions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return parseApiResponse<{ id: string; kernel: string }>(res);
}

/** The whole run, in the control plane's vocabulary. */
export async function fetchWebRuntimeTranscript(sessionId: string): Promise<WebRunTranscript> {
  if (!hasWebApi) throw new BackendUnavailableError("runtime.session.transcript");
  const res = await fetchWithWebAuth(apiUrl(`/runtime/sessions/${encodeURIComponent(sessionId)}/transcript`));
  return parseApiResponse<WebRunTranscript>(res);
}

/** The transcript shape the control plane serves; mirrors `@evimed/domain`'s RunTranscript. */
export interface WebRunTranscript {
  sessionId: string;
  messages: {
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
  }[];
  turnEnd: { kind: string; code?: string; subCode?: string } | null;
  subagents: { sessionId: string; parentSessionId: string; label: string; capability: string }[];
  lastSeq: number;
}

export async function fetchWebReadiness(): Promise<WebReadiness> {
  if (!hasWebApi) throw new BackendUnavailableError("ready");
  const res = await fetchWithWebAuth(apiUrl("/ready"));
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await res.json()
    : await res.text();
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: WebReadiness }).data;
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string"
          ? body
          : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as WebReadiness;
}
