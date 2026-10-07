import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AppShell } from "./AppShell";

/**
 * Where keyboard focus goes as the sidebar opens and closes, and what is reachable while it is a drawer (2026-10-07 audit B-02,
 * axe `region`). The real UI store drives it: a collapsed sidebar is `inert`, and the focus that was in it must not be left on
 * something nobody can reach.
 *
 * jsdom does not implement `inert` (it neither blurs nor skips the subtree), so what is asserted is the attribute the browser acts
 * on and where `focus()` was sent — the two things this shell controls.
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
// The sidebar has its own tests; here it is a landmark with a nav, a collapse button and an `inert` it takes from the store.
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: function MockSidebar() {
    const { sidebarCollapsed, toggleSidebar } = useUiStore();
    return (
      <aside aria-label="侧栏" data-sidebar="" inert={sidebarCollapsed}>
        <button type="button" onClick={toggleSidebar}>收起侧边栏</button>
        <nav aria-label="工作台">
          <a href="/app/chat">新对话</a>
          <a href="/app/files">知识库</a>
        </nav>
        <input aria-label="搜索对话" />
      </aside>
    );
  },
}));

/** The viewport: below `lg` the sidebar is a drawer. */
function viewport(drawer: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: drawer && query === "(max-width: 1023px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function renderShell() {
  mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
  const router = createMemoryRouter(
    [{ path: "/app", element: <AppShell />, children: [{ path: "chat", element: <div>页面内容</div> }] }],
    { initialEntries: ["/app/chat"] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByText("页面内容");
}

const main = () => document.getElementById("main") as HTMLElement;

describe("the sidebar's focus and the page behind it", () => {
  beforeAll(() => { vi.stubGlobal("Request", SignalCompatibleRequest); });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false });
    viewport(false);
  });

  it("sends focus to the expand button when the sidebar's own button closes it, and back to the first destination when it opens", async () => {
    const user = userEvent.setup();
    await renderShell();
    await user.click(screen.getByRole("button", { name: "收起侧边栏" }));
    const expand = await screen.findByRole("button", { name: "展开侧边栏" });
    expect(expand).toHaveFocus();
    expect(document.querySelector("[data-sidebar]")).toHaveAttribute("inert");

    await user.click(expand);
    expect(document.querySelector("[data-sidebar]")).not.toHaveAttribute("inert");
    expect(screen.getByRole("link", { name: "新对话" })).toHaveFocus();
  });

  it("leaves focus alone when the sidebar is closed from the page, outside it", async () => {
    await renderShell();
    const box = document.createElement("input");
    main().append(box);
    box.focus();
    act(() => { useUiStore.getState().setSidebarCollapsed(true); });
    expect(await screen.findByRole("button", { name: "展开侧边栏" })).not.toHaveFocus();
    expect(box).toHaveFocus();
  });

  it("closes with Ctrl+B and opens with it, taking the reader into the sidebar only when it opens", async () => {
    await renderShell();
    const search = screen.getByRole("textbox", { name: "搜索对话" });
    search.focus();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(await screen.findByRole("button", { name: "展开侧边栏" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("link", { name: "新对话" })).toHaveFocus();
  });

  describe("below lg, where it is a drawer over the page", () => {
    beforeEach(() => { viewport(true); });

    it("makes the page behind an open drawer inert, and the page live again when it closes", async () => {
      // The shell opens a narrow viewport closed; the reader opens it.
      await renderShell();
      expect(document.querySelector("[data-sidebar]")).toHaveAttribute("inert");
      expect(main()).not.toHaveAttribute("inert");
      await userEvent.click(await screen.findByRole("button", { name: "展开侧边栏" }));
      expect(main()).toHaveAttribute("inert");
      expect(screen.getByRole("link", { name: "新对话" })).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "关闭侧边栏" }));
      expect(main()).not.toHaveAttribute("inert");
    });

    it("closes on Escape and puts focus on the button that opens it", async () => {
      await renderShell();
      await userEvent.click(await screen.findByRole("button", { name: "展开侧边栏" }));
      await userEvent.keyboard("{Escape}");
      expect(await screen.findByRole("button", { name: "展开侧边栏" })).toHaveFocus();
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
      expect(main()).not.toHaveAttribute("inert");
    });

    it("lets a layer above it take the Escape first: a menu or a rename field closes, the drawer stays", async () => {
      await renderShell();
      await userEvent.click(await screen.findByRole("button", { name: "展开侧边栏" }));
      const search = screen.getByRole("textbox", { name: "搜索对话" });
      search.addEventListener("keydown", (event) => { if (event.key === "Escape") event.preventDefault(); });
      search.focus();
      await userEvent.keyboard("{Escape}");
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });

    it("closes on the scrim and puts focus on the expand button, the scrim having gone", async () => {
      await renderShell();
      await userEvent.click(await screen.findByRole("button", { name: "展开侧边栏" }));
      await userEvent.click(screen.getByRole("button", { name: "关闭侧边栏" }));
      expect(await screen.findByRole("button", { name: "展开侧边栏" })).toHaveFocus();
    });
  });

  it("is a column beside the page from lg up: nothing is made inert and Escape does not close it", async () => {
    await renderShell();
    expect(main()).not.toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(document.querySelector("[data-sidebar]")).not.toHaveAttribute("inert");
  });
});
