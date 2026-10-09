import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PageShell } from "@/components/layout/PageShell";
import { useUiStore } from "@/lib/store";
import { AppShell } from "./AppShell";
import { HEADING_WAIT_MS } from "./routeFocus";

/**
 * After a route change keyboard focus goes to the new page's `h1` (design reference §5.3, WCAG 2.4.3; R13 V-5): the title first,
 * then the heading, and never on the first load, on a query-only change, on the conversation surface, or off a control the
 * reader is working in.
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
// The sidebar is a landmark with links; a link there is where a keyboard reader starts.
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: function MockSidebar() {
    return (
      <aside aria-label="侧栏" data-sidebar="">
        <nav aria-label="工作台">
          <Link to="/app/files">知识库</Link>
          <Link to="/app/chat">新对话</Link>
          <Link to="/app/files?tab=sources">按类型看</Link>
        </nav>
      </aside>
    );
  },
}));

/** A page that states its title and heading the way every product page does (`PageShell`). */
const page = (title: string, body?: React.ReactNode) => (
  <PageShell title={title}>{body ?? <p>{title}的内容</p>}</PageShell>
);

/** A page whose header arrives after its first paint, as a route chunk and its data do. */
function LatePage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 30);
    return () => window.clearTimeout(timer);
  }, []);
  return ready ? page("记忆") : <p role="status">正在载入</p>;
}

/** An in-page list: choosing a row changes the path, and the row keeps focus. */
function ItemsPage() {
  return page("定时任务", (
    <ul>
      <li><Link to="/app/items/1">第一项</Link></li>
      <li><Link to="/app/items/2">第二项</Link></li>
    </ul>
  ));
}

function viewport() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function renderShell(entry: string) {
  mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
  const router = createMemoryRouter(
    [{
      path: "/app",
      element: <AppShell />,
      children: [
        { path: "chat", element: <div><h1>对话</h1></div> },
        { path: "files", element: page("知识库") },
        { path: "files/:sourceId", element: page("资料") },
        { path: "late", element: <LatePage /> },
        { path: "items", element: <ItemsPage /> },
        { path: "items/:itemId", element: <ItemsPage /> },
        { path: "quiet", element: <div><p>没有标题的页面</p></div> },
      ],
    }],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole("main");
  return router;
}

describe("a new page's heading takes focus after a route change", () => {
  beforeAll(() => { vi.stubGlobal("Request", SignalCompatibleRequest); });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false });
    viewport();
    document.title = "";
  });

  it("leaves the first load alone, so the skip link is still the first Tab stop", async () => {
    const user = userEvent.setup();
    await renderShell("/app/files");
    expect(await screen.findByRole("heading", { level: 1, name: "知识库" })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveFocus();
  });

  it("moves focus from a sidebar link to the new page's h1, with the new title already in place, and makes it no tab stop", async () => {
    const user = userEvent.setup();
    await renderShell("/app/late");
    await screen.findByRole("heading", { level: 1, name: "记忆" });
    const titlesWhenFocused: string[] = [];
    document.addEventListener("focusin", (event) => {
      if ((event.target as HTMLElement).tagName === "H1") titlesWhenFocused.push(document.title);
    });
    await user.click(screen.getByRole("link", { name: "知识库" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "知识库" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    // Title first, then the heading.
    expect(titlesWhenFocused).toEqual(["知识库 · EviMed"]);
    // Not a tab stop: Tab leaves it for the next control rather than landing on it again.
    await user.tab();
    expect(heading).not.toHaveFocus();
  });

  it("waits for a page whose heading arrives late, and does not give up on the first empty look", async () => {
    const router = await renderShell("/app/files");
    await screen.findByRole("heading", { level: 1, name: "知识库" });
    await act(async () => { await router.navigate("/app/late"); });
    expect(screen.queryByRole("heading", { level: 1, name: "记忆" })).toBeNull();
    const heading = await screen.findByRole("heading", { level: 1, name: "记忆" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("does not take the focus of a reader who moved on while the page was loading", async () => {
    const router = await renderShell("/app/files");
    await screen.findByRole("heading", { level: 1, name: "知识库" });
    await act(async () => { await router.navigate("/app/late"); });
    const elsewhere = document.createElement("input");
    elsewhere.setAttribute("aria-label", "搜索");
    document.querySelector("main")!.append(elsewhere);
    elsewhere.focus();
    const heading = await screen.findByRole("heading", { level: 1, name: "记忆" });
    expect(heading).not.toHaveFocus();
    expect(elsewhere).toHaveFocus();
  });

  it("does not move for a change of the query alone: a filter, a tab, a page number", async () => {
    const user = userEvent.setup();
    const router = await renderShell("/app/files");
    await screen.findByRole("heading", { level: 1, name: "知识库" });
    const link = screen.getByRole("link", { name: "按类型看" });
    await user.click(link);
    await waitFor(() => expect(router.state.location.search).toBe("?tab=sources"));
    expect(link).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "知识库" })).not.toHaveFocus();
  });

  it("leaves the conversation surface to the kernel frame, even where a shell h1 happens to exist", async () => {
    const user = userEvent.setup();
    await renderShell("/app/files");
    await screen.findByRole("heading", { level: 1, name: "知识库" });
    const link = screen.getByRole("link", { name: "新对话" });
    await user.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "对话" })).toBeInTheDocument();
    expect(link).toHaveFocus();
  });

  it("leaves a control the reader is working in: the row chosen in an in-page list keeps focus", async () => {
    const user = userEvent.setup();
    const router = await renderShell("/app/items");
    await screen.findByRole("heading", { level: 1, name: "定时任务" });
    const second = screen.getByRole("link", { name: "第二项" });
    await user.click(second);
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/items/2"));
    expect(screen.getByRole("link", { name: "第二项" })).toHaveFocus();
  });

  it("does not move while a dialog or drawer is open, and not for a page with no heading", async () => {
    const router = await renderShell("/app/files");
    await screen.findByRole("heading", { level: 1, name: "知识库" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    await act(async () => { await router.navigate("/app/files/src_1"); });
    const heading = await screen.findByRole("heading", { level: 1, name: "资料" });
    expect(heading).not.toHaveFocus();
    dialog.remove();
    await act(async () => { await router.navigate("/app/quiet"); });
    expect(await screen.findByText("没有标题的页面")).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("gives up on a heading that never comes, in a bounded time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const router = await renderShell("/app/files");
      await screen.findByRole("heading", { level: 1, name: "知识库" });
      await act(async () => { await router.navigate("/app/quiet"); });
      await act(async () => { vi.advanceTimersByTime(HEADING_WAIT_MS + 100); });
      // A heading appearing after the wait is nobody's business any more.
      const late = document.createElement("h1");
      late.textContent = "太晚了";
      document.querySelector("main")!.append(late);
      await act(async () => { await Promise.resolve(); });
      expect(late).not.toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});
