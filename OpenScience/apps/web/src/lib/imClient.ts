import { fetchWithWebAuth, WebApiError, webApiBase, webRetryAfterSeconds } from "./apiClient";

/**
 * The IM module's routes (`/api/im`): Feishu scan-to-create, the binding, and
 * the channel list. Everything the settings page shows about a phone comes
 * from here; the control plane decides what exists, the page only renders it.
 */

export type ImChannelState = "ready" | "not-configured" | "disabled";

export interface ImChannel {
  id: string;
  title: string;
  enabled: boolean;
  reserved: boolean;
  state: ImChannelState;
  reason: string | null;
}

export type FeishuRegistrationState =
  | "idle" | "starting" | "qr_ready" | "polling" | "slow_down" | "domain_switched" | "saving"
  | "succeeded" | "expired" | "cancelled" | "error";

export interface FeishuRegistration {
  state: FeishuRegistrationState;
  /** The SDK-built link: rendered as the QR code, and opened directly on a phone. */
  qrCodeUrl?: string;
  expiresAt?: string;
  remainingSeconds?: number;
  error?: { code: string; message: string };
  result?: { botName: string | null; pendingApproval: boolean; tenantBrand: string };
}

export interface FeishuConnection {
  state: "connecting" | "connected" | "reconnecting" | "failed" | "stopped";
  errorCode: string | null;
  since: string;
  retryAt: string | null;
}

export interface FeishuBinding {
  bound: true;
  botName: string | null;
  appId: string;
  tenantBrand: "feishu" | "lark";
  boundAt: string;
  activation: "active" | "pending" | "disabled";
  connection: FeishuConnection | null;
  notifications: boolean;
  chats: Array<{ chatType: "p2p" | "group"; projectId: string | null; projectName: string | null; updatedAt: string }>;
}

export interface ImStatus {
  /** False when the deployment has not turned the module on: the page hides the tab. */
  enabled: boolean;
  available: boolean;
  channels: ImChannel[];
  feishu: FeishuBinding | { bound: false } | null;
  registration: FeishuRegistration | null;
}

/** The registration states that are still waiting on the person or on Feishu. */
export const ACTIVE_REGISTRATION_STATES: ReadonlySet<FeishuRegistrationState> = new Set([
  "starting", "qr_ready", "polling", "slow_down", "domain_switched", "saving",
]);

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null) as { data?: T; error?: string; code?: string; requestId?: string } | null;
  if (!response.ok || !value || !("data" in value)) {
    throw new WebApiError(value?.error ?? "The messaging response was unavailable.", {
      status: response.status, code: value?.code, requestId: value?.requestId,
      retryAfterSeconds: webRetryAfterSeconds(response.headers),
    });
  }
  return value.data as T;
}

export function fetchImStatus() {
  return request<ImStatus>("/im/channels");
}

export function startFeishuRegistration() {
  return request<FeishuRegistration>("/im/feishu/registration", "POST", {});
}

export function fetchFeishuRegistration() {
  return request<FeishuRegistration>("/im/feishu/registration");
}

export function cancelFeishuRegistration() {
  return request<FeishuRegistration>("/im/feishu/registration", "DELETE");
}

export function unbindFeishu() {
  return request<{ removed: number }>("/im/feishu", "DELETE");
}

interface InboxPreferences {
  quietHours: { start: string; end: string };
  digestTime: string;
  switches: { notify: boolean; question: boolean; review: boolean };
  channels: string[];
  revision: number;
}

/**
 * Turn pushes to Feishu on or off. The preference belongs to the inbox, so it
 * is written through the inbox's own route with everything else unchanged.
 */
export async function setFeishuNotifications(enabled: boolean) {
  const current = await request<InboxPreferences>("/inbox/preferences");
  const others = current.channels.filter((channel) => channel !== "feishu" && channel !== "in-app");
  const channels = ["in-app", ...others, ...(enabled ? ["feishu"] : [])];
  return request<InboxPreferences>("/inbox/preferences", "PATCH", {
    quietHours: current.quietHours,
    digestTime: current.digestTime,
    switches: current.switches,
    channels,
    expectedRevision: current.revision,
  });
}
