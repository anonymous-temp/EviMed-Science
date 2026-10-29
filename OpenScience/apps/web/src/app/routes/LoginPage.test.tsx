import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

// Hoisted with the mocks: `vi.mock`'s factory runs before module-level
// declarations, so a class declared below it is not initialized yet.
const mocks = vi.hoisted(() => {
  class FakeWebApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status = 400) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    fetchWebMe: vi.fn(),
    fetchWebAuthMethods: vi.fn(),
    loginWeb: vi.fn(),
    loginDevelopmentWeb: vi.fn(),
    loginEvimedWeb: vi.fn(),
    logoutWeb: vi.fn(),
    registerWeb: vi.fn(),
    FakeWebApiError,
  };
});

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  fetchWebAuthMethods: mocks.fetchWebAuthMethods,
  loginWeb: mocks.loginWeb,
  loginDevelopmentWeb: mocks.loginDevelopmentWeb,
  loginEvimedWeb: mocks.loginEvimedWeb,
  logoutWeb: mocks.logoutWeb,
  registerWeb: mocks.registerWeb,
  WebApiError: mocks.FakeWebApiError,
  webErrorMessage: (error: unknown, options: { fallback?: string } = {}) => {
    if (error instanceof mocks.FakeWebApiError && error.code === "auth_rate_limited") return "尝试太频繁，请稍后再试。";
    if (error instanceof mocks.FakeWebApiError && error.status === 503) return "服务暂时不可用，请稍后重试。";
    return options.fallback ?? "操作未完成，请重试。";
  },
  getWebOidcStartUrl: (returnTo: string) => `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
}));

vi.mock("@/components/auth/EvimedAccountForm", () => ({
  EvimedAccountForm: ({ onSignedIn }: { onSignedIn: () => void }) => <button onClick={onSignedIn}>EviMed 账号表单</button>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}{location.hash}</div>;
}

function renderLogin(search = "") {
  const view = (visible: boolean) => (
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <Routes>
        <Route path="/login" element={visible ? <LoginPage /> : <LocationProbe />} />
        <Route path="/app/*" element={<LocationProbe />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
  const result = render(view(true));
  return { ...result, hideLogin: () => result.rerender(view(false)) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue(null);
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: false });
    mocks.loginWeb.mockResolvedValue(undefined);
    mocks.loginDevelopmentWeb.mockResolvedValue(undefined);
    mocks.loginEvimedWeb.mockResolvedValue(undefined);
    mocks.registerWeb.mockResolvedValue(undefined);
  });

  // Audit B01: a six-character minimum typed blind on a phone. The field's own button shows it, and hides it again.
  it("shows the password only when asked, keeps what was typed, and hides it again", async () => {
    renderLogin();
    const password = await screen.findByLabelText("密码");
    await userEvent.type(password, "secret");
    expect(password).toHaveAttribute("type", "password");
    const reveal = screen.getByRole("button", { name: "显示密码" });
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    // It is a button inside the field, not a second way to submit the form.
    expect(reveal).toHaveAttribute("type", "button");
    await userEvent.click(reveal);
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveValue("secret");
    expect(screen.getByRole("button", { name: "显示密码" })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveValue("secret");
  });

  it("has the same button on the registration form", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();
    await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "new-password");
  });

  it("opens as a Chinese username/password login and enters the workbench", async () => {
    renderLogin();

    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(mocks.loginWeb).toHaveBeenCalledWith("alice", "secret"));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/home");
  });

  // Design reference §16.3: signing in puts the reader back at the address they were sent away from.
  describe("returning to the address that was asked for", () => {
    const signIn = async () => {
      await userEvent.type(await screen.findByLabelText("账号"), "alice");
      await userEvent.type(screen.getByLabelText("密码"), "secret");
      await userEvent.click(screen.getByRole("button", { name: "登录" }));
    };

    it("goes back to the deep link, query and fragment included, after a password sign-in", async () => {
      renderLogin(`?next=${encodeURIComponent("/app/memory?tab=methods&q=%E8%83%8C#CLM-001")}`);
      await signIn();
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/memory?tab=methods&q=%E8%83%8C#CLM-001"));
    });

    it("goes back to it after a registration too", async () => {
      mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
      renderLogin(`?next=${encodeURIComponent("/app/files?tab=sources")}`);
      await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
      await userEvent.type(screen.getByLabelText("账号"), "alice");
      await userEvent.type(screen.getByLabelText("密码"), "secret");
      await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));
      await waitFor(() => expect(mocks.registerWeb).toHaveBeenCalledWith("alice", "secret"));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/files?tab=sources"));
    });

    it("hands the OIDC start the same address, so the callback can bring the reader back to it", async () => {
      mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "oidc", oidc: { label: "统一身份登录", startUrl: "/api/auth/oidc/start" } });
      renderLogin(`?next=${encodeURIComponent("/app/runs/run_1/files/report.md?quote=a%20b")}`);
      const link = await screen.findByRole("link", { name: /统一身份登录/ });
      expect(link).toHaveAttribute("href", `/api/auth/oidc/start?returnTo=${encodeURIComponent("/app/runs/run_1/files/report.md?quote=a%20b")}`);
    });

    it("sends someone who is already signed in straight to it", async () => {
      mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
      renderLogin(`?next=${encodeURIComponent("/app/autopilot?task=t1")}`);
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/autopilot?task=t1"));
    });

    it("uses the front door for a missing next and refuses every address that is not a page inside the app", async () => {
      renderLogin();
      await signIn();
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/home$/));
      cleanup();
      for (const hostile of ["//evil.example/app/chat", "/\\evil.example", "https://evil.example/", "/settings", "/app/%2e%2e/login", "/app//evil.example", "javascript:alert(1)"]) {
        mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
        const { unmount } = renderLogin(`?next=${encodeURIComponent(hostile)}`);
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/home$/));
        unmount();
      }
      mocks.fetchWebMe.mockResolvedValue(null);
      mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "oidc", oidc: { label: "统一身份登录", startUrl: "/api/auth/oidc/start" } });
      renderLogin(`?next=${encodeURIComponent("//evil.example")}`);
      expect(await screen.findByRole("link", { name: /统一身份登录/ })).toHaveAttribute("href", "/api/auth/oidc/start?returnTo=%2Fapp%2Fhome");
    });
  });

  // 2026-09-23 plan §5.10, mockup m12: the brand once, two labelled fields and
  // one button. No eyebrow, no sentence about the workspace, no disclaimer,
  // no icon or placeholder inside a field — the one icon in a field is the
  // password's own 「显示密码」 button, a control and not a decoration.
  it("shows the brand once, the fields by their labels alone, and nothing else", async () => {
    const { container } = renderLogin();
    const account = await screen.findByLabelText("账号");
    expect(screen.getAllByText("EviMed Science")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "登录" })).toBeInTheDocument();
    const password = screen.getByLabelText("密码");
    for (const field of [account, password]) expect(field).not.toHaveAttribute("placeholder");
    expect(account.parentElement?.querySelector("svg")).toBeNull();
    const icons = [...(password.parentElement?.querySelectorAll("svg") ?? [])];
    expect(icons).toHaveLength(1);
    expect(icons[0].closest("button")).toHaveAccessibleName("显示密码");
    expect(container.textContent).not.toMatch(/循证医学科研智能体|个人知识库|科研工作空间|不替代临床诊疗/);
    // The form's primary button is the one 44 px control.
    expect(screen.getByRole("button", { name: "登录" })).toHaveClass("h-form-primary");
  });

  it("redirects an existing session straight into the workbench", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    renderLogin();

    expect(await screen.findByTestId("location")).toHaveTextContent("/app/home");
  });

  it.each(["local", "evimed"])("allows an explicit EviMed reauthentication in %s mode without signing out the current account", async mode => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "reader", name: "Reader", authType: "evimed" } });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode, evimed: { account: {} } });
    renderLogin(`?reauth=evimed&next=${encodeURIComponent("/app/search?category=paper&q=aspirin#results")}`);
    const form = await screen.findByRole("button", { name: "EviMed 账号表单" });
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
    expect(mocks.logoutWeb).not.toHaveBeenCalled();
    expect(mocks.loginEvimedWeb).not.toHaveBeenCalled();
    await userEvent.click(form);
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/search?category=paper&q=aspirin#results");
    expect(mocks.logoutWeb).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "local" },
    { mode: "evimed", evimed: { sessionUrl: "/fixture/session" } },
    { mode: "oidc", evimed: { account: {} } },
    { mode: "development", evimed: { account: {} } },
  ])("does not hold an existing session on the login page when EviMed reauthentication is unavailable: $mode", async methods => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "reader", name: "Reader" } });
    mocks.fetchWebAuthMethods.mockResolvedValue(methods);
    renderLogin(`?reauth=evimed&next=${encodeURIComponent("/app/search?q=aspirin")}`);
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/search?q=aspirin");
    expect(screen.queryByRole("button", { name: "EviMed 账号表单" })).not.toBeInTheDocument();
    expect(mocks.logoutWeb).not.toHaveBeenCalled();
  });

  it("keeps the normal existing-session redirect for an unrecognized reauthentication value", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "reader", name: "Reader" } });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "evimed", evimed: { account: {} } });
    renderLogin("?reauth=local");
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/home");
    expect(mocks.logoutWeb).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example/app/search", "/app/%2e%2e/login", "//evil.example/app/search"])("validates the return address after explicit EviMed reauthentication: %s", async next => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "reader", name: "Reader" } });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", evimed: { account: {} } });
    renderLogin(`?reauth=evimed&next=${encodeURIComponent(next)}`);
    await userEvent.click(await screen.findByRole("button", { name: "EviMed 账号表单" }));
    expect(await screen.findByTestId("location")).toHaveTextContent(/^\/app\/home$/);
    expect(mocks.logoutWeb).not.toHaveBeenCalled();
  });

  it("enters an existing session even when sign-in method discovery fails", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    mocks.fetchWebAuthMethods.mockRejectedValue(new Error("Discovery unavailable"));
    renderLogin(`?next=${encodeURIComponent("/app/memory?tab=methods")}`);
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/memory?tab=methods");
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.loginEvimedWeb).not.toHaveBeenCalled();
  });

  it("offers a discovery retry without guessing a local sign-in method", async () => {
    mocks.fetchWebAuthMethods.mockRejectedValueOnce(new Error("Discovery unavailable"));
    renderLogin();
    const feedback = await screen.findByRole("alert");
    expect(feedback).toHaveTextContent("登录服务暂时不可用");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(feedback.closest(".auth-form-fields")).toBeNull();
    expect(feedback.compareDocumentPosition(screen.getByRole("button", { name: "重试" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("账号")).toBeInTheDocument();
    expect(mocks.fetchWebMe).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWebAuthMethods).toHaveBeenCalledTimes(2);
  });

  it("shows no credential form for an unknown authentication mode", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "unsupported" });
    renderLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent("登录服务暂时不可用");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.loginDevelopmentWeb).not.toHaveBeenCalled();
  });

  it("enters development mode with one action and no invented credentials, preserving the return address", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "development" });
    renderLogin(`?next=${encodeURIComponent("/app/files?tab=sources")}`);
    const enter = await screen.findByRole("button", { name: "进入工作台" });
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    await userEvent.click(enter);
    expect(mocks.loginDevelopmentWeb).toHaveBeenCalledTimes(1);
    expect(mocks.loginDevelopmentWeb).toHaveBeenCalledWith();
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.registerWeb).not.toHaveBeenCalled();
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/files?tab=sources");
  });

  it.each(["local", "evimed"])("keeps %s account-form deployments on the team flow without a local fallback", async mode => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode, selfRegistration: true, evimed: { account: {} } });
    renderLogin(`?next=${encodeURIComponent("/app/memory#methods")}`);
    const accountForm = await screen.findByRole("button", { name: "EviMed 账号表单" });
    expect(screen.queryByRole("button", { name: "使用本机账号登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回 EviMed 账号登录" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "还没有账号？注册一个" })).not.toBeInTheDocument();
    await userEvent.click(accountForm);
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/memory#methods");
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.registerWeb).not.toHaveBeenCalled();
    expect(mocks.loginEvimedWeb).not.toHaveBeenCalled();
  });

  it("uses the EviMed session action when the deployment only advertises cookie sign-in", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "evimed", evimed: { sessionUrl: "/api/auth/evimed/session", logoutUrl: "/api/auth/evimed/logout" } });
    renderLogin(`?next=${encodeURIComponent("/app/memory#methods")}`);
    const enter = await screen.findByRole("button", { name: "使用 EviMed 账号继续" });
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    await userEvent.click(enter);
    expect(mocks.loginEvimedWeb).toHaveBeenCalledTimes(1);
    expect(mocks.loginEvimedWeb).toHaveBeenCalledWith();
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.loginDevelopmentWeb).not.toHaveBeenCalled();
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/memory#methods");
  });

  it("distinguishes an expired EviMed session from a network failure", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "evimed" });
    mocks.loginEvimedWeb.mockRejectedValueOnce(new mocks.FakeWebApiError("unauthorized", 401));
    mocks.loginEvimedWeb.mockRejectedValueOnce(new Error("Network unavailable"));
    renderLogin();
    await userEvent.click(await screen.findByRole("button", { name: "使用 EviMed 账号继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("EviMed 登录状态已失效");
    await userEvent.click(screen.getByRole("button", { name: "使用 EviMed 账号继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("登录没有完成，请检查网络后重试。");
  });

  it("validates missing local fields on submit and focuses the first missing field", async () => {
    renderLogin();
    const account = await screen.findByLabelText("账号");
    const password = screen.getByLabelText("密码");
    expect(screen.getByRole("form", { name: "登录" })).toHaveAttribute("novalidate");
    expect(account).not.toHaveAttribute("aria-invalid");
    expect(password).not.toHaveAttribute("aria-invalid");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(account).toHaveAccessibleErrorMessage("请输入账号。");
    expect(account).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(document.getElementById(account.getAttribute("aria-errormessage") ?? "")?.querySelector('[role="alert"]')).toBeNull();
    await userEvent.type(account, "alice");
    expect(account).not.toHaveAttribute("aria-invalid");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(password).toHaveAccessibleErrorMessage("请输入密码。");
    expect(password).toHaveFocus();
    expect(mocks.loginWeb).not.toHaveBeenCalled();
  });

  it("keeps credential, server, and network sign-in failures distinct and retryable", async () => {
    mocks.loginWeb.mockRejectedValueOnce(new mocks.FakeWebApiError("unauthorized", 401));
    mocks.loginWeb.mockRejectedValueOnce(new mocks.FakeWebApiError("unavailable", 503));
    mocks.loginWeb.mockRejectedValueOnce(new Error("Network unavailable"));
    renderLogin();
    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    for (const message of ["账号或密码不正确", "服务暂时不可用", "登录没有完成，请检查网络后重试"]) {
      await userEvent.click(screen.getByRole("button", { name: "登录" }));
      const feedback = await screen.findByRole("alert");
      expect(feedback).toHaveTextContent(message);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(feedback.closest(".auth-form-fields")).toBeNull();
      expect(feedback.compareDocumentPosition(screen.getByRole("button", { name: "登录" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByLabelText("账号")).toHaveValue("alice");
      expect(screen.getByLabelText("密码")).toHaveValue("secret");
      expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
    }
    await userEvent.type(screen.getByLabelText("密码"), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("账号")).toHaveValue("alice");
    expect(screen.getByLabelText("密码")).toHaveValue("secretx");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/app/home");
  });

  it("clears the local service failure when switching to registration", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    mocks.loginWeb.mockRejectedValueOnce(new mocks.FakeWebApiError("unauthorized", 401));
    renderLogin();
    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号或密码不正确");
    await userEvent.click(screen.getByRole("button", { name: "还没有账号？注册一个" }));
    expect(screen.getByRole("heading", { name: "注册" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("账号")).toHaveValue("alice");
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(mocks.registerWeb).not.toHaveBeenCalled();
  });

  it("submits once when a second submit arrives before rendering the busy state", async () => {
    const response = deferred<void>();
    mocks.loginWeb.mockReturnValue(response.promise);
    renderLogin();
    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    const form = screen.getByRole("form", { name: "登录" });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(mocks.loginWeb).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
    await act(async () => { response.resolve(undefined); await response.promise; });
    expect(screen.getByTestId("location")).toHaveTextContent("/app/home");
  });

  it("ignores a successful response after the login page unmounts", async () => {
    const response = deferred<void>();
    mocks.loginWeb.mockReturnValue(response.promise);
    const view = renderLogin();
    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    view.hideLogin();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    await act(async () => { response.resolve(undefined); await response.promise; });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
  });

  // The server decides whether this deployment takes new accounts. Offering
  // the link anyway would put a button here that answers 403.
  it("offers no way to register when the deployment does not accept accounts", async () => {
    renderLogin();
    await screen.findByLabelText("账号");
    expect(screen.queryByRole("button", { name: /注册/ })).not.toBeInTheDocument();
  });

  it("registers and lands in the workbench, signed in", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
    expect(screen.getByRole("heading", { name: "注册" })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("账号"), "bob");
    await userEvent.type(screen.getByLabelText("密码"), "another correct horse");
    await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    await waitFor(() => expect(mocks.registerWeb).toHaveBeenCalledWith("bob", "another correct horse"));
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/home");
  });

  // Each refusal has a different remedy, and a single "registration failed"
  // would make all of them read as our fault rather than something to fix.
  it("says which of the refusals happened", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    const cases: [string, RegExp][] = [
      ["user_exists", /已经有人用了/],
      ["weak_password", /密码至少 6 位/],
      ["auth_rate_limited", /尝试太频繁/],
    ];
    for (const [code, message] of cases) {
      mocks.registerWeb.mockRejectedValueOnce(new mocks.FakeWebApiError(code));
      const { unmount } = renderLogin();

      await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
      await userEvent.type(screen.getByLabelText("账号"), "bob");
      await userEvent.type(screen.getByLabelText("密码"), "whatever");
      await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      unmount();
    }
  });

  // Live walk 2026-10-10: the six-character rule was shown only after a refused request, as a line under the buttons.
  it("states the password rule with the field while registering, and checks it before any request", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();
    expect(await screen.findByLabelText("密码")).not.toHaveAttribute("aria-describedby");
    await userEvent.click(screen.getByRole("button", { name: "还没有账号？注册一个" }));
    const password = screen.getByLabelText("密码");
    expect(password).toHaveAccessibleDescription("至少 6 位");
    await userEvent.type(screen.getByLabelText("账号"), "bob");
    await userEvent.type(password, "abc");
    await userEvent.click(screen.getByRole("button", { name: "注册并进入" }));
    expect(mocks.registerWeb).not.toHaveBeenCalled();
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleErrorMessage("密码至少 6 位。");
    expect(password).toHaveFocus();
    await userEvent.type(password, "defgh");
    expect(password).not.toHaveAttribute("aria-invalid");
  });

  it("goes back to signing in from the register form", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "还没有账号？注册一个" }));
    await userEvent.click(screen.getByRole("button", { name: "已有账号？返回登录" }));
    expect(screen.getByRole("heading", { name: "登录" })).toBeInTheDocument();
  });

  it("clears and conceals the secret when switching between local login and registration", async () => {
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", selfRegistration: true });
    renderLogin();
    await userEvent.type(await screen.findByLabelText("账号"), "alice");
    await userEvent.type(screen.getByLabelText("密码"), "login-secret");
    await userEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "还没有账号？注册一个" }));
    expect(screen.getByLabelText("账号")).toHaveValue("alice");
    expect(screen.getByLabelText("账号")).toHaveFocus();
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "new-password");
    await userEvent.type(screen.getByLabelText("密码"), "new-secret");
    await userEvent.click(screen.getByRole("button", { name: "已有账号？返回登录" }));
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
    expect(mocks.loginWeb).not.toHaveBeenCalled();
    expect(mocks.registerWeb).not.toHaveBeenCalled();
  });
});
