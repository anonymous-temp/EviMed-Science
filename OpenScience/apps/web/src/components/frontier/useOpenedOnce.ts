import { useEffect, useRef, useState } from "react";

/**
 * Whether the `<details>` inside the returned ref has been opened at least once.
 *
 * `Disclosure` is the product's one collapse, and it is a native `<details>`:
 * its body is mounted while closed, only not shown. What a disclosure here
 * holds is read on demand — an abstract, the whole list of sources — so the
 * body mounts its reader only after the first `toggle` to open, and a feed of
 * thirty cards costs no request until someone asks. The ref goes on a wrapper
 * (`className="contents"` keeps it out of the layout); the primitive itself is
 * used as it is.
 */
export function useOpenedOnce<T extends HTMLElement = HTMLDivElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const details = ref.current?.querySelector("details");
    if (!details || opened) return;
    if (details.open) { setOpened(true); return; }
    const onToggle = () => { if (details.open) setOpened(true); };
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, [opened]);
  return [ref, opened];
}
