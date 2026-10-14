import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { StepState } from "@/components/ui/StepState";
import { useProjectStore } from "@/lib/projects";
import { registerTaskPane } from "@/lib/taskPane";
import type { VcrStudy } from "@/lib/vcrClient";
import { phaseWord, runCountsLine } from "./vcrActivity";

/** The least a conversation is given: below it the page scrolls rather than squeezing the kernel's composer. */
const MIN_PANE_PX = 360;
/** The page's own bottom padding (`py-6`), kept under the pane. */
const BOTTOM_PX = 24;
/** How long a study without a conversation is waited for before the pane says so. */
const PREPARING_MS = 20_000;

/** The nearest ancestor that scrolls: `PageShell`'s container, which is where the pane has to fit. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return document.documentElement;
}

/**
 * Make the pane the rest of the page: its height is what is left of the scroll container below its own top — under the header and the
 * sticky band, whatever height those have just now. The kernel's conversation is an application with its own scroll and composer; it
 * needs a box with a height, not a column that grows, and a page that scrolls under a band while a frame sits over it is the one thing
 * the pane must never be.
 */
function useFillViewport(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    const scroller = scrollParent(element);
    const fit = () => {
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      element.style.height = `${Math.max(MIN_PANE_PX, Math.floor(scroller.clientHeight - top - BOTTOM_PX))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(scroller);
    // The header may wrap and the band gain a strip: both move the pane's top.
    for (const part of scroller.querySelectorAll("[data-page-header], [data-page-chrome]")) observer?.observe(part);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, enabled]);
}

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
  useFillViewport(pane, placed);

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
    const detail = [phaseWord(run.phase), runCountsLine(run.counts)].filter(Boolean).join(" · ");
    return (
      <div role="region" aria-label="研究对话" data-study-pane="progress" className="mx-auto flex max-w-measure flex-col items-center gap-1 py-10">
        <StepState phase="running" step={run.label || "推进研究"} phaseName={detail || undefined} startedAt={run.startedAt} onStop={onStop} />
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
