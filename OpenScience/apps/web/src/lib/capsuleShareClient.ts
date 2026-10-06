import { fetchWithWebAuth, WebApiError, webApiBase } from "./apiClient";
import {
  productRequest, type CapsuleCard, type CapsuleExportSnapshot, type CapsuleRecord, type CapsuleTransferPreview,
} from "./productClient";

/**
 * Sharing a capsule with other accounts of this deployment (evidence-flywheel F17, 2026-10-05): a delivery to named accounts, a share
 * link, the recipient's side of both, taking either back, and the Agent Skills pack. Every address is this account's own; nothing here
 * names an account id.
 */

/** What became of one delivery, per recipient, as its sender reads it. */
export type DeliveryState = "delivered" | "opened" | "imported" | "declined" | "withdrawn" | "taken_down";
export interface SentDelivery {
  id: string; snapshotId: string; capsuleId: string; state: DeliveryState; createdAt: string;
  openedAt: string | null; importedAt: string | null; closedAt: string | null;
  recipient: { name: string };
}
export interface DeliveryAnswer { delivered: number; notDelivered: number; snapshot: CapsuleExportSnapshot | null }

export interface ShareLink {
  id: string; capsuleId: string; snapshotId: string; uses: number; maxUses: number; importedCount: number;
  expiresAt: string; createdAt: string; revokedAt: string | null; state: "active" | "expired" | "exhausted" | "revoked";
}
export interface CreatedShareLink { token: string; path: string; link: ShareLink }

/** What a recipient sees of a pack before taking it in. `preview` is null once a delivery is closed. */
export interface SharedPreview {
  preview: CapsuleTransferPreview | null;
  /** A delivery: who sent it and where it stands. A link: when it ends and how many uses are left. */
  delivery?: { id: string; state: DeliveryState; sender: { name: string } };
  link?: { expiresAt: string; usesLeft: number };
}
export interface PendingDelivery { id: string; state: DeliveryState; createdAt: string; sender: { name: string }; card: CapsuleCard | null }

const enc = encodeURIComponent;

export const deliverCapsule = (capsuleId: string, input: { recipients: string[]; scopes?: string[] }) =>
  productRequest<DeliveryAnswer>(`/capsules/${enc(capsuleId)}/deliveries`, "POST", input);
export const listSentDeliveries = (capsuleId: string) => productRequest<SentDelivery[]>(`/capsules/${enc(capsuleId)}/deliveries`);

export const createShareLink = (capsuleId: string, input: { scopes?: string[]; maxUses?: number; ttlDays?: number } = {}) =>
  productRequest<CreatedShareLink & { snapshot: CapsuleExportSnapshot }>(`/capsules/${enc(capsuleId)}/links`, "POST", input);
export const listShareLinks = (capsuleId: string) => productRequest<ShareLink[]>(`/capsules/${enc(capsuleId)}/links`);
export const revokeShareLink = (capsuleId: string, linkId: string) => productRequest<ShareLink>(`/capsules/${enc(capsuleId)}/links/${enc(linkId)}`, "DELETE", {});

export const openShareLink = (token: string) => productRequest<SharedPreview>(`/capsules/shared/${enc(token)}`);
export const importShareLink = (token: string, input: { expectedDigest: string; title?: string }) =>
  productRequest<CapsuleRecord>(`/capsules/shared/${enc(token)}/import`, "POST", input);

export const listPendingDeliveries = () => productRequest<PendingDelivery[]>("/capsules/deliveries");
export const openDelivery = (id: string) => productRequest<SharedPreview>(`/capsules/deliveries/${enc(id)}`);
export const importDelivery = (id: string, input: { expectedDigest: string; title?: string }) =>
  productRequest<CapsuleRecord>(`/capsules/deliveries/${enc(id)}/import`, "POST", input);
export const declineDelivery = (id: string) => productRequest<unknown>(`/capsules/deliveries/${enc(id)}/decline`, "POST", {});

/** The author's take-down of one snapshot: revoked, every recipient's copy disabled, each told why. */
export const takeDownSnapshot = (capsuleId: string, snapshotId: string, reason: string) =>
  productRequest<{ snapshots: number; copies: number; withdrawn: number }>(`/capsules/${enc(capsuleId)}/exports/${enc(snapshotId)}/takedown`, "POST", reason ? { reason } : {});

/** The approved learned methods as an Agent Skills pack: a zip of text, saved by the browser. */
export async function downloadMethodPack(capsuleId: string) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/capsules/${enc(capsuleId)}/methods/export?format=agent-skills`);
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new WebApiError(value?.error ?? "The method pack could not be exported.", { status: response.status, code: value?.code });
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "evimed-methods.zip"; anchor.click(); URL.revokeObjectURL(url);
}

/** A project's evidence-zone subscription (F18). */
export interface ZoneSubscriptionView {
  zoneId: string; projectId: string; subscribedAt: string; title: string | null; kind: string | null; cards: number;
  status: "active" | "unavailable"; reason: "unpublished" | "deleted" | null; message: string | null;
}
export const zoneSubscriptionStatus = (projectId: string, zoneId: string) =>
  productRequest<{ subscribed: boolean; subscription: ZoneSubscriptionView | null }>(`/capsules/subscriptions?projectId=${enc(projectId)}&zoneId=${enc(zoneId)}`);
export const subscribeZone = (projectId: string, zoneId: string) => productRequest<ZoneSubscriptionView>("/capsules/subscriptions", "POST", { projectId, zoneId });
export const unsubscribeZone = (projectId: string, zoneId: string) => productRequest<{ unsubscribed: boolean }>("/capsules/subscriptions", "DELETE", { projectId, zoneId });
