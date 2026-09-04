import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  runs: [] as WebAgentRun[],
  listWebAgentRuns: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebAgentRuns: mocks.listWebAgentRuns,
}));

vi.mock("@/lib/store", () => ({
  SIDEBAR_MIN: 220,
  SIDEBAR_MAX: 420,
  useUiStore: () => ({
    sidebarCollapsed: false,
    sidebarWidth: 260,
    setSidebarCollapsed: vi.fn(),
    setSidebarWidth: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

// The switcher fetches on mount and has its own test; here it is only a slot.
vi.mock("@/components/sidebar/ProjectSwitcher", () => ({
  ProjectSwitcher: () => <div data-testid="project-switcher" />,
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

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderSidebar(initialPath = "/app/chat") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Sidebar />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs = [];
  mocks.listWebAgentRuns.mockImplementation(async () => mocks.runs);
});

describe("Sidebar navigation", () => {
  it("lists the workbench destinations in order and navigates to each", async () => {
    renderSidebar();

    const order = ["新任务", "运行记录", "知识库", "科研笔记本", "科研记忆", "能力模板"];
    const buttons = order.map((label) => screen.getByRole("button", { name: label }));
    for (let i = 1; i < buttons.length; i += 1) {
      expect(
        buttons[i - 1].compareDocumentPosition(buttons[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    await userEvent.click(screen.getByRole("button", { name: "科研笔记本" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/notebooks");

    await userEvent.click(screen.getByRole("button", { name: "能力模板" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/capabilities");

    await userEvent.click(screen.getByRole("button", { name: "账户与额度" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/account");

    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/settings");
  });

  it("carries the brand and the project switcher above the nav", async () => {
    renderSidebar();
    expect(screen.getByRole("img", { name: "EviMed" })).toBeInTheDocument();
    expect(screen.getByTestId("project-switcher")).toBeInTheDocument();
    // Let the ledger read settle so the assertion above is not racing it.
    await screen.findByText("还没有运行记录");
  });
});

describe("Sidebar recent runs", () => {
  it("lists runs from the ledger and links each to the run it names", async () => {
    mocks.runs = [
      run({ id: "run-1", question: "阿司匹林一级预防的证据" }),
      run({ id: "run-2", question: "二甲双胍的不良反应信号" }),
    ];
    renderSidebar();

    const first = await screen.findByRole("link", { name: /阿司匹林一级预防的证据/ });
    expect(first).toHaveAttribute("href", "/app/runs?run=run-1");
    expect(screen.getByRole("link", { name: /二甲双胍的不良反应信号/ })).toBeInTheDocument();
  });

  // The whole reason this list replaced the kernel's session list: a session
  // says a conversation happened, a run says how it came out. A delivered run
  // with an open gate issue must not read the same as an accepted one.
  it("does not show a delivered-but-unverified run as a success", async () => {
    mocks.runs = [
      run({ id: "clean", question: "干净的运行" }),
      run({ id: "open", question: "有待复核的运行", verification: "unverified" }),
      run({ id: "degraded", question: "降级交付的运行", phase: "degraded" }),
    ];
    renderSidebar();

    const clean = await screen.findByRole("link", { name: /干净的运行/ });
    expect(clean.querySelector(".bg-ok")).not.toBeNull();

    for (const name of [/有待复核的运行/, /降级交付的运行/]) {
      const row = screen.getByRole("link", { name });
      expect(row.querySelector(".bg-ok")).toBeNull();
      expect(row.querySelector(".bg-warn")).not.toBeNull();
    }
  });

  it("filters the list by what the run was asked", async () => {
    mocks.runs = [
      run({ id: "run-1", question: "阿司匹林一级预防的证据" }),
      run({ id: "run-2", question: "二甲双胍的不良反应信号" }),
    ];
    renderSidebar();
    await screen.findByRole("link", { name: /阿司匹林一级预防的证据/ });

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索运行记录" }), "二甲双胍");
    expect(screen.queryByRole("link", { name: /阿司匹林一级预防的证据/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /二甲双胍的不良反应信号/ })).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索运行记录" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索运行记录" }), "不存在");
    expect(screen.getByText("没有匹配的运行")).toBeInTheDocument();
  });

  it("says so when the account has no runs yet", async () => {
    renderSidebar();
    expect(await screen.findByText("还没有运行记录")).toBeInTheDocument();
  });

  // A ledger that cannot be read is not an empty ledger. Reporting it as one
  // would tell someone their work is gone.
  it("keeps the rows it already has when the ledger read fails", async () => {
    mocks.runs = [run({ id: "run-1", question: "已经读到的运行" })];
    renderSidebar();
    await screen.findByRole("link", { name: /已经读到的运行/ });

    mocks.listWebAgentRuns.mockRejectedValue(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByRole("link", { name: /已经读到的运行/ })).toBeInTheDocument());
    expect(screen.queryByText("还没有运行记录")).not.toBeInTheDocument();
  });
});
