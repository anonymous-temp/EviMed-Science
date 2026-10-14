import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, ListTree } from "lucide-react";
import { cn } from "@/lib/cn";
import { STICKY_BELOW_BAND, STICKY_COLUMN_MAX_HEIGHT } from "@/components/layout/chrome";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * A long page's table of contents (R19, plan §2.1 T5; extracted from `ReportReader`, which was the one page that had one while
 * an evidence card ran 40,000 px with an `[n]` anchor and nothing else).
 *
 * Two parts, because the page and the contents are two things:
 *
 *  - `useOutline` reads the headings the page actually rendered (`h2`, `h3` inside the container), gives each an id, and follows
 *    which one is being read — so the contents always match what is on screen whatever the Markdown or the blocks looked like;
 *  - `Outline` draws them: a column that stays beside the body while it scrolls (`layout="column"`, from `lg`), or a folded
 *    「目录 · N 节」 above it (`layout="folded"`, on a narrow page or in a pane). A page holds one of them, never both, so the
 *    caller chooses with `useWide()`.
 *
 * The column sticks below the page's sticky band: `PageShell` publishes the band's height as `--page-chrome-h`, and the offset
 * adds a rem to it (0 where there is no band, which is what the report page has). A page of four sections or more has an
 * outline — the walk fails a long page without a `data-outline`.
 */
export interface OutlineEntry {
  id: string;
  text: string;
  /** `h2` is a section, `h3` a part of one (indented). */
  level: 2 | 3;
}

/** How many times `values` changed identity since the last render: a dependency list a hook can take as one number. */
function useChanged(values: readonly unknown[]): number {
  const last = useRef(values);
  const count = useRef(0);
  if (values.length !== last.current.length || values.some((value, index) => !Object.is(value, last.current[index]))) {
    last.current = values;
    count.current += 1;
  }
  return count.current;
}

export function useOutline(
  container: RefObject<HTMLElement | null>,
  { enabled = true, idPrefix, refresh = [] }: {
    /** Off while the container does not hold the headings (a report's other view). The last contents are kept. */
    enabled?: boolean;
    /** Ids given to headings that have none; unique per reader so two on one page never share. */
    idPrefix: string;
    /** What re-renders the headings: when any of these changes the page is read again. */
    refresh?: readonly unknown[];
  },
): { entries: OutlineEntry[]; active: string | null; select: (id: string) => void } {
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const round = useChanged(refresh);

  // Headings get their ids from the page as rendered, so the contents always match what is on screen.
  useEffect(() => {
    const root = container.current;
    if (!root || !enabled) return;
    const found: OutlineEntry[] = [];
    root.querySelectorAll<HTMLHeadingElement>("h2, h3").forEach((heading, index) => {
      if (!heading.id) heading.id = `${idPrefix}-sec-${index + 1}`;
      const text = heading.textContent?.trim() ?? "";
      if (text) found.push({ id: heading.id, text, level: heading.tagName === "H2" ? 2 : 3 });
    });
    setEntries(found);
  }, [container, enabled, idPrefix, round]);

  // Which section is being read, for the contents' current mark.
  useEffect(() => {
    const root = container.current;
    if (!root || entries.length === 0 || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (seen) => {
        const visible = seen.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const entry of entries) {
      const heading = document.getElementById(entry.id);
      if (heading && root.contains(heading)) observer.observe(heading);
    }
    return () => observer.disconnect();
  }, [container, entries]);

  const select = (id: string) => {
    const element = document.getElementById(id);
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
    setActive(id);
  };
  return { entries, active, select };
}

export function Outline({ entries, active, onSelect, layout, onTop, label = "目录", className }: {
  entries: readonly OutlineEntry[];
  /** The id of the section being read. */
  active: string | null;
  onSelect: (id: string) => void;
  layout: "column" | "folded";
  /** The way back up, under the column. Defaults to scrolling the page's own scroll container. */
  onTop?: () => void;
  /** The list's accessible name, and the column's heading. */
  label?: string;
  className?: string;
}) {
  const column = useRef<HTMLElement>(null);
  if (entries.length === 0) return null;
  const contents = (
    <nav aria-label={label}>
      <ol className="space-y-0.5 text-ui">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? "pl-3" : undefined}>
            <Tooltip content={entry.text} kind="label" whenTruncated>
              <button
                type="button"
                onClick={() => onSelect(entry.id)}
                aria-current={active === entry.id ? "location" : undefined}
                className={cn(
                  "w-full truncate rounded px-2 py-1 text-left hover:bg-surface-2",
                  active === entry.id ? "bg-accent-soft text-accent-strong" : entry.level === 2 ? "text-text" : "text-muted",
                )}
              >
                {entry.text}
              </button>
            </Tooltip>
          </li>
        ))}
      </ol>
    </nav>
  );
  if (layout === "folded") {
    return (
      <div data-outline="" data-print-hide="" className={className}>
        <Disclosure summary={<>{label} · {entries.length} 节</>} className="rounded-input border border-border bg-surface px-3 py-2">
          {contents}
        </Disclosure>
      </div>
    );
  }
  const top = () => {
    if (onTop) onTop();
    else column.current?.parentElement?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
  };
  return (
    <aside ref={column} data-outline="" data-print-hide="" className={cn("sticky w-56 shrink-0 self-start overflow-y-auto", STICKY_BELOW_BAND, STICKY_COLUMN_MAX_HEIGHT, className)}>
      <p className="mb-2 flex items-center gap-1.5 px-2 text-caption font-medium text-muted"><ListTree size={16} aria-hidden="true" />{label}</p>
      {contents}
      {/* A 60 KB report needs a way back up (appendix D §4.5). */}
      <button type="button" onClick={top} className="mt-3 flex items-center gap-1 px-2 text-caption text-link hover:underline">
        <ArrowUp size={16} aria-hidden="true" />回到顶部
      </button>
    </aside>
  );
}
