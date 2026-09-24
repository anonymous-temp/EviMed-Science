import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export interface AgendaPayload { title: string; topics: string[]; taskTypes: string[]; dailyBudgetCny: number; weeklyBudgetCny: number;
  maxEpisodeCny: number; scheduleHour: number; timeZone: string; enabled: boolean; status: string; pauseReason: string | null; outcomes: unknown[];
  /** The agenda-zone day (`YYYY-MM-DD`) the scheduler last queued a run for. */
  lastScheduledDate?: string | null;
  userSignal?: { score: number; decided: number; rejected: boolean } | null;
  followUps?: Array<{ digestId: string; claimId: string; note: string; at: string; consumedBy?: string }> }
export interface DigestClaim { id: string; statement: string;
  /** How far the claim has been checked: only an independent rerun reaches `reproduced`. */
  tier?: string; type?: string;
  /** What an independent refuter concluded: refuted / weakened / stands. */
  refutation?: string | null;
  verification?: { status: string; verdict?: string; reason?: string; code?: string; reproductionMatched?: boolean } | null }
export interface DigestPayload { date: string; costCny: number; headlines: DigestClaim[]; leads: DigestClaim[];
  openedAt?: string | null;
  /** The runs this briefing merged; each is a conversation. */
  agendaId?: string; episodeIds?: string[];
  decisions: Array<{ action: string; claimId: string; note: string; memory?: { status: string; reason?: string; code?: string } }> }
/** One scheduled run of an agenda: the conversation it ran in and the briefing it fed. */
export interface EpisodePayload { agendaId: string; taskType: string; date: string; budgetCny: number;
  status: "queued" | "running" | "merged" | "failed" | "canceled" | string;
  runId: string | null; sessionId?: string | null; digestId?: string | null;
  error?: { code: string } | null; createdAt: string; updatedAt: string }
export type EpisodeRecord = ProductRecord<EpisodePayload> & { projectId: string };
export type AgendaRecord = ProductRecord<AgendaPayload> & { projectId: string };
export type DigestRecord = ProductRecord<DigestPayload> & { projectId: string };

export function listAgendas(projectId: string) { return productRequest<ProductPage<AgendaRecord>>(`/autopilot/agendas?projectId=${encodeURIComponent(projectId)}`); }
export function createAgenda(input: Record<string, unknown>) { return productRequest<AgendaRecord>("/autopilot/agendas", "POST", input); }
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
