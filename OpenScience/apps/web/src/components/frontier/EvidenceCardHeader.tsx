import { EVIDENCE_ORIGINALITY_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH, SOURCE_CURRENCY_LABELS_ZH } from "@evimed/domain";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/cn";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { evidenceDay } from "./evidenceDate";

/** The 引文已核对 tag's numbers: how many of the card's claims have their quotation found in their source, of how many carry one. */
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

/** 时效: the five labels of plan §4.4, as the server computed one; null where it sent none (a label is never guessed). */
export function evidenceCurrencyLabel(evidence: Pick<EvidenceCard, "currency">): string | null {
  return evidence.currency ? (SOURCE_CURRENCY_LABELS_ZH as Record<string, string>)[evidence.currency] ?? null : null;
}

/**
 * The top of a card, in one line (R19, audit D C3): who made it, the day it was last updated, and the one number a reader weighs it
 * by — ✓ n/m, the conclusions whose quotation was found in their source — which is a button: it goes to the conclusions it counts.
 * What a card's reader needs to know is wrong is on this line and nowhere less visible: a draft; a 时效 that is not current, in
 * warning colour; and a producer's interest in the products the card concerns, said in words. Everything else about who wrote and
 * checked it — 性质, a current 时效, a producer with no interest, the AI's steps — is the rows of the fold under the answer
 * (「编写与核查」). Nothing here stops a reader or a writer, and a label the card does not carry is not drawn.
 */
export function EvidenceCardHeader({ evidence, updatedAt, onOpenClaims }: { evidence: EvidenceCard; updatedAt?: string | null; onOpenClaims?: () => void }) {
  const producer = evidence.producer;
  const interest = producer && producer.relation !== "none" ? (EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[producer.relation] ?? null : null;
  const currency = evidenceCurrencyLabel(evidence);
  const tally = evidenceVerificationTally(evidence);
  const draft = evidence.state === "draft";
  if (!producer && !tally && !draft && !updatedAt && !(currency && evidence.currency !== "current")) return null;
  const complete = tally ? tally.verified === tally.checkable : true;
  const look = cn("inline-flex items-center gap-1 text-caption tabular-nums", complete ? "text-text-2" : "text-verify-pending");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="evidence-card-header">
      {producer && (
        <p className="text-ui text-text">
          {producer.name}
          {interest && <span className="text-text-2">{` · ${interest}`}</span>}
        </p>
      )}
      {updatedAt && <span className="text-caption text-text-3">{`更新于 ${evidenceDay(updatedAt)}`}</span>}
      {draft && <Tag>草稿</Tag>}
      {currency && evidence.currency !== "current" && <Tag tone="warn">{currency}</Tag>}
      {tally && (onOpenClaims ? (
        <button type="button" onClick={onOpenClaims} aria-label={`引文已核对 ${tally.verified}/${tally.checkable}，查看证据要点`} className={cn(look, "rounded hover:text-text hover:underline")}>
          <span aria-hidden="true">✓</span>{tally.verified}/{tally.checkable}
        </button>
      ) : (
        <span aria-label={`引文已核对 ${tally.verified}/${tally.checkable}`} className={look}><span aria-hidden="true">✓</span>{tally.verified}/{tally.checkable}</span>
      ))}
    </div>
  );
}
