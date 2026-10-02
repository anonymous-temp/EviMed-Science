import { expect, it, vi } from "vitest";
import { checkResultSourceUpdates, continueResultImpact, listResultImpacts, type ResultImpact } from "./resultImpactClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
it("uses the immutable version filter and optimistic revision on explicit continuation", () => {
  listResultImpacts("p/one", "rv_old", "next");
  expect(request).toHaveBeenCalledWith("/projects/p%2Fone/result-impacts?versionId=rv_old&cursor=next");
  continueResultImpact("p/one", { id: "impact/1", revision: 4 } as ResultImpact, "agenda_1");
  expect(request).toHaveBeenCalledWith("/projects/p%2Fone/result-impacts/impact%2F1/continue", "POST", { agendaId: "agenda_1", expectedRevision: 4 });
  checkResultSourceUpdates("p/one", "rv_old");
  expect(request).toHaveBeenCalledWith("/results/rv_old/source-updates", "POST", { projectId: "p/one" });
});
