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
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";

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
  /** The matrix's original path, retained for bond enumeration only. File opening uses `artifactPath`. */
  declaredArtifactPath?: string;
  resultVersionId?: string;
  resultDigest?: string;
  /** What kind of evidence the source is, decided once by the domain (C8). */
  sourceType: EvidenceSourceType;
  /** The source's risk of bias by a named tool, as the run recorded it (read by `claimAppraisalDisplay`). */
  riskOfBias?: unknown;
  /**
   * The work's bibliographic parts, when the package recorded them: what a
   * source card shows beside its title and what a copied reference is built
   * from (spec §23.2). None is required, and none is guessed when absent.
   */
  authors?: string[];
  journal?: string;
  year?: string;
  volume?: string;
  issue?: string;
  pages?: string;
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

export interface SourceUpdateStatus {
  state: "no_update" | "changed" | "unknown" | "unavailable";
  checkedAt: string | null; reason?: string; updates: SourceUpdate[];
}

/**
 * Where a verified quotation sits in its preserved source (`attachClaimSourceLocations`):
 * the table, row and cell it lies in, and the page when the text carries page
 * markers. Every part is optional because every part can be unknown, and a
 * location that is absent altogether means nobody asked (an older verification).
 */
export interface ClaimSourceLocation {
  status: "located" | "ambiguous" | "unknown";
  table?: { id: string; index: number; kind?: string; label?: string; name?: string };
  row?: number;
  cell?: { row: number; column: number; address?: string; header?: string };
  candidates?: { id: string; index: number; label?: string; name?: string }[];
  page?: { status: "located" | "ambiguous" | "unknown"; pages?: number[]; candidates?: number[]; basis?: string; reason?: string };
  reason?: string;
}

export interface ClaimVerification {
  claims: {
    claimId: string;
    claimType: string;
    status: ClaimStatus | string;
    /**
     * `sourceType` is what the preserving tool stamped beside the capture (C8),
     * added by the control plane; `doi` and `updates` are the work's Crossref
     * notices, present only when Crossref was asked and answered. `location` is
     * where the quotation sits in that source.
     */
    sources: { artifactPath: string | null; status: string; sourceType?: string; doi?: string; updates?: SourceUpdate[]; updateStatus?: SourceUpdateStatus; location?: ClaimSourceLocation }[];
  }[];
  counts: Record<string, number>;
}

/** What each status tells a reader. A status this table does not know reads as
 *  unchecked rather than as verified. */
export const CLAIM_STATUS_TEXT: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  verified: { label: "引文已在保存的原文中核对", tone: "ok" },
  quote_not_found: { label: "引文未在保存的原文中找到，请对照来源核实", tone: "warn" },
  source_unavailable: { label: "来源原文没有保存，引文无法核对", tone: "warn" },
  no_quote: { label: "这条结论没有给出可核对的引文", tone: "warn" },
  derived: { label: "推导结果：由其他结论计算或推断，本身没有引文", tone: "muted" },
};

/**
 * One line saying where a quotation sits in its source: 「Table 2 第 3 行第 2 列 · 第 7 页」,
 * the page as 「页码未知」 where only the table is known, and 「位置未知」 where
 * nothing is. Null when no location was computed at all — an older verification
 * says nothing rather than claiming an unknown it never looked for. Rows count
 * from the table's header row as row 1, the way a sheet's do.
 */
export function sourceLocationText(location: ClaimSourceLocation | null | undefined): string | null {
  if (!location) return null;
  const named = (table: { label?: string; name?: string; index: number }) => table.label ?? (table.name ? `工作表 ${table.name}` : `第 ${table.index} 张表`);
  const parts: string[] = [];
  if (location.table) {
    const place = location.cell ? `第 ${location.cell.row} 行第 ${location.cell.column} 列` : location.row ? `第 ${location.row} 行` : "";
    parts.push([named(location.table), place].filter(Boolean).join(" "));
  } else if (location.candidates?.length) {
    parts.push(`可能在 ${location.candidates.slice(0, 3).map(named).join("、")}`);
  }
  const page = location.page;
  if (page?.status === "located" && page.pages?.length) parts.push(`第 ${page.pages.join("、")} 页`);
  else if (page?.status === "ambiguous" && page.candidates?.length) parts.push(`页码待定（第 ${page.candidates.slice(0, 4).join("、")} 页之一）`);
  else if (parts.length) parts.push("页码未知");
  return parts.length ? parts.join(" · ") : "位置未知";
}

/** Status by claim id, for the citation popover. */
export function claimStatuses(verification: ClaimVerification | null | undefined): Map<string, string> {
  return new Map((verification?.claims ?? []).map((claim) => [claim.claimId, String(claim.status)]));
}

/** The one line a report opens with when some of its claims need checking —
 *  「⚠ 3 条待核对」 — and nothing when none do (2026-09-23 plan §4: a check
 *  shows where it found a problem, never a tally of what passed). The ✓ and ⚠
 *  beside each sentence carry the rest. */
export function claimVerificationSummary(verification: ClaimVerification | null | undefined): { text: string; attention: boolean } | null {
  const counts = verification?.counts ?? {};
  const pending = (counts.quote_not_found ?? 0) + (counts.source_unavailable ?? 0) + (counts.no_quote ?? 0);
  if (pending === 0) return null;
  return { text: `⚠ ${pending} 条待核对`, attention: true };
}

/**
 * Whether a report's claim checks have been read: still being read (`loading`),
 * read (`ready`), could not be read (`failed` — the read itself failed and can
 * be asked again), or there are none (`unavailable` — this report was never
 * checked). The matrix must tell them apart: a column that says something
 * while the checks are still on their way is a claim about the report that
 * nobody has made.
 */
