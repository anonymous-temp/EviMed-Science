import type { ClaimAppraisalDisplay } from "@/lib/claimAppraisal";

/**
 * A claim's appraisal, compact enough for a popover and a table cell: its
 * PICO on one wrapping line (「人群 … 干预 … 对照 … 结局 …」), its GRADE
 * certainty as a badge, and its risk of bias by the tool that judged it.
 *
 * A badge is a word in a pill, never a colour alone (appendix D §10.7), and it
 * is neutral: low certainty is a property of the evidence, not a fault of the
 * report. Where the stated level and the one its parts give disagree, a quiet
 * note says both — the reader decides which to trust; nothing is hidden and
 * nothing is flagged as an error.
 *
 * `sourceCount` is how many sources the claim stands on, so a record that
 * belongs to one of several is named by its quotation (「第 2 段引文」), the
 * way the popover names quotations.
 */
export function ClaimAppraisalSummary({ display, sourceCount = 1 }: { display: ClaimAppraisalDisplay; sourceCount?: number }) {
  return (
    <div className="mt-1.5 space-y-1 text-caption">
      {display.pico.length > 0 && (
        <dl aria-label="PICO" className="flex flex-wrap gap-x-3 gap-y-0.5">
          {display.pico.map((entry) => (
            <div key={entry.label} className="flex gap-1">
              <dt className="shrink-0 text-muted">{entry.label}</dt>
              <dd className="text-text">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {display.certainty.map((badge, index) => (
        <p key={`certainty-${index}`} className="flex flex-wrap items-center gap-1.5">
          {badge.outcome && <span className="text-muted">{badge.outcome}</span>}
          <span
            aria-label={`证据确定性：${badge.label}`}
            className="rounded-full border border-border bg-surface-2 px-1.5 text-text"
          >
            确定性 {badge.label}
          </span>
          {badge.note && <span className="text-muted">{badge.note}</span>}
        </p>
      ))}
      {display.riskOfBias.map((entry, index) => (
        <p key={`rob-${index}`} className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">
            {entry.source !== null && sourceCount > 1 ? `第 ${entry.source + 1} 段引文 · ` : ""}{entry.heading}
          </span>
          <span className="text-text">{entry.label}</span>
          {entry.note && <span className="text-muted">{entry.note}</span>}
        </p>
      ))}
    </div>
  );
}
