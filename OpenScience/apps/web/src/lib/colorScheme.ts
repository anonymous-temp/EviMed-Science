import { useEffect, useState } from "react";

/**
 * The scheme actually painted right now, read from the one place that knows:
 * `data-theme` on `<html>`, which `ThemeProvider` writes and
 * `public/theme-init.js` sets before the first frame.
 *
 * Anything that draws outside CSS — a canvas chart, a rendered figure — needs
 * the resolved value, not the preference, because 「跟随系统」 is neither
 * light nor dark until the media query answers. Watching the attribute rather
 * than the store means one source of truth and no second copy of the
 * system-preference logic.
 */

export type ColorScheme = "light" | "dark";

export function readColorScheme(): ColorScheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(readColorScheme);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return undefined;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setScheme(readColorScheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    setScheme(readColorScheme());
    return () => observer.disconnect();
  }, []);
  return scheme;
}
