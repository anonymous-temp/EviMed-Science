import { fetchWithWebAuth, WebApiError, webApiBase } from "./apiClient";

export interface InboxAction { id: string; label: string; style: "neutral" | "primary" | "danger" }
export interface InboxItem {
  id: string;
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

export function inboxErrorMessage(error: unknown) {
  if (error instanceof WebApiError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status === 409) return "消息已发生变化，请刷新后重试。";
    if (error.status === 404) return "这条消息已不存在。";
  }
  return "操作未完成，请重试。";
}
