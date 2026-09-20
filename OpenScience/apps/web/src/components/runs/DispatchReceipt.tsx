import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { MessageSquare, Square, X } from "lucide-react";
import { cancelWebAgentRun, webErrorMessage, type WebAgentRun, type WebResearchAgent } from "@/lib/apiClient";
import { rerouteRun, routeLineOf, type DispatchTarget } from "@/lib/dispatch";
import { chatPath } from "@/lib/runLocation";
import { announceRunsChanged, runState, runTitle } from "@/lib/runPresentation";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RouteLine } from "@/components/runs/RouteLine";
import { RunStatusDot } from "@/components/runs/RunStatusDot";

/**
 * What the shell shows the moment it starts a run: that it started, the route
 * line with the change offered, and the two ways on — open the conversation,
 * or stop it.
 *
 * The change is offered here and nowhere later. Right after a dispatch it
 * costs a few seconds of work to stop the run and start the same question on
 * another line; on a run that has been going for twenty minutes the same
 * button would throw those twenty minutes away, and stopping it is then done
 * from the conversation itself or from the menu on its sidebar row.
 */
export function DispatchReceipt({
  run: initialRun,
  question,
  catalog,
  onDismiss,
}: {
  run: WebAgentRun;
  /** The question as the researcher sent it; a change of line re-sends it. */
  question: string;
  catalog: ReadonlyArray<WebResearchAgent>;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const [run, setRun] = useState(initialRun);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setRun(initialRun);
    setNotice(null);
    setFailure(null);
  }, [initialRun]);

  // Focus moves to the receipt, so a keyboard or screen-reader user lands on
  // what just happened instead of on the button that caused it.
  useEffect(() => {
    headingRef.current?.focus();
  }, [initialRun.id]);

  const reroute = async (target: DispatchTarget, label: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await rerouteRun(run, target, question);
      setRun(next);
      // 普通问答 is a request to the router, not a binding: the control plane
      // has no binding for the answer line that the shell can name (its
      // version is not in the catalogue). When the router still claims the
      // question for a capability, say so rather than claim the change.
      const landed = routeLineOf(next, catalog);
      setNotice(
        target.kind === "open-domain" && !landed.answerLine
          ? `已重新提交，但路由判断这个问题仍需要「${landed.label}」；原来那次研究已停止。只想要简短回答的话，可以在对话里直接问。`
          : `已改为按「${label}」处理；原来那次研究已停止。`,
      );
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "没能改用其他工具，原来那次研究仍在进行。" }));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setConfirmingCancel(false);
    setBusy(true);
    setFailure(null);
    try {
      setRun(await cancelWebAgentRun(run.id));
      announceRunsChanged();
      setNotice("已停止这次研究。");
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "没能停止，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  const running = run.status === "running";
  const state = runState(run);

  return (
    <section aria-labelledby={`receipt-${run.id}`} className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <RunStatusDot state={state.key} className="mt-1.5" labelled />
        <div className="min-w-0 flex-1">
          <h2
            id={`receipt-${run.id}`}
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-ui font-semibold text-text outline-none"
          >
            {running ? "已开始" : state.label}：{runTitle(run)}
          </h2>
          <RouteLine
            run={run}
            catalog={catalog}
            onReroute={running ? (target, label) => void reroute(target, label) : undefined}
            busy={busy}
            className="mt-1.5"
          />
          <p role="status" className="mt-1 text-caption text-muted">
            {notice ?? (running ? "可以离开这个页面；做完后收件箱会通知你。" : "")}
          </p>
          {failure && <p role="alert" className="mt-1 text-caption text-error">{failure}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {/* One way on, not two. 「查看进度」 opened the run ledger beside
              * the conversation that already shows the same progress; the
              * ledger page was deleted on 2026-09-20. */}
            <Button size="sm" onClick={() => navigate(chatPath(run.sessionId))}>
              <MessageSquare size={14} aria-hidden="true" />打开对话
            </Button>
            {running && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingCancel(true)}>
                <Square size={14} aria-hidden="true" />停止
              </Button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="收起这条提示"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted hover:bg-surface-2 hover:text-text"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {confirmingCancel && (
        <ConfirmDialog
          title="停止这次研究？"
          body="已经做完的检索和写好的文件会留在工作区，但这次研究不会再继续。"
          confirmLabel="停止"
          onConfirm={() => void cancel()}
          onCancel={() => setConfirmingCancel(false)}
        />
      )}
    </section>
  );
}
