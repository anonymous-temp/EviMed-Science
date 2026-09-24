import { useRef, type KeyboardEvent } from "react";
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
 */
export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  /** A count after the label, when the view's size is the point (「未读 2」). */
  count?: number;
}

export function Tabs<V extends string>({
  label,
  items,
  value,
  onChange,
  panelId,
  className,
}: {
  /** The tab list's accessible name. */
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  panelId?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
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
  return (
    <div role="tablist" aria-label={label} className={cn("flex items-end gap-6 border-b border-border", className)}>
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
              "-mb-px inline-flex h-10 items-center gap-1 border-b-2 text-ui outline-none transition-colors duration-fast",
              selected ? "border-text font-medium text-text" : "border-transparent text-text-3 hover:text-text",
            )}
          >
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-text-3">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
