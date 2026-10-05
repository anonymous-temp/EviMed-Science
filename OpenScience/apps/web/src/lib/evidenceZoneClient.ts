import { webErrorMessage } from "./apiClient";
import { productRequest } from "./productClient";

/** Who owns a zone's voice: the platform (official), a company or doctor (product), a researcher (user). */
export type EvidenceZoneKind = "official" | "product" | "user";
/** Who may read a published zone: signed-in accounts, or anyone (the owner's own choice). */
export type EvidenceZoneVisibility = "platform" | "internet";
export interface EvidenceZone {
  id: string;
  createdAt?: string;
  creator?: string | null;
  revision: number;
  state: "draft" | "published";
  kind?: EvidenceZoneKind;
  visibility?: EvidenceZoneVisibility;
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
  claims: EvidenceClaim[];
  claimCount?: number;
  claimVerification?: EvidenceClaimCounts | null;
  producer?: EvidenceProducer | null;
  originality?: EvidenceOriginality | null;
  /** First-hand work (original analysis, recalculation, original research) as opposed to interpretation. */
  primary?: boolean;
  lineage?: EvidenceLineage | null;
  entityKeys?: string[];
  journeyStage?: { key: string; label: string } | null;
  disclosure?: EvidenceDisclosure | null;
  publicView?: EvidencePublicViewContent | null;
  /** The two views of this card, computed by the server from the same verified claims; absent in lists. */
  views?: { clinical: EvidenceClinicalView; public: EvidencePublicView } | null;
  sources: Array<{
    title: string;
    url: string | null;
    excerpt: string | null;
    sha256?: string;
    checkedAt?: string | null;
    coverage?: "full-text" | "abstract" | "excerpt";
    publicationStatus?: { kind: "retracted" | "corrected" | "concern"; notices: string[] } | null;
  }>;
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
  content?: EvidenceContent | null;
  editorial?: {
    author: { kind: "ai" | "human"; name: string; model?: string };
    lastEditor?: { userId: string; name: string; editedAt: string };
    reviewer: { kind: "ai"; name: string; model?: string } | null;
    sourceFingerprint?: string;
    sourceCheckedAt?: string | null;
    sourceChangedAt?: string | null;
    sourceChecks?: Array<{
      sourceIndex: number;
      status: "checked" | "retained";
      attemptedAt: string;
      code?: string;
    }>;
    status: "ai-reviewed" | "review-pending";
    findings?: Array<{ kind: string; text: string; sourceIndex?: number }>;
    reviewRevision: number | null;
    reviewedAt?: string | null;
  } | null;
  revisions?: Array<{
    revision: number;
    recordedAt: string;
    title: string;
    sourceFingerprint: string | null;
    reviewStatus: string | null;
  }>;
}
export type EvidenceProducerKind = "platform" | "enterprise" | "doctor" | "user" | "external";
export type EvidenceProducerRelation = "none" | "own_product" | "competitor_product" | "user_of_therapy" | "commercial_cooperation";
export interface EvidenceProducer {
  kind: EvidenceProducerKind;
  name: string;
  relation: EvidenceProducerRelation;
  products?: string[];
}
export type EvidenceOriginality = "original_analysis" | "recalculation" | "original_research" | "synthesis" | "brief";
export interface EvidenceLineage {
  frontierItemId?: string;
  resultVersionId?: string;
  runId?: string;
  agendaId?: string;
  episodeId?: string;
  previousCardId?: string;
  originCardId?: string;
  verifiedStudy?: { doi?: string; pmid?: string; registryId?: string };
}
export interface EvidenceDisclosure {
  model?: string;
  modelVersion?: string;
  generatedAt?: string;
  lastCheckedAt?: string;
  aiSteps: Array<"search" | "screen" | "extract" | "synthesize" | "review">;
  authors: Array<{ name: string; affiliation?: string; title?: string }>;
  reviewers: Array<{ name: string; affiliation?: string; title?: string }>;
}
/** ✓ verified, ⚠ a quotation not found or not checkable, null for a derived claim (it has no quotation). */
export type EvidenceClaimMark = "✓" | "⚠" | null;
export interface EvidenceClaimCounts {
  total: number;
  verified: number;
  quote_not_found: number;
  source_unavailable: number;
  no_quote: number;
  derived: number;
}
export interface EvidenceClaimVerification {
  claimId: string;
  claimType: string;
  status: "verified" | "quote_not_found" | "source_unavailable" | "no_quote" | "derived";
  mark: EvidenceClaimMark;
  sources: Array<{ sourceIndex: number | null; status: string; mark: EvidenceClaimMark; location?: unknown }>;
}
export interface EvidenceClaim {
  /** The statement, under the name the reading page renders. */
  text: string;
  claimId?: string;
  claimType?: "direct" | "synthesized" | "derived";
  claim?: string;
  /** 1-based positions in the card's own sources. */
  sourceIndexes?: number[];
  supportQuote?: string;
  supportingSources?: Array<{ sourceIndex: number; supportQuote?: string }>;
  confidence?: "high" | "moderate" | "low";
  applicability?: string;
  uncertainty?: string;
  derivedFrom?: string[];
  method?: string;
  assumptions?: string;
  sensitivity?: string;
  verification?: EvidenceClaimVerification | null;
}
export interface EvidencePublicViewContent {
  oneLineAnswer?: { text: string; claimIds: string[] };
  whatItIs?: { text: string; claimIds: string[] };
  labelSays?: { text: string; claimIds: string[] };
  notApplicable?: { text: string; claimIds: string[] };
  seekCareWhen?: { text: string; claimIds: string[] };
  commonMisunderstandings?: Array<{ misunderstanding: string; correction: string; observedIn?: string; claimIds: string[] }>;
}
export type EvidenceAbsoluteEffect =
  | { status: "computed"; per: 1000; unit: "people" | "person-years"; control: number; intervention: number; difference: number }
  | { status: "unavailable"; reason: "no_comparison" | "counts_missing" | "events_exceed_denominator" };
