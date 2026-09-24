import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuAccountRow, FeishuPushRow, FeishuQrCode } from "./FeishuRows";

const mocks = vi.hoisted(() => ({
  fetchImStatus: vi.fn(),
  startFeishuRegistration: vi.fn(),
  fetchFeishuRegistration: vi.fn(),
  cancelFeishuRegistration: vi.fn(),
  unbindFeishu: vi.fn(),
  setFeishuNotifications: vi.fn(),
}));

vi.mock("@/lib/imClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imClient")>("@/lib/imClient");
  return { ...actual, ...mocks };
});
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const QR_URL = "https://open.feishu.cn/page/launcher?user_code=ABCD&from=sdk&tp=sdk";
const unbound = { enabled: true, available: true, channels: [], feishu: { bound: false }, registration: null };
const bound = {
  enabled: true, available: true, channels: [], registration: null,
  feishu: {
    bound: true, botName: "张三 的 EviMed 研究助手", appId: "cli_a1b2••••0718", tenantBrand: "feishu", boundAt: "2026-09-20T01:00:00.000Z",
    activation: "active", connection: { state: "connected", errorCode: null, since: "2026-09-20T01:00:00.000Z", retryAt: null },
    notifications: true,
    chats: [{ chatType: "p2p", projectId: null, projectName: null, updatedAt: "2026-09-20T01:00:00.000Z" },
      { chatType: "group", projectId: "p-onc", projectName: "肿瘤免疫", updatedAt: "2026-09-20T01:00:00.000Z" }],
  },
};

const account = () => render(<MemoryRouter><FeishuAccountRow /></MemoryRouter>);
const push = () => render(<MemoryRouter><FeishuPushRow /></MemoryRouter>);

describe("飞书 under 账户", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it("walks from one 「绑定」 to a connected bot, polling the server while the code waits", async () => {
    mocks.fetchImStatus.mockResolvedValueOnce(unbound).mockResolvedValueOnce(bound);
    mocks.startFeishuRegistration.mockResolvedValue({ state: "polling", qrCodeUrl: QR_URL, remainingSeconds: 590 });
    mocks.fetchFeishuRegistration.mockResolvedValue({ state: "succeeded", result: { botName: "bot", pendingApproval: false, tenantBrand: "feishu" } });
    account();
    expect(await screen.findByText("研究完成和每日前沿推送到飞书")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "绑定" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(start); });
    expect(screen.getByRole("img", { name: "飞书扫码创建机器人的二维码" })).toBeInTheDocument();
    // On a phone the same SDK-built link opens Feishu directly.
    expect(screen.getByRole("link", { name: /在手机上直接打开飞书/ })).toHaveAttribute("href", QR_URL);
    expect(screen.getByText("二维码约 10 分钟内有效。")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.fetchFeishuRegistration).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect(await screen.findByText(/张三 的 EviMed 研究助手/)).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });

  it("says the platform's own sentence when a scan fails, and offers to try again", async () => {
    mocks.fetchImStatus.mockResolvedValue(unbound);
    mocks.startFeishuRegistration.mockResolvedValue({ state: "error",
      error: { code: "access_denied", message: "你在飞书里拒绝了这次授权。需要时可以重新扫码。" } });
    account();
    const start = await screen.findByRole("button", { name: "绑定" });
    await act(async () => { fireEvent.click(start); });
    expect(screen.getByRole("alert")).toHaveTextContent("你在飞书里拒绝了这次授权。");
    expect(screen.getByRole("button", { name: "重新绑定" })).toBeInTheDocument();
  });

  it("shows a bound bot's state, and keeps where each chat goes and 解除绑定 in its 「⋯」", async () => {
    const user = userEvent.setup();
    mocks.fetchImStatus.mockResolvedValueOnce(bound).mockResolvedValue(unbound);
    mocks.unbindFeishu.mockResolvedValue({ removed: 1 });
    account();
    expect(await screen.findByText("已连接")).toBeInTheDocument();
    // The app id is not the reader's business.
    expect(screen.queryByText(/cli_a1b2/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "飞书的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "对话去向" }));
    expect(screen.getByText("单聊 · 跟随你最近使用的项目")).toBeInTheDocument();
    expect(screen.getByText("群聊 · 项目「肿瘤免疫」")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "飞书的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "解除绑定" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/机器人应用仍在你的飞书里/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "解除绑定" })); });
    expect(mocks.unbindFeishu).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "绑定" })).toBeInTheDocument();
  });

  it("names an enterprise approval wait instead of a connection error", async () => {
    mocks.fetchImStatus.mockResolvedValue({ ...bound, feishu: { ...bound.feishu, activation: "pending", connection: null } });
    account();
    expect(await screen.findByText("等待企业管理员启用")).toBeInTheDocument();
    expect(screen.getByText(/启用后自动连上/)).toBeInTheDocument();
  });

  it("offers a retry when the status cannot be read", async () => {
    mocks.fetchImStatus.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(unbound);
    account();
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "绑定" })).toBeInTheDocument();
  });

  it("draws a scannable code: dark modules on a white figure, one path", () => {
    const { container } = render(<FeishuQrCode value={QR_URL} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("bg-white", "text-black");
    const size = Number(svg?.getAttribute("viewBox")?.split(" ")[2]);
    expect(size).toBeGreaterThanOrEqual(25);
    expect(container.querySelector("path")?.getAttribute("d")?.startsWith("M")).toBe(true);
  });
});

describe("飞书 under 通知", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("turns pushes off and on with a switch", async () => {
    mocks.fetchImStatus.mockResolvedValue(bound);
    mocks.setFeishuNotifications.mockResolvedValue({});
    push();
    const toggle = await screen.findByRole("switch", { name: "推送到飞书" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(toggle); });
    expect(mocks.setFeishuNotifications).toHaveBeenCalledWith(false);
  });

  it("sends an account that has not bound Feishu to 账户 to do it", async () => {
    mocks.fetchImStatus.mockResolvedValue(unbound);
    push();
    expect(await screen.findByRole("link", { name: "绑定" })).toHaveAttribute("href", "/app/account");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
