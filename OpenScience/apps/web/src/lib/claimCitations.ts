/**
 * Sentence-level citations for a clinical evidence report (2026-09-16 review,
 * P2 #14 — "逐句引用，悬停出原文").
 *
 * A report ends each finding with its reference number and the claims behind
 * it as HTML comments — `…50,920 名唯一患者 [1]<!-- claim:CLM-001 --><!-- claim:CLM-005 -->。`
 * — and the claims themselves, with the verbatim quote each rests on, sit in
 * `clinical-evidence-matrix.json` beside the report. Markdown hides the
 * comments, so a reader saw `[1]` and had to open the matrix to learn what the
 * sentence stood on. This turns each run of markers into one citation the
 * viewer can open in place.
 */

export interface ClaimSource {
  sourceTitle?: string;
  sourceUrl?: string;
  identifier?: string;
  accessLevel?: string;
  supportQuote?: string;
}

export interface ClaimEvidence extends ClaimSource {
  claimId: string;
  claim: string;
  claimType: "direct" | "synthesized" | "derived" | string;
  uncertainty?: string;
  confidence?: string;
  supportingSources?: ClaimSource[];
  derivedFrom?: string[];
  method?: string;
}

/**
 * What the control plane found when it looked each claim's quotation up in the
 * preserved source the claim names (`claim_verification`, 2026-09-17). The gate
 * used to withhold a whole package over these; they are shown per claim now.
 */
export type ClaimStatus = "verified" | "quote_not_found" | "source_unavailable" | "no_quote" | "derived";

export interface ClaimVerification {
  claims: { claimId: string; claimType: string; status: ClaimStatus | string; sources: { artifactPath: string | null; status: string }[] }[];
  counts: Record<string, number>;
}

/** What each status tells a reader. A status this table does not know reads as
 *  unchecked rather than as verified. */
export const CLAIM_STATUS_TEXT: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  verified: { label: "引文已在保存的原文中核对", tone: "ok" },
  quote_not_found: { label: "引文未在保存的原文中找到，请对照来源核实", tone: "warn" },
  source_unavailable: { label: "来源原文没有保存，引文无法核对", tone: "warn" },
  no_quote: { label: "这条主张没有给出可核对的引文", tone: "warn" },
  derived: { label: "推导结果：由其他主张计算或推断，本身没有引文", tone: "muted" },
};

/** Status by claim id, for the citation popover. */
export function claimStatuses(verification: ClaimVerification | null | undefined): Map<string, string> {
  return new Map((verification?.claims ?? []).map((claim) => [claim.claimId, String(claim.status)]));
}

/** One sentence for the top of a report: how many of its claims were checked
 *  against a preserved source, and how many could not be. Null when there is
 *  nothing to say. */
export function claimVerificationSummary(verification: ClaimVerification | null | undefined): { text: string; attention: boolean } | null {
  const counts = verification?.counts ?? {};
  const total = verification?.claims.length ?? 0;
  if (total === 0) return null;
  const notFound = counts.quote_not_found ?? 0;
  const unavailable = (counts.source_unavailable ?? 0) + (counts.no_quote ?? 0);
  const parts = [`${counts.verified ?? 0} 条引文已在保存的原文中核对`];
  if (notFound > 0) parts.push(`${notFound} 条未在原文中找到`);
  if (unavailable > 0) parts.push(`${unavailable} 条无法核对`);
  if ((counts.derived ?? 0) > 0) parts.push(`${counts.derived} 条为推导结果`);
  return { text: `本报告 ${total} 条主张：${parts.join("，")}。点句末的「依据」看每一条。`, attention: notFound + unavailable > 0 };
}

/** The link target a citation is rendered from. Not a URL anyone navigates. */
export const CLAIM_LINK_PREFIX = "#evimed-claims=";

const REPORT_NAME = "clinical-evidence-report.md";
const MATRIX_NAME = "clinical-evidence-matrix.json";

/** The matrix that belongs to a report, or null when the file is not one. */
export function claimMatrixPathFor(reportPath: string): string | null {
  const slash = reportPath.lastIndexOf("/");
  const name = slash >= 0 ? reportPath.slice(slash + 1) : reportPath;
  if (name !== REPORT_NAME) return null;
  return `${slash >= 0 ? reportPath.slice(0, slash + 1) : ""}${MATRIX_NAME}`;
}

/** The claims a matrix holds, by id. A matrix that does not parse holds none. */
export function parseClaimMatrix(text: string): Map<string, ClaimEvidence> {
  const claims = new Map<string, ClaimEvidence>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return claims;
  }
  const list = (parsed as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) return claims;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const claim = item as Record<string, unknown>;
    if (typeof claim.claimId !== "string" || typeof claim.claim !== "string") continue;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
    const source = (value: Record<string, unknown>): ClaimSource => ({
      sourceTitle: text(value.sourceTitle),
      sourceUrl: text(value.sourceUrl),
      identifier: text(value.identifier),
      accessLevel: text(value.accessLevel),
      supportQuote: text(value.supportQuote),
    });
    claims.set(claim.claimId, {
      claimId: claim.claimId,
      claim: claim.claim,
      claimType: text(claim.claimType) ?? "direct",
      ...source(claim),
      uncertainty: text(claim.uncertainty),
      confidence: text(claim.confidence),
      supportingSources: Array.isArray(claim.supportingSources)
        ? claim.supportingSources.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object").map(source)
        : undefined,
      derivedFrom: Array.isArray(claim.derivedFrom) ? claim.derivedFrom.filter((id): id is string => typeof id === "string") : undefined,
      method: text(claim.method),
    });
  }
  return claims;
}

// A fenced block (closed, or open to the end) or an inline code span: a claim
// marker quoted as code is an example, not a citation.
const CODE = /((?:^|\n)(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:`{3,}|~{3,})[^\n]*(?=\n|$)|$)|`[^`\n]+`)/g;
// One or more adjacent `<!-- claim:CLM-001 -->` comments.
const MARKER_RUN = /(?:<!--\s*claim\s*:\s*(CLM-\d{3,6})\s*-->\s*)+/gi;
const MARKER = /<!--\s*claim\s*:\s*(CLM-\d{3,6})\s*-->/gi;

/**
 * The report with each run of claim markers made into one citation link. Runs
 * inside code are left as they are; so is everything else in the text.
 */
export function linkClaimMarkers(markdown: string): string {
  return markdown
    .split(CODE)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(MARKER_RUN, (run) => {
            const ids = [...new Set([...run.matchAll(MARKER)].map((match) => match[1].toUpperCase()))];
            const trailing = /\s+$/.exec(run)?.[0] ?? "";
            return `[依据](${CLAIM_LINK_PREFIX}${ids.join(",")})${trailing}`;
          }),
    )
    .join("");
}

/** The claim ids a citation link names, or null when the link is not one. */
export function claimIdsFromHref(href: string | undefined): string[] | null {
  if (!href?.startsWith(CLAIM_LINK_PREFIX)) return null;
  const ids = href.slice(CLAIM_LINK_PREFIX.length).split(",").filter((id) => /^CLM-\d{3,6}$/.test(id));
  return ids.length ? ids : null;
}
