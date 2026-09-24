import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  webErrorMessage,
  deleteWebProject,
  exportWebProject,
  getWebProjectId,
  listWebProjects,
  type WebProject,
} from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { PROJECT_EXPLAINER, PROJECT_NAME_MAX, projectErrorMessage, projectMetaLine, projectNameProblem } from "@/lib/projectNames";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

/** The project every account has and cannot delete. Its name is 「我的研究」. */
const DEFAULT_PROJECT_ID = "default";

/**
 * Refusals the error registry has no sentence for, in the reader's words.
 * Deleting is refused while the project still has work queued or running.
 */
const DELETE_ERRORS = {
  project_busy: "这个项目还有排队或运行中的任务，等它们结束或取消后再删除。",
  default_project_protected: "「我的研究」是每个账号都有的项目，不能删除。",
};

/**
 * The account page's view of every project: what each holds (how many runs,
 * when it was last used), and the operations that belong on a management page
 * rather than in the sidebar — rename, export, delete.
 *
 * A project is created from its name alone, in any language. The id field this
 * card used to ask for, and to print under every name, was the server's key; it
 * is not something a researcher chooses or needs to read (review B §2).
 */
export function WebProjectsCard({
  onProjectChange,
}: {
  onProjectChange?: (project: WebProject) => void;
}) {
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [currentId, setCurrentId] = useState(() => getWebProjectId());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebProject | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listWebProjects();
      setProjects(items);
      setCurrentId(getWebProjectId());
      setLoadError(null);
    } catch (e) {
      setLoadError(webErrorMessage(e, { fallback: "项目列表暂时读不到，请稍后刷新。" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The sidebar's project list reads the shared store; without this it kept
  // the list from before a change made here (2026-09-16 review, D2).
  const refreshSidebar = () => {
    void useProjectStore.getState().load();
  };

  const switchProject = async (project: WebProject) => {
    if (project.id === currentId) return;
    setSwitchingId(project.id);
    try {
      await useProjectStore.getState().select(project.id);
      setCurrentId(project.id);
      onProjectChange?.(project);
    } catch (e) {
      setCurrentId(getWebProjectId());
      toast.error(`没能切换到「${project.name}」：${webErrorMessage(e)}`);
    } finally {
      setSwitchingId(null);
    }
  };

  const createProject = async () => {
    const problem = projectNameProblem(newName);
    if (problem) {
      setCreateError(problem);
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const project = await useProjectStore.getState().create(newName);
      setProjects(await listWebProjects());
      refreshSidebar();
      setNewName("");
      await switchProject(project);
    } catch (e) {
      setCreateError(projectErrorMessage(e, projects.length, "项目没有建成，请稍后重试。"));
    } finally {
      setCreating(false);
    }
  };

  const startRename = (project: WebProject) => {
    setRenamingId(project.id);
    setRenameDraft(project.name);
    setRenameError(null);
  };

  const submitRename = async (project: WebProject) => {
    const problem = projectNameProblem(renameDraft);
    if (problem) {
      setRenameError(problem);
      return;
    }
    if (renameDraft.trim() === project.name) {
      setRenamingId(null);
      return;
    }
    setBusyProjectId(project.id);
    try {
      const renamed = await useProjectStore.getState().rename(project.id, renameDraft);
      setProjects((items) => items.map((item) => (item.id === project.id ? { ...item, ...renamed } : item)));
      setRenamingId(null);
      setRenameError(null);
    } catch (e) {
      setRenameError(projectErrorMessage(e, projects.length, "项目名没有改成功，请稍后重试。"));
    } finally {
      setBusyProjectId(null);
    }
  };

  const exportProject = async (project: WebProject) => {
    setBusyProjectId(project.id);
    try {
      const blob = await exportWebProject(project.id);
      downloadBlob(blob, `evimed-project-${project.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`);
      toast.success(`已导出「${project.name}」。`);
    } catch (e) {
      toast.error(`没能导出「${project.name}」：${webErrorMessage(e)}`);
    } finally {
      setBusyProjectId(null);
    }
  };

  const confirmDeleteProject = async () => {
    if (!pendingDelete || pendingDelete.id === DEFAULT_PROJECT_ID) return;
    const project = pendingDelete;
    setPendingDelete(null);
    setBusyProjectId(project.id);
    try {
      await deleteWebProject(project.id);
      const items = await listWebProjects();
      setProjects(items);
      if (currentId === project.id) {
        // The shell was in the project that is gone, so it moves — in place,
        // through the store the sidebar and every page are keyed on. This used
        // to set the request header alone, which left the sidebar and the page
        // on a project that no longer exists. A refused move is not a failed
        // deletion: the list refresh below falls back to 「我的研究」 by itself.
        const nextProject = items.find((item) => item.id === DEFAULT_PROJECT_ID) ?? items[0];
        if (nextProject && await useProjectStore.getState().select(nextProject.id).then(() => true, () => false)) {
          setCurrentId(nextProject.id);
          onProjectChange?.(nextProject);
        }
      }
      refreshSidebar();
      toast.success(`已删除「${project.name}」。`);
    } catch (e) {
      toast.error(`没能删除「${project.name}」：${webErrorMessage(e, { codes: DELETE_ERRORS })}`);
    } finally {
      setBusyProjectId(null);
    }
  };

  const controlsDisabled = loading || creating || switchingId != null || busyProjectId != null;

  return (
    <section className="mt-5 rounded-card border border-border bg-surface">
      <header className="flex items-start gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-body text-text">项目</h2>
          <p className="mt-0.5 text-caption text-muted">{PROJECT_EXPLAINER}</p>
        </div>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted transition-colors duration-fast hover:bg-surface-2 hover:text-text disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新项目列表"
          aria-label="刷新项目列表"
        >
          <RefreshCw size={16} className={cn(loading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        </button>
      </header>
      <div className="px-5 py-4">
        {loadError && (
          <p role="alert" className="mb-3 rounded-input border border-strong bg-warn-soft px-3 py-2 text-ui text-text">
            {loadError}
          </p>
        )}
        <ul aria-label="项目列表" className="overflow-hidden rounded-input border border-border">
          {projects.length === 0 && !loading && !loadError && (
            <li className="px-3 py-2.5 text-ui text-muted">还没有项目。</li>
          )}
          {projects.length === 0 && loading && <li className="px-3 py-2.5 text-ui text-muted">正在读取项目…</li>}
          {projects.map((project, index) => {
            const selected = project.id === currentId;
            const busy = busyProjectId === project.id;
            const renaming = renamingId === project.id;
            return (
              <li
                key={project.id}
                className={cn("flex min-h-14 items-center gap-2 bg-surface px-3 py-2 text-ui", index > 0 && "border-t border-border")}
              >
                {renaming ? (
                  <form
                    className="min-w-0 flex-1"
                    onSubmit={(event) => { event.preventDefault(); void submitRename(project); }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        ref={renameRef}
                        className={inputCls("flex-1")}
                        value={renameDraft}
                        maxLength={PROJECT_NAME_MAX}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") { setRenamingId(null); setRenameError(null); }
                        }}
                        aria-label={`「${project.name}」的新名字`}
                        disabled={busy}
                      />
                      <button type="submit" className={primaryButtonCls} disabled={busy}>
                        {busy ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        className={secondaryButtonCls}
                        onClick={() => { setRenamingId(null); setRenameError(null); }}
                        disabled={busy}
                      >
                        取消
                      </button>
                    </div>
                    {renameError && <p role="alert" className="mt-1 text-caption text-error">{renameError}</p>}
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-text">{project.name}</span>
                        {selected && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-2 text-caption text-accent-strong">
                            当前
                          </span>
                        )}
                      </p>
                      <p className="truncate text-caption text-muted">{projectMetaLine(project)}</p>
                    </div>
                    {!selected && (
                      <button
                        type="button"
                        className={secondaryButtonCls}
                        onClick={() => void switchProject(project)}
                        disabled={controlsDisabled}
                        aria-label={`切换到「${project.name}」`}
                      >
                        {switchingId === project.id ? "切换中…" : "切换"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={iconButtonCls}
                      onClick={() => startRename(project)}
                      disabled={controlsDisabled}
                      title="重命名"
                      aria-label={`重命名「${project.name}」`}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={iconButtonCls}
                      onClick={() => void exportProject(project)}
                      disabled={controlsDisabled}
                      title="导出为压缩包"
                      aria-label={`导出「${project.name}」`}
                    >
                      <Download size={16} className={cn(busy && "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={cn(iconButtonCls, "hover:text-error")}
                      onClick={() => setPendingDelete(project)}
                      disabled={controlsDisabled || project.id === DEFAULT_PROJECT_ID}
                      title={project.id === DEFAULT_PROJECT_ID ? "每个账号都有这个项目，不能删除" : "删除"}
                      aria-label={`删除「${project.name}」`}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <label htmlFor="projects-card-new-name" className="mb-1 block text-caption text-muted">
            新建项目
          </label>
          <div className="flex gap-2">
            <input
              id="projects-card-new-name"
              className={inputCls("flex-1")}
              value={newName}
              maxLength={PROJECT_NAME_MAX}
              onChange={(event) => { setNewName(event.target.value); setCreateError(null); }}
              placeholder="项目名，任何语言都可以，例如：阿司匹林一级预防"
              disabled={controlsDisabled}
            />
            <button type="submit" className={cn(primaryButtonCls, "gap-1.5")} disabled={controlsDisabled || !newName.trim()}>
              <FolderPlus size={16} aria-hidden="true" />
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
          {createError && <p role="alert" className="mt-2 text-caption text-error">{createError}</p>}
        </form>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`删除项目「${pendingDelete.name}」？`}
          body="这个项目的全部工作区文件、对话与产出、研究环境状态与日志都会删除，无法恢复。需要留底的话，先导出一份。"
          confirmLabel="删除项目"
          onConfirm={() => void confirmDeleteProject()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}

const inputCls = (extra = "") =>
  cn(
    "h-9 min-w-0 rounded-input border border-strong bg-surface px-3 text-ui text-text outline-none",
    "placeholder:text-muted focus:border-focus disabled:opacity-50",
    extra,
  );

const primaryButtonCls =
  "flex h-9 shrink-0 items-center justify-center rounded-input bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-50";

const secondaryButtonCls =
  "flex h-8 shrink-0 items-center justify-center rounded-input border border-strong px-3 text-ui text-text hover:bg-surface-2 disabled:opacity-50";

const iconButtonCls =
  "grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted transition-colors duration-fast hover:bg-surface-2 hover:text-text disabled:opacity-40";

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