/** The GRADE summary-of-findings layout for doctors and pharmacists. */
export interface EvidenceClinicalView {
  kind: "clinical";
  header: {
    title: string | null;
    producer: EvidenceProducer | null;
    originality: EvidenceOriginality | null;
    primary: boolean;
    journeyStage: { key: string; label: string } | null;
    disclosure: EvidenceDisclosure | null;
    lastCheckedAt: string | null;
  };
  population: string | null;
  rows: Array<{
    title: string;
    outcome: string;
    timeframe: string;
    comparator: string | null;
    intervention: string | null;
    relativeEffect: string | null;
    absoluteEffect: EvidenceAbsoluteEffect;
    participants: number | null;
    studies: number | null;
    certainty: string | null;
    outcomeRole: "benefit" | "harm" | null;
    note: string | null;
    sourceIndexes: number[];
  }>;
  claims: EvidenceClaim[];
  counts: EvidenceClaimCounts;
}
export interface EvidenceFactBoxRow {
  index: number;
  outcome: string;
  timeframe: string;
  denominator: number;
  control: { label: string; per1000: number };
  intervention: { label: string; per1000: number };
  difference: number;
  sourceIndexes: number[];
}
/** Per 1000 people, one denominator for both arms, computed by the server; when it cannot be, `reason` says why. */
export interface EvidenceFactBox {
  status: "available" | "unavailable";
  reason?: "no_comparisons" | "outcome_role_missing" | "counts_missing" | "events_exceed_denominator" | "not_per_people" | "nothing_usable";
  per: 1000;
  unit: "people";
  benefits: EvidenceFactBoxRow[];
  harms: EvidenceFactBoxRow[];
  excluded: Array<{ index: number; reason: string }>;
}
/** The public layout: six panels the author filled, a seventh from the card, and the fact box. */
export interface EvidencePublicView {
  kind: "public";
  header: Omit<EvidenceClinicalView["header"], "lastCheckedAt">;
  panels: Array<{
    key: string;
    label: string;
    status: "written" | "missing";
    text?: string | null;
    claimIds?: string[];
    traced?: boolean;
    items?: Array<{ misunderstanding: string; correction: string; observedIn?: string; claimIds: string[]; traced: boolean }>;
    sources?: Array<{ title: string; url: string | null }>;
    checkedAt?: string | null;
  }>;
  factBox: EvidenceFactBox;
}
export interface EvidenceContent {
  question: string;
  answer: string;
  population: string;
  context?: string;
  nextStep?: string;
  sections?: Array<{ title: string; text: string; sourceIndexes?: number[] }>;
  tables?: Array<{
    title: string;
    columns: string[];
    rows: string[][];
    caption?: string;
    sourceIndexes: number[];
  }>;
  comparisons?: Array<{
    title: string;
    outcome: string;
    denominator: number;
    timeframe: string;
    measure?: "risk" | "rate";
    denominatorUnit?: "people" | "person-years";
    control: { label: string; events: number };
    intervention: { label: string; events: number };
    relativeEffect?: string;
    certainty?: string;
    sourceIndexes: number[];
    note?: string;
    participants?: number;
    studies?: number;
    outcomeRole?: "benefit" | "harm";
    valueSource?: "observed" | "extracted" | "calculated" | "imputed" | "aggregate" | "reconstructed" | "predicted" | "assumed" | "synthetic";
  }>;
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
  content?: EvidenceContent | null;
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
        sources: input.sources.map(({ title, url, excerpt }) => ({
          title,
          url,
          excerpt,
        })),
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

export interface EvidenceAutomation {
  enabled: boolean;
  query: string;
  sourceTypes: string[];
  intervalHours: number;
  maxCardsPerRun: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}
export interface EvidenceMaintenance {
  automation: EvidenceAutomation;
  jobs: { pending: number; running: number; failed: number };
  recent: Array<{
    id: string;
    state: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
    cardId?: string | null;
    sourceCheckStatus?: "partial" | "complete" | null;
  }>;
}
export const fetchEvidenceMaintenance = (zoneId: string) =>
  productRequest<EvidenceMaintenance>(
    `/frontier/zones/${id(zoneId)}/automation`,
  );
export const saveEvidenceMaintenance = (
  zone: EvidenceZone,
  automation: EvidenceAutomation,
) =>
  productRequest<EvidenceMaintenance>(
    `/frontier/zones/${id(zone.id)}/automation`,
    "PUT",
    {
      enabled: automation.enabled,
      query: automation.query,
      sourceTypes: automation.sourceTypes,
      intervalHours: automation.intervalHours,
      maxCardsPerRun: automation.maxCardsPerRun,
      expectedRevision: zone.revision,
    },
  );
export const refreshEvidenceZone = (zone: EvidenceZone) =>
  productRequest<EvidenceMaintenance>(
    `/frontier/zones/${id(zone.id)}/automation`,
    "POST",
    {},
  );

/** Native evidence failures explain the action while keeping unsaved input intact. */
export function evidenceErrorMessage(error: unknown): string {
  return webErrorMessage(error, {
    codes: {
      evidence_invalid:
        "请检查必填项、图表数值和来源编号；每个来源需填写标题，并提供有效的网页链接或原文引句。",
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
      evidence_automation_disabled: "请先启用并保存更新计划，再立即更新。",
    },
  });
}
