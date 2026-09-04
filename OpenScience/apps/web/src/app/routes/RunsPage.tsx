import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileOutput,
  FlaskConical,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Search,
} from "lucide-react";
import { downloadArtifact } from "@/lib/artifactFile";
import { listWebAgentRuns, type WebAgentRun, type WebAgentRunStatus } from "@/lib/apiClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { formatDateTime } from "@/lib/format";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

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

/** What went wrong, in the reader's language. The raw code was rendered as-is,
 *  so a run reported "specialist_citation_invalid" to someone reading a Chinese
 *  interface. The code is kept as a tooltip for support, not as the message. */
const WEB_RUN_ERROR_LABEL: Record<string, string> = {
  agent_timeout: "运行超时，未能在时限内完成。",
  runtime_tool_error: "科研工具调用失败，且后续没有成功的同类调用。",
  runtime_session_error: "科研会话出错中断。",
  runtime_canceled: "运行已被取消。",
  runtime_limit_exceeded: "同时运行的任务已达上限，请等待前一个任务完成后重试。",
  specialist_contract_unavailable: "该专项 Agent 的契约版本已变更，结果无法核验。",
  specialist_required_output_missing: "缺少必需的产物文件。",
  specialist_required_output_stale: "产物文件早于本次运行，未被更新。",
  specialist_required_skill_missing: "本轮未加载所需技能，结果未经该技能核验。",
  specialist_citation_invalid: "存在读者无法打开的引文地址（内部地址或含凭据）。",
  specialist_citation_integrity_failed: "引文与其来源不一致。",
  specialist_cited_source_unrecorded: "报告引用了未记录在证据快照中的来源。",
  specialist_evidence_snapshot_missing: "缺少证据快照文件。",
  specialist_evidence_snapshot_invalid: "证据快照文件格式无效。",
  specialist_evidence_snapshot_empty: "证据快照中没有任何来源。",
  specialist_evidence_traceability_failed: "部分结论未能追溯到其来源原文。",
  specialist_evidence_provenance_failed: "来源文件的留存记录不完整。",
  specialist_evidence_integrity_failed: "来源文件在运行后被改动。",
  specialist_evidence_repair_failed: "多轮修复后仍未通过证据核验。",
  specialist_delegated_evidence_read: "检索到的原文由子任务转述读取，引文非来源原始措辞。",
};

function runErrorLabel(code: string): string {
  return WEB_RUN_ERROR_LABEL[code] ?? "运行未通过核验。";
}

/** What each gate notice is about, in the reader's language. The notices are
 *  written for the agent that has to repair them, so making them visible put
 *  forty lines of English validator prose in front of a Chinese-reading
 *  researcher. Grouping gives them the shape of the problem first; the detail
 *  lines still carry the line numbers, URLs and claim ids they need to check. */
const NOTICE_GROUPS: { label: string; match: RegExp }[] = [
  { label: "数字未标注其来源主张", match: /^Report line \d+ numeric facts .+ have no evidence-matrix claim reference/ },
  { label: "数字与所引主张不符", match: /^Report line \d+ numeric facts .+ are not present in the cited claim evidence/ },
  { label: "推导结论未标注为推导", match: /states derived result .+ without marking it as derived/ },
  { label: "推导结论进入了处置建议", match: /practical advice must rest on measured evidence/ },
  { label: "引文地址", match: /^The citation /i },
  { label: "证据矩阵主张", match: /^claims\[\d+\]/ },
  { label: "引文台账与参考文献", match: /^(?:citation-ledger\.csv|references\.bib|citation-audit\.md)/ },
  { label: "检索日志与运行记录", match: /search log|clinical-evidence-(?:search|run)\.json/i },
  { label: "检索到的原文由子任务转述", match: /^Reading retrieved evidence was delegated/ },
  { label: "修复过程影响了报告篇幅", match: /^(?:The report was replaced|Repair reduced)/ },
  { label: "报告结构与表述", match: /^The (?:academic|deep-research) report/ },
];

interface NoticeGroup {
  label: string;
  mustFix: boolean;
  items: string[];
}

