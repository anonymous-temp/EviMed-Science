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
  status: "candidate" | "approved" | "retired" | string;
  statusReason: string | null;
  origin: "inferred" | "explicit" | string;
  counts: { eligible: number; loaded: number; invoked: number; succeeded: number; validated: number; read: number } | null;
  evaluations: { verdict?: string; report?: string; at?: string }[];
  promotion: { status: string; reasons: string[]; missing: string[]; missingDetails?: MethodPromotionDetail[] };
  body: string;
  /** When it started being used, which is what 「新」 on its row is read from. */
  statusChangedAt?: string | null;
  /** How many successful deliveries it was distilled from — the 「从你改过的 3
   *  份报告学到」 in a learned method's own sentence. */
  trajectories?: number;
  createdAt: string;
  updatedAt: string;
}

export function listMethods(status?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return productRequest<{ items: WebMethod[]; nextCursor: string | null }>(`/methods?${params}`);
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

export function rollbackMethod(method: WebMethod, targetRevision: number) {
  return productRequest<WebMethod>(`/methods/${encodeURIComponent(method.id)}/rollback`, "POST", {
    expectedRevision: method.revision,
    targetRevision,
  });
}
