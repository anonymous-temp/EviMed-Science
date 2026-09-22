import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  lastWebUsageBudgetRefusal: vi.fn(),
  fetchImStatus: vi.fn(),
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
vi.mock("@/components/settings/PasswordCard", () => ({ PasswordCard: () => <div>登录密码</div> }));
// The Feishu card has its own test; here only whether its tab exists.
vi.mock("@/components/settings/FeishuCard", () => ({ FeishuCard: () => <div>飞书机器人</div> }));
// The daily's switch decides for itself whether it is shown (its own test); here only its place.
vi.mock("@/components/settings/FrontierDigestCard", () => ({ FrontierDigestCard: () => <div>前沿动态日报</div> }));
vi.mock("@/lib/imClient", () => ({ fetchImStatus: mocks.fetchImStatus }));
vi.mock("./OpsPage", () => ({ OpsPage: () => <div>部署运维台</div> }));

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useUiStore.setState({ theme: "system" });
    mocks.lastWebUsageBudgetRefusal.mockReturnValue(null);
    mocks.fetchImStatus.mockResolvedValue({ enabled: false, available: true, channels: [], feishu: null, registration: null });
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

    expect(await screen.findAllByText("Alice")).not.toHaveLength(0);
    expect(screen.queryByText(/^tenant:/)).not.toBeInTheDocument();
    // The account id belongs to 「账户」 below — the card export and deletion
    // act through — and is printed there once. This page used to print it too,
    // which made four printings of a string nobody types (WP8, 2026-09-20).
    expect(screen.queryByText(/alice/)).toBeNull();
    expect(screen.getByText("托管账户自助管理")).toBeInTheDocument();
    // The password is the account's, so it is on the account tab.
    expect(screen.getByText("登录密码")).toBeInTheDocument();
  });

  // One destination, the tabs every product's settings have (2026-09-22:
  // 「该有的常规的设置项咋一个都没有」): account, appearance, notifications,
  // usage, data sources, projects.
  it("keeps the conventional settings as tabs of one destination", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findAllByText("Alice");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["账户", "外观", "通知", "用量与额度", "数据源", "项目"]);
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    expect(screen.getByRole("radiogroup", { name: "外观主题" })).toBeInTheDocument();
    expect(screen.getByText("简体中文")).toBeInTheDocument();
    expect(screen.getByText("键盘快捷键")).toBeInTheDocument();
    expect(screen.getByText("收起 / 展开侧边栏")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "通知" }));
    expect(screen.getByText("站内通知")).toBeInTheDocument();
    // No IM module: the phone card says so instead of offering a scan.
    expect(screen.getByText("手机通知")).toBeInTheDocument();
    expect(screen.queryByText("飞书机器人")).not.toBeInTheDocument();
    // The 「前沿动态」 daily's own switch lives with the other notifications.
    expect(screen.getByText("前沿动态日报")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "用量与额度" }));
    expect(screen.getByText("本月用量")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "数据源" }));
    expect(screen.getByText("数据源凭据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "项目" }));
    expect(screen.getByText("项目与插件设置")).toBeInTheDocument();
  });

  // A page for a switched-off subsystem would offer a scan that cannot work.
  it("offers the Feishu binding under 通知 only where the deployment runs the IM module", async () => {
    mocks.fetchImStatus.mockResolvedValue({ enabled: true, available: true, channels: [], feishu: { bound: false }, registration: null });
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );
    await screen.findAllByText("Alice");
    fireEvent.click(screen.getByRole("tab", { name: "通知" }));
    expect(await screen.findByText("飞书机器人")).toBeInTheDocument();
    expect(screen.queryByText("手机通知")).not.toBeInTheDocument();
  });

  // Presentation only — every route the page calls authorizes itself — but an
  // account the deployment did not name as an operator is not offered it.
  it("offers the operations board only to an operator account", async () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findAllByText("Alice");
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
      <MemoryRouter initialEntries={["/app/account?tab=usage"]}>
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
      <MemoryRouter initialEntries={["/app/account?tab=usage"]}>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(
      "本次登录中最近一次被额度拦下的请求。额度按滚动窗口计算：每笔支出分别在满 24 小时或满 7 天后自动腾出，不在固定时间重置。",
    )).toBeInTheDocument();
    expect(screen.queryByText(/次日重置|明天|每周一|本周额度|今日额度/)).not.toBeInTheDocument();
  });

  // The admission check refuses before it prices anything, so there is no
  // "this request needs" amount to invent.
  it("leaves out the requested amount when the refusal named none", async () => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue({ ...refusal, requested: undefined });
    render(
      <MemoryRouter initialEntries={["/app/account?tab=usage"]}>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("近 7 天额度已达上限：上限 12.00 CNY，已占用 12.40 CNY。")).toBeInTheDocument();
  });

  it("says nothing about ceilings when no request has been refused", async () => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue(null);
    mocks.fetchImStatus.mockResolvedValue({ enabled: false, available: true, channels: [], feishu: null, registration: null });
    render(
      <MemoryRouter initialEntries={["/app/account?tab=usage"]}>
        <AccountPage />
      </MemoryRouter>,
    );

    await screen.findByText("本月用量");
    expect(screen.queryByText("额度已达上限")).not.toBeInTheDocument();
    expect(screen.queryByText(/已占用/)).not.toBeInTheDocument();
  });
});
