import { useEffect, useRef, useState, type FormEvent } from "react";
import { MIN_PASSWORD_LENGTH } from "@evimed/domain";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { EviMedMark } from "@/components/brand/EviMedMark";
import {
  fetchWebAuthMethods,
  fetchWebMe,
  getWebOidcStartUrl,
  loginDevelopmentWeb,
  loginEvimedWeb,
  loginWeb,
  registerWeb,
  WebApiError,
  webErrorMessage,
  type WebAuthMethods,
} from "@/lib/apiClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { PageTitle } from "@/components/layout/PageTitle";
import { loginReturnTarget } from "@/lib/loginReturn";
import { EvimedAccountForm } from "@/components/auth/EvimedAccountForm";
import { LoginContext } from "@/components/auth/LoginContext";
import { LoginBackground } from "@/components/auth/LoginBackground";
import { AuthFeedback, AuthFieldError } from "@/components/auth/AuthFeedback";
import "@/components/auth/login.css";

const PASSWORD_RULE = "密码至少 " + MIN_PASSWORD_LENGTH + " 位。";
const AUTH_MODES = new Set(["local", "development", "oidc", "evimed"]);
const offersEvimedAccountForm = (methods: WebAuthMethods | null | undefined) => !!methods?.evimed?.account
  && (methods.mode === "evimed" || methods.mode === "local");

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = loginReturnTarget(params);
  const evimedReauthRequested = params.get("reauth") === "evimed";
  const [methods, setMethods] = useState<WebAuthMethods | null>(null);
  const [checking, setChecking] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setChecking(true);
    setLoadFailed(false);
    setMethods(null);
    // Only an explicit request with an available team account form may replace
    // an existing sign-in. It never signs the current account out beforehand.
    void Promise.allSettled([fetchWebMe(), fetchWebAuthMethods()])
      .then(([me, available]) => {
        if (!active) return;
        const reauthAvailable = evimedReauthRequested && available.status === "fulfilled"
          && offersEvimedAccountForm(available.value);
        if (me.status === "fulfilled" && me.value && !reauthAvailable) {
          navigate(returnTo, { replace: true });
          return;
        }
        if (me.status === "rejected" || available.status === "rejected"
          || !available.value || !AUTH_MODES.has(available.value.mode)) {
          setLoadFailed(true);
          return;
        }
        setMethods(available.value);
      })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [navigate, returnTo, attempt, evimedReauthRequested]);

  const completeSignIn = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await action();
      if (mounted.current) navigate(returnTo, { replace: true });
    } catch (err) {
      if (!mounted.current) return;
      if (registering && err instanceof WebApiError && err.code === "weak_password") {
        setPasswordError(registrationMessage(err));
        passwordInput.current?.focus();
      } else {
        setError(registering ? registrationMessage(err) : signInMessage(err, methods?.mode === "evimed"));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || methods?.mode !== "local") return;
    setSubmitted(true);
    setError(null);
    const accountProblem = username.trim() ? null : "请输入账号。";
    const passwordProblem = !password ? "请输入密码。"
      : registering && [...password].length < MIN_PASSWORD_LENGTH ? PASSWORD_RULE : null;
    setUsernameError(accountProblem);
    setPasswordError(passwordProblem);
    if (accountProblem || passwordProblem) {
      (accountProblem ? usernameInput : passwordInput).current?.focus();
      return;
    }
    void completeSignIn(() => registering
      ? registerWeb(username.trim(), password)
      : loginWeb(username.trim(), password));
  };

  const switchMode = () => {
    if (pending.current) return;
    setRegistering((value) => !value);
    setPassword("");
    setRevealed(false);
    setSubmitted(false);
    setUsernameError(null);
    setPasswordError(null);
    setError(null);
    usernameInput.current?.focus();
  };

  const showAccountForm = offersEvimedAccountForm(methods);
  useEffect(() => {
    if (!checking && methods?.mode === "local" && !showAccountForm) usernameInput.current?.focus();
  }, [checking, methods?.mode, showAccountForm]);

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center bg-bg px-6 text-text">
        <PageTitle page="登录" />
        <div role="status" className="flex items-center gap-2 text-ui text-text-2">
          <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          正在检查登录状态
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <LoginBackground />
      <PageTitle page={!showAccountForm && registering ? "注册" : "登录"} />
      <section aria-labelledby="login-title" className="auth-layout">
        <aside className="auth-intro">
        <div className="auth-brand">
          <span aria-hidden="true"><EviMedMark className="h-7 w-7" /></span>
          <span className="text-wordmark font-semibold">EviMed Science</span>
        </div>
        <LoginContext />
        </aside>
        <div className="auth-login-panel">
        <div className={showAccountForm ? "auth-panel-content" : "auth-panel-content auth-simple-login"}>
        {!showAccountForm && <h1 id="login-title" className="auth-title text-center text-heading font-semibold">{registering ? "注册" : "登录"}</h1>}

        {loadFailed || !methods ? (
          <div className="space-y-4">
            <AuthFeedback>登录服务暂时不可用，请稍后重试。</AuthFeedback>
            <Button variant="secondary" size="lg" className="w-full" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
          </div>
        ) : showAccountForm ? (
          <EvimedAccountForm onSignedIn={() => navigate(returnTo, { replace: true })} />
        ) : methods.mode === "oidc" ? (
          <a href={getWebOidcStartUrl(returnTo)} className={buttonClasses({ size: "lg", className: "w-full" })}>
            {methods.oidc?.label ?? "统一身份登录"}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        ) : methods.mode === "evimed" ? (
          <div className="space-y-3">
          {error && <AuthFeedback>{error}</AuthFeedback>}
          <Button size="lg" loading={submitting} className="w-full" onClick={() => void completeSignIn(loginEvimedWeb)}>
            使用 EviMed 账号继续
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          </div>
        ) : methods.mode === "development" ? (
          <div className="space-y-3">
          {error && <AuthFeedback>{error}</AuthFeedback>}
          <Button size="lg" loading={submitting} className="w-full" onClick={() => void completeSignIn(loginDevelopmentWeb)}>进入工作台</Button>
          </div>
        ) : (
          <form noValidate onSubmit={submit} aria-label={registering ? "注册" : "登录"}>
            <fieldset disabled={submitting} className="auth-field-stack">
              <Input
                ref={usernameInput}
                id="login-username"
                label="账号"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                error={usernameError ? <AuthFieldError>{usernameError}</AuthFieldError> : undefined}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                  if (submitted) setUsernameError(event.target.value.trim() ? null : "请输入账号。");
                }}
              />
              <Input
                ref={passwordInput}
                id="login-password"
                label="密码"
                hint={registering ? "至少 " + MIN_PASSWORD_LENGTH + " 位" : undefined}
                type={revealed ? "text" : "password"}
                autoComplete={registering ? "new-password" : "current-password"}
                value={password}
                error={passwordError ? <AuthFieldError>{passwordError}</AuthFieldError> : undefined}
                onChange={(event) => {
                  const value = event.target.value;
                  setPassword(value);
                  setError(null);
                  if (submitted) setPasswordError(!value ? "请输入密码。"
                    : registering && [...value].length < MIN_PASSWORD_LENGTH ? PASSWORD_RULE : null);
                }}
                trailing={(
                  <IconButton icon={revealed ? EyeOff : Eye} label="显示密码" size="sm" aria-pressed={revealed}
                    onClick={() => setRevealed((value) => !value)} />
                )}
              />
              {error && <AuthFeedback>{error}</AuthFeedback>}
              <Button type="submit" size="lg" loading={submitting} className="w-full">
                {registering ? "注册并进入" : "登录"}
              </Button>
              {methods.selfRegistration && (
                <Button variant="text" className="w-full" onClick={switchMode}>
                  {registering ? "已有账号？返回登录" : "还没有账号？注册一个"}
                </Button>
              )}
            </fieldset>
          </form>
        )}

        </div>
        </div>
      </section>
    </main>
  );
}

function signInMessage(error: unknown, evimed = false): string {
  if (error instanceof WebApiError && error.status === 401) {
    return evimed ? "EviMed 登录状态已失效，请先在 EviMed 登录后重试。" : "账号或密码不正确，请重新输入。";
  }
  return webErrorMessage(error, { fallback: "登录没有完成，请检查网络后重试。" });
}

function registrationMessage(error: unknown): string {
  const code = error instanceof WebApiError ? error.code : "";
  if (code === "user_exists") return "这个账号已经有人用了，换一个试试。";
  if (code === "weak_password") return PASSWORD_RULE;
  if (code === "invalid_username" || code === "invalid_field") return "账号只能用字母、数字、连字符和下划线。";
  if (code === "self_registration_disabled") return "这个部署暂不开放注册。";
  return webErrorMessage(error, { fallback: "无法注册，请稍后重试。" });
}
