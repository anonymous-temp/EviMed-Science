/** The room left between the band's hairline and the block's first line: a card flush against it reads as cut off. */
const ROOM_UNDER_BAND = 12;

/**
 * Brings a block of a GEO tab to the top of the page's own scroller, below the fixed band (R19, audit C A.2).
 *
 * `element.scrollIntoView({ block: "start" })` does more than that: it scrolls every ancestor that *can* scroll, and the app shell's
 * root is `overflow: hidden`, which can. Any absolutely positioned thing below the fold — a table's screen-reader caption is one —
 * is not clipped by the page's scroller (it is not a containing block) and lengthens the shell, so an anchor near the end of a page
 * carried the whole shell, the sidebar and the band with it, up by the rest of the distance and left a blank under the page. The
 * rail's 「诊断」 and 「需要你」's 「去放行」 both did it on the live walk.
 *
 * This moves the page's ground and nothing else. The ground is found the way `usePageScroll` finds it, and `scroll-padding-top` is
 * the band's height (`PageShell` writes it), so the block stops below the band and not under it. A block that is not inside a page
 * ground (a test, a gallery) falls back to the browser's own.
 */
export function scrollBlockToTop(element: HTMLElement): void {
  const ground = element.closest<HTMLElement>(".overflow-y-auto");
  if (!ground) {
    element.scrollIntoView({ block: "start" });
    return;
  }
  const padding = Number.parseFloat(getComputedStyle(ground).scrollPaddingTop);
  const offset = element.getBoundingClientRect().top - ground.getBoundingClientRect().top + ground.scrollTop;
  const top = Math.max(0, offset - (Number.isFinite(padding) ? padding : 0) - ROOM_UNDER_BAND);
  if (typeof ground.scrollTo === "function") ground.scrollTo({ top });
  else ground.scrollTop = top;
}
