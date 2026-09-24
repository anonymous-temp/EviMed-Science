import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@/lib/store";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  fetchImStatus: vi.fn(),
}));

vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return { ...actual, fetchWebMe: mocks.fetchWebMe, hasWebApi: true };
});
vi.mock("@/lib/imClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imClient")>("@/lib/imClient");
  return { ...actual, fetchImStatus: mocks.fetchImStatus };
});

// Each section has its own test; here they are the slots the section column
// opens. 项目 is the real section's shape as far as this page cares: it holds
// no plugins card any more.
vi.mock("@/components/settings/AccountSection", () => ({
  AccountSection: ({ imEnabled }: { imEnabled: boolean }) => <div>账户分区{imEnabled ? "（含飞书）" : ""}</div>,
}));
vi.mock("@/components/settings/NotificationsSection", () => ({ NotificationsSection: () => <div>通知分区</div> }));
vi.mock("@/components/settings/UsageSection", () => ({ UsageSection: () => <div>用量分区</div> }));
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

function open(path = "/app/account") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/account" element={<AccountPage />} /></Routes>
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "设置分区" });

describe("设置", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ theme: "system" });
    mocks.fetchImStatus.mockResolvedValue({ enabled: false, available: true, channels: [], feishu: null, registration: null });
    mocks.fetchWebMe.mockResolvedValue(me());
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

  it("lists the conventional sections in a column on the left, and opens on 账户", async () => {
    open();
    expect(await screen.findByText("账户分区")).toBeInTheDocument();
    const links = within(nav()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["账户", "外观", "通知", "用量", "数据源", "项目"]);
    expect(within(nav()).getByRole("link", { name: "账户" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("link", { name: "用量" })).toHaveAttribute("href", "/app/account?tab=usage");
  });

  it.each([
    ["usage", "用量", "用量分区"],
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

  // A hosted account does not pick a model and does not hold a provider key —
  // the gateway resolves both per request — and approval is the deployment's.
  // A section for any of them would offer a control the server refuses.
  it("offers no model, credential or approval control", async () => {
    const user = userEvent.setup();
    mocks.fetchWebMe.mockResolvedValue(me(true));
    open();
    await within(nav()).findByRole("link", { name: "运维" });
    const labels = within(nav()).getAllByRole("link").map((link) => link.textContent);
    expect(labels).toEqual(["账户", "外观", "通知", "用量", "数据源", "项目", "运维"]);
    for (const label of labels) {
      await user.click(within(nav()).getByRole("link", { name: label ?? "" }));
      for (const gone of [/API Key/i, /审批模式/, /选择模型/, /添加 MCP/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    }
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
