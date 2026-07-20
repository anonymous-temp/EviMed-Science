import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, Plus } from "lucide-react";
import { isTauri, pickFolder } from "@/lib/tauri";
import { datedWorkspaceName, useRuntimeStore } from "@/lib/runtime";
import {
  createWebProject,
  getWebProjectId,
  hasCommandBackend,
  listWebProjects,
  type WebProject,
} from "@/lib/apiClient";

/** Last path segment of the workspace folder, or "工作区" when unknown. */
export function baseName(path: string | null): string {
  if (!path) return "工作区";
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "工作区";
}

/**
 * Folder picker for a fresh draft, rendered in the Composer action row. A
 * draft starts in a new dated folder by default — the chip opens the native
 * picker for anyone who wants a specific folder instead (the pick pins it).
 * Once the session exists its folder is a fact, not a choice — the header's
 * Files toggle names it, so the chip disappears.
 */
export function WorkspaceChip() {
  const workspace = useRuntimeStore((s) => s.workspace);
  const currentId = useRuntimeStore((s) => s.currentId);
  const workspacePinned = useRuntimeStore((s) => s.workspacePinned);
  const switchWorkspace = useRuntimeStore((s) => s.switchWorkspace);
  const sending = useRuntimeStore((s) => s.sending);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (currentId) return null;

  if (!isTauri && hasCommandBackend) {
    const loadProjects = async () => {
      setLoadingProjects(true);
      setError(null);
      try {
        setProjects(await listWebProjects());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingProjects(false);
      }
    };

    const openMenu = () => {
      setMenuOpen((open) => !open);
      if (!menuOpen) void loadProjects();
    };

    const switchProject = async (projectId: string) => {
      const current = getWebProjectId();
      if (!projectId || projectId === current) {
        setMenuOpen(false);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await useRuntimeStore.getState().switchHostedProject(projectId);
        setMenuOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    const createProject = async () => {
      const id = newProjectId.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
        setError("只能使用字母、数字、连字符或下划线。");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const project = await createWebProject(id, id);
        setProjects(await listWebProjects());
        setNewProjectId("");
        await switchProject(project.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    const current = getWebProjectId();
    const currentProject = projects.find((project) => project.id === current);

    return (
      <div className="relative" ref={menuRef}>
        <button
          className="flex items-center gap-1 rounded-input px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-60"
          onClick={openMenu}
          disabled={busy || sending}
          title="选择托管项目工作区"
          aria-label="选择项目工作区"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <FolderOpen size={14} className="shrink-0" />
          <span className="max-w-[200px] truncate">
            {busy ? "正在切换…" : (currentProject?.name ?? current)}
          </span>
          <ChevronDown size={12} className="shrink-0 opacity-70" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-card border border-border bg-surface py-1 shadow-pop"
          >
            <div className="max-h-56 overflow-y-auto py-1">
              {loadingProjects && (
                <div className="px-3 py-2 text-xs text-muted">正在加载…</div>
              )}
              {!loadingProjects &&
                projects.map((project) => (
                  <button
                    key={project.id}
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text hover:bg-surface-2"
                    onClick={() => void switchProject(project.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.name}</span>
                      <span className="block truncate text-caption text-muted">{project.id}</span>
                    </span>
                    {project.id === current && <Check size={13} className="shrink-0 text-accent" />}
                  </button>
                ))}
            </div>
            <div className="border-t border-border p-2">
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createProject();
                }}
              >
                <input
                  className="min-w-0 flex-1 rounded-input border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
                  value={newProjectId}
                  onChange={(e) => setNewProjectId(e.target.value)}
                  placeholder="new-project"
                  aria-label="新项目 id"
                  disabled={busy}
                />
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-input bg-accent text-accent-fg hover:opacity-90 disabled:opacity-50"
                  type="submit"
                  title="创建项目"
                  aria-label="创建项目"
                  disabled={busy || !newProjectId.trim()}
                >
                  <Plus size={14} />
                </button>
              </form>
              {error && <div className="mt-1 text-caption text-error">{error}</div>}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!isTauri) return null;

  const choose = async () => {
    const dir = await pickFolder();
    if (!dir) return; // cancelled — keep the current destination
    setBusy(true);
    try {
      await switchWorkspace({ path: dir }); // an explicit pick pins the folder
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="flex items-center gap-1 rounded-input px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-60"
      onClick={() => void choose()}
      disabled={busy || sending}
      title={
        workspacePinned
          ? `${workspace ?? ""} — 点击选择其他文件夹`
          : `默认在新建的日期文件夹（${datedWorkspaceName()}）中开始 — 点击改为选择文件夹`
      }
      aria-label="选择会话文件夹"
    >
      <FolderOpen size={14} className="shrink-0" />
      {busy ? (
        <span>正在切换…</span>
      ) : (
        workspacePinned && <span className="max-w-[200px] truncate">{baseName(workspace)}</span>
      )}
    </button>
  );
}
