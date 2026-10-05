import { EVIDENCE_ORIGINALITY_LABELS_ZH, EVIDENCE_PRODUCER_KIND_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH, SOURCE_CURRENCY_LABELS_ZH } from "@evimed/domain";
import { Tag } from "@/components/ui/Tag";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";

/** The 核验 tag's numbers: how many of the card's claims have their quotation found in their source, of how many carry one. */
export function evidenceVerificationTally(evidence: Pick<EvidenceCard, "claimVerification">): { verified: number; checkable: number } | null {
  const counts = evidence.claimVerification;
  if (!counts) return null;
  const checkable = counts.total - counts.derived;
  return checkable > 0 ? { verified: counts.verified, checkable } : null;
}

/**
 * The top of a card: who made it and how that producer relates to the products it concerns, and the labels a reader weighs
 * it by (plan §4.4) as small plain tags — 性质 (first-hand or interpretation), 时效 when the server has one, 核验 n/m. They are
 * labels: nothing here stops a reader or a writer, and a label the card does not carry is not drawn.
 */
export function EvidenceCardHeader({ evidence }: { evidence: EvidenceCard }) {
  const producer = evidence.producer;
  const originality = evidence.originality ? (EVIDENCE_ORIGINALITY_LABELS_ZH as Record<string, string>)[evidence.originality] : null;
  const currency = evidence.currency ? (SOURCE_CURRENCY_LABELS_ZH as Record<string, string>)[evidence.currency] : null;
  const tally = evidenceVerificationTally(evidence);
  if (!producer && !originality && !currency && !tally) return null;
  return (
    <div className="space-y-2" data-testid="evidence-card-header">
      {producer && (
        <p className="text-ui text-text">
          <span className="text-text-3">出品方 </span>
          {producer.name}
          <span className="text-text-3">
            {` · ${(EVIDENCE_PRODUCER_KIND_LABELS_ZH as Record<string, string>)[producer.kind] ?? producer.kind} · ${(EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[producer.relation] ?? ""}`}
          </span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {originality && <Tag>{`性质 ${evidence.primary ? "一手" : "解读"} · ${originality}`}</Tag>}
        {currency && <Tag tone={evidence.currency === "current" ? "neutral" : "warn"}>{`时效 ${currency}`}</Tag>}
        {tally && <Tag>{`核验 ${tally.verified}/${tally.checkable}`}</Tag>}
      </div>
    </div>
  );
}
