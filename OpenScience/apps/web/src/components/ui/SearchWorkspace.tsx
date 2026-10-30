import { useEffect, useId, useState, type ReactNode } from "react";
import { MOTION } from "@evimed/design-tokens";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Toolbar, type ToolbarSelect } from "@/components/ui/Toolbar";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/cn";

/**
 * Component: SearchWorkspace; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Retained refinement rail beside a stable summary/selection slot, tools and list.
 * Variants: Optional desktop horizontal rail; compact native disclosure; results alone.
 * States: Controlled rail expansion; independent pending/known/unknown result count.
 * Hit area: Shared small buttons; the collapse action stays outside the moving rail.
 * Keyboard: Native controls; collapsed filters are immediately inert and hidden from AT.
 * Long content: Heading and action groups wrap independently; selection replaces the summary without resizing it; filter drafts remain mounted.
 * Theme: Shared surface, border, type and motion tokens only.
 * Responsive: Desktop rail width and content fade together; reduced motion settles immediately.
 * Verification: EvimedSearchPage.test.tsx covers draft retention and navigation; browser checks own alignment and motion.
 */
export function SearchWorkspace({ filters, filtersCollapsed = false, onFiltersCollapsedChange, count, pending, searched, sort, tools, selection, children }: {
  filters?: ReactNode;
  filtersCollapsed?: boolean;
  onFiltersCollapsedChange?(value: boolean): void;
  count: number | undefined;
  pending: boolean;
  searched: boolean;
  sort?: ToolbarSelect;
  tools?: ReactNode;
  /** Compact selection controls replace the summary inside its reserved footprint. */
  selection?: { active: boolean; controls: ReactNode };
  children: ReactNode;
}) {
  const compact = useMediaQuery("(max-width: 1023px)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const collapsed = !compact && filtersCollapsed;
  const [collapseFinished, setCollapseFinished] = useState(collapsed);
  useEffect(() => {
    if (!collapsed || reducedMotion) { setCollapseFinished(collapsed); return; }
    // Keep the body during the width transition, then release its height without losing drafts.
    const timer = window.setTimeout(() => setCollapseFinished(true), Number.parseFloat(MOTION.slow));
    return () => window.clearTimeout(timer);
  }, [collapsed, reducedMotion]);
  const filtersId = useId();
  const FilterIcon = filtersCollapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="flex min-w-0 flex-col rounded-panel border border-border bg-surface lg:flex-row" data-search-workspace="">
      {filters && <aside id={filtersId} aria-hidden={collapsed || undefined} inert={collapsed} aria-label="筛选条件"
        className={cn("min-w-0 shrink-0 overflow-hidden rounded-t-panel bg-surface-2 transition-all duration-slow ease-standard motion-reduce:transition-none lg:rounded-l-panel lg:rounded-tr-none",
          compact ? "w-full" : collapsed ? "w-0" : "w-64")}>
        <div hidden={collapsed && (collapseFinished || reducedMotion)}
          className={cn("p-4 transition-all duration-slow ease-standard motion-reduce:transition-none lg:min-h-full lg:w-64 lg:border-r lg:border-border",
            collapsed ? "-translate-x-3 opacity-0" : "translate-x-0 opacity-100")}>
          {compact ? <Disclosure summary="筛选条件" summaryClassName="font-semibold text-text">{filters}</Disclosure> : filters}
        </div>
      </aside>}
      <section aria-label="检索结果区" className="min-w-0 flex-1 p-3 md:px-4">
        <div className="mb-1 flex min-h-control flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-2 pb-2" data-search-result-heading="">
          <div className={cn("relative min-w-0", selection && "flex min-h-sm w-52 max-w-full shrink-0 items-center")}>
            <div aria-hidden={selection?.active || undefined} className={cn("flex min-w-0 flex-wrap items-center gap-x-3", selection?.active && "invisible")}>
              <h2 className="shrink-0 text-ui font-semibold text-text">检索结果</h2>
              <div aria-live="polite" aria-atomic="true" className="flex h-6 w-32 items-center text-caption tabular-nums text-text-2" data-search-count="">
                {pending ? "正在检索" : count !== undefined ? `共 ${count.toLocaleString("zh-CN")} 条` : searched ? "暂未获取结果" : "等待检索"}
              </div>
            </div>
            {selection && <div aria-hidden={!selection.active || undefined} inert={!selection.active}
              className={cn("absolute inset-0 flex items-center", !selection.active && "invisible")}>
              {selection.controls}
            </div>}
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
            {tools}
            {sort && <Toolbar label="结果排序" navigation={[sort]} className="shrink-0" />}
            {filters && onFiltersCollapsedChange && !compact && <Button variant="text" size="sm" aria-label={filtersCollapsed ? "展开筛选栏" : "收起筛选栏"}
              aria-expanded={!filtersCollapsed} aria-controls={filtersId} onClick={() => onFiltersCollapsedChange(!filtersCollapsed)}>
              <FilterIcon size={16} aria-hidden="true" />{filtersCollapsed ? "展开筛选" : "收起筛选"}
            </Button>}
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}
