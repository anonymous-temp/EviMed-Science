import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "./store";

describe("uiStore theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ theme: "light" });
  });

  it("rotates through all three themes and persists to localStorage", () => {
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("ai4s.theme")).toBe("dark");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("system");
    expect(window.localStorage.getItem("ai4s.theme")).toBe("system");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("light");
    expect(window.localStorage.getItem("ai4s.theme")).toBe("light");
  });

  it("defaults to system when nothing is stored", async () => {
    vi.resetModules();
    const fresh = await import("./store");
    expect(fresh.useUiStore.getState().theme).toBe("system");
  });

  it.each(["light", "dark", "system"] as const)("keeps the saved %s preference", async (saved) => {
    window.localStorage.setItem("ai4s.theme", saved);
    vi.resetModules();
    const fresh = await import("./store");
    expect(fresh.useUiStore.getState().theme).toBe(saved);
  });

  it("falls back to system for an unrecognized stored value", async () => {
    window.localStorage.setItem("ai4s.theme", "sepia");
    vi.resetModules();
    const fresh = await import("./store");
    expect(fresh.useUiStore.getState().theme).toBe("system");
  });
});

// L-13 (live walk 2026-10-10): the sidebar a phone had closed stayed closed at desktop width in the same browser, because every
// change of it, the shell's own at a narrow width included, was written down as the reader's preference.
describe("uiStore sidebar", () => {
  const KEY = "ai4s.sidebar.collapsed";
  const realMatchMedia = window.matchMedia;
  /** The window below or from `lg`: below it the sidebar is a drawer over the page. */
  const window_ = (narrow: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches: narrow && query === "(max-width: 1023px)", media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  };
  beforeEach(() => { window.localStorage.clear(); window_(false); useUiStore.setState({ sidebarCollapsed: false }); });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  it("keeps the column's state for the next visit, from lg up", () => {
    useUiStore.getState().toggleSidebar();
    expect(window.localStorage.getItem(KEY)).toBe("1");
    useUiStore.getState().setSidebarCollapsed(false);
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });

  it("does not keep the drawer's: opened and shut below lg it is the page's, not the reader's preference", () => {
    window.localStorage.setItem(KEY, "0");
    window_(true);
    useUiStore.getState().setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().toggleSidebar();
    useUiStore.getState().toggleSidebar();
    expect(window.localStorage.getItem(KEY)).toBe("0");
    window.localStorage.clear();
    useUiStore.getState().setSidebarCollapsed(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("opens a desktop visit as the reader left the column, whatever a phone did in this browser", async () => {
    window.localStorage.setItem(KEY, "0");
    window_(true);
    useUiStore.getState().setSidebarCollapsed(true);
    window_(false);
    vi.resetModules();
    const fresh = await import("./store");
    expect(fresh.useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("settles by the layout: a drawer is closed, a column is as the reader last left it", () => {
    useUiStore.getState().setSidebarCollapsed(true);
    window.localStorage.setItem(KEY, "0");
    useUiStore.getState().settleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    window_(true);
    useUiStore.getState().settleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });
});
