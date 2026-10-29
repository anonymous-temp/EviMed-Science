import { useEffect, useRef } from "react";

/**
 * Focus follows a change of mode. A page that swaps its list for a long form (or the form back for the list) unmounts the control
 * the person used, and the browser drops focus to the document: a keyboard or screen-reader reader is left at the top of the page.
 * On the change into the mode `enter` names where to land (the new section's heading, made focusable with `tabIndex={-1}`);
 * on the change out `exit` names the control that opened it, which is mounted again by then. A target that is not there, or a
 * callback that returns nothing (an entry the person did not ask for, such as a restored draft), moves nothing; the first render
 * never moves focus.
 */
export function useModeFocus(active: boolean, targets: { enter(): HTMLElement | null | undefined; exit(): HTMLElement | null | undefined }): void {
  const previous = useRef(active);
  const latest = useRef(targets);
  latest.current = targets;
  useEffect(() => {
    if (previous.current === active) return;
    previous.current = active;
    (active ? latest.current.enter() : latest.current.exit())?.focus();
  }, [active]);
}
