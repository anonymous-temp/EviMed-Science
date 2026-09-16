/**
 * The browser tab's name for this page.
 *
 * Every route rendered `EviMed` and nothing else (2026-09-16 walk, U6), so the
 * browser tab strip, the history menu, a bookmark and a screen reader's window
 * list all described ten different pages identically. React 19 hoists a
 * `<title>` rendered anywhere in the tree into `<head>`, so each page states
 * its own name where the page is defined rather than through an effect that
 * has to be undone on the way out.
 *
 * Product name last, as browsers truncate from the right and the distinguishing
 * part is the page.
 */
export function PageTitle({ page, section }: { page: string; section?: string }) {
  const parts = section && section !== page ? [page, section] : [page];
  return <title>{[...parts, "EviMed"].join(" · ")}</title>;
}
