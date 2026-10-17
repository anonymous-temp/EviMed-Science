import type { ConversationSource, MethodVersion } from "./methodsClient";
import { productRequest } from "./productClient";

/**
 * The capability handbooks the platform learned for the account — what 「用在某个科研工具里」 lists under 做法 — as
 * `/api/handbooks` shows them to their owner. A handbook is what the learning loop made of a reviewed lesson for one
 * research tool; the researcher reads it and, when it is wrong for them, stops it or goes back, as for a learned method.
 */
export interface WebHandbook {
  id: string;
  /** The concurrency token: it moves on every write and is never shown as a version. */
  revision: number;
  /** The research tool it is for; `capabilityTitle` turns it into the name the researcher knows. */
  capabilityId: string | null;
  status: "active" | "retired" | string;
  /** What the researcher reads: a title and one sentence written for them. */
  title: string;
  summary: string | null;
  whenToUse: string;
  appliedAt: string | null;
  source: { projectId: string; sessionId: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** One handbook whole: the steps in the researcher's language (null when there are none) and the text written for the model. */
export interface WebHandbookDetail extends WebHandbook {
  body: string;
  steps: string | null;
  sources: ConversationSource[];
}

/** How many pages a whole list reads at most: far above any account's handbooks, so the read cannot run forever. */
const LIST_PAGES = 40;

export function listHandbooks(status: "active" | "retired", cursor?: string | null) {
  const params = new URLSearchParams({ status, limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return productRequest<{ items: WebHandbook[]; nextCursor: string | null }>(`/handbooks?${params}`);
}

/** Every handbook of a status, page after page to the end. */
export async function listAllHandbooks(status: "active" | "retired"): Promise<WebHandbook[]> {
  const items: WebHandbook[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const result: { items: WebHandbook[]; nextCursor: string | null } = await listHandbooks(status, cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}

export function handbookDetail(handbook: Pick<WebHandbook, "id">) {
  return productRequest<WebHandbookDetail>(`/handbooks/${encodeURIComponent(handbook.id)}`);
}

/** The bodies a handbook has held, newest first — never a counter write. */
export function handbookVersions(handbook: Pick<WebHandbook, "id">) {
  return productRequest<{ items: MethodVersion[] }>(`/handbooks/${encodeURIComponent(handbook.id)}/history`);
}

/** 「不再使用」: stopped, and restorable from 已忘记的内容. */
export function retireHandbook(handbook: WebHandbook, reason?: string) {
  return productRequest<WebHandbook>(`/handbooks/${encodeURIComponent(handbook.id)}/retire`, "POST", {
    expectedRevision: handbook.revision,
    ...(reason ? { reason } : {}),
  });
}

/** 「回到上一版」 and 恢复: save the body held at `targetRevision` forward. */
export function rollbackHandbook(handbook: Pick<WebHandbook, "id" | "revision">, targetRevision: number) {
  return productRequest<WebHandbook>(`/handbooks/${encodeURIComponent(handbook.id)}/rollback`, "POST", {
    expectedRevision: handbook.revision,
    targetRevision,
  });
}
