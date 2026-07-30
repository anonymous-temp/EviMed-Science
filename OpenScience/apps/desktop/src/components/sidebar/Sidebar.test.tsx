import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; title: string; parentId?: string }>,
  sessionTitles: {} as Record<string, string>,
  runningSessions: {} as Record<string, true>,
  threads: {} as Record<string, { blocks: Array<Record<string, unknown>>; index: Record<string, number>; loaded: boolean }>,
  startDraft: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  /** Hosted-web flag: memory/workflow nav entries exist only online. */
  hasWebApi: true,
}));

vi.mock("@/lib/runtime", () => ({
  useRuntimeStore: () => ({
    sessions: mocks.sessions,
    sessionTitles: mocks.sessionTitles,
    runningSessions: mocks.runningSessions,
    threads: mocks.threads,
    startDraft: mocks.startDraft,
    deleteSession: mocks.deleteSession,
    renameSession: mocks.renameSession,
  }),
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

vi.mock("@/lib/tauri", () => ({ isTauri: false }));
vi.mock("@/lib/apiClient", () => ({
  get hasWebApi() {
    return mocks.hasWebApi;
  },
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderSidebar(initialPath = "/") {
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
  mocks.sessions = [];
  mocks.sessionTitles = {};
  mocks.runningSessions = {};
  mocks.threads = {};
  mocks.hasWebApi = true;
});

describe("Sidebar research-agent navigation", () => {
  it("places notebooks, memory, and Research Agents below Files and navigates correctly", async () => {
    renderSidebar();

    const files = screen.getByRole("button", { name: "知识库" });
    const notebooks = screen.getByRole("button", { name: "科研笔记本" });
    const memory = screen.getByRole("button", { name: "科研记忆" });
    const researchAgents = screen.getByRole("button", { name: "科研工作流" });
    expect(files.compareDocumentPosition(notebooks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notebooks.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(memory.compareDocumentPosition(researchAgents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skills" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Model not set/i)).not.toBeInTheDocument();
    expect(screen.getByText("EviMed")).toBeInTheDocument();
    expect(screen.queryByText("Open Science")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "EviMed" })).toBeInTheDocument();

    await userEvent.click(notebooks);
    expect(screen.getByTestId("location")).toHaveTextContent("/notebooks");

    await userEvent.click(memory);
    expect(screen.getByTestId("location")).toHaveTextContent("/memory");

    await userEvent.click(researchAgents);
    expect(screen.getByTestId("location")).toHaveTextContent("/agents");
  });

  it("names the first entry by what it does — start a new task, not a home page", async () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "首页" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "新任务" }));
    expect(mocks.startDraft).toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/live");
  });

  it("hides the hosted-only memory and workflow entries on the desktop", () => {
    mocks.hasWebApi = false;
    renderSidebar();
    expect(screen.queryByRole("button", { name: "科研记忆" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "科研工作流" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "科研笔记本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行记录" })).toBeInTheDocument();
  });
});

describe("Sidebar session list", () => {
  const twoSessions = [
    { id: "ses_1", title: "药物评价报告" },
    { id: "ses_2", title: "实验记录整理" },
  ];

  it("filters history rows by title from the search box", async () => {
    mocks.sessions = twoSessions;
    renderSidebar();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索历史会话" }), "药物");
    expect(screen.getByRole("link", { name: /药物评价报告/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /实验记录整理/ })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索历史会话" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索历史会话" }), "不存在");
    expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
  });

  it("renames a session inline: Enter saves, Esc cancels", async () => {
    mocks.sessions = twoSessions;
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "重命名 药物评价报告" }));
    const input = screen.getByRole("textbox", { name: "重命名 药物评价报告" });
    await userEvent.clear(input);
    await userEvent.type(input, "阿司匹林 HTA{Enter}");
    expect(mocks.renameSession).toHaveBeenCalledWith("ses_1", "阿司匹林 HTA");

    await userEvent.click(screen.getByRole("button", { name: "重命名 实验记录整理" }));
    const cancelled = screen.getByRole("textbox", { name: "重命名 实验记录整理" });
    await userEvent.type(cancelled, "临时改名{Escape}");
    expect(mocks.renameSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: /实验记录整理/ })).toBeInTheDocument();
  });

  it("shows the local title override in place of the server title", () => {
    mocks.sessions = twoSessions;
    mocks.sessionTitles = { ses_1: "阿司匹林 HTA" };
    renderSidebar();
    expect(screen.getByRole("link", { name: /阿司匹林 HTA/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /药物评价报告/ })).not.toBeInTheDocument();
  });

  it("marks running and failed sessions instead of one always-green dot", () => {
    mocks.sessions = [...twoSessions, { id: "ses_3", title: "普通会话" }];
    mocks.runningSessions = { ses_1: true };
    mocks.threads = {
      ses_2: { blocks: [{ kind: "status-line", text: "发送失败", tone: "error" }], index: {}, loaded: true },
    };
    renderSidebar();
    expect(screen.getByTitle("正在运行")).toHaveClass("animate-pulse", "bg-accent");
    expect(screen.getByTitle("上轮任务失败")).toHaveClass("bg-error");
    // No status → no visible dot (kept only for title alignment), never green.
    const plainLink = screen.getByRole("link", { name: /普通会话/ });
    expect(plainLink.querySelector(".bg-ok")).toBeNull();
    expect(document.querySelector(".bg-ok")).toBeNull();
  });

  it("keeps the delete button focusable: visible on hover AND keyboard focus", () => {
    mocks.sessions = twoSessions;
    renderSidebar();
    const deleteButton = screen.getByRole("button", { name: "删除 药物评价报告" });
    expect(deleteButton.parentElement).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-within:opacity-100",
    );
  });

  it("still confirms before deleting", async () => {
    mocks.sessions = twoSessions;
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "删除 药物评价报告" }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(mocks.deleteSession).toHaveBeenCalledWith("ses_1");
  });
});
