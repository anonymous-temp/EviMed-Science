import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
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
 * knowledge graph's entities. A row opens the file in the reader. The search box narrows the tree in hand by title.
 */
export function KnowledgeTree({ rows, query, listState }: { rows: readonly KnowledgeTreeRow[]; query: string; listState: KnowledgeListState }) {
  const groups = groupRows(rows, query);
  if (groups.length === 0) return <p className="text-ui text-text-3">{query ? "没有找到相关的页面" : "还没有整理出页面"}</p>;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <div data-knowledge-tree="" className="space-y-3">
      {groups.map((group, index) => (
        <Disclosure key={group.id} defaultOpen={Boolean(query) || total <= 40 || index === 0}
          summary={<span className="font-medium text-text">{group.label}<span className="ml-2 font-normal text-text-3">{group.rows.length}</span></span>}>
          <List label={group.label}>
            {group.rows.map((row) => <ListRow key={row.sourceId} title={row.title} to={readerPath(row.sourceId, listState)} meta={rowMeta(row)} />)}
          </List>
        </Disclosure>
      ))}
    </div>
  );
}

/** Where the compiled files are read when the tree cannot be: the plain list of documents. */
export function KnowledgeTreeMissing({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="mb-3 text-caption text-text-3">
      知识页的目录暂时没能读取，下面是文件列表。<button type="button" onClick={onRetry} className="text-link underline underline-offset-2">重试</button>
    </p>
  );
}
