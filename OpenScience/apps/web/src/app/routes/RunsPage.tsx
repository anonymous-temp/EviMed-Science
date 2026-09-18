import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Search,
  Square,
  X,
} from "lucide-react";
import { downloadArtifact } from "@/lib/artifactFile";
import { extOf, extToKind } from "@/lib/artifacts";
import {
  cancelWebAgentRun,
  fetchWebConnectors,
  getWebProjectId,
  listWebAgentRuns,
  listWebDeliverableFeedback,
  renameWebAgentRun,
  reportWebDeliverableFeedback,
  steerWebAgentRun,
  webErrorMessage,
  type WebAgentRun,
  type WebAgentRunStatus,
  type WebConnector,
  type WebRunDeliverable,
} from "@/lib/apiClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import {
  announceRunsChanged,
  OPEN_DOMAIN_ANSWER_AGENT_ID,
  relativeTime,
  runDidNotDeliver,
  runState,
  runTitle,
  undeliveredFiles,
  webRunOutcome,
  WEB_RUN_STATUS_LABEL,
} from "@/lib/runPresentation";
import {
  childrenLine,
  claimSummaryLine,
  currentPhaseLabel,
  DELIVERABLE_STATUS_LABEL,
  foldRunEvents,
  progressCountsLine,
  runCostText,
  runDeliverables,
  runProgressOf,
  type LiveRunFold,
} from "@/lib/runProgress";
import { useRunEvents } from "@/lib/runEvents";
import { capabilityTitle } from "@/lib/researchAgentUi";
import { runCredentialNeed, runCredentialSentence } from "@/lib/runCredential";
import { labelFor } from "@/lib/statusLabel";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { QualityNotices } from "@/components/runs/QualityNotices";
import { RunStatusDot } from "@/components/runs/RunStatusDot";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Textarea } from "@/components/ui/Input";

type SincePreset = "24h" | "7d" | "30d";

const SINCE_SECONDS: Record<SincePreset, number> = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

const SINCE_OPTIONS: { value: SincePreset | "all"; label: string }[] = [
  { value: "all", label: "全部时间" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

interface Filter {
  search: string;
  status?: string;
  surface?: string;
  since?: SincePreset;
}

/**
 * The nine-phase projection (§7.1.1), said for a run that is still open.
 *
 * Not a second status: `status` is the ledger's own four-value field and stays
 * what the badge, the filters and every gate script read. The phase separates
 * a run still waiting for its container from one that is working, and a
 * repair round from a first attempt. 「核验」, not 「门禁」: the gate is the
 * platform's word for itself, not the researcher's.
 */
const WEB_RUN_PHASE_LABEL: Record<string, string> = {
  reserved: "已排队，尚未派发",
  dispatched: "已派发，尚无进展",
  running: "进行中",
  delivering: "交付核对中",
  repairing: "按核验意见修复中",
  accepted: "已交付并通过核验",
  degraded: "已交付，待人工复核",
  failed: "未完成",
  canceled: "已取消",
};

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

interface RunsFilterChip {
  key: string;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  state?: "done" | "review" | "failed" | "running" | "canceled";
}

/** The sticky filter bar: a search box (debounced by the caller), status
 *  facet chips, and the time range in words. */
function RunsFilterBar({
  search,
  onSearchChange,
  chips,
  since,
  onSinceChange,
  anyFilter,
  onClear,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  chips: RunsFilterChip[];
  since?: SincePreset;
  onSinceChange: (since: SincePreset | undefined) => void;
  anyFilter: boolean;
  onClear: () => void;
}) {
  return (
    // An opaque canvas: the 95 %-alpha canvas class it had generated no CSS at
    // all (an opacity modifier on a var() colour), so rows scrolled visibly
    // under it.
    <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-bg px-1 py-2">
      <label className="relative min-w-48 flex-1">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <span className="sr-only">搜索运行记录</span>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索题目、能力或产物文件…"
          className="h-9 w-full rounded-input border border-strong bg-surface pl-8 pr-3 text-ui text-text outline-none placeholder:text-muted focus:border-focus"
        />
      </label>
      {chips.map(({ key, ...chip }) => (
        <FacetChip key={key} {...chip} />
      ))}
      {/* In words, not `24h / 7d / 30d` with `capitalize` — the one Latin
        * control in a Chinese interface (review B §4h). */}
      <SegmentedControl
        aria-label="时间范围"
        value={since ?? "all"}
        onChange={(value) => onSinceChange(value === "all" ? undefined : value)}
        options={SINCE_OPTIONS}
      />
      {anyFilter && (
        <button type="button" className="text-ui text-link hover:underline" onClick={onClear}>
          清除筛选
        </button>
      )}
    </div>
  );
}

/** One day-grouped section of the ledger, under its sticky day label. */
function DaySection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h2 className="sticky top-[3.25rem] z-10 bg-bg py-1 text-caption font-semibold text-muted">
        {label}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

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

/** Statuses a run is still in. Drives the fallback refresh below. */
const ACTIVE_RUN_STATUSES: ReadonlySet<WebAgentRunStatus> = new Set([
  "queued",
  "dispatching",
  "running",
  "canceling",
] as WebAgentRunStatus[]);

/**
 * The fallback read of the whole ledger while something runs. Live progress
 * arrives on each running row's event stream within a second; this is only
 * for what the stream does not carry and for a stream that could not connect.
 * It was the only source at 20 s, for three runs, and the page was 20 s stale.
 */
const RUNS_POLL_MS = 60_000;

/** A read that failed, said as a read that failed. */
function RunsLoadError({ message, onRetry, stale }: { message: string; onRetry: () => void; stale: boolean }) {
  return (
    <div role="alert" className="mt-3 rounded-card border border-border bg-surface px-4 py-3">
      <p className="text-ui text-text">{stale ? "刷新运行记录失败，下面显示的是上一次读到的内容。" : "无法读取运行记录。"}</p>
      <p className="mt-1 text-ui text-muted">{message}</p>
      <Button size="sm" variant="ghost" className="mt-2" onClick={onRetry}>重试</Button>
    </div>
  );
}

function RunsEmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return <EmptyState icon={Search} title="没有符合筛选条件的运行记录。" className="mt-8" />;
  }
  // It used to say 「当 EviMed 运行代码时（例如 python train.py）」 — a line
  // left over from a machine-learning tool, on an evidence workbench.
  return (
    <EmptyState
      icon={FlaskConical}
      title="还没有运行记录"
      description="提一个研究问题，或从「科研能力」选一项开始。每次运行的计划、进展、核验结果与产物都会记在这里。"
      action={<Link to="/app/chat" className={buttonClasses()}>新任务</Link>}
      className="mt-8 rounded-card border border-dashed border-border bg-surface"
    />
  );
}

