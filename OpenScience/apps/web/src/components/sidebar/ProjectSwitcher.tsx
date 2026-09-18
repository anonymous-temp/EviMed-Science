import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Check, ChevronsUpDown, FolderGit2, Pencil, Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useProjectStore } from "@/lib/projects";
import { webErrorMessage } from "@/lib/apiClient";
import { PROJECT_EXPLAINER, PROJECT_NAME_MAX, projectErrorMessage, projectNameProblem } from "@/lib/projectNames";

/** Past six projects the panel gets a search box (appendix D §10.2). */
const SEARCH_FROM = 7;

/**
 * The top-level project switcher (appendix D §10.2).
 *
 * It sits under the wordmark because it scopes everything below it: the
 * conversation, the runs, the files, the memory. It used to show an English
 * 「Default Project」 that could not be renamed, and asked for a 「新项目名」
 * it then refused if it held a Chinese character — it was an id field wearing
 * a name's label (review B §2). A project is created and renamed by its name
 * now, in any language; the server derives the id, which nobody needs to see.
 * The one sentence at the foot of the panel says what a project is, because
 * switching one restarts the research runtime and nothing else says so.
 *
 * The panel is a small dialog rather than a listbox: each row carries a rename
 * button, and an option may not contain another control. ↑/↓ still move
 * between projects, Enter chooses, typing filters when there is a search box,
 * and Escape closes and returns focus to the trigger.
 */
