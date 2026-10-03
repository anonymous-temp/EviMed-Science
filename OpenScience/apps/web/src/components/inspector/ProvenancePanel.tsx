import { ResultVersionInspector } from "./ResultVersionInspector";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MessageSquare, Package, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
import type { ProvenanceRecord } from "@ai4s/shared";
import { listProvenance, readEnvLockfile } from "@/lib/provenance";
import { getWebProjectId } from "@/lib/apiClient";
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";

/** The prompt the Reproduce action drafts — prefilled, reviewed, user-sent. */
export function reproducePrompt(r: ProvenanceRecord): string {
  const pkgs = r.env?.packages;
  const pkgNote = pkgs
    ? ` 该环境安装了 ${pkgs.count} 个 Python 包，记录在 \`.openscience/env/${pkgs.hash}.txt\`。`
    : "";
  const env = r.env
    ? ` 该结果使用${r.env.python ? ` Python ${r.env.python}，运行于` : ""} ${r.env.platform}。${pkgNote}`
    : "";
  const content = r.content ?? "";
  // A fence longer than any backtick run in the content, so embedded ``` in
  // the recorded code (e.g. a generated report.md) cannot close it early.
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  // Records are capped at 100 KB (provenance.rs cap_content) — a truncated
  // record is not runnable, so tell the agent where the full code lives.
  const truncNote = content.endsWith("[truncated]")
    ? " 注意：下方记录代码因存储上限被截断；完整代码未保存，请检查现有输入；完整代码可能无法恢复。"
    : "";
  return (
    `讨论 \`${r.path}\`（旧版记录 v${r.version}，未保存不可变文件内容）。${env} ` +
    `根据下方记录说明可以如何继续分析 \`${r.path}\`，` +
    `先检查依赖和输入是否可用；此请求不是确定性重算。` +
    `${truncNote}\n\n${fence}\n${content}\n${fence}`
  );
}

