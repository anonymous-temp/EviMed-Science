import type { ReactNode } from "react";
import { FileSearch } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { readerPath, type KnowledgeListState } from "@/lib/knowledgeNav";
import type { KnowledgeTreeRow } from "@/lib/sourceClient";
import { formatDay } from "@/lib/format";
import { STALE_LABEL, groupRows, staleReasons } from "./knowledgeView";

/** The one line under a page's title: what stands in the way of trusting it, and what the person added. */
function rowMeta(row: KnowledgeTreeRow) {
  const { labels } = row;
  const reasons = staleReasons(labels.stale);
  const quotations = labels.quotations;
  const lost = quotations?.absent ?? 0;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {reasons.map((reason) => <Tag key={reason} tone="warn">{STALE_LABEL[reason]}</Tag>)}
      {labels.userEdited && <Tag tone="accent">含我的补充</Tag>}
      {lost > 0 && <span>{lost} 处引文没能核对</span>}
      <span>{formatDay(row.updatedAt)}</span>
    </span>
  );
}

/**
 * The project's compiled files, as a tree by what they are: the pages by type — 概念, 实体, 方法, 比较, 分析, 摘要, 目录 — then the
 * knowledge graph's entities. A row opens the file in the reader. The toolbar's search narrows the tree in hand by title.
 *
 * With nothing to list the page says what to do about it (`empty`, the 知识页 tab's recipe) — a bare 「还没有整理出页面」 was a dead end —
 * and a search that matches nothing says only that.
 */
export function KnowledgeTree({ rows, query, listState, empty }: { rows: readonly KnowledgeTreeRow[]; query: string; listState: KnowledgeListState; empty: ReactNode }) {
  const groups = groupRows(rows, query);
  if (groups.length === 0) return query ? <EmptyState icon={FileSearch} title="没有找到相关的页面" reason="换个关键词试试，或清空搜索框看全部。" /> : <>{empty}</>;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <div data-knowledge-tree="" className="space-y-3">
      {groups.map((group, index) => (
        <Disclosure key={group.id} defaultOpen={Boolean(query) || total <= 40 || index === 0}
          summary={<span className="font-semibold text-text">{group.label}<span className="ml-2 font-normal text-text-3">{group.rows.length}</span></span>}>
          <List label={group.label}>
            {group.rows.map((row) => <ListRow key={row.sourceId} title={row.title} to={readerPath(row.sourceId, listState)} meta={rowMeta(row)} />)}
          </List>
        </Disclosure>
      ))}
    </div>
  );
}

/** Where the compiled files are read when the tree cannot be: the plain list of documents, and the one way to try the tree again. */
export function KnowledgeTreeMissing({ onRetry }: { onRetry: () => void }) {
  return (
    <Note className="mb-3" action={<Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>}>知识页的目录暂时没能读取，下面是文件列表。</Note>
  );
}
