/**
 * What the sticky band of `PageShell` publishes to the body, and the classes that read it.
 *
 * The band's height is written on the page's column as `--page-chrome-h` (0 where there is no band). A thing that sticks in the
 * body — a table of contents, a side panel, a table header that must be seen under the band — keeps its `top` below it by
 * adding its own offset to the variable, so it is not hidden behind the steps and the tabs it scrolls under.
 */
export const PAGE_CHROME_VAR = "--page-chrome-h";

/** `top` for a sticky element in the body: the band and a rem. */
export const STICKY_BELOW_BAND = "top-[calc(var(--page-chrome-h,0px)+1rem)]";

/** The tallest a sticky column may be and still end above the window's bottom: the band, the top rem and the bottom 5 rem. */
export const STICKY_COLUMN_MAX_HEIGHT = "max-h-[calc(100vh-var(--page-chrome-h,0px)-6rem)]";
