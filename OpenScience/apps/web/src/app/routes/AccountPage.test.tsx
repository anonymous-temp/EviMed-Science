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
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
}));

vi.mock("@/components/settings/WebAccountCard", () => ({
  WebAccountCard: () => <div>托管账户自助管理</div>,
}));
// Usage has its own test; here it is only a slot on the page.
vi.mock("@/components/settings/UsageCard", () => ({
  UsageCard: () => <div>本月用量</div>,
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

  it("offers a three-way appearance control", async () => {
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

  it("names the tenant and offers account self-service", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("tenant: alice")).toBeInTheDocument();
    expect(screen.getByText("托管账户自助管理")).toBeInTheDocument();
    // What the account has spent belongs with the account, not with the
    // deployment's settings.
    expect(screen.getByText("本月用量")).toBeInTheDocument();
  });

  // Everything about how the deployment runs moved to /app/settings. Keeping a
  // second copy here is how two pages drift into disagreeing about one system.
  it("leaves the deployment's own operational surface to the settings page", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findByText("tenant: alice");
    for (const moved of ["托管项目自助管理", "资源与配额", "隐私与数据流向", "SaaS 部署就绪"]) {
      expect(screen.queryByText(moved)).not.toBeInTheDocument();
    }
  });
});
