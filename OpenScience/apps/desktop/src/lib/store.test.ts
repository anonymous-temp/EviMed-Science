import { beforeEach, describe, expect, it, vi } from "vitest";
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
