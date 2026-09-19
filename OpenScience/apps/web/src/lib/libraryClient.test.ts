import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import { fetchLibrary, publishToCapsule } from "./libraryClient";

const product = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("./productClient", () => product);

describe("the library reader", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads the agreed shape as a list or as a page, and a 404 as a deployment without the library", async () => {
    const item = { sourceId: "s", title: "t", kind: "other", addedAt: "2026-09-01T00:00:00Z", projects: [], status: "complete" };
    product.productRequest.mockResolvedValueOnce([item]);
    expect(await fetchLibrary()).toEqual([item]);
    product.productRequest.mockResolvedValueOnce({ items: [item], nextCursor: null });
    expect(await fetchLibrary()).toEqual([item]);
    expect(product.productRequest).toHaveBeenLastCalledWith("/library");
    product.productRequest.mockRejectedValueOnce(new WebApiError("Route not found.", { status: 404, code: "not_found" }));
    expect(await fetchLibrary()).toBeNull();
    product.productRequest.mockRejectedValueOnce(new WebApiError("down", { status: 503 }));
    await expect(fetchLibrary()).rejects.toThrow("down");
  });

  it("publishes one source to the capsule by its id", async () => {
    product.productRequest.mockResolvedValueOnce({ facts: 2 });
    await publishToCapsule("src/with slash");
    expect(product.productRequest).toHaveBeenCalledWith("/library/src%2Fwith%20slash/publish-to-capsule", "POST", {});
  });
});
