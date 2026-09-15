import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  runs: [] as WebAgentRun[],
  listWebAgentRuns: vi.fn(),
  listInbox: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  listWebAgentRuns: mocks.listWebAgentRuns,
  getWebProjectId: () => "default",
}));

vi.mock("@/lib/inboxClient", () => ({ listInbox: mocks.listInbox }));

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
  const location = useLocation();
  return <div data-testid="location">{location.pathname}<span data-testid="intent">{JSON.stringify(location.state?.runtimeUiIntent)}</span></div>;
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
  mocks.listInbox.mockResolvedValue({ items: [], nextCursor: null });
});

describe("Sidebar navigation", () => {
  it("makes repeated new-task clicks distinct native requests even on the same route", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "新任务" }));
    const first = JSON.parse(screen.getByTestId("intent").textContent!);
    await userEvent.click(screen.getByRole("button", { name: "新任务" }));
    const second = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(first).toMatchObject({ kind: "create", projectId: "default" });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  // Six rows and one footer row. Ten rows with no grouping described the
  // implementation's modules, not the researcher's work (2026-09-15 walk, C8),
  // and three of them were views of one body of material.
  it("lists the workbench destinations in order and navigates to each", async () => {
    renderSidebar();

    const order = ["新任务", "运行记录", "知识库", "记忆", "主动科研", "科研能力"];
    const buttons = order.map((label) => screen.getByRole("button", { name: label }));
    for (let i = 1; i < buttons.length; i += 1) {
      expect(
        buttons[i - 1].compareDocumentPosition(buttons[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    await userEvent.click(screen.getByRole("button", { name: "知识库" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/files");

    await userEvent.click(screen.getByRole("button", { name: "科研能力" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/capabilities");

    await userEvent.click(screen.getByRole("button", { name: "账户与设置" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/account");
  });

  // The rows that used to be here and are now tabs of one of the six. The
  // inbox is not in this list: it is still reachable, as the bell above.
  it("no longer offers a row for a view of another destination", async () => {
    renderSidebar();
    for (const gone of ["资料整理", "科研笔记本", "科研记忆", "记忆胶囊", "能力模板", "设置", "账户与额度"]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    await screen.findByText("还没有任务");
  });

  it("carries the brand, the inbox bell and the project switcher above the nav", async () => {
    mocks.listInbox.mockResolvedValue({ items: [{ id: "n1" }, { id: "n2" }], nextCursor: null });
    renderSidebar();
    expect(screen.getByRole("img", { name: "EviMed" })).toBeInTheDocument();
    expect(screen.getByTestId("project-switcher")).toBeInTheDocument();
    // One old notification did not earn a permanent navigation row; an unread
    // count does earn a badge.
    const bell = await screen.findByRole("button", { name: "收件箱，2 条未读" });
    await userEvent.click(bell);
    expect(screen.getByTestId("location")).toHaveTextContent("/app/inbox");
  });
});

describe("Sidebar recent runs", () => {
  // Back into the conversation. This is the product's only session list now
  // that the kernel's own left column is a rail, so it has to open the thing
  // itself rather than the ledger row about it.
  it("lists runs from the ledger and opens the conversation each belongs to", async () => {
    mocks.runs = [
      run({ id: "run-1", question: "阿司匹林一级预防的证据" }),
      run({ id: "run-2", question: "二甲双胍的不良反应信号" }),
    ];
    renderSidebar();

    const first = await screen.findByRole("link", { name: /阿司匹林一级预防的证据/ });
    expect(first).toHaveAttribute("href", "/app/chat/ses-run-1");
    expect(screen.getByRole("link", { name: /二甲双胍的不良反应信号/ })).toBeInTheDocument();
  });

  // A run whose session id is not addressable still has a ledger entry.
  it("falls back to the ledger for a run with no addressable session", async () => {
    mocks.runs = [run({ id: "run-1", question: "早期的运行", sessionId: "not a session id" })];
    renderSidebar();
    expect(await screen.findByRole("link", { name: /早期的运行/ })).toHaveAttribute("href", "/app/runs?run=run-1");
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
    expect(screen.getByText("没有匹配的任务")).toBeInTheDocument();
  });

  it("says so when the account has no runs yet", async () => {
    renderSidebar();
    expect(await screen.findByText("还没有任务")).toBeInTheDocument();
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
    expect(screen.queryByText("还没有任务")).not.toBeInTheDocument();
  });
});
