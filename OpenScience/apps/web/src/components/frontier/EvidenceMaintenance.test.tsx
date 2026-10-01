import { render, screen } from "@testing-library/react";
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
});
