import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { EviMedMark } from "@/components/brand/EviMedMark";
import {
  fetchWebAuthMethods,
  fetchWebMe,
  getWebOidcStartUrl,
  loginDevelopmentWeb,
  loginWeb,
  registerWeb,
  WebApiError,
  webErrorMessage,
  type WebAuthMethods,
} from "@/lib/apiClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PageTitle } from "@/components/layout/PageTitle";

export function LoginPage() {
  const navigate = useNavigate();
  const [methods, setMethods] = useState<WebAuthMethods | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchWebMe(), fetchWebAuthMethods()])
      .then(([me, available]) => {
        if (!active) return;
        if (me) {
          navigate("/app/chat", { replace: true });
          return;
        }
        setMethods(available);
      })
      .catch(() => {
        if (active) setError("登录服务暂时不可用，请稍后重试。");
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

/**
 * Why the sign-in did not go through.
 *
 * Every failure used to read 「账号或密码错误」 (2026-09-16 walk, U12), including
 * rate limiting, a 5xx and a dropped connection — so someone locked out by the
 * auth rate limiter retyped a correct password until the window expired. Only
 * a 401 is a wrong credential; everything else goes to the shared dictionary,
 * which knows about `Retry-After`.
 */
function signInMessage(error: unknown): string {
  if (error instanceof WebApiError && error.status === 401) return "账号或密码错误，请重新输入。";
  return webErrorMessage(error, { fallback: "登录没有完成，请检查网络后重试。" });
}

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入账号和密码。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (registering) await registerWeb(username.trim(), password);
      else if (methods?.mode === "development") await loginDevelopmentWeb();
      else await loginWeb(username.trim(), password);
      navigate("/app/chat", { replace: true });
    } catch (err) {
      setError(registering ? registrationMessage(err) : signInMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-bg text-muted">
        <Loader2 size={20} className="animate-spin" aria-label="正在检查登录状态" />
      </div>
    );
  }

  // The brand once, the two fields by their labels, and the one button — no
  // eyebrow, no sentence about the workspace, no card and no footer
  // (2026-09-23 plan §5.10, mockup m12). The heading names the form for a
  // screen reader; the page itself shows the brand, not a second 「EviMed」.
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 py-10 text-text">
      <PageTitle page={registering ? "注册" : "登录"} />
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span aria-hidden="true"><EviMedMark className="h-7 w-7" /></span>
          <span className="text-display font-semibold">EviMed</span>
        </div>
        <h1 className="sr-only">{registering ? "注册" : "登录"}</h1>

        {methods?.mode === "oidc" ? (
          <a href={getWebOidcStartUrl("/app/chat")} className={buttonClasses({ size: "lg", className: "w-full" })}>
            {methods.oidc?.label ?? "统一身份登录"}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <Input
              id="login-username"
              label="账号"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <Input
              id="login-password"
              label="密码"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" size="lg" loading={submitting} className="w-full">
              {registering ? "注册并进入" : "登录"}
            </Button>
            {methods?.selfRegistration && (
              <Button
                variant="text"
                className="w-full"
                onClick={() => {
                  setRegistering((value) => !value);
                  setError(null);
                }}
              >
                {registering ? "已有账号？返回登录" : "还没有账号？注册一个"}
              </Button>
            )}
          </form>
        )}

        {error && <p className="mt-4 text-center text-ui text-danger" role="alert">{error}</p>}
      </div>
    </main>
  );
}

/**
 * What went wrong, in the words of the person who typed it.
 *
 * Registration fails for reasons a reader can act on — the name is taken, the
 * password is too short, the deployment is closed — and each has its own code.
 * A single "registration failed" would make all three look like our fault.
 */
function registrationMessage(error: unknown): string {
  const code = error instanceof WebApiError ? error.code : "";
  if (code === "user_exists") return "这个账号已经有人用了，换一个试试。";
  if (code === "weak_password") return "密码至少 8 位。";
  if (code === "invalid_username" || code === "invalid_field") return "账号只能用字母、数字、连字符和下划线。";
  if (code === "self_registration_disabled") return "这个部署暂不开放注册。";
  if (code === "auth_rate_limited") return "尝试太频繁了，请稍后再试。";
  return "注册失败，请稍后重试。";
}
