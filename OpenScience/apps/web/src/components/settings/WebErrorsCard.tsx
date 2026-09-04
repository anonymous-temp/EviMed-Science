import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { listWebErrorEvents, type WebErrorEvent } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

export function WebErrorsCard() {
  const [events, setEvents] = useState<WebErrorEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebErrorEvents(20));
    } catch (e) {
      toast.error(`无法读取托管错误：${e instanceof Error ? e.message : String(e)}`);
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
          <h2 className="font-serif text-body text-text">托管错误</h2>
          <p className="mt-0.5 text-xs text-muted">该项目最近失败的 API 请求</p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新错误列表"
          aria-label="刷新错误列表"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {events.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">暂无近期 API 错误。</p>
          ) : (
            events.map((event, index) => (
              <div
                key={`${event.requestId ?? "request"}-${event.createdAt}-${index}`}
                className={cn(
                  "flex min-h-10 items-center gap-2.5 bg-surface px-3 py-2 text-ui",
                  index > 0 && "border-t border-border",
                )}
              >
                <AlertTriangle size={13} className="shrink-0 text-error" />
                <span className="w-10 shrink-0 font-mono text-xs text-error">{event.status}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-text" title={event.route}>
                  {event.route}
                </span>
                <span className="hidden max-w-[9rem] truncate font-mono text-caption text-muted sm:block">
                  {event.code}
                </span>
                <span className="hidden max-w-[10rem] truncate font-mono text-caption text-muted md:block">
                  {event.requestId ?? "无请求 id"}
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

function formatTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
