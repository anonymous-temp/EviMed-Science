import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceUnderstanding, listSourceUnderstandingHistory } from "./sourceClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

describe("source understanding client", () => {
  beforeEach(() => { request.mockReset(); });

  it("uses the authenticated detail route with an encoded source id", async () => {
    const result = { sourceId: "source/one", current: null };
    request.mockResolvedValue(result);
    expect(await getSourceUnderstanding("source/one")).toBe(result);
    expect(request).toHaveBeenCalledWith("/sources/source%2Fone/understanding");
  });

  it("requests bounded history pages and preserves opaque cursor values", async () => {
    request.mockResolvedValue({ items: [], nextCursor: null });
    await listSourceUnderstandingHistory("source-one");
    expect(request).toHaveBeenLastCalledWith("/sources/source-one/understanding/history?limit=20");
    await listSourceUnderstandingHistory("source-one", "next+/=&");
    expect(request).toHaveBeenLastCalledWith("/sources/source-one/understanding/history?limit=20&cursor=next%2B%2F%3D%26");
  });
});
