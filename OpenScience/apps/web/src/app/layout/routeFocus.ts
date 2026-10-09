import { useEffect, useRef, type RefObject } from "react";
import { isChatPath } from "@/lib/runLocation";

/**
 * How long a page may take to put its heading on the screen before the move is given up: a lazy chunk and a slow link are slow,
 * but a heading that arrives half a minute later would take the focus from a reader who has long since moved on.
 */
export const HEADING_WAIT_MS = 5000;

/** The page's own heading: the first `h1` in the main area that is not inside the (hidden) conversation surface. */
function pageHeading(main: HTMLElement): HTMLElement | null {
  for (const heading of main.querySelectorAll<HTMLElement>("h1")) {
    if (!heading.closest("[data-session-surface]")) return heading;
  }
  return null;
}

/**
 * After a route change, keyboard focus goes to the new page's `h1` (design reference §5.3, WCAG 2.4.3; R13 V-5).
 *
 * A single-page app changes the screen without a page load, so the browser does not do what it does for a link — announce the
 * new title and start the reader at the top. Without this, a keyboard or screen-reader user who activated a sidebar link stays on
 * that link with the new page unannounced. Order matters: the new page states its tab title (`PageTitle`, hoisted into the head
 * in the same commit as its heading), and only then does focus move, so the title is already the new one when the heading is
 * announced.
 *
 * What does not move focus:
 *  - the first load (the skip link is the first thing Tab reaches, and a heading focused behind it would be a surprise);
 *  - a change that is not of the address's path — a filter, a tab, `?page=` — which is the same page;
 *  - the conversation surface: the kernel frame has no shell `h1` and takes its own focus when a conversation opens;
 *  - a control inside the page that keeps focus through the change: the row a reader just chose in an in-page list, or a tab. A
 *    reader working inside a page is not navigating away from it. Focus that is on the sidebar, on `main` itself (the skip link's
 *    target), or lost with a page that unmounted, does move;
 *  - a dialog or drawer that is open, which has the focus by right;
 *  - a reader who moved focus somewhere else while the page was loading, or a page that took focus itself.
 *
 * The heading is made programmatically focusable (`tabindex="-1"`) and is never a tab stop; it shows no ring (a heading is not a
 * control; the stylesheet gives it the transparent outline forced colours can still paint). `preventScroll` leaves the page where
 * it restored itself.
 *
 * @param pathname the location's path, without query or hash
 * @param main the main landmark, the page's container
 * @param enabled false until there is a page to move focus into (sign-in still being checked)
 */
export function useRouteFocus(pathname: string, main: RefObject<HTMLElement | null>, enabled: boolean): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const container = main.current;
    if (!enabled || !container) return undefined;
    const was = previous.current;
    previous.current = pathname;
    // The first page the shell shows, and any change that left the path as it was.
    if (was === null || was === pathname) return undefined;
    if (isChatPath(pathname)) return undefined;

    const at = document.activeElement;
    const keptByThePage = at instanceof Element && at !== container && container.contains(at);
    if (keptByThePage) return undefined;
    if (document.querySelector('[aria-modal="true"]')) return undefined;

    const arrive = (): boolean => {
      const heading = pageHeading(container);
      if (!heading) return false;
      const now = document.activeElement;
      // Someone moved focus on while the page loaded: leave it where they put it.
      if (now && now !== document.body && now !== container && now !== at) return true;
      heading.setAttribute("tabindex", "-1");
      heading.setAttribute("data-route-focus", "");
      heading.focus({ preventScroll: true });
      return true;
    };
    if (arrive()) return undefined;
    // The page is not here yet (a route chunk loading, a skeleton before its header): watch for its heading.
    const observer = new MutationObserver(() => { if (arrive()) stop(); });
    const timer = window.setTimeout(() => stop(), HEADING_WAIT_MS);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(container, { childList: true, subtree: true });
    return stop;
  }, [pathname, main, enabled]);
}
