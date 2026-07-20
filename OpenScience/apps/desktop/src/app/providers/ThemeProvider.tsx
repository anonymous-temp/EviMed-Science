import { useEffect, type ReactNode } from "react";
import { useUiStore } from "@/lib/store";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Applies the current theme to the document root. The "system" preference
 *  tracks the OS color scheme live, so an OS light/dark flip repaints the app
 *  without a reload. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    if (theme !== "system") {
      document.documentElement.dataset.theme = theme;
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const apply = () => {
      document.documentElement.dataset.theme = media.matches ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return <>{children}</>;
}
