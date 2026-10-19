import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS_CHANGED_EVENT } from "@/lib/runPresentation";
import { geoProjectAssociation } from "./useGeoProjectIds";
import { useFrameGeoOptions } from "./useFrameGeoOptions";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()), listGeoProjects: api.list,
}));
afterEach(() => vi.restoreAllMocks());

describe("GEO association discovered by native conversation options", () => {
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
});
