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
  /** What later became of the results produced under the body it holds now: reproduced by a trusted recalculation, or not
   *  or corrected. Association, never cause: `causalBenefit` is always "unproven" and `applicability` "unknown" until
   *  the engine's own diagnostics say otherwise. A separate axis from `counts`, which are about deliveries. */
  scientific?: {
    results: number; supports: number; against: number; assessed: number; neutral: number;
    applicability: "unknown" | "flagged" | "unflagged" | string; causalBenefit: "unproven" | string;
  };
  /** The situation it is for and the ones it must not be loaded into, as declared when it was learnt. */
  scope?: { applicability: string; counterexamples: string[]; current: boolean } | null;
  /** What was left when it was returned to an earlier body or stopped because results produced under it were found wrong. */
  links?: { type: string; at: string; results: number; against: number }[];
  /** Sources that a result it was learnt from or used for rests on, and that changed. A label beside the method: the
   *  notice says the source changed, never that the method was wrong. */
  sourceChanges?: { id: string; source: { id: string; doi?: string }; state: "changed" | "retracted"; reason: string; versionId: string;
    relation: "learnt_from" | "used_for"; at: string }[];
  createdAt: string;
  updatedAt: string;
}

/** The name a researcher reads for a method: its own line, else its name. */
export function methodTitle(method: Pick<WebMethod, "title" | "name">): string {
  return method.title || method.name;
}

export function listMethods(status?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return productRequest<{ items: WebMethod[]; nextCursor: string | null }>(`/methods?${params}`);
}

/**
 * How many pages a whole list reads at most: 40 of 50, far above any account's methods — the bound is there so a server
 * that kept answering with a cursor could not make a page read forever.
 */
const LIST_PAGES = 40;

/**
 * Every method of a status, page after page to the end. The memory page read the first page and ignored `nextCursor`
 * (2026-10-07 walk, D-P1-2): an account past fifty methods saw fifty, and nothing said so.
 */
export async function listAllMethods(status?: string): Promise<WebMethod[]> {
  const items: WebMethod[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const result: { items: WebMethod[]; nextCursor: string | null } = await listMethods(status, cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
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

/**
 * One body a method has held, as 「以前的版本」 lists it, with what a researcher reads to see what it said: its sentence, when it
 * applied and its steps — or its text, when it has no steps.
 */
export interface MethodVersion {
  version: number;
  revision: number;
  at: string | null;
  title: string | null;
  summary?: string | null;
  whenToUse?: string;
  steps?: string | null;
  body?: string;
  current: boolean;
}

/** A conversation a method or handbook was learned from, as 「从哪里学到的」 links it. */
export interface ConversationSource {
  projectId: string;
  sessionId: string;
  title: string;
  at: string | null;
}

/** The conversations that taught a method, newest lesson first; empty when none can be found. */
export function methodSources(method: Pick<WebMethod, "id">) {
  return productRequest<{ items: ConversationSource[] }>(`/methods/${encodeURIComponent(method.id)}/sources`);
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
