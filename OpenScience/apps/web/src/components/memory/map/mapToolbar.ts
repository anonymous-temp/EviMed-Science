import { X } from "lucide-react";
import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarFilter, ToolbarProps } from "@/components/ui/Toolbar";
import { formatDay } from "@/lib/format";
import { kindTitle } from "@/lib/memoryGroups";
import { MAP_VIEWS, type MapView, type MemoryMap } from "@/lib/memoryMapClient";
import type { MapSelection } from "./useMapSelection";

export const VIEW_NAMES: Record<MapView, string> = { graph: "关系", topics: "主题", dims: "维度", time: "时间", activity: "活跃" };
const VIEW_OPTIONS: FilterOption<MapView>[] = MAP_VIEWS.map((value) => ({ value, label: VIEW_NAMES[value] }));

const RANGES: FilterOption<string>[] = [
  { value: "30d", label: "近 30 天" }, { value: "90d", label: "近 90 天" }, { value: "1y", label: "近一年" },
];

/** What the range chip says when the range is not one of the named ones: the days as a list dates them (「9月14日 至 9月20日」). */
export function rangeLabel(range: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u.exec(range);
  if (!match) return "全部时间";
  return match[1] === match[2] ? formatDay(match[1]) : `${formatDay(match[1])} 至 ${formatDay(match[2])}`;
}

/**
 * The map's one row of controls (R19, plan §5.5; DESIGN.md 「页面结构」 rule 5), above everything it controls: which of the five
 * views, then what narrows them all — the time, the kind of memory, what needs a look, and, as marks that let go with a press,
 * whatever else narrows the page (a topic, an aspect, the mark in focus) — and the search at the end. The project is the header's
 * (`ScopeMenu`), not a filter among these. A press on a control changes the shared selection; nothing here is a view of its own.
 *
 * The views are one group of chips, not a second row of tabs: the page's tab row is 记忆胶囊's four tabs, and a page has one.
 * Three things follow from the views being among the filters, and are said here so nobody undoes them:
 *  - the views are `pinned`: on a phone every other filter folds into one 「筛选」 chip, and the five views stay on the row — they are how the
 *    page is used, and a person should not have to open a menu to leave 关系;
 *  - the view is never counted as a filter (`neutral` is the view in force), so 「清除筛选」 does not appear for choosing 主题;
 *  - on the time view the window is the weekly bars' slider, so the 时间 menu is not drawn there and a window that is set is a mark
 *    that lets go of it, like a topic.
 */
export function mapToolbar({ selection, doc, topicName, aspectName, focusLabel, onView, onNarrow, onClear, search }: {
  selection: MapSelection;
  /** Null until the document is read: the views and the search are there from the first moment, so the band does not change. */
  doc: Pick<MemoryMap, "facets" | "summary"> | null;
  topicName: string | null;
  aspectName: string | null;
  focusLabel: string | null;
  onView: (view: MapView) => void;
  onNarrow: (patch: Partial<MapSelection>) => void;
  onClear: () => void;
  search: { draft: string; setDraft: (value: string) => void; clear: () => void; composition: object };
}): ToolbarProps {
  const filters: ToolbarFilter[] = [
    { kind: "chips", label: "地图的视图", options: VIEW_OPTIONS, value: selection.view, neutral: selection.view, pinned: true, onChange: (view) => onView(view as MapView) },
  ];
  const windowed = selection.range !== "all";
  if (selection.view === "time") {
    if (windowed) filters.push({ kind: "toggle", label: `时间：${rangeLabel(selection.range)}`, pressed: true, icon: X, onChange: () => onNarrow({ range: "all" }) });
  } else {
    const known = RANGES.some((range) => range.value === selection.range);
    filters.push({
      // 「全部时间」, not 「时间」: the chip stands beside the view that is called 时间, and two chips of one name read as one control.
      kind: "select", label: "全部时间", allLabel: "全部时间",
      options: !windowed || known ? RANGES : [...RANGES, { value: selection.range, label: rangeLabel(selection.range) }],
      value: windowed ? selection.range : null,
      onChange: (range) => onNarrow({ range: range ?? "all" }),
    });
  }
  const kinds: FilterOption<string>[] = (doc?.facets.kinds ?? []).map((kind) => ({ value: kind.id, label: kindTitle(kind.id), count: kind.count }));
  if (kinds.length > 0) filters.push({ kind: "select", label: "种类", allLabel: "全部种类", options: kinds, value: selection.kind, onChange: (kind) => onNarrow({ kind }) });
  // Only when something needs a look (or the page is already narrowed to it, so it can be let go): a chip for nothing is a filter that empties the page.
  if ((doc?.summary.needsLook ?? 0) > 0 || selection.look) filters.push({ kind: "toggle", label: "只看需要看一眼的", pressed: selection.look, onChange: (look) => onNarrow({ look }) });
  if (topicName) filters.push({ kind: "toggle", label: `主题：${topicName}`, pressed: true, icon: X, onChange: () => onNarrow({ topic: null }) });
  if (aspectName) filters.push({ kind: "toggle", label: `维度：${aspectName}`, pressed: true, icon: X, onChange: () => onNarrow({ dimension: null }) });
  if (selection.focus && focusLabel) {
    filters.push({ kind: "toggle", label: `聚焦：${focusLabel}`, pressed: true, icon: X, onChange: () => onNarrow({ focus: null }) });
    if (!selection.focus.startsWith("cluster:")) {
      filters.push({
        kind: "select", label: "深度", options: [{ value: "1", label: "深度 1" }, { value: "2", label: "深度 2" }],
        value: String(selection.depth), onChange: (depth) => onNarrow({ depth: depth === "2" ? 2 : 1 }),
      });
    }
    if (selection.focus.startsWith("memory:")) filters.push({ kind: "toggle", label: "来源链", pressed: selection.chain, onChange: (chain) => onNarrow({ chain }) });
  }
  return {
    label: "地图的视图与筛选",
    filters,
    onClear,
    search: { label: "搜索记忆地图", value: search.draft, maxLength: 80, onChange: search.setDraft, onClear: search.clear, inputProps: search.composition },
  };
}