function groupQualityNotices(notices: string[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    // "MUST FIX — " is how the gate marks what a reader cannot see for
    // themselves. It is a severity, not part of the sentence.
    const mustFix = /^MUST FIX\s*[—-]\s*/.test(notice);
    const body = notice.replace(/^MUST FIX\s*[—-]\s*/, "");
    const label = NOTICE_GROUPS.find((group) => group.match.test(body))?.label ?? "其他核验提示";
    const key = `${mustFix ? "1" : "0"}:${label}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(body);
    else groups.set(key, { label, mustFix, items: [body] });
  }
  // What must be fixed leads: it is the part a reader cannot discount alone.
  return [...groups.values()].sort((a, b) => Number(b.mustFix) - Number(a.mustFix));
}

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
  // `?run=` is how every link into this page names the run it means — the
  // sidebar's recent list, and anything else that wants to point at one.
  // Without it a link can only land on "the newest run", which is a different
  // run by the time someone opens it.
  const [params] = useSearchParams();
  const deepLinked = params.get("run");
  const [expanded, setExpanded] = useState<string | null>(deepLinked);
  const navigate = useNavigate();
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

  useEffect(() => {
    let active = true;
    void listWebAgentRuns()
      .then((value) => {
        if (!active) return;
        setRuns(value);
        setExpanded((current) => current ?? newestRun(value)?.id ?? null);
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

  const reproduce = (run: WebAgentRun) => {
    const activeAgent = run.effectiveAgentId ?? run.agentId;
    setComposerDraft(
      `复查科研运行 \`${run.id}\`（${activeAgent ? `${run.mode === "open-domain" ? "开放域路由 · " : ""}${activeAgent}` : "开放域科研"}）。` +
        `请读取该会话的原始消息、工具记录和产物，核对证据来源、失败项与可复现性；不要重新编造缺失数据。`,
    );
    navigate(`/live/${run.sessionId}`);
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
        {/* The question, when the run recorded one. The list was keyed on the
          * run id alone, so thirty analyses read as thirty hashes and telling
          * them apart meant opening each one. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            run.question ? "" : "font-mono",
            failed ? "text-text/70" : "text-text",
          )}
          title={run.question ? `${run.question}\n${run.id}` : run.id}
        >
          {run.question || run.id}
        </span>
        <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-accent">
          {run.effectiveAgentId
            ? `${run.mode === "open-domain" ? "开放域 · " : ""}${run.effectiveAgentId}`
            : run.mode === "specialist" ? run.agentId : "开放域科研"}
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
            {run.mode === "open-domain" && run.effectiveAgentId && (
              <Chip title="开放域自动路由专项">{run.effectiveAgentId}</Chip>
            )}
            <Chip title="会话">{run.sessionId}</Chip>
            {run.question && <Chip title="运行 ID">{run.id}</Chip>}
            {run.phase && WEB_RUN_PHASE_LABEL[run.phase] && (
              <Chip title={`运行阶段（由账本记录派生，不单独存储）：${run.phase}`}>
                {WEB_RUN_PHASE_LABEL[run.phase]}
              </Chip>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Action icon={<RotateCcw size={12} />} onClick={onReproduce} title="起草提示，复查该运行的证据与产物并尝试复现">
              复查与复现
            </Action>
            <Action icon={<MessageSquare size={12} />} onClick={onOpenConversation} title="打开产生此次运行的对话">
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
            {run.errorCode && (
              <span className="text-error" title={`错误码：${run.errorCode}`}>
                {runErrorLabel(run.errorCode)}
              </span>
            )}
          </div>

          {/* The verdict and its reasons were computed, stored, and returned by
            * the API, and then rendered nowhere: a package delivered with seven
            * named gaps looked exactly like a clean one. */}
          {(run.verification != null || (run.qualityNotices?.length ?? 0) > 0) && (
            <div className="rounded-card border border-border-faint bg-surface-2/40 p-2">
              <div className="mb-1 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wider text-muted">
                <ScrollText size={12} />
                {run.verification === "unverified" && "已交付，但未完成核验"}
                {/* Not the same statement, and it used to render as the absence
                  * of any statement: a layer of the gate did not run here, so
                  * nothing below says that layer found the package sound. */}
                {run.verification === "unchecked" && "已交付，但有一层没有检查过"}
                {run.verification == null && "核验提示"}
              </div>
              {run.verification === "unverified" && (
                <p className="mb-1.5 text-xs text-text/80">
                  产物可以照常下载和阅读；以下各点是本次分析未能自证的部分，请在引用前自行核对。
                </p>
              )}
              {run.verification === "unchecked" && (
                <p className="mb-1.5 text-xs text-text/80">
                  产物可以照常下载和阅读；本次交付有一层核验根本没有执行，以下说明是哪一层、为什么没执行。
                  没有发现问题不等于检查过。
                </p>
              )}
              <ul className="space-y-2">
                {groupQualityNotices(run.qualityNotices ?? []).map((group) => (
                  <li key={`${group.mustFix}-${group.label}`}>
                    <div className="flex items-center gap-1.5 text-xs">
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
