import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import type { RunStreamEvent } from "@/lib/runEvents";
import { RunsPage } from "./RunsPage";

const api = vi.hoisted(() => ({
  listWebAgentRuns: vi.fn(),
  cancelWebAgentRun: vi.fn(),
  renameWebAgentRun: vi.fn(),
  steerWebAgentRun: vi.fn(),
  listWebDeliverableFeedback: vi.fn(),
  reportWebDeliverableFeedback: vi.fn(),
}));
const live = vi.hoisted(() => ({ events: [] as RunStreamEvent[] }));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  ...api,
  fetchWebConnectors: async () => [],
  fetchWebMe: async () => ({ user: { id: "u", name: "u" }, operator: false, project: { id: "default", name: "我的研究" }, projects: [] }),
}));
// The page reads each running run's stream through this hook; the stream
// itself has its own tests (runEvents.test.ts).
vi.mock("@/lib/runEvents", () => ({
  useRunEvents: (runId: string | null) => ({ events: runId ? live.events : [], lastEvent: null, connected: Boolean(runId) }),
}));

function run(overrides: Partial<WebAgentRun> = {}): WebAgentRun {
  const now = new Date().toISOString();
  return {
    id: "run-1", dispatchId: null, dispatchStatus: "accepted", sessionId: "ses-1", mode: "specialist",
    agentId: "clinical-evidence-synthesis", agentVersion: null, runtimeAgent: null, model: "deepseek-flash",
    status: "succeeded", createdAt: now, startedAt: now, finishedAt: now, durationMs: 1_500_000, errorCode: null,
    artifacts: ["deliverables/clinical-evidence-report.md"],
    ...overrides,
  };
}

const renderPage = () => render(<MemoryRouter initialEntries={["/app/runs"]}><RunsPage /></MemoryRouter>);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  live.events = [];
  api.listWebDeliverableFeedback.mockResolvedValue([]);
});

describe("an open ledger row", () => {
  // The first thing under an open row was 「技术标识（供排查使用）」 — the one
  // section whose purpose is not to be first (review B §4a).
  it("leads with the products and ends with the identifiers", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({
      verification: "unverified",
      qualityNotices: [{ code: "x", severity: "advice", title: "数字未在所引原文中出现", text: "legacy" }],
      deliverables: [{ id: "d1", title: "证据综述报告", status: "delivered", attempts: 2, lastVerdict: "unverified" }],
      recalledMemories: [{ id: "m1", kind: "preference", scope: "user" }],
    })]);
    renderPage();
    const products = await screen.findByRole("heading", { name: "产物" });
    const check = screen.getByRole("region", { name: "核验结果" });
    const progress = screen.getByRole("heading", { name: /^交付进度/ });
    const memories = screen.getByText(/个性化依据 1 条/);
    const identifiers = screen.getByText("技术标识（供排查使用）");
    const order = [products, check, progress, memories, identifiers];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // A real heading, not a 12 px uppercase label.
    expect(products.tagName).toBe("H3");
  });

  // Kept after the run ends: which deliverable went back, how many times.
  it("keeps the plan with each deliverable's submissions and verdict after the run ended", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({
      deliverables: [
        { id: "d1", title: "证据综述报告", status: "delivered", attempts: 3, lastVerdict: "unverified" },
        { id: "d2", title: "证据矩阵", status: "failed", attempts: 2, lastVerdict: "issues", mustFixCount: 4 },
      ],
    })]);
    renderPage();
    const steps = await screen.findByRole("list", { name: "交付进度" });
    expect(steps).toHaveTextContent("证据综述报告已交付 · 第 3 次提交 · 未核验交付");
    expect(steps).toHaveTextContent("证据矩阵未完成 · 第 2 次提交 · 4 项必须修改");
  });

  it("says how many claims were checked in one sentence", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({ claimSummary: { total: 72, verified: 68, unverified: 4 } })]);
    renderPage();
    expect(await screen.findByText("72 条结论，68 条引文已核对，4 条未核对")).toBeInTheDocument();
  });

  it("says what the run cost and how long it took", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({
      usage: { requests: 120, inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, costCny: 1.234 },
    })]);
    renderPage();
    const row = await screen.findByRole("button", { name: /临床证据深度分析/, expanded: true });
    expect(row).toHaveTextContent("用时 25 分钟");
    expect(row).toHaveTextContent("¥1.23");
  });

  // 采纳 / 我改过 used to be posted and never read back, so a reload offered
  // both again on a file already adopted (review B §4h).
  it("reads back what the researcher already reported about a deliverable", async () => {
    api.listWebAgentRuns.mockResolvedValue([run()]);
    api.listWebDeliverableFeedback.mockResolvedValue([{ id: "f1", trigger: "deliverable-adopted", detail: {} }]);
    renderPage();
    expect(await screen.findByText("已记录：这份成果被采纳。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "采纳" })).not.toBeInTheDocument();
    // An edit after an adoption is still worth reporting.
    expect(screen.getByRole("button", { name: "我改过" })).toBeInTheDocument();
    expect(api.listWebDeliverableFeedback).toHaveBeenCalledWith("run-1", "deliverables/clinical-evidence-report.md");
  });
});

