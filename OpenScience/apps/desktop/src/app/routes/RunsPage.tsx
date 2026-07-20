import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  FileCode2,
  FileOutput,
  FlaskConical,
  Loader2,
  MessageSquare,
  Package,
  RotateCcw,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import type { RunArtifact, RunRecord } from "@ai4s/shared";
import { queryRuns, readRunLog, reproduceRunPrompt, type RunFacet, type RunPage } from "@/lib/runs";
import { downloadArtifact, openArtifactExternally } from "@/lib/artifactFile";
import { hasWebApi, listWebAgentRuns, type WebAgentRun, type WebAgentRunStatus } from "@/lib/apiClient";
import { isTauri } from "@/lib/tauri";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { EmptyState } from "@/components/cards/EmptyState";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { formatDateTime, humanSize } from "@/lib/format";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

type SincePreset = "24h" | "7d" | "30d";
const SINCE_SECONDS: Record<SincePreset, number> = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

interface Filter {
  search: string;
  status?: string;
  surface?: string;
  since?: SincePreset;
}

const WEB_RUN_STATUS_LABEL: Record<WebAgentRunStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};

/** Global Runs view (sidebar) — all runs across every session, like the global
 *  Files browser and Notebooks page. Same information architecture on both
 *  surfaces; only the data source and row actions differ. */
export function RunsPage() {
  if (hasWebApi && !isTauri) return <HostedRunsView />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <RunsHeader
          description={
            <>
              跨所有科研会话记录代码执行的命令、代码版本、环境、硬件与输出。
              <span className="text-text/70">复现</span>会重新运行命令并比较结果。
            </>
          }
        />
        <RunsView />
      </div>
    </div>
  );
}

/** The page header shared by both runs surfaces. */
function RunsHeader({ description }: { description: ReactNode }) {
  return (
    <header className="mb-4 flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-input bg-accent/10 text-accent">
        <FlaskConical size={17} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="font-serif text-xl leading-tight text-text">运行记录</h1>
        <p className="mt-0.5 text-sm text-muted">{description}</p>
      </div>
    </header>
  );
}

interface RunsFilterChip {
  key: string;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: string;
  accent?: boolean;
}

/** The sticky filter bar shared by both runs ledgers: a search box (callers
 *  debounce it), status/surface facet chips, and a recency preset switch. */
function RunsFilterBar({
  search,
  searchPlaceholder,
  onSearchChange,
  chips,
  since,
  onSinceChange,
  anyFilter,
  onClear,
}: {
  search: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  chips: RunsFilterChip[];
  since?: SincePreset;
  onSinceChange: (since: SincePreset | undefined) => void;
  anyFilter: boolean;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-bg/95 px-1 py-2 backdrop-blur">
      <div className="relative min-w-[12rem] flex-1">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full rounded-input border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
        />
      </div>
      {chips.map((chip) => (
        <FacetChip
          key={chip.key}
          label={chip.label}
          count={chip.count}
          active={chip.active}
          onClick={chip.onClick}
          dot={chip.dot}
          accent={chip.accent}
        />
      ))}
      <div className="flex shrink-0 items-center rounded-full border border-border bg-surface p-0.5 text-xs">
        {(["all", "24h", "7d", "30d"] as const).map((k) => {
          const active = (since ?? "all") === k;
          return (
            <button
              key={k}
              onClick={() => onSinceChange(k === "all" ? undefined : k)}
              className={cn(
                "rounded-full px-2 py-0.5 font-medium capitalize transition-colors",
                active ? "bg-surface-2 text-text" : "text-muted hover:text-text",
              )}
            >
              {k === "all" ? "任意时间" : k}
            </button>
          );
        })}
      </div>
      {anyFilter && (
        <button className="text-xs text-link hover:underline" onClick={onClear}>
          清除
        </button>
      )}
    </div>
  );
}

/** One day-grouped section of the ledger, under its sticky day label. */
function DaySection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div className="sticky top-[3.25rem] z-10 bg-bg/95 py-1 text-caption font-semibold uppercase tracking-wider text-muted backdrop-blur">
        {label}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

