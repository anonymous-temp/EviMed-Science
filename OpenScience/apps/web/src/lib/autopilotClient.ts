import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export interface AgendaSchedule { kind: "once" | "daily" | "weekly"; timeZone: string; time: string; date?: string; weekdays?: number[] }
export interface AgendaMessage { requestId: string; note: string; episodeId?: string | null; runEpisodeId: string; at: string }
export interface AgendaPayload {
  prompt?: string; schedule?: AgendaSchedule; nextRunAt?: string | null;
  scheduleState?: "paused" | "scheduled" | "completed" | "archived"; archivedAt?: string | null;
  messages?: AgendaMessage[]; title: string; topics: string[]; taskTypes: string[]; dailyBudgetCny: number; weeklyBudgetCny: number;
  maxEpisodeCny: number; scheduleHour: number; timeZone: string; enabled: boolean; status: string; pauseReason: string | null; outcomes: unknown[];
  /** The agenda-zone day (`YYYY-MM-DD`) the scheduler last queued a run for. */
  lastScheduledDate?: string | null;
  userSignal?: { score: number; decided: number; rejected: boolean } | null;
  followUps?: Array<{ digestId: string; claimId: string; note: string; at: string; consumedBy?: string }> }
export interface AutopilotArtifactRef { projectId: string; runId: string; sessionId: string; path: string }
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
  trigger?: "scheduled" | "manual" | "follow-up"; scheduledAt?: string; occurrenceKey?: string | null;
  instruction?: string; followUpNote?: string; replyToEpisodeId?: string | null; requestId?: string;
 agendaId: string; taskType: string; date: string; budgetCny: number;
  status: "queued" | "running" | "merged" | "failed" | "canceled" | string;
  runId: string | null; sessionId?: string | null; digestId?: string | null;
  artifactRefs?: AutopilotArtifactRef[]; claims?: DigestClaim[];
  resourceDeferrals?: Record<string, { code: string; status: "waiting" | "exhausted"; retryAt?: string | null } | null>;
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
export function followUpAgenda(id: string, input: { requestId: string; note: string; episodeId?: string }) { return productRequest<{ episode: EpisodeRecord }>(`/autopilot/agendas/${encodeURIComponent(id)}/follow-ups`, "POST", input); }
export function startAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/start`, "POST", { expectedRevision: revision }); }
export function stopAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/stop`, "POST", { expectedRevision: revision }); }
export function scheduleAgenda(id: string, date: string) { return productRequest<{ episode: { id: string } }>(`/autopilot/agendas/${encodeURIComponent(id)}/schedule`, "POST", { date }); }
export function listEpisodes(projectId: string, agendaId?: string) {
  return productRequest<ProductPage<EpisodeRecord>>(`/autopilot/episodes?projectId=${encodeURIComponent(projectId)}${agendaId ? `&agendaId=${encodeURIComponent(agendaId)}` : ""}`);
}
// A briefing is read through the run that produced it (主动科研, 2026-09-23):
// its address resolves to that conversation, and opening a result records the
// read the stopping rules count. The per-finding decisions left the page with
// the briefing cards; the server keeps its routes.
export function getDigest(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}`); }
export function markDigestOpened(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}/opened`, "POST", {}); }
