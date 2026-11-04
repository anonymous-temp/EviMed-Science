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
  const ceiling = cost.ceiling === null ? null : `预计最多 ${money(cost.ceiling)}`;
  const spent = cost.spent === null ? null : `已用 ${money(cost.spent)}`;
  return [ceiling, spent].filter(Boolean).join("，") || null;
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
  const tail = `${noun}${failed}${cost ? `；${cost}` : ""}。`;
  // A count of people too small to show this reader is not a zero: the sentence goes without it.
  const howFar = (lead: string): NoteResult => (progress.finished !== null && progress.total !== null
    ? [`${lead}已完成 `, { n: progress.finished }, " / ", { n: progress.total }, ` ${tail}`]
    : [`${lead}少于 `, { n: VCR_MIN_CELL_SIZE }, ` 人时不显示具体人数${failed}${cost ? `；${cost}` : ""}。`]);
  if (progress.state === "running" || progress.state === "waiting_budget") {
    const waiting = progress.state === "waiting_budget";
    return (
      <div data-vcr-judged-progress={progress.state}>
        <Note
          tone={waiting ? "warn" : "default"}
          result={howFar(waiting ? "判定暂停，等研究的计算预算：" : "正在判定：")}
          action={mayRun && progress.jobId ? <Button size="sm" variant="secondary" actionKind="set" loading={busy} onClick={onStop}>停止这批判定</Button> : undefined}
        />
      </div>
    );
  }
  const left = (progress.waiting ?? 0) + (progress.failed ?? 0);
  const leftHidden = progress.waiting === null || progress.failed === null;
  if (progress.state === "stopped" && (left > 0 || leftHidden)) {
    return (
      <div data-vcr-judged-progress="stopped">
        <Note
          tone="warn"
          result={howFar("判定没有做完：")}
          action={mayRun ? <Button size="sm" variant="secondary" actionKind="start" loading={busy} onClick={onResume}>{leftHidden ? "继续判定剩下的" : `继续判定剩下的 ${left} ${noun.slice(0, 1)}`}</Button> : undefined}
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
