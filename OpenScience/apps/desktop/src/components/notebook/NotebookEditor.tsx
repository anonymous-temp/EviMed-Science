import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, History, Loader2, NotebookPen, Play, Plus, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { NotebookCell } from "@ai4s/shared";
import { readArtifact, writeWorkspaceFile } from "@/lib/artifactFile";
import { ProvenancePanel } from "@/components/inspector/ProvenancePanel";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { parseIpynb, serializeIpynb, notebookLanguage } from "@/lib/notebook-file";
import {
  formatExecResult,
  isCodeLanguage,
  kernelExecute,
  KERNEL_UNAVAILABLE_MESSAGE,
  kernelReset,
  type KernelLanguage,
} from "@/lib/kernel";
import { hasCommandBackend, hasWebApi, isTauri } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { useScrollMemory } from "@/lib/scrollMemory";
import { cn } from "@/lib/cn";

/**
 * Runnable editor for a real workspace .ipynb. Used full-page (Notebooks page)
 * and as the right-pane inspector next to a conversation — the agent edits the
 * same file, so Reload picks up its changes.
 */
export function NotebookEditor({
  path,
  root,
  onBack,
  onClose,
  controls,
}: {
  path: string;
  /** Folder tree `path` resolves in (default the active workspace). The
   *  kernel also runs with the notebook's own folder as cwd. */
  root?: "workspace" | "base";
  /** Back navigation (full-page use). */
  onBack?: () => void;
  /** Close the pane (inspector use). */
  onClose?: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const hostedWeb = hasWebApi && !isTauri;
  const kernelActionsEnabled = !hostedWeb || hasCommandBackend;
  const [cells, setCells] = useState<NotebookCell[] | null>(null);
  const [language, setLanguage] = useState<KernelLanguage>("python");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [saved, setSaved] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const cellsRef = useRef<NotebookCell[] | null>(null);
  cellsRef.current = cells;
  const rawRef = useRef<string | null>(null);
  const savedRef = useRef(true);
  savedRef.current = saved;

  const load = useCallback(async () => {
    setError(null);
    try {
      const f = await readArtifact(path, root);
      if (!f || f.encoding !== "utf8") throw new Error("无法读取该笔记本");
      rawRef.current = f.data;
      setLanguage(notebookLanguage(f.data));
      setCells(parseIpynb(f.data));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path, root]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the agent live: while the user isn't mid-edit, poll the file and
  // reload when its content changed on disk (the agent writes via Jupyter).
  useEffect(() => {
    const t = setInterval(() => {
      if (!savedRef.current) return; // never clobber unsaved local edits
      void (async () => {
        try {
          const f = await readArtifact(path, root);
          if (f && f.encoding === "utf8" && rawRef.current !== null && f.data !== rawRef.current) {
            rawRef.current = f.data;
            setLanguage(notebookLanguage(f.data));
            setCells(parseIpynb(f.data));
          }
        } catch {
          /* transient read failures are fine */
        }
      })();
    }, 2000);
    return () => clearInterval(t);
  }, [path, root]);

  const save = useCallback(async () => {
    const current = cellsRef.current;
    if (!current) return;
    try {
      const out = serializeIpynb(current);
      await writeWorkspaceFile(path, out, root);
      rawRef.current = out; // our own write is not an external change
      setSaved(true);
    } catch (e) {
      toast.error(`无法保存：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [path, root]);

  // Debounced autosave: runs AFTER React commits the latest cells, so the file
  // always gets the freshest state (saving inside handlers would race setState).
  useEffect(() => {
    if (saved || !cells) return;
    const t = setTimeout(() => void save(), 500);
    return () => clearTimeout(t);
  }, [cells, saved, save]);

  const update = (index: number, patch: Partial<NotebookCell>) => {
    setCells((c) => c?.map((cell) => (cell.index === index ? { ...cell, ...patch } : cell)) ?? null);
    setSaved(false);
  };

  // True while a user-requested Stop is in flight, so the resulting kernel
  // error renders as "Interrupted", not as a crash.
  const interruptRef = useRef(false);
  const runningLanguageRef = useRef<KernelLanguage>(language);

  const run = async (cell: NotebookCell) => {
    if (!kernelActionsEnabled || running !== null) return;
    const lang = isCodeLanguage(cell.language) ? cell.language : language;
    runningLanguageRef.current = lang;
    setRunning(cell.index);
    update(cell.index, { output: "正在运行…" });
    try {
      const res = await kernelExecute(cell.code, lang, path, root);
      update(cell.index, {
        output: interruptRef.current
          ? hostedWeb
            ? "已中断——服务端隔离执行已停止。"
            : "已中断——内核已重启，变量已重置。"
          : res
            ? formatExecResult(res)
            : KERNEL_UNAVAILABLE_MESSAGE,
      });
    } catch (e) {
      update(cell.index, {
        output: interruptRef.current
          ? hostedWeb
            ? "已中断——服务端隔离执行已停止。"
            : "已中断——内核已重启，变量已重置。"
          : `内核错误：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      interruptRef.current = false;
      setRunning(null);
    }
  };

  // Stop a hung cell: kill THIS notebook's kernel — the blocked execute then
  // errors out and `run` reports the interruption. Reset is best-effort.
  const stop = async () => {
    if (!kernelActionsEnabled) return;
    interruptRef.current = true;
    try {
      await kernelReset(runningLanguageRef.current, path, root);
    } catch {
      /* the execute's own error path reports the state */
    }
  };

  const addCell = () => {
    setCells((c) => {
      const next = (c?.[c.length - 1]?.index ?? 0) + 1;
      return [...(c ?? []), { index: next, language, code: "" }];
    });
    setSaved(false);
  };

  const removeCell = (index: number) => {
    setCells((c) => c?.filter((cell) => cell.index !== index) ?? null);
    setSaved(false);
  };

  // Where the user was in this notebook, restored when they come back to it
  // (session switch, pane reopen) — once the cells are in, so the offset holds.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `file:${path}`, cells !== null);

  const onCellKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, cell: NotebookCell) => {
    if (!kernelActionsEnabled) return;
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
      e.preventDefault();
      void run(cell);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        {onBack && (
          <button className="text-text hover:opacity-60" aria-label="返回科研笔记本" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        <NotebookPen size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <h1 className="truncate text-ui font-medium text-text">{path}</h1>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-caption font-medium uppercase tracking-wide text-muted">
          {language === "r" ? "R" : "Python"}
        </span>
        <span className="shrink-0 text-xs text-muted">{saved ? "已保存" : "未保存"}</span>
        <div className="flex-1" />
        <span className="hidden shrink-0 text-xs text-muted xl:inline">
          {hostedWeb
            ? "Shift/⌘+Enter 在服务端隔离内核中运行单元格"
            : "Shift/⌘+Enter 运行单元格 · 与科研 Agent 共用文件"}
        </span>
        <button
          className={cn(showHistory ? "text-accent" : "text-text hover:opacity-60")}
          aria-label="版本历史"
          title="版本历史——查看保存过的代码和关联会话"
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} />
        </button>
        <button
          className="text-text hover:opacity-60"
          aria-label="从磁盘重新加载"
          title="重新加载科研 Agent 对文件的修改"
          onClick={() => void load()}
        >
          <RefreshCw size={14} strokeWidth={1.5} />
        </button>
        {controls}
        {onClose && (
          <button className="text-text hover:opacity-60" aria-label="关闭检查器" onClick={onClose}>
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {showHistory && (
        <div className="flex-1 overflow-y-auto bg-surface-2">
          <ProvenancePanel path={path} language={language} />
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className={cn("flex-1 overflow-y-auto", showHistory && "hidden")}>
        <div className="mx-auto max-w-3xl px-6 py-5">
          {error && <div className="text-sm text-error">{error}</div>}
          {!error && !cells && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> 正在加载…
            </div>
          )}
          {cells?.map((cell) => (
            <div key={cell.index} className="group mb-4">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <span className="font-mono">[{cell.index}]</span>
                <span>{cell.language}</span>
                {isCodeLanguage(cell.language) && kernelActionsEnabled &&
                  (running === cell.index ? (
                    // Always visible while running (not hover-gated): a hung
                    // cell must offer a way out without restarting the app.
                    <button
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-error hover:bg-surface-2"
                      aria-label={`停止单元格 ${cell.index}`}
                      title={hostedWeb ? "停止服务端隔离执行" : "停止并重启此笔记本内核（变量将重置）"}
                      onClick={() => void stop()}
                    >
                      <Square size={10} fill="currentColor" />
                      停止
                    </button>
                  ) : (
                    <button
                      className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-surface-2 hover:text-text group-hover:flex"
                      aria-label={`运行单元格 ${cell.index}`}
                      onClick={() => void run(cell)}
                      disabled={running !== null}
                    >
                      <Play size={11} />
                      运行
                    </button>
                  ))}
                <button
                  className="hidden rounded px-1 py-0.5 hover:bg-surface-2 hover:text-error group-hover:block"
                  aria-label={`删除单元格 ${cell.index}`}
                  onClick={() => removeCell(cell.index)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <textarea
                value={cell.code}
                onChange={(e) => update(cell.index, { code: e.target.value })}
                onKeyDown={(e) => onCellKeyDown(e, cell)}
                rows={Math.min(Math.max(cell.code.split("\n").length, 1), 14)}
                spellCheck={false}
                className={cn(
                  "w-full resize-none rounded-input border border-border bg-surface p-3 font-mono text-ui-sm leading-relaxed text-text outline-none focus:border-accent/50",
                  !isCodeLanguage(cell.language) && "bg-surface-2 text-muted",
                )}
                aria-label={`单元格 ${cell.index}`}
              />
              {cell.output && (
                <pre className="mt-1.5 whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-ui-sm text-text">
                  {cell.output}
                </pre>
              )}
              {cell.image && (
                <img
                  src={`data:image/png;base64,${cell.image}`}
                  alt={`单元格 ${cell.index} 图像`}
                  className="mt-1.5 max-w-full rounded-input border border-border bg-white p-2"
                />
              )}
            </div>
          ))}
          {cells && (
            <button
              className="flex items-center gap-1.5 rounded-input border border-dashed border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onClick={addCell}
            >
              <Plus size={12} /> 添加单元格
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
