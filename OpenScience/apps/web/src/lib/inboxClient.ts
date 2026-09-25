import { fetchWithWebAuth, WebApiError, webApiBase, webErrorMessage, webRetryAfterSeconds } from "./apiClient";

export interface InboxAction { id: string; label: string; style: "neutral" | "primary" | "danger" }

/**
 * How much an item may interrupt (2026-09-18, contract C1). Only `safety` is
 * allowed to: a clinical-safety finding is the one notice that must reach a
 * researcher who is not looking. `attention` means a person has something to
 * do; `info` is a record of something that happened.
 */
export type InboxSeverity = "safety" | "attention" | "info";

export interface InboxItem {
  id: string;
  projectId?: string | null;
  source?: { type: "run" | "thread" | "share" | "system" | "digest" | "memory" | "geo"; id: string } | null;
  noticeType: "notify" | "question" | "review";
  priority: number;
  title: string;
  body: string;
  actions: InboxAction[];
  count: number;
  readAt: string | null;
  resolvedAt: string | null;
  resolution: { actionId: string } | null;
  revision: number;
  createdAt: string;
  /** Absent on items written before the field existed; read as `info`. */
  severity?: InboxSeverity;
  /**
   * Items merged into one row share this key (per day, per project, for
   * 「研究已完成」); `count` says how many the row stands for.
   */
  groupKey?: string | null;
}
export interface InboxPageResult {
  items: InboxItem[];
  nextCursor: string | null;
  /**
   * Every unread item in scope, not the length of this page. The page is
   * capped at 50, and a badge that read the page's length could never say more
   * than 50 — 「99+」 was dead code for exactly that reason (B §1c).
   */
  unreadTotal?: number;
}

/** The bell's two numbers, from a route that returns nothing else. */
export interface InboxUnreadCount {
  unreadTotal: number;
  /** How many of those are clinical-safety findings. */
  safetyUnread: number;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null) as { data?: T; error?: string; code?: string; requestId?: string } | null;
  if (!response.ok || !value || !("data" in value)) {
    throw new WebApiError(value?.error ?? "The inbox response was unavailable.", {
      status: response.status, code: value?.code, requestId: value?.requestId,
      // Same reason as `productClient`: the reset moment travels as a header.
      retryAfterSeconds: webRetryAfterSeconds(response.headers),
    });
  }
  return value.data as T;
}

export function listInbox({ unread = false, cursor = null, limit }: { unread?: boolean; cursor?: string | null; limit?: number } = {}) {
  const query = new URLSearchParams({ unread: String(unread) });
  if (cursor) query.set("cursor", cursor);
  if (limit != null) query.set("limit", String(limit));
  return request<InboxPageResult>(`/inbox?${query}`);
}

const countOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The unread count and how much of it is clinical safety — the bell's whole
 * input. It used to download up to fifty full notices every minute to render
 * one integer (B §1c). A body that does not carry two counts is refused rather
 * than read as zero: "nothing unread" is a claim, and a malformed answer is not
 * evidence for it.
 */
export async function fetchInboxUnreadCount(): Promise<InboxUnreadCount> {
  const value = await request<Partial<InboxUnreadCount>>("/inbox/unread-count");
  const unreadTotal = countOf(value?.unreadTotal);
  const safetyUnread = countOf(value?.safetyUnread);
  if (unreadTotal == null || safetyUnread == null) {
    throw new WebApiError("The inbox count was malformed.", { status: 502, code: null, requestId: null });
  }
  return { unreadTotal, safetyUnread: Math.min(safetyUnread, unreadTotal) };
}

/** Marks every unread item read, whatever actions it carries. Idempotent. */
export function markAllInboxRead() {
  return request<{ updated: number }>("/inbox/read-all", "POST", {});
}

/**
 * The event every surface that changes the unread count dispatches, so the
 * bell does not wait out its poll to agree with the page the reader is on.
 */
export const INBOX_CHANGED_EVENT = "evimed:inbox-changed";

export function announceInboxChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
}

export function markInboxRead(id: string, expectedRevision: number) {
  return request<InboxItem>(`/inbox/${encodeURIComponent(id)}/read`, "POST", { expectedRevision });
}

export function resolveInboxItem(id: string, actionId: string, expectedRevision: number) {
  return request<InboxItem>(`/inbox/${encodeURIComponent(id)}/resolve`, "POST", { actionId, expectedRevision });
}

/**
 * The inbox's own wording over the shared projection.
 *
 * Only the two sentences that talk about a 消息 rather than a 记录 stay local:
 * a revision conflict and a deleted item are protocol facts no error code
 * expresses. Everything else — the registry's sentence for the code, the spend
 * ceilings with their amounts, the 401 — comes from the one dictionary, so the
 * inbox and the pages it links to cannot describe the same refusal differently.
 */
export function inboxErrorMessage(error: unknown) {
  return webErrorMessage(error, {
    statuses: {
      409: "消息已发生变化，请刷新后重试。",
      404: "这条消息已不存在。",
    },
  });
}
