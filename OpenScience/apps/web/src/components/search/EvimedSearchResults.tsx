import { useRef, type ReactNode } from "react";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SearchWorkspace } from "@/components/ui/SearchWorkspace";
import { SelectionCheckbox } from "@/components/ui/SelectionCheckbox";
import { StateScreen } from "@/components/ui/StateScreen";
import type { ToolbarSelect } from "@/components/ui/Toolbar";
import { EvimedSearchActions, EvimedSearchBatchActions } from "@/components/search/EvimedSearchActions";
import { EvimedSearchResultList, type SearchResultLink, type SearchResultSelection } from "@/components/search/EvimedSearchResultList";
import type { EvimedSearchCategory, EvimedSearchItem, EvimedSearchResult } from "@/lib/evimedSearchClient";

/**
 * Component: EvimedSearchSkeleton; owner: H; rules: DS21.
 * Anatomy: One status and four non-interactive result placeholders.
 * Variants: Shared by results and initial reader loading.
 * States: Pending only; the host removes it on settlement.
 * Hit area: None; placeholders do not simulate controls.
 * Keyboard: No focus stop; the pending status is named.
 * Long content: Proportional widths stay within the container.
 * Theme: Semantic surface tokens only.
 * Responsive: Fluid widths; reduced motion removes the pulse.
 * Verification: Search route loading/retry regressions.
 */
export function EvimedSearchSkeleton() {
  return <div role="status" aria-label="正在检索" className="py-3">
    <span className="sr-only">正在检索</span>
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      {[0, 1, 2, 3].map(key => <div key={key} className="space-y-2">
        <div className="h-3 w-1/3 rounded bg-surface-2" />
        <div className="h-4 w-2/3 rounded bg-surface-2" />
        <div className="h-3 w-full rounded bg-surface-2" />
        <div className="h-3 w-4/5 rounded bg-surface-2" />
      </div>)}
    </div>
  </div>;
}

/**
 * Component: EvimedSearchResults; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Optional refinement rail, stable summary/selection slot and tools, reusable result list and pagination.
 * Variants: All four medical categories; filters, selection and pagination are independently optional.
 * States: Pending, supplied recovery, empty and populated; route and request state stay with the host.
 * Hit area: Shared buttons and checkboxes; collection/citation/export/download reuse existing actions.
 * Keyboard: Native controls, retained filter drafts and inert collapsed rail through SearchWorkspace.
 * Long content: Count and batch controls share reserved space; list previews are compact without reducing type sizes.
 * Theme: Existing shared workspace and row primitives; no plugin/runtime dependency.
 * Responsive: Refinements fold into a disclosure; result tools wrap independently from the count.
 * Verification: Standalone composition tests, search route regressions and Chrome desktop/mobile checks.
 */
export function EvimedSearchResults({ category, result, pending, page, error, emptyAction, refinements, sort,
  selection, getDetailLink, onPageChange, onRefresh, onCollectedChange }: {
  category: EvimedSearchCategory;
  result: EvimedSearchResult | null;
  pending: boolean;
  page: number;
  error?: ReactNode;
  emptyAction?: ReactNode;
  refinements?: { content: ReactNode; collapsed: boolean; onCollapsedChange(value: boolean): void };
  sort?: ToolbarSelect;
  selection?: SearchResultSelection;
  getDetailLink?(item: EvimedSearchItem): SearchResultLink | undefined;
  onPageChange?(page: number): void;
  onRefresh?(): void;
  onCollectedChange?(actionRef: string, collected: boolean): void;
}) {
  const activeSelection = category === "literature" ? selection : undefined;
  const selectedIds = new Set(activeSelection?.items.map(item => item.id));
  const selectableItems = activeSelection ? result?.items.filter(item => item.actionRef) ?? [] : [];
  const selectedOnPage = selectableItems.filter(item => selectedIds.has(item.id)).length;
  const pageCount = result ? Math.max(1, Math.ceil(result.total / Math.max(1, result.pageSize))) : 1;
  const selectionControl = useRef<HTMLDivElement>(null);
  const clearSelection = () => {
    activeSelection?.onClear();
    // The clear action disappears; return to the persistent control after disabled state settles.
    requestAnimationFrame(() => selectionControl.current?.querySelector("input")?.focus({ preventScroll: true }));
  };
  return <SearchWorkspace count={result?.total} pending={pending} searched sort={sort}
    filters={refinements?.content} filtersCollapsed={refinements?.collapsed}
    onFiltersCollapsedChange={refinements?.onCollapsedChange}
    selection={activeSelection ? { active: activeSelection.items.length > 0, controls:
      <EvimedSearchBatchActions category={category} items={activeSelection.items} onClear={clearSelection} onRefresh={onRefresh} /> } : undefined}
    tools={activeSelection && <div ref={selectionControl} className="shrink-0">
      <SelectionCheckbox label="选择本页" showLabel checked={selectableItems.length > 0 && selectedOnPage === selectableItems.length}
        mixed={selectedOnPage > 0 && selectedOnPage < selectableItems.length}
        disabled={selectableItems.length === 0 || (selectedOnPage === 0 && activeSelection.items.length >= activeSelection.limit)}
        onChange={value => activeSelection.onChange(selectableItems, value)} />
    </div>}>
    {pending ? <EvimedSearchSkeleton /> : error || (result && (result.items.length === 0
      ? <StateScreen icon={SearchX} title={page > 1 ? "这一页暂无结果，请返回第一页。" : "没有找到符合条件的结果，请换个关键词或放宽筛选。"}
        action={page > 1 && onPageChange ? <Button variant="secondary" onClick={() => onPageChange(1)}>返回第一页</Button> : emptyAction} />
      : <>
        <EvimedSearchResultList items={result.items} selection={activeSelection} getDetailLink={getDetailLink}
          renderActions={item => <EvimedSearchActions category={category} item={item} onRefresh={onRefresh}
            onCollectedChange={value => { if (item.actionRef) onCollectedChange?.(item.actionRef, value); }} />} />
        {onPageChange && <nav aria-label="结果分页" className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</Button>
          <span role="status" className="text-ui tabular-nums text-text-2">第 {page} / {pageCount} 页</span>
          <Button variant="secondary" disabled={page >= pageCount || page >= 1000} onClick={() => onPageChange(page + 1)}>下一页</Button>
        </nav>}
      </>))}
  </SearchWorkspace>;
}
