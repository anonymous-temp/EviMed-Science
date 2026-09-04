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