/** The ledger's two empty states: nothing recorded yet, or nothing matches. */
function RunsEmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return <EmptyState icon={Search} title="没有符合筛选条件的运行记录。" className="mt-8" />;
  }
  return (
    <EmptyState
      icon={FlaskConical}
      title="尚无运行记录"
      description={
        <>
          当科研 Agent 运行代码时（例如 <span className="font-mono text-text">python train.py</span>
          ），执行方案和产物会记录于此。
        </>
      }
      className="mt-8 rounded-input border border-dashed border-border bg-surface"
    />
  );
}

/**
 * The desktop runs ledger — experiment executions backed by the global SQLite
 * index over the append-only runs logs. Faceted (status / surface), searchable,
 * and keyset-paginated with infinite scroll, so it stays fast and calm from
 * five runs to hundreds of thousands. Reused by the global `RunsPage` (all
 * sessions) and the per-session `RunsPane` (passes `sessionId` to narrow).
 */
function RunsView({ sessionId }: { sessionId?: string }) {
  const [filter, setFilter] = useState<Filter>({ search: "" });
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<RunRecord[]>([]);
  const [facets, setFacets] = useState<RunPage["facets"]>({ status: [], surface: [] });
  const [cursor, setCursor] = useState<RunPage["next"]>(undefined);
  const [state, setState] = useState<"loading" | "loadingMore" | "ready">("loading");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [log, setLog] = useState<{ hash: string; text: string | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

  // Debounce the search box so each keystroke doesn't hit the index.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filter.search.trim()), 220);
    return () => clearTimeout(timer);
  }, [filter.search]);

  const base = useMemo(
    () => ({
      sessionId,
      search: debounced,
      status: filter.status,
      surface: filter.surface,
      sinceTs: filter.since ? Math.floor(Date.now() / 1000) - SINCE_SECONDS[filter.since] : undefined,
    }),
    [sessionId, debounced, filter.status, filter.surface, filter.since],
  );

  // (Re)load the first page whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void queryRuns({ ...base, limit: 50 }).then((page) => {
      if (cancelled) return;
      setRows(page.rows);
      setFacets(page.facets);
      setCursor(page.next);
      setState("ready");
      const target = searchParams.get("run");
      setExpanded(target && page.rows.some((r) => r.runId === target) ? target : page.rows[0]?.runId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [base, searchParams]);

  const loadMore = useCallback(() => {
    if (!cursor || state !== "ready") return;
    setState("loadingMore");
    void queryRuns({ ...base, beforeTs: cursor.ts, beforeRowid: cursor.rowid, limit: 50 }).then((page) => {
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.next);
      setState("ready");
    });
  }, [cursor, state, base]);

  // Infinite scroll: load older pages as the sentinel scrolls into view.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const toggleLog = (hash: string) => {
    if (log?.hash === hash) return setLog(null);
    setLog({ hash, text: null });
    void readRunLog(hash).then((text) =>
      setLog((cur) => (cur?.hash === hash ? { hash, text: text ?? "(log unavailable)" } : cur)),
    );
  };

  const reproduce = (r: RunRecord) => {
    setComposerDraft(reproduceRunPrompt(r));
    navigate(r.sessionId ? `/live/${r.sessionId}` : "/live");
  };

  const copyCommand = (r: RunRecord) => {
    void copyText(r.command).then(() => {
      setCopied(r.runId);
      setTimeout(() => setCopied((c) => (c === r.runId ? null : c)), 1500);
    });
  };

  const toggle = (key: "status" | "surface", value: string) =>
    setFilter((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));

  const anyFilter = !!(filter.search || filter.status || filter.surface || filter.since);
  const chips: RunsFilterChip[] = [
    {
      key: "ok",
      label: "成功",
      count: count(facets.status, "ok"),
      active: filter.status === "ok",
      dot: "bg-ok",
      onClick: () => toggle("status", "ok"),
    },
    {
      key: "failed",
      label: "失败",
      count: count(facets.status, "failed"),
      active: filter.status === "failed",
      dot: "bg-error",
      onClick: () => toggle("status", "failed"),
    },
    ...facets.surface
      .filter((f) => f.value && f.value !== "local")
      .map((f) => ({
        key: f.value,
        label: f.value.toUpperCase(),
        count: f.count,
        active: filter.surface === f.value,
        accent: true,
        onClick: () => toggle("surface", f.value),
      })),
  ];
  const groups = useMemo(() => groupByDay(rows, (r) => r.ts), [rows]);

  return (
    <>
        {/* Filter bar */}
        {(rows.length > 0 || anyFilter) && (
          <RunsFilterBar
            search={filter.search}
            searchPlaceholder="搜索命令或输出路径…"
            onSearchChange={(value) => setFilter((f) => ({ ...f, search: value }))}
            chips={chips}
            since={filter.since}
            onSinceChange={(since) => setFilter((f) => ({ ...f, since }))}
            anyFilter={anyFilter}
            onClear={() => setFilter({ search: "" })}
          />
        )}

        {state === "loading" && <RunsSkeleton />}

        {state !== "loading" && rows.length === 0 && <RunsEmptyState filtered={anyFilter} />}

        {/* The ledger — borderless rows grouped under sticky day labels. */}
        <div className="mt-1">
          {groups.map(([label, items]) => (
            <DaySection key={label} label={label}>
              {items.map((r) => (
                <RunRow
                  key={r.runId}
                  run={r}
                  open={expanded === r.runId}
                  onToggle={() => setExpanded((e) => (e === r.runId ? null : r.runId))}
                  onReproduce={() => reproduce(r)}
                  onOpenConversation={r.sessionId ? () => navigate(`/live/${r.sessionId}`) : undefined}
                  onCopy={() => copyCommand(r)}
                  copied={copied === r.runId}
                  log={log}
                  onToggleLog={toggleLog}
                />
              ))}
            </DaySection>
          ))}
          <div ref={sentinel} />
          {state === "loadingMore" && (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> 正在加载更多…
            </div>
          )}
        </div>
    </>
  );
}

