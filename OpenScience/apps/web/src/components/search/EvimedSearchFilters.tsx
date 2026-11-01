import { useId, useLayoutEffect, useRef, useState } from "react";
import { CheckSquare, Search, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterSelect } from "@/components/ui/FilterChips";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { YearRangeFilter } from "@/components/ui/YearRangeFilter";
import { cn } from "@/lib/cn";
import { evimedSearchFilterPatch } from "@/lib/evimedSearchFilters";
import type { EvimedSearchCategory, EvimedSearchFacets, EvimedSearchFilters as SearchFilters } from "@/lib/evimedSearchClient";

type FilterGroup = EvimedSearchFacets["groups"][number];
type Patch = Record<string, string | null>;

function WithinResults({ value, disabled, onChange }: { value: string; disabled: boolean; onChange(value: string): void }) {
  const [draft, setDraft] = useState(value);
  return <form onSubmit={(event) => { event.preventDefault(); onChange(draft.trim()); }} className="space-y-2">
    <Input label="结果中搜索" placeholder="输入词语进一步缩小范围" value={draft} maxLength={200}
      disabled={disabled} onChange={(event) => setDraft(event.target.value)}
      trailing={<IconButton icon={Search} label="在结果中搜索" size="sm" type="submit" disabled={disabled || draft.trim() === value} />}
      onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
    {value && <div className="flex justify-end"><Button variant="text" size="sm" onClick={() => onChange("")}>清除词语</Button></div>}
  </form>;
}

function NumericRange({ label, minLabel, maxLabel, min, max, maxValue, integer, onChange }: {
  label: string; minLabel: string; maxLabel: string; min?: number; max?: number; maxValue: number;
  integer?: boolean; onChange(min: number | undefined, max: number | undefined): void;
}) {
  const [draftMin, setDraftMin] = useState(min === undefined ? "" : String(min));
  const [draftMax, setDraftMax] = useState(max === undefined ? "" : String(max));
  const [error, setError] = useState("");
  const apply = () => {
    const values = [draftMin, draftMax].map((value) => value.trim() === "" ? undefined : Number(value));
    if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > maxValue || integer && !Number.isInteger(value)))) {
      setError(integer ? "请输入有效的非负整数。" : "请输入有效的非负数。"); return;
    }
    if (values[0] !== undefined && values[1] !== undefined && values[0] > values[1]) { setError("最大值不能小于最小值。"); return; }
    setError(""); onChange(values[0], values[1]);
  };
  return <Section title={label} level="sub" className="mt-0">
    <form onSubmit={(event) => { event.preventDefault(); apply(); }}>
      <div className="grid grid-cols-2 gap-2">
        <Input aria-label={minLabel} placeholder="最小值" type="number" min={0} max={maxValue} step={integer ? 1 : 0.01}
          value={draftMin} onChange={(event) => { setDraftMin(event.target.value); setError(""); }} />
        <Input aria-label={maxLabel} placeholder="最大值" type="number" min={0} max={maxValue} step={integer ? 1 : 0.01}
          value={draftMax} onChange={(event) => { setDraftMax(event.target.value); setError(""); }} />
      </div>
      {error && <div role="alert" className="mt-2 text-ui text-error">{error}</div>}
      <div className="mt-2 flex justify-end gap-1">
        {(min !== undefined || max !== undefined) && <Button variant="text" size="sm" onClick={() => onChange(undefined, undefined)}>重置{label}</Button>}
        <Button variant="secondary" size="sm" type="submit">应用{label}</Button>
      </div>
    </form>
  </Section>;
}

