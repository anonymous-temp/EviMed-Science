import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, SearchX } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button, buttonClasses } from "@/components/ui/Button";
import { StateScreen } from "@/components/ui/StateScreen";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { EvimedSearchFilters } from "@/components/search/EvimedSearchFilters";
import { EvimedSearchReader } from "@/components/search/EvimedSearchReader";
import { EvimedReaderBack } from "@/components/search/EvimedReaderBack";
import { EvimedSearchHome } from "@/components/search/EvimedSearchHome";
import { EvimedSearchTransition } from "@/components/search/EvimedSearchTransition";
import { EvimedSearchResults, EvimedSearchSkeleton } from "@/components/search/EvimedSearchResults";
import { useEvimedSearchState } from "@/lib/useEvimedSearchState";
import {
  EVIMED_SEARCH_CATEGORIES,
  type EvimedSearchCategory, type EvimedSearchFailure,
} from "@/lib/evimedSearchClient";

function SearchError({ error, currentPath, onRetry, onSearch }: {
  error: EvimedSearchFailure; currentPath: string; onRetry(): void; onSearch(): void;
}) {
  const action = error.action === "login"
    ? <Link to={`/login?reauth=evimed&next=${encodeURIComponent(currentPath)}`} className={buttonClasses()}>重新登录</Link>
    : <Button onClick={error.action === "search" ? onSearch : onRetry}>{error.action === "search" ? "重新检索" : "重试"}</Button>;
  return <StateScreen icon={SearchX} title={error.message} role="alert" action={action} />;
}

function DetailReader({ category, state, backTo, currentPath, onSearch, onRetry, onCollectedChange }: {
  category: EvimedSearchCategory;
  state: ReturnType<typeof useEvimedSearchState>["readerState"]; backTo: string; currentPath: string;
  onSearch(): void; onRetry(): void;
  onCollectedChange(actionRef: string, collected: boolean): void;
}) {
  if (state.status === "success") return <EvimedSearchReader key={`${category}:${state.data.id ?? state.data.actionRef ?? state.data.title}`}
    category={category} detail={state.data} backTo={backTo} onSearch={onSearch} onCollectedChange={onCollectedChange} />;
  return <PageShell width="page" title="检索详情" actionPlan={{}} backPlacement="edge"
    back={<EvimedReaderBack fallback={backTo} />}>
    {state.status === "loading" ? <EvimedSearchSkeleton />
      : <SearchError error={state.error} currentPath={currentPath} onRetry={onRetry} onSearch={onSearch} />}
  </PageShell>;
}

/**
 * Component: EvimedSearchPage; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: PageShell navigation and search controls compose the home, results or reader.
 * Variants: Four medical categories share controlled result components.
 * States: The search hook owns requests, per-category caches, selection and restored scroll.
 * Hit area: Shared tabs, buttons and search input; result actions stay inside their component.
 * Keyboard: IME-safe submit and native navigation; reader returns preserve entry context.
 * Long content: Shared page measure and complete titles with compact result previews.
 * Theme: Existing design tokens and typography roles only.
 * Responsive: PageShell and SearchWorkspace own toolbar wrapping and refinement disclosure.
 * Verification: EvimedSearchPage.test.tsx, standalone result tests and Chrome viewport checks.
 */
