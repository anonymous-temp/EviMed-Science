import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useNarrow } from "@/lib/useMediaQuery";
import { FilterChip } from "@/components/ui/FilterChips";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { RAIL_STATE_WORDS, RailMark, type RailState } from "@/components/ui/ProgressRail";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * A module's steps as one row, at the top of every tab and sticky with them (R19, plan §2.2 rule 2; D C1d).
 *
 * `ProgressRail` is the same program drawn as a card with a line under each step; it lived on one tab (「总览」) and scrolled
 * away, so on the other six the person could not see which step the program was on — or that switching a tab made the rail
 * disappear and the page jump. `StepRail` is its compact sibling and uses its marks: a dot and a name per step, the state as a
 * glyph, as a word in a tooltip and for a screen reader. What a step produced (`summary`) is in the tooltip.
 * A visible rail with measured overflow adds a named all-steps menu and gives trailing status its own wrapping row.
 *
 *  - A step's click goes to its home: `href` (a link) or `onSelect`.
 *  - `activeSteps` underlines the steps the open tab is built from, in the accent (the geo's 「行动」 tab is made of the content
 *    and the delivery steps; the tab bar below says which tab, the rail says which steps).
 *  - `trailing` is the program's 「现在」 sentence at the right end: 「第 3 轮复测中」, 「下一批为 4 个问题群写稿（周一）」.
 *  - Under 640 px the row folds to 「已完成 7/8 步 ▾」, a chip that opens the steps as a menu, with the 「现在」 sentence after it on
 *    the one line (cut where it does not fit); the row's height does not change.
 *
 * `data-step-rail` is what the walk and `pageComposition.test.tsx` read: it must be present, with the same step count, on
 * every tab of a module.
 */
export interface StepRailStep {
  id: string;
  label: string;
  state: RailState;
  /** What the step produced, in the reader's words (「86 条事实」): the tooltip, never a second line. */
  summary?: string | null;
  /** A precise status supplied by the workflow, including unrequested steps. */
  stateLabel?: string;
  /** The step's home: a route… */
  href?: string;
  /** …or a handler (a tab switch on the same route). */
  onSelect?: () => void;
}

export interface StepRailProps {
  /** The rail's accessible name (「进度」). */
  label: string;
  steps: readonly StepRailStep[];
  /** The ids of the steps the open tab is built from. */
  activeSteps?: readonly string[];
  /** The program's 「现在」 sentence, at the right end. */
  trailing?: ReactNode;
  className?: string;
  /** Keep the reachable step row on narrow screens. */
  visible?: boolean;
  /** Show status words alongside the marks. */
  showState?: boolean;
}

