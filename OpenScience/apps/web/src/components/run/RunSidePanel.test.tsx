import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { RunSidePanel } from "./RunSidePanel";

const mocks = vi.hoisted(() => ({
  runs: [] as WebAgentRun[],
  listWebAgentRuns: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebAgentRuns: mocks.listWebAgentRuns,
  webFileDownloadUrl: (path: string) => `/api/files/download/${encodeURIComponent(path)}`,
}));

function run(overrides: Partial<WebAgentRun> & { id: string }): WebAgentRun {
  return {
    dispatchId: null,
    question: null,
    dispatchStatus: "accepted",
    sessionId: `ses-${overrides.id}`,
    mode: "specialist",
    agentId: null,
    agentVersion: null,
    runtimeAgent: null,
    model: "deepseek",
    status: "succeeded",
    createdAt: "2026-09-04T00:00:00.000Z",
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:01:00.000Z",
    durationMs: 60_000,
    errorCode: null,
    artifacts: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [];
  mocks.listWebAgentRuns.mockImplementation(async () => mocks.runs);
});

describe("RunSidePanel", () => {
  it("opens the newest run and links its deliverables", async () => {
    mocks.runs = [
      run({ id: "r1", question: "阿司匹林的证据", artifacts: ["reports/aspirin.md"] }),
      run({ id: "r2", question: "更早的运行" }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("阿司匹林的证据")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "aspirin.md" });
    expect(link).toHaveAttribute("href", "/api/files/download/reports%2Faspirin.md");
    // The older run is listed but collapsed, so only one card's body is open.
    expect(screen.getByText("更早的运行")).toBeInTheDocument();
  });

  // The reason this panel sits beside the conversation: a transcript cannot
  // say that a finished package still has an open gate issue.
  it("states an unresolved gate verdict on a run that did deliver", async () => {
    mocks.runs = [
      run({
        id: "r1",
        question: "有待复核的运行",
        verification: "unverified",
        qualityNotices: ["两条 derived 结论没有列出敏感性分析"],
        artifacts: ["reports/x.md"],
      }),
    ];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/已交付，但未完成核验/)).toBeInTheDocument();
    expect(screen.getByText("两条 derived 结论没有列出敏感性分析")).toBeInTheDocument();
  });

  it("distinguishes a layer that never ran from a clean pass", async () => {
    mocks.runs = [run({ id: "r1", question: "没查过的运行", verification: "unchecked" })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/有一层门禁没有检查过/)).toBeInTheDocument();
  });

  it("names the failure code on a failed run", async () => {
    mocks.runs = [run({ id: "r1", question: "失败的运行", status: "failed", errorCode: "credits_exhausted" })];
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText(/credits_exhausted/)).toBeInTheDocument();
  });

  it("invites the first run when the project has none", async () => {
    render(<RunSidePanel onClose={vi.fn()} />);
    expect(await screen.findByText(/这个项目还没有运行记录/)).toBeInTheDocument();
  });

  it("reports a ledger it could not read instead of showing an empty one", async () => {
    mocks.listWebAgentRuns.mockRejectedValue(new Error("gateway down"));
    render(<RunSidePanel onClose={vi.fn()} />);

    expect(await screen.findByText("gateway down")).toBeInTheDocument();
  });

  it("closes on request", async () => {
    const onClose = vi.fn();
    render(<RunSidePanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭运行面板" }));
    expect(onClose).toHaveBeenCalled();
  });
});
