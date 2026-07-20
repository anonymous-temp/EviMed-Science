import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { cancelWebTask, listWebTasks, type WebTask, type WebTaskStatus } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

const TONE: Record<WebTaskStatus, string> = {
  queued: "text-muted",
  running: "text-warn",
  canceling: "text-warn",
  succeeded: "text-ok",
  failed: "text-error",
  canceled: "text-muted",
  timed_out: "text-error",
};

const TERMINAL = new Set<WebTaskStatus>(["succeeded", "failed", "canceled", "timed_out"]);

export function WebTasksCard() {
  const [tasks, setTasks] = useState<WebTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [canceling, setCanceling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await listWebTasks());
    } catch (e) {
      toast.error(`无法读取托管任务：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cancel = async (id: string) => {
    setCanceling(id);
    try {
      const task = await cancelWebTask(id);
      setTasks((items) => items.map((item) => (item.id === id ? task : item)));
    } catch (e) {
      toast.error(`无法取消任务：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCanceling(null);
    }
  };

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">托管任务</h2>
          <p className="mt-0.5 text-xs text-muted">当前项目的任务队列</p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新任务"
          aria-label="刷新任务"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {tasks.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">该项目暂无任务。</p>
          ) : (
            tasks.map((task, index) => (
              <div
                key={task.id}
                className={cn(
                  "flex h-10 items-center gap-2.5 bg-surface px-3 text-ui",
                  index > 0 && "border-t border-border",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-text">
                  {task.command}
                </span>
                <span className="hidden max-w-[9rem] truncate font-mono text-caption text-muted sm:block">
                  {task.id}
                </span>
                <span className={cn("text-xs font-medium", TONE[task.status])}>
                  {task.status.replace("_", " ")}
                </span>
                <span className="hidden font-mono text-caption text-muted sm:inline">
                  {formatTime(task.startedAt ?? task.queuedAt ?? task.createdAt)}
                </span>
                {!TERMINAL.has(task.status) && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error disabled:opacity-50"
                    onClick={() => void cancel(task.id)}
                    disabled={canceling === task.id}
                    title={`取消 ${task.command}`}
                    aria-label={`取消 ${task.command}`}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function formatTime(value: string | null) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
