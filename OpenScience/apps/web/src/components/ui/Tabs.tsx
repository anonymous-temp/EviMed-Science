import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Component: Tabs; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: underlined scrolling tablist with optional trailing actions.
 * Variants: automatic or manual activation; semantic stage dots.
 * States: selection and stage state remain independent.
 * Hit area: 40px row buttons.
 * Keyboard: arrows/Home/End focus; manual Enter/Space activates.
 * Long content: horizontal scroll retains full labels.
 * Theme: semantic text and independent status tokens.
 * Responsive: overflow scroll with edge fade.
 * Verification: Tabs.test.tsx; keyboard/browser/AT remain separate.
 */
export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  /** A count after the label, when the view's size is the point (「未读 2」). */
  count?: number;
  /** A status dot before the label, when each view is a stage with a state (a study's tabs). */
  dot?: TabDot;
  /**
   * What the stage found, after the label (「3,412 名」): one short phrase, one number — a module's step bar says where each stage
   * stands without opening it. Read out with the label; never a sentence.
   */
  note?: string;
  /** The state in words, as a tooltip over the whole tab (「进行中：构建人群」): the legend of the dot, for a pointer and a keyboard. */
  hint?: string;
}

/**
 * The state a tab's dot says, three ways — shape, colour and words (spec: every status is said three times): `done` a filled green
 * circle, `active` a navy information ring (work under way, and only that), `partial` the same ring with a pale information fill (some of the stage is
 * done and nothing is running now), `attention` an amber diamond (stale, or not finished), `todo` a small grey dot.
 */
export type TabDot = "done" | "active" | "partial" | "attention" | "todo";

export const DOT_WORDS: Record<TabDot, string> = { done: "已完成", active: "进行中", partial: "部分完成", attention: "需要留意", todo: "未开始" };

const DOT_CLASSES: Record<TabDot, string> = {
  done: "h-2 w-2 rounded-full bg-ok",
  active: "h-2 w-2 rounded-full bg-surface ring-2 ring-info",
  partial: "h-2 w-2 rounded-full bg-info-soft ring-2 ring-info",
  attention: "h-2 w-2 rotate-45 bg-warn",
  todo: "h-1.5 w-1.5 rounded-full bg-surface-2 ring-1 ring-border-control",
};

/**
 * A tab row wider than its box (a phone shows four of seven) fades out at the
 * end that still has tabs, so the one cut in half reads as a row that scrolls
 * and not as a label that was clipped. A mask, not an overlay: it needs to know
 * no ground colour, so the row can sit on the page, a card or a drawer.
 */
const END_FADE = "linear-gradient(to right, black calc(100% - 2rem), transparent)";
const FADED: CSSProperties = { maskImage: END_FADE, WebkitMaskImage: END_FADE };

