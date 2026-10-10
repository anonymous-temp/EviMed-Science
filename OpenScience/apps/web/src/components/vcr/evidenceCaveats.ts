import type { VcrClinicalTimelineEntry, VcrCriterionJudgement } from "@/lib/vcrClient";

/** How a recorded fact was stated, in the words the clinical timeline and a rule's row both use. */
export const ASSERTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  affirmed: "已记录", negated: "已否认", possible: "疑似", hypothetical: "假设", conditional: "有条件", unknown: "未知", family: "家族史",
});

/** What a rule's evidence has been through, as one tag on the rule's row. */
export interface EvidenceCaveat {
  key: string;
  label: string;
  /** A correction or a contradiction the coordinator has to settle; the rest say how the sentence is to be read. */
  needsChecking: boolean;
}

type Evidence = NonNullable<VcrCriterionJudgement["evidence"]>;

/** The same span of the same document: the evidence of a judgment and the fact it was read from cite one place. */
function sameSpan(a: Evidence["locator"], b: VcrClinicalTimelineEntry["locator"]): boolean {
  return Boolean(a?.documentId && b && a.documentId === b.documentId && typeof a.start === "number" && a.start === b.start && typeof a.end === "number" && a.end === b.end);
}

/**
 * The caveats on a rule's evidence, read from the facts of the person the rule was judged for (the page's timeline).
 *
 * A fact stands behind a rule when it cites the very span the rule's evidence cites — or, where a locator is missing, says the very
 * sentence. A cell of the data table has neither, so it carries nothing: a table value is neither denied nor corrected in text.
 * The tag changes nothing about the rule's state; it says what the evidence went through (denied, hypothetical, since corrected, a
 * correction, contradicted by another record), which the folded timeline used to be the only place to learn.
 */
export function evidenceCaveats(evidence: VcrCriterionJudgement["evidence"], timeline: readonly VcrClinicalTimelineEntry[] | undefined): EvidenceCaveat[] {
  if (!evidence || !timeline?.length) return [];
  const behind = timeline.filter((fact) => sameSpan(evidence.locator, fact.locator) || (!evidence.locator?.documentId && Boolean(fact.quote) && fact.quote === evidence.quote));
  const found: EvidenceCaveat[] = [];
  const add = (caveat: EvidenceCaveat) => { if (!found.some((each) => each.key === caveat.key)) found.push(caveat); };
  for (const fact of behind) {
    if (fact.assertion !== "affirmed" && fact.assertion !== "unknown" && ASSERTION_WORDS[fact.assertion]) {
      add({ key: `assertion:${fact.assertion}`, label: ASSERTION_WORDS[fact.assertion]!, needsChecking: false });
    }
    if (fact.correctionOf) add({ key: "correction", label: "更正记录", needsChecking: true });
    if (fact.superseded) add({ key: "superseded", label: "已有更正", needsChecking: true });
    if (fact.conflictFactIds?.length) add({ key: "conflict", label: "记录有冲突", needsChecking: true });
  }
  return found;
}
