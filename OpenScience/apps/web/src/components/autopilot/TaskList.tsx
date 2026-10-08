import { Plus } from "lucide-react";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { taskPath } from "@/lib/taskLocation";
import { RunStatusDot } from "@/components/runs/RunStatusDot";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { cn } from "@/lib/cn";
import { TaskGroup } from "./TaskGroup";
import { activeAgenda, inFlight, rowLine, TASK_GROUPS, taskGroupOf } from "./taskPresentation";

/** What a row's 「⋯」 does to its task; the page decides how (a confirmation, a request, a dialog). */
export interface TaskRowActions {
  run: (agenda: AgendaRecord) => void;
  togglePause: (agenda: AgendaRecord) => void;
  edit: (agenda: AgendaRecord) => void;
  remove: (agenda: AgendaRecord) => void;
}

/**
 * The tasks of the project, as one column of the page (the whole page when there is no room for a conversation beside it).
 *
 * The header is the page's heading and one quiet 「新建」 icon button; under it, a search box and the groups 即将执行 / 已暂停 / 已完成,
 * a group with nothing in it not drawn. A row is the task's name and one line — when it runs next and how often, that it is running,
 * why it stopped — and its 「⋯」, always visible. It is a link: it opens the task's page, and the open task's row is marked.
 */
export function TaskList({ agendas, episodes, selectedId, search, onSearch, projectName, error, onRetry, onCreate, busy, actions, singleColumn }: {
  agendas: AgendaRecord[] | null;
  /** The project's newest executions: which tasks are running now. */
  episodes: readonly EpisodeRecord[];
  selectedId: string | null;
  search: string;
  onSearch: (value: string) => void;
  projectName?: string;
  error: string | null;
  onRetry: () => void;
  onCreate: () => void;
  busy: boolean;
  actions: TaskRowActions;
  /** The list is the page: it keeps to the list column's measure instead of the width of its container. */
  singleColumn: boolean;
}) {
  const needle = search.trim().toLocaleLowerCase();
  const visible = (agendas ?? []).filter(agenda => !agenda.payload.archivedAt
    && `${agenda.payload.title}\n${agenda.payload.prompt ?? agenda.payload.topics.join(" ")}`.toLocaleLowerCase().includes(needle));
  const running = new Set(episodes.filter(inFlight).map(episode => episode.payload.agendaId));
  const now = new Date();
  const groups = TASK_GROUPS.map(([key, label]) => [label, visible.filter(agenda => taskGroupOf(agenda) === key)
    .sort((a, b) => key === "upcoming" ? (a.payload.nextRunAt ?? "z").localeCompare(b.payload.nextRunAt ?? "z") : a.payload.title.localeCompare(b.payload.title, "zh-CN"))] as const)
    .filter(([, items]) => items.length > 0);
  const row = (agenda: AgendaRecord) => {
    const open = agenda.id === selectedId;
    const completed = taskGroupOf(agenda) === "completed";
    const operable = !busy;
    return <ListRow key={agenda.id} to={taskPath(agenda.id, { search })} title={agenda.payload.title} muted={taskGroupOf(agenda) !== "upcoming"}
      selected={open} titleProps={{ "data-task-id": agenda.id, "aria-current": open ? "page" : undefined }}
      // The dot sits in a gutter every row has, so the names start on one left edge whether or not a task is running.
      leading={running.has(agenda.id) ? <RunStatusDot state="running" labelled /> : <span className="inline-block h-2.5 w-2.5" aria-hidden="true" />}
      meta={<span className="block line-clamp-2 break-words">{rowLine(agenda, running.has(agenda.id), now)}</span>}
      menu={<Menu label={`“${agenda.payload.title}”的更多操作`} items={[
        { label: "立即运行", disabled: !operable || !activeAgenda(agenda), onSelect: () => actions.run(agenda) },
        ...(completed ? [] : [{ label: activeAgenda(agenda) ? "暂停" : "启用", disabled: !operable, onSelect: () => actions.togglePause(agenda) }]),
        { label: "编辑", disabled: !operable, onSelect: () => actions.edit(agenda) },
        "separator" as const,
        { label: "删除", destructive: true, disabled: !operable, onSelect: () => actions.remove(agenda) },
      ]} />} />;
  };
  return <div className={cn("flex min-h-0 flex-1 flex-col", singleColumn && "mx-auto w-full max-w-page")}>
    <header className="flex min-h-8 shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-5">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className={PAGE_TITLE_CLASS}>定时任务</h1>
        {projectName && <span className="min-w-0 truncate text-caption text-text-3">{projectName}</span>}
      </div>
      <IconButton icon={Plus} label="新建" onClick={onCreate} />
    </header>
    {/* A search box over nothing to search is not drawn. */}
    {(agendas?.length ?? 0) > 0 && <div className="shrink-0 px-4 pb-3"><SearchInput label="搜索任务" value={search} onChange={event => onSearch(event.target.value)} onClear={() => onSearch("")} className="w-full" /></div>}
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-6">
      {error && <LoadError message={error} onRetry={onRetry} className="mx-2" />}
      {agendas === null ? <FilesSkeleton /> : <>
        {groups.map(([label, items]) => <TaskGroup key={label} label={label}><List>{items.map(row)}</List></TaskGroup>)}
        {visible.length === 0 && !error && <p className="px-4 text-ui text-text-3">{search.trim() ? "没有匹配的任务" : "还没有定时任务"}</p>}
      </>}
    </div>
  </div>;
}
