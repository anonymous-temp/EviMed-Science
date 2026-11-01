import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "@/app/routes/LoginPage";
import { EvimedAccountForm } from "./EvimedAccountForm";

const mocks = vi.hoisted(() => {
  class FakeWebApiError extends Error {
    constructor(public code: string, public status = 400) { super("Private provider diagnostic: fixture-secret"); }
  }
  return {
    fetchEvimedCaptcha: vi.fn(), sendEvimedCode: vi.fn(), loginEvimedPassword: vi.fn(), loginEvimedSms: vi.fn(),
    registerEvimedAccount: vi.fn(), verifyEvimedCode: vi.fn(), resetEvimedPassword: vi.fn(),
    fetchWebMe: vi.fn(), fetchWebAuthMethods: vi.fn(), loginEvimedWeb: vi.fn(), loginWeb: vi.fn(),
    loginDevelopmentWeb: vi.fn(), registerWeb: vi.fn(), FakeWebApiError,
  };
});
vi.mock("@/lib/apiClient", () => ({
  ...mocks,
  WebApiError: mocks.FakeWebApiError,
  webErrorMessage: (_error: unknown, options: { fallback?: string } = {}) => options.fallback ?? "操作未完成，请重试。",
  getWebOidcStartUrl: () => "/fixture/oidc",
}));

// The test exercises orchestration and the captured identity, without rendering or solving a provider puzzle.
vi.mock("./SliderCaptcha", () => ({
  SliderCaptcha: ({ busy, onComplete, onRefresh }: { busy: boolean; onComplete: (value: string) => void; onRefresh: () => void }) => <>
    <button type="button" disabled={busy} onClick={() => onComplete("25")}>完成安全验证</button>
    <button type="button" disabled={busy} onClick={onRefresh}>刷新验证图片</button>
  </>,
}));

const PHONE = "13800138000";
const OTHER_PHONE = "13900139000";
const CODE = "123456";
const CAPTCHA = { canvasSrc: "fixture-canvas", blockSrc: "fixture-block", blockX: 20, blockY: 30, canvasWidth: 350, canvasHeight: 200, blockWidth: 50, blockHeight: 50 };
const ACCOUNT_METHODS = {
  captchaUrl: "/fixture/captcha", sendCodeUrl: "/fixture/send-code", passwordLoginUrl: "/fixture/password-login",
  smsLoginUrl: "/fixture/sms-login", registerUrl: "/fixture/register", verifyCodeUrl: "/fixture/verify-code", resetPasswordUrl: "/fixture/reset-password",
};