/**
 * The hosted runs ledger. The web API returns the full list in one shot — no
 * server-side paging or facets — so filtering, day-grouping and chip counts
 * are computed client-side.
 */
function HostedRunsView() {
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null); // null = loading
  // A deliverable opened in place: a report, its matrix, a table — with the
  // same viewers the files page uses, instead of download-only rows.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ search: "" });
  const [debounced, setDebounced] = useState("");
  // `?run=` is how every link into this page names the run it means — the
  // sidebar's recent list, the inbox, and anything else that points at one.
  const [params] = useSearchParams();
  const deepLinked = params.get("run");
  const [expanded, setExpanded] = useState<string | null>(deepLinked);
  // The run a link named, until the ledger has been read and it can be opened.
  // It used to be applied once at mount, and the "keep the open row visible"
  // effect below ran first against the still-empty list and cleared it, so a
  // link from the sidebar or the inbox opened the newest run instead.
  const pendingDeepLink = useRef<string | null>(deepLinked);
  const navigate = useNavigate();

  // The ledger is a trust surface, so a failed read says so, and the rows
  // already on screen survive a failed refresh (2026-09-16 walk, U3).
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectors, setConnectors] = useState<WebConnector[] | null>(null);
  useEffect(() => {
    let active = true;
    // Only to name the one source a failed run needed; a read that fails
    // leaves that sentence out and nothing else.
    fetchWebConnectors().then((list) => { if (active) setConnectors(list); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const value = await listWebAgentRuns();
      setRuns(value);
      const linked = pendingDeepLink.current;
      if (linked && value.some((run) => run.id === linked)) {
        pendingDeepLink.current = null;
        setExpanded(linked);
      } else {
        setExpanded((current) => current ?? newestRun(value)?.id ?? null);
      }
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

  /** One run's record changed here (renamed, cancelled): swap it in place. */
  const replaceRun = useCallback((next: WebAgentRun) => {
    setRuns((current) => current?.map((run) => (run.id === next.id ? { ...run, ...next } : run)) ?? current);
    announceRunsChanged();
  }, []);

  // The slow fallback refresh while something runs, gated on visibility: a
  // background tab polling a ledger is spend with nobody reading it.
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
          // (§7.1.1), so this one filter key reads a different field.
          (!filter.status || (filter.status === "degraded" ? run.phase === "degraded" : run.status === filter.status)) &&
          (!sinceTs || webRunTs(run) >= sinceTs) &&
          (!query ||
            [runTitle(run), run.question, run.id, run.sessionId, run.agentId, run.effectiveAgentId, capabilityLabel(run), run.model, ...run.artifacts]
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
   * "复查与复现" — drafted into the session surface that actually reads it:
   * `runtimeUiIntent` in the navigation state, forwarded by RuntimeUiFrame and
   * applied by the harness bridge's `setDraft`.
   */
  const reproduce = (run: WebAgentRun) => {
    const activeAgent = run.effectiveAgentId ?? run.agentId;
    const draft =
      `复查科研运行 \`${run.id}\`（${activeAgent ? `${run.mode === "open-domain" ? "开放域路由 · " : ""}${activeAgent}` : "开放域科研"}）。` +
      `请读取该会话的原始消息、工具记录和产物，核对证据来源、失败项与可复现性；不要重新编造缺失数据。`;
    // `runtimeUiIntentFromState` drops an intent whose session id is not a
    // plain identifier; open a fresh session carrying the same draft then.
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
      label: "已交付",
      count: statusCounts.get("succeeded") ?? 0,
      active: filter.status === "succeeded",
      state: "done",
      onClick: () => toggle("succeeded"),
    },
    // Delivered, but with something unresolved a person should look at before
    // it is trusted the way an accepted run is. Shown only once at least one
    // run needs it, the rule "running"/"canceled" below follow.
    ...(statusCounts.get("degraded") ? [{
      key: "degraded",
      label: "待人工复核",
      count: statusCounts.get("degraded") ?? 0,
      active: filter.status === "degraded",
      state: "review" as const,
      onClick: () => toggle("degraded"),
    }] : []),
    {
      key: "failed",
      label: "未完成",
      count: statusCounts.get("failed") ?? 0,
      active: filter.status === "failed",
      state: "failed",
      onClick: () => toggle("failed"),
    },
    ...(["running", "canceled"] as const)
      .filter((s) => statusCounts.has(s))
      .map((s) => ({
        key: s,
        label: s === "running" ? "运行中" : WEB_RUN_STATUS_LABEL[s],
        count: statusCounts.get(s) ?? 0,
        active: filter.status === s,
        state: s,
        onClick: () => toggle(s),
      })),
  ];
  const groups = useMemo(() => groupByDay(rows, webRunTs), [rows]);

  // Keep the expanded row visible: when a filter change drops it from the
  // list, fall back to the newest row. Not while the ledger is still loading —
  // an empty list is not a filter result.
  useEffect(() => {
    if (runs === null) return;
    setExpanded((cur) => (cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)));
  }, [rows, runs]);

  // A new `?run=` on an already-mounted page (clicking a second sidebar row)
  // must move the expansion, not be ignored because the first one won.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  useEffect(() => {
    if (!deepLinked) return;
    pendingDeepLink.current = deepLinked;
    if (runsRef.current?.some((run) => run.id === deepLinked)) {
      pendingDeepLink.current = null;
      setExpanded(deepLinked);
    }
  }, [deepLinked]);

  return (
    <ConnectorsContext.Provider value={connectors}>
      <FilePreviewContext.Provider value={setPreviewPath}>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-content-wide px-8 py-8">
            <PageHeader
              title="运行记录"
              description="每次研究运行的进展、核验结果与产物。"
              className="mb-4"
            />

            {(rows.length > 0 || anyFilter) && (
              <RunsFilterBar
                search={filter.search}
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
                      onRunChanged={replaceRun}
                      onFinished={() => void load()}
                    />
                  ))}
                </DaySection>
              ))}
            </div>
          </div>
        </div>
        {previewPath && <RunFilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
      </FilePreviewContext.Provider>
    </ConnectorsContext.Provider>
  );
}

