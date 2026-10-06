import {
  EVIDENCE_CHALLENGE_OUTCOME_LABELS_ZH,
  EVIDENCE_CHALLENGE_REASON_LIMITS,
  EVIDENCE_CHANGE_CATEGORY_LABELS_ZH,
  EVIDENCE_CHANGE_TRIGGER_LABELS_ZH,
} from "@evimed/domain";
import { webErrorMessage } from "./apiClient";
import { productRequest } from "./productClient";

/** Where a reader's challenge to one claim stands: judged by the platform, told to the producer, or closed by the producer's own edit. */
export type EvidenceChallengeState = "open" | "notified" | "resolved" | "closed";
export type EvidenceChallengeOutcome = "uphold" | "amend" | "withdraw";
export interface EvidenceChallengeView {
  id: string;
  cardId: string;
  claimId: string;
  state: EvidenceChallengeState;
  /** `platform_recheck`: the platform's own card, judged by it. `producer_notice`: someone's card, which the platform does not change. */
  route: "platform_recheck" | "producer_notice";
  outcome: EvidenceChallengeOutcome | null;
  outcomeLabel: string | null;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  /** The platform's day for judging challenges is spent: the challenge is received and queued (`EVIDENCE_CHALLENGE_WAITING_LABEL_ZH`). */
  waiting?: boolean;
  /** The sentence the re-check gave for its outcome. */
  explanation: string | null;
  changeLogId: string | null;
}
/** One entry of a zone's public change log: made by the server from structured facts, never by a model. */
export interface EvidenceChangeEntry {
  id: string;
  zoneId: string;
  cardId: string;
  cardTitle: string | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  category: keyof typeof EVIDENCE_CHANGE_CATEGORY_LABELS_ZH;
  categoryLabel: string;
  trigger: keyof typeof EVIDENCE_CHANGE_TRIGGER_LABELS_ZH;
  triggerLabel: string;
  summary: string;
  occurredAt: string;
}
export interface EvidenceChangePage { items: EvidenceChangeEntry[]; nextBefore: string | null }

export const EVIDENCE_REASON_LIMITS = EVIDENCE_CHALLENGE_REASON_LIMITS;
export const EVIDENCE_OUTCOME_LABELS = EVIDENCE_CHALLENGE_OUTCOME_LABELS_ZH;
export const EVIDENCE_CATEGORY_LABELS = EVIDENCE_CHANGE_CATEGORY_LABELS_ZH;
export const EVIDENCE_TRIGGER_LABELS = EVIDENCE_CHANGE_TRIGGER_LABELS_ZH;

const id = (value: string) => encodeURIComponent(value);

/** Challenge one claim of a published card, and say why. */
export async function submitEvidenceChallenge(cardId: string, claimId: string, reason: string) {
  return (await productRequest<{ challenge: EvidenceChallengeView }>(
    `/frontier/evidence/${id(cardId)}/challenges`, "POST", { claimId, reason: reason.trim() },
  )).challenge;
}
/** The signed-in reader's own challenges on a card. */
export async function listMyEvidenceChallenges(cardId: string) {
  return (await productRequest<{ items: EvidenceChallengeView[] }>(`/frontier/evidence/${id(cardId)}/challenges`)).items;
}
/** A zone's change log, newest first; `before` is the `nextBefore` of the page before. */
export function fetchEvidenceChanges(zoneId: string, { cardId, before, limit }: { cardId?: string; before?: string | null; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (cardId) params.set("cardId", cardId);
  if (before) params.set("before", before);
  if (limit) params.set("limit", String(limit));
  return productRequest<EvidenceChangePage>(`/frontier/zones/${id(zoneId)}/changes${params.size ? `?${params}` : ""}`);
}
/** A producer's word about their own card: no longer updated, updated again, or "I have read the new studies". */
export function setEvidenceUpkeep(cardId: string, action: "retire" | "reopen" | "reviewed") {
  return productRequest<{ currency: string }>(`/frontier/evidence/${id(cardId)}/upkeep`, "POST", { action });
}

/** What the challenge and change-log actions say when they are refused; the registry's own sentences cover every code the server names. */
export function evidenceUpkeepErrorMessage(error: unknown): string {
  return webErrorMessage(error, { fallback: "操作没有完成，请稍后重试。" });
}

/** What this deployment offers around an evidence zone (flywheel F08, F14): a public page to link to, and a card's history and challenges. */
export interface EvidenceFeatures {
  publicPages: boolean;
  /**
   * Where the public pages are served, when the server says: `/evidence`, or `/evimed-evidence` on a deployment whose own `/evidence/`
   * belongs to another product. Absent, a link uses `DEFAULT_PUBLIC_BASE_PATH`.
   */
  publicBasePath?: string;
  upkeep: boolean;
}
/** The public pages' base paths a server may report; the closed set is `EVIDENCE_PUBLIC_BASE_PATHS` in `@evimed/domain` (a test holds the two equal). */
export const EVIDENCE_PUBLIC_BASE_PATHS = ["/evidence", "/evimed-evidence"] as const;
export const DEFAULT_PUBLIC_BASE_PATH = EVIDENCE_PUBLIC_BASE_PATHS[0];
const NO_FEATURES: EvidenceFeatures = { publicPages: false, upkeep: false };
let featuresRead: { at: number; value: Promise<EvidenceFeatures> } | null = null;
/**
 * Read from `/frontier/status` `capabilities`, which names a feature only when the route behind it exists, so a link or a button is never
 * shown for a page that would answer 404. A server that does not say, or does not answer, offers none of them. One read serves every
 * evidence page opened within the minute.
 */
export function fetchEvidenceFeatures(): Promise<EvidenceFeatures> {
  const now = Date.now();
  if (featuresRead && now - featuresRead.at < 60_000) return featuresRead.value;
  const value = productRequest<{ capabilities?: Record<string, unknown> } | null>("/frontier/status")
    .then((status): EvidenceFeatures => {
      // A base the server names outside the closed set is not a link target: it is left out and the default stands.
      const base = EVIDENCE_PUBLIC_BASE_PATHS.find((path) => path === status?.capabilities?.evidencePublicBasePath);
      return {
        publicPages: status?.capabilities?.evidencePublicPages === true,
        ...(base ? { publicBasePath: base } : {}),
        upkeep: status?.capabilities?.evidenceUpkeep === true,
      };
    })
    .catch(() => NO_FEATURES);
  featuresRead = { at: now, value };
  return value;
}
/** For tests: forget what was read. */
export function resetEvidenceFeatures() {
  featuresRead = null;
}
