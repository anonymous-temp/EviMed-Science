import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  fetchEvimedCaptcha, loginEvimedPassword, loginEvimedSms, registerEvimedAccount,
  resetEvimedPassword, sendEvimedCode, verifyEvimedCode, WebApiError, webErrorMessage,
  type EvimedCaptcha,
} from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { FormDialog } from "@/components/ui/FormDialog";
import { SliderCaptcha } from "./SliderCaptcha";
import { AuthFeedback, AuthFieldError } from "./AuthFeedback";

type Mode = "login" | "register" | "reset";
type Field = "phone" | "code" | "username" | "password" | "confirm" | "agreed";
type Values = Record<Exclude<Field, "agreed">, string> & { agreed: boolean };
const PHONE = /^1[3-9]\d{9}$/;
const CODE = /^\d{4,6}$/;
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,16}$/;
const PASSWORD_HINT = "6–16 位，包含字母和数字";
const LOGIN_TABS = [{ value: "sms", label: "验证码登录" }, { value: "password", label: "账号密码" }] as const;

/** The team's account flow; only the hosted session crosses back into the app. */
export function EvimedAccountForm({ onSignedIn }: {
  onSignedIn: () => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [entryDirection, setEntryDirection] = useState(1);
  const [tab, setTab] = useState<"sms" | "password">("sms");
  const [values, setValues] = useState<Values>({ phone: "", code: "", username: "", password: "", confirm: "", agreed: false });
  const [proof, setProof] = useState<{ phone: string; code: string } | null>(null);
  const [registration, setRegistration] = useState<{ phone: string; code: string } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deadlines, setDeadlines] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const [captcha, setCaptcha] = useState<{ phone: string; data: EvimedCaptcha | null } | null>(null);
  const [captchaError, setCaptchaError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const focusSentCode = useRef(false);
  const registrationFocus = useRef<"phone" | "password" | null>(null);
  const newPassword = (mode === "register" && registration !== null) || (mode === "reset" && proof !== null);
  const view = mode === "login" ? tab : `${mode}-${newPassword ? "password" : "phone"}`;
  const cooldownKey = `${mode}:${values.phone}`;
  const secondsLeft = Math.max(0, Math.ceil(((deadlines[cooldownKey] ?? 0) - now) / 1000));

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    if (mode !== "register" || !registrationFocus.current) return;
    form.current?.querySelector<HTMLInputElement>(`[name="${registrationFocus.current}"]`)?.focus({ preventScroll: true });
    registrationFocus.current = null;
  }, [mode, registration]);
  useEffect(() => {
    if (focusSentCode.current && !busy && captcha === null) {
      focusSentCode.current = false;
      form.current?.querySelector<HTMLInputElement>('[name="code"]')?.focus();
    }
  }, [busy, captcha]);
  useEffect(() => {
    if (!Object.values(deadlines).some(deadline => deadline > Date.now())) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadlines]);

  const problems: Partial<Record<Field, string>> = {};
  if (!(mode === "login" && tab === "password") && !proof && !registration) {
    if (!PHONE.test(values.phone)) problems.phone = "请输入正确的 11 位手机号。";
    if (!CODE.test(values.code)) problems.code = "请输入 4–6 位短信验证码。";
  }
  if (mode === "login" && tab === "password") {
    if (!values.username.trim()) problems.username = "请输入账号或手机号。";
    if (!values.password) problems.password = "请输入密码。";
  }
  if (newPassword) {
    if (!PASSWORD.test(values.password)) problems.password = PASSWORD_HINT + "。";
    if (!values.confirm || values.confirm !== values.password) problems.confirm = "两次输入的密码不一致。";
  }
  if ((mode === "login" || (mode === "register" && registration !== null)) && !values.agreed) problems.agreed = "请先阅读并接受用户协议和隐私政策。";
  const fieldError = (field: Field) => submitted ? problems[field] : undefined;
  const fieldIssue = (field: Field) => {
    const message = fieldError(field);
    return message ? <AuthFieldError>{message}</AuthFieldError> : undefined;
  };

  const change = <K extends keyof Values>(field: K, value: Values[K]) => {
    setValues(previous => ({ ...previous, [field]: value }));
    setError("");
    setNotice("");
  };
  const switchMode = (next: Mode, nextTab = tab) => {
    if (pending.current || captcha) return;
    generation.current += 1;
    setEntryDirection(nextTab === "password" ? 1 : -1);
    registrationFocus.current = null;
    setMode(next); setTab(nextTab); setProof(null); setRegistration(null); setSubmitted(false); setRevealed(false);
    setValues(previous => ({ ...previous, code: "", password: "", confirm: "", agreed: false }));
    setError(""); setNotice("");
  };
  const run = async (action: () => Promise<void>, success: () => void) => {
    if (pending.current) return;
    const id = generation.current;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await action();
      if (active.current && id === generation.current) success();
    } catch (err) {
      if (active.current && id === generation.current) setError(accountError(err, mode, tab));
    } finally {
      pending.current = false;
      if (active.current && id === generation.current) setBusy(false);
    }
  };
  const returnToLogin = (phone: string, message: string) => {
    registrationFocus.current = null;
    setMode("login"); setTab("password"); setProof(null); setRegistration(null); setSubmitted(false); setRevealed(false);
    setValues({ phone, username: phone, code: "", password: "", confirm: "", agreed: false });
    setNotice(message);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || captcha) return;
    setSubmitted(true); setError(""); setNotice("");
    if (Object.keys(problems).length) {
      queueMicrotask(() => {
        const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
        invalid?.focus({ preventScroll: true });
        const messageId = invalid?.getAttribute("aria-errormessage") ?? invalid?.getAttribute("aria-describedby");
        const message = messageId ? document.getElementById(messageId) : null;
        (message?.parentElement ?? invalid)?.scrollIntoView?.({ block: "nearest" });
      });
      return;
    }
    const snapshot = { ...values };
    if (mode === "login") {
      void run(() => tab === "sms" ? loginEvimedSms(snapshot.phone, snapshot.code)
        : loginEvimedPassword(snapshot.username.trim(), snapshot.password), onSignedIn);
    } else if (mode === "register") {
      if (!registration) {
        registrationFocus.current = "password";
        setEntryDirection(1);
        setRegistration({ phone: snapshot.phone, code: snapshot.code });
        setValues(previous => ({ ...previous, password: "", confirm: "", agreed: false }));
        setSubmitted(false); setRevealed(false);
        return;
      }
      const identity = { ...registration };
      void run(() => registerEvimedAccount(identity.phone, identity.code, snapshot.password),
        () => returnToLogin(identity.phone, "注册成功，请使用新账号登录。"));
    } else if (!proof) {
      void run(() => verifyEvimedCode(snapshot.phone, snapshot.code), () => {
        setProof({ phone: snapshot.phone, code: snapshot.code }); setSubmitted(false);
        setValues(previous => ({ ...previous, password: "", confirm: "" }));
      });
    } else {
      const verified = { ...proof };
      void run(() => resetEvimedPassword(verified.phone, verified.code, snapshot.password),
        () => returnToLogin(verified.phone, "密码已重置，请使用新密码登录。"));
    }
  };
  const editRegistration = () => {
    if (pending.current || captcha || !registration) return;
    generation.current += 1;
    registrationFocus.current = "phone";
    setEntryDirection(-1);
    setValues(previous => ({ ...previous, ...registration, password: "", confirm: "", agreed: false }));
    setRegistration(null); setSubmitted(false); setRevealed(false);
    setError(""); setNotice("");
  };
  const repeatVerification = () => {
    if (pending.current || captcha || !proof) return;
    generation.current += 1;
    setEntryDirection(-1);
    setProof(null); setSubmitted(false); setRevealed(false);
    setValues(previous => ({ ...previous, password: "", confirm: "" }));
    setError(""); setNotice("");
  };
  const startCountdown = (key: string) => {
    const time = Date.now(); setNow(time);
    setDeadlines(previous => ({ ...previous, [key]: time + 60_000 }));
    setNotice("验证码已发送，请查看短信。");
  };
  const loadCaptcha = async (phone: string) => {
    if (pending.current) return;
    const id = ++generation.current;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setCaptcha({ phone, data: null }); setCaptchaError("");
    try {
      const data = await fetchEvimedCaptcha(phone);
      if (active.current && id === generation.current) setCaptcha({ phone, data });
    } catch (err) {
      if (active.current && id === generation.current) setCaptchaError(accountError(err, mode, tab));
    } finally {
      pending.current = false;
      if (active.current && id === generation.current) setBusy(false);
    }
  };
  const sendCode = () => {
    if (pending.current || captcha || secondsLeft > 0 || !PHONE.test(values.phone)) return;
    const phone = values.phone;
    if (mode === "login") { void loadCaptcha(phone); return; }
    const key = cooldownKey;
    void run(() => sendEvimedCode(mode, phone), () => startCountdown(key));
  };
  const finishCaptcha = async (xcode: string) => {
    if (pending.current || !captcha?.data) return;
    const { phone } = captcha, id = generation.current;
    pending.current = true; setBusy(true); setCaptchaError("");
    try {
      await sendEvimedCode("login", phone, xcode);
      if (active.current && id === generation.current) {
        focusSentCode.current = true;
        setCaptcha(null); startCountdown(`login:${phone}`);
      }
    } catch (err) {
      if (active.current && id === generation.current) setCaptchaError(accountError(err, mode, tab));
    } finally {
      pending.current = false;
      if (active.current && id === generation.current) setBusy(false);
    }
  };

  return <>
    <div className="auth-account-layout" data-mode={mode} data-stage={mode === "login" ? undefined : newPassword ? "2" : "1"}>
    <h1 id="login-title" className="auth-title text-center text-heading font-semibold">
      {mode === "login" ? "登录 EviMed" : mode === "register" ? "注册账号" : "找回密码"}
    </h1>
    {mode === "login" && <Tabs animatedIndicator label="登录方式" items={LOGIN_TABS} value={tab}
      onChange={value => switchMode("login", value)} panelId="evimed-account-panel" className="auth-account-tabs" />}
    <form className="auth-account-form" data-view={view} ref={form} noValidate onSubmit={submit} aria-label={mode === "login" ? "EviMed 登录" : mode === "register" ? "注册账号" : "找回密码"}
      id="evimed-account-panel" aria-labelledby={mode === "login" ? `evimed-account-panel-tab-${tab}` : "login-title"}
      aria-describedby={error || notice ? "evimed-account-feedback" : undefined} inert={captcha !== null}>
      <fieldset disabled={busy} className="auth-account-fieldset">
        <div key={view} className="auth-form-fields">
        <div className="auth-fields-enter auth-field-stack"
          style={{ "--auth-enter-offset": `calc(${entryDirection} * var(--motion-menu))` } as CSSProperties}>
        {mode === "register" && registration ? <div className="auth-stage-summary flex flex-wrap items-center justify-between gap-2 text-ui text-text-2">
          <span>手机号 {registration.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")}</span>
          <Button variant="text" size="sm" onClick={editRegistration}>修改手机信息</Button>
        </div> : mode === "reset" && proof ? <div className="flex flex-wrap items-center justify-between gap-2 text-ui text-text-2">
          <span>已验证 {proof.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")}</span>
          <Button variant="text" size="sm" onClick={repeatVerification}>重新验证</Button>
        </div> : mode === "login" && tab === "password" ? <Input id="evimed-username" name="username" label="账号或手机号"
          autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} value={values.username}
          error={fieldIssue("username")} onChange={event => change("username", event.target.value)} /> : <>
          <Input id="evimed-phone" name="phone" label="手机号" type="tel" inputMode="numeric" maxLength={11} autoComplete="tel-national"
            value={values.phone} error={fieldIssue("phone")} onChange={event => change("phone", event.target.value.trim())} />
          <div className="relative">
            <Input id="evimed-code" name="code" label="短信验证码" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
              value={values.code} error={fieldIssue("code")} className="pr-32" onChange={event => change("code", event.target.value.trim())} />
            <Button variant="text" size="sm" className="auth-code-action absolute right-1 top-8" disabled={secondsLeft > 0 || !PHONE.test(values.phone)} onClick={sendCode}>
              {secondsLeft > 0 ? `${secondsLeft} 秒后重发` : "获取验证码"}
            </Button>
          </div>
        </>}
        {(newPassword || (mode === "login" && tab === "password")) && <Input id="evimed-password" name="password" label={newPassword ? "设置密码" : "密码"}
          type={revealed ? "text" : "password"} autoComplete={newPassword ? "new-password" : "current-password"}
          value={values.password} maxLength={newPassword ? 16 : 256} error={fieldIssue("password")} hint={newPassword ? PASSWORD_HINT : undefined}
          onChange={event => change("password", event.target.value)} trailing={<IconButton icon={revealed ? EyeOff : Eye} size="sm"
            label="显示密码" aria-pressed={revealed} onClick={() => setRevealed(previous => !previous)} />} />}
        {newPassword && <Input id="evimed-confirm" name="confirm" label="确认密码" type={revealed ? "text" : "password"} autoComplete="new-password"
          value={values.confirm} maxLength={16} error={fieldIssue("confirm")} onChange={event => change("confirm", event.target.value)} />}
        {(mode === "login" || (mode === "register" && registration !== null)) && <div>
          <label className="flex items-start gap-2 text-caption text-text-2">
            <input name="agreed" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-accent" checked={values.agreed}
              aria-invalid={!!fieldError("agreed") || undefined} aria-describedby={fieldError("agreed") ? "evimed-agreed-error" : undefined}
              onChange={event => change("agreed", event.target.checked)} />
            <span>阅读并接受 <a href="/static/agreement.html" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">用户协议</a>
              {" 与 "}<a href="/static/privacyPolicy.html" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">隐私政策</a></span>
          </label>
          {fieldError("agreed") && <p id="evimed-agreed-error" role="alert" className="mt-2 text-ui text-error">{fieldIssue("agreed")}</p>}
        </div>}
        </div>
        </div>
        <div className="auth-form-actions">
        <div className="auth-feedback-slot">
          {error ? <AuthFeedback id="evimed-account-feedback">{error}</AuthFeedback>
            : notice ? <AuthFeedback id="evimed-account-feedback" tone="success">{notice}</AuthFeedback>
              : mode === "login" && <p className="text-caption text-text-3">{tab === "sms" ? "未注册手机号将自动注册" : "使用已有 EviMed 账号继续"}</p>}
        </div>
        <Button type="submit" size="lg" loading={busy} className="w-full" aria-describedby={error || notice ? "evimed-account-feedback" : undefined}>
          {mode === "login" ? tab === "sms" ? "登录 / 注册" : "登录" : mode === "register" ? registration ? "注册" : "下一步" : proof ? "重置密码" : "验证手机号"}
        </Button>
        <div className="auth-alternate-actions">
          {mode === "login" ? <>
            <Button variant="text" size="sm" onClick={() => switchMode("reset")}>忘记密码</Button>
            <Button variant="text" size="sm" onClick={() => switchMode("register")}>没有账号？注册</Button>
          </> : <Button variant="text" size="sm" className="mx-auto" onClick={() => switchMode("login")}>返回登录</Button>}
        </div>
        </div>
      </fieldset>
    </form>
    </div>
    {captcha && <FormDialog title="安全验证" className="auth-captcha-dialog" busy={busy} onClose={() => { if (!pending.current) { generation.current += 1; setCaptcha(null); } }}>
      {captcha.data ? <SliderCaptcha key={captcha.data.canvasSrc} data={captcha.data} busy={busy}
        onComplete={xcode => void finishCaptcha(xcode)} onRefresh={() => void loadCaptcha(captcha.phone)} />
        : busy && <p role="status" className="py-8 text-center text-ui text-text-2">正在加载验证图片</p>}
      {captchaError && <AuthFeedback className="mt-3">{captchaError}</AuthFeedback>}
      {!captcha.data && !busy && <Button variant="secondary" className="mt-3" onClick={() => void loadCaptcha(captcha.phone)}>重新加载</Button>}
      {!captchaError && <p className="mt-3 text-caption text-text-3">验证通过后，短信将发送至 {captcha.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")}</p>}
    </FormDialog>}
  </>;
}

function accountError(error: unknown, mode: Mode, tab: "sms" | "password"): string {
  if (error instanceof WebApiError) {
    if (error.code === "evimed_credential_rejected") return tab === "password" ? "账号或密码不正确，请重新输入。" : "验证码不正确或已过期，请重新获取。";
    if (error.code === "evimed_account_rejected") return mode === "register" ? "注册未完成，请检查手机号和验证码；已有账号可返回登录。" : "验证未通过，请检查信息后重试。";
    if (error.code === "evimed_account_invalid_input") return "输入信息不符合要求，请检查后重试。";
    if (error.code === "evimed_account_failed" || error.code === "evimed_account_unreachable") return "账号服务暂时不可用，请稍后重试。";
    if (error.code === "auth_method_disabled") return "此登录方式暂不可用，请刷新页面后重试。";
  }
  return webErrorMessage(error, { fallback: "操作未完成，请检查网络后重试。" });
}
