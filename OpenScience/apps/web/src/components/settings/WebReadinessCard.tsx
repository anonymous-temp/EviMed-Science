import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, RefreshCw, XCircle } from "lucide-react";
import { fetchWebReadiness, type WebReadiness, type WebReadinessCheck } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

const CHECK_LABELS: Record<string, string> = {
  dataDir: "数据卷",
  examples: "示例工作流",
  staticDir: "静态资源",
  publicUrl: "公开 URL",
  auth: "身份认证",
  stateStore: "共享控制面",
  memory: "科研记忆",
  security: "安全策略",
  observability: "可观测性",
  evimedAdapters: "专业工作流",
  scienceConnectors: "科学连接器",
  modelGateway: "模型网关",
  release: "发布溯源",
  resources: "资源限额",
  backup: "备份",
  runtime: "运行时沙箱",
  kernel: "内核策略",
  saasProfile: "SaaS Profile",
};

export function WebReadinessCard() {
  const [readiness, setReadiness] = useState<WebReadiness | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await fetchWebReadiness());
    } catch (e) {
      toast.error(`无法读取部署就绪状态：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    const checks = readiness?.checks ?? {};
    return Object.entries(checks).map(([key, check]) => ({
      key,
      label: CHECK_LABELS[key] ?? key,
      check,
    }));
  }, [readiness]);

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">部署就绪检查</h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {readiness ? (readiness.ok ? "托管检查全部通过" : "托管检查需要关注") : "服务端就绪检查"}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-caption font-medium", readiness?.ok ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn")}>
          {readiness ? (readiness.ok ? "就绪" : "未就绪") : "加载中"}
        </span>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新就绪状态"
          aria-label="刷新就绪状态"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {rows.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">就绪检查尚未加载。</p>
          ) : (
            rows.map(({ key, label, check }, index) => (
              <div
                key={key}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 bg-surface px-3 py-2 text-ui",
                  index > 0 && "border-t border-border",
                )}
              >
                {check.skipped ? (
                  <CircleDashed size={14} className="shrink-0 text-muted" />
                ) : check.ok ? (
                  <CheckCircle2 size={14} className="shrink-0 text-ok" />
                ) : (
                  <XCircle size={14} className="shrink-0 text-error" />
                )}
                <span className="w-32 shrink-0 font-medium text-text">{label}</span>
                <span
                  className={cn(
                    "w-20 shrink-0 font-mono text-caption",
                    check.ok ? "text-ok" : check.skipped ? "text-muted" : "text-error",
                  )}
                >
                  {check.skipped ? "已跳过" : check.ok ? "通过" : "失败"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted">
                  {readinessDetail(key, check)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function readinessDetail(key: string, check: WebReadinessCheck): string {
  if (!check.ok) return check.code ?? "check_failed";
  if (check.skipped) return "未配置";
  if (key === "publicUrl") return String(check.origin ?? (check.required ? "必需" : "开发环境"));
  if (key === "auth") return [check.mode, check.users != null ? `${check.users} 个用户` : null].filter(Boolean).join(" · ");
  if (key === "saasProfile") {
    return [check.profile, check.tenantModel, check.technicalSaas ? "SaaS 技术边界通过" : "受控试点"]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "security") {
    return [
      check.securityHeaders ? "响应头" : "响应头关闭",
      check.corsOriginCount != null ? `${check.corsOriginCount} 个 CORS 来源` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "observability") {
    return [check.mode, check.required ? "必需" : "可选"].filter(Boolean).join(" · ");
  }
  if (key === "release") {
    if (check.tracked === false) return "未跟踪的开发构建";
    return [check.releaseId, check.appVersion ? `v${check.appVersion}` : null, check.revision]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "resources") {
    return [
      check.maxFileBytes != null ? `${formatBytes(Number(check.maxFileBytes))} 文件` : null,
      check.maxProjectBytes != null ? `${formatBytes(Number(check.maxProjectBytes))} 项目` : null,
      check.maxConcurrentTasks != null ? `${check.maxConcurrentTasks} 任务` : null,
      check.maxRuntimeProxyConnections != null ? `${check.maxRuntimeProxyConnections} 代理` : null,
      check.runtimeQuotaCheckIntervalMs != null
        ? `${Number(check.runtimeQuotaCheckIntervalMs) / 1000}s 配额检查`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "backup") {
    return [
      check.mode,
      check.retentionDays != null ? `保留 ${check.retentionDays} 天` : null,
      check.encrypted ? "已加密" : null,
      check.restoreDrill ? "恢复演练" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "runtime") {
    return [check.mode, check.sandboxMode, check.networkMode, check.networkEgress, check.networkPolicy]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "kernel") return String(check.mode ?? "disabled");
  return "可用";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "invalid";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  const text = next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1);
  return `${text.replace(/\.0$/, "")} ${units[unit]}`;
}
