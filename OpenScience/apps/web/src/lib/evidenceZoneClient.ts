import { webErrorMessage } from "./apiClient";
import { productRequest } from "./productClient";

export interface EvidenceZone {
  id: string;
  createdAt?: string;
  creator?: string | null;
  revision: number;
  state: "draft" | "published";
  canEdit: boolean;
  title: string;
  description: string | null;
  background: string | null;
  experts: Array<{ name: string; institution: string | null }>;
  following: boolean;
  canFollow: boolean;
  canFeedback: boolean;
  canResearch: boolean;
  evidenceCount: number | null;
}
export interface EvidenceCard {
  id: string;
  revision: number;
  state: "draft" | "published";
  canEdit: boolean;
  zoneId: string;
  createdAt?: string;
  sourceItemId?: string | null;
  body: string;
  title: string;
  subtype: string | null;
  summary: string | null;
  creator: string | null;
  reviewer: string | null;
  reviewedAt: string | null;
  claims: Array<{ text: string }>;
  sources: Array<{ title: string; url: string | null; excerpt: string | null }>;
  limitations: string | null;
  discussion: Array<{
    id?: string;
    canDelete?: boolean;
    author: string;
    text: string;
    createdAt: string | null;
  }>;
  reviews?: EvidenceReview[];
  canReview?: boolean;
  review: { score: number | null; label: string } | null;
  canResearch: boolean;
}
export interface EvidencePage<T> {
  canCreate?: boolean;
  items: T[];
  total: number | null;
  nextCursor: string | null;
}
const id = (value: string) => encodeURIComponent(value);
const query = (
  q: string,
  cursor: string | null,
  scope?: "owned" | "following",
) => {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  if (scope) params.set("scope", scope);
  return params.size ? `?${params}` : "";
};
export const listEvidenceZones = (
  q = "",
  cursor: string | null = null,
  scope?: "owned" | "following",
) =>
  productRequest<EvidencePage<EvidenceZone>>(
    `/frontier/zones${query(q, cursor, scope)}`,
  );
export async function fetchEvidenceZone(zoneId: string) {
  return (
    await productRequest<{ zone: EvidenceZone }>(
      `/frontier/zones/${id(zoneId)}`,
    )
  ).zone;
}
export const listZoneEvidence = (
  zoneId: string,
  q = "",
  cursor: string | null = null,
  scope?: "owned",
) =>
  productRequest<EvidencePage<EvidenceCard>>(
    `/frontier/zones/${id(zoneId)}/evidence${query(q, cursor, scope)}`,
  );
export async function fetchZoneEvidence(zoneId: string, cardId: string) {
  return (
    await productRequest<{ evidence: EvidenceCard }>(
      `/frontier/zones/${id(zoneId)}/evidence/${id(cardId)}`,
    )
  ).evidence;
}
export async function followEvidenceZone(zone: EvidenceZone) {
  return (
    await productRequest<{ zone: EvidenceZone }>(
      `/frontier/zones/${id(zone.id)}/follow`,
      zone.following ? "DELETE" : "POST",
      { expectedRevision: zone.revision },
    )
  ).zone;
}
export const submitEvidenceZoneFeedback = (
  zone: EvidenceZone,
  feedbackInfo: string,
  requestId?: string,
) =>
  productRequest(`/frontier/zones/${id(zone.id)}/feedback`, "POST", {
    expectedRevision: zone.revision,
    feedbackInfo,
    requestId: requestId ?? crypto.randomUUID(),
  });
/** A server-authorized draft binds scope and revision; no imported prose becomes a prompt. */
export const prepareEvidenceResearch = (
  zone: EvidenceZone,
  evidence?: EvidenceCard,
) =>
  productRequest<{ draft: string }>(
    `/frontier/zones/${id(zone.id)}/research`,
    "POST",
    {
      expectedRevision: zone.revision,
      ...(evidence
        ? { evidenceId: evidence.id, evidenceRevision: evidence.revision }
        : {}),
    },
  );

