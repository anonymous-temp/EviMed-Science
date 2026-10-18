import { createContext, useContext, useLayoutEffect, useRef } from "react";
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
  /** `useVcrPrimary`'s door; a tab does not call it. */
  setPrimary(primary: StudyPrimary | null): void;
}

/** The one thing a tab asks of the reader next, as the header's primary button (DESIGN.md: the primary action is in the header). */
export interface StudyPrimary {
  label: string;
  onSelect: () => void;
}

export const StudyFrameContext = createContext<StudyFrameApi | null>(null);

/** The frame this component is in, or null outside one. */
export function useStudyFrame(): StudyFrameApi | null {
  return useContext(StudyFrameContext);
}

/**
 * The same door for a page that is not a study: 虚拟临床研究's home, whose libraries (方法库, 试验先例) load their own data and so know
 * their own filters. The page supplies the setter and merges what it is given into its one toolbar, next to its views; a panel calls
 * `useVcrToolbar` exactly as a tab does and draws no `Toolbar` of its own.
 */
export const ToolbarSlotContext = createContext<((toolbar: ToolbarProps | null | undefined) => void) | null>(null);

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
  const frame = useContext(StudyFrameContext)?.setToolbar;
  const slot = useContext(ToolbarSlotContext);
  const set = frame ?? slot;
  useLayoutEffect(() => { set?.(toolbar); });
  useLayoutEffect(() => () => { set?.(undefined); }, [set]);
}


/**
 * The tab's one primary action — 「选定方案」 on 试验 — drawn **in the header's action slot**, where every page's primary is, and not
 * in the toolbar (the walk's `primary-action`: a solid button 144 px down, under the header's row, on the owner's study). The frame
 * draws it as the header's primary and the study's next step beside it as a secondary one, as it does while the budget waits. A tab
 * that has none passes `null`; the button goes when the tab does.
 */
export function useVcrPrimary(primary: StudyPrimary | null): void {
  const set = useContext(StudyFrameContext)?.setPrimary;
  const label = primary?.label ?? null;
  const select = useRef(primary?.onSelect);
  select.current = primary?.onSelect;
  useLayoutEffect(() => {
    set?.(label === null ? null : { label, onSelect: () => select.current?.() });
  }, [set, label]);
  useLayoutEffect(() => () => { set?.(null); }, [set]);
}
