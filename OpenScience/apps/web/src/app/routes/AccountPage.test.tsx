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
// The other two tabs are whole pages with their own tests. Mocked so this file
// tests the account destination, not everything reachable from it.
vi.mock("./SettingsPage", () => ({ SettingsPage: () => <div>项目与插件设置</div> }));
vi.mock("./OpsPage", () => ({ OpsPage: () => <div>部署运维台</div> }));

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

  it("names the account and offers self-service", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    // 「tenant: alice」 was a runtime word and a raw id used as a label.
    expect(screen.getByText("账号 alice")).toBeInTheDocument();
    expect(screen.queryByText(/^tenant:/)).not.toBeInTheDocument();
    expect(screen.getByText("托管账户自助管理")).toBeInTheDocument();
    // What the account has spent belongs with the account.
    expect(screen.getByText("本月用量")).toBeInTheDocument();
  });

  // One destination, four views. Credentials and settings were two more
  // top-level rows pointing at the same thing (2026-09-15 walk, C7/C8).
  it("gathers usage, data sources and settings as tabs of one destination", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("tab", { name: "数据源" }));
    expect(screen.getByText("数据源凭据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "设置" }));
    expect(screen.getByText("项目与插件设置")).toBeInTheDocument();
  });

  // Presentation only — every route the page calls authorizes itself — but an
  // account the deployment did not name as an operator is not offered it.
  it("offers the operations board only to an operator account", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findByText("Alice");
    expect(screen.queryByRole("tab", { name: "运维台" })).not.toBeInTheDocument();
  });

  it("offers the operations board when the control plane says this account is one", async () => {
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice", tenantId: "alice" },
      tenant: { id: "alice", model: "individual-account", role: "owner" },
      operator: true,
      project: { id: "default", name: "Default Project" },
      projects: [{ id: "default", name: "Default Project" }],
    });
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("tab", { name: "运维台" }));
    expect(screen.getByText("部署运维台")).toBeInTheDocument();
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

    await screen.findByText("账号 alice");
    expect(screen.queryByText("额度已达上限")).not.toBeInTheDocument();
    expect(screen.queryByText(/已占用/)).not.toBeInTheDocument();
  });
});
