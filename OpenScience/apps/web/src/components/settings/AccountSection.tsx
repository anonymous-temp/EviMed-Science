import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import { deleteWebAccount, exportWebAccount, fetchWebMe, logoutWeb, webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { FeishuAccountRow } from "./FeishuRows";
import { PasswordRow } from "./PasswordRow";

interface WebAccount {
  id: string;
  name: string;
}

/**
 * 「账户」 in 设置 (2026-09-23 plan §5.9, mockup m11): one group — 用户名,
 * 密码 (changed in place), 飞书 where the deployment runs the IM module, and
 * 退出登录 — and a second for the account's data: export, and 删除账户 as a
 * destructive text action that asks for the account's id before it acts.
 *
 * What went: the 「你的账号」 card and its sentence about how accounts are
 * isolated, the 「数据独立」 pill, the account id printed in mono under the
 * name (it appears once now, in the deletion confirmation, where it is what
 * the deletion acts on), a refresh button, and a card inside a card inside a
 * card around the confirmation.
 */
export function AccountSection({ imEnabled }: { imEnabled: boolean }) {
  const navigate = useNavigate();
  const [account, setAccount] = useState<WebAccount | null>(null);
  const [busy, setBusy] = useState<"export" | "logout" | "delete" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [password, setPassword] = useState("");
  // 「删除」 gives way to the confirmation it opens, so its first field takes the focus.
  const confirmField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (deleting) confirmField.current?.focus(); }, [deleting]);

  useEffect(() => {
    let active = true;
    fetchWebMe()
      .then((me) => { if (active) setAccount(me?.user ?? null); })
      .catch((error) => { if (active) toast.error(`无法读取账户：${webErrorMessage(error)}`); });
    return () => { active = false; };
  }, []);

  const leave = () => navigate("/login", { replace: true });

  const signOut = async () => {
    setBusy("logout");
    try {
      await logoutWeb();
      toast.success("已退出登录");
      leave();
    } catch (error) {
      toast.error(`无法退出登录：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const exportAccount = async () => {
    if (!account) return;
    setBusy("export");
    try {
      const blob = await exportWebAccount();
      downloadBlob(blob, `evimed-account-${account.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`);
      toast.success("已导出");
    } catch (error) {
      toast.error(`无法导出账户：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    if (!account || confirmId.trim() !== account.id) return;
    setBusy("delete");
    try {
      await deleteWebAccount(confirmId.trim(), password.trim() || undefined);
      toast.success("账户已删除");
      leave();
    } catch (error) {
      toast.error(`无法删除账户：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const closeDeletion = () => { setDeleting(false); setConfirmId(""); setPassword(""); };

  return (
    <div className="space-y-8">
      <Panel title="账户">
        <PanelRow label="用户名" control={account ? account.name || account.id : undefined} />
        <PasswordRow />
        {imEnabled && <FeishuAccountRow />}
        <PanelRow
          label="退出登录"
          control={(
            <Button variant="text" loading={busy === "logout"} disabled={busy !== null} onClick={() => void signOut()}>
              {busy !== "logout" && <LogOut size={16} aria-hidden="true" />}退出
            </Button>
          )}
        />
      </Panel>

      <Panel title="数据">
        <PanelRow
          label="导出账户数据"
          control={<Button variant="secondary" loading={busy === "export"} disabled={!account || busy !== null} onClick={() => void exportAccount()}>导出</Button>}
        />
        <PanelRow
          label="删除账户"
          control={deleting ? undefined : (
            <Button variant="text" destructive disabled={!account || busy !== null} onClick={() => setDeleting(true)}>删除</Button>
          )}
        >
          {deleting && account && (
            <form
              className="grid max-w-sm gap-3"
              aria-label="删除账户"
              onSubmit={(event) => { event.preventDefault(); void deleteAccount(); }}
            >
              <p className="text-ui text-text">将删除账户及全部项目，不可恢复。</p>
              <Input
                ref={confirmField}
                label={`输入账户 ID「${account.id}」确认`}
                value={confirmId}
                autoComplete="off"
                className="font-mono"
                disabled={busy === "delete"}
                onChange={(event) => setConfirmId(event.target.value)}
              />
              <Input
                label="当前密码（如需要）"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy === "delete"}
                onChange={(event) => setPassword(event.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" loading={busy === "delete"} disabled={confirmId.trim() !== account.id}>删除账户</Button>
                <Button variant="text" disabled={busy === "delete"} onClick={closeDeletion}>取消</Button>
              </div>
            </form>
          )}
        </PanelRow>
      </Panel>
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
