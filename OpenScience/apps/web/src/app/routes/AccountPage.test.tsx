import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { forgetResearchBilling } from "@/lib/useResearchBilling";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  fetchImStatus: vi.fn(),
  allowance: vi.fn(),
}));

vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return { ...actual, fetchWebMe: mocks.fetchWebMe, fetchWebResearchAllowance: mocks.allowance, hasWebApi: true };
});
vi.mock("@/lib/imClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imClient")>("@/lib/imClient");
  return { ...actual, fetchImStatus: mocks.fetchImStatus };
});

// Each section has its own test; here they are the slots the section column
// opens. 项目 is the real section's shape as far as this page cares: it holds
// no plugins card any more. The usage section is real — it is the one that
// asks which of its two bodies the deployment has, and it shares that answer
// with this page's tab label — and its two bodies are the slots.
vi.mock("@/components/settings/AccountSection", () => ({
  AccountSection: ({ imEnabled }: { imEnabled: boolean }) => <div>账户分区{imEnabled ? "（含飞书）" : ""}</div>,
}));
vi.mock("@/components/settings/NotificationsSection", () => ({ NotificationsSection: () => <div>通知分区</div> }));
vi.mock("@/components/settings/MonthlyUsage", () => ({ MonthlyUsage: () => <div>用量分区</div> }));
vi.mock("@/components/settings/ResearchAllowance", () => ({ ResearchAllowance: () => <div>科研额度分区</div> }));
vi.mock("@/components/settings/ConnectorsSection", () => ({ ConnectorsSection: () => <div>数据源分区</div> }));
vi.mock("@/components/settings/ProjectsSection", () => ({ ProjectsSection: () => <div>项目分区</div> }));
vi.mock("./OpsPage", () => ({ OpsPage: () => <div>运维分区<p>项目插件</p></div> }));

const me = (operator = false) => ({
  user: { id: "alice", name: "Alice", tenantId: "alice" },
  tenant: { id: "alice", model: "individual-account", role: "owner" },
  ...(operator ? { operator: true } : {}),
  project: { id: "default", name: "我的研究" },
  projects: [{ id: "default", name: "我的研究" }],
});

/** `/api/account/allowance` on a deployment that bills research, and on one that does not (every deployment today). */
const billing = (enabled: boolean) => ({
  enabled, currency: "CNY", status: enabled ? "ready" : "disabled", available: enabled ? 20 : null, held: null, balances: null, membership: null,
  month: { since: "2026-10-01T00:00:00.000Z", paid: 0, pending: 0 },
  commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null },
});

function open(path = "/app/account") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/account" element={<AccountPage />} /></Routes>
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "设置分区" });
/** The deployment's answer has landed and the page has drawn it. */
const answered = () => act(async () => {});
const names = () => within(nav()).getAllByRole("link").map((link) => link.textContent);

/** The usage section is named by the deployment: 用量, and 科研额度 only where research is billed. */
const DEPLOYMENTS = [
  { name: "does not bill research", enabled: false, usage: "用量", body: "用量分区", other: "科研额度", reads: 1 },
  { name: "bills research", enabled: true, usage: "科研额度", body: "科研额度分区", other: "用量", reads: 2 },
] as const;

