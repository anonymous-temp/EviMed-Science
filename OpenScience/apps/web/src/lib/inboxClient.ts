import { fetchWithWebAuth, WebApiError, webApiBase, webErrorMessage, webRetryAfterSeconds } from "./apiClient";

export interface InboxAction { id: string; label: string; style: "neutral" | "primary" | "danger" }
export interface InboxItem {
  id: string;
  projectId?: string | null;
  source?: { type: "run" | "thread" | "share" | "system" | "digest"; id: string } | null;
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
}
export interface InboxPageResult { items: InboxItem[]; nextCursor: string | null }

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

export function listInbox({ unread = false, cursor = null }: { unread?: boolean; cursor?: string | null } = {}) {
  const query = new URLSearchParams({ unread: String(unread) });
  if (cursor) query.set("cursor", cursor);
  return request<InboxPageResult>(`/inbox?${query}`);
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
