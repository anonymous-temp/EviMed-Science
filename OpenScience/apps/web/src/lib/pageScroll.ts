import { useLayoutEffect, useRef, type RefObject } from "react";
import { useLocation } from "react-router";

/** Scroll offsets by history entry, for the life of the tab: Back finds the entry's own key again. */
const offsets = new Map<string, number>();

/** Test seam. */
export function clearPageScroll(): void {
  offsets.clear();
}

/**
 * A page's place in its list survives leaving it and coming back (design
 * reference §20.3 A08): the offset the reader had scrolled to is kept under the
 * history entry's key, and put back when Back returns to that entry and the
 * list is on screen again. A new visit (a link, a click) is a new entry with no
 * offset, so it opens at the top.
 *
 * Put the returned ref on an empty element inside the page; the scroller is the
 * nearest `overflow-y-auto` ancestor, which is the page ground `PageShell`
 * draws. `ready` is false while the list is a skeleton: nothing is recorded
 * then (the shrunk box makes the browser clamp the offset to a bogus one) and
 * nothing is restored until the rows are there to scroll. The offset is put back
 * once per visit to an entry: a list that is read again on the same entry (a
 * filter changed, everything marked read) starts from the top, as a new list.
 */
export function usePageScroll(ready: boolean): RefObject<HTMLSpanElement | null> {
  const anchor = useRef<HTMLSpanElement>(null);
  const { key } = useLocation();
  const restoredFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready) return;
    const scroller = anchor.current?.closest<HTMLElement>(".overflow-y-auto");
    if (!scroller) return;
    if (restoredFor.current !== key) {
      restoredFor.current = key;
      const saved = offsets.get(key);
      if (saved) scroller.scrollTop = saved;
    }
    const remember = () => offsets.set(key, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [ready, key]);
  return anchor;
}
