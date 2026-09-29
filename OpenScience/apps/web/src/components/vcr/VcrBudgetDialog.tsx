import { useRef, useState } from "react";
import { confirmVcrBudget, type VcrBudget, type VcrJob } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { NO_VALUE, numberText } from "./vcrText";

/**
 * CPU time as a reader says it: 「45 秒」「12 分钟」「2 小时」「2.5 小时」.
 *
 * The platform meters compute in CPU seconds (contract 2026-09-29 §3) and the
 * budget is that, not money; a number of seconds past a few hundred is a
 * number nobody reads, so it is said in the largest unit that keeps it small.
 */
export function cpuTimeText(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return NO_VALUE;
  if (seconds < 60) return `${numberText(Math.round(seconds), 0)} 秒`;
  if (seconds < 3_600) return `${numberText(Math.round(seconds / 60), 0)} 分钟`;
  const hours = Math.round(seconds / 360) / 10;
  return `${hours.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时`;
}

/** The jobs held at the second human stop, and the CPU time they would need between them. */
export function jobsAwaitingBudget(jobs: readonly VcrJob[]): { jobs: VcrJob[]; seconds: number } {
  const waiting = jobs.filter((job) => job.state === "awaiting_budget");
  const seconds = waiting.reduce((sum, job) => sum + (typeof job.cpuSecondsLimit === "number" && job.cpuSecondsLimit > 0 ? job.cpuSecondsLimit : 0), 0);
  return { jobs: waiting, seconds };
}

/**
 * The second of the three places a human is required to stop: more compute
 * than this study's budget (plan §10.1).
 *
 * The budget is CPU time. A job that would pass it waits here, and the lead
 * releases it — one job at a time, all of them at once, or by adding time to
 * the budget; nothing is silently cut down to fit. What is used and what is
 * already committed are shown beside the limit, because a number to raise
 * means nothing without the number it is raised from.
 *
 * Every confirmation is one request at a time (CW-18): a second click while
 * the first is in flight does nothing.
 */
export function VcrBudgetDialog({
  studyId,
  budget,
  jobs,
  onClose,
  onSaved,
}: {
  studyId: string;
  budget: VcrBudget | null;
  jobs: readonly VcrJob[];
  onClose: () => void;
  /** After any confirmation: the page re-reads the study. */
  onSaved: () => void;
}) {
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const holding = useRef(false);
  const waiting = jobsAwaitingBudget(jobs);
  const parsed = Number.parseFloat(minutes);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const confirm = (key: string, body: { jobId: string } | { cpuSeconds: number }, done: string) => {
    if (holding.current) return;
    holding.current = true;
    setBusy(key);
    void confirmVcrBudget(studyId, body)
      .then(() => { toast.success(done); onSaved(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "计算预算暂时无法确认，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(null); });
  };

  return (
    <Drawer title="计算预算" onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-budget="" className="flex flex-col gap-6">
        <dl className="divide-y divide-border rounded-card border border-border">
          {[
            { label: "已用", value: budget?.usedSeconds },
            { label: "已承诺", value: budget?.committedSeconds },
            { label: "上限", value: budget?.limitSeconds },
          ].map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-caption text-text-3">{row.label}</dt>
              <dd className="text-ui tabular-nums text-text">{cpuTimeText(row.value)}</dd>
            </div>
          ))}
        </dl>

        {waiting.jobs.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-ui font-semibold text-text">等待确认</h3>
              <Button
                size="sm"
                loading={busy === "all"}
                disabled={busy !== null || waiting.seconds <= 0}
                onClick={() => confirm("all", { cpuSeconds: waiting.seconds }, "已确认，等待中的计算会开始。")}
              >
                全部确认
              </Button>
            </div>
            <ul className="divide-y divide-faint">
              {waiting.jobs.map((job) => (
                <li key={job.id} data-vcr-budget-job={job.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-text">{job.label}</span>
                    <span className="block text-caption tabular-nums text-text-3">{`需要 ${cpuTimeText(job.cpuSecondsLimit)} CPU 时间`}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === job.id}
                    disabled={busy !== null}
                    onClick={() => confirm(job.id, { jobId: job.id }, "已确认，这项计算会开始。")}
                  >
                    确认
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) confirm("add", { cpuSeconds: Math.round(parsed * 60) }, "已增加计算时间。");
          }}
        >
          <Input
            label="增加计算时间（分钟）"
            type="number"
            min={1}
            step="1"
            inputMode="numeric"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            className="w-40"
          />
          <Button type="submit" variant="secondary" loading={busy === "add"} disabled={!valid || busy !== null}>增加</Button>
        </form>
      </div>
    </Drawer>
  );
}
