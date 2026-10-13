import { knowledgePageTypeLabel } from "@evimed/domain";
import type { KnowledgeGraph, KnowledgeGraphSource, KnowledgeStaleReason, KnowledgeTreeName } from "@/lib/sourceClient";

/**
 * What the knowledge graph draws, decided before any chart library is asked: the marks and lines of either graph in one
 * shape, the overview cut to a size a picture can hold (the rest folded by type, never a hairball), the neighbourhood of
 * one mark, the marks a search names, and which three kinds carry a colour. Plain functions of the route's answer, so the
 * words and the cuts are tested without a canvas; `knowledgeGraphOption.ts` is the one place the library is told.
 */

/** The most marks the overview draws; the rest of a type is folded into one mark with its count. */
export const OVERVIEW_LIMIT = 150;
/** The most marks any picture draws, even where the reader unfolded a type: past this a picture says less than the list. */
export const HARD_LIMIT = 400;
/** Fewer marks than this and the list says it better than a picture. */
export const MIN_MARKS = 4;

export interface GraphMark {
  /** The graph's own id: a page's path, an entity's id. */
  id: string;
  title: string;
  /** The page type, or the entity type as the compile wrote it. */
  type: string;
  typeLabel: string;
  description: string;
  aliases: string[];
  degree: number;
  /** The mirrored file's document id: what opening the mark opens. */
  sourceId: string | null;
  stale: KnowledgeStaleReason[];
  userEdited: boolean;
  sources: KnowledgeGraphSource[];
}
export interface GraphLine {
  from: string;
  to: string;
  /** The relation in words, or the link's text. */
  label: string;
  relation: string | null;
  evidence: KnowledgeGraphSource[];
}
export interface GraphModel {
  kind: KnowledgeTreeName;
  marks: GraphMark[];
  lines: GraphLine[];
}

/** The few entity types a compile writes most, in the reader's words; any other stays as the compile wrote it. */
const ENTITY_TYPE_LABEL: Readonly<Record<string, string>> = {
  person: "人物", people: "人物", organization: "机构", org: "机构", company: "机构", document: "文件", file: "文件", concept: "概念",
  project: "项目", system: "系统", tool: "工具", product: "产品", event: "事件", location: "地点", place: "地点", metric: "指标",
  drug: "药物", disease: "疾病", trial: "试验", outcome: "结局", protocol: "方案", method: "方法", other: "其他",
};

/** The name of a kind of mark. */
export function typeLabelOf(kind: KnowledgeTreeName, type: string): string {
  if (kind === "wiki") return knowledgePageTypeLabel(type);
  return ENTITY_TYPE_LABEL[type] ?? type.replace(/_/gu, " ");
}

