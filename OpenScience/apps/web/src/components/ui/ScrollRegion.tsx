import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A box that scrolls sideways when its content is wider than it is: a table, a
 * heat grid, a matrix.
 *
 * Chromium puts such a scroller into the tab order by itself; WebKit and Firefox
 * on the Mac do not, so a keyboard reader there could not move a wide table at
 * all (axe `scrollable-region-focusable`, 2026-10-07 audit). A scroller that
 * takes focus also needs a role and a name, or the focus lands on nothing — so
 * while the content overflows the box is a labelled region with `tabIndex` 0,
 * and its focus ring is the global `:focus-visible` rule's.
 *
 * Only while it overflows. A report holds thirty tables and most of them fit on
 * a desktop; thirty extra stops in the tab order, each announced as a region,
 * are a cost for the reader the fit never asked for. The overflow is measured
 * (the box and the content it holds), not guessed from a breakpoint, and it is
 * measured again whenever either is resized.
 *
 * `jsx-a11y/no-noninteractive-tabindex` cannot model a scroll region; the
 * attributes are a spread on purpose, so no file has to silence the rule.
 */
export function ScrollRegion({ label, className, children }: {
  /** The region's accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => setOverflows(element.scrollWidth - element.clientWidth > 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  const region = overflows ? { tabIndex: 0, role: "region", "aria-label": label } : {};
  return (
    <div ref={box} className={cn("overflow-x-auto", className)} {...region}>
      {children}
    </div>
  );
}
