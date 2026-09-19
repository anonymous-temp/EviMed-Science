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

import { evidenceSourceTypeOf } from "@evimed/domain";

/** One of the domain's evidence source types (contract C8): `guideline`, `rct`, … `other`. */
export type EvidenceSourceType = ReturnType<typeof evidenceSourceTypeOf>;

export interface ClaimSource {
  sourceTitle?: string;
  sourceUrl?: string;
  identifier?: string;
  accessLevel?: string;
  supportQuote?: string;
  /** The preserved copy of the source in the workspace (`.evimed-sources/…`), when the run kept one. */
  artifactPath?: string;
  /** What kind of evidence the source is, decided once by the domain (C8). */
  sourceType: EvidenceSourceType;
  /** The source's risk of bias by a named tool, as the run recorded it (read by `claimAppraisalDisplay`). */
  riskOfBias?: unknown;
}

export interface ClaimEvidence extends ClaimSource {
  claimId: string;
  claim: string;
  claimType: "direct" | "synthesized" | "derived" | string;
  referenceNumber?: number;
  uncertainty?: string;
  confidence?: string;
  supportingSources?: ClaimSource[];
  derivedFrom?: string[];
  method?: string;
  /** The claim's PICO and GRADE certainty in parts, as the run recorded them (read by `claimAppraisalDisplay`). */
  pico?: unknown;
  certainty?: unknown;
}

/**
 * Package-level facts a matrix root may declare. None of them is required by
 * the contract today; a reader shows 「未注明」 for each one a package leaves
 * out rather than guessing it from the prose.
 */
export interface ClaimMatrixMeta {
  searchCutoff?: string;
  sourceScope?: string;
  limitations?: string[];
}

export interface ClaimMatrixDocument {
  claims: Map<string, ClaimEvidence>;
  meta: ClaimMatrixMeta;
}

/**
 * What the control plane found when it looked each claim's quotation up in the
 * preserved source the claim names (`claim_verification`, 2026-09-17). The gate
 * used to withhold a whole package over these; they are shown per claim now.
 */
export type ClaimStatus = "verified" | "quote_not_found" | "source_unavailable" | "no_quote" | "derived";

/**
 * A retraction or correction notice on a cited work, from Crossref (plan
 * §3.9): `kind` is one of the domain's SOURCE_UPDATE_KINDS.
 */
export interface SourceUpdate {
  kind: string;
  noticeDoi: string | null;
  date: string | null;
  source: string | null;
}

export interface ClaimVerification {
  claims: {
    claimId: string;
    claimType: string;
    status: ClaimStatus | string;
    /**
     * `sourceType` is what the preserving tool stamped beside the capture (C8),
     * added by the control plane; `doi` and `updates` are the work's Crossref
     * notices, present only when Crossref was asked and answered.
     */
    sources: { artifactPath: string | null; status: string; sourceType?: string; doi?: string; updates?: SourceUpdate[] }[];
  }[];
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

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
}

/** The matrix that belongs to a report, or null when the file is not one. */
export function claimMatrixPathFor(reportPath: string): string | null {
  if (fileName(reportPath) !== REPORT_NAME) return null;
  return `${directoryOf(reportPath)}${MATRIX_NAME}`;
}

/** Whether a path is a clinical evidence matrix, which reads as a table, not as JSON. */
export function isClaimMatrixPath(path: string): boolean {
  return fileName(path) === MATRIX_NAME;
}

/** The report a matrix belongs to. */
export function reportPathForMatrix(matrixPath: string): string {
  return `${directoryOf(matrixPath)}${REPORT_NAME}`;
}

/** A workspace path a link may open: relative, no `..`, no backslash. */
export function safeWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024) return undefined;
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  return value;
}

/** The claims a matrix holds, by id. A matrix that does not parse holds none. */
export function parseClaimMatrix(text: string): Map<string, ClaimEvidence> {
  return parseClaimMatrixDocument(text).claims;
}

