import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { ThemeProvider } from "./ThemeProvider";

/** jsdom has no matchMedia — stub the one query the provider subscribes to. */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      get matches() {
        return matches;
      },
      media: "(prefers-color-scheme: dark)",
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    })),
  });
  return {
    flip(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
    listenerCount: () => listeners.size,
  };
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("applies an explicit theme directly without consulting the OS scheme", () => {
    const mm = stubMatchMedia(true);
    useUiStore.setState({ theme: "light" });
    render(<ThemeProvider>{null}</ThemeProvider>);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.matchMedia).not.toHaveBeenCalled();
    expect(mm.listenerCount()).toBe(0);
  });

  it("system follows the OS scheme and reacts to live changes", () => {
    const mm = stubMatchMedia(true);
    useUiStore.setState({ theme: "system" });
    render(<ThemeProvider>{null}</ThemeProvider>);

    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => mm.flip(false));
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => mm.flip(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("drops the OS-scheme listener when the preference leaves system", () => {
    const mm = stubMatchMedia(false);
    useUiStore.setState({ theme: "system" });
    render(<ThemeProvider>{null}</ThemeProvider>);
    expect(mm.listenerCount()).toBe(1);

    act(() => useUiStore.getState().setTheme("dark"));
    expect(mm.listenerCount()).toBe(0);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