export function ProjectSwitcher({ running = false }: { running?: boolean }) {
  const { projects, currentId, loading, error, load, select, create, rename } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const searchable = projects.length >= SEARCH_FROM;

  useEffect(() => {
    void load();
  }, [load]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setCreating(false);
    setDraftName("");
    setRenaming(null);
    setFailure(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // ↑/↓ walk the project rows, from the search box too.
  const moveFocus = useCallback((event: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel || !panel.contains(event.target as Node)) return;
    const options = Array.from(panel.querySelectorAll<HTMLElement>("[data-project-option]"));
    if (options.length === 0) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown"
      ? (index + 1) % options.length
      : index <= 0 ? options.length - 1 : index - 1;
    options[next]?.focus();
  }, []);

  // Where the keyboard lands on open: the search box when there is one, so
  // typing filters at once; otherwise the current project.
  useEffect(() => {
    if (!open) return;
    if (searchRef.current) searchRef.current.focus();
    else panelRef.current?.querySelector<HTMLElement>("[data-project-option][aria-current]")?.focus();
  }, [open]);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // An inline edit takes Escape for itself first (its handler stops it).
      if (event.key === "Escape") close(true);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") moveFocus(event);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, moveFocus]);

  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? currentId;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => projects.filter((project) => !needle || project.name.toLowerCase().includes(needle)),
    [projects, needle],
  );

  const choose = async (projectId: string) => {
    if (projectId === currentId) {
      close(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await select(projectId);
      setOpen(false);
    } catch (err) {
      // A switch that fails says so in the panel; closing would read as a
      // success against a project the account never moved to.
      setFailure(webErrorMessage(err, { fallback: "无法切换到这个项目，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async () => {
    const problem = projectNameProblem(draftName);
    if (problem) {
      setFailure(problem);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const project = await create(draftName);
      setDraftName("");
      setCreating(false);
      await select(project.id);
    } catch (err) {
      setFailure(projectErrorMessage(err, projects.length, "无法创建项目，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (projectId: string) => {
    const problem = projectNameProblem(renameDraft);
    if (problem) {
      setFailure(problem);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await rename(projectId, renameDraft);
      setRenaming(null);
    } catch (err) {
      setFailure(projectErrorMessage(err, projects.length, "项目名没有改成功，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative px-3 pb-2" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`当前项目：${label}${running ? "（有研究正在运行）" : ""}`}
        title={PROJECT_EXPLAINER}
        className="flex h-10 w-full items-center gap-2 rounded-input border border-strong bg-surface px-2.5 text-ui text-text hover:bg-surface-2"
      >
        <FolderGit2 size={16} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden="true" />
        {running && (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-dot-running motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronsUpDown size={14} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="切换项目"
          className="absolute left-3 right-3 z-20 mt-1 rounded-card border border-border bg-surface py-1 shadow-pop"
        >
          {searchable && (
            <label className="relative mx-2 mb-1 block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <span className="sr-only">搜索项目</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目"
                className="h-8 w-full rounded-input border border-strong bg-surface pl-8 pr-2 text-ui text-text outline-none placeholder:text-muted focus:border-focus"
              />
            </label>
          )}
          {loading && projects.length === 0 && (
            <p className="px-3 py-2 text-caption text-muted">正在读取项目…</p>
          )}
          {error && <p className="px-3 py-2 text-caption text-error">{error}</p>}
          {projects.length > 0 && visible.length === 0 && (
            <p className="px-3 py-2 text-caption text-muted">没有名字里含「{query.trim()}」的项目</p>
          )}
          {/* Eight 36 px rows, then the list scrolls. */}
          <ul aria-label="项目" className="max-h-72 overflow-y-auto">
            {visible.map((project) => {
              const selected = project.id === currentId;
              return (
                <li key={project.id} className="group/project relative">
                  {renaming === project.id ? (
                    <form
                      className="flex h-9 items-center gap-1.5 px-2"
                      onSubmit={(event) => { event.preventDefault(); void submitRename(project.id); }}
                    >
                      <label className="sr-only" htmlFor={`project-rename-${project.id}`}>新的项目名</label>
                      <input
                        id={`project-rename-${project.id}`}
                        ref={renameRef}
                        value={renameDraft}
                        maxLength={PROJECT_NAME_MAX}
                        disabled={busy}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.stopPropagation();
                          event.nativeEvent.stopImmediatePropagation();
                          setRenaming(null);
                          setFailure(null);
                        }}
                        className="h-7 min-w-0 flex-1 rounded-input border border-strong bg-surface px-2 text-ui text-text outline-none focus:border-focus"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        className="h-7 shrink-0 rounded-input px-2 text-ui text-accent hover:bg-surface-2 disabled:opacity-50"
                      >
                        保存
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-project-option=""
                        aria-current={selected ? "true" : undefined}
                        title={project.name}
                        disabled={busy}
                        onClick={() => void choose(project.id)}
                        className="relative flex h-9 w-full items-center gap-2 pl-3 pr-10 text-left text-ui text-text hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-50"
                      >
                        {selected && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" aria-hidden="true" />}
                        <Check
                          size={14}
                          strokeWidth={2}
                          className={cn("shrink-0", selected ? "text-accent" : "invisible")}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`重命名项目「${project.name}」`}
                        title="重命名"
                        disabled={busy}
                        onClick={() => { setRenaming(project.id); setRenameDraft(project.name); setFailure(null); }}
                        className="absolute right-1.5 top-1 grid h-7 w-7 place-items-center rounded-input text-muted opacity-0 hover:bg-surface hover:text-text focus-visible:opacity-100 group-hover/project:opacity-100 max-lg:opacity-100"
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-1 border-t border-border pt-1">
            {creating ? (
              <form className="px-3 py-1.5" onSubmit={(event) => { event.preventDefault(); void submitNew(); }}>
                <label className="mb-1 block text-caption text-muted" htmlFor="project-new-name">新项目名</label>
                <input
                  id="project-new-name"
                  ref={newNameRef}
                  value={draftName}
                  maxLength={PROJECT_NAME_MAX}
                  disabled={busy}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.stopPropagation();
                    event.nativeEvent.stopImmediatePropagation();
                    setCreating(false);
                    setDraftName("");
                    setFailure(null);
                  }}
                  placeholder="例如：阿司匹林一级预防"
                  className="h-8 w-full rounded-input border border-strong bg-surface px-2 text-ui text-text outline-none placeholder:text-muted focus:border-focus"
                />
                <p className="mt-1 text-caption text-muted">按 Enter 创建并切换过去</p>
              </form>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setCreating(true); setFailure(null); }}
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-ui text-accent hover:bg-surface-2 disabled:opacity-50"
              >
                <Plus size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                新建项目
              </button>
            )}
            <Link
              to="/app/account?tab=settings"
              onClick={() => close(false)}
              className="flex h-9 items-center px-3 text-ui text-text hover:bg-surface-2"
            >
              管理项目
            </Link>
          </div>

          {failure && <p role="alert" className="px-3 pb-2 pt-1 text-caption text-error">{failure}</p>}
          <p className="mt-1 border-t border-border px-3 pb-1.5 pt-2 text-caption text-muted">{PROJECT_EXPLAINER}</p>
        </div>
      )}
    </div>
  );
}
