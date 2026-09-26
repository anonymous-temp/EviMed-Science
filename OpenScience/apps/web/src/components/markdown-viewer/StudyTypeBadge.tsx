import { EVIDENCE_SOURCE_TYPE_LABELS_ZH, studyBadgeKind } from "@evimed/domain";
import { tagClasses } from "@/components/ui/Tag";

/**
 * The study-type badge (融合方案 §5.8, 来源级): a soft ground with its own deep
 * text, one pair per family, so a reader tells a guideline from an RCT before
 * reading a word.
 *
 * The five pairs are `STUDY_TYPE_BADGES` in `@evimed/design-tokens`, emitted
 * as `--study-<kind>-fg/bg`; which of the five a source type wears is
 * `studyBadgeKind` in `@evimed/domain`, beside the twelve types themselves.
 * The variables are read through an inline style because the palette
 * generates no Tailwind utility for them — a class would have to be an
 * arbitrary value, which the design lint refuses, and hard-coding the hex
 * would be a second copy of a token.
 *
 * `other` is the table saying it cannot tell what the record is, and nothing
 * is drawn: a grey badge reading 「其他」 says less than the title beside it.
 */
export function StudyTypeBadge({ sourceType, className }: { sourceType: string | undefined; className?: string }) {
  const label = sourceType ? EVIDENCE_SOURCE_TYPE_LABELS_ZH[sourceType as keyof typeof EVIDENCE_SOURCE_TYPE_LABELS_ZH] : undefined;
  if (!sourceType || !label || sourceType === "other") return null;
  const kind = studyBadgeKind(sourceType);
  return (
    <span
      data-study-type={sourceType}
      className={tagClasses({ className })}
      style={{ color: `var(--study-${kind}-fg)`, backgroundColor: `var(--study-${kind}-bg)` }}
    >
      {label}
    </span>
  );
}
