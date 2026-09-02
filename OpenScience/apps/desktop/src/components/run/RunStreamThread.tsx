import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCw, XCircle } from "lucide-react";
import { BlockList } from "@/components/thread/BlockList";
import { RunInteractionPrompt } from "@/components/run/RunInteractionPrompt";
import { RunTree } from "@/components/run/RunTree";
import { cn } from "@/lib/cn";
import type { RunStreamStatus } from "@/lib/useRunStream";
import { budgetLimit, TERMINAL_RUN_STATUSES, type RunView } from "@/lib/runStream";

// Imported rather than repeated: a run the control plane considers finished
// beside a badge that still spins is the kind of disagreement nobody reports,
// they just stop trusting the badge.

/**
 * Every status the control plane publishes, in the user's words.
 *
 * The vocabulary is the run ledger's `run.status` — `running`, `succeeded`,
 * `failed`, `canceled` — plus the `reserved` a view starts from before the
 * first frame arrives. It is deliberately *not* `@evimed/domain`'s nine-value
 * `RUN_PHASES`: the ledger's own field never carries `accepted` or `degraded`,
 * and labelling values that are never sent while missing the ones that are is
 * how a delivered run ends up displaying a raw identifier. The `phase`
 * projection (§7.1.1) those two values live in is a sibling field on the same
 * frame, read separately (`RunsPage`'s 待人工复核 grouping), not folded into
 * this badge.
 */
const STATE_LABEL: Record<string, string> = {
  reserved: "已排队",
  running: "进行中",
  succeeded: "已交付",
  failed: "未完成",
  canceled: "已取消",
};

function StateBadge({ state, errorCode }: { state: string; errorCode: string | null }) {
  const settled = (TERMINAL_RUN_STATUSES as readonly string[]).includes(state);
  const Icon = state === "succeeded" ? CheckCircle2 : state === "failed" ? XCircle : settled ? CircleDashed : Loader2;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-input bg-surface-2 px-2 py-1 text-caption",
        state === "succeeded" && "text-ok",
        state === "failed" && "text-error",
        !settled && "text-muted",
        state === "canceled" && "text-muted",
      )}
    >
      <Icon size={12} className={cn(!settled && "animate-spin")} aria-hidden />
      {STATE_LABEL[state] ?? state}
      {errorCode ? <span className="text-muted">· {errorCode}</span> : null}
    </span>
  );
}

/**
 * One run, rendered from the control plane's own event vocabulary.
 *
 * Hidden knowledge: what is on screen that a chat transcript would not show,
 * and why each earned its space.
 *
 * A deliverable's *issues* are shown even when the run is still going, because
 * the gate returns its verdict as a value and the run repairs in place — a user
 * watching a run that has been rejected twice should be able to see what for,
 * rather than learn it from a final failure. They live in the *run tree* now,
 * beside the child that produced them: the flat 交付物/分工 pair this used to
 * draw showed both facts and neither relation, so a reader could see that a
 * package was rejected and not who had been asked for it.
 *
 * A *request from the kernel* is drawn above the transcript. A run blocked on
 * an approval or a question is doing nothing, visibly, and the reason has to be
 * the first thing on screen rather than the last.
 *
 * A *gap* is shown, because the replay buffer is bounded and a client that fell
 * behind it has a hole in its picture. Silently continuing would render a
 * partial run as a complete one.
 *
 * *Unknown events* are counted and named. The kernel adds frame types faster
 * than this bundle ships, and an event we quietly drop is a change nobody
 * learns about until a user reports that something is missing.
 */
export function RunStreamThread({
  view,
  status,
  retries,
  onReconnect,
  onAnswerInteraction,
}: {
  view: RunView;
  status: RunStreamStatus;
  retries: number;
  onReconnect: () => void;
  /**
   * Answers a request from the kernel. Absent while the control plane has no
   * channel for one — see `RunInteractionPrompt`, which then says so rather
   * than offering a button that cannot work.
   */
  onAnswerInteraction?: (answer: { requestId: string; decision: "allow" | "deny" | "answer"; text?: string }) => Promise<void>;
}) {
  const unknown = Object.entries(view.unknownEvents);
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <StateBadge state={view.state} errorCode={view.errorCode} />
        {view.attempts > 1 ? (
          <span className="text-caption text-muted">第 {view.attempts} 次提交</span>
        ) : null}
        {view.verification ? (
          <span className="text-caption text-muted">核验：{view.verification}</span>
        ) : null}
        {status === "error" ? (
          <button
            type="button"
            onClick={onReconnect}
            className="inline-flex items-center gap-1.5 rounded-input border border-border px-2 py-1 text-caption text-muted hover:text-text"
          >
            <RefreshCw size={12} aria-hidden />
            连接已断开（已重试 {retries} 次），点击重连
          </button>
        ) : null}
      </header>

      {view.missedRange ? (
        <div className="flex items-start gap-2 rounded-card border border-border bg-surface-2 p-3 text-ui-sm text-text" role="status">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <span>
            与服务端的连接中断期间遗漏了第 {view.missedRange.since}–{view.missedRange.resumedAt} 条事件，
            这段过程未显示在下面的记录里。运行本身不受影响。
          </span>
        </div>
      ) : null}

      {/* Above the transcript, not below it: a blocked run is waiting on this
        * and only this, and a person should not have to scroll a long
        * conversation to find out what it is waiting for. */}
      {view.interactions.map((interaction) => (
        <RunInteractionPrompt
          key={interaction.requestId}
          interaction={interaction}
          {...(onAnswerInteraction ? { onAnswer: onAnswerInteraction } : {})}
        />
      ))}

      <BlockList blocks={view.blocks} />

      <RunTree view={view} />

      <footer className="flex flex-wrap gap-4 text-caption text-muted">
        <span>
          步骤 {view.budget.steps}
          {budgetLimit(view.budget.limits, "steps") ? ` / ${budgetLimit(view.budget.limits, "steps")}` : ""}
        </span>
        <span>
          令牌 {view.budget.tokens}
          {budgetLimit(view.budget.limits, "tokens") ? ` / ${budgetLimit(view.budget.limits, "tokens")}` : ""}
        </span>
        {view.evidence.total ? <span>证据 {view.evidence.total} 条</span> : null}
        {unknown.length ? (
          <span title={unknown.map(([name, count]) => `${name} × ${count}`).join("\n")}>
            {unknown.reduce((sum, [, count]) => sum + count, 0)} 条本版本尚不能展示的事件
          </span>
        ) : null}
      </footer>
    </div>
  );
}
