import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  hasWebApi: true,
  hasCommandBackend: true,
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
}));

// AccountPage reuses the settings page's ThemeSegmentedControl; the page's
// other module dependencies stay out of this test.
vi.mock("@/lib/tauri", () => ({ isTauri: false }));
vi.mock("@/lib/runtime", () => ({
  getClient: vi.fn(),
  useRuntimeStore: Object.assign(vi.fn(), { getState: vi.fn() }),
}));
vi.mock("@/components/settings/WebAccountCard", () => ({
  WebAccountCard: () => <div>托管账户自助管理</div>,
}));
vi.mock("@/components/settings/WebProjectsCard", () => ({
  WebProjectsCard: () => <div>托管项目自助管理</div>,
}));
vi.mock("@/components/settings/WebResourcesCard", () => ({
  WebResourcesCard: () => <div>资源与配额</div>,
}));
vi.mock("@/components/settings/WebReadinessCard", () => ({
  WebReadinessCard: () => <div>SaaS 部署就绪</div>,
}));
vi.mock("@/components/settings/WebTasksCard", () => ({
  WebTasksCard: () => <div>异步任务状态</div>,
}));
vi.mock("@/components/settings/WebAuditCard", () => ({
  WebAuditCard: () => <div>项目审计记录</div>,
}));
vi.mock("@/components/settings/WebErrorsCard", () => ({
  WebErrorsCard: () => <div>错误记录</div>,
}));
vi.mock("@/components/settings/WebSecurityCard", () => ({
  WebSecurityCard: () => <div>安全记录</div>,
}));

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useUiStore.setState({ theme: "system" });
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice", tenantId: "alice" },
      tenant: { id: "alice", model: "individual-account", role: "owner" },
      project: { id: "default", name: "Default Project" },
      projects: [{ id: "default", name: "Default Project" }],
    });
  });

  it("offers the same three-way appearance control as the desktop settings", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("外观")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "外观主题" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "浅色" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "深色" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeInTheDocument();
    // Default preference is system, so that segment is the checked one.
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
  });

  it("persists an explicit theme choice from the hosted page", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    expect(useUiStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("ai4s.theme")).toBe("dark");
  });

  it("restores the complete hosted self-service and operational module surface", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("tenant: alice")).toBeInTheDocument();
    expect(screen.getByText("托管账户自助管理")).toBeInTheDocument();
    expect(screen.getByText("托管项目自助管理")).toBeInTheDocument();
    expect(screen.getByText("资源与配额")).toBeInTheDocument();
    expect(screen.getByText("隐私与数据流向")).toBeInTheDocument();
    expect(screen.getByText("运行、审计与安全详情")).toBeInTheDocument();
    expect(screen.getByText("SaaS 部署就绪")).toBeInTheDocument();
    expect(screen.getByText("异步任务状态")).toBeInTheDocument();
    expect(screen.getByText("项目审计记录")).toBeInTheDocument();
    expect(screen.getByText("错误记录")).toBeInTheDocument();
    expect(screen.getByText("安全记录")).toBeInTheDocument();
  });
});
