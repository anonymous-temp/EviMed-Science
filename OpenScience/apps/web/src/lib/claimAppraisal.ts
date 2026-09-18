/**
 * A claim's structured appraisal as a reader sees it (plan §9.8, P2-22): the
 * PICO it measured, its GRADE certainty as a badge — 高 / 中 / 低 / 极低 — and
 * its risk of bias by a named tool.
 *
 * Nothing is recomputed here. `claimAppraisal` in `@evimed/domain` is the same
 * analysis the delivery gate checks the run with, so the note a reader sees
 * and the notice the run was given cannot disagree. This file only turns its
 * answer into Chinese.
 *
 * The badge shows the level the author stated when there is one — it is the
 * level the report's prose states, and a popover contradicting the sentence
 * above it would be read as the page disagreeing with itself — and a quiet
 * note says when the parts give a different level. With no stated level, the
 * badge is the level the parts give, and says so.
 */

import { CERTAINTY_LEVEL_LABELS_ZH, RISK_OF_BIAS_LEVEL_LABELS_ZH, claimAppraisal } from "@evimed/domain";
import type { ClaimEvidence, ClaimVerification } from "@/lib/claimCitations";

export interface PicoEntry {
  /** 人群 / 干预（或暴露） / 对照 / 结局 / 时间 / 场景 */
  label: string;
  value: string;
}

export interface CertaintyBadge {
  /** The outcome it rates, when the claim names one. */
  outcome: string | null;
  /** 高 / 中 / 低 / 极低 */
  label: string;
  /** 「标注为“中”，按各分项计算为“低”」, 「按各分项计算」, or nothing. */
  note: string | null;
  /** The stated level and the one its parts give disagree. */
  disagrees: boolean;
}

export interface RiskOfBiasEntry {
  /** The supporting source it belongs to, for a synthesized claim; null for the claim's own. */
  source: number | null;
  /** 「偏倚风险 · RoB 2」, 「结果可信度 · AMSTAR 2」 */
  heading: string;
  /** The judgement, in the reader's words where the tool's scale is known. */
  label: string;
  note: string | null;
  disagrees: boolean;
}

export interface ClaimAppraisalDisplay {
  pico: PicoEntry[];
  certainty: CertaintyBadge[];
  riskOfBias: RiskOfBiasEntry[];
}

type VerifiedClaim = ClaimVerification["claims"][number];

function certaintyLabel(level: string | null): string {
  return level ? CERTAINTY_LEVEL_LABELS_ZH[level as keyof typeof CERTAINTY_LEVEL_LABELS_ZH] ?? level : "";
}

function robLabel(level: string | null): string {
  return level ? RISK_OF_BIAS_LEVEL_LABELS_ZH[level] ?? level : "";
}

/**
 * The claim's appraisal in the reader's words, or null when it carries none.
 * `verified` is what the control plane found for the claim; its sources carry
 * the evidence type stamped beside each preserved capture, which decides
 * whether a GRADE upgrade counts — the same input the gate reads.
 */
export function claimAppraisalDisplay(claim: ClaimEvidence, verified?: VerifiedClaim | null): ClaimAppraisalDisplay | null {
  if (claim.pico === undefined && claim.certainty === undefined && claim.riskOfBias === undefined
    && !(claim.supportingSources ?? []).some((source) => source.riskOfBias !== undefined)) return null;

  const sourceTypes: Record<string, string> = {};
  for (const source of verified?.sources ?? []) {
    if (source.artifactPath && source.sourceType) sourceTypes[source.artifactPath] = source.sourceType;
  }
  const view = claimAppraisal({
    claimType: claim.claimType,
    artifactPath: claim.artifactPath,
    supportingSources: claim.supportingSources?.map((source) => ({ artifactPath: source.artifactPath, riskOfBias: source.riskOfBias })),
    pico: claim.pico,
    certainty: claim.certainty,
    riskOfBias: claim.riskOfBias,
  }, { sourceTypes });
  if (!view) return null;

  const pico: PicoEntry[] = [];
  if (view.pico) {
    const parts: [string, string | null][] = [
      ["人群", view.pico.population],
      [view.pico.exposure ? "暴露" : "干预", view.pico.intervention],
      ["对照", view.pico.comparator],
      ["结局", view.pico.outcomes.length ? view.pico.outcomes.join("、") : null],
      ["时间", view.pico.timeframe],
      ["场景", view.pico.setting],
    ];
    for (const [label, value] of parts) if (value) pico.push({ label, value });
  }

  const certainty: CertaintyBadge[] = [];
  for (const entry of view.certainty ?? []) {
    const shown = entry.stated ?? entry.computed;
    if (!shown) continue;
    const disagrees = entry.agrees === false;
    certainty.push({
      outcome: entry.outcome,
      label: certaintyLabel(shown),
      note: disagrees
        ? `标注为“${certaintyLabel(entry.stated)}”，按各分项计算为“${certaintyLabel(entry.computed)}”`
        : entry.stated ? null : "按各分项计算",
      disagrees,
    });
  }

  const riskOfBias: RiskOfBiasEntry[] = [];
  for (const entry of view.riskOfBias ?? []) {
    const shown = entry.stated ?? entry.computed;
    if (!shown) continue;
    const disagrees = entry.agrees === false;
    const expected = entry.computed ? robLabel(entry.computed) : entry.allowed.map(robLabel).join("或");
    riskOfBias.push({
      source: entry.source,
      heading: `${entry.tool === "amstar2" ? "结果可信度" : "偏倚风险"} · ${entry.toolName}`,
      label: robLabel(shown),
      note: disagrees
        ? `标注为“${robLabel(entry.stated)}”，按各领域判断应为“${expected}”`
        : entry.stated ? null : "按各领域判断",
      disagrees,
    });
  }

  if (!pico.length && !certainty.length && !riskOfBias.length) return null;
  return { pico, certainty, riskOfBias };
}