/**
 * The hosted runs ledger. The web API returns the full list in one shot — no
 * server-side paging or facets — so filtering, day-grouping and chip counts
 * are computed client-side while the filter bar, sticky day labels and row
 * expand style stay identical to the desktop ledger. Actions differ by form:
 * hosted downloads artifacts instead of opening them locally, and "复查与复现"
 * prefills the composer instead of the desktop's re-run recipe.
 */
function HostedRunsView() {
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null); // null = loading
  const [filter, setFilter] = useState<Filter>({ search: "" });
  const [debounced, setDebounced] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const navigate = useNavigate();
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

  useEffect(() => {
    let active = true;
    void listWebAgentRuns()
      .then((value) => {
        if (!active) return;
        setRuns(value);
        setExpanded(newestRun(value)?.id ?? null);
      })
      .catch((error) => {
        if (!active) return;
        setRuns([]);
        toast.error(`无法加载运行记录：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  // Debounce the search box so each keystroke doesn't refilter the ledger.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filter.search.trim()), 220);
    return () => clearTimeout(timer);
  }, [filter.search]);

  const rows = useMemo(() => {
    const query = debounced.toLowerCase();
    const sinceTs = filter.since ? Math.floor(Date.now() / 1000) - SINCE_SECONDS[filter.since] : undefined;
    return (runs ?? [])
      .filter(
        (run) =>
          (!filter.status || run.status === filter.status) &&
          (!sinceTs || webRunTs(run) >= sinceTs) &&
          (!query ||
            [run.id, run.sessionId, run.mode, run.agentId, run.model, ...run.artifacts]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query)),
      )
      .sort((a, b) => webRunTs(b) - webRunTs(a));
  }, [runs, debounced, filter.status, filter.since]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs ?? []) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    return counts;
  }, [runs]);

  const reproduce = (run: WebAgentRun) => {
    setComposerDraft(
      `复查科研运行 \`${run.id}\`（${run.mode === "specialist" ? run.agentId : "开放域科研"}）。` +
        `请读取该会话的原始消息、工具记录和产物，核对证据来源、失败项与可复现性；不要重新编造缺失数据。`,
    );
    navigate(`/live/${run.sessionId}`);
  };

  const toggle = (value: WebAgentRunStatus) =>
    setFilter((f) => ({ ...f, status: f.status === value ? undefined : value }));

  const anyFilter = !!(filter.search || filter.status || filter.since);
  const chips: RunsFilterChip[] = [
    {
      key: "succeeded",
      label: "成功",
      count: statusCounts.get("succeeded") ?? 0,
      active: filter.status === "succeeded",
      dot: "bg-ok",
      onClick: () => toggle("succeeded"),
    },
    {
      key: "failed",
      label: "失败",
      count: statusCounts.get("failed") ?? 0,
      active: filter.status === "failed",
      dot: "bg-error",
      onClick: () => toggle("failed"),
    },
    ...(["running", "canceled"] as const)
      .filter((s) => statusCounts.has(s))
      .map((s) => ({
        key: s,
        label: WEB_RUN_STATUS_LABEL[s],
        count: statusCounts.get(s) ?? 0,
        active: filter.status === s,
        dot: s === "running" ? "bg-accent" : "bg-muted",
        onClick: () => toggle(s),
      })),
  ];
  const groups = useMemo(() => groupByDay(rows, webRunTs), [rows]);

  // Keep the expanded row visible: when a filter change drops it from the
  // list, fall back to the newest row (the desktop ledger does the same on
  // every refetch).
  useEffect(() => {
    setExpanded((cur) => (cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)));
  }, [rows]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <RunsHeader description="记录开放域与专项科研任务的执行状态、模型、耗时和成果文件。" />

        {(rows.length > 0 || anyFilter) && (
          <RunsFilterBar
            search={filter.search}
            searchPlaceholder="搜索专项、模型、会话或产物文件…"
            onSearchChange={(value) => setFilter((f) => ({ ...f, search: value }))}
            chips={chips}
            since={filter.since}
            onSinceChange={(since) => setFilter((f) => ({ ...f, since }))}
            anyFilter={anyFilter}
            onClear={() => setFilter({ search: "" })}
          />
        )}

        {runs === null && <RunsSkeleton />}

        {runs !== null && rows.length === 0 && <RunsEmptyState filtered={anyFilter} />}

        <div className="mt-1">
          {groups.map(([label, items]) => (
            <DaySection key={label} label={label}>
              {items.map((run) => (
                <WebRunRow
                  key={run.id}
                  run={run}
                  open={expanded === run.id}
                  onToggle={() => setExpanded((e) => (e === run.id ? null : run.id))}
                  onReproduce={() => reproduce(run)}
                  onOpenConversation={() => navigate(`/live/${run.sessionId}`)}
                />
              ))}
            </DaySection>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Per-session Runs pane (session header toggle) — this session's runs only,
 *  beside the chat, like the session's Files pane. */
export function RunsPane({
  sessionId,
  onClose,
  controls,
}: {
  sessionId: string;
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <FlaskConical size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <span className="text-sm font-medium text-text">运行记录</span>
        <span className="text-xs text-muted">本会话</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label="关闭运行面板" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <RunsView sessionId={sessionId} />
      </div>
    </div>
  );
}

function RunRow({
  run: r,
  open,
  onToggle,
  onReproduce,
  onOpenConversation,
  onCopy,
  copied,
  log,
  onToggleLog,
}: {
  run: RunRecord;
  open: boolean;
  onToggle: () => void;
  onReproduce: () => void;
  onOpenConversation?: () => void;
  onCopy: () => void;
  copied: boolean;
  log: { hash: string; text: string | null } | null;
  onToggleLog: (hash: string) => void;
}) {
  const failed = r.status === "failed";
  const remote = r.surface && r.surface !== "local";
  return (
    <li>
      <button
        className="group flex w-full items-center gap-2.5 rounded-input px-2 py-1.5 text-left hover:bg-surface-2/60"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted opacity-40 group-hover:opacity-100" />
        )}
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", failed ? "bg-error" : "bg-ok")}
          title={failed ? "失败" : "成功"}
        />
        <span className={cn("min-w-0 flex-1 truncate font-mono text-ui", failed ? "text-text/70" : "text-text")}>
          {r.command}
        </span>
        {remote && (
          <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-accent">{r.surface}</span>
        )}
        {r.wallMs != null && <span className="shrink-0 tabular-nums text-xs text-muted">{formatDuration(r.wallMs)}</span>}
        <span className="w-16 shrink-0 text-right text-xs text-muted" title={absoluteTs(r.ts)}>
          {relativeTs(r.ts)}
        </span>
      </button>

      {open && (
        <div className="ml-6 mb-1 space-y-3 border-l border-border-faint pl-4 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            {r.env && (
              <Chip>
                {[r.env.python && `py ${r.env.python}`, r.env.platform, r.env.app && `app ${r.env.app}`]
                  .filter(Boolean)
                  .join(" · ")}
              </Chip>
            )}
            {r.env?.hardware && (
              <Chip icon={<Cpu size={11} />} title="本次运行所使用的硬件">
                {hardwareLabel(r.env.hardware)}
              </Chip>
            )}
            {r.env?.packages && <Chip icon={<Package size={11} />}>{r.env.packages.count} 个软件包</Chip>}
            {r.remoteHardware && (
              <Chip icon={<Cpu size={11} />} title="本次运行所使用的远程硬件">
                {r.remoteHardware}
              </Chip>
            )}
            {r.host && (
              <Chip title="集群主机或 Modal 应用">
                {r.host}
                {r.jobId && ` · 任务 ${r.jobId}`}
              </Chip>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Action icon={<RotateCcw size={12} />} onClick={onReproduce} title="起草提示，重新运行此命令并比较输出">
              复现
            </Action>
            {r.logHash && (
              <Action icon={<ScrollText size={12} />} onClick={() => onToggleLog(r.logHash!)} active={log?.hash === r.logHash} title="查看捕获的 stdout/stderr">
                日志
              </Action>
            )}
            {onOpenConversation && (
              <Action icon={<MessageSquare size={12} />} onClick={onOpenConversation} title="打开产生此次运行的对话">
                打开对话
              </Action>
            )}
            <Action icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={onCopy} title="复制命令">
              {copied ? "已复制" : "复制命令"}
            </Action>
          </div>

          {r.code && r.code.length > 0 && <FileGroup icon={<FileCode2 size={12} />} label="代码" files={r.code} />}
          {r.outputs && r.outputs.length > 0 && (
            <FileGroup icon={<FileOutput size={12} />} label="输出" files={r.outputs} openable />
          )}
          {!r.outputs?.length && remote && (
            <p className="text-muted">
              在 {r.surface === "hpc" ? "HPC 集群" : r.surface} 上运行；输出保存在该环境，未在本地捕获。
            </p>
          )}

          {r.logHash && log?.hash === r.logHash && (
            <div className="overflow-hidden rounded-input border border-border bg-surface-2">
              <div className="border-b border-border px-2.5 py-1 text-caption text-muted">stdout / stderr</div>
              {log.text === null ? (
                <div className="flex items-center gap-2 px-2.5 py-2 text-muted">
                  <Loader2 size={12} className="animate-spin" /> 正在加载…
                </div>
              ) : (
                <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-caption leading-relaxed text-text">
                  {log.text}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** A hosted ledger row — same visual language as the desktop `RunRow`, but the
 *  main text is the run id, the tag names the specialist/open-domain agent,
 *  and artifacts download through the web API. */
function WebRunRow({
  run,
  open,
  onToggle,
  onReproduce,
  onOpenConversation,
}: {
  run: WebAgentRun;
  open: boolean;
  onToggle: () => void;
  onReproduce: () => void;
  onOpenConversation: () => void;
}) {
  const failed = run.status === "failed";
  const ts = webRunTs(run);
  return (
    <li>
      <button
        className="group flex w-full items-center gap-2.5 rounded-input px-2 py-1.5 text-left hover:bg-surface-2/60"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted opacity-40 group-hover:opacity-100" />
        )}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            failed ? "bg-error" : run.status === "succeeded" ? "bg-ok" : "bg-muted",
          )}
          title={WEB_RUN_STATUS_LABEL[run.status]}
        />
        <span className={cn("min-w-0 flex-1 truncate font-mono text-ui", failed ? "text-text/70" : "text-text")}>
          {run.id}
        </span>
        <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-accent">
          {run.mode === "specialist" ? run.agentId : "开放域科研"}
        </span>
        {run.durationMs != null && (
          <span className="shrink-0 tabular-nums text-xs text-muted">{formatDuration(run.durationMs)}</span>
        )}
        <span className="w-16 shrink-0 text-right text-xs text-muted" title={absoluteTs(ts)}>
          {relativeTs(ts)}
        </span>
      </button>

      {open && (
        <div className="ml-6 mb-1 space-y-3 border-l border-border-faint pl-4 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip title="模型">{run.model}</Chip>
            {run.mode === "specialist" && run.agentId && <Chip title="专项科研 Agent">{run.agentId}</Chip>}
            <Chip title="会话">{run.sessionId}</Chip>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Action icon={<RotateCcw size={12} />} onClick={onReproduce} title="起草提示，复查该运行的证据与产物并尝试复现">
              复查与复现
            </Action>
            <Action icon={<MessageSquare size={12} />} onClick={onOpenConversation} title="打开产生此次运行的对话">
              打开对话
            </Action>
            {run.durationMs != null && <span className="text-muted">耗时 {formatDuration(run.durationMs)}</span>}
            {run.errorCode && <span className="text-error">{run.errorCode}</span>}
          </div>

          {run.artifacts.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-caption font-medium uppercase tracking-wider text-muted">
                <FileOutput size={12} /> 产物
              </div>
              <ul className="space-y-0.5">
                {run.artifacts.map((path) => (
                  <li key={path}>
                    <button
                      onClick={() => void downloadArtifact(path, "workspace")}
                      title="下载此产物文件"
                      className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-text group-hover:text-link">{path}</span>
                      <ExternalLink size={11} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FacetChip({
  label,
  count,
  active,
  onClick,
  dot,
  accent,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: string;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors",
        active
          ? accent
            ? "border-accent bg-accent/10 text-accent"
            : "border-border bg-surface-2 text-text"
          : "border-border bg-surface text-muted hover:text-text",
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />}
      <span className="font-medium">{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function Chip({ children, icon, title }: { children: React.ReactNode; icon?: React.ReactNode; title?: string }) {
  return (
    <span className="flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-muted" title={title}>
      {icon}
      {children}
    </span>
  );
}

function Action({
  children,
  icon,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button className={cn("flex items-center gap-1 hover:underline", active ? "text-text" : "text-link")} onClick={onClick} aria-pressed={active} title={title}>
      {icon}
      {children}
    </button>
  );
}

function FileGroup({ icon, label, files, openable }: { icon: React.ReactNode; label: string; files: RunArtifact[]; openable?: boolean }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-caption font-medium uppercase tracking-wider text-muted">
        {icon} {label}
      </div>
      <ul className="space-y-0.5">
        {files.map((f) =>
          openable ? (
            <li key={f.path}>
              <button
                onClick={() => void (hasWebApi && !isTauri
                  ? downloadArtifact(f.path, "workspace")
                  : openArtifactExternally(f.path, "workspace"))}
                title="打开此输出文件"
                className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-text group-hover:text-link">{f.path}</span>
                <ExternalLink size={11} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
                <span className="shrink-0 tabular-nums text-muted">{humanSize(f.size)}</span>
              </button>
            </li>
          ) : (
            <li key={f.path} className="flex items-center gap-2 px-1">
              <span className="min-w-0 flex-1 truncate font-mono text-text">{f.path}</span>
              <span className="shrink-0 tabular-nums text-muted">{humanSize(f.size)}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function count(facets: RunFacet[], value: string): number {
  return facets.find((f) => f.value === value)?.count ?? 0;
}

function hardwareLabel(hw: NonNullable<RunRecord["env"]>["hardware"]): string {
  if (!hw) return "";
  if (hw.gpu && hw.gpu.length > 0) return hw.gpu.join(", ");
  return [hw.cpu, hw.accelerator].filter(Boolean).join(" · ");
}

/** Epoch seconds of a hosted run's start (0 when the timestamp is missing). */
function webRunTs(run: WebAgentRun): number {
  const ms = Date.parse(run.startedAt);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function newestRun(runs: WebAgentRun[]): WebAgentRun | undefined {
  return [...runs].sort((a, b) => webRunTs(b) - webRunTs(a))[0];
}

/** Group newest-first rows under contiguous day labels. Input must already be
 *  sorted newest first (both backends deliver it that way). */
function groupByDay<T>(items: T[], ts: (item: T) => number): [string, T[]][] {
  const groups: [string, T[]][] = [];
  let current: [string, T[]] | null = null;
  for (const item of items) {
    const label = dayLabel(ts(item));
    if (!current || current[0] !== label) {
      current = [label, []];
      groups.push(current);
    }
    current[1].push(item);
  }
  return groups;
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return d.toLocaleDateString("zh-CN", { weekday: "long" });
  return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function relativeTs(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} 小时前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function absoluteTs(ts: number): string {
  return formatDateTime(ts * 1000, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
