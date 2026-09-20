import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { webErrorMessage, cancelWebTask, listWebTasks, type WebTask, type WebTaskStatus } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { formatClock } from "@/lib/format";
import { labelFor } from "@/lib/statusLabel";

/** The task states in words: `timed out` and `succeeded` reached the page as
 *  English enum values (review B, WebTasksCard P1). */
const TASK_STATUS_LABEL: Record<WebTaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  canceling: "正在取消",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  timed_out: "已超时",
};

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
      toast.error(`无法读取后台任务：${webErrorMessage(e)}`);
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
      toast.error(`无法取消任务：${webErrorMessage(e)}`);
    } finally {
      setCanceling(null);
    }
  };

  return (
    <section className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-body text-text">后台任务</h2>
          <p className="mt-0.5 text-caption text-muted">当前项目的任务队列</p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新任务"
          aria-label="刷新任务"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} aria-hidden="true" />
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
                <span className={cn("text-caption font-medium", TONE[task.status])}>
                  {labelFor(TASK_STATUS_LABEL, task.status)}
                </span>
                <span className="hidden font-mono text-caption text-muted sm:inline">
                  {formatClock(task.startedAt ?? task.queuedAt ?? task.createdAt)}
                </span>
                {!TERMINAL.has(task.status) && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error disabled:opacity-50"
                    onClick={() => void cancel(task.id)}
                    disabled={canceling === task.id}
                    title={`取消 ${task.command}`}
                    aria-label={`取消 ${task.command}`}
                  >
                    <X size={13} aria-hidden="true" />
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

