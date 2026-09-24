import { Link } from "react-router";
import { ExternalLink, FileText } from "lucide-react";
import type { WebReadPage } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { safeWebHref, snapshotHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";
import { Tag } from "@/components/ui/Tag";

/**
 * The 官方来源 label: a regulator's, a guideline body's or a registry's own
 * page. Neutral on purpose — it says where a page comes from, which is what an
 * evidence grade needs, not that what it says is right; teal is the verified
 * mark and red the safety one, and this is neither. Said with an icon and words.
 */
export function OfficialSourceBadge() {
  return <Tag>官方来源</Tag>;
}

/**
 * One page the run read: title (linked to the original), site and time, the
 * official label, whether a browser had to draw it, and the preserved snapshot
 * the run could quote. Wraps rather than truncates, so a long title and a long
 * address stay readable on a phone.
 */
export function ReadPageCard({ page, runId, compact = false, showSnapshot = true }: {
  page: WebReadPage;
  runId: string | null | undefined;
  compact?: boolean;
  /** Off where the caller already links the same snapshot, at the quotation. */
  showSnapshot?: boolean;
}) {
  const original = safeWebHref(page.finalUrl) ?? safeWebHref(page.url);
  return (
    <div className={cn("min-w-0 space-y-0.5", compact ? "rounded bg-surface-1 p-2" : "")}>
      <p className="flex flex-wrap items-center gap-1.5 text-ui">
        {original ? (
          <a href={original} target="_blank" rel="noreferrer" className="min-w-0 break-words text-link hover:underline">
            {page.title}
            <ExternalLink size={16} className="ml-0.5 inline align-baseline" aria-hidden="true" />
          </a>
        ) : (
          <span className="min-w-0 break-words text-text">{page.title}</span>
        )}
        {page.official && <OfficialSourceBadge />}
      </p>
      <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted">
        <span className="break-all">{page.site}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={page.fetchedAt}>{formatDateTime(page.fetchedAt)}</time>
      </p>
      {showSnapshot && runId && page.snapshotPath && (
        <Link
          to={snapshotHref(runId, page.snapshotPath)}
          className="inline-flex items-center gap-1 text-caption text-link hover:underline"
        >
          <FileText size={16} aria-hidden="true" />查看保存的快照
        </Link>
      )}
    </div>
  );
}
