import { productRequest, type ProductPage, type ProductRecord } from "./productClient";

export interface AgendaPayload { title: string; topics: string[]; taskTypes: string[]; dailyBudgetCny: number; weeklyBudgetCny: number;
  maxEpisodeCny: number; scheduleHour: number; timeZone: string; enabled: boolean; status: string; pauseReason: string | null; outcomes: unknown[];
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
  decisions: Array<{ action: string; claimId: string; note: string; memory?: { status: string; reason?: string; code?: string } }> }
export type AgendaRecord = ProductRecord<AgendaPayload> & { projectId: string };
export type DigestRecord = ProductRecord<DigestPayload> & { projectId: string };

export function listAgendas(projectId: string) { return productRequest<ProductPage<AgendaRecord>>(`/autopilot/agendas?projectId=${encodeURIComponent(projectId)}`); }
export function createAgenda(input: Record<string, unknown>) { return productRequest<AgendaRecord>("/autopilot/agendas", "POST", input); }
export function startAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/start`, "POST", { expectedRevision: revision }); }
export function stopAgenda(id: string, revision: number) { return productRequest<AgendaRecord>(`/autopilot/agendas/${encodeURIComponent(id)}/stop`, "POST", { expectedRevision: revision }); }
export function scheduleAgenda(id: string, date: string) { return productRequest<{ episode: { id: string } }>(`/autopilot/agendas/${encodeURIComponent(id)}/schedule`, "POST", { date }); }
export function listDigests(projectId: string) { return productRequest<ProductPage<DigestRecord>>(`/autopilot/digests?projectId=${encodeURIComponent(projectId)}`); }
export function getDigest(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}`); }
export function markDigestOpened(id: string) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}/opened`, "POST", {}); }
export function decideDigest(id: string, input: { action: string; claimId: string; note: string }) { return productRequest<DigestRecord>(`/autopilot/digests/${encodeURIComponent(id)}/decisions`, "POST", input); }
