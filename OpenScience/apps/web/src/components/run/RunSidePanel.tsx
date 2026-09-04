import { useEffect, useState } from "react";
import { FileText, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import { runDotClass, runTitle, WEB_RUN_STATUS_LABEL } from "@/lib/runPresentation";

/** How many runs the panel keeps on screen; the ledger holds the rest. */
const PANEL_RUNS = 20;

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

      {open && (
        <div className="border-t border-border px-3 py-2">
          {/* The gate's verdict, in the words the ledger uses. A run with
              nothing here passed every layer that ran — which is not the same
              as "no issues found", so the two other cases say which. */}
          {run.verification === "unverified" && (
            <p className="mb-2 text-xs text-warn">已交付，但未完成核验——交付物可用，结论请自行复核。</p>
          )}
          {run.verification === "unchecked" && (
            <p className="mb-2 text-xs text-warn">已交付，但有一层门禁没有检查过。</p>
          )}
          {(run.qualityNotices?.length ?? 0) > 0 && (
            <ul className="mb-2 list-disc pl-4 text-xs text-muted">
              {run.qualityNotices?.slice(0, 4).map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
          {run.errorCode && <p className="mb-2 text-xs text-error">失败原因：{run.errorCode}</p>}

          {run.artifacts.length > 0 ? (
            <div className="flex flex-col items-start gap-1">
              {/* The same download the ledger uses, not a second one: one way
                  to fetch a deliverable means one place its auth, its root and
                  its filename are decided. */}
              {run.artifacts.map((artifact) => (
                <button
                  key={artifact}
                  type="button"
                  onClick={() => void downloadArtifact(artifact, "workspace")}
                  className="flex max-w-full items-center gap-1.5 truncate text-xs text-accent hover:underline"
                >
                  <FileText size={12} strokeWidth={1.5} className="shrink-0" />
                  <span className="truncate">{artifact.split("/").pop()}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">暂无交付物。</p>
          )}
        </div>
      )}
    </div>
  );
}
