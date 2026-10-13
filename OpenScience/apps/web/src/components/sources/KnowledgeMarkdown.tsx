import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { listParams, readListState, readerPath } from "@/lib/knowledgeNav";
import { locateSourceQuote, type KnowledgePage, type KnowledgePageLink } from "@/lib/sourceClient";
import { linkPosition, pageSegments, rawMarkdown, withoutLeadingTitle } from "./knowledgeView";

const LINK = "text-link underline decoration-1 underline-offset-2 hover:decoration-2";
const MISSING_QUOTE = "没能在原文里核对到这句引文";

/**
 * The position of a quotation in the document it comes from, then the document's page open on it (the reader takes the
 * highlight from its address). A quotation that cannot be found any more opens the document without one.
 */
export async function openQuotation(sourceId: string, quote: string | null, go: (path: string) => void, listSearch = ""): Promise<void> {
  const base = `/app/files/${encodeURIComponent(sourceId)}`;
  const tail = listSearch ? `&${listSearch}` : "";
  if (quote) {
    try {
      const found = await locateSourceQuote(sourceId, quote);
      if (found.status === "verified" && found.start !== null && found.end !== null && found.textSha256) {
        const params = new URLSearchParams({ tab: "original", start: String(found.start), end: String(found.end), sha: found.textSha256 });
        if (found.page) params.set("page", String(found.page));
        go(`${base}?${params}${tail}`);
        return;
      }
    } catch { /* the document opens without a highlight */ }
  }
  go(`${base}?tab=original${tail}`);
}

/** A page that cannot be drawn shows what it says as it is written, never an error. */
class RawFallback extends Component<{ raw: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <pre data-knowledge-raw="" className="whitespace-pre-wrap break-words rounded-card bg-surface-2 p-4 font-mono text-ui text-text">{this.props.raw}</pre>;
  }
}

/** One link to a document: opens it at the quotation, and says whether the platform found that quotation in the document. */
function SourceLink({ link, children }: { link: Extract<KnowledgePageLink, { kind: "source" }>; children: ReactNode }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  if (!link.available || link.status === "source_missing") {
    return <Tooltip content="这份资料已不在知识库里"><span className="text-text-3">{children}</span></Tooltip>;
  }
  const mark = link.status === "present" ? (
    <span role="img" aria-label="原文里找到了这句引文" className="ml-0.5 inline-block align-text-bottom"><CircleCheck size={16} aria-hidden="true" className="text-ok" /></span>
  ) : link.status === "absent" ? (
    <button type="button" aria-expanded={open} aria-label={`${MISSING_QUOTE}，点开看是哪一句`} onClick={() => setOpen((value) => !value)}
      className="ml-0.5 inline-block rounded align-text-bottom"><TriangleAlert size={16} aria-hidden="true" className="text-warn" /></button>
  ) : null;
  return (
    <>
      <button type="button" className={`${LINK} text-left`} onClick={() => void openQuotation(link.sourceId, link.quote, navigate, listParams(readListState(params)).toString())}>{children}</button>
      {mark}
      {link.status === "absent" && open && (
        <span role="note" className="mx-1 rounded-tag bg-warn-soft px-1.5 py-0.5 text-caption text-warn-strong">
          {MISSING_QUOTE}：“{link.quote}”
        </span>
      )}
    </>
  );
}

/** A page of the knowledge base opened from a page; one that is not there yet is written as plain text. */
function PageLinkTo({ link, children }: { link: Extract<KnowledgePageLink, { kind: "page" }>; children: ReactNode }) {
  const [params] = useSearchParams();
  if (!link.exists || !link.sourceId) return <Tooltip content="这一页还没有整理出来"><span className="text-text-2">{children}</span></Tooltip>;
  return <Link to={readerPath(link.sourceId, readListState(params))} className={LINK}>{children}</Link>;
}

/**
 * A knowledge page, drawn: its Markdown as the document reader draws any report — headings, lists, tables, emphasis —
 * with each link the control plane found replaced by what it leads to. A link to a page goes to that page in the app; a
 * link to a document opens the document at the quotation and carries a ✓ (the platform found the quotation) or a ⚠ (it
 * did not, and says which sentence); a link with no quotation carries nothing; the engine's own address is never shown.
 * The person's own paragraphs stand apart, marked as theirs.
 */
export function KnowledgeMarkdown({ page }: { page: KnowledgePage }) {
  // The title heading is dropped after the links were replaced, so the offsets the control plane measured still hold.
  const segments = useMemo(() => {
    const cut = pageSegments(page);
    return cut.map((segment, index) => (index === 0 && !segment.mine ? { ...segment, markdown: withoutLeadingTitle(segment.markdown, page.title) } : segment));
  }, [page]);
  const renderLink = useCallback((href: string | undefined, children: ReactNode): ReactNode | undefined => {
    const position = linkPosition(href);
    if (position === null) return href && /^viking:/iu.test(href) ? children : undefined;
    const link = page.links[position];
    if (!link) return children;
    if (link.kind === "source") return <SourceLink link={link}>{children}</SourceLink>;
    if (link.kind === "page") return <PageLinkTo link={link}>{children}</PageLinkTo>;
    return /^(https?:|mailto:)/iu.test(link.href)
      ? <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK}>{children}</a>
      : <>{children}</>;
  }, [page.links]);

  // The graph's relation file is data, not a page: it is shown as it is written.
  if (page.type === "relations") {
    return <pre data-knowledge-raw="" className="whitespace-pre-wrap break-words rounded-card bg-surface-2 p-4 font-mono text-ui text-text">{rawMarkdown(page)}</pre>;
  }
  return (
    <RawFallback raw={rawMarkdown(page)}>
      <div data-knowledge-body="">
        {segments.map((segment, index) => segment.mine ? (
          <div key={index} data-knowledge-mine="" className="my-4 border-l-2 border-accent pl-4">
            <Tag tone="accent">我的补充</Tag>
            <MarkdownViewer variant="document" renderLink={renderLink}>{segment.markdown}</MarkdownViewer>
          </div>
        ) : (
          <MarkdownViewer key={index} variant="document" renderLink={renderLink}>{segment.markdown}</MarkdownViewer>
        ))}
      </div>
    </RawFallback>
  );
}
