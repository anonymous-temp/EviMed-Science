import { Tooltip } from "@/components/ui/Tooltip";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { vcrTabPath } from "@/components/vcr/vcrTabs";
import type { VcrTabKey } from "@/lib/vcrClient";

/**
 * The lower sidebar's research history: conversations and saved results grouped by research (study).
 *
 * Hidden knowledge: a programme study is one project (`VcrStudySummary.projectId`), so every conversation of that project belongs to it and
 * two sessions of one study stay two rows. A study a conversation made lives in the person's own ordinary project next to unrelated chats
 * and other such studies: it owns exactly the conversation it was made in (`sessionId`), several of them may share one project, and every
 * other conversation of that project stays an ordinary row. A study none of whose conversations survive is still reachable through exactly one saved-result row;
 * nothing is invented for an artifact that has no study. The grouping reads only what the sidebar already listed (the account's home
 * list and its runs), so a row the account may no longer read is never added here.
 */

export interface HistoryEntry {
  key: string; projectId: string; projectName: string; sessionId: string; title: string; at: number; studyId?: string; geoId?: string; geoOwnerId?: string;
  /** Where the row goes when it is not a conversation (a saved result). */
  to?: string;
}
export interface HistoryStudy { id: string; projectId: string; name: string; tabs: readonly VcrTabKey[]; calculation: boolean; at: number; /** Set for a study a conversation made: the conversation it owns (null when that conversation is gone). */ sessionId?: string | null }
export interface HistoryGroup { study: HistoryStudy; rows: HistoryEntry[]; saved: HistoryEntry | null; at: number }

const SAVED_TITLE = "已保存的结果";

export function savedResultPath(study: HistoryStudy): string {
  return study.calculation ? vcrCalculationPath(study.id) : vcrTabPath(study.id, study.tabs[0] ?? "overview");
}

/**
 * Split the listed conversations into research groups and the rest. Search matches a research's name (which keeps all of its rows) or a
 * conversation's title; everything else keeps the sidebar's own filter (title and project name).
 */
export function groupResearchHistory(entries: readonly HistoryEntry[], studies: readonly HistoryStudy[], query: string): { groups: HistoryGroup[]; rest: HistoryEntry[] } {
  const needle = query.trim().toLocaleLowerCase();
  const byProject = new Map<string, HistoryStudy>();
  const made: HistoryStudy[] = [];
  for (const study of studies) {
    if (study.sessionId !== undefined) made.push(study);
    else if (!byProject.has(study.projectId)) byProject.set(study.projectId, study);
  }
  const owned = new Map<string, HistoryEntry[]>();
  const rest: HistoryEntry[] = [];
  for (const entry of entries) {
    const study = entry.geoId ? undefined : byProject.get(entry.projectId) ?? made.find(row => row.projectId === entry.projectId && row.sessionId === entry.sessionId);
    if (!study) { if (`${entry.title} ${entry.projectName}`.toLocaleLowerCase().includes(needle)) rest.push(entry); continue; }
    owned.set(study.id, [...owned.get(study.id) ?? [], entry]);
  }
  const groups: HistoryGroup[] = [];
  for (const study of [...byProject.values(), ...made]) {
    const all = owned.get(study.id) ?? [];
    const named = !needle || study.name.toLocaleLowerCase().includes(needle);
    const rows = (named ? all : all.filter(row => row.title.toLocaleLowerCase().includes(needle))).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
    const saved: HistoryEntry | null = all.length === 0 && named
      ? { key: `saved:${study.id}`, projectId: study.projectId, projectName: study.name, sessionId: "", title: SAVED_TITLE, at: study.at, to: savedResultPath(study) } : null;
    if (rows.length === 0 && !saved) continue;
    // A group sits where its newest conversation sits, so an old research never rides above today's ordinary chat.
    groups.push({ study, rows, saved, at: rows.length ? Math.max(...rows.map(row => row.at)) : study.at });
  }
  groups.sort((a, b) => b.at - a.at || a.study.id.localeCompare(b.study.id));
  return { groups, rest };
}

export type HistoryItem = { kind: "group"; group: HistoryGroup; at: number; key: string } | { kind: "row"; row: HistoryEntry; at: number; key: string };

/** Research groups and ordinary conversations as one newest-first list. */
export function historyTimeline(groups: readonly HistoryGroup[], rows: readonly HistoryEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [
    ...groups.map(group => ({ kind: "group" as const, group, at: group.at, key: group.study.id })),
    ...rows.map(row => ({ kind: "row" as const, row, at: row.at, key: row.key })),
  ];
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** One research: its name, then its conversations (or its one saved result). The row's press is the sidebar's own `open`. */
export function VcrResearchGroup({ group: { study, rows, saved }, isCurrent, onOpen }: { group: HistoryGroup; isCurrent: (row: HistoryEntry) => boolean; onOpen: (row: HistoryEntry) => void }) {
  const shown = saved ? [saved] : rows;
  return <div role="group" aria-label={`研究：${study.name}`} data-vcr-research={study.id} className="flex flex-col">
      <Tooltip kind="label" content={study.name} whenTruncated><span className="mx-2 mt-1 truncate px-3 pt-1 text-caption text-text-3">{study.name}</span></Tooltip>
      {shown.map(row => <button key={row.key} type="button" onClick={() => onOpen(row)} aria-current={isCurrent(row) ? "page" : undefined}
        className="mx-2 flex min-h-control items-center gap-2 rounded py-2 pl-5 pr-3 text-left text-ui text-text-2 outline-none hover:bg-surface-2 hover:text-text focus-visible:outline-focus aria-[current=page]:bg-surface-2 aria-[current=page]:text-text">
        <Tooltip kind="label" content={row.title} whenTruncated><span className="min-w-0 flex-1 truncate">{row.title}</span></Tooltip>
      </button>)}
    </div>;
}