/**
 * What produced this run, in the product's words. An id this build has no
 * name for falls back to the id rather than to silence, because an unnamed
 * capability is worth seeing.
 */
function capabilityLabel(run: WebAgentRun): string {
  const agent = run.effectiveAgentId ?? run.agentId;
  if (!agent) return run.mode === "specialist" ? "专项科研" : "开放域科研";
  if (agent === OPEN_DOMAIN_ANSWER_AGENT_ID) return "开放域问答";
  const name = capabilityTitle(agent) ?? agent;
  return run.mode === "open-domain" ? `开放域 · ${name}` : name;
}

/**
 * A running run's own event stream, folded (contract C5). Subscribed only
 * while the run runs; when the stream says it ended, the ledger is re-read so
 * the row shows the verdict, not the last progress frame.
 */
function useLiveRun(run: WebAgentRun, onFinished: () => void): LiveRunFold | null {
  const running = run.status === "running";
  const { events } = useRunEvents(running ? run.id : null, { enabled: running, limit: 200 });
  const live = useMemo(() => (events.length > 0 ? foldRunEvents(events) : null), [events]);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const terminal = live?.state != null && live.state !== "running";
  useEffect(() => {
    if (terminal) finished.current();
  }, [terminal]);
  return live;
}

/** Re-renders a running row every 15 s so 「已用 N 分钟」 moves; nothing else ticks. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** One ledger row: its header, and — open — what the run produced, how it
 *  was checked, how its deliverables went, and its identifiers, in that order. */
