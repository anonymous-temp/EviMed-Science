import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, NotebookPen, Plus } from "lucide-react";
import { addTextToWorkspace } from "@/lib/backend";
import { hasWebApi } from "@/lib/apiClient";
import { listNotebooks, type NotebookEntry } from "@/lib/artifactFile";
import { formatDateTime } from "@/lib/format";
import { emptyIpynb } from "@/lib/notebook-file";
import type { KernelLanguage } from "@/lib/kernel";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { Button } from "@/components/ui/Button";
import { toast } from "@/lib/toast";

/**
 * Notebooks live in session workspaces as real .ipynb files. This page is
 * GLOBAL: it lists every notebook under the base folder, across all session
 * folders, newest first. Desktop kernels run in the notebook's own folder;
 * hosted Web keeps notebook execution behind a server-side sandbox gate.
 */
export function NotebooksPage() {
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  /** Open notebook + the tree its path resolves in ("base" = listed here;
   *  "workspace" = just created in the active session folder). */
  const [open, setOpen] = useState<{ path: string; root: "workspace" | "base" } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setEntries(await listNotebooks("base"));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Close the kernel menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const createNew = async (language: KernelLanguage) => {
    setMenuOpen(false);
    try {
      const base = language === "r" ? "notebook-r.ipynb" : "notebook.ipynb";
      const name = await addTextToWorkspace(base, emptyIpynb(language));
      await refresh();
      setOpen({ path: name, root: "workspace" });
    } catch (err) {
      toast.error(`无法创建笔记本：${err instanceof Error ? err.message : String(err)}`);
    }
  };


  if (open) {
    return (
      <NotebookEditor
        path={open.path}
        root={open.root}
        onBack={() => {
          setOpen(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-6">
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-xl text-text">科研笔记本</h1>
          <div className="flex-1" />
          <div className="relative" ref={menuRef}>
            <Button
              size="sm"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={!hasWebApi}
              title="新建笔记本"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Plus size={13} aria-hidden="true" /> 新建笔记本 <ChevronDown size={12} className="opacity-80" aria-hidden="true" />
            </Button>
            {menuOpen && hasWebApi && (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-card border border-border bg-surface py-1 shadow-pop"
              >
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text hover:bg-surface-2"
                  onClick={() => void createNew("python")}
                >
                  <NotebookPen size={13} className="text-muted" /> Python 笔记本
                </button>
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text hover:bg-surface-2"
                  onClick={() => void createNew("r")}
                >
                  <NotebookPen size={13} className="text-muted" /> R 笔记本
                </button>
              </div>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted">
          {hasWebApi
            ? "管理项目中的真实 .ipynb 文件；Python 或 R 单元格在服务端隔离内核中执行，科研 Agent 可处理同一份文件。"
            : "管理所有科研会话中的 Jupyter 笔记本；单元格在笔记本目录的本地 Python 或 R 内核中执行。"}
        </p>

        <div className="mt-5 space-y-1.5">
          {entries.length === 0 && (
            <div className="rounded-card border border-border bg-surface p-5 text-sm text-muted">
              {hasWebApi
                ? hasWebApi
                  ? "暂无笔记本。可以新建、从知识库上传，或让科研 Agent 生成。"
                  : "暂无笔记本。可以新建，或让科研 Agent 生成。"
                : "当前未配置可用的笔记本后端。"}
            </div>
          )}
          {entries.map((e) => {
            const slash = e.path.lastIndexOf("/");
            const folder = slash >= 0 ? e.path.slice(0, slash) : "";
            const name = slash >= 0 ? e.path.slice(slash + 1) : e.path;
            return (
              <button
                key={e.path}
                onClick={() => setOpen({ path: e.path, root: "base" })}
                className="flex w-full items-center gap-2.5 rounded-card border border-border bg-surface px-4 py-2.5 text-left hover:bg-surface-2"
              >
                <NotebookPen size={15} className="shrink-0 text-muted" />
                <span className="truncate text-sm text-text">{name}</span>
                {folder && (
                  <span className="max-w-[40%] truncate rounded bg-surface-2 px-1.5 py-0.5 text-caption text-muted">
                    {folder}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-muted">
                  {formatDateTime(e.modified * 1000, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