/** Marks and lines of a route's answer: a line whose end is no mark is left out, a line between the same two marks with the same relation is one. */
export function modelOf(graph: KnowledgeGraph): GraphModel {
  const kind = graph.kind;
  const marks = graph.nodes.map((node): GraphMark => {
    const type = (kind === "kg" ? node.entityType : node.type) || (kind === "kg" ? "other" : "page");
    return {
      id: node.id, title: node.title || node.id, type, typeLabel: typeLabelOf(kind, type), description: node.description ?? "",
      aliases: node.aliases ?? [], degree: node.degree ?? 0, sourceId: node.sourceId ?? null,
      stale: (node.stale ?? []).map((entry) => entry.reason), userEdited: Boolean(node.userEdited), sources: node.sources ?? [],
    };
  });
  const known = new Set(marks.map((mark) => mark.id));
  const seen = new Set<string>();
  const lines: GraphLine[] = [];
  for (const link of graph.links) {
    if (!known.has(link.source) || !known.has(link.target) || link.source === link.target) continue;
    const key = `${link.source}\u0000${link.target}\u0000${link.relation ?? link.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ from: link.source, to: link.target, label: link.label || "", relation: link.relation ?? null, evidence: link.evidence ?? [] });
  }
  // A degree the route did not count is counted here.
  if (marks.every((mark) => mark.degree === 0) && lines.length > 0) {
    const count = new Map<string, number>();
    for (const line of lines) { count.set(line.from, (count.get(line.from) ?? 0) + 1); count.set(line.to, (count.get(line.to) ?? 0) + 1); }
    for (const mark of marks) mark.degree = count.get(mark.id) ?? 0;
  }
  return { kind, marks, lines };
}

/** The mark that heads the list: the most connected first, then by title. */
const byDegree = (left: GraphMark, right: GraphMark) => right.degree - left.degree || left.title.localeCompare(right.title, "zh-Hans-CN");

export interface FoldedType { type: string; label: string; count: number }
export interface Overview {
  marks: GraphMark[];
  /** A line between two shown marks, or from a fold to a shown mark (`from`/`to` is `fold:<type>` then). */
  lines: GraphLine[];
  folded: FoldedType[];
}

/** The id of the mark that stands for the folded part of a type. */
export const foldId = (type: string) => `fold:${type}`;
export const isFold = (id: string) => id.startsWith("fold:");

/**
 * The overview: at most `limit` marks, the most connected ones, the rest of each type folded into one mark that says how
 * many it holds. A type the reader unfolded (`expanded`) shows all its marks, up to `HARD_LIMIT` in all. A line from a folded
 * mark to a shown one becomes a line from the fold; two folded marks are not drawn.
 */
export function overview(model: GraphModel, { limit = OVERVIEW_LIMIT, expanded = new Set<string>() }: { limit?: number; expanded?: ReadonlySet<string> } = {}): Overview {
  if (model.marks.length <= limit) return { marks: model.marks, lines: model.lines, folded: [] };
  const ranked = [...model.marks].sort(byDegree);
  const shown = new Set<string>();
  for (const mark of ranked) if (expanded.has(mark.type) && shown.size < HARD_LIMIT) shown.add(mark.id);
  for (const mark of ranked) { if (shown.size >= limit) break; shown.add(mark.id); }
  const folds = new Map<string, FoldedType>();
  const typeOf = new Map(model.marks.map((mark) => [mark.id, mark]));
  for (const mark of model.marks) {
    if (shown.has(mark.id)) continue;
    const fold = folds.get(mark.type) ?? { type: mark.type, label: mark.typeLabel, count: 0 };
    fold.count += 1;
    folds.set(mark.type, fold);
  }
  const lines: GraphLine[] = [];
  const foldLines = new Set<string>();
  for (const line of model.lines) {
    const from = shown.has(line.from) ? line.from : null;
    const to = shown.has(line.to) ? line.to : null;
    if (from && to) lines.push(line);
    else if (from || to) {
      const hidden = typeOf.get(from ? line.to : line.from);
      if (!hidden) continue;
      const key = `${from ?? foldId(hidden.type)}\u0000${to ?? foldId(hidden.type)}`;
      if (foldLines.has(key)) continue;
      foldLines.add(key);
      lines.push({ from: from ?? foldId(hidden.type), to: to ?? foldId(hidden.type), label: "", relation: null, evidence: [] });
    }
  }
  return { marks: model.marks.filter((mark) => shown.has(mark.id)), lines, folded: [...folds.values()].sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)) };
}

/** The marks within `depth` steps of one mark, either direction, the most connected kept if there are more than `limit`. */
export function neighbourhood(model: GraphModel, focus: string, depth: number, limit = OVERVIEW_LIMIT): GraphModel {
  if (!model.marks.some((mark) => mark.id === focus)) return model;
  const around = new Map<string, Set<string>>();
  for (const line of model.lines) {
    (around.get(line.from) ?? around.set(line.from, new Set()).get(line.from)!).add(line.to);
    (around.get(line.to) ?? around.set(line.to, new Set()).get(line.to)!).add(line.from);
  }
  const reached = new Set([focus]);
  let edge = [focus];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const id of edge) for (const other of around.get(id) ?? []) if (!reached.has(other)) { reached.add(other); next.push(other); }
    edge = next;
  }
  let kept = model.marks.filter((mark) => reached.has(mark.id));
  if (kept.length > limit) kept = [...kept.filter((mark) => mark.id === focus), ...kept.filter((mark) => mark.id !== focus).sort(byDegree).slice(0, limit - 1)];
  const ids = new Set(kept.map((mark) => mark.id));
  return { kind: model.kind, marks: kept, lines: model.lines.filter((line) => ids.has(line.from) && ids.has(line.to)) };
}

/** The marks a search names: by title, description, alias or the name of their kind. */
export function searchHits(marks: readonly GraphMark[], query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) return new Set();
  return new Set(marks.filter((mark) => `${mark.title} ${mark.description} ${mark.aliases.join(" ")} ${mark.typeLabel}`.toLowerCase().includes(needle)).map((mark) => mark.id));
}

/** How many colours the picture uses for kinds of mark, besides the neutral one. */
export const HUES = 3;

/**
 * Which kinds carry a colour: the three with the most marks, in that order; every other kind is neutral. The vocabulary is
 * the compile's and open, so no kind is promised a colour — the legend says which three have one.
 */
export function hueOfTypes(marks: readonly GraphMark[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const mark of marks) count.set(mark.type, (count.get(mark.type) ?? 0) + 1);
  const ranked = [...count.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return new Map(ranked.slice(0, HUES).map(([type], index) => [type, index]));
}

/** The lines between two marks, both directions: what a click on one of them shows. */
export function linesBetween(lines: readonly GraphLine[], one: string, other: string): GraphLine[] {
  return lines.filter((line) => (line.from === one && line.to === other) || (line.from === other && line.to === one));
}

/** The documents a set of lines were read from, once each, in the order met. */
export function evidenceOf(lines: readonly GraphLine[]): KnowledgeGraphSource[] {
  const seen = new Set<string>();
  const out: KnowledgeGraphSource[] = [];
  for (const line of lines) for (const entry of line.evidence) if (!seen.has(entry.sourceId)) { seen.add(entry.sourceId); out.push(entry); }
  return out;
}

/** The marks as a list for a person (and a screen reader): a search's hits alone, else the most connected first. */
export function listedMarks(marks: readonly GraphMark[], hits: ReadonlySet<string>): GraphMark[] {
  const rows = hits.size > 0 ? marks.filter((mark) => hits.has(mark.id)) : [...marks];
  return rows.sort(byDegree);
}

/** Whether there is too little to draw: the list says it better. */
export function isThin(model: Pick<GraphModel, "marks" | "lines">): boolean {
  return model.marks.length < MIN_MARKS || model.lines.length === 0;
}

/**
 * The lines of the overview with the index page's own left out: an index links to every page, so drawn it is a hub of lines
 * that says nothing but "these are pages". A focus on the index itself keeps them.
 */
export function withoutIndexLines(lines: readonly GraphLine[], marks: readonly GraphMark[], focus: string | null): GraphLine[] {
  const indexes = new Set(marks.filter((mark) => mark.type === "index" && mark.id !== focus).map((mark) => mark.id));
  return indexes.size === 0 ? [...lines] : lines.filter((line) => !indexes.has(line.from) && !indexes.has(line.to));
}
