import { beforeEach, expect, it, vi } from "vitest";
import { addAgendaMaterials, archiveAgenda, followUpAgenda, getAgenda, getResearchState, removeAgendaMaterial, runAgendaNow, updateAgenda } from "./autopilotClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
beforeEach(() => request.mockReset());
it("uses authenticated product requests for the task contract", () => {
  getAgenda("task/one"); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task%2Fone");
  updateAgenda("task/one", { expectedRevision: 5, prompt: "  Original\n与instruction  ", schedule: { kind: "daily", time: "09:15", timeZone: "Asia/Shanghai" } });
  expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task%2Fone", "PATCH", expect.objectContaining({ expectedRevision: 5, prompt: "  Original\n与instruction  " }));
  archiveAgenda("task/one", 5); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task%2Fone", "DELETE", { expectedRevision: 5 });
});
it("passes the caller's idempotency identity and complete follow-up", () => {
  runAgendaNow("task", "request-1"); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task/run-now", "POST", { requestId: "request-1" });
  followUpAgenda("task", { requestId: "request-2", note: "  Follow-up\n完整说明  ", episodeId: "episode" });
  expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task/follow-ups", "POST", { requestId: "request-2", note: "  Follow-up\n完整说明  ", episodeId: "episode" });
});
it("reads a question's progress and changes its material only through its own agenda", () => {
  getResearchState("task/one"); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task%2Fone/progress");
  addAgendaMaterials("task/one", { sha256: ["a".repeat(64)] });
  expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task%2Fone/materials", "POST", { sha256: ["a".repeat(64)] });
  addAgendaMaterials("task", { sourceIds: ["src_a"] }); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task/materials", "POST", { sourceIds: ["src_a"] });
  removeAgendaMaterial("task", "src/a"); expect(request).toHaveBeenLastCalledWith("/autopilot/agendas/task/materials/src%2Fa", "DELETE");
});
