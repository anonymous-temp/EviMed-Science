import { useEffect, useState } from "react";

/**
 * A media query as a boolean, for the places that must hold one set of controls and not two (a rail folded to one line, a table of
 * contents beside the page or above it). CSS toggles would put both in the document: a screen reader reads each, and a test finds
 * every control twice.
 *
 * A test environment without `matchMedia` (or one whose stub never matches) is never narrow and never wide: it reads `false`.
 */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

/** Under Tailwind's `sm` (640 px): a phone. */
export const NARROW_QUERY = "(max-width: 639px)";

/** From Tailwind's `lg` (1024 px): the page has a column beside its body. */
export const WIDE_QUERY = "(min-width: 1024px)";

export function useNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

export function useWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}
