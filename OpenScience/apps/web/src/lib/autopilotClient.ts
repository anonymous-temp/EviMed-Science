import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export interface AgendaSchedule { kind: "once" | "daily" | "weekly"; timeZone: string; time: string; date?: string; weekdays?: number[] }
/** What the researcher wrote to the question; `paused` marks a message that asked to hold the research and was answered by pausing it (no episode ran). */
export interface AgendaMessage { requestId: string; note: string; episodeId?: string | null; runEpisodeId: string | null; outcome?: "paused"; at: string }
export interface AgendaPayload {
  sessionId?: string | null;
  prompt?: string; schedule?: AgendaSchedule; nextRunAt?: string | null;
  scheduleState?: "paused" | "scheduled" | "completed" | "archived"; archivedAt?: string | null;
  messages?: AgendaMessage[]; title: string; topics: string[]; taskTypes: string[]; dailyBudgetCny: number; weeklyBudgetCny: number;
  maxEpisodeCny: number; scheduleHour: number; timeZone: string; enabled: boolean; status: string; pauseReason: string | null; outcomes: unknown[];
  /** The error code behind a pause that is not the researcher's or the planner's (a per-episode cap below the floor); its sentence is the registry's. */
  pauseCode?: string | null;
  /** The agenda-zone day (`YYYY-MM-DD`) the scheduler last queued a run for. */
  lastScheduledDate?: string | null;
  userSignal?: { score: number; decided: number; rejected: boolean } | null;
  /** Task types paused after repeated failures to run; the others go on. */
  taskTypeState?: Record<string, { consecutiveFailures?: number; pausedAt?: string | null; pauseReason?: string | null }>;
  /** Why the agenda was paused because another episode would add nothing, until the researcher starts it again. */
  plannerStop?: { kind: "answered" | "exhausted" | "needs_input" | "paused_by_researcher"; reason: string; at: string } | null;
  /** The sources the researcher associated with this question (the files are in the project's knowledge base). */
  materials?: Array<{ sourceId: string; addedAt: string }>;
  followUps?: Array<{ digestId: string; claimId: string; note: string; at: string; consumedBy?: string }> }
/** What the researcher reads about one question: what was found, what is unresolved, and the material they added. */
export interface ResearchState {
  agendaId: string; asOf: string; truncated: boolean;
  found: Array<{ statement: string; check: "reproduced" | "stands" | "refuted"; sources: number; date: string }>;
  /** `not_rechecked`: no independent check will be made of it, for the `reason` (`VERIFICATION_UNSCHEDULED_REASONS`). */
  unresolved: Array<{ kind: "unchecked" | "check_unavailable" | "not_rechecked" | "weakened" | "question" | "not_run"; text?: string; date?: string; reason?: string }>;
  materials: Array<{ sourceId: string; name: string; addedAt: string; state: "reading" | "ready" | "attention" | "unavailable" }>;
}
export interface AutopilotArtifactRef { projectId: string; runId: string; sessionId: string; path: string; role?: string }
export interface DigestClaim { id: string; statement: string;
  /** How far the claim has been checked: only an independent rerun reaches `reproduced`. */
  tier?: string; type?: string;
  /** What an independent refuter concluded: refuted / weakened / stands. */
  refutation?: string | null;
  verification?: { status: string; verdict?: string; reason?: string; code?: string; reproductionMatched?: boolean; isolationEnforced?: boolean } | null }
export interface DigestPayload { date: string; costCny: number; headlines: DigestClaim[]; leads: DigestClaim[];
  openedAt?: string | null;
  /** The runs this briefing merged; each is a conversation. */
  agendaId?: string; episodeIds?: string[]; artifactRefs?: AutopilotArtifactRef[];
  decisions: Array<{ action: string; claimId: string; note: string; memory?: { status: string; reason?: string; code?: string } }> }
