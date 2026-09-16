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
