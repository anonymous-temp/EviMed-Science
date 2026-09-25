import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ChevronRight, Folder, FolderOpen, Loader2, Pencil, Plus, Radar, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { webErrorMessage, type WebAgentRun, type WebProject } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { PROJECT_NAME_MAX, projectErrorMessage, projectNameProblem } from "@/lib/projectNames";
import { chatPath } from "@/lib/runLocation";
import { compactTime, runMoment, runTitle } from "@/lib/runPresentation";
import { groupConversations, type Conversation } from "@/lib/conversations";
import { isRunUnseen, markRunSeen, useRunsSeenVersion } from "@/lib/runSeen";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { warmWebRuntime } from "@/lib/runtimeWarm";
import { ConversationMatches } from "@/components/sidebar/ConversationMatches";
import { ConversationMenu } from "@/components/sidebar/ConversationMenu";
import { inputClasses } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import { isRunning, useProjectRuns, type ProjectRuns } from "@/components/sidebar/useProjectRuns";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";

/** Conversation rows a group shows before 「展开其余 N 条对话」 — the kernel's own
 *  workspace list folds at the same count (`COLLAPSED_SESSION_LIMIT`). */
const COLLAPSED_TASK_ROWS = 5;

/** Search results listed at most, as in the kernel's list. */
const SEARCH_RESULTS_MAX = 20;

/** Which project groups are open, by project id, kept across reloads. */
const EXPANDED_KEY = "ai4s.sidebar.projectGroups";

const ADDRESSABLE_SESSION = /^[A-Za-z0-9_-]{1,160}$/;

type ExpandedMap = Record<string, boolean>;

