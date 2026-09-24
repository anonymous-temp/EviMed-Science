import { useEffect, useRef, useState } from "react";
import { changeWebPassword, fetchWebAuthMethods, webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PanelRow } from "@/components/ui/Panel";

/** The floor registration sets (`store.createUser`); said before the request. */
const PASSWORD_MIN = 8;

/**
 * 「密码」 on the account panel: 修改 opens the form under the row, in place
 * (2026-09-23 plan §5.9).
 *
 * Offered only where a password is the credential: under OIDC the identity
 * provider owns it, and under development auth there is none. The row asks
 * the deployment (`/api/auth/methods`) rather than assuming, so a deployment
 * that switches to OIDC does not keep offering a form the server refuses.
 */
export function PasswordRow() {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // 「修改」 gives way to the form it opens, so the first field takes the focus.
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);

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
  const close = () => { setOpen(false); setCurrent(""); setNext(""); setAgain(""); setProblem(null); };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await changeWebPassword(current, next);
      close();
      toast.success("密码已更新");
    } catch (error) {
      setProblem(webErrorMessage(error, { fallback: "密码没有改成，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelRow label="密码" control={open ? undefined : <Button variant="secondary" onClick={() => setOpen(true)}>修改</Button>}>
      {open && (
        <form className="grid max-w-sm gap-3" onSubmit={submit} aria-label="修改密码">
          <Input ref={first} label="当前密码" type="password" autoComplete="current-password" value={current} maxLength={4096}
            disabled={busy} onChange={(event) => setCurrent(event.target.value)} />
          <Input label="新密码" type="password" autoComplete="new-password" value={next} maxLength={4096}
            placeholder={`至少 ${PASSWORD_MIN} 位`} disabled={busy} onChange={(event) => setNext(event.target.value)}
            error={short ? `至少 ${PASSWORD_MIN} 位` : undefined} />
          <Input label="再输一次新密码" type="password" autoComplete="new-password" value={again} maxLength={4096}
            disabled={busy} onChange={(event) => setAgain(event.target.value)}
            error={mismatch ? "两次输入不一致" : undefined} />
          {problem && <p role="alert" className="text-ui text-error">{problem}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!ready} loading={busy}>保存</Button>
            <Button variant="text" onClick={close} disabled={busy}>取消</Button>
          </div>
        </form>
      )}
    </PanelRow>
  );
}
