import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A page's views: one row of underlined tabs over a hairline (2026-09-23 plan
 * §4). The one way a page switches between views of itself — the frontier's
 * 精选 / 热榜 / 日报 / 全部 / 与我相关 — where there used to be five kinds:
 * segmented controls, pill groups, underlined tabs and eight mini segments in
 * the file viewers (inventory §2.4).
 *
 * A tab list: arrow keys move between tabs and select them, Home and End
 * jump; only the selected tab is in the tab order. The panel is the page's
 * own content below, labelled by the selected tab when `panelId` is given.
 * A row too wide for its box scrolls sideways and fades at the end that has
 * more tabs.
 */
export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  /** A count after the label, when the view's size is the point (「未读 2」). */
  count?: number;
  /** A status dot before the label, when each view is a stage with a state (a study's tabs). */
  dot?: TabDot;
}

/**
 * The state a tab's dot says, three ways — shape, colour and words (spec: every status is said three times): `done` a filled blue
 * circle, `active` a blue ring (work under way, and only that), `partial` the same ring with a pale blue fill (some of the stage is
 * done and nothing is running now), `attention` an amber diamond (stale, or not finished), `todo` a small grey dot.
 */
export type TabDot = "done" | "active" | "partial" | "attention" | "todo";

const DOT_WORDS: Record<TabDot, string> = { done: "已完成", active: "进行中", partial: "部分完成", attention: "需要留意", todo: "未开始" };

const DOT_CLASSES: Record<TabDot, string> = {
  done: "h-2 w-2 rounded-full bg-accent",
  active: "h-2 w-2 rounded-full bg-surface ring-2 ring-accent",
  partial: "h-2 w-2 rounded-full bg-accent-soft ring-2 ring-accent",
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
  className,
}: {
  /** The tab list's accessible name. */
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  panelId?: string;
  /** Controls at the row's end; they sit on the same hairline as the tabs. */
  trailing?: ReactNode;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // True while the row has tabs scrolled out of sight at its end.
  const [moreAhead, setMoreAhead] = useState(false);
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
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = items.findIndex((item) => item.value === value);
    const next = event.key === "ArrowRight" ? (at + 1) % items.length
      : event.key === "ArrowLeft" ? (at - 1 + items.length) % items.length
        : event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  const list = (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      style={moreAhead ? FADED : undefined}
      className={cn(
        // `scroll-px-6`: a tab brought into view by the keyboard stops short of the edge, not under the fade.
        "flex min-w-0 scroll-px-6 items-end gap-6 overflow-x-auto border-b border-border",
        // With controls beside it the hairline belongs to the row, from `sm` up.
        trailing && "sm:flex-1 sm:border-b-0",
        !trailing && className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            id={panelId ? `${panelId}-tab-${item.value}` : undefined}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={onKeyDown}
            className={cn(
              // One weight for every tab: the selected one is told by its
              // colour and its rule, so a tab list is one kind of control.
              "-mb-px inline-flex h-10 shrink-0 items-center gap-1 whitespace-nowrap border-b-2 text-ui font-medium outline-none transition-colors duration-fast focus-visible:outline-focus",
              selected ? "border-text text-text" : "border-transparent text-text-3 hover:text-text",
            )}
          >
            {item.dot && <span aria-hidden="true" data-tab-dot={item.dot} data-forced-colors="preserve" className={cn("mr-0.5 inline-block shrink-0", DOT_CLASSES[item.dot])} />}
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-text-3">{item.count}</span>}
            {/* The state in words, after the name: a screen reader hears 「试验 进行中」, and the dot's shape and colour are not the only way to know. */}
            {item.dot && <span className="sr-only">{DOT_WORDS[item.dot]}</span>}
          </button>
        );
      })}
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