/** The claims a matrix holds, and the package-level facts its root declares. */
export function parseClaimMatrixDocument(text: string): ClaimMatrixDocument {
  const claims = new Map<string, ClaimEvidence>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { claims, meta: {} };
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const value = (entry: unknown) => (typeof entry === "string" && entry.trim() ? entry.trim() : undefined);
  const limitations = Array.isArray(root.limitations)
    ? root.limitations.map(value).filter((entry): entry is string => Boolean(entry))
    : value(root.limitations) ? [value(root.limitations)!] : undefined;
  const meta: ClaimMatrixMeta = {
    ...(value(root.searchCutoff) ?? value(root.searchDate) ? { searchCutoff: value(root.searchCutoff) ?? value(root.searchDate) } : {}),
    ...(value(root.sourceScope) ? { sourceScope: value(root.sourceScope) } : {}),
    ...(limitations?.length ? { limitations } : {}),
  };
  const list = root.claims;
  if (!Array.isArray(list)) return { claims, meta };
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const claim = item as Record<string, unknown>;
    if (typeof claim.claimId !== "string" || typeof claim.claim !== "string") continue;
    const text = (entry: unknown) => (typeof entry === "string" && entry.trim() ? entry : undefined);
    const source = (record: Record<string, unknown>): ClaimSource => ({
      sourceTitle: text(record.sourceTitle),
      sourceUrl: text(record.sourceUrl),
      identifier: text(record.identifier),
      accessLevel: text(record.accessLevel),
      supportQuote: text(record.supportQuote),
      artifactPath: safeWorkspacePath(record.artifactPath),
      sourceType: evidenceSourceTypeOf(record),
      ...(record.riskOfBias !== undefined && record.riskOfBias !== null ? { riskOfBias: record.riskOfBias } : {}),
    });
    const referenceNumber = Number(claim.referenceNumber);
    claims.set(claim.claimId, {
      claimId: claim.claimId,
      claim: claim.claim,
      claimType: text(claim.claimType) ?? "direct",
      ...source(claim),
      ...(Number.isSafeInteger(referenceNumber) && referenceNumber > 0 ? { referenceNumber } : {}),
      uncertainty: text(claim.uncertainty),
      confidence: text(claim.confidence),
      supportingSources: Array.isArray(claim.supportingSources)
        ? claim.supportingSources.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object").map(source)
        : undefined,
      derivedFrom: Array.isArray(claim.derivedFrom) ? claim.derivedFrom.filter((id): id is string => typeof id === "string") : undefined,
      method: text(claim.method),
      // Kept as written: what they mean is the domain's to read, once, in
      // `claimAppraisalDisplay`, not this parser's.
      ...(claim.pico !== undefined && claim.pico !== null ? { pico: claim.pico } : {}),
      ...(claim.certainty !== undefined && claim.certainty !== null ? { certainty: claim.certainty } : {}),
    });
  }
  return { claims, meta };
}

/** The sources a claim stands on, in the order the verification reports them. */
export function claimSources(claim: ClaimEvidence): ClaimSource[] {
  if (claim.claimType === "derived") return [];
  if (claim.claimType === "synthesized") return claim.supportingSources ?? [];
  return [claim];
}

/**
 * What a reader should do about a claim whose quotation did not check out,
 * naming which quotation (「第 2 段引文」) when the claim rests on several.
 * Null when every quotation checked out, or nothing was checked.
 */
export function claimGuidance(
  claim: ClaimEvidence | undefined,
  verified: ClaimVerification["claims"][number] | undefined,
): string | null {
  if (!verified || verified.status === "verified" || verified.status === "derived") return null;
  const count = verified.sources.length;
  const which = (index: number) => (count > 1 ? `第 ${index + 1} 段引文` : "这段引文");
  const lines = verified.sources
    .map((source, index) => {
      if (source.status === "quote_not_found") return `${which(index)}没有在保存的原文中找到：请打开原文核对措辞与数字。`;
      if (source.status === "source_unavailable") return `${which(index)}的原文没有保存，无法自动核对：请到原始来源核实。`;
      if (source.status === "no_quote") return `${which(index)}缺少可核对的原文摘录：引用这条结论前请自行查证。`;
      return null;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length > 0) return lines.join("");
  return claim && claimSources(claim).length === 0 ? "这条主张没有给出可核对的引文：引用前请自行查证。" : null;
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
