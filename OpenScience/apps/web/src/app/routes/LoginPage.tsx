import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Loader2, LockKeyhole, UserRound } from "lucide-react";
import { useNavigate } from "react-router";
import evimedMark from "@/assets/evimed-mark.svg";
import { fetchWebAuthMethods, fetchWebMe, getWebOidcStartUrl, loginDevelopmentWeb, loginWeb, type WebAuthMethods } from "@/lib/apiClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function LoginPage() {
  const navigate = useNavigate();
  const [methods, setMethods] = useState<WebAuthMethods | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchWebMe(), fetchWebAuthMethods()])
      .then(([me, available]) => {
        if (!active) return;
        if (me) {
          navigate("/live", { replace: true });
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入账号和密码。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (methods?.mode === "development") await loginDevelopmentWeb();
      else await loginWeb(username.trim(), password);
      navigate("/live", { replace: true });
    } catch {
      setError("账号或密码错误，请重新输入。");
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

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 py-10 text-text">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <img src={evimedMark} alt="EviMed" className="h-9 w-9" />
          <span className="font-serif text-2xl font-semibold tracking-tight">EviMed</span>
        </div>

        <section className="rounded-card border border-border bg-surface px-7 py-8 shadow-card sm:px-9">
          <div className="text-center">
            <div className="text-xs font-medium tracking-[0.18em] text-accent">循证医学科研智能体</div>
            <h1 className="mt-3 font-serif text-2xl font-semibold">登录 EviMed</h1>
            <p className="mt-2 text-sm leading-6 text-muted">进入你的个人知识库与科研工作空间</p>
          </div>

          {methods?.mode === "oidc" ? (
            <a
              href={getWebOidcStartUrl("/live")}
              className={buttonClasses({ className: "mt-7 h-11 w-full gap-2 text-sm" })}
            >
              {methods.oidc?.label ?? "统一身份登录"}
              <ArrowRight size={15} />
            </a>
          ) : (
            <form className="mt-7 space-y-4" onSubmit={submit}>
              <div>
                <label htmlFor="login-username" className="mb-1.5 block text-sm font-medium">账号</label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={15} />
                  <Input
                    id="login-username"
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="请输入账号"
                    className="h-11 bg-bg pl-10 text-sm"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium">密码</label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={15} />
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="请输入密码"
                    className="h-11 bg-bg pl-10 text-sm"
                  />
                </div>
              </div>
              <Button type="submit" loading={submitting} className="h-11 w-full gap-2 text-sm">
                登录
              </Button>
            </form>
          )}

          {error && <div className="mt-4 text-center text-sm text-error" role="alert">{error}</div>}
        </section>
        <p className="mt-5 text-center text-xs text-muted">
          仅用于科研辅助，不替代临床诊疗或专业判断；关键结论需回溯原始证据
        </p>
      </div>
    </main>
  );
}
