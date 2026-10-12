import { FileText, Search } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tooltip } from "@/components/ui/Tooltip";
import { artifactDisplayName } from "@/lib/artifactNames";
import { formatDay } from "@/lib/format";
import { runFilePath, type ProjectOutput } from "@/lib/knowledgeBaseClient";

/** Whether an output answers the search box: the conversation it came out of, or what the file is called. */
export function outputMatches(output: ProjectOutput, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || [output.title ?? "", artifactDisplayName(output.path), output.path.slice(output.path.lastIndexOf("/") + 1)].some((text) => text.toLowerCase().includes(needle));
}

/**
 * 「对话产出」: the files the project's conversations delivered — one line per report, document or draft, named by the
 * conversation it came out of, with what the file is under the name and the day at the end. A line is a link to the file where
 * its run left it (`/app/runs/:runId/files/*`); nothing is copied into the knowledge base by listing it, and the reader's own
 * 「存入知识库」 on the file is the way one goes in.
 *
 * The search box above filters this list too, by what the lines say. Four states, as every list: the skeleton while it is
 * read, one sentence where the project's conversations have delivered nothing (or nothing matches), the failure with 重试,
 * and the lines.
 */
export function ProjectOutputsList({ items, failed, query, onRetry }: {
  /** Null while the list is being read. */
  items: readonly ProjectOutput[] | null;
  failed: boolean;
  query: string;
  onRetry: () => void;
}) {
  if (failed) return <LoadError message="无法加载对话产出，请重试。" onRetry={onRetry} />;
  if (items === null) return <FilesSkeleton />;
  const shown = items.filter((output) => outputMatches(output, query));
  if (shown.length === 0) {
    return query.trim()
      ? <EmptyState icon={Search} title="没有找到相关产出" />
      : <EmptyState icon={FileText} title="这个项目的对话还没有产出文件。" />;
  }
  return (
    <List label="对话产出">
      {shown.map((output) => {
        const name = artifactDisplayName(output.path);
        const title = output.title ?? name;
        return (
          <ListRow
            key={`${output.runId}:${output.path}`}
            leading={<span className="grid h-8 w-8 place-items-center rounded bg-surface-2 text-text-3"><FileText size={16} aria-hidden="true" /></span>}
            title={<Tooltip content={title} kind="label" whenTruncated><span className="block truncate">{title}</span></Tooltip>}
            to={runFilePath(output.runId, output.path)}
            meta={output.title ? name : undefined}
            trailing={<span className="tabular-nums">{formatDay(output.at)}</span>}
          />
        );
      })}
    </List>
  );
}
