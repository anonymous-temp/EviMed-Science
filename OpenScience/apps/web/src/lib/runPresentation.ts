import { errorCodeMessage, runOutcomeKind } from "@evimed/domain";
import type { WebAgentRun, WebAgentRunStatus } from "@/lib/apiClient";

export const WEB_RUN_STATUS_LABEL: Record<WebAgentRunStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};

/**
 * The dot beside a run, by what the ledger says about it.
 *
 * `degraded` is a phase and not a status: the run delivered, and something in
 * the gate's verdict is still open. It reads amber rather than green because
 * an accepted run and one waiting on a person are not the same result, and the
 * ledger is where that difference has to be visible.
 */
export function runDotClass(run: WebAgentRun): string {
  if (run.status === "running") return "animate-pulse bg-accent";
  if (run.phase === "degraded" || run.verification != null) return "bg-warn";
  if (run.status === "succeeded") return "bg-ok";
  if (run.status === "failed") return "bg-error";
  return "bg-muted";
}

/** What to call a run in a list: its question, else the capability, else its id. */
export function runTitle(run: WebAgentRun): string {
  const question = run.question?.trim();
  if (question) return question;
  const agent = run.effectiveAgentId ?? run.agentId;
  if (agent) return agent;
  return run.id;
}

/* ------------------------------------------------------------------ */
/* What happened to this run, said once                                */
/* ------------------------------------------------------------------ */

/**
 * The outcome classes `@evimed/domain`'s `runOutcomeKind` sorts a run into.
 *
 * Mirrored here because `RUN_OUTCOME_KINDS` is a frozen array of strings and
 * therefore widens to `string` on the way through JSDoc. The domain's own test
 * is what keeps the two lists equal; this one only lets the surfaces switch on
 * the value without a cast at every call site.
 */
export type RunOutcomeKind =
  | "delivered"
  | "qualified"
  | "gated"
  | "stopped"
  | "capped"
  | "upstream"
  | "unknown";

/** One reader-facing verdict on one run: what happened, and whatever the
 *  ledger's own counters can add to it. */
export interface RunOutcome {
  kind: RunOutcomeKind;
  /** The raw ledger code, kept for support — never shown as the message. */
  code: string | null;
  headline: string;
  detail: string | null;
}

/**
 * What to tell the reader about this run — from the one dictionary.
 *
 * This is the only door the two routed run surfaces walk through to reach the
 * error registry, and it exists because there used to be no door at all.
 * RunsPage carried its own 20-key table whose default sentence was
 * "运行未通过核验。", so a run killed by the 15-minute stall detector, a run
 * the researcher cancelled and a run superseded by their own next message were
 * each told their science had failed quality control. A map keyed on the code
 * alone cannot tell those apart, and neither surface had any business owning
 * one.
 *
 * There is deliberately no third field for "what you can do next": every
 * sentence in `ERROR_CODE_MESSAGES` is written to the registry's own rule,
 * "what happened + what you can do", and a per-kind advice line here would be
 * a second dictionary competing with the first — which is the defect being
 * removed, not a feature. `detail` carries only facts the ledger measured, so
 * it is true whatever the code turns out to be.
 */
export function webRunOutcome(run: WebAgentRun): RunOutcome {
  // A cancel is written to the ledger as `runtime_canceled`, but the status
  // alone is enough to name it — and reading the status here means an older
  // record that recorded the cancel without the code still gets the sentence
  // instead of the "no reason recorded" fallback.
  const code = run.errorCode ?? (run.status === "canceled" ? "runtime_canceled" : null);
  return {
    kind: runOutcomeKind({ status: run.status, errorCode: code, verification: run.verification ?? null }) as RunOutcomeKind,
    code: run.errorCode,
    headline: errorCodeMessage(code ?? ""),
    detail: livenessDetail(run),
  };
}

/**
 * What the run had done by the time it ended.
 *
 * These counters are already on the wire and both surfaces rendered them only
 * while `status === "running"` — hidden at exactly the moment they explain
 * something. A researcher told their 58-minute run "failed" has no way to
 * tell it apart from one that died in its first minute, and that is the
 * difference between "resume it" and "it never started".
 */
function livenessDetail(run: WebAgentRun): string | null {
  if (run.status === "running") return null;
  const calls = run.observedToolCalls ?? 0;
  if (calls <= 0) return null;
  return `结束前已完成 ${calls} 次检索与工具调用。`;
}

/**
 * Whether this run owes the reader an explanation.
 *
 * A run that delivered explains itself with its files; a run that did not has
 * to say so in words. Keyed on the domain's outcome vocabulary so there is one
 * definition of "delivered" and the surfaces do not each invent theirs.
 */
export function runDidNotDeliver(run: WebAgentRun): boolean {
  // A run still working owes nothing yet. `runOutcomeKind` classifies a
  // `running` record with no code as `unknown` — correctly, since it is not an
  // outcome at all — and without this line the ledger would put
  // 「这次没有完成，系统没有记下原因。」 on top of a 40-minute analysis that is
  // busy succeeding.
  if (run.status === "running") return false;
  const kind = runOutcomeKind({
    status: run.status,
    errorCode: run.errorCode,
    verification: run.verification ?? null,
  }) as RunOutcomeKind;
  return kind !== "delivered" && kind !== "qualified";
}

