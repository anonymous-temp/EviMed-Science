import type { WebStructuredMemory } from "@/lib/apiClient";
import { entryGroup, recordGroup, recordProjectId, selfSection, type MemoryGroup, type SelfSection } from "@/lib/memoryGroups";
import type { OwnCapsuleEntry } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { methodTitle, type WebMethod } from "@/lib/methodsClient";
import { fileSummary, fileTopic, isFileMemory } from "./memoryNative";

/**
 * What the memory page lists, as one shape per kind of row. Two stores hold a
 * fact (the structured memories and the notes of the researcher's own capsule);
 * the page reads them as one list, so the pair is one type here and the rest of
 * the page never asks which store a row came from until it has to write to it.
 * A practice is a learned method.
 */

/** A fact: one sentence about the researcher or a project, from either store. */
export type FactItem =
  | { kind: "record"; key: string; group: MemoryGroup; section: SelfSection; projectId: string | null; at: string; text: string;
    record: WebStructuredMemory }
  | { kind: "entry"; key: string; group: MemoryGroup; section: SelfSection; projectId: string | null; at: string; text: string; entry: OwnCapsuleEntry };

/** A practice the platform learned, for every study. */
export type PracticeItem = { kind: "method"; key: string; at: string; title: string; summary: string; method: WebMethod };

/** What a row in the hub is, for the one drawer that opens at a time. */
export type OpenItem = FactItem | PracticeItem;

export function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/** A newer row first; the key breaks a tie so the order never depends on the order the stores answered in. */
function newestFirst<T extends { at: string; key: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.at.localeCompare(left.at) || left.key.localeCompare(right.key));
}

/**
 * The facts a list shows: memories in force and the notes in force, newest
 * first.
 *
 * A run summary names a conversation and is not a memory. A forgotten fact is
 * under 已忘记的内容, not in the list, searched or not.
 */
export function factItems(
  records: readonly WebStructuredMemory[],
  entries: readonly OwnCapsuleEntry[],
  { query = "" }: { query?: string } = {},
): FactItem[] {
  const text = query.trim();
  const shown = records.filter((record) => record.kind !== "run_summary");
  const items: FactItem[] = [
    ...shown
      .filter((record) => record.status !== "archived")
      .map((record): FactItem => ({
        kind: "record", key: `record:${record.id}`, group: recordGroup(record), section: selfSection(record.kind), projectId: recordProjectId(record),
        at: record.updatedAt ?? record.createdAt ?? "", text: isFileMemory(record) ? fileTopic(record) : memoryExcerpt(record.summary || record.value),
        record,
      })),
    ...entries
      .filter((entry) => entry.payload.status !== "retired" && (!text || matches(entry.payload.content, text)))
      .map((entry): FactItem => ({
        kind: "entry", key: `entry:${entry.id}`, group: entryGroup(entry), section: selfSection(entry.payload.factKind), projectId: entry.projectId ?? null,
        at: entry.updatedAt ?? entry.createdAt ?? "", text: memoryExcerpt(entry.payload.content), entry,
      })),
  ];
  return newestFirst(items);
}

/** The practices a list shows: the learned methods in force, newest first. */
export function practiceItems(
  methods: readonly WebMethod[],
  { query = "" }: { query?: string } = {},
): PracticeItem[] {
  const text = query.trim();
  return newestFirst(methods.filter((method) => method.status === "approved").map((method): PracticeItem => ({
    kind: "method", key: `method:${method.id}`, at: method.bodyUpdatedAt ?? method.updatedAt ?? "", title: methodTitle(method),
    summary: method.summary || (method.description ? memoryExcerpt(method.description, 120) : ""), method,
  })).filter((item) => !text || matches(`${item.title} ${item.summary}`, text)));
}

/** What the memories of a project the account no longer has are filed under, wherever it is printed: the lists and the dashboard. */
export const OTHER_PROJECT_LABEL = "未归入项目";

/** The quiet line under a row: what a file memory says under its topic. A sentence needs none. */
export function factRowSummary(item: FactItem): string | undefined {
  return item.kind === "record" && isFileMemory(item.record) ? fileSummary(item.record) || undefined : undefined;
}
