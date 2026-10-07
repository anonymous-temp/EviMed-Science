import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from "lucide-react";
import { knownErrorCodeMessage } from "@evimed/domain";
import { webErrorMessage, fetchWebReadiness, type WebReadiness, type WebReadinessCheck } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { humanSize } from "@/lib/format";
import { Disclosure } from "@/components/ui/Disclosure";
import { iconButtonClasses } from "@/components/ui/IconButton";
import { Tooltip } from "@/components/ui/Tooltip";

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
  saasProfile: "SaaS 配置档",
  // Six checks the deployment grew after this table was written, each of which
  // therefore fell through to `?? key` and printed its own camelCase name in
  // the middle of a Chinese list (2026-09-15 walk, E3). The fallback is right —
  // an untranslated check is visibly untranslated — but a readiness board whose
  // labels drift from the server's check list will keep producing this, so the
  // test asserts every key `/api/ready` reports has an entry here.
  memoryIndex: "记忆检索索引",
  usageLedger: "用量账本",
  inbox: "收件箱",
  documentParser: "文档解析",
  openList: "网盘接入",
  relationalIntegrity: "关系完整性",
  // The checks the modules added since (`readinessStatus` in the server): each would otherwise print its camelCase key.
  publicSourceCredentials: "公共数据源密钥",
  frontier: "前沿动态",
  jev: "独立评审",
  review: "评审服务",
  geo: "循证 GEO",
  credits: "科研额度",
  vcr: "虚拟临床研究",
};

/** What a row says when the registry has no sentence for the code the server sent: that there is something, and where to read it. */
const NO_SENTENCE_FAILED = "检查没有通过，详情见日志";
const NO_SENTENCE_WARNING = "有提示，详情见日志";

type RowKind = "failed" | "warning" | "disabled" | "passed";

interface ReadinessRow {
  key: string;
  label: string;
  check: WebReadinessCheck;
  kind: RowKind;
  /** The sentence the row reads: why it failed, what to look at, or — for a pass — what it came to. */
  detail: string;
  /** The server's own word for it, kept for the operator who has to search the logs: the tooltip, never the row. */
  code: string | null;
}

/**
 * Which of the four a check is. A check that is red is failed whatever else it says; a green one with a `warning` is the
 * degraded kind (OpenList answering with no storage mounted, a plugin out of reach, a market not configured); one the
 * deployment does not run (`skipped`, `enabled: false`, or not required and not configured) is not a pass and not a fault.
 */
function kindOf(check: WebReadinessCheck): RowKind {
  if (!check.ok) return "failed";
  if (typeof check.warning === "string" && check.warning) return "warning";
  if (check.skipped === true || check.enabled === false || (check.required === false && check.configured === false)) return "disabled";
  return "passed";
}


