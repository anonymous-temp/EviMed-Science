import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, CornerDownLeft, NotebookPen, Square, X } from "lucide-react";
import type { NotebookCell, NotebookInspector as NotebookInspectorT } from "@ai4s/shared";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { PaneTitlebarInset } from "./RightPane";
import { formatExecResult, kernelExecute, KERNEL_UNAVAILABLE_MESSAGE, kernelReset } from "@/lib/kernel";
import { useScrollMemory } from "@/lib/scrollMemory";
import { hasCommandBackend, hasWebApi, isTauri } from "@/lib/apiClient";

export function NotebookInspector({
  data,
  onClose,
  onEvaluate,
  controls,
}: {
  data: NotebookInspectorT;
  onClose: () => void;
  /** Forward the expression to the agent's live kernel (live session only). */
  onEvaluate?: (expr: string) => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const hostedWeb = hasWebApi && !isTauri;
  const kernelActionsEnabled = !hostedWeb || hasCommandBackend;
  const [cells, setCells] = useState<NotebookCell[]>(data.cells);
  const [expr, setExpr] = useState("");
  const [busy, setBusy] = useState(false);
  const interruptRef = useRef(false);
  // Viewing position, restored when this notebook is reopened.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `nb:${data.name}`);

  const evaluate = async () => {
    if (!kernelActionsEnabled) return;
    const code = expr.trim();
    if (!code || busy) return;
    const nextIndex = (cells[cells.length - 1]?.index ?? 0) + 1;
    setCells((c) => [...c, { index: nextIndex, language: "python", code, output: "执行中…" }]);
    setExpr("");

    const setOutput = (output: string) =>
      setCells((c) => c.map((cell) => (cell.index === nextIndex ? { ...cell, output } : cell)));

    setBusy(true);
    try {
      const res = await kernelExecute(code);
      if (interruptRef.current) {
        setOutput(hostedWeb ? "已中断——隔离执行已停止。" : "已中断——计算内核已重启。");
      } else if (res) setOutput(formatExecResult(res));
      else if (onEvaluate) {
        onEvaluate(code);
        setOutput("→ 已发送到科研助手的计算内核");
      } else {
        setOutput(KERNEL_UNAVAILABLE_MESSAGE);
      }
    } catch (e) {
      setOutput(`计算内核错误：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      interruptRef.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    interruptRef.current = true;
    try {
      await kernelReset("python");
    } catch {
      /* evaluate reports the execution outcome */
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void evaluate();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <NotebookPen size={14} strokeWidth={1.5} className="text-text" />
        <span className="text-sm font-medium text-text">计算文档</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label="关闭预览" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="rounded-input bg-surface-2 px-2 py-1 text-sm font-medium text-text">
          {data.name}
        </span>
        <span className="text-sm text-muted">与科研助手共享</span>
        <div className="flex-1" />
        {data.live && (
          <span className="flex items-center gap-1 text-sm text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" /> 实时
            <ChevronDown size={14} />
          </span>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
        {cells.map((cell) => (
          <div key={cell.index} className="mb-4">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              <span className="font-mono">[{cell.index}]</span>
              <span>{cell.language}</span>
            </div>
            <CodeViewer code={cell.code} language={cell.language} startLine={1} />
            {cell.output && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-muted">&gt; 输出</div>
                <pre className="whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-ui-sm text-text">
                  {cell.output}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <footer className="border-t border-border px-4 py-3">
        <div className="text-sm font-medium text-text">{data.kernelLabel}</div>
        <div className="mt-1 mb-2 text-xs leading-relaxed text-muted">{data.kernelNote}</div>
        {!kernelActionsEnabled ? (
          <div className="rounded-input border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            当前无法执行计算文档内核。
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
            <span className="font-mono text-xs text-muted">&gt;&gt;&gt;</span>
            <input
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入表达式并按回车"
              className="flex-1 bg-transparent font-mono text-ui text-text outline-none placeholder:text-muted"
              aria-label="计算表达式"
            />
            {busy ? (
              <button className="text-error hover:opacity-70" aria-label="停止计算" onClick={() => void stop()}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                className="text-muted hover:text-text disabled:opacity-30"
                aria-label="运行表达式"
                onClick={() => void evaluate()}
                disabled={!expr.trim()}
              >
                <CornerDownLeft size={15} />
              </button>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