export function EvimedSearchPage() {
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [searchMode, setSearchMode] = useState<"browse" | "submit" | "edit">("browse");
  const {
    rootRef, category, params, query, page, detailRef, language, sort, scholarly,
    draft, setDraft, composing, result, state, readerState, busy, update, submit, clearSearch, editSearch, switchCategory,
    retrySearch, retryCurrent, retryDetail, backTo, currentPath, filters, facets, facetsBusy, retryFacets, resetFilters,
    selectedItems, selectItems, clearSelection, updateCollected,
  } = useEvimedSearchState();
  useEffect(() => {
    if (!busy) setSearchMode(value => value === "submit" ? "browse" : value);
  }, [busy]);
  function submitSearch() {
    if (composing.current || !draft.trim() || (busy && draft.trim() === query)) return;
    setSearchMode("submit");
    submit();
  }
  function returnToEdit() {
    setSearchMode("edit");
    editSearch();
  }
  function retrySearchWithTransition() { setSearchMode("submit"); retrySearch(); }
  function retryCurrentWithTransition() { setSearchMode("submit"); retryCurrent(); }
  if (detailRef) return <div ref={rootRef} className="h-full min-h-0"><DetailReader category={category} state={readerState} backTo={backTo}
    currentPath={currentPath} onSearch={retrySearch} onRetry={retryDetail} onCollectedChange={updateCollected} /></div>;
  if (!query) return <div ref={rootRef} className="h-full min-h-0"><PageShell title="医学检索" headerVisibility="sr-only" width="page" contentClassName="xl:pt-8 2xl:pt-16">
    <EvimedSearchHome category={category} draft={draft} onDraftChange={setDraft} onCategoryChange={switchCategory}
      onSubmit={submitSearch} onClear={clearSearch} onCompositionChange={value => { composing.current = value; }} focusQuery={searchMode === "edit"} />
  </PageShell></div>;
  const sortOptions = [
    { value: "newest", label: "最新发表" },
    { value: "oldest", label: "最早发表" },
    ...(category === "literature" ? [{ value: "relevance", label: "相关性" }] : []),
    ...(category === "literature" && language === "en" ? [{ value: "impact-high", label: "影响因子从高到低" }, { value: "impact-low", label: "影响因子从低到高" }] : []),
  ];
  const sortControl: ToolbarFilter | undefined = scholarly ? {
    kind: "select", label: "排序", allLabel: "综合", emptyText: "综合排序", value: sort === "comprehensive" ? null : sort,
    options: sortOptions, onChange: value => update({ sort: value, page: null }),
  } : undefined;
  return (
    <div ref={rootRef} className="h-full min-h-0"><PageShell title="医学检索" width="page" contentClassName="mt-4"
      actions={<Link to={`/app/search/${category}`} className={buttonClasses({ variant: "text", size: "sm" })}><ArrowLeft size={16} aria-hidden="true" />检索首页</Link>}
      toolbar={{
      label: "检索条件",
      views: { label: "检索类别", items: EVIMED_SEARCH_CATEGORIES, value: category, onChange: switchCategory, panelId: "evimed-search-results" },
      search: { label: "检索关键词", placeholder: category === "drugs" ? "药品名称" : "输入关键词", value: draft, maxLength: 200,
        onChange: setDraft, onClear: clearSearch, onSubmit: submitSearch,
        inputProps: { onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; } } },
      actions: <Button size="sm" disabled={!draft.trim()} loading={busy && draft.trim() === query} onClick={submitSearch}>检索</Button>,
    }}>
      {busy && searchMode === "submit" ? <EvimedSearchTransition category={category} query={query} onEdit={returnToEdit} />
        : <EvimedSearchResults category={category} result={result} pending={busy} page={page} sort={sortControl}
          selection={{ items: selectedItems, limit: 20, onChange: selectItems, onClear: clearSelection }}
          refinements={{ collapsed: filtersCollapsed, onCollapsedChange: setFiltersCollapsed,
            content: <EvimedSearchFilters key={`${category}:${query}`} category={category} query={query} filters={filters} facets={facets}
              loading={facetsBusy} onChange={values => update({ ...values, page: null })} onReset={resetFilters} onRetry={retryFacets} /> }}
          error={state.status === "error" && <SearchError error={state.error} currentPath={currentPath}
            onRetry={retryCurrentWithTransition} onSearch={retrySearchWithTransition} />}
          emptyAction={Object.entries(filters).some(([key, value]) => value !== "" && !(key === "sort" && value === "comprehensive") && !(key === "source" && value === "0"))
            ? <Button variant="secondary" onClick={resetFilters}>清除筛选</Button> : undefined}
          getDetailLink={item => {
            if (!item.detailRef) return undefined;
            const detailParams = new URLSearchParams(params);
            detailParams.set("detail", item.detailRef);
            return { to: `/app/search/${category}?${detailParams}`, state: { returnTo: currentPath } };
          }}
          onPageChange={value => update({ page: value === 1 ? null : String(value) })}
          onRefresh={retrySearch} onCollectedChange={updateCollected} />}
    </PageShell></div>
  );
}