/* ------------------------------------------------------------------ */
/* Files the run wrote that the gate did not accept                    */
/* ------------------------------------------------------------------ */

/**
 * The ledger field that lists them.
 *
 * This read two candidate names while the server side was landing in parallel,
 * because picking one and being wrong makes the whole affordance render nothing
 * and look exactly like it was never built. The field shipped as
 * `unverifiedArtifacts`; the alternative is gone.
 */
const UNDELIVERED_FILE_KEYS = ["unverifiedArtifacts"] as const;

/**
 * Files this run wrote that no gate accepted.
 *
 * Returns `null` when the ledger does not carry the field at all — which is
 * *not* the same as "there are none", and the surfaces must not say "没有留下
 * 任何文件" on the strength of a field that was never sent. Twenty-eight of
 * 179 finished runs on the host were refused with `artifacts: []` while a
 * complete package sat on disk; nothing deleted those files, they were only
 * unreachable, so an absent field means unknown and an empty array means none.
 */
export function undeliveredFiles(run: WebAgentRun): string[] | null {
  const record = run as unknown as Record<string, unknown>;
  for (const key of UNDELIVERED_FILE_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The gate's notices, grouped                                         */
/* ------------------------------------------------------------------ */

/** What each gate notice is about, in the reader's language. The notices are
 *  written for the agent that has to repair them, so making them visible put
 *  forty lines of English validator prose in front of a Chinese-reading
 *  researcher. Grouping gives them the shape of the problem first; the detail
 *  lines still carry the line numbers, URLs and claim ids they need to check.
 *
 *  Moved here from RunsPage so the ledger row and the side panel read one
 *  table: two copies of a label map is exactly how the three competing error
 *  dictionaries started. No pattern was added — widening these is banned
 *  (principle 5); the real fix is the gate emitting a code plus parameters
 *  instead of an English sentence. */
const NOTICE_GROUPS: { label: string; match: RegExp }[] = [
  { label: "数字未标注其来源主张", match: /^Report line \d+ numeric facts .+ have no evidence-matrix claim reference/ },
  { label: "数字与所引主张不符", match: /^Report line \d+ numeric facts .+ are not present in the cited claim evidence/ },
  { label: "推导结论未标注为推导", match: /states derived result .+ without marking it as derived/ },
  { label: "推导结论进入了处置建议", match: /practical advice must rest on measured evidence/ },
  { label: "引文地址", match: /^The citation /i },
  { label: "证据矩阵主张", match: /^claims\[\d+\]/ },
  { label: "引文台账与参考文献", match: /^(?:citation-ledger\.csv|references\.bib|citation-audit\.md)/ },
  { label: "检索日志与运行记录", match: /search log|clinical-evidence-(?:search|run)\.json/i },
  { label: "检索到的原文由子任务转述", match: /^Reading retrieved evidence was delegated/ },
  { label: "修复过程影响了报告篇幅", match: /^(?:The report was replaced|Repair reduced)/ },
  { label: "报告结构与表述", match: /^The (?:academic|deep-research) report/ },
];

export interface NoticeGroup {
  label: string;
  mustFix: boolean;
  items: string[];
}

export interface NoticeSummary {
  groups: NoticeGroup[];
  /** How many notices a reader cannot discount on their own. */
  mustFix: number;
  advisory: number;
  total: number;
}

/**
 * The gate's verdict, grouped and counted.
 *
 * The counts are the honest half: a panel that showed four of twenty-five
 * findings without saying so sent the researcher back to fix four things and
 * be refused again for the fifth they were never shown. Callers may render
 * fewer detail lines than there are, but never fewer than they admit to.
 */
export function summarizeQualityNotices(notices: string[]): NoticeSummary {
  const groups = new Map<string, NoticeGroup>();
  let mustFixCount = 0;
  for (const notice of notices) {
    // "MUST FIX — " is how the gate marks what a reader cannot see for
    // themselves. It is a severity, not part of the sentence.
    const mustFix = /^MUST FIX\s*[—-]\s*/.test(notice);
    if (mustFix) mustFixCount += 1;
    const body = notice.replace(/^MUST FIX\s*[—-]\s*/, "");
    const label = NOTICE_GROUPS.find((group) => group.match.test(body))?.label ?? "其他核验提示";
    const key = `${mustFix ? "1" : "0"}:${label}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(body);
    else groups.set(key, { label, mustFix, items: [body] });
  }
  return {
    // What must be fixed leads: it is the part a reader cannot discount alone.
    groups: [...groups.values()].sort((a, b) => Number(b.mustFix) - Number(a.mustFix)),
    mustFix: mustFixCount,
    advisory: notices.length - mustFixCount,
    total: notices.length,
  };
}

/**
 * Hand each group as many detail lines as the budget still allows.
 *
 * `Number.POSITIVE_INFINITY` renders everything. The returned `hidden` counts
 * are what the caller must show; there is no silent remainder.
 */
export function budgetNoticeDetails(
  groups: NoticeGroup[],
  budget: number,
): { group: NoticeGroup; shown: string[]; hidden: number }[] {
  let left = budget;
  return groups.map((group) => {
    const take = Math.max(0, Math.min(group.items.length, left));
    left -= take;
    return { group, shown: group.items.slice(0, take), hidden: group.items.length - take };
  });
}
