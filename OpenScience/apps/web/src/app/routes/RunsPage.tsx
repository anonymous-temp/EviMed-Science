import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FileOutput,
  FlaskConical,
  Loader2,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import { downloadArtifact } from "@/lib/artifactFile";
import { extOf, extToKind } from "@/lib/artifacts";
import {
  getWebProjectId,
  listWebAgentRuns,
  reportWebDeliverableFeedback,
  webErrorMessage,
  type WebAgentRun,
  type WebAgentRunStatus,
  type WebRunPlanItem,
} from "@/lib/apiClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { formatDateTime } from "@/lib/format";
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import {
  runDidNotDeliver,
  runTitle,
  summarizeQualityNotices,
  undeliveredFiles,
  webRunOutcome,
  WEB_RUN_STATUS_LABEL,
} from "@/lib/runPresentation";
import { capabilityTitle } from "@/lib/researchAgentUi";
import { cn } from "@/lib/cn";
import { PageTitle } from "@/components/layout/PageTitle";

type SincePreset = "24h" | "7d" | "30d";

const SINCE_SECONDS: Record<SincePreset, number> = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

interface Filter {
  search: string;
  status?: string;
  surface?: string;
  since?: SincePreset;
}

/**
 * The nine-phase projection (§7.1.1), for the row that is already open.
 *
 * Not a second status: `status` is the ledger's own four-value field and stays
 * what the badge, the filters and every gate script read. The phase is a
 * strictly richer read of the same record — it separates a run still waiting
 * for its container from one that is working, and a clean delivery from one
 * that needs a person to look at it — and it was already on the wire and used
 * for exactly one filter chip while the row itself never mentioned it.
 */
const WEB_RUN_PHASE_LABEL: Record<string, string> = {
  reserved: "已排队，尚未派发",
  dispatched: "已派发，尚无进展",
  running: "进行中",
  delivering: "交付核对中",
  repairing: "按门禁意见修复中",
  accepted: "已交付并通过核验",
  degraded: "已交付，待人工复核",
  failed: "未完成",
  canceled: "已取消",
};

/** Global Runs view (sidebar) — all runs across every session, like the global
 *  Files browser and Notebooks page. Same information architecture on both
 *  surfaces; only the data source and row actions differ. */
/**
 * The run ledger.
 *
 * There used to be two of these — one reading a local SQLite index the desktop
 * shell wrote, one reading the control plane. The local one went with the
 * shell; what is left is the ledger the gate actually writes to.
 */
export function RunsPage() {
  return <HostedRunsView />;
}

/** The page header shared by both runs surfaces. */
function RunsHeader({ description }: { description: ReactNode }) {
  return (
    <header className="mb-4 flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-input bg-accent/10 text-accent">
        <FlaskConical size={17} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <PageTitle page="运行记录" />
        <h1 className="font-serif text-display leading-tight text-text">运行记录</h1>
        <p className="mt-0.5 text-ui text-muted">{description}</p>
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
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full rounded-input border border-border bg-surface py-1.5 pl-8 pr-3 text-ui text-text outline-none placeholder:text-muted focus:border-accent"
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
      <div className="flex shrink-0 items-center rounded-full border border-border bg-surface p-0.5 text-caption">
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
        <button className="text-caption text-link hover:underline" onClick={onClear}>
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
/** The memory kinds, in the researcher's words. Values are never shown here —
 *  a memory's content lives in one place, where deleting it deletes it. */
const MEMORY_KIND_LABELS: Record<string, string> = {
  profile: "画像",
  preference: "偏好",
  behavior: "工作习惯",
  correction: "你做过的纠正",
  project_fact: "项目事实",
  analysis: "分析口径",
  decision: "已定的决策",
  follow_up: "待跟进",
  run_summary: "过往运行摘要",
  note: "科研记忆",
};

/** Statuses a run is still in. Drives the refresh above; a finished ledger is
 *  not re-read. */
const ACTIVE_RUN_STATUSES: ReadonlySet<WebAgentRunStatus> = new Set([
  "queued",
  "dispatching",
  "running",
  "canceling",
] as WebAgentRunStatus[]);
const RUNS_POLL_MS = 20_000;

/** A read that failed, said as a read that failed. */
function RunsLoadError({ message, onRetry, stale }: { message: string; onRetry: () => void; stale: boolean }) {
  return (
    <div role="alert" className="mt-3 rounded-card border border-border bg-surface px-4 py-3">
      <p className="text-ui text-text">{stale ? "刷新运行记录失败，下面显示的是上一次读到的内容。" : "无法读取运行记录。"}</p>
      <p className="mt-1 text-ui-sm text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 min-h-6 rounded-input border border-border px-3 py-1 text-ui-sm text-text hover:bg-surface-2"
      >
        重试
      </button>
    </div>
  );
}

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
          当 EviMed 运行代码时（例如 <span className="font-mono text-text">python train.py</span>
          ），执行方案和产物会记录于此。
        </>
      }
      className="mt-8 rounded-input border border-dashed border-border bg-surface"
    />
  );
}