function renderAccount() {
  const signedIn = vi.fn();
  const result = render(<EvimedAccountForm onSignedIn={signedIn} />);
  return { ...result, user: userEvent.setup(), signedIn };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fillPhone(user: ReturnType<typeof userEvent.setup>, phone = PHONE, code = CODE) {
  const input = screen.getByLabelText("手机号");
  await user.clear(input); await user.type(input, phone);
  const verification = screen.getByLabelText("短信验证码");
  await user.clear(verification); await user.type(verification, code);
}
async function agree(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /阅读并接受/ }));
}
async function completeCaptcha(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "获取验证码" }));
  const dialog = await screen.findByRole("dialog", { name: "安全验证" });
  await user.click(await within(dialog).findByRole("button", { name: "完成安全验证" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "安全验证" })).not.toBeInTheDocument());
}
async function enterRegistration(user: ReturnType<typeof userEvent.setup>, password = "abc123") {
  await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
  await fillPhone(user);
  await user.click(screen.getByRole("button", { name: "下一步" }));
  await user.type(screen.getByLabelText("设置密码"), password);
  await user.type(screen.getByLabelText("确认密码"), password);
  await agree(user);
}
function expectActionFeedback(feedback: HTMLElement, submit: HTMLElement) {
  expect(feedback.closest(".auth-form-fields")).toBeNull();
  expect(feedback.closest(".auth-feedback-slot")).not.toBeNull();
  const actions = feedback.closest(".auth-form-actions");
  expect(actions).not.toBeNull();
  expect(actions).toContainElement(submit);
  expect(feedback.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchEvimedCaptcha.mockResolvedValue(CAPTCHA);
  for (const name of ["sendEvimedCode", "loginEvimedPassword", "loginEvimedSms", "registerEvimedAccount", "verifyEvimedCode", "resetEvimedPassword"] as const) mocks[name].mockResolvedValue(undefined);
  mocks.fetchWebMe.mockResolvedValue(null);
  mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local", evimed: { account: ACCOUNT_METHODS } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("EvimedAccountForm", () => {
  it("labels its fields and validates only on submit, focusing the first missing field and then agreement", async () => {
    const { user } = renderAccount();
    const phone = screen.getByLabelText("手机号"), code = screen.getByLabelText("短信验证码");
    expect(screen.getByRole("form", { name: "验证码登录" })).toHaveAttribute("novalidate");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    expect(phone).toHaveAccessibleErrorMessage("请输入正确的 11 位手机号。");
    expect(code).toHaveAccessibleErrorMessage("请输入 4–6 位短信验证码。");
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(document.getElementById(phone.getAttribute("aria-errormessage") ?? "")?.querySelector('[role="alert"]')).toBeNull();
    await waitFor(() => expect(phone).toHaveFocus());
    await fillPhone(user);
    expect(phone).not.toHaveAttribute("aria-invalid");
    expect(code).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    const agreement = screen.getByRole("checkbox", { name: /阅读并接受/ });
    expect(agreement).toHaveAccessibleDescription("请先阅读并接受用户协议和隐私政策。");
    await waitFor(() => expect(agreement).toHaveFocus());
    expect(mocks.loginEvimedSms).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "用户协议" })).toHaveAttribute("href", "/static/agreement.html");
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/static/privacyPolicy.html");
  });

  it("submits the SMS identity once and calls the navigation callback only after success", async () => {
    const response = deferred<void>();
    mocks.loginEvimedSms.mockReturnValue(response.promise);
    const { user, signedIn } = renderAccount();
    await fillPhone(user); await agree(user);
    const form = screen.getByRole("form", { name: "验证码登录" });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(mocks.loginEvimedSms).toHaveBeenCalledTimes(1);
    expect(mocks.loginEvimedSms).toHaveBeenCalledWith(PHONE, CODE);
    expect(signedIn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "登录 / 注册" })).toBeDisabled();
    await act(async () => { response.resolve(undefined); await response.promise; });
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it("keeps rejected SMS credentials and network failures distinct, hides provider details, and allows retry", async () => {
    mocks.loginEvimedSms.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_credential_rejected", 401));
    mocks.loginEvimedSms.mockRejectedValueOnce(new Error("Private provider diagnostic: fixture-secret"));
    const { user, signedIn } = renderAccount();
    await fillPhone(user); await agree(user);
    for (const message of ["验证码不正确或已过期", "操作未完成，请检查网络后重试"]) {
      await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
      const feedback = await screen.findByRole("alert");
      expect(feedback).toHaveTextContent(message);
      expectActionFeedback(feedback, screen.getByRole("button", { name: "登录 / 注册" }));
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByText("未注册手机号将自动注册")).not.toBeInTheDocument();
      expect(screen.queryByText(/fixture-secret/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("手机号")).toHaveValue(PHONE);
      expect(screen.getByLabelText("短信验证码")).toHaveValue(CODE);
      expect(signedIn).not.toHaveBeenCalled();
    }
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalledTimes(1));
  });

  it("clears a service failure on input edit or mode change without discarding the retry fields", async () => {
    mocks.loginEvimedSms.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_credential_rejected", 401));
    mocks.loginEvimedSms.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_unreachable", 503));
    const { user, signedIn } = renderAccount();
    await fillPhone(user); await agree(user);
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("验证码不正确或已过期");
    const code = screen.getByLabelText("短信验证码");
    await user.clear(code); await user.type(code, "654321");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("未注册手机号将自动注册")).toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toHaveValue(PHONE);
    expect(screen.getByRole("checkbox", { name: /阅读并接受/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号服务暂时不可用");
    expect(mocks.loginEvimedSms).toHaveBeenLastCalledWith(PHONE, "654321");
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    expect(screen.getByRole("heading", { name: "注册账号" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回登录" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("未注册手机号将自动注册")).toBeInTheDocument();
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("uses the password login helper with a trimmed account and unchanged password", async () => {
    const { user, signedIn } = renderAccount();
    await user.click(screen.getByRole("tab", { name: "账号密码" }));
    await user.type(screen.getByLabelText("账号或手机号"), "  alice@example.com  ");
    const password = screen.getByLabelText("密码");
    await user.type(password, " raw password 123 ");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    await agree(user);
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(mocks.loginEvimedPassword).toHaveBeenCalledWith("alice@example.com", " raw password 123 "));
    expect(mocks.loginEvimedSms).not.toHaveBeenCalled();
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it("advances registration locally after phone/code validation without validating hidden password fields or calling an API", async () => {
    const { user } = renderAccount();
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    const form = screen.getByRole("form", { name: "注册账号" });
    expect(form).toHaveAttribute("data-view", "register-phone");
    expect(form.closest(".auth-account-layout")).toHaveAttribute("data-mode", "register");
    expect(form.closest(".auth-account-layout")).toHaveAttribute("data-stage", "1");
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByLabelText("手机号")).toHaveAccessibleErrorMessage("请输入正确的 11 位手机号。");
    await waitFor(() => expect(screen.getByLabelText("手机号")).toHaveFocus());
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(form).toHaveAttribute("data-view", "register-password");
    expect(form.closest(".auth-account-layout")).toHaveAttribute("data-stage", "2");
    expect(screen.queryByLabelText("手机号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("短信验证码")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/已验证/)).not.toBeInTheDocument();
    expect(screen.getByText("手机号 138****8000")).toBeInTheDocument();
    expect(screen.getByLabelText("设置密码")).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: /阅读并接受/ })).not.toBeChecked();
    for (const name of ["verifyEvimedCode", "registerEvimedAccount", "sendEvimedCode", "fetchEvimedCaptcha", "loginEvimedPassword", "loginEvimedSms"] as const) {
      expect(mocks[name]).not.toHaveBeenCalled();
    }
  });

  it("clears second-stage secrets on back, binds registration to edited phone/code, and resets the stage after success", async () => {
    const { user, signedIn } = renderAccount();
    await enterRegistration(user);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("设置密码")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "修改手机信息" }));
    expect(screen.getByLabelText("手机号")).toHaveValue(PHONE);
    expect(screen.getByLabelText("短信验证码")).toHaveValue(CODE);
    expect(screen.getByLabelText("手机号")).toHaveFocus();
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await fillPhone(user, OTHER_PHONE, "654321");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("手机号 139****9000")).toBeInTheDocument();
    expect(screen.queryByText(/已验证/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("设置密码")).toHaveValue("");
    expect(screen.getByLabelText("设置密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: /阅读并接受/ })).not.toBeChecked();
    expect(mocks.registerEvimedAccount).not.toHaveBeenCalled();
    expect(mocks.verifyEvimedCode).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("设置密码"), "new123");
    await user.type(screen.getByLabelText("确认密码"), "new123");
    await agree(user);
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(mocks.registerEvimedAccount).toHaveBeenCalledTimes(1);
    expect(mocks.registerEvimedAccount).toHaveBeenCalledWith(OTHER_PHONE, "654321", "new123");
    expect(await screen.findByRole("status")).toHaveTextContent("注册成功");
    expect(screen.getByLabelText("账号或手机号")).toHaveValue(OTHER_PHONE);
    expect(signedIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    expect(screen.getByRole("form", { name: "注册账号" })).toHaveAttribute("data-view", "register-phone");
    expect(screen.getByLabelText("短信验证码")).toHaveValue("");
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
  });

  it("forgets an unfinished registration stage and its sensitive fields when leaving the mode", async () => {
    const { user } = renderAccount();
    await enterRegistration(user);
    await user.click(screen.getByRole("button", { name: "返回登录" }));
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    expect(screen.getByRole("form", { name: "注册账号" })).toHaveAttribute("data-view", "register-phone");
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByLabelText("设置密码")).toHaveValue("");
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: /阅读并接受/ })).not.toBeChecked();
    expect(mocks.registerEvimedAccount).not.toHaveBeenCalled();
    expect(mocks.verifyEvimedCode).not.toHaveBeenCalled();
  });

  it("rejects invalid new passwords and mismatched confirmation before registration", async () => {
    const { user } = renderAccount();
    await enterRegistration(user);
    const password = screen.getByLabelText("设置密码"), confirm = screen.getByLabelText("确认密码");
    expect(password).toHaveAttribute("maxlength", "16");
    for (const invalid of ["123456", "abcdef", "ab123", "abc12!", "a1234567890123456"]) {
      fireEvent.change(password, { target: { value: invalid } });
      fireEvent.change(confirm, { target: { value: invalid } });
      await user.click(screen.getByRole("button", { name: "注册" }));
      expect(password).toHaveAccessibleErrorMessage("6–16 位，包含字母和数字。");
      await waitFor(() => expect(password).toHaveFocus());
      expect(mocks.registerEvimedAccount).not.toHaveBeenCalled();
    }
    fireEvent.change(password, { target: { value: "abc123" } });
    fireEvent.change(confirm, { target: { value: "other123" } });
    expect(password).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(confirm).toHaveAccessibleErrorMessage("两次输入的密码不一致。");
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(mocks.registerEvimedAccount).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "修改手机信息" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("设置密码")).toHaveValue("");
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
  });

  it.each(["abc123", "a123456789012345"])("registers a valid %s password and returns to login without signing in", async (password) => {
    const { user, signedIn } = renderAccount();
    await enterRegistration(user, password);
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(mocks.registerEvimedAccount).toHaveBeenCalledWith(PHONE, CODE, password);
    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveTextContent("注册成功，请使用新账号登录");
    expectActionFeedback(feedback, screen.getByRole("button", { name: "登录" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("使用已有 EviMed 账号继续")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "账号密码" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("账号或手机号")).toHaveValue(PHONE);
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: /阅读并接受/ })).not.toBeChecked();
    expect(signedIn).not.toHaveBeenCalled();
    expect(mocks.loginEvimedPassword).not.toHaveBeenCalled();
    expect(mocks.loginEvimedSms).not.toHaveBeenCalled();
  });

  it("preserves registration values after rejection and retries without an automatic login", async () => {
    mocks.registerEvimedAccount.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_rejected"));
    const { user, signedIn } = renderAccount();
    await enterRegistration(user);
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("注册未完成，请检查手机号和验证码");
    expect(screen.getByLabelText("设置密码")).toHaveValue("abc123");
    expect(screen.getByLabelText("确认密码")).toHaveValue("abc123");
    await user.click(screen.getByRole("button", { name: "注册" }));
    expect(await screen.findByRole("status")).toHaveTextContent("注册成功");
    expect(mocks.registerEvimedAccount).toHaveBeenCalledTimes(2);
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("resets only with the verified phone/code snapshot and returns to password login", async () => {
    const verification = deferred<void>();
    mocks.verifyEvimedCode.mockReturnValue(verification.promise);
    const { user, signedIn } = renderAccount();
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fillPhone(user);
    const phone = screen.getByLabelText("手机号"), code = screen.getByLabelText("短信验证码");
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    expect(mocks.verifyEvimedCode).toHaveBeenCalledWith(PHONE, CODE);
    // A late input event must never replace the proof already sent for verification.
    fireEvent.change(phone, { target: { value: OTHER_PHONE } });
    fireEvent.change(code, { target: { value: "654321" } });
    await act(async () => { verification.resolve(undefined); await verification.promise; });
    expect(screen.getByText("已验证 138****8000")).toBeInTheDocument();
    expect(screen.queryByLabelText("手机号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("短信验证码")).not.toBeInTheDocument();
    expect(screen.getByLabelText("设置密码")).toHaveValue("");
    await user.type(screen.getByLabelText("设置密码"), "new123");
    await user.type(screen.getByLabelText("确认密码"), "new123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));
    expect(mocks.resetEvimedPassword).toHaveBeenCalledWith(PHONE, CODE, "new123");
    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveTextContent("密码已重置，请使用新密码登录");
    expectActionFeedback(feedback, screen.getByRole("button", { name: "登录" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("使用已有 EviMed 账号继续")).not.toBeInTheDocument();
    expect(screen.getByLabelText("账号或手机号")).toHaveValue(PHONE);
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("stays on phone verification after a rejection and can retry the same proof", async () => {
    mocks.verifyEvimedCode.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_rejected"));
    const { user } = renderAccount();
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("验证未通过，请检查信息后重试");
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toHaveValue(PHONE);
    expect(mocks.resetEvimedPassword).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    expect(await screen.findByLabelText("设置密码")).toBeInTheDocument();
    expect(mocks.verifyEvimedCode).toHaveBeenCalledTimes(2);
  });

  it("keeps the verified proof and new password when reset fails, then permits a retry", async () => {
    mocks.resetEvimedPassword.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_unreachable", 503));
    const { user } = renderAccount();
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    await user.type(await screen.findByLabelText("设置密码"), "new123");
    await user.type(screen.getByLabelText("确认密码"), "new123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号服务暂时不可用，请稍后重试");
    expect(screen.getByText("已验证 138****8000")).toBeInTheDocument();
    expect(screen.getByLabelText("设置密码")).toHaveValue("new123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByRole("status")).toHaveTextContent("密码已重置");
    expect(mocks.verifyEvimedCode).toHaveBeenCalledTimes(1);
    expect(mocks.resetEvimedPassword).toHaveBeenCalledTimes(2);
  });

  it("clears a failed reset and conceals the next password after returning to phone verification", async () => {
    mocks.resetEvimedPassword.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_unreachable", 503));
    const { user, signedIn } = renderAccount();
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    await user.type(await screen.findByLabelText("设置密码"), "new123");
    await user.type(screen.getByLabelText("确认密码"), "new123");
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("设置密码")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("账号服务暂时不可用");

    await user.click(screen.getByRole("button", { name: "重新验证" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("设置密码")).not.toBeInTheDocument();
    await fillPhone(user, OTHER_PHONE, "654321");
    await user.click(screen.getByRole("button", { name: "验证手机号" }));
    const password = await screen.findByLabelText("设置密码");
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
    expect(screen.getByLabelText("确认密码")).toHaveAttribute("type", "password");
    expect(screen.getByText("已验证 139****9000")).toBeInTheDocument();
    expect(mocks.verifyEvimedCode).toHaveBeenLastCalledWith(OTHER_PHONE, "654321");
    expect(mocks.resetEvimedPassword).toHaveBeenCalledTimes(1);
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("fetches and refreshes a captcha for one captured phone and sends its xcode to that phone", async () => {
    const { user, signedIn } = renderAccount();
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    const dialog = await screen.findByRole("dialog", { name: "安全验证" });
    expect(mocks.fetchEvimedCaptcha).toHaveBeenCalledWith(PHONE);
    expect(within(dialog).getByText(/138\*\*\*\*8000/)).toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "刷新验证图片" }));
    expect(mocks.fetchEvimedCaptcha).toHaveBeenCalledTimes(2);
    expect(mocks.fetchEvimedCaptcha).toHaveBeenLastCalledWith(PHONE);
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: OTHER_PHONE } });
    await user.click(within(dialog).getByRole("button", { name: "完成安全验证" }));
    expect(mocks.sendEvimedCode).toHaveBeenCalledWith("login", PHONE, "25");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("短信验证码")).toHaveFocus();
    const feedback = screen.getByRole("status");
    expect(feedback).toHaveTextContent("验证码已发送，请查看短信");
    expectActionFeedback(feedback, screen.getByRole("button", { name: "登录 / 注册" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("未注册手机号将自动注册")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "获取验证码" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: PHONE } });
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("keeps separate cooldowns for each phone and each SMS purpose", async () => {
    const { user } = renderAccount();
    await fillPhone(user); await completeCaptcha(user);
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    await user.clear(screen.getByLabelText("手机号")); await user.type(screen.getByLabelText("手机号"), OTHER_PHONE);
    expect(screen.getByRole("button", { name: "获取验证码" })).toBeEnabled();
    await user.clear(screen.getByLabelText("手机号")); await user.type(screen.getByLabelText("手机号"), PHONE);
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "返回登录" }));
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "返回登录" }));
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    expect(mocks.sendEvimedCode.mock.calls).toEqual([["login", PHONE, "25"], ["register", PHONE], ["reset", PHONE]]);
    expect(mocks.fetchEvimedCaptcha).toHaveBeenCalledTimes(1);
  });

  it("retries failed captcha and SMS requests without starting a false cooldown", async () => {
    mocks.fetchEvimedCaptcha.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_unreachable", 503));
    mocks.sendEvimedCode.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_failed", 503));
    const { user } = renderAccount();
    await fillPhone(user);
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    const dialog = await screen.findByRole("dialog", { name: "安全验证" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("账号服务暂时不可用");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).queryByText(/验证通过后，短信将发送至/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.sendEvimedCode).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "重新加载" }));
    const finish = await within(dialog).findByRole("button", { name: "完成安全验证" });
    await user.click(finish);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("账号服务暂时不可用");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).queryByText(/验证通过后，短信将发送至/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /秒后重发/ })).not.toBeInTheDocument();
    await user.click(finish);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    expect(mocks.sendEvimedCode).toHaveBeenCalledTimes(2);
  });

  it("keeps captcha failure in the top dialog after clearing an earlier login failure", async () => {
    mocks.loginEvimedSms.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_credential_rejected", 401));
    mocks.fetchEvimedCaptcha.mockRejectedValueOnce(new mocks.FakeWebApiError("evimed_account_unreachable", 503));
    const { user } = renderAccount();
    await fillPhone(user); await agree(user);
    const form = screen.getByRole("form", { name: "验证码登录" });
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("验证码不正确或已过期");
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    const dialog = await screen.findByRole("dialog", { name: "安全验证" });
    const feedback = await within(dialog).findByRole("alert");
    expect(feedback).toHaveTextContent("账号服务暂时不可用");
    expect(screen.getAllByRole("alert")).toEqual([feedback]);
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/验证通过后，短信将发送至/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toHaveValue(PHONE);
    expect(screen.getByLabelText("短信验证码")).toHaveValue(CODE);
  });

  it("blocks tab, mode and duplicate submit while working, without offering a local-account switch", async () => {
    const response = deferred<void>();
    mocks.loginEvimedSms.mockReturnValue(response.promise);
    function LocationProbe() { return <div data-testid="location">{useLocation().pathname}</div>; }
    render(<MemoryRouter initialEntries={["/login"]}><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/app/*" element={<LocationProbe />} />
    </Routes></MemoryRouter>);
    const user = userEvent.setup();
    await screen.findByLabelText("手机号");
    await fillPhone(user); await agree(user);
    await user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    expect(screen.queryByRole("button", { name: "使用本机账号登录" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "账号密码" }));
    await user.click(screen.getByRole("button", { name: "没有账号？注册" }));
    fireEvent.submit(screen.getByRole("form", { name: "验证码登录" }));
    expect(screen.getByRole("tab", { name: "验证码登录" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "登录 EviMed" })).toBeInTheDocument();
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
    expect(mocks.loginEvimedSms).toHaveBeenCalledTimes(1);
    await act(async () => { response.resolve(undefined); await response.promise; });
    expect(screen.getByTestId("location")).toHaveTextContent("/app/home");
  });

  it("does not navigate or revive a captcha when pending responses arrive after unmount", async () => {
    const login = deferred<void>();
    mocks.loginEvimedSms.mockReturnValue(login.promise);
    const first = renderAccount();
    await fillPhone(first.user); await agree(first.user);
    await first.user.click(screen.getByRole("button", { name: "登录 / 注册" }));
    first.unmount();
    await act(async () => { login.resolve(undefined); await login.promise; });
    expect(first.signedIn).not.toHaveBeenCalled();

    const captcha = deferred<typeof CAPTCHA>();
    mocks.fetchEvimedCaptcha.mockReturnValue(captcha.promise);
    const second = renderAccount();
    await fillPhone(second.user);
    await second.user.click(screen.getByRole("button", { name: "获取验证码" }));
    expect(screen.getByRole("dialog", { name: "安全验证" })).toBeInTheDocument();
    second.unmount();
    await act(async () => { captcha.resolve(CAPTCHA); await captcha.promise; });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(second.signedIn).not.toHaveBeenCalled();
    expect(mocks.sendEvimedCode).not.toHaveBeenCalled();
  });
});
