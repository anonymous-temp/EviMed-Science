/**
 * Runtime command boundary for desktop and web deployments.
 *
 * Desktop keeps using Tauri IPC. A hosted web build can set
 * VITE_OPEN_SCIENCE_API_URL and implement POST /api/commands/:command with a
 * JSON body matching the old Tauri command arguments.
 */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const rawWebApiBase = import.meta.env.VITE_OPEN_SCIENCE_API_URL?.trim() ?? "";

export const webApiBase = rawWebApiBase.replace(/\/+$/, "");
const PROJECT_KEY = "openScience.projectId";
const CSRF_HEADER = "X-Open-Science-CSRF";
export const WEB_SESSION_ENDED_EVENT = "open-science:web-session-ended";
export const WEB_SESSION_STARTED_EVENT = "open-science:web-session-started";
let webCsrfToken: string | null = null;
let webCsrfRefresh: Promise<string | null> | null = null;

export const hasWebApi = !isTauri && webApiBase.length > 0;

export const hasCommandBackend = isTauri || hasWebApi;

export class BackendUnavailableError extends Error {
  constructor(command: string) {
    super(`No desktop or web backend is configured for command "${command}".`);
    this.name = "BackendUnavailableError";
  }
}

export class WebApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(message: string, details: { status: number; code?: string | null; requestId?: string | null }) {
    super(message);
    this.name = "WebApiError";
    this.status = details.status;
    this.code = details.code ?? null;
    this.requestId = details.requestId ?? null;
  }
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

export interface WebAgentRun {
  id: string;
  dispatchId: string | null;
  dispatchStatus: "dispatching" | "accepted" | "unknown" | "rejected";
  sessionId: string;
  mode: "open-domain" | "specialist";
  agentId: string | null;
  agentVersion: string | null;
  runtimeAgent: string | null;
  effectiveAgentId?: string | null;
  effectiveAgentVersion?: string | null;
  effectiveRuntimeAgent?: string | null;
  model: string;
  status: WebAgentRunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  artifacts: string[];
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
  oidc?: {
    label: string;
    startUrl: string;
  };
}

export function getWebProjectId(): string {
  if (typeof window === "undefined") return "default";
  return window.localStorage.getItem(PROJECT_KEY) || "default";
}

export function setWebProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROJECT_KEY, projectId);
}

function clearWebSessionState(): void {
  webCsrfToken = null;
  webCsrfRefresh = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(PROJECT_KEY);
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
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
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

export function getWebOidcStartUrl(returnTo = "/settings"): string {
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/settings";
  return `${apiUrl("/auth/oidc/start")}?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export async function fetchWebMe(): Promise<{
  user: { id: string; name: string; tenantId?: string };
  tenant?: { id: string; model: "individual-account"; role: "owner" };
  project: WebProject;
  projects: WebProject[];
  csrfToken?: string;
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
    };
  };
  rememberCsrfToken(body.data);
  return body.data;
}

export async function listWebProjects(): Promise<WebProject[]> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.list");
  const res = await fetchWithWebAuth(apiUrl("/projects"));
  return parseApiResponse<WebProject[]>(res);
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


export async function exportWebProject(projectId: string): Promise<Blob> {
  if (!hasWebApi) throw new BackendUnavailableError("projects.export");
  const res = await fetchWithWebAuth(apiUrl(`/projects/${encodeURIComponent(projectId)}/export`));
  if (!res.ok) await parseApiResponse<never>(res);
  return res.blob();
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
