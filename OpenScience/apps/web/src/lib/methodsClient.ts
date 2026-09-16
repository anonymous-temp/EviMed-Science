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
  createdAt: string;
  updatedAt: string;
}

export function listMethods(status?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return productRequest<{ items: WebMethod[]; nextCursor: string | null }>(`/methods?${params}`);
}

/** A method the researcher writes takes effect at once; see `learningRoutes.mjs`. */
export function createMethod(skill: string) {
  return productRequest<WebMethod>("/methods", "POST", { skill });
}

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
