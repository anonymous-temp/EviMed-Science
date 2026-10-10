import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, useEffect, type ReactElement } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PageShell } from "@/components/layout/PageShell";
import { useUiStore } from "@/lib/store";
import { AppShell } from "./AppShell";

/**
 * A click on the sidebar that opens a page whose chunk is still in flight shows that the page is coming: the
 * router navigates in a transition, and with one Suspense boundary for every page the previous page stayed on
 * screen with nothing to say the click was taken (live walk 2026-10-10: 科研工具 stayed 11 s under
 * /app/virtual-research while its chunk loaded).
 */

const NativeRequest = globalThis.Request;
class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: undefined } : init);
  }
}

const mocks = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: Object.assign(vi.fn(() => "default"), { getState: () => ({ clear: vi.fn() }) }),
}));
vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  getWebProjectId: () => "default",
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
  WEB_SESSION_STARTED_EVENT: "open-science:web-session-started",
}));
vi.mock("@/app/layout/SessionFrameHost", () => ({ SessionFrameHost: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/ShortcutHelp", () => ({ ShortcutHelp: () => null }));
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: function MockSidebar() {
    return (
      <aside aria-label="侧栏" data-sidebar="">
        <nav aria-label="工作台">
          <Link to="/app/tools">科研工具</Link>
          <Link to="/app/studies">虚拟临床研究</Link>
          <Link to="/app/geo/one/overview">总览</Link>
          <Link to="/app/geo/one/sources">信源</Link>
        </nav>
      </aside>
    );
  },
}));

function viewport() {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("a page whose chunk is still loading", () => {
  beforeAll(() => { vi.stubGlobal("Request", SignalCompatibleRequest); });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false });
    viewport();
  });

  it("replaces the previous page with the loading state instead of leaving it on screen, then shows the new page", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    let arrive: (module: { default: () => ReactElement }) => void = () => {};
    const SlowStudies = lazy(() => new Promise<{ default: () => ReactElement }>((resolve) => { arrive = resolve; }));
    const router = createMemoryRouter([{
      path: "/app",
      element: <AppShell />,
      children: [
        { path: "tools", element: <PageShell title="科研工具"><p>工具列表</p></PageShell> },
        { path: "studies", element: <SlowStudies /> },
      ],
    }], { initialEntries: ["/app/tools"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("工具列表")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "虚拟临床研究" }));
    expect(await screen.findByText("正在载入")).toBeInTheDocument();
    expect(screen.queryByText("工具列表")).toBeNull();
    await act(async () => { arrive({ default: () => <PageShell title="虚拟临床研究"><p>研究列表</p></PageShell> }); });
    expect(await screen.findByText("研究列表")).toBeInTheDocument();
  });

  it("keeps a page mounted when only its parameters change, so a tab switch does not flash the loading state", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    let mounts = 0;
    function GeoPage() {
      useEffect(() => { mounts += 1; }, []);
      return <PageShell title="循证 GEO"><p>项目页</p></PageShell>;
    }
    const router = createMemoryRouter([{
      path: "/app",
      element: <AppShell />,
      children: [{ path: "geo/:geoId/:tab?", element: <GeoPage /> }],
    }], { initialEntries: ["/app/geo/one/overview"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("项目页")).toBeInTheDocument();
    const before = mounts;
    await userEvent.click(screen.getByRole("link", { name: "信源" }));
    expect(router.state.location.pathname).toBe("/app/geo/one/sources");
    expect(screen.getByText("项目页")).toBeInTheDocument();
    expect(screen.queryByText("正在载入")).toBeNull();
    // A re-render is fine; a remount would mean the boundary was rebuilt.
    expect(before).toBe(1);
    expect(mounts).toBe(before);
  });
});
