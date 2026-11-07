import { expect, it, vi } from "vitest";
import { checkResultSourceUpdates, listResultImpacts } from "./resultImpactClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
it("uses the immutable version filter", () => {
  listResultImpacts("p/one", "rv_old", "next");
  expect(request).toHaveBeenCalledWith("/projects/p%2Fone/result-impacts?versionId=rv_old&cursor=next");
  checkResultSourceUpdates("p/one", "rv_old");
  expect(request).toHaveBeenCalledWith("/results/rv_old/source-updates", "POST", { projectId: "p/one" });
});
