import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZoneDirectory, forgetZoneCreateAllowed } from "@/lib/evidenceTopicClient";
import { useZoneCreate } from "./useZoneCreate";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/productClient", () => ({ productRequest: request }));

describe("whether 以此新建专区 is offered outside the directory", () => {
  beforeEach(() => { request.mockReset(); forgetZoneCreateAllowed(); });

  it("is offered until a directory read says this reader may not make a zone, then goes, and comes back when a later read says they may", async () => {
    const { result } = renderHook(() => useZoneCreate());
    expect(result.current).toBe(true);
    request.mockResolvedValue({ view: "recommended", groups: [], zones: [], total: 0, canCreate: false, userZones: { count: 0, max: 30 } });
    await act(async () => { await fetchZoneDirectory("recommended"); });
    expect(result.current).toBe(false);
    request.mockResolvedValue({ view: "recommended", groups: [], zones: [], total: 0, canCreate: true, userZones: { count: 0, max: 30 } });
    await act(async () => { await fetchZoneDirectory("recommended"); });
    expect(result.current).toBe(true);
  });

  it("goes where the deployment does not serve the topic directory", async () => {
    const { result } = renderHook(() => useZoneCreate());
    request.mockResolvedValue({ items: [], total: 0, canCreate: true });
    await act(async () => { await fetchZoneDirectory("recommended"); });
    expect(result.current).toBe(false);
  });
});
