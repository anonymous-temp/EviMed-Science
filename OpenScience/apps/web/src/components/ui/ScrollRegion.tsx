import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Component: ScrollRegion; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Overflow-x container with optional named region and decorative right-edge fade.
 * Variants: Caller classes select height and any extra overflow.
 * States: Measured overflow controls focusability; scroll/resize/content/theme observers update cue.
 * Hit area: Native scroll area; cue ignores pointers.
 * Keyboard: Overflowing region becomes a Tab stop for native scrolling.
 * Long content: Child width retained; scrolling reveals clipped columns.
 * Theme: Fade reads nearest live ancestor background; no scientific palette.
 * Responsive: ResizeObserver measures container/children; no hardcoded width.
 * Verification: ScrollRegion.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
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
      setGround(groundOf(element));
      const wide = element.scrollWidth - element.clientWidth > 1;
      setOverflows(wide);
      setMore(wide && element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of Array.from(element.children)) observer?.observe(child);
      measure();
    });
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    scheme?.addEventListener?.("change", measure);
    const theme = new MutationObserver(measure);
    for (let node: HTMLElement | null = element; node; node = node.parentElement) theme.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => { scheme?.removeEventListener?.("change", measure); mutations.disconnect(); theme.disconnect(); element.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
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