describe("a running run", () => {
  it("shows live progress from the run's own event stream, as counts and never a percentage", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({ status: "running", finishedAt: null, durationMs: null, artifacts: [] })]);
    live.events = [{
      seq: 4, time: new Date().toISOString(), type: "run/progress",
      deliverables: [{ id: "d1", title: "证据综述报告", status: "rejected", attempts: 2, lastVerdict: "issues", mustFixCount: 3 }],
      phaseCounts: { search: 6, screen: 1, fulltext: 13, claims: 41, write: 2, deliver: 1 },
      currentPhase: "claims",
      sources: { searched: 120, included: 23, fullText: 13 },
      claims: { total: 72, verified: 41 },
      children: [{ childSessionId: "c1", deliverableId: "d1", state: "running", lastActivityAt: null }],
      startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }];
    renderPage();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("正在核验");
    expect(status).toHaveTextContent("检索 6 次 · 纳入 23 篇 · 全文 13 篇 · 结论 41/72 已核对");
    expect(status).toHaveTextContent("子任务 1/1 运行中");
    expect(status.textContent).not.toMatch(/%/);
    // The plan follows the stream, not the 20 s poll.
    expect(screen.getByRole("list", { name: "交付进度" })).toHaveTextContent("证据综述报告需修改 · 第 2 次提交 · 3 项必须修改");
  });

  it("stops only after the researcher confirms", async () => {
    const running = run({ status: "running", finishedAt: null, durationMs: null, artifacts: [] });
    api.listWebAgentRuns.mockResolvedValue([running]);
    api.cancelWebAgentRun.mockResolvedValue({ ...running, status: "canceled" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "取消运行" }));
    const dialog = screen.getByRole("alertdialog", { name: "取消这次运行？" });
    expect(dialog).toHaveTextContent("包括它委派出去的子任务");
    expect(api.cancelWebAgentRun).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "取消运行" }));
    await waitFor(() => expect(api.cancelWebAgentRun).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByRole("button", { name: /临床证据深度分析/, expanded: true })).toHaveTextContent("已取消");
  });

  it("takes a correction without restarting the run", async () => {
    api.listWebAgentRuns.mockResolvedValue([run({ status: "running", finishedAt: null, durationMs: null, artifacts: [] })]);
    api.steerWebAgentRun.mockResolvedValue({ id: "run-1", corrections: 1 });
    renderPage();
    await userEvent.click(await screen.findByText("补充条件或调整方向"));
    await userEvent.type(screen.getByRole("textbox", { name: "给正在进行的运行补充" }), "只看 70 岁以上人群");
    await userEvent.click(screen.getByRole("button", { name: "发送补充" }));
    await waitFor(() => expect(api.steerWebAgentRun).toHaveBeenCalledWith("run-1", "只看 70 岁以上人群"));
    expect(await screen.findByText("已送达，这是第 1 次补充。")).toBeInTheDocument();
  });
});

describe("naming a run", () => {
  it("renames in place and locks the name against automatic titles", async () => {
    api.listWebAgentRuns.mockResolvedValue([run()]);
    api.renameWebAgentRun.mockResolvedValue({ ...run(), title: "≥70 岁阿司匹林一级预防", titleSource: "user" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "重命名「临床证据深度分析」" }));
    const input = screen.getByRole("textbox", { name: "运行标题" });
    await userEvent.clear(input);
    await userEvent.type(input, "≥70 岁阿司匹林一级预防{Enter}");
    await waitFor(() => expect(api.renameWebAgentRun).toHaveBeenCalledWith("run-1", "≥70 岁阿司匹林一级预防"));
    const row = await screen.findByRole("button", { name: /≥70 岁阿司匹林一级预防/, expanded: true });
    expect(row.querySelector("[title*='自动命名不会覆盖']")).not.toBeNull();
  });
});
