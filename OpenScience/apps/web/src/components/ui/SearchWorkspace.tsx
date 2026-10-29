import { useId, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Toolbar, type ToolbarFilter } from "@/components/ui/Toolbar";
import { useMediaQuery } from "@/lib/useMediaQuery";

/** A research catalogue: refinement beside a readable list, with counts outside the query controls. */
export function SearchWorkspace({ filters, filtersCollapsed, onFiltersCollapsedChange, count, pending, searched, sort, tools, children }: {
  filters: ReactNode;
  filtersCollapsed: boolean;
  onFiltersCollapsedChange(value: boolean): void;
  count: number | undefined;
  pending: boolean;
  searched: boolean;
  sort?: ToolbarFilter;
  tools?: ReactNode;
  children: ReactNode;
}) {
  const compact = useMediaQuery("(max-width: 1023px)");
  const filtersId = useId();
  const FilterIcon = filtersCollapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="flex min-w-0 flex-col rounded-panel border border-border bg-surface lg:flex-row" data-search-workspace="">
      <aside id={filtersId} hidden={!compact && filtersCollapsed} aria-label="筛选条件" className="min-w-0 rounded-t-panel bg-surface-2 p-4 lg:w-64 lg:shrink-0 lg:rounded-l-panel lg:rounded-tr-none lg:border-r lg:border-border">
        {compact ? <Disclosure summary="筛选条件" summaryClassName="font-semibold text-text">{filters}</Disclosure> : filters}
      </aside>
      <section aria-label="检索结果区" className="min-w-0 flex-1 p-3 md:px-4">
        <div className="mb-1 flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border pb-3" data-search-result-heading="">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            {!compact && <Button variant="text" size="sm" aria-label={filtersCollapsed ? "展开筛选栏" : "收起筛选栏"}
              aria-expanded={!filtersCollapsed} aria-controls={filtersId} onClick={() => onFiltersCollapsedChange(!filtersCollapsed)}>
              <FilterIcon size={16} aria-hidden="true" />{filtersCollapsed ? "展开筛选" : "收起筛选"}
            </Button>}
            <h2 className="text-ui font-semibold text-text">检索结果</h2>
            <div aria-live="polite" aria-atomic="true" className="flex h-6 w-32 items-center text-caption tabular-nums text-text-2" data-search-count="">
              {pending ? "正在检索" : count !== undefined ? `共 ${count.toLocaleString("zh-CN")} 条` : searched ? "暂未获取结果" : "等待检索"}
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {tools}
            <div className="w-32 shrink-0 sm:w-40">{sort && <Toolbar label="结果排序" filters={[sort]} className="justify-end" />}</div>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}
