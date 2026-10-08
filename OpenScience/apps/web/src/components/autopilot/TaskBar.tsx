import { ChevronDown, ChevronLeft } from "lucide-react";
import { Link } from "react-router";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { activeAgenda, executionLabel, needsMaterial, pauseNotes, runState, scheduleLine, scheduleOf } from "./taskPresentation";

/** The executions the switcher lists: the newest, so a task that has run for a year does not open a menu a screen tall. */
const SWITCHER_LIMIT = 30;

/** What the bar's buttons do; the page decides how (a request, a confirmation, a dialog, a drawer). */
export interface TaskBarActions {
  run: () => void;
  stop: () => void;
  openProgress: () => void;
  edit: () => void;
  togglePause: () => void;
  remove: () => void;
  supply: () => void;
  selectExecution: (episodeId: string) => void;
}

/**
 * The strip over a task's conversation, drawn by the shell: the task's name; how often it runs, in which zone, and when next;
 * 「最新结果」, which opens the newest execution's file in the reader and needs no runtime; the switcher between executions
 * (「第 3 次 · 今天」); the one primary button — 「立即运行」, which becomes 「停止本次」 while an execution is on its way and cancels only
 * that execution — and 「⋯」 with the record (「研究进展」) and the task's own controls.
 *
 * It states no budget and asks for no confirmation to run. A task that waits on the researcher says so in a line of its own, with the
 * way to give it. The conversation is the kernel's, below; the shell draws no input box of its own.
 */
export function TaskBar({ agenda, executions, selected, running, stopping = false, latestResultHref, busy, actions, backTo, onResultOpened, error }: {
  agenda: AgendaRecord;
  /** This task's executions, oldest first. */
  executions: readonly EpisodeRecord[];
  /** The execution the conversation below shows. */
  selected: EpisodeRecord | null;
  /** An execution of this task that is on its way: the primary button stops it. */
  running: EpisodeRecord | null;
  /** That execution was asked to stop and has not yet ended. */
  stopping?: boolean;
  /** The reader's address for the newest execution's file, when one has a file to read. */
  latestResultHref: string | null;
  busy: boolean;
  actions: TaskBarActions;
  /** The list this page came from, when the list is not beside it: the way back is a link, not a browser button. */
  backTo?: string;
  onResultOpened: () => void;
  error?: { message: string; retry?: () => void } | null;
}) {
  const zone = scheduleOf(agenda).timeZone;
  const notes = pauseNotes(agenda);
  const waiting = needsMaterial(agenda);
  const completed = agenda.payload.scheduleState === "completed";
  const ordinal = (episode: EpisodeRecord) => executions.indexOf(episode) + 1;
  const switcher: MenuEntry[] = [...executions].reverse().slice(0, SWITCHER_LIMIT).map(episode => ({
    label: `${executionLabel(episode, ordinal(episode), zone)} · ${runState(episode.payload)}`,
    checked: episode.id === selected?.id,
    onSelect: () => actions.selectExecution(episode.id),
  }));
  const Heading = backTo ? "h1" : "h2";
  return <header className="shrink-0 border-b border-border px-6 py-3" data-task-bar="">
    {backTo && <Link to={backTo} className="-ml-1 mb-1 inline-flex items-center gap-0.5 text-caption text-text-3 hover:text-text"><ChevronLeft size={16} aria-hidden="true" />定时任务</Link>}
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <Heading className={backTo ? PAGE_TITLE_CLASS : "truncate text-section font-semibold text-text"}>{agenda.payload.title}</Heading>
        <p className="mt-0.5 text-caption text-text-3">{scheduleLine(agenda)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {latestResultHref && <Link to={latestResultHref} onClick={onResultOpened} className={buttonClasses({ variant: "text", size: "sm" })}>最新结果</Link>}
        {executions.length > 0 && selected && <Menu label="切换执行" align="end" items={switcher}>
          <Button variant="text" size="sm">{executionLabel(selected, ordinal(selected), zone)}<ChevronDown size={16} aria-hidden="true" /></Button>
        </Menu>}
        {running
          ? <Button variant="secondary" disabled={busy || stopping} onClick={actions.stop}>{stopping ? "正在停止" : "停止本次"}</Button>
          : <Button disabled={busy || !activeAgenda(agenda)} onClick={actions.run}>立即运行</Button>}
        <Menu label="更多" items={[
          { label: "研究进展", onSelect: actions.openProgress },
          { label: "编辑", disabled: busy, onSelect: actions.edit },
          ...(completed ? [] : [{ label: activeAgenda(agenda) ? "暂停" : "启用", disabled: busy, onSelect: actions.togglePause }]),
          "separator" as const,
          { label: "删除", destructive: true, disabled: busy, onSelect: actions.remove },
        ]} />
      </div>
    </div>
    {notes.map(note => <p key={note} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-pre-wrap break-words text-ui text-text-2">
      {note}
      {waiting && note.startsWith("需要你补充：") && <Button variant="secondary" size="sm" disabled={busy} onClick={actions.supply}>补充材料并继续</Button>}
    </p>)}
    {error && <div role="alert" className="mt-2 text-ui text-error">{error.message}{error.retry && <Button variant="text" disabled={busy} onClick={error.retry}>重试操作</Button>}</div>}
  </header>;
}
