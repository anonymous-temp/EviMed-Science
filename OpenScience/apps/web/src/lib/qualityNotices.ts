import type { WebQualityNotice, WebQualityNoticeSeverity } from "@/lib/apiClient";

/**
 * The delivery gate's findings on a run, grouped by how much they matter.
 *
 * Since 2026-09-18 each finding reaches the browser as a `WebQualityNotice`:
 * the gate's own `code`, a severity, and a Chinese title and detail from one
 * domain table (contract C2). Before that it was one flattened English
 * sentence written for the agent that had to repair it, and the ledger printed
 * it verbatim — 「claims[52].claim numeric fact 6 is not present…」 in front of
 * a Chinese-reading pharmacist (review B §4e). That was the sibling platform's
 * hard rule 1 broken on the product's core output: every status, enum and
 * error code on screen goes through a Chinese mapping.
 *
 * Old records still hold the sentences, and they are read here too — but no
 * English sentence becomes primary text. `legacyNotice` below is the whole of
 * the fallback.
 */

export type NoticeSeverity = WebQualityNoticeSeverity;

/** One finding as a line a reader can act on. Always Chinese. */
export interface NoticeLine {
  text: string;
  claimId?: string;
  file?: string;
}

export interface NoticeGroup {
  key: string;
  severity: NoticeSeverity;
  /** What the findings in this group are about, in the reader's language. */
  label: string;
  /** How many findings the group stands for, lines or not. */
  count: number;
  /** The Chinese lines worth showing under the label; may be fewer than `count`. */
  lines: NoticeLine[];
  /**
   * Sentences only the run could read — the pre-2026-09-18 English form. They
   * are counted in `count`, never printed as a line, and shown verbatim only
   * behind the operator-only disclosure.
   */
  technical: string[];
  /**
   * An old finding no label in the frozen table covers. Such groups are not
   * listed under a made-up heading; they fold into 「另有 N 条技术提示」.
   */
  unlabelled: boolean;
}

export interface NoticeSummary {
  safety: NoticeGroup[];
  mustFix: NoticeGroup[];
  advice: NoticeGroup[];
  counts: { safety: number; mustFix: number; advice: number; total: number };
  /** How many findings no Chinese label covers (old records only): 「另有 N 条技术提示」. */
  technicalCount: number;
}

const SEVERITY_LABEL: Record<NoticeSeverity, string> = {
  safety: "临床安全",
  "must-fix": "必须修改",
  advice: "提示",
};

export function noticeSeverityLabel(severity: NoticeSeverity): string {
  return SEVERITY_LABEL[severity];
}

const UNLABELLED = "其他技术提示";

/** A character from the CJK Unified Ideographs block — the UI language. */
const CJK = /[\u3400-\u9fff]/;

/**
 * Old records: the one door a flattened sentence walks through.
 *
 * Two facts are read off it, both closed-vocabulary. The severity is the
 * prefix the gate itself wrote (`SAFETY — ` / `MUST FIX — `). The group label
 * comes from `LEGACY_NOTICE_GROUPS`, frozen as it stood on 2026-09-18: the gate
 * now emits a code, so this table is not extended, ever (principle 5 — widening
 * a prose pattern is exactly what that principle bans). A sentence with no
 * Chinese in it was written for the run, not the reader, and is counted but
 * never printed; one in Chinese (the safety rules have always written Chinese)
 * is shown as it is.
 */
function legacyNotice(sentence: string): { severity: NoticeSeverity; label: string; line: string | null } {
  const safety = /^SAFETY\s*[—-]\s*/.test(sentence);
  const mustFix = !safety && /^MUST FIX\s*[—-]\s*/.test(sentence);
  const body = sentence.replace(/^(?:MUST FIX|SAFETY)\s*[—-]\s*/, "").trim();
  const severity: NoticeSeverity = safety ? "safety" : mustFix ? "must-fix" : "advice";
  const label = safety
    ? "临床安全"
    : LEGACY_NOTICE_GROUPS.find((group) => group.match.test(body))?.label ?? UNLABELLED;
  return { severity, label, line: CJK.test(body) ? body : null };
}

/**
 * The pre-2026-09-18 group labels, frozen. Read only for records written
 * before the gate emitted codes; do not add to it — add a row to the domain's
 * `gateIssueText` table instead.
 */
const LEGACY_NOTICE_GROUPS: ReadonlyArray<{ label: string; match: RegExp }> = Object.freeze([
  { label: "数字未标注其来源主张", match: /^Report line \d+ numeric facts .+ have no evidence-matrix claim reference/ },
  { label: "数字与所引主张不符", match: /^Report line \d+ numeric facts .+ are not present in the cited claim evidence/ },
  { label: "推导结论未标注为推导", match: /states derived result .+ without marking it as derived/ },
  { label: "推导结论进入了处置建议", match: /practical advice must rest on measured evidence/ },
  { label: "引文地址", match: /^The citation /i },
  { label: "证据矩阵主张", match: /^claims\[\d+\]/ },
  { label: "引文台账与参考文献", match: /^(?:citation-ledger\.csv|references\.bib|citation-audit\.md)/ },
  { label: "检索日志与过程记录", match: /search log|clinical-evidence-(?:search|run)\.json/i },
  { label: "检索到的原文由子任务转述", match: /^Reading retrieved evidence was delegated/ },
  { label: "修复过程影响了报告篇幅", match: /^(?:The report was replaced|Repair reduced)/ },
  { label: "报告结构与表述", match: /^The (?:academic|deep-research) report/ },
]);