export interface EvidenceZoneInput {
  title: string;
  description: string;
  background: string;
}
export interface EvidenceCardInput {
  sourceItemId?: string;
  title: string;
  subtype: "knowledge" | "academic";
  summary: string;
  body: string;
  sources: EvidenceCard["sources"];
  limitations: string;
}
export async function saveEvidenceZone(
  input: EvidenceZoneInput,
  zone?: EvidenceZone,
  requestId?: string,
) {
  return (
    await productRequest<{ zone: EvidenceZone }>(
      zone ? `/frontier/zones/${id(zone.id)}` : "/frontier/zones",
      zone ? "PATCH" : "POST",
      {
        ...input,
        requestId,
        ...(zone ? { expectedRevision: zone.revision } : {}),
      },
    )
  ).zone;
}
export async function publishEvidenceZone(
  zone: EvidenceZone,
  state: "published" | "draft" = "published",
) {
  return (
    await productRequest<{ zone: EvidenceZone }>(
      `/frontier/zones/${id(zone.id)}`,
      "PATCH",
      { expectedRevision: zone.revision, state },
    )
  ).zone;
}
export async function saveEvidenceCard(
  zoneId: string,
  input: EvidenceCardInput,
  card?: EvidenceCard,
  requestId?: string,
) {
  return (
    await productRequest<{ evidence: EvidenceCard }>(
      `/frontier/zones/${id(zoneId)}/evidence${card ? `/${id(card.id)}` : ""}`,
      card ? "PATCH" : "POST",
      {
        ...input,
        requestId,
        ...(card ? { expectedRevision: card.revision } : {}),
      },
    )
  ).evidence;
}
export async function publishEvidenceCard(
  card: EvidenceCard,
  state: "published" | "draft" = "published",
) {
  return (
    await productRequest<{ evidence: EvidenceCard }>(
      `/frontier/zones/${id(card.zoneId)}/evidence/${id(card.id)}`,
      "PATCH",
      { expectedRevision: card.revision, state },
    )
  ).evidence;
}
export const commentEvidenceCard = (
  card: EvidenceCard,
  text: string,
  requestId?: string,
) =>
  productRequest(
    `/frontier/zones/${id(card.zoneId)}/evidence/${id(card.id)}/comments`,
    "POST",
    { text, requestId: requestId ?? crypto.randomUUID() },
  );
export interface EvidenceReview {
  author: string;
  score: number;
  text: string;
  createdAt: string;
  revision: number;
  current: boolean;
}
export const reviewEvidenceCard = (
  card: EvidenceCard,
  score: number,
  text: string,
) =>
  productRequest(
    `/frontier/zones/${id(card.zoneId)}/evidence/${id(card.id)}/review`,
    "POST",
    { expectedRevision: card.revision, score, text },
  );

export const fetchEvidenceZoneDetail = (zoneId: string) =>
  productRequest<{
    zone: EvidenceZone;
    feedback: Array<{
      id: string;
      author: string;
      text: string;
      createdAt: string;
    }>;
  }>(`/frontier/zones/${id(zoneId)}`);
export const listFollowedEvidence = (cursor: string | null = null) =>
  productRequest<EvidencePage<EvidenceCard>>(
    `/frontier/evidence${query("", cursor, "following")}`,
  );

export const deleteEvidenceComment = (card: EvidenceCard, commentId: string) =>
  productRequest(
    `/frontier/zones/${id(card.zoneId)}/evidence/${id(card.id)}/comments/${id(commentId)}`,
    "DELETE",
  );

/** Native evidence failures explain the action while keeping unsaved input intact. */
export function evidenceErrorMessage(error: unknown): string {
  return webErrorMessage(error, {
    codes: {
      evidence_invalid:
        "请检查必填项和长度；每个来源需填写标题，并提供有效的网页链接或原文引句。",
      evidence_query_invalid: "搜索条件无效，请清空搜索条件后重试。",
      evidence_revision_conflict:
        "内容已有更新，当前填写内容仍保留。请先复制修改，再关闭编辑并重新打开最新版本后保存。",
      evidence_cursor_invalid: "列表已有更新，请重新加载列表。",
      evidence_owner_required: "只有创建者可以修改或发布这项内容。",
      evidence_not_found: "这项内容已撤回或不存在，请返回专区查看。",
      evidence_request_conflict: "这次提交的内容已变更，请确认修改后重新提交。",
      evidence_reviewer_required:
        "创建者不能评议自己的证据，请由其他用户参与评议。",
      evidence_publication_incomplete:
        "发布前请填写证据正文，并添加至少一个有链接或原文引句的来源。",
    },
  });
}