export type ClaimCheckState = "loading" | "ready" | "unavailable" | "failed";

export type ClaimCheckKind = "verified" | "attention" | "derived" | "checking" | "unavailable" | "failed" | "unchecked";

/**
 * A claim's overall check as one short mark: a word and a symbol, never a
 * colour alone — or nothing at all. `text` is empty where there is no check
 * to report (a derived claim, a claim the read checks do not name, checks that
 * were never made or could not be read): a column that says 「未核对」 or
 * 「暂无核对结果」 in every row tells the reader less than a blank one, and the
 * reason is said once, where the whole read failed (v2.1 §29.2: a sentence
 * with no check record carries no mark).
 */
export interface ClaimCheckMark {
  kind: ClaimCheckKind;
  text: string;
  tone: "ok" | "warn" | "muted";
}

/**
 * The words of the marks. The ✓ and ⚠ are the ones the source cards and the
 * 依据 popover say (`SourceCards.STATUS_MARK`, held equal by a test), so a
 * quotation reads the same in the matrix, in the popover and on the card.
 */
const CHECK_MARKS: Record<string, ClaimCheckMark> = {
  verified: { kind: "verified", text: "✓ 引文已核对", tone: "ok" },
  quote_not_found: { kind: "attention", text: "⚠ 引文未在原文中找到", tone: "warn" },
  source_unavailable: { kind: "attention", text: "⚠ 原文未保存，无法核对", tone: "warn" },
  no_quote: { kind: "attention", text: "⚠ 没有可核对的引文", tone: "warn" },
  derived: { kind: "derived", text: "", tone: "muted" },
};

/** What one source's own check found, in the same words as a claim's; nothing where it has no check. */
export function sourceCheckMark(status: string | undefined): ClaimCheckMark {
  return (status ? CHECK_MARKS[status] : undefined) ?? { kind: "unchecked", text: "", tone: "muted" };
}

/**
 * The mark a claim wears in the matrix: ✓, ⚠ or nothing. A check the control
 * plane made always speaks for itself; without one the mark is blank — except
 * 「核对中」 while the checks are being read, which is the one thing a reader is
 * waiting on. A derived claim has no quotation to check, whatever the state.
 */
export function claimCheckMark(
  claim: Pick<ClaimEvidence, "claimType">,
  check: ClaimVerification["claims"][number] | undefined,
  state: ClaimCheckState = "ready",
): ClaimCheckMark {
  if (check) return sourceCheckMark(String(check.status));
  if (claim.claimType === "derived") return CHECK_MARKS.derived;
  if (state === "loading") return { kind: "checking", text: "核对中", tone: "muted" };
  if (state === "failed") return { kind: "failed", text: "", tone: "muted" };
  if (state === "unavailable") return { kind: "unavailable", text: "", tone: "muted" };
  return { kind: "unchecked", text: "", tone: "muted" };
}

/** Whether a claim is one to look at again: not found, not preserved, unquoted, or never checked. */
export function claimNeedsReview(mark: ClaimCheckMark): boolean {
  return mark.kind !== "verified" && mark.kind !== "derived";
}

export const CLAIM_TYPE_LABEL: Record<string, string> = { direct: "直接证据", synthesized: "综合结论", derived: "推导结果" };

export function claimTypeLabel(claimType: string): string {
  return CLAIM_TYPE_LABEL[claimType] ?? "结论";
}

/**
 * Everything a reader might type to find a claim, folded to lower case: its
 * id, its sentence, each source's title and identifier, each quotation. A plain
 * substring match over this is the matrix's search (112 claims need no index).
 */
export function claimMatrixSearchText(claim: ClaimEvidence): string {
  const parts = [claim.claimId, claim.claim];
  for (const source of claimSources(claim)) parts.push(source.sourceTitle ?? "", source.identifier ?? "", source.supportQuote ?? "");
  return parts.join("\n").toLowerCase();
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
    /** A bibliographic part: a string, or a number as a year or volume is often written. */
    const part = (entry: unknown) => (typeof entry === "number" && Number.isFinite(entry) ? String(entry) : text(entry)?.trim());
    const authorsOf = (entry: unknown) => {
      const list = (Array.isArray(entry) ? entry : [entry]).map(text).filter((name): name is string => Boolean(name)).map((name) => name.trim());
      return list.length ? { authors: list } : {};
    };
    const bibliographic = (record: Record<string, unknown>) => Object.fromEntries(
      (["journal", "year", "volume", "issue", "pages"] as const)
        .map((key) => [key, part(record[key])] as const)
        .filter(([, value]) => value !== undefined),
    ) as Pick<ClaimSource, "journal" | "year" | "volume" | "issue" | "pages">;
    const source = (record: Record<string, unknown>): ClaimSource => ({
      sourceTitle: text(record.sourceTitle),
      sourceUrl: text(record.sourceUrl),
      identifier: text(record.identifier),
      accessLevel: text(record.accessLevel),
      supportQuote: text(record.supportQuote),
      artifactPath: safeWorkspacePath(record.artifactPath),
      declaredArtifactPath: text(record.artifactPath),
      sourceType: evidenceSourceTypeOf(record),
      ...(record.riskOfBias !== undefined && record.riskOfBias !== null ? { riskOfBias: record.riskOfBias } : {}),
      ...authorsOf(record.authors),
      ...bibliographic(record),
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
  return claimEvidenceSources(claim);
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
  return claim && claimSources(claim).length === 0 ? "这条结论没有给出可核对的引文：引用前请自行查证。" : null;
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
