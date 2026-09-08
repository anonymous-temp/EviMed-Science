import { useEffect, useState } from "react";
import { FileText, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import {
  budgetNoticeDetails,
  runDidNotDeliver,
  runDotClass,
  runTitle,
  summarizeQualityNotices,
  undeliveredFiles,
  webRunOutcome,
  WEB_RUN_STATUS_LABEL,
} from "@/lib/runPresentation";

/** How many runs the panel keeps on screen; the ledger holds the rest. */
const PANEL_RUNS = 20;

/** How many gate findings the panel spells out before it offers the rest. The
 *  budget is a layout choice, never a secret: whatever it hides is counted on
 *  the button that reveals it. */
const NOTICE_DETAIL_BUDGET = 4;

/**
 * The run ledger, beside the conversation.
 *
 * The conversation is the kernel's; the verdict on what it produced is ours.
 * A run that delivered and a run that delivered with an open gate issue look
 * identical inside a chat transcript, and that difference is the product —
 * so it is shown next to the transcript rather than one navigation away.
 */
export function RunSidePanel({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await listWebAgentRuns();
        if (!active) return;
        setRuns(value);
        setError(null);
        setExpanded((current) => current ?? value[0]?.id ?? null);
      } catch (err) {
        if (!active) return;
        setRuns((current) => current ?? []);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setRuns(await listWebAgentRuns());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const rows = (runs ?? []).slice(0, PANEL_RUNS);

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-medium text-text">运行记录</span>
        <span className="text-xs text-muted">本项目</span>
        <div className="flex-1" />
        <button
          onClick={() => void refresh()}
          aria-label="刷新运行记录"
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        >
          <RefreshCw size={13} strokeWidth={1.5} className={cn(refreshing && "animate-spin")} />
        </button>
        <button onClick={onClose} aria-label="关闭运行面板" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error && <div className="px-2 py-2 text-xs text-error">{error}</div>}
        {runs === null && <div className="px-2 py-3 text-xs text-muted">正在读取…</div>}
        {runs !== null && rows.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted">
            这个项目还没有运行记录。在左边开始一段对话，产出会记在这里。
          </div>
        )}
        {rows.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            open={expanded === run.id}
            onToggle={() => setExpanded((id) => (id === run.id ? null : run.id))}
          />
        ))}
      </div>
    </aside>
  );
}

function RunCard({ run, open, onToggle }: { run: WebAgentRun; open: boolean; onToggle: () => void }) {
  const agent = run.effectiveAgentId ?? run.agentId;
  return (
    <div className="mb-1 rounded-card border border-border">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span
          className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", runDotClass(run))}
          title={WEB_RUN_STATUS_LABEL[run.status]}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-text">{runTitle(run)}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {agent ?? "开放域"} · {WEB_RUN_STATUS_LABEL[run.status]}
            {run.durationMs != null && ` · ${Math.round(run.durationMs / 1000)}s`}
          </span>
        </span>
      </button>

      {open && <RunCardBody run={run} />}
    </div>
  );
}

function RunCardBody({ run }: { run: WebAgentRun }) {
  const [allNotices, setAllNotices] = useState(false);
  const notices = summarizeQualityNotices(run.qualityNotices ?? []);
  const delivered = run.artifacts.length > 0;
  const undelivered = undeliveredFiles(run);

  return (
    <div className="border-t border-border px-3 py-2">
      {/* What happened, in one true sentence, from the one dictionary. This
          used to print `失败原因：{run.errorCode}` — the raw server identifier,
          in English, to a reader of a Simplified-Chinese interface. */}
      {runDidNotDeliver(run) && <RunVerdict run={run} />}

      {/* The gate's verdict on a run that did deliver. A run with nothing here
          passed every layer that ran — which is not the same as "no issues
          found", so the two other cases say which. The clause about files is
          conditional because the unverified path can finish with no files at
          all (an open-domain answer has none by design), and the card used to
          promise "交付物可用" six lines above "暂无交付物。" */}
      {run.verification === "unverified" && (
        <p className="mb-2 text-xs text-warn">
          {delivered
            ? "已交付，但未完成核验——交付物可以照常下载，结论请在引用前自行复核。"
            : "已交付，但未完成核验——本次没有文件产出，结论请在引用前自行复核。"}
        </p>
      )}
      {run.verification === "unchecked" && (
        <p className="mb-2 text-xs text-warn">已交付，但有一层门禁没有检查过。没有发现问题不等于检查过。</p>
      )}

      {notices.total > 0 && (
        <div className="mb-2">
          {/* The shape of the verdict before its prose: how many findings a
              reader cannot discount, and how many they can weigh themselves. */}
          <div className="mb-1 text-caption font-medium uppercase tracking-wider text-muted">
            门禁意见 · 必须修正 {notices.mustFix} 项 · 建议修正 {notices.advisory} 项
          </div>
          <NoticeList notices={notices} expanded={allNotices} onExpand={() => setAllNotices((value) => !value)} />
        </div>
      )}

      <RunFiles run={run} delivered={delivered} undelivered={undelivered} />
    </div>
  );
}

/** What happened to this run, plus what the ledger measured before it ended.
 *  The registry's sentences already carry "what happened + what you can do";
 *  the raw code stays reachable as a tooltip for support, never as the
 *  message. */