/** One scheduled run of an agenda: the conversation it ran in and the briefing it fed. */
export interface EpisodePayload {
  resultKind?: import("@evimed/domain").AgendaResultKind;
  trigger?: "scheduled" | "manual" | "follow-up"; scheduledAt?: string; occurrenceKey?: string | null;
  instruction?: string; followUpNote?: string; replyToEpisodeId?: string | null; requestId?: string;
 agendaId: string; taskType: string; date: string; budgetCny: number;
  status: "queued" | "running" | "merged" | "failed" | "canceled" | string;
  runId: string | null; sessionId?: string | null; digestId?: string | null;
  /**
   * Where the execution ran. `true`: in the researcher's own open project runtime — its conversation is the kernel's and can be
   * shown live. `false` (or absent, as on every execution before the field): in a bounded runtime that holds the project, so its
   * conversation cannot be opened until it ends and the page shows the run ledger's progress instead.
   */
  interactive?: boolean;
  artifactRefs?: AutopilotArtifactRef[]; claims?: DigestClaim[];
  resourceDeferrals?: Record<string, { code: string; status: "waiting" | "exhausted"; retryAt?: string | null } | null>;
  /** What the episode was chosen to do: by the model from the progress, or by the date rotation when the model could not be asked. */
  selection?: { source: "model" | "date-rotation"; taskType: string; focus?: string; reason?: string; fallbackReason?: string; priority?: "normal" | "reduced" } | null;
  error?: { code: string } | null; createdAt: string; updatedAt: string }
export type EpisodeRecord = ProductRecord<EpisodePayload> & { projectId: string };
export type AgendaRecord = ProductRecord<AgendaPayload> & { projectId: string };
export type DigestRecord = ProductRecord<DigestPayload> & { projectId: string };

export function listAgendas(projectId: string) { return productRequest<ProductPage<AgendaRecord>>(`/autopilot/agendas?projectId=${encodeURIComponent(projectId)}`); }
export function createAgenda(input: Record<string, unknown>) { return productRequest<AgendaRecord>("/autopilot/agendas", "POST", input); }
export function getAgenda(id: string) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}`); }
export function updateAgenda(id: string, input: Record<string, unknown>) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}`, "PATCH", input); }
export function archiveAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}`, "DELETE", { expectedRevision: revision }); }
export function runAgendaNow(id: string, requestId: string) { return productRequest<{ episode: EpisodeRecord }>(`/autopilot/agendas/${encodeURIComponent(id)}/run-now`, "POST", { requestId }); }
/** `episode` is null when the researcher's message asked to hold the research and it was paused instead. */
export function followUpAgenda(id: string, input: { requestId: string; note: string; episodeId?: string }) { return productRequest<{ episode: EpisodeRecord | null }>(`/autopilot/agendas/${encodeURIComponent(id)}/follow-ups`, "POST", input); }
export function getResearchState(id: string) { return productRequest<ResearchState>(`/autopilot/agendas/${encodeURIComponent(id)}/progress`); }
/** Associate sources of the question's project with it: by id (already in the knowledge base) or by the SHA-256 of the bytes just uploaded. */
export function addAgendaMaterials(id: string, input: { sourceIds?: string[]; sha256?: string[] }) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/materials`, "POST", input); }
export function removeAgendaMaterial(id: string, sourceId: string) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/materials/${encodeURIComponent(sourceId)}`, "DELETE"); }
/** Cancels this one execution — never the task: pausing is `stopAgenda`. Returns the episode as it now stands. */
export function cancelEpisode(agendaId: string, episodeId: string, requestId: string) {
  return productRequest<EpisodeRecord>(`/autopilot/agendas/${encodeURIComponent(agendaId)}/episodes/${encodeURIComponent(episodeId)}/cancel`, "POST", { requestId });
}
export function startAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/start`, "POST", { expectedRevision: revision }); }
export function stopAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/stop`, "POST", { expectedRevision: revision }); }
export function scheduleAgenda(id: string, date: string) { return productRequest<{ episode: { id: string } }>(`/autopilot/agendas/${encodeURIComponent(id)}/schedule`, "POST", { date }); }
export function listEpisodes(projectId: string, agendaId?: string) {
  return productRequest<ProductPage<EpisodeRecord>>(`/autopilot/episodes?projectId=${encodeURIComponent(projectId)}${agendaId ? `&agendaId=${encodeURIComponent(agendaId)}` : ""}`);
}
// A briefing is read through the run that produced it (定时任务, 2026-09-23):
// its address resolves to that conversation, and opening a result records the
// read the stopping rules count. The per-finding decisions left the page with
// the briefing cards; the server keeps its routes.
export function getDigest(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}`); }
export function markDigestOpened(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}/opened`, "POST", {}); }