/**
 * The hosted runs ledger. The web API returns the full list in one shot — no
 * server-side paging or facets — so filtering, day-grouping and chip counts
 * are computed client-side while the filter bar, sticky day labels and row
 * expand style stay identical to the desktop ledger. Actions differ by form:
 * hosted downloads artifacts instead of opening them locally, and "复查与复现"
 * drafts into the runtime session surface instead of the desktop's re-run
 * recipe.
 */
function HostedRunsView() {
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null); // null = loading
  // A deliverable opened in place: a report, its matrix, a table — with the
  // same viewers the files page uses, instead of download-only rows.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ search: "" });
  const [debounced, setDebounced] = useState("");
  // `?run=` is how every link into this page names the run it means — the
  // sidebar's recent list, and anything else that wants to point at one.
  // Without it a link can only land on "the newest run", which is a different
  // run by the time someone opens it.
  const [params] = useSearchParams();
  const deepLinked = params.get("run");
  const [expanded, setExpanded] = useState<string | null>(deepLinked);
  const navigate = useNavigate();

  // The ledger is a trust surface, so a failed read says so.
  //
  // It used to set `runs = []` and show 「尚无运行记录」 (2026-09-16 walk, U3):
  // a control plane that could not be reached and an account that has never
  // run anything rendered the same page, and the second reading is the one
  // people believe. The error is kept in its own state so the rows already on
  // screen survive a failed refresh — a poll that misses must not empty a page
  // that is correct.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const value = await listWebAgentRuns();
      setRuns(value);
      setExpanded((current) => current ?? newestRun(value)?.id ?? null);
      setLoadError(null);
      return true;
    } catch (error) {
      setLoadError(webErrorMessage(error, { fallback: "无法读取运行记录，请检查网络后重试。" }));
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While something is running the page refreshes itself. It used to fetch once
  // and never again, so 「最近进展 X 分钟前」 froze at whatever it said when the
  // page opened while the sidebar beside it polled every 20 s and disagreed.
  // Gated on visibility: a background tab polling a ledger is spend with nobody
  // reading it.
  const hasActiveRun = (runs ?? []).some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  useEffect(() => {
    if (!hasActiveRun) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await load();
      if (!stopped) timer = setTimeout(() => void tick(), RUNS_POLL_MS);
    };
    timer = setTimeout(() => void tick(), RUNS_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hasActiveRun, load]);

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
          // "degraded" is not a status value — it is the phase projection
          // (§7.1.1), so this one filter key reads a different field than the
          // rest without needing a second filter dimension for it.
          (!filter.status || (filter.status === "degraded" ? run.phase === "degraded" : run.status === filter.status)) &&
          (!sinceTs || webRunTs(run) >= sinceTs) &&
          (!query ||
            [run.question, run.id, run.sessionId, run.mode, run.agentId, run.effectiveAgentId, run.model, ...run.artifacts]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query)),
      )
      .sort((a, b) => webRunTs(b) - webRunTs(a));
  }, [runs, debounced, filter.status, filter.since]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs ?? []) {
      counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
      if (run.phase === "degraded") counts.set("degraded", (counts.get("degraded") ?? 0) + 1);
    }
    return counts;
  }, [runs]);

  /**
   * "复查与复现" — drafted into the session surface that actually reads it.
   *
   * This used to write a store field only our own, never-routed composer read
   * (deleted 2026-09-09 with the rest of that surface), so the draft went
   * nowhere and the researcher landed on an empty runtime chat: a button whose
   * tooltip promised a drafted prompt and which silently did nothing. The
   * channel that works is `runtimeUiIntent` in the navigation state, forwarded
   * by RuntimeUiFrame and applied by the harness bridge's `setDraft`.
   */
  const reproduce = (run: WebAgentRun) => {
    const activeAgent = run.effectiveAgentId ?? run.agentId;
    const draft =
      `复查科研运行 \`${run.id}\`（${activeAgent ? `${run.mode === "open-domain" ? "开放域路由 · " : ""}${activeAgent}` : "开放域科研"}）。` +
      `请读取该会话的原始消息、工具记录和产物，核对证据来源、失败项与可复现性；不要重新编造缺失数据。`;
    // `runtimeUiIntentFromState` drops an intent whose session id is not a
    // plain identifier, and a dropped intent is indistinguishable from the bug
    // being fixed here. When the ledger's session id cannot be addressed,
    // open a fresh session carrying the same draft rather than lose it.
    const addressable = /^[A-Za-z0-9_-]{1,160}$/.test(run.sessionId);
    const intent: RuntimeUiIntent = {
      kind: addressable ? "open" : "create",
      projectId: getWebProjectId(),
      requestId: crypto.randomUUID(),
      sessionId: addressable ? run.sessionId : crypto.randomUUID(),
      draft,
    };
    navigate(addressable ? `/app/chat/${run.sessionId}` : "/app/chat", { state: { runtimeUiIntent: intent } });
  };

  const toggle = (value: WebAgentRunStatus | "degraded") =>
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
    // Delivered, but with something unresolved — unverified content, or a
    // partial delivery — that a person should look at before it is trusted the
    // way an accepted run is. Shown only once at least one run actually needs
    // it, the same rule "running"/"canceled" below already follow.
    ...(statusCounts.get("degraded") ? [{
      key: "degraded",
      label: "待人工复核",
      count: statusCounts.get("degraded") ?? 0,
      active: filter.status === "degraded",
      dot: "bg-warn",
      onClick: () => toggle("degraded"),
    }] : []),
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

  // A new `?run=` on an already-mounted page (clicking a second sidebar row)
  // must move the expansion, not be ignored because the first one won.
  useEffect(() => {
    if (deepLinked) setExpanded(deepLinked);
  }, [deepLinked]);

  return (
    <FilePreviewContext.Provider value={setPreviewPath}>
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

          {runs === null && loadError === null && <RunsSkeleton />}

          {loadError !== null && <RunsLoadError message={loadError} onRetry={() => void load()} stale={(runs?.length ?? 0) > 0} />}

          {runs !== null && loadError === null && rows.length === 0 && <RunsEmptyState filtered={anyFilter} />}

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
                    onOpenConversation={() => navigate(`/app/chat/${run.sessionId}`)}
                  />
                ))}
              </DaySection>
            ))}
          </div>
        </div>
      </div>
      {previewPath && <RunFilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
    </FilePreviewContext.Provider>
  );
}

