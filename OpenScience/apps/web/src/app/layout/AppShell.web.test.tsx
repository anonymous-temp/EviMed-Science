import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const NativeRequest = globalThis.Request;

class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: undefined } : init);
  }
}

const mocks = vi.hoisted(() => {
  const clearProjects = vi.fn();
  const fetchWebMe = vi.fn();
  const useProjectStore = Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ clear: clearProjects })),
  });
  const useUiStore = Object.assign(
    vi.fn(() => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: vi.fn(),
    })),
    { getState: vi.fn(() => ({ toggleSidebar: vi.fn() })) },
  );
  return { clearProjects, fetchWebMe, useProjectStore, useUiStore };
});

vi.mock("@/lib/projects", () => ({ useProjectStore: mocks.useProjectStore }));
vi.mock("@/lib/store", () => ({ useUiStore: mocks.useUiStore }));
vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  getWebProjectId: () => "default",
  listWebAgentRuns: vi.fn(),
  listWebProjects: vi.fn(),
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
  WEB_SESSION_STARTED_EVENT: "open-science:web-session-started",
}));
// The conversation surface the shell now hosts above the router has its own
// tests (RuntimeUiFrame.test.tsx); this file is about the authentication gate.
vi.mock("@/app/layout/SessionFrameHost", () => ({ SessionFrameHost: () => null }));
vi.mock("@/components/sidebar/Sidebar", () => ({ Sidebar: () => <aside>Sidebar</aside> }));
vi.mock("@/components/command-palette/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));
// The login-time connector prompt has its own test; here it is a slot.

function renderRoute(path = "/app/chat") {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <main>账号密码登录</main> },
      {
        path: "/app",
        element: <AppShell />,
        children: [
          { path: "chat", element: <main>Chat workspace</main> },
          { path: "settings", element: <main>账户</main> },
          { path: "autopilot", element: <aside aria-label="定时任务列表">Task context</aside> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("AppShell hosted authentication gate", () => {
  beforeAll(() => {
    vi.stubGlobal("Request", SignalCompatibleRequest);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useUiStore.mockReturnValue({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() });
  });

  it("redirects an unauthenticated browser to the standalone login page", async () => {
    mocks.fetchWebMe.mockResolvedValue(null);
    renderRoute();

    expect(screen.getByLabelText("正在检查登录状态")).toBeInTheDocument();
    expect(await screen.findByText("账号密码登录")).toBeInTheDocument();
  });

  it("renders the workbench once the account answers", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute();

    expect(await screen.findByText("Chat workspace")).toBeInTheDocument();
  });
  // 2026-10-07 audit (live A01): the rebuilt 定时任务 page kept the old own-shell hack and dropped the global sidebar, the expand
  // button and Ctrl+B — a dead end with no way to any other page. It is an ordinary page of the workbench.
  it.each(["/app/autopilot", "/app/autopilot/"])("keeps the workbench sidebar and its toggle on %s, as on every other page", async (path) => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    const router = renderRoute(path);
    expect(await screen.findByLabelText("定时任务列表")).toBeInTheDocument();
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭侧边栏" })).toBeInTheDocument();
    await router.navigate("/app/chat");
    expect(await screen.findByText("Sidebar")).toBeInTheDocument();
  });

  it("offers the expand button on 定时任务 when the sidebar is collapsed", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    mocks.useUiStore.mockReturnValue({ sidebarCollapsed: true, setSidebarCollapsed: vi.fn() });
    renderRoute("/app/autopilot");
    expect(await screen.findByLabelText("定时任务列表")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭侧边栏" })).not.toBeInTheDocument();
  });

  // Spec §10.3, appendix E #3: the first thing Tab reaches is a way past the
  // sidebar, and it lands focus on the page's main region.
  it("opens with a skip link that moves focus to the main region", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute("/app/settings");
    await screen.findByText("账户");

    const skip = screen.getByRole("link", { name: "跳到主要内容" });
    expect(skip).toHaveClass("sr-only", "focus:not-sr-only", "focus:z-skip");
    // The first focusable element in the shell.
    const focusable = document.querySelectorAll("a[href], button, [tabindex]:not([tabindex='-1'])");
    expect(focusable[0]).toBe(skip);
    fireEvent.click(skip);
    expect(document.getElementById("main")).toHaveFocus();
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
  });

  // Audit F-G6: the EviMed Vue shell mounts a Science page with ?embed=1 and
  // draws its own sidebar around it.
  it("renders only the content area when embedded, and keeps it that way after a link drops the query", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    const router = renderRoute("/app/settings?embed=1");
    expect(await screen.findByText("账户")).toBeInTheDocument();
    expect(screen.queryByText("Sidebar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "跳到主要内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开侧边栏" })).not.toBeInTheDocument();

    await router.navigate("/app/chat");
    expect(await screen.findByText("Chat workspace")).toBeInTheDocument();
    expect(screen.queryByText("Sidebar")).not.toBeInTheDocument();
  });

  it("is an ordinary shell with embed=0 or no flag", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute("/app/settings?embed=0");
    expect(await screen.findByText("账户")).toBeInTheDocument();
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
  });

  // Logging out has to drop the previous account's projects from this tab.
  // Leaving them behind is how the next person to log in on a shared machine
  // sees a project list that is not theirs.
  it("clears the account's projects and returns to login when the session ends", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute();
    expect(await screen.findByText("Chat workspace")).toBeInTheDocument();

    fireEvent(window, new Event("open-science:web-session-ended"));

    expect(await screen.findByText("账号密码登录")).toBeInTheDocument();
    await waitFor(() => expect(mocks.clearProjects).toHaveBeenCalledTimes(1));
  });
});
