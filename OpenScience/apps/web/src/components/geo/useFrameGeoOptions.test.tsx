import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS_CHANGED_EVENT } from "@/lib/runPresentation";
import { geoProjectAssociation } from "./useGeoProjectIds";
import { useFrameGeoOptions } from "./useFrameGeoOptions";

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()), listGeoProjects: api.list, getGeoProject: api.get, patchGeoProject: api.patch,
}));
afterEach(() => vi.restoreAllMocks());

describe("GEO association discovered by native conversation options", () => {
  it.each(["scoped", "discovered"] as const)("keeps %s settings writable during a same-conversation refresh and retains changes after an older read returns", async (mode) => {
    const project = { id: "geo_refresh", projectId: "p_refresh", product: {}, coverageDays: 90, engines: ["kimi"] };
    let answerRefresh: () => void = () => undefined;
    api.get.mockReset(); api.list.mockReset(); api.patch.mockReset().mockResolvedValue({});
    const read = mode === "scoped" ? api.get : api.list;
    const response = mode === "scoped" ? project : [project];
    read.mockResolvedValueOnce(response).mockImplementation(() => new Promise(resolve => { answerRefresh = () => resolve(response); }));
    const post = vi.fn();
    const view = renderHook(() => useFrameGeoOptions({ projectId: "p_refresh", geoId: mode === "scoped" ? "geo_refresh" : undefined, sessionId: "ses_refresh", capabilityId: mode === "scoped" ? null : "geo-insight", enabled: true, post }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ controls: true, coverageDays: 90 })));
    act(() => window.dispatchEvent(new Event(RUNS_CHANGED_EVENT)));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    act(() => view.result.current({ sessionId: "ses_refresh", coverageDays: 180 }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("geo_refresh", { coverageDays: 180 }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ controls: true, coverageDays: 180 })));
    act(() => view.result.current({ sessionId: "ses_refresh", engines: ["kimi", "deepseek"] }));
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("geo_refresh", { engines: ["kimi", "deepseek"] }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ controls: true, coverageDays: 180, engines: ["kimi", "deepseek"] })));
    await act(async () => { answerRefresh(); await Promise.resolve(); });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ controls: true, coverageDays: 180, engines: ["kimi", "deepseek"] }));
    view.unmount();
  });

  it.each(["project", "geo"] as const)("revokes pending writes when the %s scope changes even if the session id stays the same", async (change) => {
    api.get.mockReset().mockResolvedValueOnce({ id: "geo_before", projectId: "p_before", product: {}, coverageDays: 90, engines: ["kimi"] }).mockImplementation(() => new Promise(() => {}));
    api.patch.mockReset();
    const post = vi.fn();
    const view = renderHook(({ projectId, geoId }: { projectId: string; geoId: string }) => useFrameGeoOptions({ projectId, geoId, sessionId: "ses_same", capabilityId: null, enabled: true, post }), { initialProps: { projectId: "p_before", geoId: "geo_before" } });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ controls: true })));
    act(() => {
      view.result.current({ sessionId: "ses_same", coverageDays: 180 });
      view.rerender({ projectId: change === "project" ? "p_after" : "p_before", geoId: change === "geo" ? "geo_after" : "geo_before" });
    });
    await act(async () => { await Promise.resolve(); });
    expect(api.patch).not.toHaveBeenCalled();
    view.unmount();
  });

  it("loads an explicitly scoped GEO project for its ordinary primary without listing projects or binding a specialist", async () => {
    api.list.mockReset(); api.get.mockReset().mockResolvedValue({
      id: "geo_explicit", projectId: "p_explicit", product: { brandName: "Scoped product" }, coverageDays: 90, engines: ["kimi"], steps: {},
    });
    const post = vi.fn();
    const view = renderHook(() => useFrameGeoOptions({ projectId: "p_explicit", geoId: "geo_explicit", sessionId: "ses_primary", capabilityId: null, enabled: true, post }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_primary", controls: true, starters: expect.any(Array) })));
    expect(api.get).toHaveBeenCalledWith("geo_explicit");
    expect(api.list).not.toHaveBeenCalled();
    expect(post.mock.calls.at(-1)?.[0].starters).toHaveLength(6);
    view.unmount();
  });

  it("reuses the existing lookup and discovers a project created after the first GEO turn", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    api.list.mockReset();
    api.list.mockResolvedValueOnce([]).mockResolvedValue([{
      id: "geo_discovered", projectId: "p_discovered", name: "Product", coverageDays: 90, engines: [], steps: {},
    }]);
    const post = vi.fn();
    const view = renderHook(() => useFrameGeoOptions({ projectId: "p_discovered", sessionId: "ses_discovered", capabilityId: "geo-insight", enabled: true, post }));
    await waitFor(() => expect(timer.mock.calls.some((call) => call[1] === 10_000)).toBe(true));
    const discover = timer.mock.calls.find((call) => call[1] === 10_000)![0] as () => void;
    act(() => discover());
    await waitFor(() => expect(geoProjectAssociation("p_discovered")?.id).toBe("geo_discovered"));
    expect(api.list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("does no GEO lookup for ordinary conversations, including after a run changes", () => {
    api.list.mockReset();
    const post = vi.fn();
    renderHook(() => useFrameGeoOptions({ projectId: "p_ordinary", sessionId: "ses_plain", capabilityId: null, enabled: true, post }));
    act(() => window.dispatchEvent(new Event(RUNS_CHANGED_EVENT)));
    expect(api.list).not.toHaveBeenCalled();
  });

  it("clears scoped options on leaving GEO and drops a change still waiting for its builder", async () => {
    api.get.mockResolvedValue({ id: "geo_scoped", projectId: "p_scoped", product: {}, coverageDays: 90, engines: ["kimi"] });
    api.list.mockReset(); api.patch.mockReset();
    const post = vi.fn();
    const view = renderHook(({ geoId, sessionId }: { geoId?: string; sessionId: string }) => useFrameGeoOptions({ projectId: "p_scoped", geoId, sessionId, capabilityId: null, enabled: true, post }), { initialProps: { geoId: "geo_scoped" as string | undefined, sessionId: "ses_geo" } });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_geo", controls: true })));
    act(() => {
      view.result.current({ sessionId: "ses_geo", coverageDays: 180 });
      view.rerender({ geoId: undefined, sessionId: "ses_plain" });
    });
    await act(async () => { await Promise.resolve(); });
    expect(post).toHaveBeenLastCalledWith({ sessionId: "ses_plain", clear: true });
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    view.unmount();
  });
});
