import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { changeWebPassword, fetchWebAuthMethods, webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { toast } from "@/lib/toast";

/** The floor registration sets (`store.createUser`); said before the request. */
const PASSWORD_MIN = 8;

/**
 * 「登录密码」: the one setting every account page people know has, and the
 * one this page lacked until 2026-09-22 (「该有的常规的设置项咋一个都没有」).
 *
 * Offered only where a password is the credential: under OIDC the identity
 * provider owns it, and under development auth there is none. The card asks
 * the deployment (`/api/auth/methods`) rather than assuming, so a deployment
 * that switches to OIDC does not keep offering a form the server refuses.
 */
export function PasswordCard() {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWebAuthMethods()
      .then((methods) => { if (active) setOffered(methods.mode === "local"); })
      .catch(() => { if (active) setOffered(false); });
    return () => { active = false; };
  }, []);

  if (!offered) return null;

  const mismatch = again.length > 0 && next !== again;
  const short = next.length > 0 && next.length < PASSWORD_MIN;
  const ready = current.length > 0 && next.length >= PASSWORD_MIN && next === again && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await changeWebPassword(current, next);
      setCurrent(""); setNext(""); setAgain("");
      toast.success("密码已更新。");
    } catch (error) {
      setProblem(webErrorMessage(error, { fallback: "密码没有改成，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-5" title="登录密码" hint={`至少 ${PASSWORD_MIN} 位。改完后这台设备保持登录，其他设备下次登录时用新密码。`}>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit} aria-label="修改登录密码">
        <Input label="当前密码" type="password" autoComplete="current-password" value={current} maxLength={4096}
          disabled={busy} onChange={(event) => setCurrent(event.target.value)} />
        <Input label="新密码" type="password" autoComplete="new-password" value={next} maxLength={4096}
          disabled={busy} onChange={(event) => setNext(event.target.value)}
          error={short ? `至少 ${PASSWORD_MIN} 位` : undefined} />
        <Input label="再输一次新密码" type="password" autoComplete="new-password" value={again} maxLength={4096}
          disabled={busy} onChange={(event) => setAgain(event.target.value)}
          error={mismatch ? "两次输入不一致" : undefined} />
        {problem && <p role="alert" className="text-ui text-error sm:col-span-3">{problem}</p>}
        <div className="sm:col-span-3">
          <Button type="submit" size="sm" disabled={!ready} loading={busy}>
            {!busy && <KeyRound size={16} aria-hidden="true" />}
            更新密码
          </Button>
        </div>
      </form>
    </Card>
  );
}
