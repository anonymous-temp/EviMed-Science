import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { webErrorMessage, fetchWebMetrics, restartWebRuntime, startWebRuntime, stopWebRuntime, type WebMetrics } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { formatClock, formatRelativeTime, humanSize } from "@/lib/format";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { iconButtonClasses } from "@/components/ui/IconButton";
import { buttonClasses } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";

export function WebResourcesCard() {
  const [metrics, setMetrics] = useState<WebMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<"start" | "restart" | "stop" | null>(null);
  // Stop and restart end whatever analysis is running in the container. They
  // were one click next to 「启动」 with no confirmation (review B, P0).
  const [confirming, setConfirming] = useState<"restart" | "stop" | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(await fetchWebMetrics());
    } catch (e) {
      toast.error(`无法读取资源：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startRuntime = async () => {
    setRuntimeAction("start");
    try {
      await startWebRuntime();
      setMetrics(await fetchWebMetrics());
      toast.success("研究运行时已启动。");
    } catch (e) {
      toast.error(`无法启动研究运行时：${webErrorMessage(e)}`);
    } finally {
      setRuntimeAction(null);
    }
  };

  const restartRuntime = async () => {
    setRuntimeAction("restart");
    try {
      await restartWebRuntime();
      setMetrics(await fetchWebMetrics());
      toast.success("研究运行时已重启。");
    } catch (e) {
      toast.error(`无法重启研究运行时：${webErrorMessage(e)}`);
    } finally {
      setRuntimeAction(null);
    }
  };

  const stopRuntime = async () => {
    setRuntimeAction("stop");
    try {
      await stopWebRuntime();
      setMetrics(await fetchWebMetrics());
      toast.success("研究运行时已停止。");
    } catch (e) {
      toast.error(`无法停止研究运行时：${webErrorMessage(e)}`);
    } finally {
      setRuntimeAction(null);
    }
  };

  const used = metrics?.project.storage.usedBytes ?? 0;
  const max = metrics?.project.storage.maxBytes ?? null;
  const pct = max && max > 0 ? Math.min(100, Math.round((used / max) * 100)) : null;
  const runningTasks = metrics
    ? metrics.tasks.byStatus.running + metrics.tasks.byStatus.queued + metrics.tasks.byStatus.canceling
    : 0;
  const runtimeRunning = Boolean(metrics?.runtime.running);
  const controlsDisabled = loading || runtimeAction != null || metrics == null;

  return (
    <section className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-body text-text">运行状况</h2>
          <p className="mt-0.5 text-caption text-muted">
            {metrics ? `${metrics.project.name} · ${formatClock(metrics.createdAt)}` : "当前项目与服务端进程"}
          </p>
        </div>
        <Tooltip content="刷新资源状态" kind="label">
          <button
            className={iconButtonClasses({ size: "sm" })}
            onClick={() => void refresh()}
            disabled={loading || runtimeAction != null}
            aria-label="刷新资源状态"
          >
            <RefreshCw size={16} className={cn(loading && "animate-spin")} aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="存储" value={max ? `${humanSize(used)} / ${humanSize(max)}` : humanSize(used)} detail={pct == null ? "无配额" : `已用 ${pct}%`} />
        <Metric label="任务" value={`${runningTasks} 个进行中`} detail={`共 ${metrics?.tasks.total ?? 0} 条`} />
        <Metric label="运行时" {...runtimeMetric(metrics, runningTasks)} />
        <Metric label="服务端内存" value={humanSize(metrics?.server.memory.rssBytes ?? 0)} detail={metrics ? `pid ${metrics.server.pid}` : "未加载"} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <Tooltip content="启动研究运行时" kind="label">
          <button
            className={runtimeButtonCls}
            onClick={() => void startRuntime()}
            disabled={controlsDisabled || runtimeRunning}
            aria-label="启动研究运行时"
          >
            <Play size={16} className={cn(runtimeAction === "start" && "animate-pulse")} aria-hidden="true" />
            启动
          </button>
        </Tooltip>
        <Tooltip content="重启研究运行时" kind="label">
          <button
            className={runtimeButtonCls}
            onClick={() => setConfirming("restart")}
            disabled={controlsDisabled}
            aria-label="重启研究运行时"
          >
            <RotateCw size={16} className={cn(runtimeAction === "restart" && "animate-spin")} aria-hidden="true" />
            重启
          </button>
        </Tooltip>
        <Tooltip content="停止研究运行时" kind="label">
          <button
            className={cn(runtimeButtonCls, "hover:text-error")}
            onClick={() => setConfirming("stop")}
            disabled={controlsDisabled || !runtimeRunning}
            aria-label="停止研究运行时"
          >
            <Square size={16} className={cn(runtimeAction === "stop" && "animate-pulse")} aria-hidden="true" />
            停止
          </button>
        </Tooltip>
      </div>
      {confirming && (
        <ConfirmDialog
          title={confirming === "stop" ? "停止研究运行时？" : "重启研究运行时？"}
          body={confirming === "stop"
            ? "正在进行的研究会立即中断；已写出的文件保留在工作区。下次打开任务时运行时会重新启动，通常需要十秒左右。"
            : "正在进行的研究会立即中断；已写出的文件保留在工作区。重启通常需要十秒左右。"}
          confirmLabel={confirming === "stop" ? "停止运行时" : "重启运行时"}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const action = confirming;
            setConfirming(null);
            void (action === "stop" ? stopRuntime() : restartRuntime());
          }}
        />
      )}
    </section>
  );
}

// The small secondary button (spec §17.1): there are no outline buttons.
const runtimeButtonCls = buttonClasses({ variant: "secondary", size: "sm" });

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "warn" }) {
  return (
    <div className={cn("rounded-input border bg-bg px-3 py-2.5", tone === "warn" ? "border-warn" : "border-border")}>
      <div className="text-caption text-muted">{label}</div>
      <div className={cn("mt-1 truncate text-ui font-medium", tone === "warn" ? "text-warn-strong" : "text-text")}>{value}</div>
      <div className="mt-0.5 truncate text-caption text-muted">{detail}</div>
    </div>
  );
}

/**
 * What the runtime tile says, decided from two facts and nothing else: whether it is up, and whether anything is waiting on it.
 *
 * `stale` means the state file still said running or starting and the process is not there now. For a runtime that is started
 * when it is used (and reaped when idle, and replaced by a release switch) that is the normal state of a quiet project, so it
 * is an alarm only when work waits on it — 「失联」 is a claim that someone is affected, and it is made only then.
 */
function runtimeMetric(metrics: WebMetrics | null, waiting: number): { value: string; detail: string; tone?: "warn" } {
  if (!metrics) return { value: "已停止", detail: "未加载" };
  const runtime = metrics.runtime;
  if (runtime.running) return { value: "运行中", detail: runtime.startedAt ? `启动于 ${formatRelativeTime(runtime.startedAt)}` : "" };
  if (runtime.stale && waiting > 0) return { value: "失联", detail: `有 ${waiting} 个任务在等它`, tone: "warn" };
  if (runtime.stale) return { value: "已停止", detail: "意外退出，下次打开任务会自动启动" };
  return { value: "已停止", detail: "用到时自动启动" };
}
