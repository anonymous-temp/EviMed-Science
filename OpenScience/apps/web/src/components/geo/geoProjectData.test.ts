import { describe, expect, it, vi } from "vitest";
import { GeoDataCache } from "./geoProjectData";
import { WebApiError } from "@/lib/apiClient";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("GEO shared reads during ongoing work", () => {
  it("defers a queued refresh when a slow read finishes after the page is hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visible = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    let finish: (value: string) => void = () => undefined;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const cache = new GeoDataCache();
    const load = vi.fn().mockReturnValueOnce(pending).mockResolvedValue("fresh");
    const stop = cache.watch("sources:geo1", load);
    try {
      await settle();
      cache.invalidate();
      visibility = "hidden";
      finish("preserved");
      await settle();
      expect(load).toHaveBeenCalledTimes(1);
      visibility = "visible";
      cache.invalidate();
      await settle();
      expect(cache.snapshot("sources:geo1")).toMatchObject({ kind: "ready", data: "fresh" });
    } finally { stop(); visible.mockRestore(); }
  });
  it("does not retain data after access has been revoked", async () => {
    const cache = new GeoDataCache();
    const load = vi.fn().mockResolvedValueOnce({ articles: ["private"] }).mockRejectedValueOnce(new WebApiError("denied", { status: 403 }));
    const stop = cache.watch("articles:geo1", load);
    await settle();
    cache.invalidate();
    await settle();
    expect(cache.snapshot("articles:geo1").kind).toBe("error");
    expect(cache.refreshError()).toBe("");
    stop();
  });
  it("retains the last usable response on refresh failure and clears the notice after recovery", async () => {
    const cache = new GeoDataCache();
    const load = vi.fn().mockResolvedValueOnce({ articles: ["draft1"] }).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ articles: ["draft1", "draft2"] });
    const stop = cache.watch("articles:geo1", load);
    await settle();
    cache.invalidate();
    await settle();
    expect(cache.snapshot("articles:geo1")).toMatchObject({ kind: "ready", data: { articles: ["draft1"] }, refreshError: expect.any(String) });
    expect(cache.refreshError()).not.toBe("");
    cache.reload("articles:geo1");
    await settle();
    expect(cache.snapshot("articles:geo1")).toEqual({ kind: "ready", data: { articles: ["draft1", "draft2"] } });
    expect(cache.refreshError()).toBe("");
    stop();
  });

  it("coalesces invalidations while a slow read is pending without starving its replacement", async () => {
    const cache = new GeoDataCache();
    let finish: (value: string) => void = () => undefined;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const load = vi.fn().mockReturnValueOnce(pending).mockResolvedValue("fresh");
    const stop = cache.watch("diagnosis:geo1:scope1", load);
    await settle();
    cache.invalidate(); cache.invalidate(); cache.invalidate();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    finish("stale");
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.snapshot("diagnosis:geo1:scope1")).toMatchObject({ kind: "ready", data: "fresh" });
    stop();
  });
});

it("tells a refresh refused for a changed saved selection from one that may succeed if asked again", async () => {
  const cache = new GeoDataCache();
  const load = vi.fn().mockResolvedValueOnce("shown")
    .mockRejectedValueOnce(new WebApiError("changed", { status: 409, code: "geo_read_filter_invalid" }))
    .mockRejectedValueOnce(new WebApiError("busy", { status: 503 }));
  const stop = cache.watch("visibility:geo1", load);
  try {
    await settle();
    cache.reload("visibility:geo1"); await settle();
    expect(cache.refreshStale()).toBe(true);
    expect(cache.snapshot("visibility:geo1")).toMatchObject({ kind: "ready", data: "shown" });
    cache.reload("visibility:geo1"); await settle();
    expect(cache.refreshStale()).toBe(false);
    expect(cache.refreshError()).not.toBe("");
  } finally { stop(); }
});