function RunVerdict({ run }: { run: WebAgentRun }) {
  const outcome = webRunOutcome(run);
  return (
    <div className="mb-2 space-y-0.5">
      <p className="text-xs text-error" title={outcome.code ? `错误码：${outcome.code}` : undefined}>
        {outcome.headline}
      </p>
      {outcome.detail && <p className="text-xs text-text/70">{outcome.detail}</p>}
    </div>
  );
}

/** Every group, always; the detail lines up to a budget, with the remainder
 *  counted on the button rather than dropped. The panel used to `.slice(0, 4)`
 *  with no indication there were more, so a package with 25 findings was
 *  repaired four at a time and refused again each round. */
function NoticeList({
  notices,
  expanded,
  onExpand,
}: {
  notices: ReturnType<typeof summarizeQualityNotices>;
  expanded: boolean;
  onExpand: () => void;
}) {
  const budgeted = budgetNoticeDetails(notices.groups, expanded ? Number.POSITIVE_INFINITY : NOTICE_DETAIL_BUDGET);
  const hidden = budgeted.reduce((sum, entry) => sum + entry.hidden, 0);
  return (
    <>
      <ul className="space-y-1">
        {budgeted.map(({ group, shown }) => (
          <li key={`${group.mustFix}-${group.label}`}>
            <div className="flex items-center gap-1.5 text-xs">
              {group.mustFix && (
                <span className="shrink-0 rounded bg-error/10 px-1 py-px text-caption font-medium text-error">
                  必须修正
                </span>
              )}
              <span className="min-w-0 truncate font-medium text-text">{group.label}</span>
              <span className="tabular-nums text-muted">{group.items.length}</span>
            </div>
            {shown.length > 0 && (
              <ul className="mt-0.5 space-y-0.5">
                {shown.map((item) => (
                  <li key={item} className="flex gap-1.5 leading-relaxed text-xs text-text/70">
                    <span className="shrink-0 text-muted">·</span>
                    <span className="min-w-0 break-words">{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && (
        <button type="button" onClick={onExpand} className="mt-1 text-xs text-link hover:underline">
          {expanded ? "收起明细" : `展开全部 ${notices.total} 条明细`}
        </button>
      )}
    </>
  );
}

/**
 * The files, and what the gate said about them.
 *
 * Three cases, and the third is why this is not one ternary: the ledger field
 * that lists produced-but-unaccepted files is absent on older records, and an
 * absent field means "unknown", not "none". Saying "没有留下任何文件" on the
 * strength of a field nobody sent would be the same class of untruth as the
 * "运行未通过核验。" default this change removes.
 */
function RunFiles({
  run,
  delivered,
  undelivered,
}: {
  run: WebAgentRun;
  delivered: boolean;
  undelivered: string[] | null;
}) {
  if (delivered) {
    return (
      <div className="flex flex-col items-start gap-1">
        {/* The same download the ledger uses, not a second one: one way
            to fetch a deliverable means one place its auth, its root and
            its filename are decided. */}
        {run.artifacts.map((artifact) => (
          <FileButton key={artifact} path={artifact} />
        ))}
      </div>
    );
  }

  if (undelivered && undelivered.length > 0) {
    return (
      <div>
        <div className="mb-1 text-caption font-medium uppercase tracking-wider text-warn">
          未通过核验的文件（{undelivered.length}）
        </div>
        {/* Load-bearing wording. Twenty-eight of 179 finished runs on the host
            were refused with an empty artifact list while a complete package
            sat on disk; nothing deleted those files. Handing them back is
            right, and handing them back looking like accepted work would be
            the failure the gate exists to prevent, moved into the UI. */}
        <p className="mb-1 text-xs text-text/70">
          本次运行写出了这些文件，但它们没有通过质量门，因此没有作为成果发布。文件没有被删除，可以下载后自行判断；引用前请逐条核对。
        </p>
        <div className="flex flex-col items-start gap-1">
          {undelivered.map((path) => (
            <FileButton key={path} path={path} unverified />
          ))}
        </div>
      </div>
    );
  }

  if (undelivered) {
    return <p className="text-xs text-muted">本次运行没有留下任何文件。</p>;
  }

  if (run.status === "running") {
    return <p className="text-xs text-muted">运行进行中，尚未产出交付物。</p>;
  }

  return (
    <p className="text-xs text-muted">
      {runDidNotDeliver(run)
        ? "没有通过核验的交付物。本次运行写出的文件（如果有）仍留在工作区，未随这次运行发布。"
        : "本次运行没有交付文件。"}
    </p>
  );
}

function FileButton({ path, unverified }: { path: string; unverified?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => void downloadArtifact(path, "workspace")}
      title={path}
      className={cn(
        "flex max-w-full items-center gap-1.5 text-xs hover:underline",
        unverified ? "text-warn" : "text-accent",
      )}
    >
      <FileText size={12} strokeWidth={1.5} className="shrink-0" />
      <span className="truncate">{path.split("/").pop()}</span>
      {/* Same visual weight as the filename: a reader must not be able to take
          one of these for graded work. */}
      {unverified && <span className="shrink-0 text-caption">未经核验</span>}
    </button>
  );
}
