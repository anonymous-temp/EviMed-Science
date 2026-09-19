import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  fetchInboxUnreadCount: vi.fn(),
  fetchWebConnectors: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebConnectors: mocks.fetchWebConnectors,
  getWebProjectId: () => "default",
}));

vi.mock("@/lib/inboxClient", () => ({
  fetchInboxUnreadCount: mocks.fetchInboxUnreadCount,
  INBOX_CHANGED_EVENT: "evimed:inbox-changed",
}));

const store = vi.hoisted(() => ({
  setSidebarWidth: vi.fn(),
  toggleSidebar: vi.fn(),
  setPaletteOpen: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  SIDEBAR_MIN: 220,
  SIDEBAR_MAX: 420,
  useUiStore: () => ({
    sidebarCollapsed: false,
    sidebarWidth: 260,
    setSidebarCollapsed: vi.fn(),
    setSidebarWidth: store.setSidebarWidth,
    toggleSidebar: store.toggleSidebar,
    setPaletteOpen: store.setPaletteOpen,
  }),
}));

// The projects and their tasks read the store and the ledgers on mount and
// have their own tests (ProjectBrowser.test.tsx); here the section is a slot.
vi.mock("@/components/sidebar/ProjectBrowser", () => ({
  ProjectBrowser: () => <section aria-label="项目" data-testid="project-browser" />,
}));

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
  mocks.fetchInboxUnreadCount.mockResolvedValue({ unreadTotal: 0, safetyUnread: 0 });
  mocks.fetchWebConnectors.mockResolvedValue([]);
});

describe("Sidebar navigation", () => {
  it("makes repeated new-task clicks distinct native requests even on the same route", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("link", { name: "新任务" }));
    const first = JSON.parse(screen.getByTestId("intent").textContent!);
    await userEvent.click(screen.getByRole("link", { name: "新任务" }));
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

    const order = ["新任务", "运行记录", "知识库", "记忆胶囊", "主动科研", "科研能力"];
    const buttons = order.map((label) => screen.getByRole("link", { name: label }));
    for (let i = 1; i < buttons.length; i += 1) {
      expect(
        buttons[i - 1].compareDocumentPosition(buttons[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    await userEvent.click(screen.getByRole("link", { name: "知识库" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/files");

    await userEvent.click(screen.getByRole("link", { name: "科研能力" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/capabilities");

    await userEvent.click(screen.getByRole("link", { name: "账户与设置" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/account");
  });

  // The credentials banner used to sit across the top of seven pages. The
  // fact it stated is now a quiet count on the account row.
  it("counts the data sources nothing serves on the account row instead of a banner", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([
      { id: "opengwas", needsAttention: true },
      { id: "core", needsAttention: true },
      { id: "semantic-scholar", needsAttention: false },
    ]);
    renderSidebar();
    const row = await screen.findByRole("link", { name: "账户与设置，2 个数据源没有可用凭据" });
    expect(row).toHaveAttribute("href", "/app/account?tab=connectors");
    expect(row).toHaveTextContent("2");
  });

  // The rows that used to be here and are now tabs of one of the six. The
  // inbox is not in this list: it is still reachable, as the bell above.
  it("no longer offers a row for a view of another destination", async () => {
    renderSidebar();
    for (const gone of ["资料整理", "科研笔记本", "科研记忆", "记忆胶囊", "能力模板", "设置", "账户与额度"]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
  });

  // The kernel's column, top to bottom: brand, the destinations, the
  // workspace list filling the rest, the account at the foot. The project
  // dropdown that sat under the wordmark is gone — every project is a group in
  // the list now — and so is the 「最近任务」 list of the current one only.
  it("puts the projects between the destinations and the account row, and no project dropdown above them", async () => {
    renderSidebar();
    const lastRow = screen.getByRole("link", { name: "科研能力" });
    const projects = screen.getByRole("region", { name: "项目" });
    const account = await screen.findByRole("link", { name: "账户与设置" });
    expect(lastRow.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(projects.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^当前项目：/ })).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务")).not.toBeInTheDocument();
  });

  it("carries the brand and the inbox bell above the nav", async () => {
    mocks.fetchInboxUnreadCount.mockResolvedValue({ unreadTotal: 2, safetyUnread: 0 });
    renderSidebar();
    expect(screen.getByRole("img", { name: "EviMed" })).toBeInTheDocument();
    // One old notification did not earn a permanent navigation row; an unread
    // count does earn a badge.
    const bell = await screen.findByRole("button", { name: "收件箱，2 条未读" });
    await userEvent.click(bell);
    expect(screen.getByTestId("location")).toHaveTextContent("/app/inbox");
  });
});

describe("Sidebar chrome", () => {
  // A width a mouse can set, a keyboard can (WAI-ARIA window splitter).
  it("resizes from the keyboard through a focusable separator", async () => {
    renderSidebar();
    const separator = await screen.findByRole("separator", { name: "调整侧边栏宽度" });
    expect(separator).toHaveAttribute("aria-valuenow", "260");
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuemax", "420");
    separator.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(store.setSidebarWidth).toHaveBeenLastCalledWith(276);
    await userEvent.keyboard("{Home}");
    expect(store.setSidebarWidth).toHaveBeenLastCalledWith(220);
    await userEvent.keyboard("{Enter}");
    expect(store.toggleSidebar).toHaveBeenCalled();
  });

  it("shows the command palette's shortcut where it can be seen, and opens it", async () => {
    renderSidebar();
    const open = await screen.findByRole("button", { name: /快速跳转/ });
    expect(open).toHaveTextContent(/K/);
    await userEvent.click(open);
    expect(store.setPaletteOpen).toHaveBeenCalledWith(true);
  });
});