function longestBacktickRun(text: string): number {
  let max = 0;
  for (const run of text.match(/`+/g) ?? []) max = Math.max(max, run.length);
  return max;
}

/**
 * The provenance History of one artifact: every recorded version with the code
 * that produced it, the tool, the model, and a link back to the originating
 * conversation. Data comes from `.openscience/provenance.jsonl` (P0-3).
 */
export function ProvenancePanel({ path, language, runId, initialVersionId }: { path: string; language?: string; runId?: string; initialVersionId?: string }) {
  const [legacy, setLegacy] = useState(false);
  if (!legacy) return <ResultVersionInspector path={path} runId={runId} initialVersionId={initialVersionId} onLegacy={() => setLegacy(true)} />;
  return <LegacyProvenancePanel path={path} language={language} />;
}

export function LegacyProvenancePanel({ path, language }: { path: string; language?: string }) {
  const [records, setRecords] = useState<ProvenanceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  // The package lockfile currently shown, keyed by its content hash.
  const [lockfile, setLockfile] = useState<{ hash: string; text: string | null } | null>(null);
  const navigate = useNavigate();

  // Toggle the pip-freeze lockfile for a snapshot hash; loads it lazily on open.
  const toggleLockfile = (hash: string) => {
    if (lockfile?.hash === hash) {
      setLockfile(null);
      return;
    }
    setLockfile({ hash, text: null });
    void readEnvLockfile(hash).then((text) =>
      setLockfile((cur) => (cur?.hash === hash ? { hash, text: text ?? "（依赖锁定文件不可用）" } : cur)),
    );
  };

  // Draft the reproduce prompt into the conversation the version came from —
  // the user reviews and sends it (human in the loop, never auto-run). The
  // draft travels as a `runtimeUiIntent` in the navigation state, which the
  // kernel's own application reads through the harness bridge; it used to be
  // written to a store field only a never-routed composer of ours read, so the
  // button navigated and the prompt went nowhere.
  const reproduce = (r: ProvenanceRecord) => {
    const sessionId = typeof r.sessionId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(r.sessionId) ? r.sessionId : null;
    const intent: RuntimeUiIntent = {
      kind: sessionId ? "open" : "create",
      projectId: getWebProjectId(),
      requestId: crypto.randomUUID(),
      sessionId: sessionId ?? crypto.randomUUID(),
      draft: reproducePrompt(r),
    };
    navigate(sessionId ? `/app/chat/${sessionId}` : "/app/chat", { state: { runtimeUiIntent: intent } });
  };

  useEffect(() => {
    let cancelled = false;
    setRecords(null); setError(null);
    void listProvenance(path).then((r) => {
      if (cancelled) return;
      setRecords([...r].reverse()); // newest first
      setExpanded(r.length > 0 ? r[r.length - 1].version : null);
    }).catch(() => { if (!cancelled) setError("无法读取旧版记录，请重试"); });
    return () => {
      cancelled = true;
    };
  }, [path, reload]);

  if (error) return <div role="alert" className="space-y-2 p-4 text-ui text-error"><p>{error}</p><Button variant="secondary" onClick={() => setReload((n) => n + 1)}>重试</Button></div>;

  if (records === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-ui text-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> 正在加载版本记录
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="p-4 text-ui text-muted">
        暂无版本记录。<span className="font-mono text-text">{path}</span> 的历史文件内容尚未保存。
      </div>
    );
  }

  return (
    <ul className="space-y-2 p-3">
      {records.map((r) => {
        const open = expanded === r.version;
        return (
          <li key={r.version} className="rounded-input border border-border bg-surface">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui"
              onClick={() => setExpanded(open ? null : r.version)}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden="true" />
              ) : (
                <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden="true" />
              )}
              <span className="rounded bg-surface-2 px-1.5 text-caption font-medium text-text">
                v{r.version}
              </span>
              <span className="font-mono text-caption text-muted">{r.tool}</span>
              <span className="flex-1" />
              <span className="text-caption text-muted">{formatTs(r.ts)}</span>
            </button>
            {open && (
              <div className="space-y-2 border-t border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
                  {r.model && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{r.model}</span>
                  )}
                  {r.env && (
                    <Tooltip content="此版本的运行环境">
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">
                        {[r.env.python && `py ${r.env.python}`, r.env.platform, `app ${r.env.app}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Tooltip>
                  )}
                  {r.env?.packages && (
                    <Tooltip content="查看此版本的 Python 依赖锁定文件">
                      <button
                        className={cn(
                          "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono hover:bg-surface-2 hover:text-text",
                          lockfile?.hash === r.env.packages.hash && "bg-surface-2 text-text",
                        )}
                        onClick={() => toggleLockfile(r.env!.packages!.hash)}
                        aria-pressed={lockfile?.hash === r.env.packages.hash}
                      >
                        <Package size={16} aria-hidden="true" /> {r.env.packages.count} 个依赖包
                      </button>
                    </Tooltip>
                  )}
                  {r.log && <Tooltip content={r.log} kind="label" whenTruncated><span className="truncate">{r.log}</span></Tooltip>}
                  <span className="flex-1" />
                  {r.content && (
                    <Tooltip content="在对话中讨论旧版代码记录">
                      <button className="flex items-center gap-1 text-link hover:underline" onClick={() => reproduce(r)}>
                        <RotateCcw size={16} aria-hidden="true" /> 发起后续分析
                      </button>
                    </Tooltip>
                  )}
                  {r.sessionId && (
                    <Tooltip content="打开此版本的来源对话">
                      <button className="flex items-center gap-1 text-link hover:underline" onClick={() => navigate(`/app/chat/${r.sessionId}`)}>
                        <MessageSquare size={16} aria-hidden="true" /> 打开对话
                      </button>
                    </Tooltip>
                  )}
                </div>
                {r.env?.packages && lockfile?.hash === r.env.packages.hash && (
                  <div className="rounded-input border border-border bg-surface-2">
                    <div className="border-b border-border px-2.5 py-1 text-caption text-muted">
                      pip freeze · {r.env.packages.count} 个依赖包
                    </div>
                    {lockfile.text === null ? (
                      <div className="flex items-center gap-2 px-2.5 py-2 text-caption text-muted">
                        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> 正在加载
                      </div>
                    ) : (
                      <pre className="max-h-48 overflow-auto px-2.5 py-2 font-mono text-caption leading-relaxed text-text">
                        {lockfile.text}
                      </pre>
                    )}
                  </div>
                )}
                {r.content ? (
                  <CodeViewer code={r.content} language={language} />
                ) : (
                  <div className={cn("text-caption text-muted")}>
                    此版本未记录文本内容（可能是二进制文件或由代码运行生成）。
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
