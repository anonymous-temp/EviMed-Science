import { useCallback, useEffect, useState } from "react";
import { Download, LogOut, RefreshCw, Trash2, UserRound, X } from "lucide-react";
import { deleteWebAccount, exportWebAccount, fetchWebMe, logoutWeb } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

interface WebAccount {
  id: string;
  name: string;
}

export function WebAccountCard({
  onAccountDeleted,
  onSignedOut,
}: {
  onAccountDeleted?: () => void;
  onSignedOut?: () => void;
}) {
  const [account, setAccount] = useState<WebAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"export" | "delete" | "logout" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [password, setPassword] = useState("");
  const [deleted, setDeleted] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await fetchWebMe();
      setAccount(me?.user ?? null);
      setDeleted(false);
    } catch (e) {
      toast.error(`无法读取托管账户：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const exportAccount = async () => {
    if (!account) return;
    setBusy("export");
    try {
      const blob = await exportWebAccount();
      downloadBlob(blob, `evimed-account-${safeFilename(account.id)}.tar.gz`);
      toast.success("账户归档已导出。");
    } catch (e) {
      toast.error(`无法导出托管账户：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!account) return;
    const confirmedId = confirmId.trim();
    if (confirmedId !== account.id) return;
    setBusy("delete");
    try {
      await deleteWebAccount(confirmedId, password.trim() || undefined);
      setAccount(null);
      setDeleted(true);
      setConfirmingDelete(false);
      setConfirmId("");
      setPassword("");
      onAccountDeleted?.();
      toast.success("账户已删除。");
    } catch (e) {
      toast.error(`无法删除托管账户：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy("logout");
    try {
      await logoutWeb();
      setAccount(null);
      onSignedOut?.();
      toast.success("已退出登录。");
    } catch (e) {
      toast.error(`无法退出登录：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const deleting = busy === "delete";
  const exporting = busy === "export";
  const deleteDisabled = !account || deleting || confirmId.trim() !== account.id;

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">托管账户</h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {account ? `${account.name || account.id} · ${account.id}` : "当前托管会话"}
          </p>
        </div>
        <button
          className={iconButtonCls}
          onClick={() => void refresh()}
          disabled={loading || busy != null}
          title="刷新账户"
          aria-label="刷新账户"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        {deleted ? (
          <p className="rounded-input border border-border bg-surface-2 px-3 py-2.5 text-ui text-muted">
            账户已删除。请重新登录以继续使用。
          </p>
        ) : !account ? (
          <p className="rounded-input border border-border bg-surface-2 px-3 py-2.5 text-ui text-muted">
            当前没有登录托管账户。
          </p>
        ) : (
          <>
            <div className="flex min-h-12 items-center gap-3 rounded-input border border-border px-3 py-2">
              <UserRound size={15} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium text-text">{account.name || account.id}</p>
                <p className="truncate font-mono text-caption text-muted">{account.id}</p>
              </div>
              <button
                className={iconButtonCls}
                onClick={() => void exportAccount()}
                disabled={busy != null}
                title="导出账户归档"
                aria-label="导出账户归档"
              >
                <Download size={13} className={cn(exporting && "animate-pulse")} />
              </button>
              <button
                className={iconButtonCls}
                onClick={() => void signOut()}
                disabled={busy != null}
                title="退出登录"
                aria-label="退出登录"
              >
                <LogOut size={13} />
              </button>
              <button
                className={cn(iconButtonCls, "hover:text-error")}
                onClick={() => setConfirmingDelete(true)}
                disabled={busy != null}
                title="删除账户"
                aria-label="打开账户删除"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {confirmingDelete && (
              <div className="mt-3 rounded-input border border-error/30 bg-error/5 p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui font-medium text-text">删除 {account.id}？</p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      将删除该账户及其全部托管项目、工作区、任务状态、运行时状态与日志。
                    </p>
                  </div>
                  <button
                    className={iconButtonCls}
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    title="取消删除"
                    aria-label="取消账户删除"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input
                    className={inputCls("font-mono")}
                    value={confirmId}
                    onChange={(e) => setConfirmId(e.target.value)}
                    placeholder={account.id}
                    aria-label="确认账户 id"
                    disabled={deleting}
                  />
                  <input
                    className={inputCls()}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="密码（如需要）"
                    aria-label="当前密码"
                    disabled={deleting}
                  />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    className="h-8 rounded-input border border-border px-3 text-xs text-muted hover:bg-surface hover:text-text disabled:opacity-50"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                  >
                    取消
                  </button>
                  <button
                    className="h-8 rounded-input bg-error px-3 text-xs font-medium text-error-fg hover:opacity-90 disabled:opacity-50"
                    onClick={() => void confirmDelete()}
                    disabled={deleteDisabled}
                    aria-label="确认删除账户"
                  >
                    {deleting ? "正在删除…" : "删除账户"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const inputCls = (extra = "") =>
  cn(
    "h-9 min-w-0 rounded-input border border-border bg-surface px-3 text-ui text-text outline-none",
    "placeholder:text-muted focus:border-accent/60 disabled:opacity-50",
    extra,
  );

const iconButtonCls =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40";

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
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
