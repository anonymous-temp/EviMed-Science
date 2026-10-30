import { beforeEach, expect, it, vi } from "vitest";
import { productRequest } from "./productClient";
import { readEvimedSearchTopics } from "./evimedSearchTopicsClient";

vi.mock("./productClient", () => ({ productRequest: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });

it("uses the authenticated control-plane project route, with a bounded topic count and cancellation", async () => {
  const response = { schemaVersion: 1, category: "guidelines", topics: [], count: 0 };
  vi.mocked(productRequest).mockResolvedValue(response);
  const controller = new AbortController();
  expect(await readEvimedSearchTopics("project/with space", "guidelines", controller.signal)).toBe(response);
  expect(productRequest).toHaveBeenCalledWith("/projects/project%2Fwith%20space/evimed-search/topics?category=guidelines&limit=3", "GET", undefined, { signal: controller.signal });
});
