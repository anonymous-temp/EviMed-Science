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
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
  WEB_SESSION_STARTED_EVENT: "open-science:web-session-started",
}));
vi.mock("@/components/sidebar/Sidebar", () => ({ Sidebar: () => <aside>Sidebar</aside> }));
vi.mock("@/components/command-palette/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));

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
