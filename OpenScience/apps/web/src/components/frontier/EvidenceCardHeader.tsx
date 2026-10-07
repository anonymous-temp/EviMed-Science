import { EVIDENCE_ORIGINALITY_LABELS_ZH, EVIDENCE_PRODUCER_KIND_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH, SOURCE_CURRENCY_LABELS_ZH } from "@evimed/domain";
import { Tag } from "@/components/ui/Tag";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { evidenceDay } from "./evidenceDate";

/** The 核验 tag's numbers: how many of the card's claims have their quotation found in their source, of how many carry one. */
export function evidenceVerificationTally(evidence: Pick<EvidenceCard, "claimVerification">): { verified: number; checkable: number } | null {
  const counts = evidence.claimVerification;
  if (!counts) return null;
  const checkable = counts.total - counts.derived;
  return checkable > 0 ? { verified: counts.verified, checkable } : null;
}

/** 性质: first-hand work or interpretation, and what kind (「一手 · 原创研究」, 「解读 · 综合」); null for a card that states none. */
export function evidenceNatureLabel(evidence: Pick<EvidenceCard, "originality" | "primary">): string | null {
  const originality = evidence.originality ? (EVIDENCE_ORIGINALITY_LABELS_ZH as Record<string, string>)[evidence.originality] : null;
  return originality ? `${evidence.primary ? "一手" : "解读"} · ${originality}` : null;
}

/**
 * The top of a card, in one wrapping row: who made it and how that producer relates to the products it concerns, the labels a
 * reader weighs it by (plan §4.4) as small plain tags — 性质 (first-hand or interpretation), 时效 when the server has one, 核验
 * n/m — and the day it was last updated. They are labels: nothing here stops a reader or a writer, and a label the card does not
 * carry is not drawn. Everything else about who wrote and checked it is the folded 「编写与核查」 under the answer.
 */
export function EvidenceCardHeader({ evidence, updatedAt }: { evidence: EvidenceCard; updatedAt?: string | null }) {
  const producer = evidence.producer;
  const nature = evidenceNatureLabel(evidence);
  const currency = evidence.currency ? (SOURCE_CURRENCY_LABELS_ZH as Record<string, string>)[evidence.currency] : null;
  const tally = evidenceVerificationTally(evidence);
  const draft = evidence.state === "draft";
  if (!producer && !nature && !currency && !tally && !draft && !updatedAt) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="evidence-card-header">
      {producer && (
        <p className="text-ui text-text">
          <span className="text-text-3">出品方 </span>
          {producer.name}
          <span className="text-text-3">
            {` · ${(EVIDENCE_PRODUCER_KIND_LABELS_ZH as Record<string, string>)[producer.kind] ?? producer.kind} · ${(EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[producer.relation] ?? ""}`}
          </span>
        </p>
      )}
      {draft && <Tag>草稿</Tag>}
      {nature && <Tag>{`性质 ${nature}`}</Tag>}
      {currency && <Tag tone={evidence.currency === "current" ? "neutral" : "warn"}>{`时效 ${currency}`}</Tag>}
      {tally && <Tag>{`核验 ${tally.verified}/${tally.checkable}`}</Tag>}
      {updatedAt && <span className="text-caption text-text-3">{`更新于 ${evidenceDay(updatedAt)}`}</span>}
    </div>
  );
}
