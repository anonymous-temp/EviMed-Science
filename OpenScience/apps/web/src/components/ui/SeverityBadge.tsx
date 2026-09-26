import { cn } from "@/lib/cn";

/**
 * How badly a wrong sentence about a medicine would land, as the one red on a
 * data page (DESIGN.md: red is for danger and unhandled work, nothing else).
 *
 * Five grades, after the medication-error scale: S4 and S3 are the deep red,
 * S2 the lighter one, S1 and S0 grey — a defect that changes nothing is not
 * an alarm. The grade is said three ways: the colour, the letter, and the
 * consequence in words, which is the badge's tooltip and its accessible name.
 */

export type SeverityLevel = "S0" | "S1" | "S2" | "S3" | "S4";

/** The consequence, which is what a reader needs; the grade only follows it. */
export const SEVERITY_WORDS: Readonly<Record<SeverityLevel, string>> = Object.freeze({
  S0: "几乎无影响",
  S1: "影响轻微",
  S2: "需监测或干预",
  S3: "可致暂时伤害",
  S4: "可致永久伤害或危及生命",
});

/** The ground and the text that reads on it; both pairs are above 4.5:1. */
const TONES: Record<SeverityLevel, string> = {
  S4: "bg-severity-s3 text-accent-fg",
  S3: "bg-severity-s3 text-accent-fg",
  S2: "bg-severity-s2 text-text",
  S1: "bg-severity-s1 text-text",
  S0: "bg-severity-s1 text-text",
};

export function isSeverityLevel(value: string | null | undefined): value is SeverityLevel {
  return value === "S0" || value === "S1" || value === "S2" || value === "S3" || value === "S4";
}

export function SeverityBadge({
  level,
  label,
  className,
}: {
  level: SeverityLevel;
  /** The consequence printed beside the grade, where there is room for it. */
  label?: boolean;
  className?: string;
}) {
  const word = SEVERITY_WORDS[level];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
      <span
        data-severity={level}
        title={word}
        className={cn("inline-flex h-5 items-center rounded-tag px-1.5 text-meta font-semibold", TONES[level])}
      >
        {level}
        <span className="sr-only">{`，${word}`}</span>
      </span>
      {label && <span className="text-caption text-text-2">{word}</span>}
    </span>
  );
}
