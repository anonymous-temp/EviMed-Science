import { useCallback, useEffect, useState } from "react";
import { Check, Download, FolderPlus, RefreshCw, Trash2, X } from "lucide-react";
import {
  createWebProject,
  deleteWebProject,
  exportWebProject,
  fetchWebMe,
  getWebProjectId,
  listWebProjects,
  setWebProjectId,
  type WebProject,
} from "@/lib/apiClient";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function WebProjectsCard({
  onProjectChange,
}: {
  onProjectChange?: (project: WebProject) => void;
}) {
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [currentId, setCurrentId] = useState(() => getWebProjectId());
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebProject | null>(null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listWebProjects();
      setProjects(items);
      setCurrentId(getWebProjectId());
    } catch (e) {
      toast.error(`无法读取托管项目：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchProject = async (project: WebProject) => {
    if (project.id === currentId) return;
    setSwitchingId(project.id);
    try {
      await useRuntimeStore.getState().switchHostedProject(project.id);
      setCurrentId(project.id);
      onProjectChange?.(project);
    } catch (e) {
      setCurrentId(getWebProjectId());
      toast.error(`无法切换托管项目：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitchingId(null);
    }
  };

  const createProject = async () => {
    const id = newId.trim();
    const name = newName.trim() || id;
    if (!PROJECT_ID_RE.test(id)) {
      setCreateError("只能使用字母、数字、连字符或下划线。");
      return;
    }
    setCreateError(null);
    setSwitchingId(id);
    try {
      const project = await createWebProject(id, name);
      setProjects(await listWebProjects());
      setNewId("");
      setNewName("");
      await switchProject(project);
    } catch (e) {
      toast.error(`无法创建托管项目：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitchingId(null);
    }
  };

  const exportProject = async (project: WebProject) => {
    setBusyProjectId(project.id);
    try {
      const blob = await exportWebProject(project.id);
      downloadBlob(
        blob,
        `evimed-project-${project.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`,
      );
      toast.success(`已导出 ${project.name}。`);
    } catch (e) {
      toast.error(`无法导出托管项目：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyProjectId(null);
    }
  };

  const confirmDeleteProject = async () => {
    if (!pendingDelete || pendingDelete.id === "default") return;
    const project = pendingDelete;
    setBusyProjectId(project.id);
    try {
      await deleteWebProject(project.id);
      const items = await listWebProjects();
      setProjects(items);
      setPendingDelete(null);
      if (currentId === project.id) {
        const nextProject = items.find((item) => item.id === "default") ?? items[0];
        if (nextProject) {
          useRuntimeStore.getState().resetProjectState();
          setWebProjectId(nextProject.id);
          setCurrentId(nextProject.id);
          const me = await fetchWebMe();
          if (!me || me.project.id !== nextProject.id || !(await useRuntimeStore.getState().bootstrap())) {
            throw new Error("回退项目的运行时无法启动。");
          }
          onProjectChange?.(nextProject);
        }
      }
      toast.success(`已删除 ${project.name}。`);
    } catch (e) {
      toast.error(`无法删除托管项目：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyProjectId(null);
    }
  };

  const currentProject = projects.find((project) => project.id === currentId);
  const controlsDisabled = loading || switchingId != null || busyProjectId != null;

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-body text-text">托管项目</h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {currentProject ? `${currentProject.name} · ${currentProject.id}` : currentId}
          </p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新项目列表"
          aria-label="刷新项目列表"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </header>
      <div className="px-5 py-4">
        <div className="overflow-hidden rounded-input border border-border">
          {projects.length === 0 ? (
            <p className="bg-surface px-3 py-2.5 text-ui text-muted">未找到托管项目。</p>
          ) : (
            projects.map((project, index) => {
              const selected = project.id === currentId;
              const switching = switchingId === project.id;
              const busy = busyProjectId === project.id;
              return (
                <div
                  key={project.id}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-1.5 bg-surface px-3 py-1.5 text-ui",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <button
                    className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-input px-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                    onClick={() => void switchProject(project)}
                    disabled={controlsDisabled || selected}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        selected ? "bg-ok" : "bg-muted",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-text">{project.name}</span>
                      <span className="block truncate font-mono text-caption text-muted">{project.id}</span>
                    </span>
                    {selected ? (
                      <Check size={14} className="shrink-0 text-ok" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted">
                        {switching ? "切换中…" : "使用"}
                      </span>
                    )}
                  </button>
                  <button
                    className={iconButtonCls}
                    onClick={() => void exportProject(project)}
                    disabled={controlsDisabled}
                    title={`导出 ${project.name}`}
                    aria-label={`导出 ${project.name}`}
                  >
                    <Download size={13} className={cn(busy && "animate-pulse")} />
                  </button>
                  <button
                    className={cn(iconButtonCls, "hover:text-error")}
                    onClick={() => setPendingDelete(project)}
                    disabled={controlsDisabled || project.id === "default"}
                    title={project.id === "default" ? "默认项目不可删除" : `删除 ${project.name}`}
                    aria-label={`删除 ${project.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {pendingDelete && (
          <div className="mt-3 rounded-input border border-error/30 bg-error/5 p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium text-text">删除 {pendingDelete.name}？</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  将删除该项目的全部工作区文件、项目元数据、任务状态、运行时状态与日志。
                </p>
              </div>
              <button
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface hover:text-text"
                onClick={() => setPendingDelete(null)}
                disabled={busyProjectId === pendingDelete.id}
                title="取消删除"
                aria-label="取消项目删除"
              >
                <X size={13} />
              </button>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                className="h-8 rounded-input border border-border px-3 text-xs text-muted hover:bg-surface hover:text-text disabled:opacity-50"
                onClick={() => setPendingDelete(null)}
                disabled={busyProjectId === pendingDelete.id}
              >
                取消
              </button>
              <button
                className="h-8 rounded-input bg-error px-3 text-xs font-medium text-error-fg hover:opacity-90 disabled:opacity-50"
                onClick={() => void confirmDeleteProject()}
                disabled={busyProjectId === pendingDelete.id}
              >
                {busyProjectId === pendingDelete.id ? "正在删除…" : "删除项目"}
              </button>
            </div>
          </div>
        )}

        <form
          className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void createProject();
          }}
        >
          <input
            className={inputCls("font-mono")}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="project-id"
            aria-label="项目 id"
            disabled={controlsDisabled}
          />
          <input
            className={inputCls()}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
            disabled={controlsDisabled}
          />
          <button
            className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-input bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
            type="submit"
            disabled={controlsDisabled || !newId.trim()}
          >
            <FolderPlus size={13} />
            创建
          </button>
        </form>
        {createError && <p className="mt-2 text-xs text-error">{createError}</p>}
      </div>
    </section>
  );
}

const inputCls = (extra = "") =>
  cn(
    "h-9 min-w-0 rounded-input border border-border bg-surface px-3 text-ui text-text outline-none",
    "placeholder:text-muted focus:border-accent/60 disabled:opacity-50",
    extra,
  );

const iconButtonCls =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40";

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
