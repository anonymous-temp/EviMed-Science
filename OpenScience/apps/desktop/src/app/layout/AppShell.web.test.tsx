import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const NativeRequest = globalThis.Request;

class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: undefined } : init);
  }
}

const mocks = vi.hoisted(() => {
  const bootstrap = vi.fn();
  const clearHostedSession = vi.fn();
  const fetchWebMe = vi.fn();
  const ensureJupyter = vi.fn();
  const useRuntimeStore = Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ bootstrap, clearHostedSession })),
  });
  const useUiStore = Object.assign(
    vi.fn(() => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: vi.fn(),
    })),
    { getState: vi.fn(() => ({ toggleSidebar: vi.fn() })) },
  );
  return { bootstrap, clearHostedSession, fetchWebMe, ensureJupyter, useRuntimeStore, useUiStore };
});

vi.mock("@/lib/runtime", () => ({ useRuntimeStore: mocks.useRuntimeStore }));
vi.mock("@/lib/store", () => ({ useUiStore: mocks.useUiStore }));
vi.mock("@/lib/tauri", () => ({
  ensureJupyter: mocks.ensureJupyter,
  isTauri: false,
  openExternal: vi.fn(),
}));
vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  hasWebApi: true,
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
  WEB_SESSION_STARTED_EVENT: "open-science:web-session-started",
}));
vi.mock("@/components/sidebar/Sidebar", () => ({ Sidebar: () => <aside>Sidebar</aside> }));
vi.mock("@/components/command-palette/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));

function renderRoute(path = "/live") {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <main>账号密码登录</main> },
      {
        path: "/",
        element: <AppShell />,
        children: [
          { path: "live", element: <main>Live workspace</main> },
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

  it("redirects an unauthenticated browser to the standalone login page without starting a runtime", async () => {
    mocks.fetchWebMe.mockResolvedValue(null);
    renderRoute();

    expect(screen.getByLabelText("正在检查登录状态")).toBeInTheDocument();
    expect(await screen.findByText("账号密码登录")).toBeInTheDocument();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("starts only the hosted runtime after authentication without probing Jupyter provisioning", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute();

    expect(await screen.findByText("Live workspace")).toBeInTheDocument();
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(1));
    expect(mocks.ensureJupyter).not.toHaveBeenCalled();
  });

  it("clears runtime memory and returns to login when the hosted session ends", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderRoute();
    expect(await screen.findByText("Live workspace")).toBeInTheDocument();

    fireEvent(window, new Event("open-science:web-session-ended"));

    expect(await screen.findByText("账号密码登录")).toBeInTheDocument();
    expect(mocks.clearHostedSession).toHaveBeenCalledTimes(1);
  });
});
