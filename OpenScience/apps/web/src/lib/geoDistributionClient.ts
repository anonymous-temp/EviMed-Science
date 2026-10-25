import { productRequest } from './productClient';
import type { GeoArticleLayer, GeoOrderCheck, GeoOrderState } from './geoClient';
import { GEO_SOURCE_RELATIONSHIP_LABELS_ZH } from '@evimed/domain';

export interface GeoExecutionOrder {
  id: string; articleId: string | null; articleTitle: string | null; media: string | null; domain: string | null;
  layer: GeoArticleLayer | null; state: GeoOrderState; priceCny: number | null; publishedUrl: string | null;
  articleResultVersionId: string | null; articleDigest: string | null; currentResultVersionId: string | null;
  versionState: 'current' | 'update_needed' | 'unknown'; checks: GeoOrderCheck[]; cancellable: boolean;
  createdAt: string | null; updatedAt: string | null; sentAt: string | null; submittedAt: string | null;
  acceptedAt: string | null; publishedAt: string | null; stateAt: string | null; refundSeenAt: string | null;
}
export interface GeoDistributionPage<T> { items: T[]; nextCursor: string | null; total: number }
export interface GeoOrderEvent {
  id: string; at: string | null; fromState: GeoOrderState | null; toState: GeoOrderState | null;
  phase: string | null; amountCny: number | null;
}
export interface GeoOrderDetail { order: GeoExecutionOrder; events: GeoDistributionPage<GeoOrderEvent> }
export interface GeoMoneyBalance {
  budgetCny: number | null; dailyCny: number | null; reservedCny: number; settledCny: number;
  refundedCny: number; spentCny: number; availableCny: number | null;
}
export interface GeoLedgerEntry {
  id: string; orderId: string | null; kind: string; amountCny: number; createdAt: string | null; balance: GeoMoneyBalance;
}
export interface GeoProjectLedger extends GeoDistributionPage<GeoLedgerEntry> {
  currency: 'CNY'; opening: GeoMoneyBalance | null; summary: GeoMoneyBalance;
}
export interface GeoDistributionPageInput { cursor?: string | null; limit?: number }
const base = (geoId: string) => `/geo/projects/${encodeURIComponent(geoId)}`;
function pageQuery(input: GeoDistributionPageInput & { articleId?: string } = {}): string {
  const params = new URLSearchParams();
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.articleId) params.set('articleId', input.articleId);
  return params.size ? `?${params}` : '';
}
export function getGeoExecutionOrders(geoId: string, input: GeoDistributionPageInput & { articleId?: string } = {}) {
  return productRequest<GeoDistributionPage<GeoExecutionOrder>>(`${base(geoId)}/distribution/orders${pageQuery(input)}`);
}
export function getGeoOrderDetail(geoId: string, orderId: string, input: GeoDistributionPageInput = {}) {
  return productRequest<GeoOrderDetail>(`${base(geoId)}/orders/${encodeURIComponent(orderId)}${pageQuery(input)}`);
}
export function getGeoProjectLedger(geoId: string, input: GeoDistributionPageInput = {}) {
  return productRequest<GeoProjectLedger>(`${base(geoId)}/distribution/ledger${pageQuery(input)}`);
}

export type GeoSourceRelationship = keyof typeof GEO_SOURCE_RELATIONSHIP_LABELS_ZH;
export interface GeoOwnershipTarget { kind: 'domain' | 'page'; value: string }
export interface GeoSourceOwnershipRecord {
  id: string; revision: number; target: GeoOwnershipTarget & { key: string; hostname: string };
  relation: GeoSourceRelationship; active: boolean; reason: string | null; reviewedAt: string; basis: 'user_annotation';
}
export interface GeoSourceOwnershipRead {
  current: GeoSourceOwnershipRecord | null;
  effective?: { relation: GeoSourceRelationship; origin: 'page' | 'domain' | 'unknown' } | null;
  history: { items: GeoSourceOwnershipRecord[]; nextBeforeRevision: number | null };
}
export function getGeoSourceOwnership(geoId: string, target: GeoOwnershipTarget, beforeRevision?: number) {
  // Keep full page addresses in the body rather than browser or proxy URL logs.
  return productRequest<GeoSourceOwnershipRead>(`${base(geoId)}/source-ownership/read`, 'POST', { target, ...(beforeRevision ? { beforeRevision } : {}) });
}
export function setGeoSourceOwnership(geoId: string, input: {
  target: GeoOwnershipTarget; relation: GeoSourceRelationship; expectedRevision: number; active?: boolean; reason?: string;
}) {
  return productRequest<GeoSourceOwnershipRecord>(`${base(geoId)}/source-ownership`, 'POST', input);
}

export interface GeoOwnedPublication {
  id: string; url: string; title: string; platform: string; status: 'active' | 'retired'; publishedAt: string | null;
  articleId: string | null; articleTitle: string | null; articleResultVersionId: string | null; articleDigest: string | null;
  currentResultVersionId: string | null; currentDigest: string | null; versionState: 'current' | 'update_needed' | 'unknown';
}
export interface GeoPublicationReceipt {
  revision: number; recordedAt: string; basis: 'legacy_record' | 'user_reported_update'; linkId: string; url: string;
  articleId: string | null; resultVersionId: string | null; digest: string | null; publishedAt: string | null;
}
export interface GeoOwnedPublicationDetail {
  link: GeoOwnedPublication; revision: number;
  history: { items: GeoPublicationReceipt[]; nextBeforeRevision: number | null };
}
export function getGeoOwnedPublications(geoId: string, input: GeoDistributionPageInput = {}) {
  return productRequest<GeoDistributionPage<GeoOwnedPublication>>(`${base(geoId)}/owned-links${pageQuery(input)}`);
}
export function getGeoOwnedPublication(geoId: string, linkId: string, beforeRevision?: number) {
  return productRequest<GeoOwnedPublicationDetail>(`${base(geoId)}/owned-links/${encodeURIComponent(linkId)}${beforeRevision ? `?beforeRevision=${beforeRevision}` : ''}`);
}
export function confirmGeoOwnedPublication(geoId: string, linkId: string, input: {
  requestKey: string; expectedRevision: number; expectedResultVersionId: string | null; expectedDigest: string | null;
  resultVersionId: string; digest: string; publishedAt: string;
}) {
  return productRequest<GeoPublicationReceipt>(`${base(geoId)}/owned-links/${encodeURIComponent(linkId)}/published-version`, 'POST', input);
}
