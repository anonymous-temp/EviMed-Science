import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArchiveRestore, Download, Pencil, Plus } from "lucide-react";
import {
  archiveWebAgentRun,
  deleteWebProject,
  exportWebProject,
  getWebProjectId,
  listWebAgentRuns,
  listWebProjects,
  webErrorMessage,
  type WebAgentRun,
  type WebProject,
} from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { PROJECT_NAME_MAX, projectErrorMessage, projectMetaLine, projectNameProblem } from "@/lib/projectNames";
import { announceRunsChanged, relativeTime, runMoment, runTitle } from "@/lib/runPresentation";
import { chatPath } from "@/lib/runLocation";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { Tag } from "@/components/ui/Tag";

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

/** A row inside a settings group: the group's own padding, no row corners. */
const PANEL_ROW = "rounded-none px-4";

/**
 * 「项目」 in 设置 (2026-09-23 plan §5.9): the projects as rows — 重命名 and
 * 导出 on hover, 删除 in the row's 「⋯」 — and the conversations of this
 * project that were archived, each with 恢复.
 *
 * What went: 「切换」 on every row (clicking a project in the sidebar is the
 * switch), the explainer under the group's name, the run count, the list box
 * inside the card, the plugins card (an operator's, under 运维) and the
 * 「隐私与数据流向」 card.
 */
