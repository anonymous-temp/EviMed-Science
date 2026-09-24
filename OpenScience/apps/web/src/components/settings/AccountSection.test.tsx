import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSection } from "./AccountSection";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  exportWebAccount: vi.fn(),
  deleteWebAccount: vi.fn(),
  logoutWeb: vi.fn(),
  fetchWebAuthMethods: vi.fn(),
  changeWebPassword: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebMe: mocks.fetchWebMe,
  exportWebAccount: mocks.exportWebAccount,
  deleteWebAccount: mocks.deleteWebAccount,
  logoutWeb: mocks.logoutWeb,
  fetchWebAuthMethods: mocks.fetchWebAuthMethods,
  changeWebPassword: mocks.changeWebPassword,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("./FeishuRows", () => ({ FeishuAccountRow: () => <div>飞书绑定行</div> }));

function open({ imEnabled = false } = {}) {
  return render(
    <MemoryRouter initialEntries={["/app/account"]}>
      <Routes>
        <Route path="/app/account" element={<AccountSection imEnabled={imEnabled} />} />
        <Route path="/login" element={<p>登录页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("账户", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "cdss-access" },
      project: { id: "default", name: "我的研究" },
      projects: [{ id: "default", name: "我的研究" }],
    });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local" });
    mocks.exportWebAccount.mockResolvedValue(new Blob(["account-archive"]));
    mocks.deleteWebAccount.mockResolvedValue(undefined);
    mocks.logoutWeb.mockResolvedValue(undefined);
    mocks.changeWebPassword.mockResolvedValue(undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:account-archive") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("is one group, one item per row: 用户名, 密码, 退出登录 — and never the account id", async () => {
    open();
    const group = (await screen.findByRole("heading", { name: "账户" })).closest("section")!;
    expect(await within(group).findByText("cdss-access")).toBeInTheDocument();
    expect(within(group).getByText("用户名")).toBeInTheDocument();
    expect(await within(group).findByRole("button", { name: "修改" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "退出" })).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    for (const gone of [/每个账号的数据彼此独立/, /数据独立/, /刷新账户/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(screen.queryByText("飞书绑定行")).not.toBeInTheDocument();
  });

  it("puts Feishu in the account group where the deployment runs the IM module", async () => {
    open({ imEnabled: true });
    const group = (await screen.findByRole("heading", { name: "账户" })).closest("section")!;
    expect(within(group).getByText("飞书绑定行")).toBeInTheDocument();
  });

  it("changes the password in place under its row", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "修改" }));
    const form = screen.getByRole("form", { name: "修改密码" });
    await user.type(within(form).getByLabelText("当前密码"), "old-password-1");
    await user.type(within(form).getByLabelText("新密码"), "short");
    expect(within(form).getAllByText("至少 8 位").length).toBeGreaterThan(0);
    await user.clear(within(form).getByLabelText("新密码"));
    await user.type(within(form).getByLabelText("新密码"), "new-password-1");
    await user.type(within(form).getByLabelText("再输一次新密码"), "new-password-1");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.changeWebPassword).toHaveBeenCalledWith("old-password-1", "new-password-1"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("密码已更新");
    expect(screen.queryByRole("form", { name: "修改密码" })).not.toBeInTheDocument();
  });

  it("offers no password row where the identity provider owns the password", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "oidc" });
    open();
    await screen.findByText("cdss-access");
    await waitFor(() => expect(mocks.fetchWebAuthMethods).toHaveBeenCalled());
    expect(screen.queryByText("密码")).not.toBeInTheDocument();
  });

  it("signs out and leaves for the login page", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "退出" }));
    await waitFor(() => expect(mocks.logoutWeb).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("登录页")).toBeInTheDocument();
  });

  it("exports the account's archive", async () => {
    open();
    await screen.findByText("cdss-access");
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => expect(mocks.exportWebAccount).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已导出");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("deletes the account only as a destructive text action that asks for the exact account id", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("cdss-access");
    const remove = screen.getByRole("button", { name: "删除" });
    expect(remove).toHaveClass("text-danger");
    await user.click(remove);
    const form = screen.getByRole("form", { name: "删除账户" });
    expect(within(form).getByText("将删除账户及全部项目，不可恢复。")).toBeInTheDocument();
    const confirm = within(form).getByRole("button", { name: "删除账户" });
    expect(confirm).toBeDisabled();
    await user.type(within(form).getByLabelText("输入账户 ID「alice」确认"), "alice-other");
    expect(confirm).toBeDisabled();
    await user.clear(within(form).getByLabelText("输入账户 ID「alice」确认"));
    await user.type(within(form).getByLabelText("输入账户 ID「alice」确认"), "alice");
    await user.type(within(form).getByLabelText("当前密码（如需要）"), "secret-password");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(mocks.deleteWebAccount).toHaveBeenCalledWith("alice", "secret-password"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("账户已删除");
    expect(await screen.findByText("登录页")).toBeInTheDocument();
  });
});