export function Tabs<V extends string>({
  label,
  items,
  value,
  onChange,
  panelId,
  trailing,
  activation = "automatic",
  className,
  animatedIndicator = false,
}: {
  /** The tab list's accessible name. */
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  panelId?: string;
  activation?: "automatic" | "manual";
  /** Controls at the row's end; they sit on the same hairline as the tabs. */
  trailing?: ReactNode;
  className?: string;
  /** One moving accent underline; the standard page tabs keep their static rule. */
  animatedIndicator?: boolean;
}) {
  const [focused, setFocused] = useState(value);
  useLayoutEffect(() => { setFocused(value); }, [value]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // True while the row has tabs scrolled out of sight at its end.
  const [moreAhead, setMoreAhead] = useState(false);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => setMoreAhead(list.scrollWidth - list.clientWidth - list.scrollLeft > 1);
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(list);
    for (const child of Array.from(list.children)) observer?.observe(child);
    return () => {
      list.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [items.length]);
  // The tab that is open is always whole: a row wider than its box is scrolled to it when the open view changes and on arrival
  // (a phone showed 「对照」 cut in half) — and only then: a reader who swiped the row away keeps it where it is while the page
  // re-renders. Only the row scrolls sideways, never the page, which `scrollIntoView` would also move. Clear of the fade that marks
  // more tabs ahead (2 rem), unless the open tab is the last and nothing is ahead.
  const current = useRef(items);
  current.current = items;
  useLayoutEffect(() => {
    const list = listRef.current;
    const all = current.current;
    const at = all.findIndex((item) => item.value === value);
    const tab = refs.current[at];
    if (!list || !tab) return;
    const row = list.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    const end = row.right - (at === all.length - 1 ? 0 : 32);
    const delta = box.left < row.left ? box.left - row.left : box.right > end ? box.right - end : 0;
    if (delta !== 0) list.scrollBy?.({ left: delta });
  }, [value]);
  useLayoutEffect(() => {
    if (!animatedIndicator) {
      setIndicator(null);
      return undefined;
    }
    const list = listRef.current;
    const tab = refs.current[items.findIndex((item) => item.value === value)];
    if (!list || !tab) {
      setIndicator(null);
      return undefined;
    }
    const measure = () => {
      const row = list.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      const left = box.left - row.left + list.scrollLeft;
      const width = box.width;
      setIndicator((previous) => previous?.left === left && previous.width === width ? previous : { left, width });
    };
    // The first rule is mounted at its measured destination before paint. Later selections move that same rule.
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(list);
    for (const button of refs.current) if (button) observer?.observe(button);
    window.addEventListener("resize", measure);
    return () => {
      list.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [animatedIndicator, items, value]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = items.some(item => item.value === value) || activation === "manual" ? refs.current.indexOf(event.currentTarget) : -1;
    if (!items.length) return;
    const next = event.key === "ArrowRight" ? (at + 1) % items.length
      : event.key === "ArrowLeft" ? (at - 1 + items.length) % items.length
        : event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    if (activation === "automatic") onChange(items[next].value);
    refs.current[next]?.focus();
  };
  // A view that is not one of the tabs (a study's conversation, which is a view of the page and not a tab) leaves none selected: the
  // first one stays in the tab order, so the row can be reached from the keyboard.
  const anyFocused = items.some((item) => item.value === focused);
  const anySelected = items.some((item) => item.value === value);
  const list = (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      style={moreAhead ? FADED : undefined}
      className={cn(
        // `scroll-px-6`: a tab brought into view by the keyboard stops short of the edge, not under the fade.
        "flex min-w-0 scroll-px-6 items-end gap-6 overflow-x-auto overflow-y-hidden border-b border-border",
        animatedIndicator && "relative",
        // With controls beside it the hairline belongs to the row, from `sm` up.
        trailing && "sm:flex-1 sm:border-b-0",
        !trailing && className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        const tab = (
          <button
            key={item.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            id={panelId ? `${panelId}-tab-${item.value}` : undefined}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={item.value === focused || (!anyFocused && index === 0) ? 0 : -1}
            onFocus={() => {
              setFocused(item.value);
              const list = listRef.current, tab = refs.current[index];
              if (!list || !tab) return;
              const row = list.getBoundingClientRect(), box = tab.getBoundingClientRect();
              const end = row.right - (index === items.length - 1 ? 0 : 32);
              const delta = box.left < row.left ? box.left - row.left : box.right > end ? box.right - end : 0;
              if (delta) list.scrollBy?.({ left: delta });
            }}
            onClick={() => onChange(item.value)}
            onKeyDown={onKeyDown}
            className={cn(
              // Keep the full button inside the x-scroller: a negative bottom margin creates a one-pixel vertical scrollbar on Windows.
              // One weight for every tab: the selected one is told by its
              // colour and its rule, so a tab list is one kind of control.
              "inline-flex h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded-none border-b-2 text-ui font-normal outline-none transition-colors duration-fast focus-visible:outline-focus",
              selected ? animatedIndicator ? "border-transparent text-accent" : "border-text text-text" : "border-transparent text-text-3 hover:text-text",
            )}
          >
            {/* `mx-0.5`: the ring is a 2 px shadow outside the dot, and the row clips what overflows it — on the first tab it was cut in half. */}
            {item.dot && <span aria-hidden="true" data-tab-dot={item.dot} data-forced-colors="preserve" className={cn("mx-0.5 inline-block shrink-0", DOT_CLASSES[item.dot])} />}
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-text-3">{item.count}</span>}
            {item.note && <span data-tab-note="" className="ml-0.5 text-caption font-normal tabular-nums text-text-3">{item.note}</span>}
            {/* The state in words, after the name: a screen reader hears 「试验 进行中」, and the dot's shape and colour are not the only way to know. */}
            {item.dot && <span className="sr-only">{DOT_WORDS[item.dot]}</span>}
          </button>
        );
        return item.hint ? <Tooltip key={item.value} content={item.hint}>{tab}</Tooltip> : tab;
      })}
      {animatedIndicator && anySelected && indicator && (
        <span
          aria-hidden="true"
          data-tab-indicator=""
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-accent transition-all duration-base ease-standard motion-reduce:transition-none"
          style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
        />
      )}
    </div>
  );
  if (!trailing) return list;
  return (
    <div className={cn("flex flex-col sm:flex-row sm:items-end sm:gap-4 sm:border-b sm:border-border", className)}>
      {list}
      <div className="flex shrink-0 flex-wrap items-center gap-1 py-1.5 sm:pb-1.5 sm:pt-0">{trailing}</div>
    </div>
  );
}
