import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceMaintenance } from "./EvidenceMaintenance";
import type { EvidenceZone } from "@/lib/evidenceZoneClient";
const client = vi.hoisted(() => ({
  fetchEvidenceMaintenance: vi.fn(),
  saveEvidenceMaintenance: vi.fn(),
  refreshEvidenceZone: vi.fn(),
}));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()),
  ...client,
}));
const zone = { id: "one", revision: 2, canEdit: true } as EvidenceZone;
const maintenance = {
  automation: {
    enabled: true,
    query: "kidney disease",
    sourceTypes: ["journal"],
    intervalHours: 24,
    maxCardsPerRun: 2,
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
  },
  jobs: { running: 0, pending: 0, failed: 0 },
  recent: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  client.fetchEvidenceMaintenance.mockResolvedValue(maintenance);
  client.saveEvidenceMaintenance.mockResolvedValue(maintenance);
  client.refreshEvidenceZone.mockResolvedValue({
    ...maintenance,
    jobs: { running: 0, pending: 1, failed: 0 },
  });
});
describe("who pays for the upkeep", () => {
  it("tells the owner of a zone that the model cost is theirs, before they switch it on", async () => {
    client.fetchEvidenceMaintenance.mockResolvedValue({ ...maintenance, automation: { ...maintenance.automation, enabled: false }, billing: { payer: "owner", official: false, purpose: "evidence-upkeep" } });
    render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByText("持续更新"));
    expect(await screen.findByText("自动更新的模型费用由你的额度支付")).toBeInTheDocument();
    expect(screen.queryByText(/由平台支付/)).not.toBeInTheDocument();
  });
  it("says the platform pays for an official zone, and says nothing about money when the server did not say who", async () => {
    client.fetchEvidenceMaintenance.mockResolvedValue({ ...maintenance, billing: { payer: "platform", official: true, purpose: "frontier" } });
    const { unmount } = render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByText("持续更新"));
    expect(await screen.findByText("自动更新的模型费用由平台支付")).toBeInTheDocument();
    unmount();
    client.fetchEvidenceMaintenance.mockResolvedValue(maintenance);
    render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByText("持续更新"));
    await screen.findByText("自动寻找新证据");
    expect(screen.queryByText(/模型费用/)).not.toBeInTheDocument();
  });
});
describe("zone evidence upkeep", () => {
  it("saves real settings and starts a bounded refresh from the current zone", async () => {
    render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByText("持续更新"));
    await screen.findByRole("textbox", { name: "关注的问题或检索词" });
    await userEvent.click(
      screen.getByRole("switch", { name: "循证与指南机构" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "保存更新计划" }));
    expect(client.saveEvidenceMaintenance).toHaveBeenCalledWith(
      zone,
      expect.objectContaining({ sourceTypes: ["journal", "evidence-body"] }),
    );
    await userEvent.click(screen.getByRole("button", { name: "立即更新" }));
    expect(client.refreshEvidenceZone).toHaveBeenCalledWith(zone);
    expect(await screen.findByText("正在寻找与复核新证据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即更新" })).toBeDisabled();
  });
  it("shows retry on load failure and keeps edits after save failure", async () => {
    client.fetchEvidenceMaintenance.mockRejectedValueOnce(new Error("offline"));
    render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByText("持续更新"));
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    const query = await screen.findByRole("textbox", {
      name: "关注的问题或检索词",
    });
    await userEvent.clear(query);
    await userEvent.type(query, "atrial fibrillation");
    client.saveEvidenceMaintenance.mockRejectedValue(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "保存更新计划" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(query).toHaveValue("atrial fibrillation");
  });
  it("shows retained sources as awaiting recheck even when the maintenance job completed", async () => {
    vi.useFakeTimers();
    try {
      client.fetchEvidenceMaintenance
        .mockResolvedValueOnce({ ...maintenance, jobs: { running: 1, pending: 0, failed: 0 } })
        .mockResolvedValue({
          ...maintenance,
          recent: [{ id: "job", state: "completed", attempts: 1, lastError: null, updatedAt: "2026-10-02T06:00:00Z", cardId: "card", sourceCheckStatus: "partial" }],
        });
      render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText("正在寻找与复核新证据")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(screen.getByText(/部分来源待复核，已沿用上次保留内容/)).toBeInTheDocument();
      expect(screen.getByText("本轮处理已结束；仍有部分来源待复核，可查看当前证据与来源状态。")).toBeInTheDocument();
      expect(screen.queryByText("本轮更新已结束，可查看当前证据。")).not.toBeInTheDocument();
      expect(screen.queryByText(/部分证据更新未完成/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "查看最新证据" })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it("clears an old partial result when the latest job for that card completed all source checks", async () => {
    vi.useFakeTimers();
    try {
      const job = { state: "completed", attempts: 1, lastError: null, cardId: "card" };
      client.fetchEvidenceMaintenance
        .mockResolvedValueOnce({ ...maintenance, jobs: { running: 1, pending: 0, failed: 0 } })
        .mockResolvedValue({ ...maintenance, recent: [
          { ...job, id: "maintenance", updatedAt: "2026-10-03T06:00:00Z", sourceCheckStatus: "complete" },
          { ...job, id: "discovery", updatedAt: "2026-10-02T06:00:00Z", sourceCheckStatus: "partial" },
          { ...job, id: "no-card", updatedAt: "2026-10-01T06:00:00Z", cardId: null, sourceCheckStatus: "partial" },
        ] });
      render(<EvidenceMaintenance zone={zone} onUpdated={vi.fn()} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(screen.queryByText(/部分来源待复核/)).not.toBeInTheDocument();
      expect(screen.getByText("本轮更新已结束，可查看当前证据。")).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});