function FacetGroup({ group, value, onChange, defaultOpen, expanded, onExpand, scrollPositions }: {
  group: FilterGroup; value: readonly string[]; onChange(value: string[]): void; defaultOpen: boolean;
  expanded: boolean; onExpand(value: boolean): void; scrollPositions: Map<string, number>;
}) {
  const groupId = useId();
  const optionsId = useId();
  const optionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (optionsRef.current) optionsRef.current.scrollTop = expanded ? scrollPositions.get(group.key) ?? 0 : 0;
  }, [expanded, group.key, scrollPositions]);
  // Keep chosen values reachable while the upstream facet list narrows or a companion request is unavailable.
  const options: FilterGroup["options"] = [...group.options, ...value.filter((item) => !group.options.some((option) => option.value === item))
    .map((item) => ({ value: item, label: item }))];
  const ordered = [...options.filter((item) => value.includes(item.value)), ...options.filter((item) => !value.includes(item.value))];
  const visible = expanded ? options : ordered.slice(0, Math.max(6, value.length));
  const remaining = Math.max(0, options.length - visible.length);
  if (!options.length) return null;
  return <Disclosure defaultOpen={defaultOpen || value.length > 0} className="border-t border-border pt-3" summaryClassName="text-text font-semibold"
    summary={<span id={groupId}>{group.label}{value.length > 0 && <span className="ml-2 tabular-nums text-text-2">{value.length}</span>}</span>}>
    {/* The expanded scroll window needs a keyboard stop, as in ScrollRegion. */}
    <div ref={optionsRef} id={optionsId} role="group" aria-labelledby={groupId} {...(expanded ? { tabIndex: 0 } : {})}
      data-filter-options={group.key} onScroll={event => scrollPositions.set(group.key, event.currentTarget.scrollTop)}
      className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain pr-1"
      style={{ scrollbarGutter: "stable" }}>
      {visible.map((option) => {
        const selected = value.includes(option.value);
        const Icon = selected ? CheckSquare : Square;
        return <Button key={option.value} role="checkbox" aria-checked={selected} aria-label={option.label}
          variant="text" size="sm" className={cn("h-auto min-h-sm w-full justify-start gap-2 whitespace-normal px-1.5 py-1.5 text-left", selected && "bg-accent-soft text-accent")}
          onClick={() => onChange(selected ? value.filter((item) => item !== option.value) : [...value, option.value])}>
          <Icon size={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{option.label}</span>
          {option.count !== undefined && <span className="shrink-0 text-caption tabular-nums text-text-3">{option.count.toLocaleString("zh-CN")}</span>}
        </Button>;
      })}
    </div>
    {(expanded || remaining > 0) && <div className="mt-2 flex justify-start">
      <Button variant="text" size="sm" aria-expanded={expanded} aria-controls={optionsId}
        onClick={() => { scrollPositions.delete(group.key); onExpand(!expanded); }}>
        {expanded ? "收起选项" : `显示更多 · 还有 ${remaining.toLocaleString("zh-CN")} 项`}
      </Button>
    </div>}
  </Disclosure>;
}

export interface EvimedSearchFiltersProps {
  category: EvimedSearchCategory;
  query: string;
  filters: SearchFilters;
  facets?: EvimedSearchFacets;
  loading: boolean;
  onChange(patch: Patch): void;
  onReset(): void;
  onRetry(): void;
}

