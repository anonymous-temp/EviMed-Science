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
 *
 * While there is more to the right of what is in view a fade at the edge says so (R19, the walk's phone pictures: a heat grid and
 * two tables cut mid-word at the card's edge read as broken, not wide). The fade is a sibling of the scroller, so the scroller's
 * own box, border and focus ring are as they were, and it takes the colour the box sits on.
 */
export function ScrollRegion({ label, className, children }: {
  /** The region's accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  // Whether there is more to the right of what is in view, and the colour the page is behind the box: the cue fades into it.
  const [more, setMore] = useState(false);
  const [ground, setGround] = useState("");
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => {
      const wide = element.scrollWidth - element.clientWidth > 1;
      setOverflows(wide);
      setMore(wide && element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    return () => { element.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    if (more && ground === "" && box.current) setGround(groundOf(box.current));
  }, [more, ground]);
  const region = overflows ? { tabIndex: 0, role: "region", "aria-label": label } : {};
  return (
    <div className="relative min-w-0">
      <div ref={box} className={cn("overflow-x-auto", className)} {...region}>
        {children}
      </div>
      {/* A table cut at the edge of its box looks broken, not wide: while there is more to the right a fade says so. Never in the tab order. */}
      {more && (
        <span
          aria-hidden="true"
          data-scroll-cue=""
          className="pointer-events-none absolute inset-y-0 right-0 w-10"
          style={{ backgroundImage: `linear-gradient(to left, ${ground || "var(--surface)"}, transparent)` }}
        />
      )}
    </div>
  );
}

/** The colour the box sits on: the nearest background up the tree that is not transparent, else the page's. @param {HTMLElement} element */
function groundOf(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    // A computed background with no alpha left is `transparent` or the four-channel form ending in a zero alpha.
    const clear = color === "transparent" || (color.startsWith("rgba") && /,\s*0\)$/.test(color));
    if (color && !clear) return color;
  }
  return "var(--bg)";
}
