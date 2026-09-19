import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuCard, FeishuQrCode } from "./FeishuCard";

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

describe("FeishuCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks a researcher from one button to a connected bot, polling the server while the code waits", async () => {
    mocks.fetchImStatus.mockResolvedValueOnce(unbound).mockResolvedValueOnce(bound);
    mocks.startFeishuRegistration.mockResolvedValue({ state: "polling", qrCodeUrl: QR_URL, remainingSeconds: 590 });
    mocks.fetchFeishuRegistration.mockResolvedValue({ state: "succeeded", result: { botName: "bot", pendingApproval: false, tenantBrand: "feishu" } });
    render(<FeishuCard />);
    const start = await screen.findByRole("button", { name: /扫码创建飞书机器人/ });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(start); });
    expect(screen.getByRole("img", { name: "飞书扫码创建机器人的二维码" })).toBeInTheDocument();
    // On a phone the same SDK-built link opens Feishu directly.
    expect(screen.getByRole("link", { name: /直接在飞书中打开/ })).toHaveAttribute("href", QR_URL);
    expect(screen.getByText("二维码约 10 分钟内有效。")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.fetchFeishuRegistration).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect(await screen.findByText("张三 的 EviMed 研究助手")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });

  it("says the platform's own sentence when a scan fails, and offers a new code", async () => {
    mocks.fetchImStatus.mockResolvedValue({ ...unbound, registration: { state: "error",
      error: { code: "access_denied", message: "你在飞书里拒绝了这次授权。需要时可以重新扫码。" } } });
    mocks.startFeishuRegistration.mockResolvedValue({ state: "error",
      error: { code: "access_denied", message: "你在飞书里拒绝了这次授权。需要时可以重新扫码。" } });
    render(<FeishuCard />);
    const start = await screen.findByRole("button", { name: /扫码创建飞书机器人/ });
    await act(async () => { fireEvent.click(start); });
    expect(screen.getByRole("alert")).toHaveTextContent("你在飞书里拒绝了这次授权。");
    expect(screen.getByRole("button", { name: /重新生成二维码/ })).toBeInTheDocument();
  });

  it("shows a bound bot, where each chat's questions go, and turns pushes off", async () => {
    mocks.fetchImStatus.mockResolvedValue(bound);
    mocks.setFeishuNotifications.mockResolvedValue({});
    render(<FeishuCard />);
    expect(await screen.findByText("单聊 · 跟随你最近使用的项目")).toBeInTheDocument();
    expect(screen.getByText("群聊 · 项目「肿瘤免疫」")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "已开启" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await act(async () => { fireEvent.click(toggle); });
    expect(mocks.setFeishuNotifications).toHaveBeenCalledWith(false);
  });

  it("asks before unbinding and says the app stays in Feishu", async () => {
    mocks.fetchImStatus.mockResolvedValueOnce(bound).mockResolvedValue(unbound);
    mocks.unbindFeishu.mockResolvedValue({ removed: 1 });
    render(<FeishuCard />);
    fireEvent.click(await screen.findByRole("button", { name: /解除绑定/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/机器人应用仍在你的飞书里/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "解除绑定" })); });
    expect(mocks.unbindFeishu).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /扫码创建飞书机器人/ })).toBeInTheDocument();
  });

  it("names an enterprise approval wait instead of a connection error", async () => {
    mocks.fetchImStatus.mockResolvedValue({ ...bound, feishu: { ...bound.feishu, activation: "pending", connection: null } });
    render(<FeishuCard />);
    expect(await screen.findByText("等待企业管理员启用")).toBeInTheDocument();
    expect(screen.getByText(/启用后会自动连上，不用重新扫码/)).toBeInTheDocument();
  });

  it("offers a retry when the status cannot be read", async () => {
    mocks.fetchImStatus.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(unbound);
    render(<FeishuCard />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /扫码创建飞书机器人/ })).toBeInTheDocument();
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