/** One narrow catalogue filter panel; its parent owns request state, URL and per-category memory. */
export function EvimedSearchFilters({ category, query, filters, facets, loading, onChange, onReset, onRetry }: EvimedSearchFiltersProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const scrollPositions = useRef(new Map<string, number>());
  const scholarly = category === "literature" || category === "guidelines";
  const groups = facets?.groups ?? [];
  const language = groups.find((group) => group.key === "language");
  const source = groups.find((group) => group.key === "source");
  const panelKey = `${category}:${query}`;
  const change = (key: keyof SearchFilters, value: string | number | readonly string[] | null | undefined) => onChange(evimedSearchFilterPatch(key, value));
  const changeSource = (value: string | null) => onChange({ ...evimedSearchFilterPatch("source", value),
    ...(category === "trials" ? { minSampleSize: null, maxSampleSize: null, studyType: null, testPhase: null, recruitmentStatus: null,
      associatedArticles: null, clinicalSourceDb: null } : {}) });
  const changeGroup = (group: FilterGroup, values: string[]) => {
    const patch = evimedSearchFilterPatch(group.key, group.key === "clinicalSourceDb" ? values.at(-1) : values);
    if (group.key === "secondLevelDepartment") {
      const parents = [...new Set(values.map((value) => group.options.find((option) => option.value === value)?.parent).filter((value): value is string => Boolean(value)))];
      Object.assign(patch, evimedSearchFilterPatch("firstLevelDepartment", parents));
    }
    onChange(patch);
  };
  const facetGroups = groups.filter((group) => !["language", "source", "sort", "firstLevelDepartment"].includes(group.key));
  return <aside aria-label="检索筛选" className="min-w-0 space-y-4">
    <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
      <h2 className="text-ui font-semibold text-text">筛选</h2>
      <Button variant="text" size="sm" onClick={onReset}>清空筛选</Button>
    </div>
    <WithinResults key={`${panelKey}:${filters.words ?? ""}`} value={filters.words ?? ""} disabled={!query} onChange={(value) => change("words", value)} />
    {scholarly && language && <FilterSelect label="语言" allLabel="不限语言" value={filters.language || null} options={language.options}
      onChange={(value) => onChange({ ...evimedSearchFilterPatch("language", value), ...(value !== "en" ? { jcrPartition: null,
        ...(["impact-high", "impact-low"].includes(filters.sort ?? "") ? { sort: null } : {}) } : {}) })} />}
    {!scholarly && source && <FilterSelect label={category === "drugs" ? "药品来源" : "试验来源"}
      allLabel={category === "drugs" ? "全部来源" : undefined} value={filters.source || (category === "trials" ? "0" : null)}
      options={source.options} onChange={changeSource} />}
    {category !== "drugs" && <YearRangeFilter key={`${panelKey}:years:${filters.startYear ?? ""}:${filters.endYear ?? ""}`}
      label={category === "trials" && filters.source !== "2" ? "注册年份" : "发表年份"} distribution={facets?.timeline}
      startYear={filters.startYear} endYear={filters.endYear}
      onChange={(start, end) => onChange({ startYear: start === undefined ? null : String(start), endYear: end === undefined ? null : String(end), years: null, page: null })} />}
    {category === "literature" && <NumericRange key={`${panelKey}:impact:${filters.smallJcr ?? ""}:${filters.bidJcr ?? ""}`} label="影响因子"
      minLabel="最小影响因子" maxLabel="最大影响因子" min={filters.smallJcr} max={filters.bidJcr} maxValue={1000}
      onChange={(min, max) => onChange({ ...evimedSearchFilterPatch("smallJcr", min), ...evimedSearchFilterPatch("bidJcr", max) })} />}
    {category === "trials" && filters.source !== "2" && <NumericRange key={`${panelKey}:sample:${filters.minSampleSize ?? ""}:${filters.maxSampleSize ?? ""}`} label="样本量"
      minLabel="最小样本量" maxLabel="最大样本量" min={filters.minSampleSize} max={filters.maxSampleSize} maxValue={99999999} integer
      onChange={(min, max) => onChange({ ...evimedSearchFilterPatch("minSampleSize", min), ...evimedSearchFilterPatch("maxSampleSize", max) })} />}
    {loading && !facets && <div role="status" aria-label="正在加载筛选" className="space-y-3 motion-safe:animate-pulse">
      <span className="sr-only">正在加载筛选</span>{[0, 1, 2].map((index) => <div key={index} aria-hidden="true" className="h-4 w-2/3 rounded bg-surface-2" />)}
    </div>}
    {facetGroups.map((group, index) => {
      const raw = filters[group.key];
      const selected = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
      return <FacetGroup key={`${panelKey}:${group.key}`} group={group} value={selected} defaultOpen={index < 2} onChange={(values) => changeGroup(group, values)}
        expanded={Boolean(expandedGroups[group.key])} onExpand={expanded => setExpandedGroups(current => ({ ...current, [group.key]: expanded }))}
        scrollPositions={scrollPositions.current} />;
    })}
    {Boolean(facets?.unavailable.length) && <Note action={<Button variant="text" size="sm" onClick={onRetry}>重新加载筛选</Button>}>部分筛选暂时未能加载。</Note>}
  </aside>;
}