function WebRunRow({
  run,
  open,
  onToggle,
  onReproduce,
  onOpenConversation,
  onRunChanged,
  onFinished,
}: {
  run: WebAgentRun;
  open: boolean;
  onToggle: () => void;
  onReproduce: () => void;
  onOpenConversation: () => void;
  onRunChanged: (run: WebAgentRun) => void;
  onFinished: () => void;
}) {
  const live = useLiveRun(run, onFinished);
  const running = run.status === "running";
  const now = useMinuteClock(running);
  const progress = runProgressOf(run, live);
  const state = runState(run);
  const cost = runCostText(run.usage ?? progress?.usage);
  const tag = capabilityLabel(run);
  const title = runTitle(run);
  const [editing, setEditing] = useState(false);

  const started = Date.parse(progress?.startedAt ?? run.startedAt);
  const elapsed = running && Number.isFinite(started) ? formatDuration(now - started) : "";
  // The state in words on every row, from the same rule and in the same place
  // as the sidebar's second line — colour and shape only repeat it.
  const meta = running
    ? [tag !== title ? tag : null, state.label, currentPhaseLabel(progress), elapsed ? `已用 ${elapsed}` : null]
    : [tag !== title ? tag : null, state.label, relativeTime(webRunTs(run) * 1000, now), run.durationMs != null ? `用时 ${formatDuration(run.durationMs)}` : null, cost || null];

  return (
    <li className="group/row">
      <div className="flex items-start gap-1 rounded-input hover:bg-surface-2">
        {editing ? (
          <RunTitleEditor
            run={run}
            onDone={(next) => {
              setEditing(false);
              if (next) onRunChanged(next);
            }}
          />
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-2 text-left"
            onClick={onToggle}
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown size={14} className="mt-1 shrink-0 text-muted" aria-hidden="true" />
            ) : (
              <ChevronRight size={14} className="mt-1 shrink-0 text-muted" aria-hidden="true" />
            )}
            <RunStatusDot state={state.key} labelled className="mt-1.5" />
            <span className="min-w-0 flex-1">
              {/* The question, when the run recorded one; `runTitle` says so
                * when it did not. The id stays in the identifiers
                * disclosure, where it is labelled. */}
              <span
                className={cn("block truncate text-ui font-medium", state.key === "failed" ? "text-muted" : "text-text")}
                title={run.titleSource === "user" ? `${title}（你起的标题，自动命名不会覆盖）` : title}
              >
                {title}
              </span>
              <span className="block truncate text-caption text-muted tabular-nums">
                {meta.filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`重命名「${title}」`}
            title="重命名"
            className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted opacity-0 hover:bg-surface hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {open && (
        <RunDetail
          run={run}
          live={live}
          onReproduce={onReproduce}
          onOpenConversation={onOpenConversation}
          onRunChanged={onRunChanged}
        />
      )}
    </li>
  );
}

/**
 * Renaming a run in place. The server marks the title `user` and no automatic
 * title may replace it afterwards (contract C3) — ChatGPT's auto-rename undoing
 * its users' names is the cautionary tale (appendix C, A3).
 */
function RunTitleEditor({ run, onDone }: { run: WebAgentRun; onDone: (next: WebAgentRun | null) => void }) {
  const [value, setValue] = useState(() => runTitle(run));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const save = async () => {
    const title = value.trim();
    if (!title || title === runTitle(run)) { onDone(null); return; }
    setSaving(true);
    setFailure(null);
    try {
      const next = await renameWebAgentRun(run.id, title);
      onDone({ ...run, ...next, title: next.title ?? title, titleSource: "user" });
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "标题没有保存下来，请重试。" }));
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-2 py-1.5"
      onSubmit={(event) => { event.preventDefault(); void save(); }}
    >
      <label className="sr-only" htmlFor={`run-title-${run.id}`}>运行标题</label>
      <input
        ref={input}
        id={`run-title-${run.id}`}
        value={value}
        maxLength={120}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") onDone(null); }}
        className="h-9 min-w-0 flex-1 rounded-input border border-strong bg-surface px-3 text-ui text-text outline-none focus:border-focus"
      />
      <Button size="sm" type="submit" loading={saving}>保存标题</Button>
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => onDone(null)}>取消</Button>
      <p className="w-full text-caption text-muted">改过的标题会被锁定，自动命名不再覆盖它。</p>
      {failure && <p role="alert" className="w-full text-caption text-error">{failure}</p>}
    </form>
  );
}