/**
 * Component: StepRail; owner: H; rules: DS21, DS22.3/AT53, DESIGN.md component adoption.
 * Anatomy: Named ordered step navigation with marks, state words and optional trailing fact.
 * Variants: visible/showState; default narrow Menu fallback.
 * States: activeSteps denotes current scope independently of supplied state.
 * Hit area: 40px row or 56px with state; shared menu chip on narrow view.
 * Keyboard: Native links/buttons; narrow Menu owns arrows/Escape.
 * Long content: Expanded rail scrolls horizontally; overflow status wraps in its own row; Tooltip exposes summary.
 * Theme: Success/info/warn marks; accent current-step rule.
 * Responsive: Narrow default uses Menu; visible rails disclose all steps only on measured overflow, scroll current step into view and give trailing status its own wrapping row.
 * Verification: StepRail.test.tsx and Composition.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function StepRail({ label, steps, activeSteps = [], trailing, className, visible = false, showState = false }: StepRailProps) {
  const narrow = useNarrow();
  const list = useRef<HTMLOListElement>(null);
  const [overflow, setOverflow] = useState(false);
  const failedAt = useRef(0);
  const previousWidth = useRef(0);
  const previousActive = useRef('');
  const activeKey = JSON.stringify(activeSteps);
  const stepKey = JSON.stringify(steps.map(step => [step.id, step.label, step.stateLabel, showState ? step.state : null]));
  const lastSteps = useRef(stepKey);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const parentWidth = element.parentElement?.clientWidth ?? element.clientWidth;
      if (lastSteps.current !== stepKey) { lastSteps.current = stepKey; failedAt.current = 0; }
      // The disclosure moves status onto another row and changes OL width. Only parent growth retries the inline layout.
      if (!overflow && element.scrollWidth > element.clientWidth + 1) { failedAt.current = parentWidth; setOverflow(true); }
      else if (overflow && parentWidth > failedAt.current + 8) setOverflow(false);
      const alignCurrent = previousActive.current !== activeKey || previousWidth.current === 0 || element.clientWidth < previousWidth.current;
      previousActive.current = activeKey;
      previousWidth.current = element.clientWidth;
      const active = element.querySelector<HTMLElement>('[aria-current="step"]');
      if (active && alignCurrent) {
        const left = active.offsetLeft - element.offsetLeft;
        if (left < element.scrollLeft) element.scrollLeft = left;
        else if (left + active.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollLeft = left + active.offsetWidth - element.clientWidth;
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.parentElement) observer?.observe(element.parentElement);
    if (!observer) window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); if (!observer) window.removeEventListener('resize', measure); };
  }, [stepKey, activeKey, narrow, visible, overflow]);
  const entries: MenuEntry[] = steps.map(step => ({
    label: `${step.label} · ${step.stateLabel ?? RAIL_STATE_WORDS[step.state]}`,
    checked: activeSteps.includes(step.id),
    to: step.href,
    disabled: !step.href && !step.onSelect,
    onSelect: () => step.onSelect?.(),
  }));
  const done = steps.filter((step) => step.state === "done").length;

  if (narrow && !visible) {
    return (
      <nav data-step-rail="" aria-label={label} className={cn("flex h-10 items-center gap-2", className)}>
        <Menu label={label} align="start" items={entries}>
          <FilterChip menu className="-ml-3 shrink-0" aria-label={`${label}：已完成 ${done}/${steps.length} 步`}>{`已完成 ${done}/${steps.length} 步`}</FilterChip>
        </Menu>
        {/* The program's 「现在」 has the room the steps gave up: one line, cut at the edge where it is longer. */}
        {trailing && <span className="min-w-0 flex-1 truncate text-caption text-text-3">{trailing}</span>}
      </nav>
    );
  }

  return (
    <nav data-step-rail="" aria-label={label} className={cn("flex min-w-0 items-stretch gap-x-4", overflow ? "flex-wrap" : showState ? "h-14" : "h-10", className)}>
      <ol ref={list} className={cn("flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto", showState ? "min-h-14" : "min-h-10")}>
        {steps.map((step) => {
          const active = activeSteps.includes(step.id);
          const body = (
            <>
              <RailMark state={step.state} />
              <span className="whitespace-nowrap">
                {step.label}
                <span className={showState ? "block text-caption text-text-3" : "sr-only"}>{showState ? (step.stateLabel ?? RAIL_STATE_WORDS[step.state]) : `，${step.stateLabel ?? RAIL_STATE_WORDS[step.state]}`}</span>
              </span>
            </>
          );
          // The one look of the tab row beneath it (`Tabs`: 40 high, 14 / 400, square): the step the open tab is built from is told by its
          // rule and its colour, never by a weight or a corner of its own — a rail and a tab row that differ in how they are drawn are two
          // kinds of control on every module page, for the one job of saying where the person is.
          const look = cn(
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-none border-b-2 px-2 text-ui font-normal outline-none transition-colors duration-fast",
            active ? "border-accent text-text" : cn("border-transparent", step.state === "todo" ? "text-text-3" : "text-text-2"),
          );
          const tip = `${step.stateLabel ?? RAIL_STATE_WORDS[step.state]}${step.summary ? `：${step.summary}` : ""}`;
          const control = step.href ? (
            <Link to={step.href} onClick={step.onSelect} aria-current={active ? "step" : undefined} className={cn(look, "hover:bg-surface-2 hover:text-text")}>{body}</Link>
          ) : step.onSelect ? (
            <button type="button" onClick={step.onSelect} aria-current={active ? "step" : undefined} className={cn(look, "hover:bg-surface-2 hover:text-text")}>{body}</button>
          ) : (
            <span aria-current={active ? "step" : undefined} className={look}>{body}</span>
          );
          return (
            <li key={step.id} data-rail-step={step.id} data-rail-state={step.state} className="flex shrink-0">
              <Tooltip content={tip}>{control}</Tooltip>
            </li>
          );
        })}
      </ol>
      {overflow && <Menu label="全部步骤" align="end" items={entries}><FilterChip menu className="self-center">全部步骤</FilterChip></Menu>}
      {trailing && <span className={cn("min-w-0 self-center text-caption text-text-3", overflow ? "w-full py-1 whitespace-normal break-words" : "shrink truncate")}>{trailing}</span>}
    </nav>
  );
}
