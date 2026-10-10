import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AppShell } from "./AppShell";

/**
 * On the scheduled-task page the conversation is drawn below the task bar and beside the list, so a keyboard or screen-reader
 * reader meets them in that order: the list, the bar, then the conversation (WCAG 2.4.3; review §3.4).
 *
 * The resident conversation surface (`SessionFrameHost`) is mounted once for the whole shell, above the router's outlet, and it
 * used to come first in the document: its iframe was the first thing after the sidebar in the Tab order and in the reading
 * order, ahead of the list and the bar it is drawn under and beside. It now follows the routed page. (On the chat surface the
 * route renders a title only, so nothing changes there.)
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
// The frame is an iframe in the real shell; a button stands in for the one thing a Tab stop needs, a place to land.
vi.mock("@/app/layout/SessionFrameHost", () => ({
  SessionFrameHost: () => <div data-testid="frame"><button type="button">对话</button></div>,
}));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/ShortcutHelp", () => ({ ShortcutHelp: () => null }));
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: function MockSidebar() {
    return (
      <aside aria-label="侧栏" data-sidebar="">
        <nav aria-label="工作台">
          <Link to="/app/autopilot">定时任务</Link>
          <Link to="/app/chat">新对话</Link>
        </nav>
      </aside>
    );
  },
}));

/** The task page's parts in the order it draws them: the list column, then the bar and the pane the conversation is placed over. */
function TaskPage() {
  return (
    <div data-testid="task-page">
      <section aria-label="任务列表"><a href="/app/autopilot/agenda-one">心衰证据追踪</a></section>
      <section aria-label="任务">
        <div data-task-bar=""><button type="button">立即运行</button></div>
        <div role="region" aria-label="任务对话" />
      </section>
    </div>
  );
}

function viewport() {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function renderTaskPage() {
  mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
  const router = createMemoryRouter(
    [{ path: "/app", element: <AppShell />, children: [{ path: "autopilot/:taskId?", element: <TaskPage /> }, { path: "chat", element: <div /> }] }],
    { initialEntries: ["/app/autopilot/agenda-one"] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByTestId("task-page");
}

describe("the conversation surface on the scheduled-task page", () => {
  beforeAll(() => { vi.stubGlobal("Request", SignalCompatibleRequest); });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false });
    viewport();
  });

  it("follows the page in the document: the list and the task bar come first", async () => {
    await renderTaskPage();
    const page = screen.getByTestId("task-page");
    const frame = screen.getByTestId("frame");
    expect(page.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("is reached by Tab after the task list and the task bar, not before them", async () => {
    const user = userEvent.setup();
    await renderTaskPage();
    screen.getByRole("link", { name: "新对话" }).focus();
    await user.tab();
    expect(screen.getByRole("link", { name: "心衰证据追踪" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "立即运行" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "对话" })).toHaveFocus();
  });
});
