import { EVIDENCE_SOURCE_TYPES, EVIDENCE_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import type { WebAgentRun } from "@/lib/apiClient";
import { claimSources, type ClaimEvidence, type ClaimMatrixMeta, type EvidenceSourceType } from "@/lib/claimCitations";

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

/** Distinct sources the claims stand on, by kind, in the domain's order (most authoritative form first). */
export function sourceComposition(claims: Iterable<ClaimEvidence>): { type: EvidenceSourceType; label: string; count: number }[] {
  const seen = new Map<string, EvidenceSourceType>();
  for (const claim of claims) {
    for (const source of claimSources(claim)) {
      const key = source.artifactPath ?? source.identifier ?? source.sourceUrl ?? source.sourceTitle;
      if (key && !seen.has(key)) seen.set(key, source.sourceType);
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
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const date = new Date(time);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function reportFacts({
  meta,
  claims,
  run,
  limitationsTarget,
}: {
  meta: ClaimMatrixMeta | null;
  claims: Map<string, ClaimEvidence> | null;
  run: WebAgentRun | null;
  /** The id of the report's own 「局限性」 heading, when it has one. */
  limitationsTarget?: string | null;
}): ReportFact[] {
  const facts: ReportFact[] = [];
  const cutoff = dateText(meta?.searchCutoff);
  facts.push({ label: "检索截止日", value: cutoff ?? NOT_STATED, missing: !cutoff });

  const composition = claims ? sourceComposition(claims.values()) : [];
  const total = composition.reduce((sum, entry) => sum + entry.count, 0);
  const scope = meta?.sourceScope
    ?? (total > 0 ? `${composition.map((entry) => `${entry.label} ${entry.count}`).join(" · ")}（共 ${total} 个来源）` : null);
  facts.push({ label: "来源范围", value: scope ?? NOT_STATED, missing: !scope });

  const model = modelLabel(run?.model);
  facts.push({ label: "模型", value: model ?? NOT_STATED, missing: !model });

  if (meta?.limitations?.length) {
    facts.push({ label: "已知局限", value: meta.limitations.join("；"), missing: false, ...(limitationsTarget ? { target: limitationsTarget } : {}) });
  } else if (limitationsTarget) {
    facts.push({ label: "已知局限", value: "见正文「局限性」一节", missing: false, target: limitationsTarget });
  } else {
    facts.push({ label: "已知局限", value: NOT_STATED, missing: true });
  }

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
