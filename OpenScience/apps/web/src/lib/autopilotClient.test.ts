import { beforeEach, expect, it, vi } from "vitest";
import { archiveAgenda, followUpAgenda, getAgenda, runAgendaNow, updateAgenda } from "./autopilotClient";
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
