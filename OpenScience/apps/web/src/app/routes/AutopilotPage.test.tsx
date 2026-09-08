import { act, render as renderView, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotPage } from "./AutopilotPage";

const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), createAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), scheduleAgenda: vi.fn(), listDigests: vi.fn(), decideDigest: vi.fn(), getDigest: vi.fn(), markDigestOpened: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
// Partial: only the project identity is stubbed. A total mock listing two
// exports by hand is a list that goes stale — it did, the moment the error
// dictionary gained `webErrorMessage`, and this page stopped rendering at all
// while the failure read as three missing strings. The real `webErrorMessage`
// and the real `WebApiError` also mean an assertion here proves what the
// shared registry says rather than what this file made up.
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  getWebProjectId: () => "project-one",
}));

const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, payload: { title: "心衰证据追踪", topics: ["heart failure"],
  taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "Asia/Shanghai",
  enabled: true, status: "active", pauseReason: null, outcomes: [] } };
const digest = { id: "digest-one", projectId: "project-one", revision: 1, payload: { date: "2026-09-06", costCny: 3.2,
  headlines: [{ id: "claim-one", statement: "新增直接证据" }], leads: [{ id: "claim-two", statement: "待验证线索" }], decisions: [] } };

function render(page = "/app/autopilot?digest=digest-one") {
  return renderView(<MemoryRouter initialEntries={[page]}><AutopilotPage /></MemoryRouter>);
}

