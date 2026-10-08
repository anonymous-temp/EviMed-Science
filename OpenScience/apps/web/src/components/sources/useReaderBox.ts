import { useLayoutEffect, useState } from "react";

/**
 * The original's column is never narrower than this: below it a page of a PDF is read at a size nobody reads at, and
 * the original and the key points go back to being two tabs (design reference §5.1). The width that counts is the
 * page's own — what the sidebar and the window leave — not the viewport's.
 */
export const ORIGINAL_MIN_WIDTH = 560;
/** The key points' column. */
export const POINTS_WIDTH = 360;
/** The gutter between the two (`gap-6`). */
export const COLUMN_GAP = 24;
/** The content width from which the original and the key points stand side by side. */
export const TWO_COLUMN_MIN_WIDTH = ORIGINAL_MIN_WIDTH + COLUMN_GAP + POINTS_WIDTH;

/** Whether a content box of this width has room for the original (at least 560) beside the key points. */
export function fitsTwoColumns(width: number): boolean {
  return width >= TWO_COLUMN_MIN_WIDTH;
}

/** The page's own bottom padding (`py-6` on `PageShell`'s column), which the body leaves below itself. */
const PAGE_BOTTOM_PADDING = 24;
/** A pane is never shorter than this, so a short window scrolls the page instead of squeezing the original away. */
export const MIN_PANE_HEIGHT = 384;

export interface ReaderBox {
  /** The body's content width, 0 until it has been measured. */
  width: number;
  /** The height left for the body under the header, or null where it cannot be measured. */
  height: number | null;
}

/**
 * Measures the box a reader page lays its columns in: its width, to choose between two columns and two tabs; and the
 * height the window leaves under the header, so that the original and the key points each scroll in their own column
 * and the header stays where it is (§5.2: a multi-column workspace may scroll by column).
 *
 * `rootRef` goes on the element that wraps `PageShell` — whose own scroll container is its first child — and `bodyRef`
 * on the element inside the page that holds the columns. Both are callback refs, so the hook measures as soon as the
 * boxes exist, before the first paint, and again whenever the window, the sidebar or the header changes size.
 */
export function useReaderBox() {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<ReaderBox>({ width: 0, height: null });

  useLayoutEffect(() => {
    if (!root || !body) return undefined;
    const scroller = root.firstElementChild instanceof HTMLElement ? root.firstElementChild : null;
    const measure = () => {
      const width = body.clientWidth;
      let height: number | null = null;
      if (scroller && scroller.clientHeight > 0) {
        const top = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        height = Math.max(MIN_PANE_HEIGHT, Math.floor(scroller.clientHeight - top - PAGE_BOTTOM_PADDING));
      }
      setBox((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (scroller) {
      observer.observe(scroller);
      // The header wrapping onto a second line moves the body down without resizing either of the two above.
      if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    }
    return () => observer.disconnect();
  }, [root, body]);

  return { rootRef: setRoot, bodyRef: setBody, box };
}
