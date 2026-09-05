import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotPage } from "./AutopilotPage";

const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), createAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), scheduleAgenda: vi.fn(), listDigests: vi.fn(), decideDigest: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/apiClient", () => ({ getWebProjectId: () => "project-one", WebApiError: class WebApiError extends Error {} }));

const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, payload: { title: "心衰证据追踪", topics: ["heart failure"],
  taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "Asia/Shanghai",
  enabled: true, status: "active", pauseReason: null, outcomes: [] } };
const digest = { id: "digest-one", projectId: "project-one", revision: 1, payload: { date: "2026-09-06", costCny: 3.2,
  headlines: [{ id: "claim-one", statement: "新增直接证据" }], leads: [{ id: "claim-two", statement: "待验证线索" }], decisions: [] } };

describe("AutopilotPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listAgendas.mockResolvedValue({ items: [agenda], nextCursor: null });
    mocks.listDigests.mockResolvedValue({ items: [digest], nextCursor: null });
    mocks.createAgenda.mockResolvedValue(agenda); mocks.startAgenda.mockResolvedValue(agenda); mocks.stopAgenda.mockResolvedValue(agenda);
    mocks.scheduleAgenda.mockResolvedValue({ episode: { id: "episode-one" } }); mocks.decideDigest.mockResolvedValue(digest);
  });

  it("shows bounded agenda controls and morning findings", async () => {
    render(<AutopilotPage />);
    expect(await screen.findByRole("heading", { name: "主动科研" })).toBeInTheDocument();
    expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
    expect(screen.getByText("每日 ¥20 · 每周 ¥80 · 单回合 ¥8")).toBeInTheDocument();
    expect(screen.getByText("新增直接证据")).toBeInTheDocument();
    expect(screen.getByText("待验证线索")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "立即运行一回合" }));
    await waitFor(() => expect(mocks.scheduleAgenda).toHaveBeenCalledWith("agenda-one", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
  });

  it("records an adopt or reject decision from the digest", async () => {
    render(<AutopilotPage />);
    await userEvent.click(await screen.findByRole("button", { name: "采纳新增直接证据" }));
    await waitFor(() => expect(mocks.decideDigest).toHaveBeenCalledWith("digest-one", { action: "adopt", claimId: "claim-one", note: "" }));
    await userEvent.click(screen.getByRole("button", { name: "驳回待验证线索" }));
    await waitFor(() => expect(mocks.decideDigest).toHaveBeenCalledWith("digest-one", { action: "reject", claimId: "claim-two", note: "" }));
  });
});
