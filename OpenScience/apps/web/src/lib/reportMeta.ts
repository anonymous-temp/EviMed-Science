import { EVIDENCE_SOURCE_TYPES, EVIDENCE_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import type { WebAgentRun } from "@/lib/apiClient";
import { claimSources, type ClaimEvidence, type ClaimMatrixMeta, type ClaimVerification, type EvidenceSourceType } from "@/lib/claimCitations";

/**
 * The block above a delivered report (plan §5 act 4, appendix C §2): when the
 * search stopped, what kinds of sources the report stands on, which model
 * wrote it, and what limits it declares. A clinical reader decides how far to
 * trust a synthesis from exactly these four lines before reading one sentence
 * of it.
 *
 * Every value comes from the package or the run record. A field neither
 * declares says 「未注明」 — never a date read out of the prose, never a model
 * assumed from the deployment.
 */
export interface ReportFact {
  label: string;
  value: string;
  /** The value is the absence of one. */
  missing: boolean;
  /** An element id in the report where the fact is stated at length. */
  target?: string;
}

export const NOT_STATED = "未注明";

/**
 * The kind of each preserved source as the control plane read it from the
 * capture's own `source.json` (C8), by artifact path. The package's matrix
 * rarely states a kind, so without this the header of the first live aspirin
 * report (2026-09-19) said 「指南 1 · 其他 25」 while the verification the same
 * page had fetched typed its sources as 28 guideline and 32 RCT references.
 */
export function verifiedSourceTypes(verification: ClaimVerification | null | undefined): Map<string, EvidenceSourceType> {
  const types = new Map<string, EvidenceSourceType>();
  for (const claim of verification?.claims ?? []) {
    for (const source of claim.sources ?? []) {
      const type = source.sourceType;
      if (source.artifactPath && type && (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(type) && type !== "other") {
        types.set(source.artifactPath, type as EvidenceSourceType);
      }
    }
  }
  return types;
}

/** Distinct sources the claims stand on, by kind, in the domain's order (most authoritative form first). */
export function sourceComposition(
  claims: Iterable<ClaimEvidence>,
  verified: ReadonlyMap<string, EvidenceSourceType> = new Map(),
): { type: EvidenceSourceType; label: string; count: number }[] {
  const seen = new Map<string, EvidenceSourceType>();
  for (const claim of claims) {
    for (const source of claimSources(claim)) {
      const key = source.artifactPath ?? source.identifier ?? source.sourceUrl ?? source.sourceTitle;
      const type = (source.artifactPath ? verified.get(source.artifactPath) : undefined) ?? source.sourceType;
      if (key && !seen.has(key)) seen.set(key, type);
    }
  }
  const counts = new Map<EvidenceSourceType, number>();
  for (const type of seen.values()) counts.set(type, (counts.get(type) ?? 0) + 1);
  return (EVIDENCE_SOURCE_TYPES as readonly EvidenceSourceType[])
    .filter((type) => counts.has(type))
    .map((type) => ({ type, label: EVIDENCE_SOURCE_TYPE_LABELS_ZH[type], count: counts.get(type)! }));
}

/** 「DeepSeek · deepseek-flash」 — the model the run record names, as recorded. */
export function modelLabel(model: string | null | undefined): string | null {
  const id = (model ?? "").trim().replace(/^deepseek\//i, "");
  if (!id) return null;
  return /^deepseek/i.test(id) ? `DeepSeek · ${id}` : id;
}

function dateText(value: string | null | undefined): string | null {
  if (!value) return null;
  // A bare date is a calendar day and is read as written. A timestamp is an
  // instant and is dated where the reader is: the prefix of a UTC instant put
  // a run started at 03:01 Beijing time on the previous day.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match) return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const date = new Date(time);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * The facts above a report: when the search stopped, and when the report was
 * written — two dates (2026-09-23 inventory §1.11). The model's name was the
 * deployment's fact; the source tally and the limitations are the report's own
 * to state in its text; and a row reading 「未注明」 told the reader nothing.
 * A package that states its cutoff is taken at its word; one that does not was
 * still searched on a known day, the run's own start.
 */
export function reportFacts({ meta, run }: {
  meta: ClaimMatrixMeta | null;
  run: WebAgentRun | null;
}): ReportFact[] {
  const facts: ReportFact[] = [];
  const cutoff = dateText(meta?.searchCutoff) ?? dateText(run?.startedAt ?? null);
  if (cutoff) facts.push({ label: "检索截止日", value: cutoff, missing: false });
  const generated = dateText(run?.finishedAt ?? run?.startedAt ?? null);
  if (generated) facts.push({ label: "生成日期", value: generated, missing: false });
  return facts;
}

/**
 * The claims a clinical-safety finding names (contract C2): their evidence is
 * open where the sentence stands instead of behind a click.
 */
export function safetyClaimIds(notices: ReadonlyArray<unknown> | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const notice of notices ?? []) {
    if (!notice || typeof notice !== "object") continue;
    const { severity, claimId } = notice as { severity?: unknown; claimId?: unknown };
    if (severity === "safety" && typeof claimId === "string" && /^CLM-\d{3,6}$/.test(claimId)) ids.add(claimId);
  }
  return ids;
}
