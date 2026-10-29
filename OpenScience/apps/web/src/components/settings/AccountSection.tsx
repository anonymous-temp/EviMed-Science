import { InlineAlert } from "@/components/ui/InlineAlert";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import { deleteWebAccount, exportWebAccount, fetchWebMe, logoutWeb, webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { PasswordRow } from "./PasswordRow";

interface WebAccount {
  id: string;
  name: string;
}

/**
 * 「账户」 in 设置 (2026-09-23 plan §5.9, mockup m11): one group — 用户名,
 * 密码 (changed in place) and 退出登录 — and a second for the account's data: export, and 删除账户 as a
 * destructive text action that asks for the account's id before it acts.
 *
 * What went: the 「你的账号」 card and its sentence about how accounts are
 * isolated, the 「数据独立」 pill, the account id printed in mono under the
 * name (it appears once now, in the deletion confirmation, where it is what
 * the deletion acts on), a refresh button, and a card inside a card inside a
 * card around the confirmation.
 *
 * A third group, 记忆, is the product's plain statement of what memory keeps
 * and does not (2026-10-23 rectification T6.5; GB/T 45654-2025 §6.2 b: the
 * privacy statement says what a memory collects): what is remembered, what
 * never is, where it is seen, changed and deleted (the 记忆胶囊 page, whose
 * switch and reset are its own), and that it is not used to train a model.
 * The words follow the policy in `memoryNeverKept.mjs`; when the policy
 * moves, this moves with it.
 */
export function AccountSection() {
  const navigate = useNavigate();
  const [readError, setReadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
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
      .then((me) => { if (active) { setAccount(me?.user ?? null); setReadError(null); } })
      .catch((error) => { if (active) setReadError(`无法读取账户：${webErrorMessage(error)}`); });
    return () => { active = false; };
  }, [readAttempt]);

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
      {readError && <InlineAlert onRetry={() => setReadAttempt(attempt => attempt + 1)}>{readError}</InlineAlert>}
      <Panel title="账户">
        <PanelRow label="用户名" control={account ? account.name || account.id : readError ? "读取失败" : "正在读取"} />
        <PasswordRow />
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
                label={`输入账户 ID“${account.id}”确认`}
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

      <Panel title="记忆">
        <PanelRow
          label="会记什么"
          description="你说过、确认过、纠正过的做法和背景，以及项目的情况；在记忆胶囊里可以逐条查看、修改、忘记，也可以整体重置。"
          control={<Button variant="text" onClick={() => navigate("/app/memory")}>打开记忆胶囊</Button>}
        />
        <PanelRow label="不会记什么" description="密码、证件号和银行卡号，别人的身份信息，文档和网页里的内容；健康等敏感信息，除非你说“记住”。记忆只用来帮你工作，不会用来训练模型。" />
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
