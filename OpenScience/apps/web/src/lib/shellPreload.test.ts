import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warm: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({ warmWebRuntime: mocks.warm, listRuntimeUiPreload: mocks.list }));
vi.mock("@/app/routes/FrontierPage", () => ({}));
vi.mock("@/app/routes/CapabilitiesPage", () => ({}));
vi.mock("@/app/routes/KnowledgePage", () => ({}));
vi.mock("@/app/routes/MemoryHubPage", () => ({}));
vi.mock("@/app/virtual-research/VcrHomePage", () => ({}));
vi.mock("@/app/routes/GeoHomePage", () => ({}));
vi.mock("@/app/routes/AutopilotPage", () => ({}));

import { preloadAllowed, preloadConversationAssets, resetShellHeadStartForTests, startShellHeadStart } from "./shellPreload";
import { holdStaleChunkReload, installStaleChunkReload } from "./staleChunk";

describe("the shell's head start", () => {
  const fetched = vi.fn(async () => new Response());
  beforeEach(() => {
    vi.clearAllMocks();
    resetShellHeadStartForTests();
    vi.stubGlobal("fetch", fetched);
    mocks.list.mockResolvedValue({ origin: "https://host:8443", paths: ["/__evimed/k/assets/a.js", "/__evimed/k/assets/b.js"] });
  });
  afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });

  it("starts the runtime as a guess that stops nothing, once a tab", () => {
    expect(startShellHeadStart()).toBe(true);
    expect(startShellHeadStart()).toBe(false);
    expect(mocks.warm).toHaveBeenCalledTimes(1);
    expect(mocks.warm).toHaveBeenCalledWith(undefined, { speculative: true });
  });

  it("leaves a module's conversation to start its own runtime", () => {
    window.history.pushState({}, "", "/app/geo/g1/chat/s1");
    startShellHeadStart();
    expect(mocks.warm).not.toHaveBeenCalled();
  });

  it("never reaches the caller when it fails", () => {
    mocks.warm.mockImplementationOnce(() => { throw new Error("no"); });
    expect(startShellHeadStart()).toBe(false);
  });

  it("fetches the conversation's files on its origin, with the session, without reading them", async () => {
    await preloadConversationAssets();
    expect(fetched.mock.calls.map(([url]: unknown[]) => url)).toEqual(["https://host:8443/__evimed/k/assets/a.js", "https://host:8443/__evimed/k/assets/b.js"]);
    expect(fetched.mock.calls[0]).toEqual([expect.any(String), { mode: "no-cors", credentials: "include" }]);
  });

  it("asks for nothing on a connection that asked to save data", async () => {
    expect(preloadAllowed({ saveData: true })).toBe(false);
    expect(preloadAllowed({ effectiveType: "2g" })).toBe(false);
    expect(preloadAllowed({ effectiveType: "4g" })).toBe(true);
    expect(preloadAllowed(undefined)).toBe(true);
  });

  it("a chunk fetched ahead of need never reloads the tab, and a page's own chunk still does", () => {
    const reload = vi.fn();
    const remove = installStaleChunkReload(window, reload);
    const release = holdStaleChunkReload();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).not.toHaveBeenCalled();
    release();
    release();
    window.sessionStorage.clear();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
    remove();
  });
});
