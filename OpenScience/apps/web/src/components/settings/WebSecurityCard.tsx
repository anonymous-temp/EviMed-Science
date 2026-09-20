import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { webErrorMessage, listWebSecurityEvents, type WebSecurityEvent } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { LEDGER_STATUS_LABEL, labelFor } from "@/lib/statusLabel";
import { toast } from "@/lib/toast";
import { formatClock } from "@/lib/format";

export function WebSecurityCard() {
  const [events, setEvents] = useState<WebSecurityEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebSecurityEvents(20));
    } catch (e) {
      toast.error(`无法读取安全日志：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-body text-text">安全事件</h2>
          <p className="mt-0.5 text-caption text-muted">该账户最近的认证事件</p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新安全事件"
          aria-label="刷新安全事件"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} aria-hidden="true" />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {events.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">暂无近期安全事件。</p>
          ) : (
            events.map((event, index) => (
              <div
                key={`${event.action}-${event.createdAt}-${index}`}
                className={cn(
                  "flex min-h-10 items-center gap-2.5 bg-surface px-3 py-2 text-ui",
                  index > 0 && "border-t border-border",
                )}
              >
                {event.status === "failed" ? (
                  <ShieldX size={13} className="shrink-0 text-error" aria-hidden="true" />
                ) : (
                  <ShieldCheck size={13} className="shrink-0 text-accent" aria-hidden="true" />
                )}
                <span className="w-20 shrink-0 font-mono text-caption text-text">{event.action}</span>
                <span
                  className={cn(
                    "w-20 shrink-0 text-caption",
                    event.status === "failed" ? "text-error" : "text-accent",
                  )}
                  title={event.status}
                >
                  {labelFor(LEDGER_STATUS_LABEL, event.status)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted">
                  {event.code ?? event.userId ?? event.username ?? "正常"}
                </span>
                <span className="shrink-0 font-mono text-caption text-muted">{formatClock(event.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

