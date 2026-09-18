import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { webErrorMessage, fetchWebMetrics, restartWebRuntime, startWebRuntime, stopWebRuntime, type WebMetrics } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { formatClock, humanSize } from "@/lib/format";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

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
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">运行资源</h2>
          <p className="mt-0.5 text-caption text-muted">
            {metrics ? `${metrics.project.name} · ${formatClock(metrics.createdAt)}` : "当前项目与服务端进程"}
          </p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading || runtimeAction != null}
          title="刷新资源状态"
          aria-label="刷新资源状态"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} aria-hidden="true" />
        </button>
      </header>
      <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="存储" value={max ? `${humanSize(used)} / ${humanSize(max)}` : humanSize(used)} detail={pct == null ? "无配额" : `已用 ${pct}%`} />
        <Metric label="任务" value={`${runningTasks} 个进行中`} detail={`共 ${metrics?.tasks.total ?? 0} 条`} />
        <Metric
          label="运行时"
          value={metrics?.runtime.running ? "运行中" : metrics?.runtime.stale ? "失联" : "已停止"}
          detail={runtimeDetail(metrics)}
        />
        <Metric label="服务端内存" value={humanSize(metrics?.server.memory.rssBytes ?? 0)} detail={metrics ? `pid ${metrics.server.pid}` : "未加载"} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <button
          className={runtimeButtonCls}
          onClick={() => void startRuntime()}
          disabled={controlsDisabled || runtimeRunning}
          title="启动研究运行时"
          aria-label="启动研究运行时"
        >
          <Play size={13} className={cn(runtimeAction === "start" && "animate-pulse")} aria-hidden="true" />
          启动
        </button>
        <button
          className={runtimeButtonCls}
          onClick={() => setConfirming("restart")}
          disabled={controlsDisabled}
          title="重启研究运行时"
          aria-label="重启研究运行时"
        >
          <RotateCw size={13} className={cn(runtimeAction === "restart" && "animate-spin")} aria-hidden="true" />
          重启
        </button>
        <button
          className={cn(runtimeButtonCls, "hover:text-error")}
          onClick={() => setConfirming("stop")}
          disabled={controlsDisabled || !runtimeRunning}
          title="停止研究运行时"
          aria-label="停止研究运行时"
        >
          <Square size={13} className={cn(runtimeAction === "stop" && "animate-pulse")} aria-hidden="true" />
          停止
        </button>
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

const runtimeButtonCls =
  "inline-flex h-8 items-center gap-1.5 rounded-input border border-border px-3 text-caption font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40";

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-input border border-border bg-bg px-3 py-2.5">
      <div className="text-caption text-muted">{label}</div>
      <div className="mt-1 truncate text-ui font-medium text-text">{value}</div>
      <div className="mt-0.5 truncate text-caption text-muted">{detail}</div>
    </div>
  );
}

function runtimeDetail(metrics: WebMetrics | null) {
  if (!metrics) return "未加载";
  const runtime = metrics.runtime;
  if (runtime.stale) return runtime.lastEvent ? `最近 ${runtime.lastEvent}` : "未连接";
  return runtime.kind ?? runtime.sandboxMode ?? "未启动";
}


