import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { ResultImpactPanel } from "./ResultImpactPanel";
import type { ResultImpact } from "@/lib/resultImpactClient";

const api = vi.hoisted(() => ({ list: vi.fn(), continue: vi.fn(), agendas: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/resultImpactClient", () => ({ listResultImpacts: api.list, continueResultImpact: api.continue, checkResultSourceUpdates: api.check }));
vi.mock("@/lib/autopilotClient", () => ({ listAgendas: api.agendas }));
const changed: ResultImpact = { id: "impact_1", revision: 4, createdAt: "", updatedAt: "", deletedAt: null, payload: {
  versionId: "rv_old", source: { id: "source_1", doi: "10.1234/paper" },
  sourceStatus: { state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind: "correction", noticeDoi: "10.1234/correction", date: null, source: "publisher" }] },
  effect: "potentially_affected", claimIds: ["C1"], historicalResultPreserved: true, recomputed: false, continuation: { status: "awaiting_user" },
} };
const active = { id: "agenda_1", revision: 7, payload: { title: "长期研究", enabled: true, status: "active", archivedAt: null } };
function mount(versionId = "rv_old") { return render(<MemoryRouter><ResultImpactPanel key={versionId} projectId="p" versionId={versionId} digest="selected_digest" /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks(); api.list.mockResolvedValue({ items: [changed], nextCursor: null });
  api.agendas.mockResolvedValue({ items: [active, { ...active, id: "paused", payload: { ...active.payload, title: "暂停研究", status: "paused" } }, { ...active, id: "disabled", payload: { ...active.payload, title: "停止研究", enabled: false } }] });
  api.continue.mockResolvedValue({ ...changed, revision: 6, payload: { ...changed.payload, continuation: { status: "scheduled", agendaId: active.id, episodeId: "ep_1" } } });
  api.check.mockResolvedValue({ versionId: "rv_old", digest: "selected_digest", statuses: [{ source: { id: "source_1" }, doi: null, updateStatus: { state: "no_update", checkedAt: null, updates: [] } }], impacts: { items: [] } });
});
it("shows current corrections for the exact historical version and schedules only on explicit consent", async () => {
  mount();
  expect(await screen.findByText("文献有更新")).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledWith("p", "rv_old");
  const selector = await screen.findByRole("combobox", { name: "研究议程 source_1" });
  expect(screen.queryByRole("option", { name: "暂停研究" })).toBeNull();
  expect(screen.queryByRole("option", { name: "停止研究" })).toBeNull();
  expect(api.continue).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "在此议程中继续研究" })).toBeDisabled();
  await userEvent.selectOptions(selector, active.id);
  expect(api.continue).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "在此议程中继续研究" }));
  expect(api.continue).toHaveBeenCalledWith("p", changed, active.id);
  expect(await screen.findByText(/已安排后续研究/)).toBeInTheDocument();
  expect(screen.getByText(/历史结果已保留/)).toBeInTheDocument();
});
it("keeps unknown and unavailable checks visible without recomputation or agenda actions", async () => {
  api.list.mockResolvedValue({ items: ["unknown", "unavailable"].map((state, index) => ({ ...changed, id: `gap_${index}`, payload: { ...changed.payload, effect: "source_gap", sourceStatus: { state, checkedAt: null, updates: [] } } })), nextCursor: null });
  mount(); expect(await screen.findByText("更新状态未知")).toBeInTheDocument();
  expect(screen.getByText("更新查询不可用")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "在此议程中继续研究" })).toBeNull();
  expect(api.agendas).not.toHaveBeenCalled(); expect(api.continue).not.toHaveBeenCalled();
});
it("reports missing records as unknown and retries failed reads", async () => {
  api.list.mockRejectedValueOnce(new Error("offline")); api.list.mockResolvedValue({ items: [], nextCursor: null });
  mount(); expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText(/暂无此版本/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试来源更新" }));
  expect(await screen.findByText(/更新状态尚未确认/)).toBeInTheDocument();
});
it("offers no continuation when there is no existing active agenda", async () => {
  api.agendas.mockResolvedValue({ items: [] }); mount();
  expect(await screen.findByText(/需要已有且正在进行的研究议程/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).toBeNull(); expect(api.continue).not.toHaveBeenCalled();
});
it("keeps the old result unchanged after a refused continuation and requires refreshed consent", async () => {
  api.continue.mockRejectedValue(new Error("conflict")); mount();
  await userEvent.selectOptions(await screen.findByRole("combobox"), active.id);
  await userEvent.click(screen.getByRole("button", { name: "在此议程中继续研究" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText(/已安排后续研究/)).toBeNull();
  expect(screen.getByText(/历史结果已保留/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "刷新并重试" }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("combobox")).toHaveValue("");
});
it("ignores records for another version instead of retargeting the selected result", async () => {
  mount("rv_new"); expect(await screen.findByText(/暂无此版本/)).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledWith("p", "rv_new");
  expect(screen.queryByText("文献有更新")).toBeNull(); expect(api.continue).not.toHaveBeenCalled();
});
it("checks only the selected version after explicit click and then refreshes its impact records", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null }); mount();
  await screen.findByText(/暂无此版本/); expect(api.check).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(api.check).toHaveBeenCalledWith("p", "rv_old");
  expect(await screen.findByText("未发现更新")).toBeInTheDocument();
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(api.continue).not.toHaveBeenCalled();
});
it("does not show a failed or wrong-version source check as clean", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.check.mockRejectedValueOnce(new Error("unavailable")); mount(); await screen.findByText(/暂无此版本/);
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText("未发现更新")).toBeNull();
  api.check.mockResolvedValueOnce({ versionId: "rv_new", digest: "different", statuses: [], impacts: { items: [] } });
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText("未发现更新")).toBeNull();
});
it("shows a revoked source as unavailable without exposing its old identity or offering continuation", async () => {
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.check.mockResolvedValue({ versionId: "rv_old", digest: "selected_digest", statuses: [{ source: { id: "unavailable-source" }, doi: null,
    updateStatus: { state: "unavailable", checkedAt: null, reason: "restricted", updates: [] } }], impacts: { items: [] } });
  mount(); await screen.findByText(/暂无此版本/);
  await userEvent.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText("原来源已不可用")).toBeInTheDocument();
  expect(screen.getByText("更新查询不可用")).toBeInTheDocument();
  expect(screen.queryByText("unavailable-source")).toBeNull();
  expect(screen.queryByRole("button", { name: "在此议程中继续研究" })).toBeNull();
});
