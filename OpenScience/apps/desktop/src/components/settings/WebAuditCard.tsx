import { useCallback, useEffect, useState } from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import { listWebAuditLog, type WebAuditRecord } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

export function WebAuditCard() {
  const [events, setEvents] = useState<WebAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebAuditLog(20));
    } catch (e) {
      toast.error(`无法读取托管审计日志：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">托管审计</h2>
          <p className="mt-0.5 text-xs text-muted">该工作区最近的项目操作</p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新审计事件"
          aria-label="刷新审计事件"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {events.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">暂无近期审计事件。</p>
          ) : (
            events.map((event, index) => (
              <div
                key={`${event.action ?? event.command ?? "event"}-${event.createdAt}-${index}`}
                className={cn(
                  "flex min-h-10 items-center gap-2.5 bg-surface px-3 py-2 text-ui",
                  index > 0 && "border-t border-border",
                )}
              >
                <ClipboardList size={13} className={cn("shrink-0", statusTone(event.status))} />
                <span className="w-24 shrink-0 truncate font-mono text-caption text-text" title={event.action ?? ""}>
                  {event.action ?? "操作"}
                </span>
                <span className={cn("w-20 shrink-0 font-mono text-caption", statusTone(event.status))}>
                  {event.status}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={event.target ?? ""}>
                  {event.target ?? event.command ?? "项目"}
                </span>
                <span className="hidden w-16 shrink-0 text-right font-mono text-caption text-muted sm:block">
                  {formatBytes(event.bytes)}
                </span>
                <span className="shrink-0 font-mono text-caption text-muted">{formatTime(event.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function statusTone(status: WebAuditRecord["status"]) {
  if (status === "failed") return "text-error";
  if (status === "completed") return "text-accent";
  return "text-muted";
}

function formatBytes(value: number | null | undefined) {
  if (!Number.isFinite(value) || !value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / (1024 * 1024))} MB`;
}

function formatTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
