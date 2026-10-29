import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowUpRight, Search, SearchX } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { StateScreen } from "@/components/ui/StateScreen";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { SearchWorkspace } from "@/components/ui/SearchWorkspace";
import { EvimedSearchFilters } from "@/components/search/EvimedSearchFilters";
import { EvimedSearchHome } from "@/components/search/EvimedSearchHome";
import { EvimedSearchActions, EvimedSearchBatchActions } from "@/components/search/EvimedSearchActions";
import { SelectionCheckbox } from "@/components/ui/SelectionCheckbox";
import { useEvimedSearchState } from "@/lib/useEvimedSearchState";
import {
  EVIMED_SEARCH_CATEGORIES, evimedSourceUrl,
  type EvimedSearchCategory, type EvimedSearchDetail, type EvimedSearchFailure, type EvimedSearchItem,
} from "@/lib/evimedSearchClient";

const PAGE_SIZE = 10;

function normalizedFact(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return /^(unknown|null|undefined|n\/?a|--|暂无(?:数据|信息|内容)?)$/i.test(text) ? "" : text;
}

function detailFacts(detail: EvimedSearchDetail) {
  const seen = new Set<string>();
  return [
    { label: "来源", value: detail.source },
    { label: "名称", value: detail.subtitle },
    { label: "DOI", value: detail.doi ?? "" },
    ...detail.metadata,
  ].filter((fact) => {
    const key = normalizedFact(fact.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function SearchSkeleton() {
  return (
    <div role="status" aria-label="正在检索" className="space-y-6 py-3">
      <span className="sr-only">正在检索</span>
      <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className="space-y-3">
            <div className="h-4 w-2/3 rounded bg-surface-2" />
            <div className="h-3 w-1/3 rounded bg-surface-2" />
            <div className="h-3 w-full rounded bg-surface-2" />
            <div className="h-3 w-4/5 rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultMetadata({ item }: { item: EvimedSearchItem }) {
  const authors = item.authors.slice(0, 3).join("、") + (item.authors.length > 3 ? " 等" : "");
  const subtitle = normalizedFact(item.subtitle);
  return (
    <div data-prose="" className="max-w-measure space-y-1 break-words pt-1">
      {authors && <div className="line-clamp-1 text-caption text-text-2" title={item.authors.join("、")}>{authors}</div>}
      {subtitle && subtitle !== normalizedFact(item.source) && subtitle !== normalizedFact(item.title) && <div className="line-clamp-2 text-caption text-text-2">{item.subtitle}</div>}
      {item.summary && <p className="line-clamp-3 text-ui text-text">{item.summary}</p>}
      {item.tags.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-2">{[...new Set(item.tags)].slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>}
    </div>
  );
}

function ResultProvenance({ item }: { item: EvimedSearchItem }) {
  const source = normalizedFact(item.source);
  return (source || item.publishedAt) ? <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-text-2">
    {source && <span>{source}</span>}
    {item.publishedAt && <time className="shrink-0 tabular-nums text-text-3">{item.publishedAt}</time>}
  </div> : null;
}

function SourceLink({ url }: { url: string | null }) {
  const href = evimedSourceUrl(url);
  if (!href) return null;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "secondary" })}>打开原文<ArrowUpRight size={16} aria-hidden="true" /></a>;
}

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
  const detail = state.status === "success" ? state.data : null;
  const source = detail ? evimedSourceUrl(detail.url) ?? (detail.doi ? evimedSourceUrl(`https://doi.org/${encodeURIComponent(detail.doi)}`) : null) : null;
  return (
    <PageShell width="read" title={detail?.title || "检索详情"} titleVariant="document" contentClassName="break-words"
      back={<Link to={backTo} className={buttonClasses({ variant: "text", size: "sm" })}><ArrowLeft size={16} aria-hidden="true" />返回检索结果</Link>}
      actions={<SourceLink url={source} />}>
      {state.status === "loading" ? <SearchSkeleton /> : state.status === "error"
        ? <SearchError error={state.error} currentPath={currentPath} onRetry={onRetry} onSearch={onSearch} />
        : <div data-prose="" className="space-y-8 break-words">
          <EvimedSearchActions category={category} item={{ ...state.data, id: state.data.id ?? state.data.actionRef ?? "" }} compact={false}
            onRefresh={onSearch} onCollectedChange={value => onCollectedChange(state.data.actionRef!, value)} />
          <FactList rows={detailFacts(state.data)} />
          {state.data.sections.map((section, index) => <Section key={`${index}-${section.title}`} title={section.title}>
            <div className="whitespace-pre-wrap text-body text-text">{section.text}</div>
          </Section>)}
          {state.data.sections.length === 0 && <StateScreen icon={Search} title="暂无可阅读的摘要。" action={<SourceLink url={source} />} />}
        </div>}
    </PageShell>
  );
}

export function EvimedSearchPage() {
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const {
    rootRef, category, params, query, page, detailRef, language, sort, scholarly,
    draft, setDraft, composing, result, state, readerState, busy, update, submit, clearSearch, switchCategory,
    retrySearch, retryCurrent, retryDetail, backTo, currentPath, filters, facets, facetsBusy, retryFacets, resetFilters,
    selectedItems, selectItems, clearSelection, updateCollected,
  } = useEvimedSearchState();
  if (detailRef) return <div ref={rootRef} className="h-full min-h-0"><DetailReader category={category} state={readerState} backTo={backTo}
    currentPath={currentPath} onSearch={retrySearch} onRetry={retryDetail} onCollectedChange={updateCollected} /></div>;
  if (!query) return <div ref={rootRef} className="h-full min-h-0"><PageShell title="医学检索" headerVisibility="sr-only" width="page" contentClassName="xl:pt-8 2xl:pt-16">
    <EvimedSearchHome category={category} draft={draft} onDraftChange={setDraft} onCategoryChange={switchCategory}
      onSubmit={submit} onClear={clearSearch} onCompositionChange={value => { composing.current = value; }} />
  </PageShell></div>;
  const selectedIds = new Set(selectedItems.map(item => item.id));
  const selectableItems = category === "literature" ? result?.items.filter(item => item.actionRef) ?? [] : [];
  const selectedOnPage = selectableItems.filter(item => selectedIds.has(item.id)).length;
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
    <div ref={rootRef} className="h-full min-h-0"><PageShell title="医学检索" width="page"
      actions={<Link to={`/app/search/${category}`} className={buttonClasses({ variant: "text", size: "sm" })}><ArrowLeft size={16} aria-hidden="true" />检索首页</Link>}
      toolbar={{
      label: "检索条件",
      views: { label: "检索类别", items: EVIMED_SEARCH_CATEGORIES, value: category, onChange: switchCategory, panelId: "evimed-search-results" },
      search: { label: "检索关键词", placeholder: category === "drugs" ? "药品名称" : "输入关键词", value: draft, maxLength: 200,
        onChange: setDraft, onClear: clearSearch, onSubmit: submit,
        inputProps: { onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; } } },
      actions: <Button size="sm" disabled={!draft.trim()} loading={busy && draft.trim() === query} onClick={submit}>检索</Button>,
    }}>
      <SearchWorkspace count={result?.total} pending={busy} searched={Boolean(query)} sort={sortControl}
        filtersCollapsed={filtersCollapsed} onFiltersCollapsedChange={setFiltersCollapsed}
        tools={category === "literature" && <>
          {selectableItems.length > 0 && <SelectionCheckbox label="选择本页" showLabel checked={selectedOnPage === selectableItems.length}
            mixed={selectedOnPage > 0 && selectedOnPage < selectableItems.length}
            disabled={selectedOnPage === 0 && selectedItems.length >= 20}
            onChange={value => selectItems(selectableItems, value)} />}
          <EvimedSearchBatchActions category={category} items={selectedItems} onClear={clearSelection} onRefresh={retrySearch} />
        </>}
        filters={<EvimedSearchFilters key={`${category}:${query}`} category={category} query={query} filters={filters} facets={facets}
          loading={facetsBusy} onChange={values => update({ ...values, page: null })} onReset={resetFilters} onRetry={retryFacets} />}>
      {busy ? <SearchSkeleton />
          : state.status === "error" ? <SearchError error={state.error} currentPath={currentPath} onRetry={retryCurrent} onSearch={retrySearch} />
            : result && result.items.length === 0 ? <StateScreen icon={SearchX} title={page > 1 ? "这一页暂无结果，请返回第一页。" : "没有找到符合条件的结果，请换个关键词或放宽筛选。"}
              action={page > 1 ? <Button variant="secondary" onClick={() => update({ page: null })}>返回第一页</Button>
                : Object.entries(filters).some(([key, value]) => value !== "" && !(key === "sort" && value === "comprehensive") && !(key === "source" && value === "0")) ? <Button variant="secondary" onClick={resetFilters}>清除筛选</Button> : undefined} />
              : result && <>
                <List label="检索结果" divided>
                  {result.items.map((item, index) => {
                    const detailParams = new URLSearchParams(params);
                    if (item.detailRef) detailParams.set("detail", item.detailRef);
                    const href = evimedSourceUrl(item.url);
                    return <ListRow key={`${item.id}-${index}`} title={<span className="block max-w-measure text-ui font-semibold text-text group-hover:text-accent group-focus-within:text-accent">{item.title}</span>}
                      eyebrow={<ResultProvenance item={item} />}
                      leading={category === "literature" && item.actionRef ? <div className="relative z-sticky self-start"><SelectionCheckbox label={`选择《${item.title}》`}
                        checked={selectedIds.has(item.id)} disabled={selectedItems.length >= 20 && !selectedIds.has(item.id)} onChange={value => selectItems([item], value)} /></div> : undefined}
                      to={item.detailRef ? `/app/search/${category}?${detailParams}` : undefined} href={!item.detailRef && href ? href : undefined}
                      meta={<ResultMetadata item={item} />} className="group break-words py-4" footerLayout="aside"
                      footer={<EvimedSearchActions category={category} item={item} onRefresh={retrySearch} onCollectedChange={value => updateCollected(item.actionRef!, value)} />} />;
                  })}
                </List>
                <nav aria-label="结果分页" className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>上一页</Button>
                  <span role="status" className="text-ui tabular-nums text-text-2">第 {page} / {Math.max(1, Math.ceil(result.total / PAGE_SIZE))} 页</span>
                  <Button variant="secondary" disabled={page * PAGE_SIZE >= result.total || page >= 1000} onClick={() => update({ page: String(page + 1) })}>下一页</Button>
                </nav>
              </>}
      </SearchWorkspace>
    </PageShell></div>
  );
}
