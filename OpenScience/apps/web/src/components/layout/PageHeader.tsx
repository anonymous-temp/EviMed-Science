import { HeaderActions, type PageActionPlan } from "./HeaderActions";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PageTitle } from "@/components/layout/PageTitle";
import { cn } from "@/lib/cn";

/**
 * Component: PageHeader; owner: H; rules: DS22/AT52–AT54.
 * Anatomy: Title, optional metadata/scope and explicit action plan.
 * Variants: Page or serif document title; legacy actions are migration-only.
 * States: Action owner supplies loading, disabled and preference state.
 * Hit area: Shared HeaderActions controls own targets.
 * Keyboard: Native headings, buttons, links and menu behavior.
 * Long content: Planned headers wrap titles and action labels without clipping; legacy titles retain their two-line clamp.
 * Theme: Shared title/text and semantic action roles.
 * Responsive: Full action width and title room determine priority collapse; natural flex wrapping separates rows only when they cannot fit. Layout marker follows actual offsets.
 * Verification: PageShell/HeaderActions tests; DS22.2/AT52; page geometry requires browser evidence.
 */
export function PageHeader({
  title,
  meta,
  actions,
  actionPlan,
  scope,
  titleVariant = "page",
  documentTitle,
  className,
}: {
  title: string;
  /** @deprecated Pages carry no subtitle; ignored. */
  description?: ReactNode;
  /** A grey count or update time after the title (「29 条」「22:40 更新」). */
  meta?: ReactNode;
  /** The page's primary action and at most two icon buttons or a search box. */
  /** @deprecated Migrate to actionPlan; retained only during DS22 caller adoption. */
  actions?: ReactNode;
  actionPlan?: PageActionPlan;
  /** The page's scope after the title: a `ScopeMenu` (whose things the page shows). */
  scope?: ReactNode;
  titleVariant?: "page" | "document";
  /**
   * The browser tab's name, when it should differ from the heading; `false` when the page names its tab elsewhere (a split view, whose
   * list column and open record each draw a header, names its tab once, from the record that is open).
   */
  documentTitle?: string | false;
  className?: string;
}) {
  const header = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [stacked, setStacked] = useState(false);
  const fullActionsWidth = useRef(0);
  const actionLabels = JSON.stringify([actionPlan?.primary?.label, actionPlan?.secondary?.map(action => action.label), actionPlan?.overflowLabel, actionPlan?.overflow?.length]);
  useLayoutEffect(() => { fullActionsWidth.current = 0; setCompact(false); }, [actionLabels]);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element || !actionPlan) return;
    const measure = () => {
      const title = element.querySelector('h1');
      const actions = element.querySelector<HTMLElement>('[data-header-actions]');
      if (!title || !actions || !element.clientWidth) return;
      if (!compact) fullActionsWidth.current = actions.scrollWidth;
      const titleRoom = Math.min(title.scrollWidth, 192);
      const needsOverflow = fullActionsWidth.current + titleRoom + 12 > element.clientWidth;
      // Preserve the focused action node during busy/resize transitions; re-evaluate when focus leaves its group.
      if (!needsOverflow || !actions.contains(document.activeElement)) setCompact(needsOverflow);
      setStacked(actions.offsetTop > title.offsetTop + title.offsetHeight);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const actions = element.querySelector<HTMLElement>('[data-header-actions]');
    if (actions) observer?.observe(actions);
    let live = true;
    const afterFocus = () => queueMicrotask(() => { if (live) measure(); });
    element.addEventListener('focusout', afterFocus);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(() => { if (live) measure(); });
    if (!observer) window.addEventListener('resize', measure);
    return () => { live = false; observer?.disconnect(); element.removeEventListener('focusout', afterFocus); document.fonts?.removeEventListener('loadingdone', measure); if (!observer) window.removeEventListener('resize', measure); };
  }, [actionPlan, compact]);
  return (
    <header ref={header} data-page-header="" data-header-layout={actionPlan ? stacked ? "stacked" : "inline" : undefined} className={cn("flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {documentTitle !== false && <PageTitle page={documentTitle ?? title} />}
      {/* `flex-wrap`: a count or a scope that does not fit beside the title goes under it; the title is never squeezed into two lines to make room. */}
      <div className={cn("flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1", actionPlan ? "basis-auto" : "basis-48")}>
        <h1 className={cn(titleVariant === "document" ? DOCUMENT_TITLE_CLASS : PAGE_TITLE_CLASS, "min-w-0", actionPlan ? "break-words" : "line-clamp-2")}>{title}</h1>
        {meta && <span className="shrink-0 text-caption tabular-nums text-text-3">{meta}</span>}
        {scope && <div className="shrink-0 self-center">{scope}</div>}
      </div>
      {actionPlan ? <div className="min-w-0 max-w-full"><HeaderActions plan={actionPlan} density={compact ? "compact" : "full"} /></div> : actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The class every page H1 wears, for the few that cannot use `PageHeader`. */
export const PAGE_TITLE_CLASS = "text-title font-semibold text-text";

/** The serif title of a document: an evidence card, an event, a report. */
export const DOCUMENT_TITLE_CLASS = "text-doc-title font-semibold text-text";
