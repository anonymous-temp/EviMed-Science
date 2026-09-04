import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, FolderGit2, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { useProjectStore } from "@/lib/projects";

/** What a project id may look like — mirrors the control plane's `safeId`. */
const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * The top-level project switcher.
 *
 * Projects used to be chosen from a card buried in settings and from a chip in
 * the composer, which is two places for one decision and neither of them where
 * a person looks for it. It sits under the wordmark because it scopes
 * everything below it: the conversation, the runs, the files, the notebooks.
 */
export function ProjectSwitcher() {
  const { projects, currentId, loading, error, load, select, create } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? currentId;

  const choose = async (projectId: string) => {
    if (projectId === currentId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await select(projectId);
      setOpen(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async () => {
    const id = draftId.trim();
    if (!PROJECT_ID_RE.test(id)) {
      setFailure("项目名只能用字母、数字、连字符和下划线，且不超过 64 个字符。");
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await create(id);
      setDraftId("");
      setCreating(false);
      await select(id);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative px-3 pb-2" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`当前项目：${label}`}
        className="flex w-full items-center gap-2 rounded-input border border-border px-2 py-1.5 text-ui text-text hover:bg-surface-2"
      >
        <FolderGit2 size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronsUpDown size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 z-20 mt-1 rounded-card border border-border bg-surface py-1 shadow-pop">
          <div className="max-h-64 overflow-y-auto">
            {loading && projects.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted">正在读取项目…</div>
            )}
            {error && <div className="px-3 py-2 text-xs text-error">{error}</div>}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === currentId}
                disabled={busy}
                onClick={() => void choose(project.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text hover:bg-surface-2 disabled:opacity-50"
              >
                <Check
                  size={13}
                  strokeWidth={2}
                  className={cn("shrink-0", project.id === currentId ? "text-accent" : "invisible")}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </button>
            ))}
          </div>

          <div className="mt-1 border-t border-border pt-1">
            {creating ? (
              <div className="px-3 py-1.5">
                <input
                  autoFocus
                  value={draftId}
                  disabled={busy}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitNew();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setDraftId("");
                    }
                  }}
                  placeholder="新项目名"
                  aria-label="新项目名"
                  className="h-7 w-full rounded-input border border-border bg-bg px-2 text-xs text-text outline-none placeholder:text-muted focus:border-accent"
                />
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
                <span>新建项目</span>
              </button>
            )}
          </div>

          {failure && <div className="px-3 pb-2 pt-1 text-xs text-error">{failure}</div>}
        </div>
      )}
    </div>
  );
}