describe("设置", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ theme: "system" });
    mocks.fetchImStatus.mockResolvedValue({ enabled: false, available: true, channels: [], feishu: null, registration: null });
    mocks.fetchWebMe.mockResolvedValue(me());
    mocks.allowance.mockReset();
    mocks.allowance.mockResolvedValue(billing(false));
    forgetResearchBilling();
  });

  it("is 「设置」 in the one page column, a title and nothing under it", async () => {
    const { container } = open();
    const heading = await screen.findByRole("heading", { level: 1, name: "设置" });
    expect(container.querySelector(".max-w-page")).toContainElement(heading);
    expect(screen.queryByText(/你的账号、外观、通知/)).not.toBeInTheDocument();
    expect(screen.queryByText("账户与设置")).not.toBeInTheDocument();
    // A section column, not a strip of tabs.
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  describe.each(DEPLOYMENTS)("on a deployment that $name", ({ enabled, usage, body, other, reads }) => {
    beforeEach(() => { mocks.allowance.mockResolvedValue(billing(enabled)); });

    it(`lists the conventional sections in a column on the left, the usage section as ${usage}, and opens on 账户`, async () => {
      open();
      expect(await screen.findByText("账户分区")).toBeInTheDocument();
      await answered();
      expect(names()).toEqual(["账户", "外观", "通知", usage, "数据源", "项目", "插件", "技能"]);
      expect(within(nav()).queryByRole("link", { name: other })).not.toBeInTheDocument();
      expect(within(nav()).getByRole("link", { name: "插件" })).toHaveAttribute("href", "/app/extensions/plugins");
      expect(within(nav()).getByRole("link", { name: "技能" })).toHaveAttribute("href", "/app/extensions/skills");
      expect(within(nav()).getByRole("link", { name: "账户" })).toHaveAttribute("aria-current", "page");
      // The address is the same under either name: links and the server's copy depend on it.
      expect(within(nav()).getByRole("link", { name: usage })).toHaveAttribute("href", "/app/account?tab=usage");
      // The sidebar's navigation item (spec §20.6), not a 32 px look of its own.
      expect(within(nav()).getByRole("link", { name: "账户" })).toHaveClass("h-control", "bg-accent-soft", "font-medium");
      expect(within(nav()).getByRole("link", { name: usage })).toHaveClass("h-control", "hover:bg-surface-2");
    });

    it(`keeps ?tab=usage: it opens the usage section, under the name ${usage}`, async () => {
      open("/app/account?tab=usage");
      expect(await screen.findByText(body)).toBeInTheDocument();
      await answered();
      expect(within(nav()).getByRole("link", { name: usage })).toHaveAttribute("aria-current", "page");
      expect(within(nav()).queryByRole("link", { name: other })).not.toBeInTheDocument();
      expect(screen.queryByText(DEPLOYMENTS.find((d) => d.enabled !== enabled)!.body)).not.toBeInTheDocument();
    });

    it(`reads the allowance ${reads === 1 ? "once" : "twice"} for the tab and the section together, not once for each`, async () => {
      const user = userEvent.setup();
      open("/app/account?tab=usage");
      await screen.findByText(body);
      await answered();
      expect(mocks.allowance).toHaveBeenCalledTimes(1);
      // Away and back: an answer that says billing is off is final; one that says it is on is read again for its numbers.
      await user.click(within(nav()).getByRole("link", { name: "数据源" }));
      expect(await screen.findByText("数据源分区")).toBeInTheDocument();
      await user.click(within(nav()).getByRole("link", { name: usage }));
      expect(await screen.findByText(body)).toBeInTheDocument();
      await answered();
      expect(mocks.allowance).toHaveBeenCalledTimes(reads);
    });

    // A hosted account does not pick a model and does not hold a provider key —
    // the gateway resolves both per request — and approval is the deployment's.
    // A section for any of them would offer a control the server refuses.
    it("offers no model, credential or approval control", async () => {
      const user = userEvent.setup();
      mocks.fetchWebMe.mockResolvedValue(me(true));
      open();
      await within(nav()).findByRole("link", { name: "运维" });
      await answered();
      const labels = names();
      expect(labels).toEqual(["账户", "外观", "通知", usage, "数据源", "项目", "运维", "插件", "技能"]);
      for (const label of labels.filter(label => label !== "插件" && label !== "技能")) {
        await user.click(within(nav()).getByRole("link", { name: label ?? "" }));
        for (const gone of [/API Key/i, /审批模式/, /选择模型/, /添加 MCP/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      }
    });
  });

  it("names the usage section 用量 until the deployment says it bills research, and never the other way round", async () => {
    let answer!: (value: object) => void;
    mocks.allowance.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    open();
    expect(await screen.findByText("账户分区")).toBeInTheDocument();
    expect(names()).toEqual(["账户", "外观", "通知", "用量", "数据源", "项目", "插件", "技能"]);
    await act(async () => { answer(billing(true)); });
    expect(names()).toEqual(["账户", "外观", "通知", "科研额度", "数据源", "项目", "插件", "技能"]);
    expect(within(nav()).getByRole("link", { name: "科研额度" })).toHaveAttribute("href", "/app/account?tab=usage");
  });

  it("keeps 用量 when the deployment's answer cannot be read, and the section says so with a retry", async () => {
    const user = userEvent.setup();
    mocks.allowance.mockRejectedValueOnce(new Error("network"));
    mocks.allowance.mockResolvedValue(billing(true));
    open("/app/account?tab=usage");
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
    expect(names()).toEqual(["账户", "外观", "通知", "用量", "数据源", "项目", "插件", "技能"]);
    expect(screen.queryByText("用量分区")).not.toBeInTheDocument();
    expect(screen.queryByText("科研额度分区")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("科研额度分区")).toBeInTheDocument();
    // The one read the retry made is the tab's answer too.
    expect(names()).toEqual(["账户", "外观", "通知", "科研额度", "数据源", "项目", "插件", "技能"]);
  });

  it.each([
    ["connectors", "数据源", "数据源分区"],
    ["notifications", "通知", "通知分区"],
    ["projects", "项目", "项目分区"],
    ["account", "账户", "账户分区"],
  ])("keeps ?tab=%s: it opens %s", async (tab, label, body) => {
    open(`/app/account?tab=${tab}`);
    expect(await screen.findByText(body)).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  });

  it("opens 账户 for a value it does not know", async () => {
    open("/app/account?tab=nonsense");
    expect(await screen.findByText("账户分区")).toBeInTheDocument();
  });

  it("moves between sections from the column", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("账户分区");
    await user.click(within(nav()).getByRole("link", { name: "数据源" }));
    expect(await screen.findByText("数据源分区")).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "数据源" })).toHaveAttribute("aria-current", "page");
    await user.click(within(nav()).getByRole("link", { name: "账户" }));
    expect(await screen.findByText("账户分区")).toBeInTheDocument();
  });

  it("offers Feishu under 账户 only where the deployment runs the IM module", async () => {
    mocks.fetchImStatus.mockResolvedValue({ enabled: true, available: true, channels: [], feishu: { bound: false }, registration: null });
    open();
    expect(await screen.findByText("账户分区（含飞书）")).toBeInTheDocument();
  });

  // 「项目插件」 is an operator's: a researcher has nothing to configure in it.
  it("offers 运维, and the project plugins in it, only to an operator account", async () => {
    open("/app/account?tab=projects");
    expect(await screen.findByText("项目分区")).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchWebMe).toHaveBeenCalled());
    expect(within(nav()).queryByRole("link", { name: "运维" })).not.toBeInTheDocument();
    expect(screen.queryByText("项目插件")).not.toBeInTheDocument();
  });

  it("offers 运维 when the control plane says this account is one", async () => {
    const user = userEvent.setup();
    mocks.fetchWebMe.mockResolvedValue(me(true));
    open();
    await user.click(await within(nav()).findByRole("link", { name: "运维" }));
    expect(await screen.findByText("运维分区")).toBeInTheDocument();
    expect(screen.getByText("项目插件")).toBeInTheDocument();
  });

  it("keeps 外观 to a theme, a language and the shortcuts, with no hint under any group", async () => {
    const user = userEvent.setup();
    open("/app/account?tab=appearance");
    expect(await screen.findByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByText("简体中文")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "快捷键" })).toBeInTheDocument();
    expect(screen.getByText("收起 / 展开侧边栏")).toBeInTheDocument();
    for (const gone of [/保存在本浏览器中/, /界面语言随部署/, /按 \? 随时打开/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
    // The theme is a choice in a menu at the row's end.
    await user.click(screen.getByRole("button", { name: "主题：跟随系统" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "深色" }));
    expect(useUiStore.getState().theme).toBe("dark");
  });
});
