import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  lastWebUsageBudgetRefusal: vi.fn(),
}));

// The refusal source is mocked; the sentence the page prints is the real one,
// so a change to how a ceiling is worded is caught here.
vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return {
    describeWebUsageBudget: actual.describeWebUsageBudget,
    fetchWebMe: mocks.fetchWebMe,
    lastWebUsageBudgetRefusal: mocks.lastWebUsageBudgetRefusal,
    hasWebApi: true,
    WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
  };
});

vi.mock("@/components/settings/WebAccountCard", () => ({
  WebAccountCard: () => <div>托管账户自助管理</div>,
}));
// Usage has its own test; here it is only a slot on the page.
vi.mock("@/components/settings/UsageCard", () => ({
  UsageCard: () => <div>本月用量</div>,
}));
// So do the connector credentials.
vi.mock("@/components/settings/ConnectorsCard", () => ({
  ConnectorsCard: () => <div>数据源凭据</div>,
}));

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useUiStore.setState({ theme: "system" });
    mocks.lastWebUsageBudgetRefusal.mockReturnValue(null);
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

describe("AccountPage budget ceilings", () => {
  const refusal = {
    window: "week" as const,
    limit: 12,
    committed: 12.4,
    requested: 0.3,
    currency: "CNY",
    observedAt: "2026-09-07T02:30:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ theme: "system" });
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice", tenantId: "alice" },
      tenant: { id: "alice", model: "individual-account", role: "owner" },
      project: { id: "default", name: "Default Project" },
      projects: [{ id: "default", name: "Default Project" }],
    });
    mocks.lastWebUsageBudgetRefusal.mockReturnValue(refusal);
  });

  // The three ceilings lead to different actions — the two account ceilings
  // are rolling windows that free spend as it ages, a run ceiling is about
  // this one task — so the page never renders them as one word. Only the
  // 24-hour and 7-day refusals reach a browser today (the reservation refusal
  // is answered by the model gateway's own envelope); `run` is rendered here
  // because the page must not go blank the day that path is routed through the
  // shared boundary.
  it.each([
    ["day", "近 24 小时额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
    ["week", "近 7 天额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
    ["run", "单次任务额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
  ] as const)("names the %s ceiling and the amounts behind it", async (window, sentence) => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue({ ...refusal, window });
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("额度已达上限")).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  // The ledger measures spend over rolling 24-hour and 7-day windows
  // (`openCostWindows`, applied in SQL as `created_at >= now - interval`), so
  // nothing resets at midnight or on Monday. The card's hint is pinned as text
  // because it is the one sentence telling the researcher when the ceiling
  // frees up, and a rule the ledger does not implement is worse than none.
  it("states the rolling window instead of a calendar reset", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(
      "本次会话中最近一次被额度拦下的请求。额度按滚动窗口计算：每笔支出分别在满 24 小时或满 7 天后自动腾出，不在固定时间重置。",
    )).toBeInTheDocument();
    expect(screen.queryByText(/次日重置|明天|每周一|本周额度|今日额度/)).not.toBeInTheDocument();
  });

  // The admission check refuses before it prices anything, so there is no
  // "this request needs" amount to invent.
  it("leaves out the requested amount when the refusal named none", async () => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue({ ...refusal, requested: undefined });
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("近 7 天额度已达上限：上限 12.00 CNY，已占用 12.40 CNY。")).toBeInTheDocument();
  });

  it("says nothing about ceilings when no request has been refused", async () => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue(null);
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findByText("tenant: alice");
    expect(screen.queryByText("额度已达上限")).not.toBeInTheDocument();
    expect(screen.queryByText(/已占用/)).not.toBeInTheDocument();
  });
});
