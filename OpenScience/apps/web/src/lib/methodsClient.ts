import { productRequest } from "./productClient";

/** What still stands between a candidate method and use, as a code and its numbers. */
export interface MethodPromotionDetail {
  code: string;
  [key: string]: string | number | string[];
}

/** One learned or written method, as `/api/methods` shows it to its owner. */
export interface WebMethod {
  id: string;
  projectId: string | null;
  revision: number;
  name: string;
  description: string;
  whenToUse: string;
  /** What the researcher reads: a title and one sentence in their language.
   *  `name` and `description` are written for the model. Null until written. */
  title?: string | null;
  summary?: string | null;
  status: "candidate" | "approved" | "retired" | string;
  statusReason: string | null;
  origin: "inferred" | "explicit" | string;
  counts: { eligible: number; loaded: number; invoked: number; succeeded: number; validated: number; read: number } | null;
  evaluations: { verdict?: string; report?: string; at?: string }[];
  promotion: { status: string; reasons: string[]; missing: string[]; missingDetails?: MethodPromotionDetail[] };
  body: string;
  /** Which body this is, counting from 1: what 「第 N 版」 means. `revision`
   *  moves on every write, counters included, and is never shown. */
  version?: number;
  /** When the body last changed. */
  bodyUpdatedAt?: string | null;
  /** The steps in the researcher's language, when they render the current
   *  body; `body` is the SKILL.md written for the model. */
  steps?: string | null;
  /** When it started being used, which is what 「新」 on its row is read from. */
  statusChangedAt?: string | null;
  /** How many successful deliveries it was distilled from — the 「从你改过的 3
   *  份报告学到」 in a learned method's own sentence. */
  trajectories?: number;
  createdAt: string;
  updatedAt: string;
}

/** The name a researcher reads for a method: its own line, else its name. */
export function methodTitle(method: Pick<WebMethod, "title" | "name">): string {
  return method.title || method.name;
}

/** Account-wide outcomes from the durable learning ledger, independent of pagination. */
export interface LearningSummary {
  methods: Record<string, number>;
  uses: Record<string, number>;
  lessons: { byTrigger: Record<string, number>; succeeded: number; failed: number };
  results: Record<string, number>;
  handbookCandidates: number;
  spend24hCny: number | null;
}

export function listMethods(status?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return productRequest<{ items: WebMethod[]; nextCursor: string | null; summary?: LearningSummary | null }>(`/methods?${params}`);
}

/**
 * There is no `createMethod` here any more. 「写一个方法」 existed twice — a
 * free-text form under 方法 and a SKILL.md editor on the methods page — and the
 * owner's ruling on 2026-09-20 is that a method is what the model learns over
 * time and that the page must never ask anyone to write one. Someone who wants
 * a standing instruction says it in a conversation and the extractor records it
 * as a preference (see the extraction instructions in `memoryIntelligence.mjs`).
 * `POST /api/methods` stays on the server for the operator path that seeds an
 * evaluation account.
 */

export function retireMethod(method: WebMethod, reason?: string) {
  return productRequest<WebMethod>(`/methods/${encodeURIComponent(method.id)}/retire`, "POST", {
    expectedRevision: method.revision,
    ...(reason ? { reason } : {}),
  });
}

/** One body a method has held, as 「历史版本」 lists it. */
export interface MethodVersion {
  version: number;
  revision: number;
  at: string | null;
  title: string | null;
  current: boolean;
}

/** The bodies a method has held, newest first — never a counter write. */
export function methodVersions(method: Pick<WebMethod, "id">) {
  return productRequest<{ items: MethodVersion[] }>(`/methods/${encodeURIComponent(method.id)}/history`);
}

export function rollbackMethod(method: WebMethod, targetRevision: number) {
  return productRequest<WebMethod>(`/methods/${encodeURIComponent(method.id)}/rollback`, "POST", {
    expectedRevision: method.revision,
    targetRevision,
  });
}
