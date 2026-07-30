import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MessageSquare, Package, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
import type { ProvenanceRecord } from "@ai4s/shared";
import { listProvenance, readEnvLockfile } from "@/lib/provenance";
import { useUiStore } from "@/lib/store";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { cn } from "@/lib/cn";

/** The prompt the Reproduce action drafts — prefilled, reviewed, user-sent. */
export function reproducePrompt(r: ProvenanceRecord): string {
  const pkgs = r.env?.packages;
  const pkgNote = pkgs
    ? ` 该环境安装了 ${pkgs.count} 个 Python 包，记录在 \`.openscience/env/${pkgs.hash}.txt\`；如复现结果不同，请按锁定文件安装相同版本后重试。`
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
    ? " 注意：下方记录代码因存储上限被截断；复现前请先从 `.openscience/provenance.jsonl` 读取 " +
      `\`${r.path}\` 的完整记录。`
    : "";
  return (
    `复现 \`${r.path}\`（来源记录 v${r.version}）。${env} ` +
    `重新运行下方记录的生成代码，再把新生成的文件与当前 \`${r.path}\` 比较，` +
    `说明二者是否一致；如不一致，请列出变化。` +
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
export function ProvenancePanel({ path, language }: { path: string; language?: string }) {
  const [records, setRecords] = useState<ProvenanceRecord[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  // The package lockfile currently shown, keyed by its content hash.
  const [lockfile, setLockfile] = useState<{ hash: string; text: string | null } | null>(null);
  const navigate = useNavigate();
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

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
  // the user reviews and sends it (human in the loop, never auto-run).
  const reproduce = (r: ProvenanceRecord) => {
    setComposerDraft(reproducePrompt(r));
    navigate(r.sessionId ? `/live/${r.sessionId}` : "/live");
  };

  useEffect(() => {
    let cancelled = false;
    setRecords(null);
    void listProvenance(path).then((r) => {
      if (cancelled) return;
      setRecords([...r].reverse()); // newest first
      setExpanded(r.length > 0 ? r[r.length - 1].version : null);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (records === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> 正在加载版本记录…
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="p-4 text-sm text-muted">
        暂无版本记录。科研助手每次写入 <span className="font-mono text-text">{path}</span> 时，
        系统都会记录对应的代码、模型和来源对话。
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
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              onClick={() => setExpanded(open ? null : r.version)}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown size={14} className="shrink-0 text-muted" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-muted" />
              )}
              <span className="rounded bg-surface-2 px-1.5 text-xs font-medium text-text">
                v{r.version}
              </span>
              <span className="font-mono text-xs text-muted">{r.tool}</span>
              <span className="flex-1" />
              <span className="text-xs text-muted">{formatTs(r.ts)}</span>
            </button>
            {open && (
              <div className="space-y-2 border-t border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {r.model && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{r.model}</span>
                  )}
                  {r.env && (
                    <span
                      className="rounded bg-surface-2 px-1.5 py-0.5 font-mono"
                      title="此版本的运行环境"
                    >
                      {[r.env.python && `py ${r.env.python}`, r.env.platform, `app ${r.env.app}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  {r.env?.packages && (
                    <button
                      className={cn(
                        "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono hover:bg-surface-2 hover:text-text",
                        lockfile?.hash === r.env.packages.hash && "bg-surface-2 text-text",
                      )}
                      onClick={() => toggleLockfile(r.env!.packages!.hash)}
                      title="查看此版本的 Python 依赖锁定文件"
                      aria-pressed={lockfile?.hash === r.env.packages.hash}
                    >
                      <Package size={11} /> {r.env.packages.count} 个依赖包
                    </button>
                  )}
                  {r.log && <span className="truncate">{r.log}</span>}
                  <span className="flex-1" />
                  {r.content && (
                    <button
                      className="flex items-center gap-1 text-link hover:underline"
                      onClick={() => reproduce(r)}
                      title="生成复现此版本并比较结果的任务"
                    >
                      <RotateCcw size={12} /> 复现
                    </button>
                  )}
                  {r.sessionId && (
                    <button
                      className="flex items-center gap-1 text-link hover:underline"
                      onClick={() => navigate(`/live/${r.sessionId}`)}
                      title="打开此版本的来源对话"
                    >
                      <MessageSquare size={12} /> 打开对话
                    </button>
                  )}
                </div>
                {r.env?.packages && lockfile?.hash === r.env.packages.hash && (
                  <div className="rounded-input border border-border bg-surface-2">
                    <div className="border-b border-border px-2.5 py-1 text-caption text-muted">
                      pip freeze · {r.env.packages.count} 个依赖包
                    </div>
                    {lockfile.text === null ? (
                      <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted">
                        <Loader2 size={12} className="animate-spin" /> 正在加载…
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
                  <div className={cn("text-xs text-muted")}>
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