function RunDetail({
  run,
  live,
  onReproduce,
  onOpenConversation,
  onRunChanged,
}: {
  run: WebAgentRun;
  live: LiveRunFold | null;
  onReproduce: () => void;
  onOpenConversation: () => void;
  onRunChanged: (run: WebAgentRun) => void;
}) {
  const running = run.status === "running";
  const hasArtifacts = run.artifacts.length > 0;
  // `null` when the ledger does not carry the field at all — which is not the
  // same as "there are none", so the row stays silent rather than claiming
  // the run produced nothing.
  const undelivered = undeliveredFiles(run);
  const deliverables = runDeliverables(run, live);
  const claims = claimSummaryLine(run.claimSummary);
  const claimsOpen = (run.claimSummary?.unverified ?? 0) > 0;
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const cancel = async () => {
    setConfirmingCancel(false);
    setCanceling(true);
    try {
      const next = await cancelWebAgentRun(run.id);
      onRunChanged(next);
      toast.success("已取消这次运行。");
    } catch (error) {
      toast.error(`没能取消：${webErrorMessage(error, { fallback: "请稍后重试。" })}`);
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="mb-3 ml-6 max-w-content space-y-5 border-l border-faint pb-2 pl-5 pt-2 text-ui">
      {/* What happened, and what can be done about it. */}
      <div className="space-y-2">
        {running && <RunActivity run={run} live={live} />}
        {/* A failure says itself once, from the one dictionary, with the
          * code kept as a tooltip for support. */}
        {runDidNotDeliver(run) && <RunVerdict run={run} />}
        {claims && (
          <p className={cn("flex items-center gap-1.5", claimsOpen ? "text-verify-pending" : "text-verify-ok")}>
            {claimsOpen ? <CircleHelp size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            {claims}
          </p>
        )}
        {run.forkedFrom && (
          <p className="flex items-center gap-1.5 text-muted">
            <GitBranch size={14} aria-hidden="true" />
            这次对话是从另一次对话分支出来的。
            {/^[A-Za-z0-9_-]{1,160}$/.test(run.forkedFrom) && (
              <Link to={`/app/chat/${encodeURIComponent(run.forkedFrom)}`} className="text-link hover:underline">打开原对话</Link>
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onOpenConversation}>
            <MessageSquare size={14} aria-hidden="true" />打开对话
          </Button>
          {!running && (
            <Button size="sm" variant="ghost" onClick={onReproduce} title="起草提示，复查该运行的证据与产物并尝试复现">
              <RotateCcw size={14} aria-hidden="true" />复查与复现
            </Button>
          )}
          {running && (
            <Button size="sm" variant="ghost" loading={canceling} onClick={() => setConfirmingCancel(true)}>
              <Square size={14} aria-hidden="true" />取消运行
            </Button>
          )}
        </div>
        {running && <SteerBox run={run} />}
      </div>

      {/* 1 · 产物 — what the researcher came for, first. */}
      {(hasArtifacts || (undelivered && undelivered.length > 0)) && (
        <section aria-labelledby={`artifacts-${run.id}`} className="space-y-2">
          <h3 id={`artifacts-${run.id}`} className="text-ui font-semibold text-text">产物</h3>
          {hasArtifacts && (
            <ul className="space-y-1">
              {run.artifacts.map((path) => (
                <li key={path}>
                  <ArtifactRow path={path} />
                  <DeliverableFeedback runId={run.id} path={path} />
                </li>
              ))}
            </ul>
          )}
          {/* The files a refused run wrote and the gate did not accept. 28 of
            * 179 finished runs on the host ended with an empty artifact list
            * while a complete package sat on disk; nothing deleted those files,
            * they were unreachable, so they are handed back labelled. */}
          {!hasArtifacts && undelivered && undelivered.length > 0 && (
            <div>
              <p className="font-semibold text-warn">未通过核验的文件（{undelivered.length}）</p>
              <p className="mb-1 text-muted">
                本次运行写出了这些文件，但它们没有通过核验，因此没有作为成果发布。文件没有被删除，可以下载后自行判断；引用前请逐条核对。
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
        </section>
      )}

      {/* 2 · 核验 — the gate's findings at three weights (QualityNotices). */}
      <QualityNotices
        notices={run.qualityNotices}
        verification={run.verification}
        hasArtifacts={hasArtifacts}
        className="rounded-card border border-border bg-surface p-3"
      />

      {/* 3 · 交付进度 — kept after the run ends: which deliverable was sent
        * back, how many submissions it took, how it came out. */}
      {deliverables.length > 0 && <RunDeliverableList runId={run.id} items={deliverables} />}

      {/* 4 · 个性化依据 — what the platform knew about this researcher and used
        * here. An answer that silently drew on a stored preference and one that
        * did not must not look the same. */}
      {(run.recalledMemories?.length ?? 0) > 0 && (
        <Disclosure summary={<>个性化依据 {run.recalledMemories?.length} 条</>}>
          <div className="space-y-1 text-muted">
            <p>这次运行读取了你的这些长期记忆。内容在「记忆」里，可以随时修改或删除。</p>
            <ul className="space-y-0.5">
              {run.recalledMemories?.map((memory) => (
                <li key={memory.id}>
                  <Link to="/app/memory" className="hover:text-link">
                    {labelFor(MEMORY_KIND_LABELS, memory.kind, "其他记忆")}
                    {memory.scope === "project" ? "（本项目）" : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Disclosure>
      )}

      {/* 5 · 技术标识 — last and folded. Support asks for these, and a reader
        * who wants to know which model answered is entitled to; they are not
        * what a researcher reads their own work by (§23.2 rule 11). */}
      <Disclosure summary="技术标识（供排查使用）">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption text-muted">
          <dt>运行</dt><dd className="truncate font-mono">{run.id}</dd>
          <dt>会话</dt><dd className="truncate font-mono">{run.sessionId}</dd>
          <dt>模型</dt><dd className="truncate font-mono">{run.model}</dd>
          {(run.effectiveAgentId ?? run.agentId) && (
            <><dt>能力</dt><dd className="truncate font-mono">{run.effectiveAgentId ?? run.agentId}</dd></>
          )}
          {run.phase && (
            <><dt>阶段</dt><dd className="truncate">{labelFor(WEB_RUN_PHASE_LABEL, run.phase)}</dd></>
          )}
          {run.usage && (
            <><dt>用量</dt><dd className="truncate tabular-nums">{run.usage.requests} 次模型调用 · {runCostText(run.usage)}</dd></>
          )}
        </dl>
      </Disclosure>

      {confirmingCancel && (
        <ConfirmDialog
          title="取消这次运行？"
          body="运行会立即停止，包括它委派出去的子任务；已经写出的文件留在工作区。取消后不能继续，需要时可以重新提问。"
          confirmLabel="取消运行"
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => void cancel()}
        />
      )}
    </div>
  );
}

/**
 * A running run, as an odometer: the phase it is in, what it has done that can
 * be counted, its subtasks, how long it has taken and what it has cost — never
 * a percentage (appendix D §6.1). Every number is a count the ledger or the
 * event stream observed.
 */
function RunActivity({ run, live }: { run: WebAgentRun; live: LiveRunFold | null }) {
  const progress = runProgressOf(run, live);
  const counts = progressCountsLine(progress);
  const phase = run.phase ? WEB_RUN_PHASE_LABEL[run.phase] : null;
  const current = currentPhaseLabel(progress);
  const children = childrenLine(progress);
  const cost = runCostText(progress?.usage ?? run.usage);
  return (
    <div role="status" aria-live="polite" className="space-y-0.5">
      <p className="flex flex-wrap items-center gap-x-2 text-text">
        <Loader2 size={14} className="animate-spin text-dot-running" aria-hidden="true" />
        {[current, phase].filter(Boolean).join(" · ") || "进行中"}
        {children && <span className="text-muted">{children}</span>}
      </p>
      {counts ? (
        <p className="tabular-nums text-muted">{counts}{cost ? ` · ${cost}` : ""}</p>
      ) : run.observedToolCalls != null && run.observedToolCalls > 0 ? (
        // These analyses run for tens of minutes. Showing only 「运行中」 for
        // that long is indistinguishable from being stuck.
        <p className="text-muted">
          已完成 {run.observedToolCalls} 次检索与工具调用
          {run.lastProgressAt && ` · 最近进展 ${relativeTime(Date.parse(run.lastProgressAt))}`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A correction to a run that is still going (`/steer`): same run, same
 * contract, same gate — the input arrives after the current step. The route
 * existed with no way to reach it from any page (review E §9.2).
 */
function SteerBox({ run }: { run: WebAgentRun }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    setFailure(null);
    try {
      const result = await steerWebAgentRun(run.id, value);
      setText("");
      setSent(result.corrections);
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "补充没有送达，请稍后重试。" }));
    } finally {
      setSending(false);
    }
  };

  return (
    <Disclosure summary="补充条件或调整方向">
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Textarea
          label="给正在进行的运行补充"
          value={text}
          maxLength={4000}
          rows={3}
          disabled={sending}
          placeholder="例如：只看 70 岁以上人群；把出血风险单独列一节"
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-caption text-muted">会在当前步骤之后生效，不会重新开始；运行记录会记下你补充过几次。</p>
        <div className="flex items-center gap-2">
          <Button size="sm" type="submit" loading={sending} disabled={!text.trim()}>发送补充</Button>
          {sent != null && <span role="status" className="text-caption text-muted">已送达，这是第 {sent} 次补充。</span>}
        </div>
        {failure && <p role="alert" className="text-caption text-error">{failure}</p>}
      </form>
    </Disclosure>
  );
}

/** The run's planned deliverables with their submissions and verdicts. */
function RunDeliverableList({ runId, items }: { runId: string; items: WebRunDeliverable[] }) {
  const passed = items.filter((item) => item.status === "accepted" || item.status === "delivered").length;
  const icon = (item: WebRunDeliverable) => {
    if (item.status === "accepted" || item.status === "delivered") return <Check size={14} className="text-verify-ok" aria-hidden="true" />;
    if (item.status === "rejected") return <AlertCircle size={14} className="text-verify-pending" aria-hidden="true" />;
    if (item.status === "failed") return <X size={14} className="text-dot-failed" aria-hidden="true" />;
    if (item.status === "planned") return <Circle size={12} className="text-dot-canceled" aria-hidden="true" />;
    return <Loader2 size={14} className="animate-spin text-dot-running" aria-hidden="true" />;
  };
  const verdict = (item: WebRunDeliverable) => {
    if (item.lastVerdict === "pass") return "核验通过";
    if (item.lastVerdict === "unverified") return "未核验交付";
    if (item.lastVerdict === "issues") return item.mustFixCount ? `${item.mustFixCount} 项必须修改` : "有待修改项";
    return null;
  };
  return (
    <section aria-labelledby={`deliverables-${runId}`} className="space-y-1.5">
      <h3 id={`deliverables-${runId}`} className="flex items-baseline gap-2 text-ui font-semibold text-text">
        交付进度
        <span className="font-normal tabular-nums text-muted">{passed}/{items.length} 件已交付</span>
      </h3>
      <ol aria-label="交付进度" className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2">
            <span className="flex w-4 shrink-0 justify-center">{icon(item)}</span>
            <span className="min-w-0 truncate text-text">{item.title}</span>
            <span className="shrink-0 text-caption text-muted">
              {DELIVERABLE_STATUS_LABEL[item.status] ?? "状态未登记"}
              {item.attempts > 1 ? ` · 第 ${item.attempts} 次提交` : ""}
              {verdict(item) ? ` · ${verdict(item)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What happened to this run — one sentence from the one dictionary, plus
 *  whatever the ledger's own counters can add to it. */
function RunVerdict({ run }: { run: WebAgentRun }) {
  const outcome = webRunOutcome(run);
  const connectors = useContext(ConnectorsContext);
  // The one source this run needed, named on this run's row — instead of a
  // banner naming seven sources on every page (review B §7c).
  const need = runCredentialNeed(run, connectors);
  return (
    <div className="space-y-0.5">
      <p className="text-error" title={outcome.code ? `错误码：${outcome.code}` : undefined}>
        {outcome.headline}
      </p>
      {outcome.detail && <p className="text-muted">{outcome.detail}</p>}
      {need && (
        <p className="text-text">
          {runCredentialSentence(need)}
          <Link to="/app/account?tab=connectors" className="ml-1 text-link hover:underline">填写凭据</Link>
        </p>
      )}
    </div>
  );
}

/** The account's connectors, read once for the page; null until known. */
const ConnectorsContext = createContext<WebConnector[] | null>(null);

/**
 * Did this file turn out to be useful, and did it need editing?
 *
 * This is the learning loop's first producer: until 2026-09-16 production
 * held zero deliverable events because nothing on any page could record one.
 * 「我改过」 takes a sentence, because that sentence is the whole signal.
 *
 * What was already reported is read back from the feedback ledger (the
 * events are subject-addressed by `<runId>:<path>`), so a reload shows
 * 「已记录」 instead of offering both buttons again on a file already adopted.
 * The server owns deduplication; this surface only stops inviting a repeat.
 */
function DeliverableFeedback({ runId, path }: { runId: string; path: string }) {
  const [adopted, setAdopted] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "editing" | "sending">("idle");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listWebDeliverableFeedback(runId, path)
      .then((items) => {
        if (!active) return;
        if (items.some((item) => item.trigger === "deliverable-adopted")) setAdopted(true);
        const edit = items.find((item) => item.trigger === "deliverable-edited");
        if (edit) setEdited(typeof edit.detail?.summary === "string" ? edit.detail.summary : "");
      })
      // A ledger that cannot be read offers the buttons, which is what the
      // page did before it could read one at all.
      .catch(() => {});
    return () => { active = false; };
  }, [runId, path]);

  const send = async (trigger: "deliverable-adopted" | "deliverable-edited", summary?: string) => {
    setMode("sending");
    setFailure(null);
    try {
      await reportWebDeliverableFeedback({ trigger, runId, path, summary });
      if (trigger === "deliverable-adopted") setAdopted(true);
      else { setEdited(summary ?? ""); setNote(""); }
      setMode("idle");
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "反馈没有记录下来，请稍后重试。" }));
      setMode("idle");
    }
  };

  return (
    <div className="px-1 pb-1">
      {(adopted || edited !== null) && (
        <p className="text-caption text-muted">
          {adopted && "已记录：这份成果被采纳。"}
          {edited !== null && `已记录：这份成果做过修改${edited ? `（${edited}）` : ""}。`}
        </p>
      )}
      {mode === "editing" ? (
        <form
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); void send("deliverable-edited", note.trim()); }}
        >
          <label className="sr-only" htmlFor={`edited-${runId}-${path}`}>改了什么</label>
          <input
            id={`edited-${runId}-${path}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="改了什么？一句话即可"
            className="h-8 min-w-0 flex-1 rounded-input border border-strong bg-surface px-2 text-ui text-text outline-none focus:border-focus"
          />
          <Button size="sm" type="submit" disabled={note.trim().length === 0}>提交</Button>
          <Button size="sm" variant="ghost" onClick={() => { setMode("idle"); setNote(""); }}>取消</Button>
        </form>
      ) : (
        (!adopted || edited === null) && (
          <div className="mt-1 flex items-center gap-2">
            {!adopted && (
              <Button size="sm" variant="ghost" disabled={mode === "sending"} onClick={() => void send("deliverable-adopted")}>采纳</Button>
            )}
            {/* An edit after an adoption is the pair the distillation reads, so
              * adopting does not take this button away. */}
            {edited === null && (
              <Button size="sm" variant="ghost" disabled={mode === "sending"} onClick={() => setMode("editing")}>我改过</Button>
            )}
          </div>
        )
      )}
      {failure && <p role="alert" className="mt-1 text-caption text-error">{failure}</p>}
    </div>
  );
}

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
        className="h-full w-full max-w-content-wide border-l border-border bg-bg shadow-modal"
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

/** One downloadable file. `unverified` marks a file the gate did not accept;
 *  the marker carries the same weight as the path, because a reader must not
 *  be able to take one of these for graded work. */
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
        type="button"
        onClick={() => void downloadArtifact(path, "workspace")}
        aria-label={unverified ? `下载 ${name}（未通过核验）` : `下载 ${name}`}
        title={unverified ? `下载 ${path}（未通过核验）` : `下载 ${path}`}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("group-hover:text-link", unverified ? "text-warn" : "text-text")}>{name}</span>
          {folder && <span className="ml-2 font-mono text-caption text-muted">{folder}</span>}
        </span>
        {unverified && <span className="shrink-0 text-caption text-warn">未经核验</span>}
        <ExternalLink size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
      {preview && (
        <Button size="sm" variant="ghost" onClick={() => preview(path)} aria-label={`预览 ${name}`}>
          预览
        </Button>
      )}
    </div>
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
 *  sorted newest first. */
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
  if (days < 7) return formatDateTime(d, { weekday: "long" });
  return formatDateTime(d, { month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** A status facet: the same shape and colour the rows use, and its count. */
function FacetChip({ label, count, active, onClick, state }: Omit<RunsFilterChip, "key">) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-ui transition-colors duration-fast",
        active ? "border-focus bg-accent-soft text-text" : "border-strong bg-surface text-muted hover:text-text",
      )}
    >
      {state && <RunStatusDot state={state} labelled />}
      <span>{label}</span>
      <span className="tabular-nums text-muted">{count}</span>
    </button>
  );
}
