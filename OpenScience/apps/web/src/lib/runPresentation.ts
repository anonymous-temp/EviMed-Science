import { errorCodeMessage, runOutcomeKind } from "@evimed/domain";
import type { WebAgentRun, WebAgentRunStatus, WebQualityNotice } from "@/lib/apiClient";
import { capabilityTitle } from "@/lib/researchAgentUi";

export const WEB_RUN_STATUS_LABEL: Record<WebAgentRunStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};

/**
 * The five states a run is shown in, and the one rule that picks them.
 *
 * The sidebar and the ledger used to carry a rule each and disagreed about the
 * same run: amber in the sidebar (delivered, verdict still open), grey or green
 * in the ledger, which had no amber branch at all (2026-09-18 review, B §3d).
 * Both now read this function and render its answer through `RunStatusDot`.
 *
 * `review` is a phase and not a status: the run delivered, and something in
 * the gate's verdict is still open. It is its own state because an accepted
 * run and one waiting on a person are not the same result.
 */
export type RunStateKey = "running" | "done" | "review" | "failed" | "canceled";

export interface RunStatePresentation {
  key: RunStateKey;
  /** The word that always travels with the dot — colour is never the only carrier. */
  label: string;
}

export const RUN_STATE_LABEL: Record<RunStateKey, string> = {
  running: "运行中",
  done: "已交付",
  review: "已交付，待复核",
  // Not 「失败」: a run the stall detector stopped, one refused for a missing
  // credential and one whose package the gate could not read all land here,
  // and none of those says the science failed.
  failed: "未完成",
  canceled: "已取消",
};

export function runState(run: WebAgentRun): RunStatePresentation {
  const key: RunStateKey = run.status === "running"
    ? "running"
    : run.status === "canceled"
      ? "canceled"
      : run.status === "failed" || runDidNotDeliver(run)
        ? "failed"
        : run.phase === "degraded" || run.verification != null
          ? "review"
          : "done";
  return { key, label: RUN_STATE_LABEL[key] };
}

/**
 * The template every capability-card brief starts with
 * (`capabilityBrief` in `@evimed/domain`: 「请以「X」能力完成以下任务：」).
 *
 * Stripped where a title is made, never where the brief is made — the brief
 * stays byte-identical because the gate reads it as the expectation. This is a
 * closed, product-owned template matched by its exact shape, not a pattern
 * over open prose: twelve runs of one capability all began with the same
 * twenty characters, and a truncated row showed nothing else.
 */
const CAPABILITY_BRIEF_PREAMBLE = /^请以「[^」\n]{1,40}」能力完成以下任务[:：]\s*/;

/** The question as a reader asked it, without the capability-card preamble. */
export function runQuestion(run: Pick<WebAgentRun, "question">): string | null {
  const question = run.question?.replace(CAPABILITY_BRIEF_PREAMBLE, "").trim();
  return question ? question : null;
}

/**
 * What to call a run in a list: the title the ledger holds, else its question,
 * else the capability's product name, else a sentence saying the brief was not
 * recorded.
 *
 * The ledger's `title` comes first because it is the one a researcher may have
 * set by hand (`titleSource: "user"`, locked against every automatic rename),
 * and otherwise the server's own reading of the question.
 *
 * It used to end `return run.id`, and a ledger row whose brief predates the
 * `question` column is exactly the row that reaches that line: the run list a
 * new account opens on was twelve identical `clinical-evidence-synthesis`
 * entries and a `run_c657a9e0…` used as a title. An id is not a name — it is
 * the absence of one — and saying so is more use to a reader than printing it.
 * The id stays reachable in the run's own detail, where it is labelled.
 */
export function runTitle(run: WebAgentRun): string {
  const title = run.title?.trim();
  if (title) return title;
  const question = runQuestion(run);
  if (question) return question;
  const agent = run.effectiveAgentId ?? run.agentId;
  const named = runAgentName(agent);
  if (named) return named;
  if (agent) return agent;
  return "未记录题面的运行";
}

/**
 * The moment a list should date a run by: when it ended, or when it started if
 * it has not. Epoch milliseconds; 0 when the ledger carries neither.
 */
export function runMoment(run: Pick<WebAgentRun, "startedAt" | "finishedAt">): number {
  const at = Date.parse(run.finishedAt ?? run.startedAt ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/**
 * How long ago, in the words the lists use: 刚刚 / N 分钟前 / N 小时前, then a
 * date. The single implementation — the sidebar and the ledger each had one.
 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * The second line of a run row: when, and how it came out. Twelve runs of one
 * capability are told apart by this line, not by a longer first one.
 */
export function runMetaLine(run: WebAgentRun, now = Date.now()): string {
  const when = relativeTime(runMoment(run), now);
  const { label } = runState(run);
  return when ? `${when} · ${label}` : label;
}

/** The answer line every unrouted open-domain question runs on (server:
 *  `OPEN_DOMAIN_ANSWER_AGENT_ID`). It is not a catalog capability, so the
 *  catalog has no title for it and the ledger printed its id (seen in the
 *  2026-09-16 scripted walk). */
export const OPEN_DOMAIN_ANSWER_AGENT_ID = "open-domain-answer";

/** What produced a run, in the product's words, or null for an id with no name. */
export function runAgentName(agent: string | null | undefined): string | null {
  if (agent === OPEN_DOMAIN_ANSWER_AGENT_ID) return "开放域问答";
  return capabilityTitle(agent);
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
  /** Clinical framing that could hurt somebody: shown first, and in red. */
  safety: boolean;
  items: string[];
}

export interface NoticeSummary {
  groups: NoticeGroup[];
  /** How many notices a reader cannot discount on their own. */
  mustFix: number;
  /** How many of those are about clinical safety. */
  safety: number;
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
export function summarizeQualityNotices(input: Array<string | WebQualityNotice>): NoticeSummary {
  const notices = input.map((notice) => typeof notice === "string"
    ? notice
    : `${notice.severity === "safety" ? "SAFETY — " : notice.severity === "must-fix" ? "MUST FIX — " : ""}${notice.title}`);
  const groups = new Map<string, NoticeGroup>();
  let mustFixCount = 0;
  let safetyCount = 0;
  for (const notice of notices) {
    // "MUST FIX — " is how the gate marks what a reader cannot see for
    // themselves, and "SAFETY — " what could hurt somebody. Severities, not
    // part of the sentence. Since 2026-09-17 neither withholds a delivery: the
    // package is handed over and these are what the reader is told about it.
    const safety = /^SAFETY\s*[—-]\s*/.test(notice);
    const mustFix = safety || /^MUST FIX\s*[—-]\s*/.test(notice);
    if (mustFix) mustFixCount += 1;
    if (safety) safetyCount += 1;
    const body = notice.replace(/^(?:MUST FIX|SAFETY)\s*[—-]\s*/, "");
    const label = safety ? "临床安全" : NOTICE_GROUPS.find((group) => group.match.test(body))?.label ?? "其他核验提示";
    const key = `${safety ? "2" : mustFix ? "1" : "0"}:${label}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(body);
    else groups.set(key, { label, mustFix, safety, items: [body] });
  }
  const rank = (group: NoticeGroup) => (group.safety ? 2 : group.mustFix ? 1 : 0);
  return {
    // Safety leads, then what a reader cannot discount alone.
    groups: [...groups.values()].sort((a, b) => rank(b) - rank(a)),
    mustFix: mustFixCount,
    safety: safetyCount,
    advisory: notices.length - mustFixCount,
    total: notices.length,
  };
}

