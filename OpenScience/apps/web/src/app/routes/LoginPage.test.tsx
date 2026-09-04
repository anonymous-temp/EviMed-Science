import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

// Hoisted with the mocks: `vi.mock`'s factory runs before module-level
// declarations, so a class declared below it is not initialized yet.
const mocks = vi.hoisted(() => {
  class FakeWebApiError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    fetchWebMe: vi.fn(),
    fetchWebAuthMethods: vi.fn(),
    loginWeb: vi.fn(),
    loginDevelopmentWeb: vi.fn(),
    registerWeb: vi.fn(),
    FakeWebApiError,
  };
});

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  fetchWebAuthMethods: mocks.fetchWebAuthMethods,
  loginWeb: mocks.loginWeb,
  loginDevelopmentWeb: mocks.loginDevelopmentWeb,
  registerWeb: mocks.registerWeb,
  WebApiError: mocks.FakeWebApiError,
  getWebOidcStartUrl: () => "/api/auth/oidc/start?returnTo=%2Fapp%2Fchat",
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/app/chat" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue(null);
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: false });
    mocks.loginWeb.mockResolvedValue(undefined);
    mocks.registerWeb.mockResolvedValue(undefined);
  });

  it("opens as a Chinese username/password login and enters the workbench", async () => {
    renderLogin();

    await userEvent.type(await screen.findByPlaceholderText("请输入账号"), "alice");
    expect(screen.getByText(/不替代临床诊疗或专业判断/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("请输入密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(mocks.loginWeb).toHaveBeenCalledWith("alice", "secret"));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat");
  });

  it("redirects an existing session straight into the workbench", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderLogin();

    expect(await screen.findByTestId("location")).toHaveTextContent("/app/chat");
  });

  // The server decides whether this deployment takes new accounts. Offering
  // the link anyway would put a button here that answers 403.
  it("offers no way to register when the deployment does not accept accounts", async () => {
    renderLogin();
    await screen.findByPlaceholderText("请输入账号");
    expect(screen.queryByRole("button", { name: /注册/ })).not.toBeInTheDocument();
  });

  it("registers and lands in the workbench, signed in", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
    expect(screen.getByRole("heading", { name: "注册 EviMed" })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("请输入账号"), "bob");
    await userEvent.type(screen.getByPlaceholderText("请输入密码"), "another correct horse");
    await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    await waitFor(() => expect(mocks.registerWeb).toHaveBeenCalledWith("bob", "another correct horse"));
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat");
  });

  // Each refusal has a different remedy, and a single "registration failed"
  // would make all of them read as our fault rather than something to fix.
  it("says which of the refusals happened", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    const cases: [string, RegExp][] = [
      ["user_exists", /已经有人用了/],
      ["weak_password", /密码至少 8 位/],
      ["auth_rate_limited", /尝试太频繁/],
    ];
    for (const [code, message] of cases) {
      mocks.registerWeb.mockRejectedValueOnce(new mocks.FakeWebApiError(code));
      const { unmount } = renderLogin();

      await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
      await userEvent.type(screen.getByPlaceholderText("请输入账号"), "bob");
      await userEvent.type(screen.getByPlaceholderText("请输入密码"), "whatever");
      await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      unmount();
    }
  });

  it("goes back to signing in from the register form", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
    await userEvent.click(screen.getByRole("button", { name: "已有账号？返回登录" }));
    expect(screen.getByRole("heading", { name: "登录 EviMed" })).toBeInTheDocument();
  });
});
