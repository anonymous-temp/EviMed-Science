import { X } from "lucide-react";
import { FilterChip, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { kindTitle } from "@/lib/memoryGroups";
import { SearchInput } from "@/components/ui/SearchInput";
import type { MemoryMap } from "@/lib/memoryMapClient";
import type { MapSelection } from "./useMapSelection";

const RANGES: FilterOption<string>[] = [
  { value: "30d", label: "近 30 天" }, { value: "90d", label: "近 90 天" }, { value: "1y", label: "近一年" },
];

/** What the range chip says when the range is not one of the named ones. */
function rangeLabel(range: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u.exec(range);
  if (!match) return "全部时间";
  return match[1] === match[2] ? match[1] : `${match[1]} 至 ${match[2]}`;
}

/**
 * The map's one row of filters (DESIGN.md 「页面结构」 rule 5): the project, the time, the kind of memory, what needs a look, and the
 * search — and, as chips that let go with a press, whatever else narrows the page (a topic, an aspect, the mark in focus). A press
 * on a chip changes the shared selection; nothing here is a view of its own.
 */
export function MapFilters({ selection, doc, topicName, aspectName, focusLabel, projects, onNarrow, onClear, search }: {
  selection: MapSelection;
  doc: Pick<MemoryMap, "facets" | "summary">;
  topicName: string | null;
  aspectName: string | null;
  focusLabel: string | null;
  projects: ReadonlyArray<{ id: string; label: string }>;
  onNarrow: (patch: Partial<MapSelection>) => void;
  onClear: () => void;
  search: { draft: string; setDraft: (value: string) => void; clear: () => void; composition: object };
}) {
  const kinds: FilterOption<string>[] = doc.facets.kinds.map((kind) => ({ value: kind.id, label: kindTitle(kind.id), count: kind.count }));
  const narrowed = Boolean(selection.topic || selection.kind || selection.dimension || selection.look || selection.focus || selection.project || selection.range !== "all" || search.draft);
  const customRange = selection.range !== "all" && !RANGES.some((range) => range.value === selection.range);
  return (
    <div role="group" aria-label="筛选" className="flex flex-wrap items-center gap-x-1 gap-y-2">
      <FilterSelect
        label={selection.project ? projects.find((project) => project.id === selection.project)?.label ?? "项目" : "项目"}
        allLabel="全部项目" options={projects.map((project) => ({ value: project.id, label: project.label }))}
        value={selection.project} onChange={(project) => onNarrow({ project })}
      />
      <FilterSelect
        label={customRange ? rangeLabel(selection.range) : RANGES.find((range) => range.value === selection.range)?.label ?? "全部时间"}
        allLabel="全部时间" options={RANGES}
        value={RANGES.some((range) => range.value === selection.range) ? selection.range : null}
        onChange={(range) => onNarrow({ range: range ?? "all" })}
      />
      {kinds.length > 0 && <FilterSelect label="种类" allLabel="全部种类" options={kinds} value={selection.kind} onChange={(kind) => onNarrow({ kind })} />}
      {/* Only when something needs a look (or the page is already narrowed to it, so it can be let go): a chip for nothing is a filter that empties the page. */}
      {(doc.summary.needsLook > 0 || selection.look) && <FilterChip pressed={selection.look} onClick={() => onNarrow({ look: !selection.look })}>只看需要看一眼的</FilterChip>}
      {topicName && <FilterChip pressed icon={X} onClick={() => onNarrow({ topic: null })} aria-label={`取消主题：${topicName}`}>{`主题：${topicName}`}</FilterChip>}
      {aspectName && <FilterChip pressed icon={X} onClick={() => onNarrow({ dimension: null })} aria-label={`取消维度：${aspectName}`}>{`维度：${aspectName}`}</FilterChip>}
      {selection.focus && focusLabel && (
        <>
          <FilterChip pressed icon={X} onClick={() => onNarrow({ focus: null })} aria-label={`取消聚焦：${focusLabel}`}>{`聚焦：${focusLabel}`}</FilterChip>
          {!selection.focus.startsWith("cluster:") && (
            <FilterSelect
              label={`深度 ${selection.depth}`} options={[{ value: "1", label: "深度 1" }, { value: "2", label: "深度 2" }]}
              value={String(selection.depth)} onChange={(depth) => onNarrow({ depth: depth === "2" ? 2 : 1 })}
            />
          )}
          {selection.focus.startsWith("memory:") && <FilterChip pressed={selection.chain} onClick={() => onNarrow({ chain: !selection.chain })}>来源链</FilterChip>}
        </>
      )}
      {narrowed && <FilterChip onClick={onClear}>清除筛选</FilterChip>}
      <div className="ml-auto min-w-0">
        <SearchInput size="sm" label="搜索记忆地图" value={search.draft} maxLength={80} onChange={(event) => search.setDraft(event.target.value)} onClear={search.clear} {...search.composition} className="w-full sm:w-56" />
      </div>
    </div>
  );
}
