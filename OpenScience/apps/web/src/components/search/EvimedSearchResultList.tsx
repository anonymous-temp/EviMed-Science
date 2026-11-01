import type { ReactNode } from "react";
import { List, ListRow } from "@/components/ui/ListRow";
import { SelectionCheckbox } from "@/components/ui/SelectionCheckbox";
import { normalizedSearchFact } from "@/components/search/evimedReaderContent";
import { evimedSourceUrl, type EvimedSearchItem } from "@/lib/evimedSearchClient";

export interface SearchResultSelection {
  items: readonly EvimedSearchItem[];
  limit: number;
  onChange(items: EvimedSearchItem[], selected: boolean): void;
  onClear(): void;
}

export interface SearchResultLink {
  to: string;
  state?: unknown;
}

function ResultMetadata({ item }: { item: EvimedSearchItem }) {
  const authors = item.authors.slice(0, 3).join("、") + (item.authors.length > 3 ? " 等" : "");
  const subtitle = normalizedSearchFact(item.subtitle);
  return (
    <div data-prose="" className="space-y-1 break-words">
      {authors && <div className="line-clamp-1 text-caption text-text-2">{authors}</div>}
      {subtitle && subtitle !== normalizedSearchFact(item.source) && subtitle !== normalizedSearchFact(item.title)
        && <div className="line-clamp-1 text-caption text-text-2">{item.subtitle}</div>}
      {item.summary && <p className="line-clamp-2 text-ui text-text">{item.summary}</p>}
      {item.tags.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-2">
        {[...new Set(item.tags)].slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}
      </div>}
    </div>
  );
}

function ResultProvenance({ item }: { item: EvimedSearchItem }) {
  const source = normalizedSearchFact(item.source);
  return (source || item.publishedAt) ? <div className="flex min-w-0 flex-1 items-baseline gap-3 text-caption text-text-2">
    {source && <span className="truncate">{source}</span>}
    {item.publishedAt && <time className="shrink-0 tabular-nums text-text-3">{item.publishedAt}</time>}
  </div> : null;
}

/**
 * Component: EvimedSearchResultList; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Divided shared rows led by the full title, then source/date with optional actions and a short preview.
 * Variants: Internal destinations supplied by the host, safe external links, or static items.
 * States: Controlled selection; the host owns fetching, caching and collection changes.
 * Hit area: Only the title opens details; selection and supplied actions keep independent targets.
 * Keyboard: Native links and checkboxes; complete titles remain in the document.
 * Long content: Titles wrap in full; source/author/subtitle previews use one line, abstracts two.
 * Theme: Existing semantic text, surface, spacing and type tokens; no independent palette.
 * Responsive: Compact actions share the source line; titles and previews use the available result width without a separate prose measure.
 * Verification: EvimedSearchResults.test.tsx and route regressions; Chrome checks density/reflow.
 */
export function EvimedSearchResultList({ items, selection, getDetailLink, renderActions }: {
  items: readonly EvimedSearchItem[];
  selection?: SearchResultSelection;
  getDetailLink?(item: EvimedSearchItem): SearchResultLink | undefined;
  renderActions?(item: EvimedSearchItem): ReactNode;
}) {
  const selectedIds = new Set(selection?.items.map(item => item.id));
  return <List label="检索结果" divided>
    {items.map((item, index) => {
      const link = getDetailLink?.(item);
      const href = link ? undefined : evimedSourceUrl(item.url) ?? undefined;
      return <ListRow key={`${item.id}-${index}`}
        title={<span className="block text-ui font-semibold">{item.title}</span>}
        leading={selection && item.actionRef ? <div className="relative z-sticky self-start">
          <SelectionCheckbox label={`选择《${item.title}》`} checked={selectedIds.has(item.id)}
            disabled={selection.items.length >= selection.limit && !selectedIds.has(item.id)}
            onChange={value => selection.onChange([item], value)} />
        </div> : undefined}
        to={link?.to} state={link?.state} href={href}
        meta={<div className="space-y-1">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <ResultProvenance item={item} />
            {renderActions && <div className="relative z-sticky ml-auto max-w-full">{renderActions(item)}</div>}
          </div>
          <ResultMetadata item={item} />
        </div>}
        openArea="title" chevron={false} className="break-words py-2" />;
    })}
  </List>;
}