const SEVERITIES: readonly NoticeSeverity[] = ["safety", "must-fix", "advice"];

function isStructured(value: unknown): value is WebQualityNotice {
  if (!value || typeof value !== "object") return false;
  const notice = value as Partial<WebQualityNotice>;
  return typeof notice.title === "string" && notice.title.trim() !== ""
    && typeof notice.severity === "string" && SEVERITIES.includes(notice.severity as NoticeSeverity);
}

/**
 * The gate's verdict, grouped and counted.
 *
 * The counts are the honest half: a panel that showed four of twenty-five
 * findings without saying so sent the researcher back to fix four things and
 * be refused again for the fifth they were never shown. Callers may render
 * fewer lines than there are, but never fewer than they admit to.
 */
export function summarizeQualityNotices(input: ReadonlyArray<unknown> | null | undefined): NoticeSummary {
  const groups = new Map<string, NoticeGroup>();
  let technicalCount = 0;
  const add = (severity: NoticeSeverity, groupKey: string, label: string, line: NoticeLine | null, technical: string | null, unlabelled = false) => {
    const key = `${severity}:${groupKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, severity, label, count: 0, lines: [], technical: [], unlabelled };
      groups.set(key, group);
    }
    group.count += 1;
    if (line && line.text !== group.label && !group.lines.some((existing) => existing.text === line.text)) group.lines.push(line);
    if (technical && !group.technical.includes(technical)) group.technical.push(technical);
  };
  for (const notice of input ?? []) {
    if (isStructured(notice)) {
      const detail = notice.detail?.trim();
      add(
        notice.severity,
        notice.check || notice.code || notice.title,
        notice.title.trim(),
        { text: detail || notice.title.trim(), claimId: notice.claimId, file: notice.file },
        // The sentence the run was sent, for support: operator-only, never a line.
        typeof notice.text === "string" && notice.text.trim() ? notice.text.trim() : null,
      );
    } else if (typeof notice === "string" && notice.trim()) {
      const legacy = legacyNotice(notice.trim());
      const unlabelled = !legacy.line && legacy.label === UNLABELLED;
      if (unlabelled) technicalCount += 1;
      add(legacy.severity, `legacy:${legacy.label}`, legacy.label, legacy.line ? { text: legacy.line } : null, legacy.line ? null : notice.trim(), unlabelled);
    }
    // Anything else is not a finding the gate could have written; dropped
    // rather than rendered as `[object Object]`.
  }
  const of = (severity: NoticeSeverity) => [...groups.values()].filter((group) => group.severity === severity);
  const total = (list: NoticeGroup[]) => list.reduce((sum, group) => sum + group.count, 0);
  const safety = of("safety");
  const mustFix = of("must-fix");
  const advice = of("advice");
  return {
    safety,
    mustFix,
    advice,
    counts: {
      safety: total(safety),
      mustFix: total(mustFix),
      advice: total(advice),
      total: total(safety) + total(mustFix) + total(advice),
    },
    technicalCount,
  };
}

/**
 * One sentence for the counts, the same wherever it appears:
 * 「临床安全 1 项 · 必须修改 3 项 · 提示 12 项」. Empty for no findings.
 */
export function noticeCountsLine(summary: NoticeSummary): string {
  const parts: string[] = [];
  if (summary.counts.safety > 0) parts.push(`临床安全 ${summary.counts.safety} 项`);
  if (summary.counts.mustFix > 0) parts.push(`必须修改 ${summary.counts.mustFix} 项`);
  if (summary.counts.advice > 0) parts.push(`提示 ${summary.counts.advice} 项`);
  return parts.join(" · ");
}

/**
 * An inbox body, split into what a reader can read and what only the run
 * could. Bodies written before 2026-09-18 carried the first two gate sentences
 * verbatim under the Chinese lead lines; those lines are held back the same
 * way `legacyNotice` holds back a ledger sentence, by script rather than by
 * wording. New bodies are composed from counts and never carry one.
 */
export function splitNoticeBody(body: string | null | undefined): { lines: string[]; technical: string[] } {
  const lines: string[] = [];
  const technical: string[] = [];
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const stripped = line.replace(/^(?:MUST FIX|SAFETY)\s*[—-]\s*/, "");
    if (CJK.test(stripped)) lines.push(stripped === line ? line : stripped);
    else technical.push(line);
  }
  return { lines, technical };
}
