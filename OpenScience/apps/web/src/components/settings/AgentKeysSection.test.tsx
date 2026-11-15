import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError, type WebAgentKey } from "@/lib/apiClient";
import { WEB_SESSION_ENDED_EVENT } from "@/lib/sessionLifecycle";
import { AgentKeysSection } from "./AgentKeysSection";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebAgentKeys: mocks.list, createWebAgentKey: mocks.create, revokeWebAgentKey: mocks.revoke,
}));
const record: WebAgentKey = { id: "agk_hidden", name: "Local DSH", scopes: ["memory.read"], createdAt: "2026-11-15T00:00:00Z", lastUsedAt: null, revokedAt: null, expiresAt: null, projectId: null };
const catalogue = { keys: [record], scopes: ["memory.read", "memory.write", "memory.manage", "memory.observe", "analysis.read", "analysis.write", "unknown.future"] };
const secret = "evk_once_only_fixture";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(catalogue);
  mocks.create.mockResolvedValue({ ...record, id: "agk_new", name: "My DSH", key: secret });
  mocks.revoke.mockResolvedValue({ ...record, revokedAt: "2026-11-15T01:00:00Z" });
});
afterEach(() => { vi.restoreAllMocks(); });
async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "创建密钥" }));
  await user.type(screen.getByLabelText("密钥名称"), "My DSH");
  await user.click(screen.getByRole("button", { name: "创建" }));
  return screen.findByLabelText("新密钥（仅显示这一次）");
}
describe("external agent keys", () => {
  it("lists names, permissions and dates without raw identifiers, and offers only supported scopes", async () => {
    const user = userEvent.setup(); render(<AgentKeysSection />);
    expect(await screen.findByText("Local DSH")).toBeInTheDocument();
    expect(screen.getByText(/创建于 2026-11-15/)).toBeInTheDocument();
    expect(screen.getByText(/尚未使用/)).toBeInTheDocument();
    expect(screen.queryByText("agk_hidden")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建密钥" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByLabelText("读取记忆与做法")).toBeChecked();
    expect(screen.getByLabelText("提出待确认的记忆")).not.toBeChecked();
    expect(screen.getByLabelText("管理记忆（确认、修改和忘记）")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
  });
  it("uses only scopes offered by this deployment and shows the last-use date", async () => {
    mocks.list.mockResolvedValue({ keys: [{ ...record, lastUsedAt: "2026-11-16T00:00:00Z" }], scopes: ["memory.read"] });
    const user = userEvent.setup(); render(<AgentKeysSection />);
    expect(await screen.findByText(/最近使用于 2026-11-16/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建密钥" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
  it("creates selected scopes, copies the secret once, and clears it on dismissal without persisting it", async () => {
    const user = userEvent.setup(); const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const storage = vi.spyOn(Storage.prototype, "setItem"); render(<AgentKeysSection />);
    await user.click(await screen.findByRole("button", { name: "创建密钥" }));
    await user.type(screen.getByLabelText("密钥名称"), "My DSH");
    await user.click(screen.getByLabelText("提出待确认的记忆"));
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByLabelText("新密钥（仅显示这一次）")).toHaveValue(secret);
    expect(mocks.create).toHaveBeenCalledWith({ name: "My DSH", scopes: ["memory.read", "memory.write"] });
    expect(screen.getByText(/保存到本机文件/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制密钥" }));
    expect(copy).toHaveBeenCalledWith(secret);
    await user.click(screen.getByRole("button", { name: "我已保存，关闭" }));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(storage.mock.calls.some(([, value]) => String(value).includes(secret))).toBe(false);
    await user.click(screen.getByRole("button", { name: "创建密钥" }));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
  it("keeps the one-time value selectable if copying is refused", async () => {
    const user = userEvent.setup(); vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("blocked"));
    render(<AgentKeysSection />); await create(user);
    await user.click(screen.getByRole("button", { name: "复制密钥" }));
    expect(await screen.findByText("无法自动复制，请选中上方密钥手动复制。")).toBeInTheDocument();
    expect(screen.getByDisplayValue(secret)).toBeInTheDocument();
  });
  it("revokes the chosen key and clears an unsaved secret for that key", async () => {
    const user = userEvent.setup(); render(<AgentKeysSection />); await create(user);
    mocks.revoke.mockResolvedValue({ ...record, id: "agk_new", name: "My DSH", revokedAt: "2026-11-15T01:00:00Z" });
    await user.click(screen.getByRole("button", { name: "撤销密钥“My DSH”" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("agk_new"));
    await waitFor(() => expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument());
    const row = screen.getByText("My DSH").closest("div.px-4")!;
    expect(within(row as HTMLElement).getByText("已撤销")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });
  it("shows one sentence and no controls when the deployment disables the API", async () => {
    mocks.list.mockRejectedValue(new WebApiError("disabled", { status: 503, code: "agent_memory_disabled" }));
    render(<AgentKeysSection />);
    expect(await screen.findByText("此部署尚未启用外部智能体访问。")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("distinguishes a read failure from disabled and can retry", async () => {
    mocks.list.mockRejectedValueOnce(new Error("offline")); render(<AgentKeysSection />);
    expect(await screen.findByText("暂时无法读取 API 密钥。")).toBeInTheDocument();
    mocks.list.mockResolvedValue(catalogue);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Local DSH")).toBeInTheDocument();
  });
  it("keeps revoke failures visible and disables duplicate mutations while waiting", async () => {
    let reject: (error: Error) => void = () => {};
    mocks.revoke.mockImplementation(() => new Promise((_resolve, refuse) => { reject = refuse; }));
    const user = userEvent.setup(); render(<AgentKeysSection />);
    const button = await screen.findByRole("button", { name: "撤销密钥“Local DSH”" });
    await user.click(button); await user.click(button);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("offline")));
    expect(await screen.findByText("暂时无法撤销密钥，请重试。")).toBeInTheDocument();
    expect(screen.getByText("Local DSH")).toBeInTheDocument();
  });
  it("does not claim success or auto-retry an unknown creation outcome", async () => {
    mocks.create.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup(); render(<AgentKeysSection />);
    await user.click(await screen.findByRole("button", { name: "创建密钥" }));
    await user.type(screen.getByLabelText("密钥名称"), "My DSH");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/创建结果暂时无法确认/)).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
  it("clears an already displayed secret when the browser session ends", async () => {
    const user = userEvent.setup(); render(<AgentKeysSection />); await create(user);
    act(() => window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
  it("clears credentials across session boundaries and discards late creations", async () => {
    let settle: (value: unknown) => void = () => {};
    mocks.create.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const user = userEvent.setup(); render(<AgentKeysSection />);
    await user.click(await screen.findByRole("button", { name: "创建密钥" }));
    await user.type(screen.getByLabelText("密钥名称"), "My DSH");
    await user.click(screen.getByRole("button", { name: "创建" }));
    act(() => window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)));
    await act(async () => settle({ ...record, key: secret }));
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });
});
