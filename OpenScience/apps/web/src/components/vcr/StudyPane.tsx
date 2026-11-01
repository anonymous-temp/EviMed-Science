import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFitToScroller } from "@/components/workspace/WorkspaceSplit";
import { Loader2, MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { StepState } from "@/components/ui/StepState";
import { STOP_STUDY_LABEL } from "./vcrActionWords";
import { useProjectStore } from "@/lib/projects";
import { registerTaskPane } from "@/lib/taskPane";
import type { VcrStudy } from "@/lib/vcrClient";
import { runDetailLine } from "./vcrActivity";

/** The least a conversation is given: below it the page scrolls rather than squeezing the kernel's composer. */
const MIN_PANE_PX = 360;
/** How long a study without a conversation is waited for before the pane says so. */
const PREPARING_MS = 20_000;

/**
 * The study's conversation, as a view of the study's page (R19, plan §5.3; audit B §4.6): one study is one project is one
 * conversation, and the step bar stays above it.
 *
 * The page cannot render the kernel's conversation — an iframe, a websocket and a handshake that moving in the tree would reload
 * (`SessionFrameHost` explains) — so this is an empty box and a request: where the shell's one resident frame is to be placed
 * (`registerTaskPane`, the scheduled-task page's mechanism, generalised), and which conversation. Switching to a tab and back is a
 * move of the box and never of the frame's place in the tree, so the conversation is not reloaded and a half-written message is
 * still in its composer.
 *
 * What it says instead, when there is no conversation to place (never as an alert, and never in a card):
 *  - **a step holds the project's runtime** (`activity.run.locked`: a step the programme started on its own, in a bounded runtime):
 *    the run's progress, and that the conversation continues when it ends — the page moves to it by itself, because the study is
 *    read again while the run goes on;
 *  - **the study has no conversation yet** (`conversation.sessionId` null: the kernel could not open a runtime for it when it was
 *    made, and every read of the study tries again): a wait, and after a while 「重试」;
 *  - **the project is not the reader's** (another member of the study; the shell cannot move to it): that the conversation is the
 *    lead's, and the tabs are still theirs.
 */
export function StudyPane({ study, unreachable, onRetry, onStop }: {
  study: VcrStudy;
  /** The shell could not move to the study's project: it is another account's. */
  unreachable: boolean;
  onRetry: () => void;
  /** Stops the run that holds the conversation (the strip's 取消). */
  onStop?: () => void;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const currentId = useProjectStore((state) => state.currentId);
  const run = study.activity?.run ?? null;
  const locked = Boolean(run?.locked);
  const sessionId = study.conversation.sessionId;
  const placed = Boolean(sessionId) && !locked && !unreachable;

  // A conversation the study should have and has not: waited for a while, then offered 重试.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (sessionId || locked || unreachable) return undefined;
    const timer = setTimeout(() => setWaited(true), PREPARING_MS);
    return () => clearTimeout(timer);
  }, [sessionId, locked, unreachable]);

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !placed || !sessionId) return undefined;
    return registerTaskPane({ element, projectId: study.projectId, sessionId });
  }, [placed, sessionId, study.projectId]);
  useFitToScroller(pane, placed, MIN_PANE_PX);

  if (placed) {
    return (
      <div ref={pane} role="region" aria-label="研究对话" data-study-pane="conversation" className="relative">
        {/* Under the frame, which covers it as soon as the shell is in the study's project. */}
        {currentId !== study.projectId && (
          <p role="status" className="flex items-center justify-center gap-2 py-12 text-ui text-text-3">
            <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在打开对话
          </p>
        )}
      </div>
    );
  }

  if (unreachable) {
    return (
      <div role="region" aria-label="研究对话" data-study-pane="unreachable">
        <EmptyState icon={MessageSquare} title="这项研究的对话在负责人的项目里" reason="各页签里的内容仍可以查看和处理。" />
      </div>
    );
  }

  if (locked && run) {
    const detail = runDetailLine(run);
    return (
      <div role="region" aria-label="研究对话" data-study-pane="progress" className="mx-auto flex max-w-measure flex-col items-center gap-1 py-10">
        <StepState phase="running" step={run.label || "推进研究"} phaseName={detail || undefined} startedAt={run.startedAt} onStop={onStop} stopLabel={STOP_STUDY_LABEL} />
        <p className="text-caption text-text-3">结束后可以在这里继续</p>
      </div>
    );
  }

  return (
    <div role="region" aria-label="研究对话" data-study-pane="preparing">
      {waited ? (
        <EmptyState
          icon={MessageSquare}
          title="对话暂时打不开"
          action={<Button variant="secondary" onClick={onRetry}>重试</Button>}
        />
      ) : (
        <p role="status" className="flex items-center justify-center gap-2 py-12 text-ui text-text-3">
          <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          正在准备对话
        </p>
      )}
    </div>
  );
}