/**
 * What produced this run, in the product's words.
 *
 * The tag used to be the raw capability id rendered `uppercase`, so the ledger
 * read `开放域 · CLINICAL-EVIDENCE-SYNTHESIS` — a Chinese connective joined to
 * a shouted English identifier. The catalog's own Chinese title is available
 * from the id without a fetch; an id this build has no name for falls back to
 * the id rather than to silence, because an unnamed capability is worth seeing.
 */
function capabilityLabel(run: WebAgentRun): string {
  const agent = run.effectiveAgentId ?? run.agentId;
  if (!agent) return run.mode === "specialist" ? "专项科研" : "开放域科研";
  const name = capabilityTitle(agent) ?? agent;
  return run.mode === "open-domain" ? `开放域 · ${name}` : name;
}

/** A hosted ledger row — same visual language as the desktop `RunRow`, but the
 *  main text is the run's brief, the tag names the capability in the product's
 *  words, and artifacts download through the web API. */
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
  const notices = summarizeQualityNotices(run.qualityNotices ?? []);
  const hasArtifacts = run.artifacts.length > 0;
  // `null` when the ledger does not carry the field at all — which is not the
  // same as "there are none", so the row stays silent rather than claiming the
  // run produced nothing.
  const undelivered = undeliveredFiles(run);
  return (
    <li>
      <button
        className="group flex w-full items-center gap-2.5 rounded-input px-2 py-1.5 text-left hover:bg-surface-2/60"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted opacity-40 group-hover:opacity-100" aria-hidden="true" />
        )}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            failed ? "bg-error" : run.status === "succeeded" ? "bg-ok" : "bg-muted",
          )}
          title={WEB_RUN_STATUS_LABEL[run.status]}
        />
        {/* The question, when the run recorded one. The list was keyed on the
          * run id alone, so thirty analyses read as thirty hashes and telling
          * them apart meant opening each one. When no brief was recorded
          * `runTitle` says so; the id stays in the tooltip and in the
          * diagnostics row, where it is labelled. */}
        <span
          className={cn("min-w-0 flex-1 truncate text-ui", failed ? "text-text/70" : "text-text")}
          title={run.question ? `${run.question}\n${run.id}` : run.id}
        >
          {runTitle(run)}
        </span>
        <span className="shrink-0 text-caption font-semibold tracking-wide text-accent">
          {capabilityLabel(run)}
        </span>
        {run.durationMs != null && (
          <span className="shrink-0 tabular-nums text-caption text-muted">{formatDuration(run.durationMs)}</span>
        )}
        <span className="w-16 shrink-0 text-right text-caption text-muted" title={absoluteTs(ts)}>
          {relativeTs(ts)}
        </span>
      </button>

      {open && (
        <div className="ml-6 mb-1 space-y-3 border-l border-border-faint pl-4 pt-1 text-caption">
          <div className="flex flex-wrap items-center gap-1.5">
            {capabilityLabel(run) && <Chip title="所用能力">{capabilityLabel(run)}</Chip>}
            {run.phase && WEB_RUN_PHASE_LABEL[run.phase] && (
              <Chip title={`运行阶段（由账本记录派生，不单独存储）：${run.phase}`}>
                {WEB_RUN_PHASE_LABEL[run.phase]}
              </Chip>
            )}
          </div>

          {/* Identifiers, folded.
            *
            * These four — the run id, the kernel's session id, the model id and
            * the raw capability id — were four chips on the open row, so the
            * first thing a researcher read about their own work was
            * `ses_0722bc34fffeRehfLDGbxJn4I3` (§23.2 rule 11 forbids exactly
            * this). They are still here, because support asks for them and
            * because a reader who wants to know which model answered is
            * entitled to; they are behind one disclosure and labelled. */}
          <details className="text-caption">
            <summary className="cursor-pointer text-muted hover:text-text">技术标识（供排查使用）</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-caption text-muted">
              <dt className="font-sans">运行</dt><dd className="truncate">{run.id}</dd>
              <dt className="font-sans">会话</dt><dd className="truncate">{run.sessionId}</dd>
              <dt className="font-sans">模型</dt><dd className="truncate">{run.model}</dd>
              {(run.effectiveAgentId ?? run.agentId) && (
                <><dt className="font-sans">能力</dt><dd className="truncate">{run.effectiveAgentId ?? run.agentId}</dd></>
              )}
            </dl>
          </details>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Action icon={<RotateCcw size={12} aria-hidden="true" />} onClick={onReproduce} title="起草提示，复查该运行的证据与产物并尝试复现">
              复查与复现
            </Action>
            <Action icon={<MessageSquare size={12} aria-hidden="true" />} onClick={onOpenConversation} title="打开产生此次运行的对话">
              打开对话
            </Action>
            {run.durationMs != null && <span className="text-muted">耗时 {formatDuration(run.durationMs)}</span>}
            {run.status === "running" && run.observedToolCalls != null && run.observedToolCalls > 0 && (
              // These analyses run for tens of minutes. Showing only "执行中"
              // for that long is indistinguishable from being stuck.
              <span className="text-muted">
                已完成 {run.observedToolCalls} 次检索与工具调用
                {run.lastProgressAt && ` · 最近进展 ${relativeTs(Date.parse(run.lastProgressAt) / 1000)}`}
              </span>
            )}
          </div>

          {run.status === "running" && run.planItems && run.planItems.length > 0 && <PlanSteps items={run.planItems} />}

          {/* What happened, said once, from the one dictionary.
            * This row used to hold a 20-key table whose default sentence was
            * "运行未通过核验。" — so a run killed by the stall detector, a run
            * the researcher cancelled and a run superseded by their own next
            * message were each told their science had failed quality control.
            * The code stays reachable as a tooltip for support, never as the
            * message. */}
          {runDidNotDeliver(run) && <RunVerdict run={run} />}

          {/* The verdict and its reasons were computed, stored, and returned by
            * the API, and then rendered nowhere: a package delivered with seven
            * named gaps looked exactly like a clean one. */}
          {(run.verification != null || notices.total > 0) && (
            <div className="rounded-card border border-border-faint bg-surface-2/40 p-2">
              <div className="mb-1 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wider text-muted">
                <ScrollText size={12} aria-hidden="true" />
                {run.verification === "unverified" && "已交付，但未完成核验"}
                {/* Not the same statement, and it used to render as the absence
                  * of any statement: a layer of the gate did not run here, so
                  * nothing below says that layer found the package sound. */}
                {run.verification === "unchecked" && "已交付，但有一层没有检查过"}
                {run.verification == null && "核验提示"}
                {notices.total > 0 && (
                  <span className="normal-case tracking-normal">
                    · 必须修正 {notices.mustFix} 项 · 建议修正 {notices.advisory} 项
                  </span>
                )}
              </div>
              {/* The clause about files is conditional: the unverified path can
                * finish with no files at all (an open-domain answer has none by
                * design), and this paragraph used to promise downloadable
                * artifacts directly above an empty artifact list. */}
              {run.verification === "unverified" && (
                <p className="mb-1.5 text-caption text-text/80">
                  {hasArtifacts
                    ? "产物可以照常下载和阅读；以下各点是本次分析未能自证的部分，请在引用前自行核对。"
                    : "本次没有文件产出；以下各点是本次分析未能自证的部分，请在引用前自行核对。"}
                </p>
              )}
              {run.verification === "unchecked" && (
                <p className="mb-1.5 text-caption text-text/80">
                  {hasArtifacts ? "产物可以照常下载和阅读；" : ""}
                  本次交付有一层核验根本没有执行，以下说明是哪一层、为什么没执行。 没有发现问题不等于检查过。
                </p>
              )}
              <ul className="space-y-2">
                {notices.groups.map((group) => (
                  <li key={`${group.mustFix}-${group.label}`}>
                    <div className="flex items-center gap-1.5 text-caption">
                      {group.mustFix && (
                        <span className="shrink-0 rounded bg-error/10 px-1 py-px text-caption font-medium text-error">
                          必须修正
                        </span>
                      )}
                      <span className="font-medium text-text">{group.label}</span>
                      <span className="tabular-nums text-muted">{group.items.length}</span>
                    </div>
                    <ul className="mt-0.5 space-y-0.5">
                      {group.items.map((item, index) => (
                        <li key={index} className="flex gap-1.5 leading-relaxed text-text/70">
                          <span className="shrink-0 text-muted">·</span>
                          <span className="min-w-0 break-words">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* What the platform knew about this researcher and used here. The
            * count is the point — an answer that silently drew on a stored
            * preference and an answer that did not must not look the same. */}
          {(run.recalledMemories?.length ?? 0) > 0 && (
            <details>
              <summary className="cursor-pointer select-none text-caption font-medium uppercase tracking-wider text-muted hover:text-text">
                个性化依据 {run.recalledMemories?.length} 条
              </summary>
              <div className="mt-1 space-y-0.5 text-caption text-muted">
                <p>这次运行读取了你的这些长期记忆。内容在「记忆」里，可以随时修改或删除。</p>
                <ul className="space-y-0.5">
                  {run.recalledMemories?.map((memory) => (
                    <li key={memory.id}>
                      <Link to="/app/memory" className="hover:text-link">
                        {MEMORY_KIND_LABELS[memory.kind] ?? memory.kind}
                        {memory.scope === "project" ? "（本项目）" : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          {hasArtifacts && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-caption font-medium uppercase tracking-wider text-muted">
                <FileOutput size={12} aria-hidden="true" /> 产物
              </div>
              <ul className="space-y-0.5">
                {run.artifacts.map((path) => (
                  <li key={path}>
                    <ArtifactRow path={path} />
                    <DeliverableFeedback runId={run.id} path={path} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The files a refused run wrote and the gate did not accept.
            * Twenty-eight of 179 finished runs on the host ended with an empty
            * artifact list while a complete nine-file package sat on disk —
            * p90 58 minutes of work, and the ledger named none of it. Nothing
            * deleted those files; they were unreachable, so this section hands
            * them back and says plainly what they are. */}
          {!hasArtifacts && undelivered && undelivered.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-caption font-medium uppercase tracking-wider text-warn">
                <FileOutput size={12} aria-hidden="true" /> 未通过核验的文件（{undelivered.length}）
              </div>
              <p className="mb-1 text-text/70">
                本次运行写出了这些文件，但它们没有通过质量门，因此没有作为成果发布。文件没有被删除，可以下载后自行判断；引用前请逐条核对。
              </p>
              <ul className="space-y-0.5">
                {undelivered.map((path) => (
                  <li key={path}>
                    <ArtifactRow path={path} unverified />
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

/** What happened to this run — one sentence from the one dictionary, plus
 *  whatever the ledger's own counters can add to it. */
function RunVerdict({ run }: { run: WebAgentRun }) {
  const outcome = webRunOutcome(run);
  return (
    <div className="space-y-0.5">
      <p className="text-error" title={outcome.code ? `错误码：${outcome.code}` : undefined}>
        {outcome.headline}
      </p>
      {outcome.detail && <p className="text-text/70">{outcome.detail}</p>}
    </div>
  );
}

/**
 * Did this file turn out to be useful, and did it need editing?
 *
 * This is the learning loop's first producer. `POST /api/feedback/events` has
 * existed since the loop was built and `reportWebDeliverableFeedback` has
 * existed in the client, but nothing on any page called either: on 2026-09-16
 * production held 92 feedback events, every one of them a memory inference
 * being accepted, and zero `deliverable-adopted` or `deliverable-edited`. Zero
 * distillation jobs had ever been queued, so the method library was empty not
 * because nothing was worth learning but because nobody could say so.
 *
 * 「我改过」 takes a sentence, because that sentence is the whole signal: what a
 * researcher changed is what the distilled method has to learn, and "edited"
 * with no reason distils to nothing.
 *
 * Reporting twice is possible — the ledger is not read back here, so the
 * buttons reset on reload. The server owns deduplication; this surface does not
 * pretend to.
 */
function DeliverableFeedback({ runId, path }: { runId: string; path: string }) {
  const [state, setState] = useState<"idle" | "editing" | "sending" | "adopted" | "edited">("idle");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const send = async (trigger: "deliverable-adopted" | "deliverable-edited", summary?: string) => {
    setState("sending");
    setFailure(null);
    try {
      await reportWebDeliverableFeedback({ trigger, runId, path, summary });
      setState(trigger === "deliverable-adopted" ? "adopted" : "edited");
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "反馈没有记录下来，请稍后重试。" }));
      setState("idle");
    }
  };

  if (state === "adopted" || state === "edited") {
    return (
      <p className="px-1 pb-1 text-caption text-muted">
        {state === "adopted" ? "已记录：这份成果被采纳。" : "已记录：这份成果做过修改。"}
      </p>
    );
  }

  return (
    <div className="px-1 pb-1">
      {state === "editing" ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`edited-${runId}-${path}`}>改了什么</label>
          <input
            id={`edited-${runId}-${path}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="改了什么？一句话即可"
            className="min-h-6 min-w-0 flex-1 rounded-input border border-border bg-surface px-2 py-1 text-ui-sm text-text"
          />
          <button
            type="button"
            disabled={note.trim().length === 0}
            onClick={() => void send("deliverable-edited", note.trim())}
            className="min-h-6 rounded-input border border-border px-2 py-1 text-ui-sm text-text hover:bg-surface-2 disabled:opacity-50"
          >
            提交
          </button>
          <button
            type="button"
            onClick={() => { setState("idle"); setNote(""); }}
            className="min-h-6 rounded-input px-2 py-1 text-ui-sm text-muted hover:bg-surface-2"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={state === "sending"}
            onClick={() => void send("deliverable-adopted")}
            className="min-h-6 rounded-input border border-border px-2 py-1 text-ui-sm text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            采纳
          </button>
          <button
            type="button"
            disabled={state === "sending"}
            onClick={() => setState("editing")}
            className="min-h-6 rounded-input border border-border px-2 py-1 text-ui-sm text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            我改过
          </button>
        </div>
      )}
      {failure && <p role="alert" className="mt-1 text-caption text-error">{failure}</p>}
    </div>
  );
}

/** One downloadable file. `unverified` marks a file the gate did not accept;
 *  the marker carries the same weight as the path, because a reader must not
 *  be able to take one of these for graded work. */
const FilePreviewInspector = lazy(() => import("@/components/inspector/FilePreviewInspector").then((m) => ({ default: m.FilePreviewInspector })));

/** Opens a run's file in place; absent outside the runs page. */
const FilePreviewContext = createContext<((path: string) => void) | null>(null);

/**
 * A deliverable previewed beside the ledger (2026-09-16 review, P2 #14: a
 * run's output was a list of paths to download). The viewer is the one the
 * files page uses, so a clinical report opens with its citations.
 */
function RunFilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a click on the backdrop itself closes the panel; Escape is the keyboard equivalent, bound above.
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/20"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${filename}`}
        className="h-full w-full max-w-content-wide border-l border-border bg-bg shadow-pop"
      >
        <Suspense fallback={<p className="p-6 text-ui text-muted">正在打开预览…</p>}>
          <FilePreviewInspector
            data={{ variant: "file", path, filename, artifact: extToKind(extOf(filename)), root: "workspace" }}
            onClose={onClose}
          />
        </Suspense>
      </div>
    </div>
  );
}

const PLAN_ITEM_LABEL: Record<WebRunPlanItem["status"], string> = {
  planned: "待开始", queued: "排队中", delegated: "进行中", submitted: "检查中",
  accepted: "已通过", rejected: "需修改", failed: "未完成",
};

/**
 * The deliverables of a run still working, as steps (2026-09-16 review, P2
 * #14). A thirteen-minute analysis showed a phase chip and a tool-call count;
 * which of its deliverables were done, being checked or sent back was only in
 * the kernel's own view.
 */
function PlanSteps({ items }: { items: WebRunPlanItem[] }) {
  const icon = (status: WebRunPlanItem["status"]) => {
    if (status === "accepted") return <Check size={13} className="text-ok" aria-hidden="true" />;
    if (status === "rejected") return <AlertCircle size={13} className="text-warn" aria-hidden="true" />;
    if (status === "failed") return <X size={13} className="text-error" aria-hidden="true" />;
    if (status === "planned") return <Circle size={11} className="text-muted" aria-hidden="true" />;
    return <Loader2 size={13} className="animate-spin text-accent" aria-hidden="true" />;
  };
  const done = items.filter((item) => item.status === "accepted").length;
  return (
    <div>
      <div className="mb-1 text-caption font-medium text-muted">交付进度 {done}/{items.length}</div>
      <ol aria-label="交付进度" className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2">
            <span className="flex w-4 shrink-0 justify-center">{icon(item.status)}</span>
            <span className="min-w-0 flex-1 truncate text-text">{item.title}</span>
            <span className="shrink-0 text-caption text-muted">
              {PLAN_ITEM_LABEL[item.status] ?? item.status}
              {item.attempts > 1 ? ` · 第 ${item.attempts} 次提交` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ArtifactRow({ path, unverified }: { path: string; unverified?: boolean }) {
  // The file's name is what a reader recognizes; the folder it sits in is the
  // workspace's bookkeeping (2026-09-16 walk, U13), kept beside it, quieter.
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const folder = slash > 0 ? path.slice(0, slash) : "";
  const preview = useContext(FilePreviewContext);
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => void downloadArtifact(path, "workspace")}
        aria-label={unverified ? `下载 ${name}（未通过核验）` : `下载 ${name}`}
        title={unverified ? `下载 ${path}（未通过核验）` : `下载 ${path}`}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("group-hover:text-link", unverified ? "text-warn" : "text-text")}>{name}</span>
          {folder && <span className="ml-2 font-mono text-caption text-muted">{folder}</span>}
        </span>
        {unverified && <span className="shrink-0 text-caption text-warn">未经核验</span>}
        <ExternalLink size={11} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
      {preview && (
        <button
          type="button"
          onClick={() => preview(path)}
          aria-label={`预览 ${name}`}
          className="min-h-6 shrink-0 rounded-input px-2 text-caption text-accent hover:bg-surface-2"
        >
          预览
        </button>
      )}
    </div>
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
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-caption transition-colors",
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
