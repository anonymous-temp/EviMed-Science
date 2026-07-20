import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAccountCard } from "./WebAccountCard";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  exportWebAccount: vi.fn(),
  deleteWebAccount: vi.fn(),
  logoutWeb: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  exportWebAccount: mocks.exportWebAccount,
  deleteWebAccount: mocks.deleteWebAccount,
  logoutWeb: mocks.logoutWeb,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

describe("WebAccountCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice" },
      project: { id: "default", name: "Default Project" },
      projects: [{ id: "default", name: "Default Project" }],
    });
    mocks.exportWebAccount.mockResolvedValue(new Blob(["account-archive"]));
    mocks.deleteWebAccount.mockResolvedValue(undefined);
    mocks.logoutWeb.mockResolvedValue(undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:account-archive"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the current hosted account archive", async () => {
    render(<WebAccountCard />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出账户归档" }));

    await waitFor(() => expect(mocks.exportWebAccount).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("账户归档已导出。");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("requires exact account id confirmation before deleting the account", async () => {
    const onAccountDeleted = vi.fn();
    render(<WebAccountCard onAccountDeleted={onAccountDeleted} />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开账户删除" }));

    const confirmButton = screen.getByRole("button", { name: "确认删除账户" });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "确认账户 id" }), {
      target: { value: "alice-other" },
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "确认账户 id" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "secret-password" },
    });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mocks.deleteWebAccount).toHaveBeenCalledWith("alice", "secret-password"),
    );
    expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("账户已删除。");
    expect(await screen.findByText("账户已删除。请重新登录以继续使用。")).toBeInTheDocument();
  });

  it("revokes the hosted session and reports sign-out", async () => {
    const onSignedOut = vi.fn();
    render(<WebAccountCard onSignedOut={onSignedOut} />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(mocks.logoutWeb).toHaveBeenCalledTimes(1));
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已退出登录。");
    expect(await screen.findByText("当前没有登录托管账户。")).toBeInTheDocument();
  });
});
