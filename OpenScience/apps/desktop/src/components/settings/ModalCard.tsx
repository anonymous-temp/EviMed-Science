import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { isTauri, modalStatus, type ModalStatus } from "@/lib/tauri";
import { cn } from "@/lib/cn";

/**
 * Cloud compute (Modal) status (P2-2). Like the HPC card, the app never handles
 * credentials — Modal runs use the user's own install + token. This card only
 * detects readiness; the bundled `modal-run` skill drives actual jobs.
 */
export function ModalCard() {
  const [status, setStatus] = useState<ModalStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    if (!isTauri) return;
    setChecking(true);
    try {
      setStatus(await modalStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const ok = status?.installed && status?.authenticated;
  const dot = ok ? "bg-ok" : status?.installed ? "bg-warn" : "bg-muted";

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">云端算力 (Modal)</h2>
          <p className="mt-0.5 text-xs text-muted">
            用你自己的 Modal 账号运行 GPU / 弹性任务 — 之后直接吩咐智能体。
          </p>
        </div>
        {isTauri && (
          <button
            className="inline-flex items-center gap-1 rounded-input border border-border px-2 py-1 text-ui-sm text-muted hover:text-text"
            onClick={() => void check()}
            disabled={checking}
            title="重新检查"
          >
            {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新检查
          </button>
        )}
      </header>
      <div className="px-5 py-4 text-ui">
        {!isTauri ? (
          <p className="text-muted">请在桌面应用中使用。</p>
        ) : (
          <div className="flex items-start gap-2.5">
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dot)} />
            <div className="min-w-0">
              <div className="text-text">
                {ok
                  ? `就绪${status?.version ? ` · ${status.version}` : ""}`
                  : status?.installed
                    ? "已安装，未认证"
                    : "未安装"}
              </div>
              {status?.hint && <div className="mt-0.5 text-xs text-muted">{status.hint}</div>}
              {ok && (
                <div className="mt-0.5 text-xs text-muted">
                  可以让智能体把重负载任务交给 Modal — 它会使用{" "}
                  <span className="font-mono">modal-run</span> 技能和你的 token。
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
