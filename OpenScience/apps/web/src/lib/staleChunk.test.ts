import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module remembers, per tab, that a reload is under way; each test gets a
// fresh copy of it, as each page load does.
async function load() {
  vi.resetModules();
  return import("./staleChunk");
}

/** Vite's own event, as its preload helper dispatches it: cancelable, with the import's error. */
function preloadError(message = "Failed to fetch dynamically imported module: https://science.example/assets/InboxPage-0ld.js") {
  const event = new Event("vite:preloadError", { cancelable: true });
  (event as Event & { payload?: unknown }).payload = new TypeError(message);
  return event;
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T08:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a tab older than the release it talks to", () => {
  it("reloads once on Vite's preload error and cancels it, then refuses a second reload within the minute", async () => {
    const { installStaleChunkReload } = await load();
    const reload = vi.fn();
    const remove = installStaleChunkReload(window, reload);

    const first = preloadError();
    window.dispatchEvent(first);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    remove();

    // The page that reload brings back fails again 30 s later: not a stale tab
    // any more, so no reload, and the error goes on to the route's element.
    vi.setSystemTime(Date.now() + 30_000);
    const next = await load();
    const again = vi.fn();
    const removeAgain = next.installStaleChunkReload(window, again);
    const second = preloadError();
    window.dispatchEvent(second);
    expect(again).not.toHaveBeenCalled();
    expect(second.defaultPrevented).toBe(false);
    removeAgain();
  });

  it("reloads again once the minute has passed", async () => {
    const { reloadForNewRelease } = await load();
    const reload = vi.fn();
    expect(reloadForNewRelease(reload)).toBe(true);
    vi.setSystemTime(Date.now() + 61_000);
    const later = await load();
    expect(later.reloadForNewRelease(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("asks for one reload however many chunks fail before it lands", async () => {
    const { installStaleChunkReload, reloadingForNewRelease } = await load();
    const reload = vi.fn();
    installStaleChunkReload(window, reload);
    const events = [preloadError(), preloadError("Unable to preload CSS for /assets/index-0ld.css")];
    for (const event of events) window.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
    expect(reloadingForNewRelease()).toBe(true);
  });

  it("does not reload a tab that is offline: that chunk is not stale, the network is gone", async () => {
    const { reloadForNewRelease } = await load();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const reload = vi.fn();
    expect(reloadForNewRelease(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // Nor does it spend the minute's reload on it.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(reloadForNewRelease(reload)).toBe(true);
  });

  it("does not reload when the tab cannot remember that it did", async () => {
    const { reloadForNewRelease } = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const reload = vi.fn();
    expect(reloadForNewRelease(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("knows a failed chunk in every engine's words, and nothing else", async () => {
    const { isStaleChunkError } = await load();
    for (const message of [
      "Failed to fetch dynamically imported module: https://science.example/assets/AutopilotPage-0ld.js",
      "error loading dynamically imported module: https://science.example/assets/AutopilotPage-0ld.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/index-0ld.css",
      "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\".",
      "'text/html' is not a valid JavaScript MIME type.",
    ]) expect(isStaleChunkError(new TypeError(message)), message).toBe(true);
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});
