import { FolderOpen, Radar, UsersRound } from "lucide-react";
import type { WebStructuredMemory } from "@/lib/apiClient";
import { capabilityTitle } from "@/lib/researchAgentUi";
import type { WebHandbook } from "@/lib/handbooksClient";
import { entryGroup, recordGroup, recordProjectId, selfSection, type MemoryGroup, type SelfSection } from "@/lib/memoryGroups";
import type { OwnCapsuleEntry } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { projectLabels, type LabelledProject } from "@/lib/projectNames";
import type { ScopeGroup } from "@/components/ui/ScopeMenu";
import { methodTitle, type WebMethod } from "@/lib/methodsClient";
import { fileSummary, fileTopic, isFileMemory } from "./memoryNative";

/**
 * What the memory page lists, as one shape per kind of row. Two stores hold a
 * fact (the structured memories and the notes of the researcher's own capsule)
 * and two hold a practice (a learned method and a capability handbook); the page
 * reads each as one list, so each pair is one type here and the rest of the page
 * never asks which store a row came from until it has to write to it.
 */

/** A fact: one sentence about the researcher or a project, from either store. */
export type FactItem =
  | { kind: "record"; key: string; group: MemoryGroup; section: SelfSection; projectId: string | null; at: string; text: string;
    record: WebStructuredMemory }
  | { kind: "entry"; key: string; group: MemoryGroup; section: SelfSection; projectId: string | null; at: string; text: string; entry: OwnCapsuleEntry };

/** A practice the platform learned: for every study, or for one research tool. */
export type PracticeItem =
  | { kind: "method"; key: string; at: string; title: string; summary: string; tool: null; method: WebMethod }
  | { kind: "handbook"; key: string; at: string; title: string; summary: string; tool: string; handbook: WebHandbook };

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

/** The practices a list shows: learned methods for every study, then handbooks for one tool each. */
export function practiceItems(
  methods: readonly WebMethod[],
  handbooks: readonly WebHandbook[],
  { query = "" }: { query?: string } = {},
): { methods: PracticeItem[]; handbooks: PracticeItem[] } {
  const text = query.trim();
  const found = (item: PracticeItem) => !text || matches(`${item.title} ${item.summary} ${item.tool ?? ""}`, text);
  return {
    methods: newestFirst(methods.filter((method) => method.status === "approved").map((method): PracticeItem => ({
      kind: "method", key: `method:${method.id}`, at: method.bodyUpdatedAt ?? method.updatedAt ?? "", title: methodTitle(method),
      summary: method.summary || (method.description ? memoryExcerpt(method.description, 120) : ""), tool: null, method,
    })).filter(found)),
    handbooks: newestFirst(handbooks.filter((handbook) => handbook.status === "active").map((handbook): PracticeItem => ({
      kind: "handbook", key: `handbook:${handbook.id}`, at: handbook.appliedAt ?? handbook.updatedAt ?? "", title: handbook.title,
      summary: handbook.summary ?? "", tool: (handbook.capabilityId ? capabilityTitle(handbook.capabilityId) : null) ?? "科研工具", handbook,
    })).filter(found)),
  };
}

/** Where a project in the dropdown belongs: the researcher's own, a 虚拟临床研究 study, or a 循证 GEO project. */
export type ProjectKind = "own" | "vcr" | "geo";

export interface ProjectChoice {
  /** A project's id; null is the facts that name no project the account still has. */
  id: string | null;
  name: string;
  kind: ProjectKind;
}

/** The choice that holds the facts naming no project the account still has. */
export const OTHER_PROJECT = "__other";

/**
 * The projects the 项目 tab can show, in the order the dropdown lists them:
 * the researcher's own first, then each module's own group. A project with no
 * facts is still listed (its list says so), because a dropdown that offers only
 * the projects that happen to have memory hides the one a researcher came to
 * look at.
 */
export function projectChoices(
  projects: readonly LabelledProject[],
  { vcr, geo }: { vcr: ReadonlySet<string>; geo: ReadonlySet<string> },
  facts: readonly FactItem[],
): ProjectChoice[] {
  const known = new Set(projects.map((project) => project.id));
  // Two projects of one name read differently in this dropdown, as in every other (`projectLabels`).
  const labels = projectLabels(projects);
  const kindOf = (id: string): ProjectKind => (vcr.has(id) ? "vcr" : geo.has(id) ? "geo" : "own");
  const order: ProjectKind[] = ["own", "vcr", "geo"];
  const listed = projects
    .map((project): ProjectChoice => ({ id: project.id, name: labels.get(project.id) ?? project.name, kind: kindOf(project.id) }))
    .sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
  const orphans = facts.some((fact) => fact.group === "project" && (fact.projectId === null || !known.has(fact.projectId)));
  return orphans ? [...listed, { id: OTHER_PROJECT, name: "其他", kind: "own" }] : listed;
}

/** The heading and mark of each group of the project menu: the researcher's own projects need neither a heading nor a new mark. */
const SCOPE_GROUPS = {
  own: { heading: undefined, icon: FolderOpen },
  vcr: { heading: "虚拟临床研究", icon: UsersRound },
  geo: { heading: "循证 GEO", icon: Radar },
} as const;

/**
 * The project choices as the header's scope menu groups them (`ScopeMenu`): the researcher's own projects first, then each module's
 * own group under its name, as the sidebar and the knowledge base list them — so two studies with one name are never mistaken for the
 * researcher's own projects. The choice that holds the facts naming no project the account still has is an ordinary entry, 「其他」.
 */
export function projectScopeGroups(choices: readonly ProjectChoice[]): ScopeGroup[] {
  const groups: ScopeGroup[] = [];
  let kind: ProjectKind | null = null;
  for (const choice of choices) {
    const { heading, icon } = SCOPE_GROUPS[choice.kind];
    const entry = { id: choice.id ?? OTHER_PROJECT, label: choice.name, icon };
    if (choice.kind === kind && groups.length > 0) {
      const last = groups[groups.length - 1]!;
      groups[groups.length - 1] = { ...last, choices: [...last.choices, entry] };
    } else {
      groups.push({ heading, choices: [entry] });
      kind = choice.kind;
    }
  }
  return groups;
}

/** The facts of the project a dropdown names; the ones that name none the account has under 「其他」. */
export function factsOfProject(facts: readonly FactItem[], projectId: string | null, known: ReadonlySet<string>): FactItem[] {
  return facts.filter((fact) => fact.group === "project" && (projectId === OTHER_PROJECT
    ? fact.projectId === null || !known.has(fact.projectId)
    : fact.projectId === projectId));
}

/** The quiet line under a row: what a file memory says under its topic. A sentence needs none. */
export function factRowSummary(item: FactItem): string | undefined {
  return item.kind === "record" && isFileMemory(item.record) ? fileSummary(item.record) || undefined : undefined;
}