export function ProjectsSection() {
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [currentId, setCurrentId] = useState(() => getWebProjectId());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebProject | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renamingId) renameRef.current?.focus(); }, [renamingId]);
  useEffect(() => { if (createOpen) createRef.current?.focus(); }, [createOpen]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listWebProjects());
      setCurrentId(getWebProjectId());
      setLoadError(null);
    } catch (error) {
      setLoadError(webErrorMessage(error, { fallback: "项目列表暂时读不到，请稍后重试。" }));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // The sidebar's project list reads the shared store; without this it kept
  // the list from before a change made here (2026-09-16 review, D2).
  const refreshSidebar = () => { void useProjectStore.getState().load(); };

  const createProject = async () => {
    const problem = projectNameProblem(newName);
    if (problem) { setCreateError(problem); return; }
    setCreateError(null);
    setCreating(true);
    try {
      const project = await useProjectStore.getState().create(newName);
      setProjects(await listWebProjects());
      refreshSidebar();
      setNewName("");
      setCreateOpen(false);
      // A project made here is the one the researcher is about to work in.
      await useProjectStore.getState().select(project.id).then(() => setCurrentId(project.id), (error) => {
        toast.error(`没能切换到「${project.name}」：${webErrorMessage(error)}`);
      });
    } catch (error) {
      setCreateError(projectErrorMessage(error, projects.length, "项目没有建成，请稍后重试。"));
    } finally {
      setCreating(false);
    }
  };

  const submitRename = async (project: WebProject) => {
    const problem = projectNameProblem(renameDraft);
    if (problem) { setRenameError(problem); return; }
    if (renameDraft.trim() === project.name) { setRenamingId(null); return; }
    setBusyProjectId(project.id);
    try {
      const renamed = await useProjectStore.getState().rename(project.id, renameDraft);
      setProjects((items) => items.map((item) => (item.id === project.id ? { ...item, ...renamed } : item)));
      setRenamingId(null);
      setRenameError(null);
    } catch (error) {
      setRenameError(projectErrorMessage(error, projects.length, "项目名没有改成功，请稍后重试。"));
    } finally {
      setBusyProjectId(null);
    }
  };

  const exportProject = async (project: WebProject) => {
    setBusyProjectId(project.id);
    try {
      const blob = await exportWebProject(project.id);
      downloadBlob(blob, `evimed-project-${project.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`);
      toast.success(`已导出「${project.name}」`);
    } catch (error) {
      toast.error(`没能导出「${project.name}」：${webErrorMessage(error)}`);
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
        // through the store the sidebar and every page are keyed on. A refused
        // move is not a failed deletion: the list refresh falls back to
        // 「我的研究」 by itself.
        const nextProject = items.find((item) => item.id === DEFAULT_PROJECT_ID) ?? items[0];
        if (nextProject && await useProjectStore.getState().select(nextProject.id).then(() => true, () => false)) {
          setCurrentId(nextProject.id);
        }
      }
      refreshSidebar();
      toast.success(`已删除「${project.name}」`);
    } catch (error) {
      toast.error(`没能删除「${project.name}」：${webErrorMessage(error, { codes: DELETE_ERRORS })}`);
    } finally {
      setBusyProjectId(null);
    }
  };

  const disabled = loading || creating || busyProjectId != null;

  return (
    <div className="space-y-8">
      <Panel
        title="项目"
        action={!createOpen && (
          <Button variant="text" size="sm" onClick={() => { setCreateOpen(true); setCreateError(null); }}>
            <Plus size={16} aria-hidden="true" />新建项目
          </Button>
        )}
      >
        {createOpen && (
          <form
            className="px-4 py-3"
            onSubmit={(event) => { event.preventDefault(); void createProject(); }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                ref={createRef}
                aria-label="新项目名"
                placeholder="新项目名"
                value={newName}
                maxLength={PROJECT_NAME_MAX}
                className="w-72"
                disabled={creating}
                onChange={(event) => { setNewName(event.target.value); setCreateError(null); }}
                onKeyDown={(event) => { if (event.key === "Escape") setCreateOpen(false); }}
              />
              <Button type="submit" loading={creating} disabled={!newName.trim()}>创建</Button>
              <Button variant="text" disabled={creating} onClick={() => { setCreateOpen(false); setNewName(""); setCreateError(null); }}>取消</Button>
            </div>
            {createError && <p role="alert" className="mt-2 text-caption text-error">{createError}</p>}
          </form>
        )}
        {loadError && (
          <PanelRow
            label={<span role="alert">{loadError}</span>}
            control={<Button variant="text" onClick={() => void refresh()}>重试</Button>}
          />
        )}
        {projects.length === 0 && loading && <PanelRow label={<span className="text-text-3">正在读取…</span>} />}
        {projects.length > 0 && (
          <List label="项目列表" divided>
            {projects.map((project) => renamingId === project.id ? (
              <li key={project.id} className="px-4 py-3">
                <form onSubmit={(event) => { event.preventDefault(); void submitRename(project); }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      ref={renameRef}
                      aria-label={`「${project.name}」的新名字`}
                      value={renameDraft}
                      maxLength={PROJECT_NAME_MAX}
                      className="w-72"
                      disabled={busyProjectId === project.id}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") { setRenamingId(null); setRenameError(null); } }}
                    />
                    <Button type="submit" loading={busyProjectId === project.id}>保存</Button>
                    <Button variant="text" disabled={busyProjectId === project.id} onClick={() => { setRenamingId(null); setRenameError(null); }}>取消</Button>
                  </div>
                  {renameError && <p role="alert" className="mt-2 text-caption text-error">{renameError}</p>}
                </form>
              </li>
            ) : (
              <ListRow
                key={project.id}
                className={PANEL_ROW}
                title={project.name}
                meta={projectMetaLine(project) || undefined}
                trailing={project.id === currentId ? <Tag>当前</Tag> : undefined}
                actions={(
                  <>
                    <IconButton icon={Pencil} label={`重命名「${project.name}」`} size="sm" disabled={disabled}
                      onClick={() => { setRenamingId(project.id); setRenameDraft(project.name); setRenameError(null); }} />
                    <IconButton icon={Download} label={`导出「${project.name}」`} size="sm" disabled={disabled}
                      onClick={() => void exportProject(project)} />
                  </>
                )}
                menu={project.id === DEFAULT_PROJECT_ID ? undefined : (
                  <Menu
                    label={`「${project.name}」的更多操作`}
                    items={[{ label: "删除", destructive: true, disabled, onSelect: () => setPendingDelete(project) }]}
                  />
                )}
              />
            ))}
          </List>
        )}
      </Panel>

      <ArchivedConversations />

      {pendingDelete && createPortal(
        <ConfirmDialog
          title={`删除项目「${pendingDelete.name}」？`}
          body="这个项目的文件、对话与研究环境都会删除，无法恢复；需要留底的话，先导出。"
          confirmLabel="删除项目"
          onConfirm={() => void confirmDeleteProject()}
          onCancel={() => setPendingDelete(null)}
        />,
        document.body,
      )}
    </div>
  );
}

/**
 * The conversations of this project the researcher put away, and the way
 * back for each. ChatGPT keeps its archived chats under Data controls; this
 * is the same shelf, under 项目, because a conversation belongs to one.
 */
function ArchivedConversations() {
  const projectId = useProjectStore((state) => state.currentId) || getWebProjectId();
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRuns(await listWebAgentRuns({ projectId, archived: true })); }
    catch (cause) { setRuns([]); setError(webErrorMessage(cause, { fallback: "已归档的对话暂时读不到。" })); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const restore = async (run: WebAgentRun) => {
    setBusy(run.id);
    try {
      await archiveWebAgentRun(run.id, false);
      announceRunsChanged();
      toast.success("已恢复到对话列表");
      await load();
    } catch (cause) {
      toast.error(webErrorMessage(cause, { fallback: "没能恢复，请稍后重试。" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="已归档的对话">
      {error ? (
        <PanelRow label={<span role="alert">{error}</span>} control={<Button variant="text" onClick={() => void load()}>重试</Button>} />
      ) : runs === null ? (
        <PanelRow label={<span className="text-text-3">正在读取…</span>} />
      ) : runs.length === 0 ? (
        <PanelRow label={<span className="text-text-3">没有归档的对话</span>} />
      ) : (
        <List label="已归档的对话" divided>
          {runs.map((run) => (
            <ListRow
              key={run.id}
              className={PANEL_ROW}
              title={runTitle(run)}
              to={chatPath(run.sessionId)}
              meta={relativeTime(runMoment(run))}
              actions={(
                <IconButton icon={ArchiveRestore} label={`恢复「${runTitle(run)}」`} size="sm" disabled={busy !== null}
                  onClick={() => void restore(run)} />
              )}
            />
          ))}
        </List>
      )}
    </Panel>
  );
}

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
