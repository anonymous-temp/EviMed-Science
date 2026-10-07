import { useState } from "react";
import { cancelVcrJob, type VcrJob, type VcrStudy } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { cpuTimeText, jobsAwaitingBudget } from "./VcrBudgetDialog";
import { jobWaitLabel, numberText } from "./vcrText";

/**
 * What the study is computing, in one line under the tabs — and nothing when nothing is.
 *
 * The line is the running computation: its name, how far it has come and 取消. It used to be a card titled 「运行」 that listed
 * every job in a state, and a study with five finished jobs and one running read as a ledger. Now a second job waiting behind the
 * first is a few words at the end of the same line, and the two states that ask something of a person each get a line of their own,
 * only while they hold:
 *
 *  - **the second human stop** — jobs past the compute budget wait for the lead (`确认预算`, the lead's alone);
 *  - **a computation that did not finish** — its sentence, so a failed job is never a silent blank under a tab.
 *
 * A job waiting on the engine says so in the same line, with nothing to press: it goes on by itself when the engine is back.
 */
export function VcrJobLine({ studyId, study, onBudget, onChanged }: {
  studyId: string;
  study: Pick<VcrStudy, "jobs" | "budget" | "abilities">;
  onBudget: () => void;
  onChanged: () => void;
}) {
  const [canceling, setCanceling] = useState<string | null>(null);
  const live = study.jobs.filter((job) => job.state === "running" || job.state === "queued");
  const lead = live.find((job) => job.state === "running") ?? live[0] ?? null;
  const behind = lead ? live.length - 1 : 0;
  // A failure the same computation has since got past (a later job of the same name succeeded; the list is newest first) is history.
  const failed = study.jobs.filter((job, index) => job.state === "failed"
    && !study.jobs.slice(0, index).some((later) => later.label === job.label && later.state === "succeeded"));
  const waiting = jobsAwaitingBudget(study.jobs);
  const awaiting = study.budget?.awaitingBudget ?? 0;
  if (!lead && failed.length === 0 && awaiting <= 0) return null;
  const mayCancel = study.abilities.includes("run");

  const cancel = (job: VcrJob) => {
    if (canceling !== null) return;
    setCanceling(job.id);
    void cancelVcrJob(studyId, job.id)
      .then(() => { toast.success("已取消。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这项计算暂时无法取消，请稍后重试。" })))
      .finally(() => setCanceling(null));
  };

  const progress = lead?.progress && lead.progress.total > 0 ? lead.progress : null;
  const share = progress ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100))) : null;

  return (
    <div data-vcr-jobs="" className="mt-4 flex flex-col gap-2">
      {lead && (
        <div data-vcr-job={lead.id} data-vcr-job-state={lead.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-accent-soft px-3 py-2 text-ui text-accent-strong">
          <span aria-hidden="true" data-forced-colors="preserve" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running" />
          <span className="min-w-0 truncate">{lead.state === "queued" ? `${lead.label}，排队中` : `正在${lead.label}`}</span>
          {progress && (
            <>
              <span className="tabular-nums">{`${numberText(progress.done, 0)} / ${numberText(progress.total, 0)}`}</span>
              <span role="progressbar" aria-label="进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? 0} className="h-1 w-28 shrink-0 overflow-hidden rounded bg-surface">
                <span className="block h-full bg-accent" style={{ width: `${share}%` }} />
              </span>
            </>
          )}
          {behind > 0 && <span className="text-caption text-text-3">{`另有 ${behind} 项排队`}</span>}
          {lead.waitingOn && <span data-vcr-job-wait={lead.waitingOn} role="status" className="text-caption text-text-2">{jobWaitLabel(lead.waitingOn)}</span>}
          <span className="flex-1" />
          {lead.cancelable && mayCancel && (
            <Button size="sm" variant="text" loading={canceling === lead.id} disabled={canceling !== null} onClick={() => cancel(lead)}>取消</Button>
          )}
        </div>
      )}
      {awaiting > 0 && (
        <p data-vcr-budget-wait="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded bg-warn-soft px-3 py-2 text-ui text-warn-strong">
          <span className="min-w-0 flex-1">
            {`有 ${numberText(awaiting, 0)} 项计算等待预算确认${waiting.seconds > 0 ? ` · 需 ${cpuTimeText(waiting.seconds)} CPU 时间` : ""}`}
          </span>
          {/* Confirming is the lead's; anyone else sees the line and not a button that would be refused. */}
          {study.abilities.includes("manage_study") && <Button size="sm" onClick={onBudget}>确认预算</Button>}
        </p>
      )}
      {failed.length > 0 && !lead && (
        <p data-vcr-job-failed="" role="status" className="rounded bg-surface-2 px-3 py-2 text-ui text-text-2">
          {failed[0].error?.message ?? `${failed.length === 1 ? "有一项计算" : `有 ${failed.length} 项计算`}没有完成，已算出的部分保留。`}
        </p>
      )}
    </div>
  );
}
