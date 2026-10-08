import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import type { WebAgentRun, WebRunDeliverableStatus } from "@/lib/apiClient";
import { currentPhaseLabel, childrenLine, progressCountsLine, runDeliverables, runProgressOf } from "@/lib/runProgress";
import { registerTaskPane } from "@/lib/taskPane";
import { RunStatusDot } from "@/components/runs/RunStatusDot";
import { activeAgenda, inFlight, instant, runState, scheduleOf, zoneName } from "./taskPresentation";

/** The state words of a plan item, in the product's own (appendix B): the ledger's gate words are not the researcher's. */
const ITEM_STATE: Record<WebRunDeliverableStatus, string> = {
  planned: "待开始", delegated: "进行中", submitted: "进行中", rejected: "进行中", accepted: "已完成", delivered: "已完成", failed: "未完成",
};

/**
 * Whether the kernel's conversation can be shown for an execution. One that ended has its conversation in the project's own runtime
 * (the one the researcher opens); one still on its way has it there only when it runs in that runtime (`interactive`). A bounded
 * runtime holds the project, so while one is on its way no conversation of the project can be opened at all (`lock`).
 */
export function conversationOf(execution: EpisodeRecord | null, lock: EpisodeRecord | null): string | null {
  const sessionId = execution?.payload.sessionId;
  if (!execution || !sessionId || lock) return null;
  return !inFlight(execution) || execution.payload.interactive === true ? sessionId : null;
}

/**
 * The bounded execution that holds this project's runtime, if one does: the newest that is running (or being checked afterwards)
 * and is not interactive. One still queued holds nothing — the runtime is reserved when it starts — so while it waits the
 * project's conversations open as they always do.
 */
export function boundedLock(episodes: readonly EpisodeRecord[]): EpisodeRecord | null {
  let newest: EpisodeRecord | null = null;
  for (const episode of episodes) {
    if (!inFlight(episode) || episode.payload.status === "queued" || episode.payload.interactive === true) continue;
    if (!newest || (episode.payload.createdAt ?? "") > (newest.payload.createdAt ?? "")) newest = episode;
  }
  return newest;
}

/**
 * What fills the area under the task bar.
 *
 * The task is a conversation, and the conversation is the kernel's. The shell keeps one resident frame (reloading an iframe is the
 * cost it exists to avoid), so this component draws nothing for it: it is the empty pane the frame is placed over
 * (`registerTaskPane` → `SessionFrameHost`), and it asks for the frame only when there is a conversation to show. When there is not,
 * it says why in the pane itself, in plain text and without a card:
 *
 *  - an execution in a bounded runtime is on its way: its progress from the run ledger, and that the conversation can be continued
 *    once it ends (the page then moves to it by itself);
 *  - an execution is waiting to start, or ended without a conversation: its state;
 *  - the task has never run: its instruction and when it will.
 *
 * Nothing here is an input box: a follow-up is a message in the kernel's own.
 */
export function TaskPane({ agenda, execution, lock, ledgerRun, projectId }: {
  agenda: AgendaRecord;
  /** The execution whose conversation is wanted, or null for a task that has not run. */
  execution: EpisodeRecord | null;
  /** The bounded execution holding the project's runtime, if any (`boundedLock`). */
  lock: EpisodeRecord | null;
  /** The run ledger's record of that execution, for its progress. */
  ledgerRun: WebAgentRun | null;
  projectId: string;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const sessionId = conversationOf(execution, lock);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !sessionId) return undefined;
    return registerTaskPane({ element, projectId, sessionId });
  }, [sessionId, projectId]);

  if (sessionId) return <div ref={pane} role="region" aria-label="任务对话" data-task-pane="conversation" className="relative min-h-0 flex-1" />;
  const zone = scheduleOf(agenda).timeZone;
  const box = (kind: string, children: ReactNode) => <div role="region" aria-label="任务对话" data-task-pane={kind} className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-body space-y-4 px-6 py-8">{children}</div>
  </div>;

  if (lock) {
    const own = lock.payload.agendaId === agenda.id;
    const progress = own && ledgerRun ? runProgressOf(ledgerRun) : null;
    const items = own && ledgerRun ? runDeliverables(ledgerRun) : [];
    const lines = [currentPhaseLabel(progress), progressCountsLine(progress), childrenLine(progress)].filter(Boolean);
    return box("progress", <>
      <p className="flex items-center gap-2 text-ui font-medium text-text"><RunStatusDot state="running" labelled />{own ? runState(lock.payload) : "这个项目里另一项任务正在执行"}</p>
      {lines.length > 0 && <ul className="space-y-1 text-ui text-text-2">{lines.map(line => <li key={line}>{line}</li>)}</ul>}
      {items.length > 0 && <ul aria-label="研究计划" className="space-y-1 text-ui text-text">{items.map(item => <li key={item.id} className="flex items-baseline justify-between gap-3"><span className="min-w-0 break-words">{item.title}</span><span className="shrink-0 text-caption text-text-3">{ITEM_STATE[item.status] ?? "待开始"}</span></li>)}</ul>}
      <p className="text-caption text-text-3">执行结束后可以在这里继续</p>
    </>);
  }
  if (execution) {
    const waiting = Object.values(execution.payload.resourceDeferrals ?? {}).find(value => value?.status === "waiting");
    const retry = waiting?.retryAt ? `预计重试 ${instant(waiting.retryAt, zone)}` : "";
    return box(inFlight(execution) ? "waiting" : "no-conversation", <>
      {(inFlight(execution) || execution.payload.status !== "merged") && <p className="flex items-center gap-2 text-ui font-medium text-text">{inFlight(execution) && <RunStatusDot state="running" labelled />}{runState(execution.payload)}</p>}
      {retry && <p className="text-ui text-text-2">{retry}</p>}
      {!inFlight(execution) && <p className="text-ui text-text-3">这次执行没有留下对话。</p>}
    </>);
  }
  const instruction = agenda.payload.prompt ?? agenda.payload.topics.join("\n");
  // The time is said with its zone: a time without one is ambiguous.
  const nextAt = activeAgenda(agenda) && agenda.payload.nextRunAt ? instant(agenda.payload.nextRunAt, zone) : "";
  return box("never-run", <>
    <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-text">{instruction}</p>
    <p className="text-ui text-text-3">{nextAt ? `还没有执行过，下次 ${nextAt}${zoneName(zone) ? ` ${zoneName(zone)}` : ""}` : "还没有执行过"}</p>
  </>);
}
