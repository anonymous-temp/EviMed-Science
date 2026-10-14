import { createContext, useContext, useLayoutEffect } from "react";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import type { VcrActivity } from "@/lib/vcrClient";

/** The panels of the page that a tab may ask the frame to open: the header menu's records and dialogs. */
export type StudyPanelKey = "intake" | "budget" | "changes" | "export" | "runs";

/**
 * What the study's frame gives the tab it holds (R19, plan §5.3; `StudyFrame.tsx`).
 *
 * A tab is a child of the frame and cannot hand it props, so what it needs of the page around it — to read the study again, to open
 * the conversation, to put its controls in the sticky band — is this context. Every member is optional in effect: a tab rendered on
 * its own (a test, a gallery) finds `null` and the hooks below do nothing, which is also what they must do.
 */
export interface StudyFrameApi {
  studyId: string;
  /**
   * What the tabs depend on, as one string (`studyVersion`): it changes when a step's state, an engine job's state or the study's
   * own update moves, and when a run has just ended. A tab reads its route again when it does; `useVcrLoad` does that by itself for
   * every study-scoped read.
   */
  version: string;
  /** What the study is doing now, as the last read said it; null when nothing is. */
  activity: VcrActivity | null;
  /** Read the study again now — after a start, a cancel, an edit that moves the header, the dots or the notes. */
  refresh(): void;
  /**
   * Open the study's conversation, in this page. A `draft` waits in the composer and is never sent (plan §9.2: no form). Never
   * `/app/chat`: the conversation is a view of the study page, with the step bar still above it.
   */
  openChat(draft?: string): void;
  /** Open one of the page's own panels over the tab: the data intake, the budget, the change log, the export choice, the AI runs. */
  openPanel(panel: StudyPanelKey): void;
  /** `useVcrToolbar`'s door; a tab does not call it. */
  setToolbar(toolbar: ToolbarProps | null | undefined): void;
}

export const StudyFrameContext = createContext<StudyFrameApi | null>(null);

/** The frame this component is in, or null outside one. */
export function useStudyFrame(): StudyFrameApi | null {
  return useContext(StudyFrameContext);
}

/**
 * The tab's one row of controls — its filters, its search, its count, its buttons — drawn **in the sticky band, above the body**:
 * the frame renders it as `PageShell`'s `toolbar` slot, so it neither scrolls away nor sinks (DESIGN.md rule 7). A tab calls this
 * and does not render a `Toolbar` of its own; a tab that calls nothing leaves its row reserved and empty, so the band's height is
 * the same on every tab.
 *
 * `toolbar.views` is not for a tab: the study's tabs are the one row of views, and a second one is a defect. A tab's own views
 * (an object switch — 方案 · 访视 · 监管) are a `filters` entry of kind `chips`.
 *
 * The object is read on every render, so its handlers are always this render's; it is cheap to build, and the frame does not
 * re-render the tab for it.
 */
export function useVcrToolbar(toolbar: ToolbarProps | null): void {
  const set = useContext(StudyFrameContext)?.setToolbar;
  useLayoutEffect(() => { set?.(toolbar); });
  useLayoutEffect(() => () => { set?.(undefined); }, [set]);
}
