import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { webErrorMessage, cancelWebTask, listWebTasks, type WebTask, type WebTaskStatus } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { formatClock } from "@/lib/format";
import { commandLabel, labelFor } from "@/lib/statusLabel";
import { IconButton } from "@/components/ui/IconButton";
import { CopyId, OPS_TONE, OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows, type OpsTone } from "./OpsCard";

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

/** A task that is under way or stopped is amber or red; one that finished is the page's own text, one that was cancelled is quiet. */
const TONE: Record<WebTaskStatus, OpsTone> = {
  queued: "quiet",
  running: "warn",
  canceling: "warn",
  succeeded: "ok",
  failed: "failed",
  canceled: "quiet",
  timed_out: "failed",
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
    <OpsCard title="后台任务" description="当前项目的任务队列" refresh={{ label: "刷新任务", loading, onRefresh: () => void refresh() }}>
      <OpsBody>
        <OpsRows label="后台任务">
          {tasks.length === 0 ? (
            <OpsNothing>该项目暂无任务。</OpsNothing>
          ) : (
            tasks.map((task) => (
              <OpsRow key={task.id}>
                <span className="min-w-0 flex-1 truncate text-text">{commandLabel(task.command)}</span>
                <CopyId value={task.id} label={`复制“${commandLabel(task.command)}”的任务标识`} />
                <span className={cn("text-caption", OPS_TONE[TONE[task.status]])}>
                  {labelFor(TASK_STATUS_LABEL, task.status)}
                </span>
                <span className="hidden font-mono text-caption text-text-3 sm:inline">
                  {formatClock(task.startedAt ?? task.queuedAt ?? task.createdAt)}
                </span>
                {!TERMINAL.has(task.status) && (
                  <IconButton
                    icon={X}
                    label={`取消 ${commandLabel(task.command)}`}
                    size="sm"
                    destructive
                    onClick={() => void cancel(task.id)}
                    disabled={canceling === task.id}
                  />
                )}
              </OpsRow>
            ))
          )}
        </OpsRows>
      </OpsBody>
    </OpsCard>
  );
}
