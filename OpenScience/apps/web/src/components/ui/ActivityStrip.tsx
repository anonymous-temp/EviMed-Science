import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useElapsed } from "@/lib/useElapsed";
import { Button } from "@/components/ui/Button";

/**
 * What the module is doing right now, said where the person is looking (R19, plan §2.2 rule 6, §5.3).
 *
 * Pressing 「生成虚拟患者」 used to carry the person into a conversation of the project that ran in the background, with no way
 * back to the page; the other shape was a grey 「正在进行：证据」 beside the button with no progress and nowhere to go. The
 * button now only starts the work, and this strip — under the step rail, in the sticky band — says what is happening, how far,
 * for how long, and has 取消. The page reads its state every few seconds while the strip is up and updates itself; the
 * conversation is a view of the same page (`to`), not another place.
 *
 * Facts, not sentences: `label` is the visible question as the person asked it (「生成虚拟患者」) and the strip composes
 * 「正在生成虚拟患者」; `counts` are a number done of a number to do, with `phase` naming what is counted (「计算」). **No
 * percentage** — a share of an agent's work is a number nobody can honour (DESIGN.md).
 *
 * `variant="chip"` is the header's small form: a pulsing dot, the step, the elapsed time and 「查看进度」 as the whole chip's
 * link. `data-activity` is what the walk reads.
 */
export interface ActivityCounts {
  done: number;
  total: number;
}

const NUMBER = new Intl.NumberFormat("zh-CN");

export interface ActivityStripProps {
  /** What was asked for, as the person asked it: 「生成虚拟患者」. */
  label: string;
  /** What `counts` counts: 「计算」「检索」. */
  phase?: string;
  counts?: ActivityCounts;
  startedAt?: string | number | Date | null;
  /** How many more are waiting behind this one. */
  queued?: number;
  /**
   * It is not going yet, and this is what it waits for (「等「证据」做完」): the strip then says 「排队中」 where it said 「正在」, the dot
   * does not pulse, and there is no clock — nothing has started to be counted.
   */
  waiting?: string;
  /** The conversation (or the page of the work) behind it. */
  to?: string;
  onCancel?: () => void;
  cancelling?: boolean;
  variant?: "strip" | "chip";
  className?: string;
}

export function ActivityStrip({ label, phase, counts, startedAt, queued, waiting, to, onCancel, cancelling, variant = "strip", className }: ActivityStripProps) {
  const elapsed = useElapsed(waiting ? null : startedAt);
  const dot = waiting
    ? <span aria-hidden="true" data-forced-colors="preserve" className="h-2 w-2 shrink-0 rounded-full bg-surface ring-2 ring-accent" />
    : <span aria-hidden="true" data-forced-colors="preserve" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running" />;
  if (variant === "chip") {
    const body = (
      <>
        {dot}
        <span className="min-w-0 truncate">{waiting ? `${label}，排队中` : `正在${label}`}</span>
        {elapsed && <span className="shrink-0 tabular-nums text-text-3">{elapsed}</span>}
        {to && <span className="shrink-0">查看进度</span>}
      </>
    );
    const look = cn("inline-flex h-sm max-w-full items-center gap-2 rounded-full bg-accent-soft px-3 text-ui text-accent", className);
    return to
      ? <Link to={to} data-activity="chip" className={cn(look, "hover:bg-surface-3")}>{body}</Link>
      : <span data-activity="chip" className={look}>{body}</span>;
  }
  const detail = counts && counts.total > 0 ? `${phase ? `${phase} ` : ""}${NUMBER.format(counts.done)} / ${NUMBER.format(counts.total)}` : phase;
  return (
    <div data-activity="strip" data-activity-state={waiting ? "queued" : "running"} className={cn("flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded bg-accent-soft px-3 py-1.5 text-ui text-accent", className)}>
      {dot}
      <span className="min-w-0 truncate">{waiting ? `${label} · 排队中` : `正在${label}`}</span>
      {waiting ? <span>{waiting}</span> : detail && <span className="tabular-nums">{detail}</span>}
      {elapsed && <span className="text-caption tabular-nums text-text-3">{elapsed}</span>}
      {queued !== undefined && queued > 0 && <span className="text-caption text-text-2">{`另有 ${queued} 项排队`}</span>}
      <span className="flex-1" />
      {to && <Link to={to} className="rounded text-link hover:underline">查看进度</Link>}
      {onCancel && <Button size="sm" variant="text" loading={cancelling} disabled={cancelling} onClick={onCancel}>取消</Button>}
    </div>
  );
}