export function WebReadinessCard() {
  const [readiness, setReadiness] = useState<WebReadiness | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await fetchWebReadiness());
    } catch (e) {
      toast.error(`无法读取部署配置检查：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo<ReadinessRow[]>(() => {
    const checks = readiness?.checks ?? {};
    return Object.entries(checks).map(([key, check]) => {
      const kind = kindOf(check);
      const code = kind === "failed" ? check.code ?? null : kind === "warning" ? String(check.warning) : null;
      const detail = kind === "failed" ? (code && knownErrorCodeMessage(code)) || NO_SENTENCE_FAILED
        : kind === "warning" ? (code && knownErrorCodeMessage(code)) || NO_SENTENCE_WARNING
          : kind === "disabled" ? "没有启用这项功能"
            : readinessDetail(key, check);
      return { key, label: CHECK_LABELS[key] ?? key, check, kind, detail, code };
    });
  }, [readiness]);

  const failed = rows.filter((row) => row.kind === "failed");
  const noted = rows.filter((row) => row.kind === "warning");
  const disabled = rows.filter((row) => row.kind === "disabled");
  const passed = rows.filter((row) => row.kind === "passed");
  const attention = failed.length + noted.length;

  return (
    <section className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-body text-text">部署配置检查</h2>
          <p className="mt-0.5 text-caption text-muted">只检查配置和依赖服务，不代表当前研究能用</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-caption font-medium", readiness && attention === 0 ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn")}>
          {readiness ? (attention === 0 ? "配置通过" : "需要关注") : "正在读取"}
        </span>
        <Tooltip content="刷新配置检查" kind="label">
          <button
            className={iconButtonClasses({ size: "sm" })}
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="刷新配置检查"
          >
            <RefreshCw size={16} className={cn(loading && "animate-spin")} aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {rows.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">配置检查尚未加载。</p>
          ) : (
            <>
              {/* What needs a person first; what is fine is folded, so a clean deployment is a short card. */}
              {[...failed, ...noted].map((row, index) => <Row key={row.key} row={row} first={index === 0} />)}
              {disabled.map((row, index) => <Row key={row.key} row={row} first={failed.length + noted.length + index === 0} />)}
              {passed.length > 0 && (
                <div className={cn("bg-surface px-3 py-2", rows.length > passed.length && "border-t border-border")}>
                  <Disclosure summary={`已通过 ${passed.length} 项`}>
                    <div className="overflow-hidden rounded-input border border-border">
                      {passed.map((row, index) => <Row key={row.key} row={row} first={index === 0} />)}
                    </div>
                  </Disclosure>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

const STATE_WORD: Record<RowKind, string> = { failed: "失败", warning: "需要留意", disabled: "未启用", passed: "通过" };

/** One check: its mark, its name, its state in words, and the sentence — with the server's code in a tooltip for whoever must grep the logs. */
function Row({ row, first }: { row: ReadinessRow; first: boolean }) {
  const { kind } = row;
  const icon: ReactNode = kind === "failed" ? <XCircle size={16} className="shrink-0 text-error" aria-hidden="true" />
    : kind === "warning" ? <AlertTriangle size={16} className="shrink-0 text-warn" aria-hidden="true" />
      : kind === "disabled" ? <CircleDashed size={16} className="shrink-0 text-muted" aria-hidden="true" />
        : <CheckCircle2 size={16} className="shrink-0 text-ok" aria-hidden="true" />;
  const detail = <span className="min-w-0 flex-1 text-caption text-muted">{row.detail}</span>;
  return (
    <div className={cn("flex min-h-11 items-center gap-2.5 bg-surface px-3 py-2 text-ui", !first && "border-t border-border")}>
      {icon}
      <span className="w-32 shrink-0 font-medium text-text">{row.label}</span>
      <span className={cn("w-20 shrink-0 text-caption", kind === "failed" ? "text-error" : kind === "warning" ? "text-warn" : kind === "passed" ? "text-ok" : "text-muted")}>
        {STATE_WORD[kind]}
      </span>
      {row.code ? <Tooltip content={row.code}>{detail}</Tooltip> : detail}
    </div>
  );
}

/**
 * What a passing check came to, in words: numbers and switches the operator reads, never the configuration's own enum
 * values (`explicitly_allowed`, `individual-saas`), which are the deployment's file and not this page's business.
 */
function readinessDetail(key: string, check: WebReadinessCheck): string {
  if (key === "publicUrl") return String(check.origin ?? (check.required ? "必需" : "开发环境"));
  if (key === "auth") return check.users != null ? `${check.users} 个用户` : "";
  if (key === "saasProfile") return check.technicalSaas ? "SaaS 技术边界通过" : "受控试点";
  if (key === "security") {
    return [
      check.securityHeaders ? "响应头" : "响应头关闭",
      check.corsOriginCount != null ? `${check.corsOriginCount} 个 CORS 来源` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (key === "observability") return check.required ? "必需" : "可选";
  if (key === "release") {
    if (check.tracked === false) return "未跟踪的开发构建";
    return [check.appVersion ? `v${check.appVersion}` : null, check.releaseId].filter(Boolean).join(" · ");
  }
  if (key === "resources") {
    return [
      Number(check.maxFileBytes) > 0 ? `${humanSize(Number(check.maxFileBytes))} 文件` : null,
      Number(check.maxProjectBytes) > 0 ? `${humanSize(Number(check.maxProjectBytes))} 项目` : null,
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
      check.retentionDays != null ? `保留 ${check.retentionDays} 天` : null,
      check.encrypted ? "已加密" : null,
      check.restoreDrill ? "恢复演练" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  // A pass needs no second word: its state already says it.
  return "";
}
