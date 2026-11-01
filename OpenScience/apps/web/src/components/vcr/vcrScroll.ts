/** The room left between the band's hairline and the block's first line: a card flush against it reads as cut off. */
const ROOM_UNDER_BAND = 12;

/**
 * Brings a block of a study page to the top of the page's own scroller, below the sticky band — and moves nothing else.
 *
 * `element.scrollIntoView` scrolls every ancestor that can scroll, and the app shell's root is `overflow: hidden`, which can: a block
 * near the end of a page carried the whole shell, the sidebar and the band with it (DESIGN.md 「页面结构」 rule 9, which found this in
 * 循证 GEO and wrote `components/geo/geoScroll.ts`). The study page's jumps (to the calibration, to a result list, to the definition
 * library) did the same. The ground is the `.overflow-y-auto` ancestor `PageShell` makes, whose `scroll-padding-top` is the band's
 * height; a block outside any ground (a test, a gallery) falls back to the browser's own.
 */
export function scrollBlockToTop(element: HTMLElement | null | undefined): void {
  if (!element) return;
  const ground = element.closest<HTMLElement>(".overflow-y-auto");
  if (!ground) {
    element.scrollIntoView?.({ block: "start" });
    return;
  }
  const padding = Number.parseFloat(getComputedStyle(ground).scrollPaddingTop);
  const offset = element.getBoundingClientRect().top - ground.getBoundingClientRect().top + ground.scrollTop;
  const top = Math.max(0, offset - (Number.isFinite(padding) ? padding : 0) - ROOM_UNDER_BAND);
  if (typeof ground.scrollTo === "function") ground.scrollTo({ top });
  else ground.scrollTop = top;
}
