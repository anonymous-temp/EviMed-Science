import { Link } from "react-router";
import { ExternalLink, FileText, Landmark } from "lucide-react";
import type { WebReadPage } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { safeWebHref, snapshotHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";

/**
 * The 官方来源 label: a regulator's, a guideline body's or a registry's own
 * page. Neutral on purpose — it says where a page comes from, which is what an
 * evidence grade needs, not that what it says is right; teal is the verified
 * mark and red the safety one, and this is neither. Said with an icon and words.
 */
export function OfficialSourceBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-2 px-1.5 text-caption text-text">
      <Landmark size={11} aria-hidden="true" />官方来源
    </span>
  );
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
    <div className={cn("min-w-0 space-y-0.5", compact ? "rounded-input border border-border bg-surface-2 p-2" : "")}>
      <p className="flex flex-wrap items-center gap-1.5 text-ui">
        {original ? (
          <a href={original} target="_blank" rel="noreferrer" className="min-w-0 break-words text-link hover:underline">
            {page.title}
            <ExternalLink size={11} className="ml-0.5 inline align-baseline" aria-hidden="true" />
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
        {page.rendered && (<><span aria-hidden="true">·</span><span>页面由浏览器打开后读取</span></>)}
      </p>
      {showSnapshot && runId && page.snapshotPath && (
        <Link
          to={snapshotHref(runId, page.snapshotPath)}
          className="inline-flex items-center gap-1 text-caption text-link hover:underline"
        >
          <FileText size={12} aria-hidden="true" />查看保存的快照
        </Link>
      )}
    </div>
  );
}

/** Every page a run read, first read first, and how many more it read than are listed. */
export function ReadPagesList({ pages, total, runId }: {
  pages: readonly WebReadPage[];
  total?: number;
  runId: string;
}) {
  const hidden = Math.max(0, (total ?? pages.length) - pages.length);
  return (
    <div className="space-y-2">
      <p className="text-muted">这次运行阅读并保存了这些网页。报告引用网页时，引文是对照保存的快照核对的。</p>
      <ul className="space-y-2">
        {pages.map((page) => (
          <li key={`${page.sha256}:${page.finalUrl}`} className="border-l-2 border-faint pl-2">
            <ReadPageCard page={page} runId={runId} />
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-caption text-muted">另有 {hidden} 个网页未列出，完整记录在本次运行的对话记录里。</p>}
    </div>
  );
}