function readExpanded(): ExpandedMap {
  if (typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

function writeExpanded(map: ExpandedMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
  } catch {
    // A full or refused storage only costs the groups' state after a reload.
  }
}

/**
 * Where a conversation opens, or null when there is none to open.
 *
 * A run whose session was never recorded has no conversation to go to. It used
 * to link to its row on the run ledger; that page was deleted on 2026-09-20,
 * and a link to a page that answers 「找不到」 is worse than a row that says so
 * where it is.
 */
function taskTarget(run: WebAgentRun): string | null {
  return ADDRESSABLE_SESSION.test(run.sessionId) ? chatPath(run.sessionId) : null;
}

function isOpenTask(run: WebAgentRun, pathname: string): boolean {
  const target = taskTarget(run);
  return target != null && pathname === target;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** One row's identity across the tree and the search results: a
 *  conversation, which keeps it when a follow-up adds a run to it. */
function taskKey(projectId: string, run: WebAgentRun): string {
  return `${projectId}\u0000${run.sessionId}`;
}

/** Where a click is going: a path, and router state minted at the moment of arrival. */
type Destination = () => { to: string; state?: unknown };

/**
 * The sidebar's 「项目」 section: every project as a group, its conversations inside.
 *
 * Modelled on the kernel's own workspace list (`WorkspaceBrowser` in
 * `@deepseek-ai/dsh-client-ui-workspace`), which is what the owner asked this
 * to look like (2026-09-19): collapsible groups with their sessions nested
 * under them, five rows before 「展开其余 N 条对话」, a header with a search
 * that replaces the tree with one flat result list, and per-group actions on
 * hover — new conversation there, rename. It replaces a project dropdown above
 * a list of the current project's recent work only, where reaching another
 * project's conversation was two menus and a document reload.
 *
 * Opening another project's conversation, or a new one in it, switches the
 * shell to that project in place and lands on it in the same render
 * (`useProjectStore.select`). Those rows are buttons, not links: the tab's
 * project is a header rather than part of the address, so the same path opened
 * in a new tab would open under the wrong project. Rows of the current
 * project stay links, as they always were.
 *
 * Conversations are read per project and only once a group is open
 * (`useProjectRuns`); which groups are open survives a reload.
 */
export function ProjectBrowser({ geo = false }: {
  /** Whether 「循证 GEO」 is offered: its projects then carry the radar icon. */
  geo?: boolean;
} = {}) {
  const { projects, currentId, switching, loading, error, load, select, create, rename } = useProjectStore();
  const geoProjectIds = useGeoProjectIds(geo, projects.map((project) => project.id).join("\u0000"));
  const navigate = useNavigate();
  const location = useLocation();
  const headingId = useId();
  const newNameId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [expanded, setExpanded] = useState<ExpandedMap>(readExpanded);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [refocus, setRefocus] = useState<{ projectId: string; key: string } | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // Until the list answers there is one project the shell knows it is in; if
  // the list cannot be read, that one stays reachable under a plain name.
  const listed: WebProject[] = useMemo(
    () => (projects.length > 0 ? projects : [{ id: currentId, name: "当前项目" }]),
    [projects, currentId],
  );
  const known = useMemo(() => (projects.length > 0 ? new Set(projects.map((project) => project.id)) : null), [projects]);
  const isExpanded = useCallback((projectId: string) => expanded[projectId] ?? projectId === currentId, [expanded, currentId]);
  // The current project is always read, open or not, as the one list before
  // this was: a task started in it must light its header even when folded.
  const wanted = useMemo(
    () => [currentId, ...(known ? listed.filter((project) => isExpanded(project.id)).map((project) => project.id) : [])],
    [known, listed, isExpanded, currentId],
  );
  const { byProject, read } = useProjectRuns(wanted, known);

  // The current project opens by default, and is then remembered as open,
  // so switching away does not fold it behind the reader's back — the
  // kernel's list does the same.
  useEffect(() => {
    setExpanded((map) => (Object.hasOwn(map, currentId) ? map : { ...map, [currentId]: true }));
  }, [currentId]);
  // Only the account's projects are remembered; a deleted one is forgotten.
  useEffect(() => {
    if (!known) return;
    setExpanded((map) => {
      const kept = Object.fromEntries(Object.entries(map).filter(([projectId]) => known.has(projectId)));
      return Object.keys(kept).length === Object.keys(map).length ? map : kept;
    });
  }, [known]);
  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);

  // Said once, politely, for a screen reader: a switch moves every page, and
  // nothing on the page itself says which project it is now.
  const announced = useRef(currentId);
  useEffect(() => {
    if (announced.current === currentId) return;
    announced.current = currentId;
    const name = projects.find((project) => project.id === currentId)?.name;
    if (name) setAnnouncement(`已切换到项目「${name}」`);
  }, [currentId, projects]);

  // Opening another project's task swaps its button for a link (the project
  // is current now), which takes the keyboard focus with it. Give it back to
  // the same task's row — only if nothing else has taken it meanwhile.
  useLayoutEffect(() => {
    if (!refocus || refocus.projectId !== currentId || searchOpen) return;
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-task-key]") ?? [])]
      .find((element) => element.dataset.taskKey === refocus.key);
    const active = document.activeElement;
    if (row && (!active || active === document.body || !active.isConnected)) row.focus();
    setRefocus(null);
  }, [refocus, currentId, searchOpen]);

  /** Starts another project's runtime while the pointer or keyboard is on its
   *  group, so opening one of its conversations does not wait for a cold start. Called
   *  on every hover: the rate is `warmWebRuntime`'s own to keep. */
  const warm = useCallback((projectId: string) => {
    if (projectId !== useProjectStore.getState().currentId) warmWebRuntime(projectId, { speculative: true });
  }, []);

  /**
   * Go somewhere in a project: at once in the current one, or by switching
   * the shell to another first. `destination` is called only once the shell
   * is there, because what it mints — a new task's intent — names the project
   * it was minted in.
   */
  const go = (projectId: string, destination: Destination) => {
    setFailures((map) => without(map, projectId));
    if (projectId === useProjectStore.getState().currentId) {
      // Also stands down a switch to another project still waiting on its
      // answer: this click came later, and it is the one meant.
      void select(projectId);
      const { to, state } = destination();
      navigate(to, { state });
      return;
    }
    void select(projectId, () => {
      const { to, state } = destination();
      navigate(to, { state, flushSync: true });
    }).catch((reason: unknown) => {
      setRefocus((pending) => (pending?.projectId === projectId ? null : pending));
      setFailures((map) => ({ ...map, [projectId]: webErrorMessage(reason, { fallback: "无法切换到这个项目，请稍后重试。" }) }));
    });
  };

  const openTask = (projectId: string, run: WebAgentRun, row: HTMLElement | null) => {
    const to = taskTarget(run);
    if (!to) return;
    if (row && row === document.activeElement && projectId !== currentId) setRefocus({ projectId, key: taskKey(projectId, run) });
    go(projectId, () => ({ to }));
  };

  const startTask = (projectId: string) => {
    setExpanded((map) => ({ ...map, [projectId]: true }));
    go(projectId, () => ({ to: "/app/chat", state: { runtimeUiIntent: newRuntimeUiIntent() } }));
  };

  const toggle = (projectId: string) => {
    const open = !isExpanded(projectId);
    setExpanded((map) => ({ ...map, [projectId]: open }));
    // Opening a group is the strongest signal short of a click that one of its
    // conversations is about to be read, and a cold runtime takes about five
    // seconds to come up (2026-09-19 measurement). `warmWebRuntime` keeps its
    // own rate, so this can fire on every toggle.
    if (open) warm(projectId);
    // Closing a group also folds its long list again, as the kernel's does.
    if (!open) {
      setShowAll((set) => {
        if (!set.has(projectId)) return set;
        const next = new Set(set);
        next.delete(projectId);
        return next;
      });
    }
  };

  const toggleShowAll = (projectId: string) => {
    setShowAll((set) => {
      const next = new Set(set);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const closeSearch = (returnFocus: boolean) => {
    setQuery("");
    setSearchOpen(false);
    if (returnFocus) requestAnimationFrame(() => searchButtonRef.current?.focus());
  };

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  const submitNew = async () => {
    const problem = projectNameProblem(draftName);
    if (problem) {
      setCreateError(problem);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    let project: WebProject;
    try {
      project = await create(draftName);
    } catch (reason) {
      setCreateError(projectErrorMessage(reason, projects.length, "无法创建项目，请稍后重试。"));
      setCreateBusy(false);
      return;
    }
    setCreateBusy(false);
    setCreating(false);
    setDraftName("");
    // A new project is for a task, so it opens on one — as adding a
    // workspace does in the kernel's list.
    startTask(project.id);
  };

  const needle = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!needle) return [];
    const found: Array<{ project: WebProject; conversation: Conversation }> = [];
    for (const project of listed) {
      const entry = byProject[project.id];
      if (entry?.status !== "ready") continue;
      for (const conversation of groupConversations(entry.runs.filter((run) => taskTarget(run) != null))) {
        if (conversation.runs.some((run) => runTitle(run).toLowerCase().includes(needle))) found.push({ project, conversation });
      }
    }
    return found.sort((a, b) => runMoment(b.conversation.lead) - runMoment(a.conversation.lead));
  }, [needle, listed, byProject]);
  // The search reads what has been loaded; the rest is one click away rather
  // than read behind the reader's back on every keystroke.
  const unsearched = listed.filter((project) => byProject[project.id]?.status !== "ready");
  const unsearchedLoading = unsearched.some((project) => byProject[project.id]?.status === "loading");

  const openResult = (project: WebProject, run: WebAgentRun, row: HTMLElement | null) => {
    // Back in the tree, the task is where the reader can see it: its group
    // open, and the long list unfolded if it sits past the first rows.
    const entry = byProject[project.id];
    const index = entry?.status === "ready"
      ? groupConversations(entry.runs.filter((candidate) => taskTarget(candidate) != null)).findIndex((candidate) => candidate.sessionId === run.sessionId)
      : -1;
    setExpanded((map) => ({ ...map, [project.id]: true }));
    if (index >= COLLAPSED_TASK_ROWS) setShowAll((set) => new Set(set).add(project.id));
    const to = taskTarget(run);
    if (!to) return;
    if (row && row === document.activeElement) setRefocus({ projectId: project.id, key: taskKey(project.id, run) });
    closeSearch(false);
    go(project.id, () => ({ to }));
  };

  return (
    <section
      ref={rootRef}
      aria-labelledby={headingId}
      className="mt-4 flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-3">
        {/* The heading stays in the tree while the search box has the row:
          * it is the section's name either way. */}
        <h2
          id={headingId}
          className={cn("min-w-0 flex-1 px-2 text-caption text-text-3", searchOpen && "sr-only")}
        >
          项目
        </h2>
        {searchOpen ? (
          <div
            className="relative flex min-w-0 flex-1 items-center"
            onBlur={(event) => {
              // An empty search box folds away when the keyboard or pointer
              // leaves it, as the kernel's does; one with a query stays.
              if (!needle && !event.currentTarget.contains(event.relatedTarget as Node | null)) closeSearch(false);
            }}
          >
            <Search size={16} className="pointer-events-none absolute left-2 text-text-3" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              aria-label="搜索对话"
              placeholder="搜索对话"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                closeSearch(true);
              }}
              className={inputClasses({ className: "h-8 bg-bg pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden" })}
            />
            <IconButton icon={X} label="清除搜索" size="sm" onClick={() => closeSearch(true)} className="absolute right-1" />
          </div>
        ) : (
          <>
            <IconButton
              ref={searchButtonRef}
              icon={Search}
              label="搜索对话"
              onClick={() => { setCreating(false); setSearchOpen(true); }}
            />
            {/* The everyday two. Export, rename and delete of a project live
              * in 设置 → 项目 (2026-09-23 plan §5.2). */}
            <IconButton
              icon={Plus}
              label="新建项目"
              aria-expanded={creating}
              onClick={() => { setCreating((open) => !open); setCreateError(null); }}
            />
          </>
        )}
      </div>

      {creating && !searchOpen && (
        <form
          className="shrink-0 px-3 pb-2"
          onSubmit={(event) => { event.preventDefault(); void submitNew(); }}
        >
          <label className="sr-only" htmlFor={newNameId}>新项目名</label>
          <input
            id={newNameId}
            ref={newNameRef}
            value={draftName}
            maxLength={PROJECT_NAME_MAX}
            disabled={createBusy}
            placeholder="项目名，回车创建"
            onChange={(event) => { setDraftName(event.target.value); setCreateError(null); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setCreating(false);
              setDraftName("");
              setCreateError(null);
            }}
            className={inputClasses({ className: "h-8" })}
          />
          {createError && <p role="alert" className="mt-1 px-2 text-caption text-error">{createError}</p>}
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {error && (
          <div role="alert" className="flex items-center gap-2 px-2 py-1 text-caption text-error">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => void load()} className="shrink-0 rounded px-1 text-link hover:underline">重试</button>
          </div>
        )}
        {needle ? (
          <>
            {Object.entries(failures).map(([projectId, message]) => (
              <p key={projectId} role="alert" className="px-2 py-1 text-caption text-error">{message}</p>
            ))}
            {results.length > 0 && (
              <ul aria-label="搜索结果" className="flex flex-col">
                {results.slice(0, SEARCH_RESULTS_MAX).map(({ project, conversation }) => (
                  <li key={taskKey(project.id, conversation.lead)}>
                    <TaskRow
                      conversation={conversation}
                      projectId={project.id}
                      projectName={project.name}
                      current={project.id === currentId}
                      active={project.id === currentId && isOpenTask(conversation.lead, location.pathname)}
                      withProject
                      onOpen={(row) => openResult(project, conversation.lead, row)}
                      onWarm={() => warm(project.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {results.length === 0 && !unsearchedLoading && <p className="px-2 py-2 text-caption text-muted">没有匹配的对话</p>}
            {results.length > SEARCH_RESULTS_MAX && (
              <p className="px-2 py-1 text-caption text-text-3">仅显示前 {SEARCH_RESULTS_MAX} 条</p>
            )}
            {unsearchedLoading && <p role="status" className="px-2 py-1 text-caption text-muted">正在读取其余项目的对话…</p>}
            {!unsearchedLoading && unsearched.length > 0 && (
              <button
                type="button"
                onClick={() => { for (const project of unsearched) read(project.id); }}
                className="mx-2 my-1 rounded text-left text-caption text-link hover:underline"
              >
                在其余 {unsearched.length} 个项目中查找
              </button>
            )}
            <ConversationMatches
              query={query}
              shownSessionIds={new Set(results.filter(({ project }) => project.id === currentId).map(({ conversation }) => conversation.sessionId))}
            />
          </>
        ) : (
          <>
            {loading && projects.length === 0 && !error && (
              <p className="px-2 py-1 text-caption text-muted">正在读取项目…</p>
            )}
            {(projects.length > 0 || error) && (
              <ul className="flex flex-col gap-1">
                {listed.map((project) => (
                  <ProjectGroup
                    key={project.id}
                    project={project}
                    geo={geoProjectIds.has(project.id)}
                    current={project.id === currentId}
                    standIn={projects.length === 0}
                    expanded={isExpanded(project.id)}
                    showAll={showAll.has(project.id)}
                    runs={byProject[project.id]}
                    switching={switching === project.id}
                    failure={failures[project.id] ?? null}
                    isOpen={(run) => project.id === currentId && isOpenTask(run, location.pathname)}
                    onToggle={() => toggle(project.id)}
                    onShowAll={() => toggleShowAll(project.id)}
                    onNewTask={() => startTask(project.id)}
                    onRename={async (name) => { await rename(project.id, name); }}
                    renameFailure={(reason) => projectErrorMessage(reason, projects.length, "项目名没有改成功，请稍后重试。")}
                    onOpenTask={(run, row) => openTask(project.id, run, row)}
                    onRetry={() => read(project.id)}
                    onWarm={() => warm(project.id)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </section>
  );
}

/**
 * One project: its header row, and its conversations when open.
 *
 * The header is a disclosure button with its two actions beside it rather
 * than inside it — a control may not contain another. The actions show on
 * hover and on keyboard focus, and always on a touch screen, where there is
 * no hover to reveal them.
 */
function ProjectGroup({
  project,
  geo,
  current,
  standIn,
  expanded,
  showAll,
  runs,
  switching,
  failure,
  isOpen,
  onToggle,
  onShowAll,
  onNewTask,
  onRename,
  renameFailure,
  onOpenTask,
  onRetry,
  onWarm,
}: {
  project: WebProject;
  /** A GEO project: the radar instead of the folder. */
  geo: boolean;
  current: boolean;
  /** The group shown for the tab's project while the list cannot be read:
   *  named 「当前项目」, and not renamable, since its real name is unknown. */
  standIn: boolean;
  expanded: boolean;
  showAll: boolean;
  runs: ProjectRuns | undefined;
  /** A switch to this project is waiting on its answer. */
  switching: boolean;
  failure: string | null;
  isOpen: (run: WebAgentRun) => boolean;
  onToggle: () => void;
  onShowAll: () => void;
  onNewTask: () => void;
  onRename: (name: string) => Promise<void>;
  renameFailure: (reason: unknown) => string;
  onOpenTask: (run: WebAgentRun, row: HTMLElement | null) => void;
  onRetry: () => void;
  onWarm: () => void;
}) {
  const listId = useId();
  const renameId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const running = runs?.status === "ready" && runs.runs.some(isRunning);
  const Icon = geo ? Radar : expanded ? FolderOpen : Folder;

  useEffect(() => {
    if (!renaming) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renaming]);

  const endRename = () => {
    setRenaming(false);
    setRenameError(null);
    requestAnimationFrame(() => toggleRef.current?.focus());
  };

  const submitRename = async () => {
    const problem = projectNameProblem(draft);
    if (problem) {
      setRenameError(problem);
      return;
    }
    if (draft.trim() === project.name) {
      endRename();
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onRename(draft);
      endRename();
    } catch (reason) {
      setRenameError(renameFailure(reason));
    } finally {
      setRenameBusy(false);
    }
  };

  // One row per conversation; a run whose session was never recorded has no
  // conversation to open.
  const rows = runs?.status === "ready" ? groupConversations(runs.runs.filter((run) => taskTarget(run) != null)) : [];
  const shown = showAll ? rows : rows.slice(0, COLLAPSED_TASK_ROWS);
  const hidden = rows.length - Math.min(rows.length, COLLAPSED_TASK_ROWS);
  const status = [current && !standIn && "当前项目", switching && "正在切换", running && "有对话正在运行"].filter(Boolean).join("，");

  return (
    // Hovering or focusing another project's group starts its runtime ahead of
    // a click (`warmWebRuntime`, which keeps its own rate).
    <li onPointerEnter={current ? undefined : onWarm} onFocus={current ? undefined : onWarm}>
      {renaming ? (
        <form
          className="flex h-8 items-center gap-1 pl-1"
          onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
        >
          <label className="sr-only" htmlFor={renameId}>新的项目名</label>
          <input
            id={renameId}
            ref={renameRef}
            value={draft}
            maxLength={PROJECT_NAME_MAX}
            disabled={renameBusy}
            onChange={(event) => { setDraft(event.target.value); setRenameError(null); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              endRename();
            }}
            className={inputClasses({ className: "h-7 min-w-0 flex-1 px-2" })}
          />
          <button
            type="submit"
            disabled={renameBusy}
            className="h-7 shrink-0 rounded-input px-2 text-ui text-accent hover:bg-surface-2 disabled:opacity-50"
          >
            保存
          </button>
        </form>
      ) : (
        <div className="group/project relative">
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-busy={switching || undefined}
            onClick={onToggle}
            title={project.name}
            className={cn(
              "flex h-8 w-full items-center gap-1.5 rounded-input pl-1 pr-2 text-left text-ui text-text hover:bg-surface-2",
              "group-hover/project:pr-14 group-focus-within/project:pr-14 max-lg:pr-14",
            )}
          >
            <ChevronRight
              size={16}
              className={cn("shrink-0 text-muted transition-transform duration-fast", expanded && "rotate-90")}
              aria-hidden="true"
            />
            <Icon size={16} className={cn("shrink-0", current ? "text-accent" : "text-muted")} aria-hidden="true" />
            <span className={cn("min-w-0 flex-1 truncate", current && "font-semibold")}>{project.name}</span>
            {switching ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-muted motion-reduce:animate-none" aria-hidden="true" />
            ) : running && (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-dot-running motion-reduce:animate-none" aria-hidden="true" />
            )}
            {status && <span className="sr-only">（{status}）</span>}
          </button>
          <span className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 max-lg:opacity-100">
            <button
              type="button"
              aria-label={`在「${project.name}」新建对话`}
              title="在此项目新建对话"
              onClick={onNewTask}
              className="grid h-6 w-6 place-items-center rounded-input text-muted hover:bg-surface hover:text-text"
            >
              {/* A plus, as the kernel's list has it: the pen-in-a-square of
                * 「新对话」 sat beside the rename pencil as its near twin. */}
              <Plus size={16} aria-hidden="true" />
            </button>
            {!standIn && (
              <button
                type="button"
                aria-label={`重命名项目「${project.name}」`}
                title="重命名"
                onClick={() => { setDraft(project.name); setRenameError(null); setRenaming(true); }}
                className="grid h-6 w-6 place-items-center rounded-input text-muted hover:bg-surface hover:text-text"
              >
                <Pencil size={16} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}
      {renameError && <p role="alert" className="px-2 py-1 text-caption text-error">{renameError}</p>}
      {failure && <p role="alert" className="py-1 pl-7 pr-2 text-caption text-error">{failure}</p>}
      {expanded && (
        <ul id={listId} aria-label={`「${project.name}」的对话`} className="mt-0.5 flex flex-col">
          {(runs === undefined || runs.status === "loading") && (
            <li className="py-1 pl-11 pr-2 text-caption text-muted">正在读取…</li>
          )}
          {runs?.status === "failed" && (
            <li className="flex items-center gap-2 py-1 pl-11 pr-2 text-caption text-muted">
              <span className="min-w-0 flex-1">这个项目的对话暂时读不到</span>
              <button type="button" onClick={onRetry} className="shrink-0 rounded px-1 text-link hover:underline">重试</button>
            </li>
          )}
          {runs?.status === "ready" && rows.length === 0 && (
            <li className="py-1 pl-11 pr-2 text-caption text-muted">还没有对话</li>
          )}
          {shown.map((conversation) => (
            <li key={conversation.sessionId}>
              <TaskRow
                conversation={conversation}
                projectId={project.id}
                projectName={project.name}
                current={current}
                active={isOpen(conversation.lead)}
                onOpen={(row) => onOpenTask(conversation.lead, row)}
              />
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                aria-expanded={showAll}
                onClick={onShowAll}
                className="flex h-7 w-full items-center gap-2 rounded-input pl-7 pr-2 text-left text-caption text-muted hover:text-text"
              >
                <span className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                {showAll ? "收起" : `展开其余 ${hidden} 条对话`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * One conversation: one line — its title, and at the end the time, or the one
 * mark it may carry (2026-09-23 plan §5.2). A spinner while it works; a small
 * dot once it has finished and nobody has opened it since; nothing otherwise.
 * 「已交付 · 有结论未逐字核对」 used to be a second line under every row: the
 * verification belongs to the report, and the list's job is to say which
 * conversation is which and which one wants you. In the search results the
 * project's name takes the time's place, because the results mix projects.
 *
 * A run whose session was never recorded has no conversation to open and is
 * not listed. The 「⋯」 beside a row (`ConversationMenu`) — stop, rename,
 * archive, delete — is offered for the project the shell is in, because every
 * one of those acts on that project's runtime.
 */
function TaskRow({
  conversation,
  projectId,
  projectName,
  current,
  active,
  withProject = false,
  onOpen,
  onWarm,
}: {
  conversation: Conversation;
  projectId: string;
  projectName: string;
  /** The conversation belongs to the project the shell is in. */
  current: boolean;
  /** This conversation is the one on screen. */
  active: boolean;
  withProject?: boolean;
  onOpen: (row: HTMLElement | null) => void;
  onWarm?: () => void;
}) {
  const run = conversation.lead;
  useRunsSeenVersion();
  useEffect(() => {
    if (active) markRunSeen(run);
  }, [active, run]);
  const target = taskTarget(run);
  if (!target) return null;
  const running = conversation.runs.some(isRunning);
  const unseen = !active && isRunUnseen(run);
  const className = "flex h-8 w-full items-center gap-2 rounded pl-7 pr-2 text-left hover:bg-surface-2 aria-[current=page]:bg-surface-2";
  const content = (
    <>
      <span className={cn("min-w-0 flex-1 truncate text-ui", unseen ? "font-medium text-text" : "text-text")}>{runTitle(conversation.titleRun)}</span>
      {running ? (
        <Loader2 size={16} className="shrink-0 animate-spin text-text-3 motion-reduce:animate-none" aria-label="进行中" />
      ) : (
        <span className={cn("flex shrink-0 items-center gap-1.5", current && "group-hover/task:invisible group-focus-within/task:invisible")}>
          {unseen && <span className="h-1.5 w-1.5 rounded-full bg-accent" role="img" aria-label="未打开" />}
          <span className="max-w-24 truncate text-meta tabular-nums text-text-3">
            {withProject ? projectName : compactTime(runMoment(run))}
          </span>
        </span>
      )}
    </>
  );
  const row = current ? (
    <Link
      to={target}
      data-task-key={taskKey(projectId, run)}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        // A modified click is the browser's to handle — that is the whole
        // point of this being a link.
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(event.currentTarget);
      }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      data-task-key={taskKey(projectId, run)}
      title={`切换到「${projectName}」并打开`}
      onClick={(event) => onOpen(event.currentTarget)}
      onPointerEnter={onWarm}
      onFocus={onWarm}
      className={className}
    >
      {content}
    </button>
  );
  if (!current) return row;
  return (
    <div className="group/task relative">
      {row}
      <span className="absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100 max-lg:opacity-100">
        <ConversationMenu conversation={conversation} />
      </span>
    </div>
  );
}