describe("AutopilotPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listAgendas.mockResolvedValue({ items: [agenda], nextCursor: null });
    mocks.listDigests.mockResolvedValue({ items: [digest], nextCursor: null });
    mocks.createAgenda.mockResolvedValue(agenda); mocks.startAgenda.mockResolvedValue(agenda); mocks.stopAgenda.mockResolvedValue(agenda);
    mocks.scheduleAgenda.mockResolvedValue({ episode: { id: "episode-one" } }); mocks.decideDigest.mockResolvedValue(digest);
    mocks.getDigest.mockResolvedValue(digest); mocks.markDigestOpened.mockResolvedValue(digest);
  });

  it("shows bounded agenda controls and morning findings", async () => {
    render();
    expect(await screen.findByRole("heading", { name: "主动科研" })).toBeInTheDocument();
    expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
    expect(screen.getByText("每日 ¥20 · 每周 ¥80 · 单回合 ¥8")).toBeInTheDocument();
    expect(screen.getByText("新增直接证据")).toBeInTheDocument();
    expect(screen.getAllByText("待验证线索").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "立即运行一回合" }));
    await waitFor(() => expect(mocks.scheduleAgenda).toHaveBeenCalledWith("agenda-one", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
  });

  it("records an adopt or reject decision from the digest", async () => {
    render();
    await userEvent.click(await screen.findByRole("button", { name: "采纳新增直接证据" }));
    await waitFor(() => expect(mocks.decideDigest).toHaveBeenCalledWith("digest-one", { action: "adopt", claimId: "claim-one", note: "" }));
    await userEvent.click(screen.getByRole("button", { name: "驳回待验证线索" }));
    await waitFor(() => expect(mocks.decideDigest).toHaveBeenCalledWith("digest-one", { action: "reject", claimId: "claim-two", note: "" }));
  });

  it("sends a follow-up question with its text and shows what was already decided", async () => {
    const decided = { ...digest, payload: { ...digest.payload, decisions: [{ action: "reject", claimId: "claim-two", note: "" }] } };
    mocks.listDigests.mockResolvedValue({ items: [decided], nextCursor: null });
    mocks.getDigest.mockResolvedValue(decided); mocks.decideDigest.mockResolvedValue(decided);
    render();
    expect(await screen.findByText("已记住：不再按这个方向")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "追问新增直接证据" }));
    const send = screen.getByRole("button", { name: "发送追问" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("追问"), "在 HFpEF 里也成立吗？");
    await userEvent.click(send);
    await waitFor(() => expect(mocks.decideDigest).toHaveBeenCalledWith("digest-one", { action: "question", claimId: "claim-one", note: "在 HFpEF 里也成立吗？" }));
    expect(mocks.decideDigest).toHaveBeenCalledTimes(1);
  });

  it("records opening only after the selected digest loads and uses its actual owned project", async () => {
    let finish!: (value: typeof digest) => void;
    mocks.getDigest.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render("/app/autopilot?digest=digest-other");
    await waitFor(() => expect(mocks.getDigest).toHaveBeenCalledWith("digest-other"));
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
    const other = { ...digest, id: "digest-other", projectId: "another-owned-project" };
    mocks.listDigests.mockResolvedValue({ items: [other], nextCursor: null });
    finish(other);
    expect(await screen.findByText("新增直接证据")).toBeInTheDocument();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-other"));
    expect(mocks.listAgendas).toHaveBeenCalledWith("another-owned-project");
    expect(mocks.listDigests).not.toHaveBeenCalledWith("project-one");
  });

  it("listing digests does not record reading and requires opening the selected contents", async () => {
    render("/app/autopilot");
    await waitFor(() => expect(mocks.listDigests).toHaveBeenCalledWith("project-one"));
    expect(mocks.getDigest).not.toHaveBeenCalled();
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "查看简报" }));
    expect(await screen.findByText("新增直接证据")).toBeInTheDocument();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one"));
  });

  it("a failed or inaccessible digest is retryable without recording an open", async () => {
    mocks.getDigest.mockRejectedValue(new Error("unavailable"));
    render();
    expect(await screen.findByText(/主动科研状态不可用/)).toBeInTheDocument();
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
    mocks.getDigest.mockResolvedValue(digest);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("新增直接证据")).toBeInTheDocument();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledTimes(1));
  });

  it("does not record a digest whose response arrives after leaving the page", async () => {
    let finish!: (value: typeof digest) => void;
    mocks.getDigest.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const page = render();
    await waitFor(() => expect(mocks.getDigest).toHaveBeenCalled());
    page.unmount();
    finish(digest);
    await Promise.resolve();
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
  });

  it("keeps loaded content visible when recording the open fails and offers retry", async () => {
    mocks.markDigestOpened.mockRejectedValueOnce(new Error("activity unavailable")).mockResolvedValue(digest);
    render();
    expect(await screen.findByText(/阅读记录未保存/)).toBeInTheDocument();
    expect(screen.getByText("新增直接证据")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledTimes(2));
  });

  it("retains an actionable open failure after a decision reloads the same digest", async () => {
    let rejectOpening!: (error: Error) => void;
    mocks.markDigestOpened.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOpening = reject; }))
      .mockResolvedValue(digest);
    render();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "采纳新增直接证据" }));
    await waitFor(() => expect(mocks.getDigest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "采纳新增直接证据" })).toBeEnabled());
    await act(async () => { rejectOpening(new Error("agenda update interrupted")); });
    expect(await screen.findByText(/阅读记录未保存/)).toBeInTheDocument();
    expect(mocks.markDigestOpened).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/阅读记录未保存/)).not.toBeInTheDocument());
  });

  it("says how far each finding was checked, and says so out loud when a re-check overturned one", async () => {
    // A digest whose headline was independently reproduced and whose lead was
    // refuted after the researcher had already been shown it. Without this the
    // page presents both in the same voice, which is the exact confusion the
    // tiers exist to prevent.
    const verified = { ...digest, payload: { ...digest.payload,
      headlines: [{ id: "claim-one", statement: "新增直接证据", tier: "reproduced", refutation: "stands" }],
      leads: [
        { id: "claim-two", statement: "待验证线索", tier: "unverified", refutation: "refuted",
          verification: { status: "recorded", verdict: "refuted" } },
        { id: "claim-three", statement: "尚未复核的线索", tier: "gated", verification: { status: "queued" } },
        { id: "claim-four", statement: "名额之外的线索", tier: "gated",
          verification: { status: "unscheduled", reason: "verification_cap" } },
      ] } };
    mocks.listDigests.mockResolvedValue({ items: [verified], nextCursor: null });
    mocks.getDigest.mockResolvedValue(verified);
    render();
    expect(await screen.findByText("独立复核已复现")).toBeInTheDocument();
    expect(screen.getByText("独立复核未能复现，已降级为线索")).toBeInTheDocument();
    expect(screen.getByText("独立复核排队中")).toBeInTheDocument();
    // The refutation is the one line that must not read like the others.
    expect(screen.getByText("独立复核未能复现，已降级为线索").className).toContain("text-error");
    expect(screen.getByText("独立复核排队中").className).toContain("text-muted");
    // A claim the cap left out is not a claim waiting its turn, and a reader
    // who cannot tell them apart waits for something that is never coming.
    expect(screen.getByText("本轮复核名额已满，未安排独立复核")).toBeInTheDocument();
  });

  it("ignores an older digest's open failure after navigating to another digest", async () => {
    let rejectOpening!: (error: Error) => void;
    const other = { ...digest, id: "digest-other", payload: { ...digest.payload,
      headlines: [{ id: "claim-other", statement: "另一份简报内容" }], leads: [] } };
    mocks.getDigest.mockImplementation(async (id) => id === other.id ? other : digest);
    mocks.listDigests.mockResolvedValue({ items: [digest, other], nextCursor: null });
    mocks.markDigestOpened.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOpening = reject; }))
      .mockResolvedValue(other);
    render();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledWith(digest.id));
    await userEvent.click(screen.getByRole("button", { name: "查看简报" }));
    expect(await screen.findByText("另一份简报内容")).toBeInTheDocument();
    await waitFor(() => expect(mocks.markDigestOpened).toHaveBeenCalledWith(other.id));
    await act(async () => { rejectOpening(new Error("old activity failure")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
