import { Disclosure } from "@/components/ui/Disclosure";
import { Button } from "@/components/ui/Button";
import { VCR_MIN_CELL_SIZE } from "@evimed/domain";
import { Note, type NoteResult } from "@/components/ui/Note";
import { formatLingdou } from "@/lib/format";
import type { VcrJudgedFailures, VcrJudgedProgress } from "@/lib/vcrClient";

/** An amount as every amount on screen is drawn: in 灵豆, two places, and a sum under a cent is not a zero. */
export function money(value: number): string {
  return formatLingdou(value);
}

/** What the job's stated ceiling and its spending so far come to, in one clause; null when neither is known. */
function costClause(progress: VcrJudgedProgress): string | null {
  const cost = progress.cost;
  if (!cost) return null;
  // The ceiling is the newest round's own; what was spent is the whole of this scope's judging, every round of it.
  const ceiling = cost.ceiling === null ? null : `这一轮预计最多 ${money(cost.ceiling)}`;
  const spent = cost.spent === null ? null : `累计已用 ${money(cost.spent)}`;
  return [ceiling, spent].filter(Boolean).join("，") || null;
}

/** The second stage (clause by clause) is what is still running: every pair has its whole-pair verdict and the clause calls are out. */
function clauseStageRunning(progress: VcrJudgedProgress): boolean {
  return progress.state === "running" && progress.finished !== null && progress.finished === progress.total && (progress.clauses?.left ?? 0) > 0;
}

/** The count in a page's heading: 「已完成 n / m」, and while the clause calls are still out, that it is the whole-pair stage that is done. */
export function judgedCountLabel(progress: VcrJudgedProgress): string {
  if (progress.finished === null || progress.total === null) return "";
  return clauseStageRunning(progress) ? `整体判定已完成 ${progress.finished} / ${progress.total} · 逐条判定进行中` : `已完成 ${progress.finished} / ${progress.total}`;
}

/**
 * How the judging stands, in one sentence that carries its numbers and, where there is something to do about it, the one action: stop the job
 * that is out, or go on with the rest of what an earlier job did not finish. A run that stopped short or failed is said as that — never as
 * "nothing was judged" and never as finished.
 *
 * Hidden knowledge:
 *  - **n of m is the pairs asked for**: what every job of this scope planned, plus anything judged outside a job. A pair that failed is
 *    counted apart from the ones not yet tried, and both are in m.
 *  - **Stopping stops this job**: the pairs it already judged stay, and the study and its other work go on.
 *  - **The cost is the job's own**: the ceiling it stated when it began and what its pairs have cost so far; either may be unknown, and an unknown is left out, not drawn as zero.
 */
export function JudgedProgressNote({ progress, noun, mayRun, busy, onResume, onStop }: {
  progress: VcrJudgedProgress;
  /** 「个试验」 or 「位患者」. */
  noun: string;
  mayRun: boolean;
  busy: boolean;
  onResume: () => void;
  onStop: () => void;
}) {
  const cost = costClause(progress);
  const failed = progress.failed !== null && progress.failed > 0 ? `，其中 ${progress.failed} ${noun.slice(0, 1)}没判成` : "";
  const owed = progress.clauses?.left ?? 0;
  const clausesWord = owed > 0 && progress.clauses?.wanted ? `，逐条判了 ${progress.clauses.done ?? 0} / ${progress.clauses.wanted}` : "";
  const tail = `${noun}${failed}${clausesWord}${cost ? `；${cost}` : ""}。`;
  // A count of people too small to show this reader is not a zero: the sentence goes without it.
  const howFar = (lead: string, after = ""): NoteResult => (progress.finished !== null && progress.total !== null
    ? [`${lead}${clauseStageRunning(progress) ? "整体判定已完成 " : "已完成 "}`, { n: progress.finished }, " / ", { n: progress.total }, ` ${tail}${after}`]
    : [`${lead}少于 `, { n: VCR_MIN_CELL_SIZE }, ` 人时不显示具体人数${failed}${cost ? `；${cost}` : ""}。${after}`]);
  if (progress.state === "running" || progress.state === "waiting_budget") {
    const waiting = progress.state === "waiting_budget";
    return (
      <div data-vcr-judged-progress={progress.state}>
        <Note
          tone={waiting ? "warn" : "default"}
          result={howFar(waiting ? "判定暂停，等研究的计算预算：" : clauseStageRunning(progress) ? "正在逐条判定：" : "正在判定：")}
          action={mayRun && progress.jobId ? <Button size="sm" variant="secondary" actionKind="set" loading={busy} onClick={onStop}>停止这批判定</Button> : undefined}
        />
      </div>
    );
  }
  // What a continuation starts: what never ran, what failed, and the pairs whose clauses are owed.
  const unit = noun.slice(0, 1);
  const notDone = (progress.waiting ?? 0) + (progress.failed ?? 0);
  const left = notDone + owed;
  const leftHidden = progress.waiting === null || progress.failed === null || progress.clauses?.left === null;
  if (progress.state === "stopped" && (left > 0 || leftHidden)) {
    // Two kinds of leftover are named as what they are: the ones with no verdict yet, and the ones with a verdict whose clause by clause is not done. One kind keeps the short button.
    const both = notDone > 0 && owed > 0 && !leftHidden;
    const rest = both ? `还差：${notDone} ${noun}还没判出结论，${owed} ${noun}的逐条判定没做完。` : "";
    return (
      <div data-vcr-judged-progress="stopped">
        <Note
          tone="warn"
          result={howFar("判定没有做完：", rest)}
          action={mayRun ? <Button size="sm" variant="secondary" actionKind="start" loading={busy} onClick={onResume}>{leftHidden || both ? "继续判定剩下的" : `继续判定剩下的 ${left} ${unit}`}</Button> : undefined}
        />
      </div>
    );
  }
  if (progress.state === "done" && progress.cost?.spent) {
    return (
      <div data-vcr-judged-progress="done">
        <Note result={progress.finished !== null
          ? ["已全部判完：", { n: progress.finished }, ` ${noun}，用了 ${money(progress.cost.spent)}。`]
          : ["已全部判完（少于 ", { n: VCR_MIN_CELL_SIZE }, ` 人时不显示具体人数），用了 ${money(progress.cost.spent)}。`]} />
      </div>
    );
  }
  return null;
}

/** The pairs that were not judged, each with its reason in plain words, or for a long roster the reasons counted and the first names. */
export function JudgedFailures({ failures, noun, titled }: { failures: VcrJudgedFailures; noun: string; titled: boolean }) {
  if (failures.count === 0) return null;
  return (
    <div data-vcr-judged-failures="" className="flex flex-col gap-2">
      <p className="text-ui text-text">{failures.reasons.map((entry) => `${entry.reason} ${entry.count} ${noun.slice(0, 1)}`).join("；")}</p>
      <Disclosure summary={`查看没判成的 ${failures.count} ${noun.slice(0, 1)}${failures.listed.length < failures.count ? `（列出前 ${failures.listed.length}）` : ""}`}>
        <ul className="flex flex-col gap-1">
          {failures.listed.map((entry) => (
            <li key={`${entry.subjectKey}:${entry.id}`} data-vcr-failed={titled ? entry.id : entry.subjectKey} className="flex flex-wrap items-baseline gap-x-3 text-ui">
              <span className="tabular-nums text-text">{titled ? entry.registryId ?? entry.title ?? entry.id : entry.label}</span>
              {titled && entry.title && entry.registryId && <span className="min-w-0 text-text-2">{entry.title}</span>}
              <span className="text-text-3">{entry.reason}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
