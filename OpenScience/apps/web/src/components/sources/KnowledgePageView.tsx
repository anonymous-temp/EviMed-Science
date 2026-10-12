import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CircleCheck, Pencil, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tag } from "@/components/ui/Tag";
import { LoadError } from "@/components/cards/LoadError";
import { productErrorMessage } from "@/lib/productClient";
import {
  getKnowledgePage, locateSourceQuote, type KnowledgePageEvidence, type KnowledgePageItem, type KnowledgePageViewData, type SourceRecord,
} from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { NoteEditor } from "./NoteEditor";

/** What a changed document did to a page, in the words the memory drawer already uses for a source that moved. */
const STALE_LABEL: Record<string, string> = { changed: "来源已更改", retracted: "来源已撤回", removed: "来源已删除" };
/** How firmly documents back a statement across them: independent documents agreeing, agreeing in direction, or only in part. */
const CONFIDENCE_LABEL: Record<string, string> = { high: "多方一致", moderate: "方向一致", low: "支持有限" };
const UNCONFIRMED = "没能在原文里核对到这句引文";

/**
 * The position of a quotation in the document it comes from, then the document's page open on it (the reader takes the
 * highlight from its address). A quotation that cannot be found any more opens the document without one.
 */
async function openQuotation(evidence: KnowledgePageEvidence, go: (path: string) => void) {
  const base = `/app/files/${encodeURIComponent(evidence.sourceId)}`;
  try {
    const found = await locateSourceQuote(evidence.sourceId, evidence.quote);
    if (found.status === "verified" && found.start !== null && found.end !== null && found.textSha256) {
      const params = new URLSearchParams({ tab: "original", start: String(found.start), end: String(found.end), sha: found.textSha256 });
      if (found.page) params.set("page", String(found.page));
      go(`${base}?${params}`);
      return;
    }
  } catch { /* the document opens without a highlight */ }
  go(`${base}?tab=original`);
}

/**
 * 「知识页」, opened: the page's sentences, each with the document it quotes. A sentence the platform has checked against
 * its document carries a ✓; one whose quotation it cannot find in the document carries a ⚠ and says that of the
 * quotation — nothing is hidden. A quotation opens the document at that place. The researcher's own sentences, which quote
 * nothing, are shown as theirs. The sentences the compile could not confirm are listed apart, under a fold, and are not
 * part of the page's text.
 *
 * Editing is the note editor on the page's whole text; saving makes the next version of this document, and from then on
 * the researcher's wording is what a recompile adds to and never rewrites.
 */
export function KnowledgePageView({ source, onSaved }: { source: SourceRecord; onSaved: (source: SourceRecord) => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<KnowledgePageViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    getKnowledgePage(source.id).then(
      (value) => { if (active) setView(value); },
      (failure) => { if (active) setError(`无法打开这页：${productErrorMessage(failure)}`); },
    );
    return () => { active = false; };
  }, [source.id, attempt]);
  const open = useCallback((evidence: KnowledgePageEvidence) => { void openQuotation(evidence, navigate); }, [navigate]);

  if (error && !view) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!view) return <p role="status" className="text-ui text-text-3">正在打开</p>;
  if (editing) {
    return (
      <div className="max-w-read">
        <NoteEditor source={source} onSaved={(saved) => { setEditing(false); toast.success("已保存"); onSaved(saved); }} />
        <Button variant="text" className="mt-2" onClick={() => setEditing(false)}>取消</Button>
      </div>
    );
  }
  const stale = [...new Set(view.stale.map((entry) => STALE_LABEL[entry.reason] ?? STALE_LABEL.changed))];
  return (
    <div className="h-full max-w-read space-y-6 overflow-y-auto pb-8" data-knowledge-page="">
      <div className="flex flex-wrap items-center gap-2">
        {stale.map((label) => <Tag key={label} tone="warn">{label}</Tag>)}
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
          <Pencil size={16} aria-hidden="true" />编辑
        </Button>
      </div>
      {view.sections.map((section, index) => (
        <section key={`${section.heading}-${index}`} aria-label={section.heading || view.title}>
          {section.heading && <h2 className="mb-2 text-section font-medium text-text">{section.heading}</h2>}
          <ul className="space-y-3">
            {section.items.map((item, position) => <PageItem key={position} item={item} onOpen={open} />)}
          </ul>
        </section>
      ))}
      {view.held.length > 0 && (
        <Disclosure summary={`未能核对的 ${view.heldCount || view.held.length} 句`}>
          <ul className="mt-2 space-y-2">
            {view.held.map((held, index) => (
              <li key={index} className="flex gap-2 text-ui text-text-2">
                <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
                <span>{held.text}<span className="ml-2 text-caption text-text-3">{UNCONFIRMED}</span></span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

function PageItem({ item, onOpen }: { item: KnowledgePageItem; onOpen: (evidence: KnowledgePageEvidence) => void }) {
  if (item.kind === "nav") {
    return (
      <li className="flex flex-wrap gap-x-3 gap-y-1 text-ui">
        {item.links.map((link) => link.sourceId
          ? <Link key={link.slug} to={`/app/files/${encodeURIComponent(link.sourceId)}`} className="text-accent hover:underline">{link.title ?? link.slug}</Link>
          : <span key={link.slug} className="text-text-3">{link.title ?? link.slug}</span>)}
      </li>
    );
  }
  const standing = item.status === "verified";
  const unconfirmed = item.status === "unverified";
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 shrink-0" role="img" aria-label={standing ? "已核对" : unconfirmed ? "未能核对" : "我的补充"}>
        {standing ? <CircleCheck size={16} aria-hidden="true" className="text-ok" />
          : unconfirmed ? <TriangleAlert size={16} aria-hidden="true" className="text-warn" /> : <span className="inline-block h-4 w-4" aria-hidden="true" />}
      </span>
      <div className="min-w-0 space-y-1">
        <p className={unconfirmed ? "text-ui text-text-2" : "text-ui text-text"}>{item.text}</p>
        {item.claimKind === "synthesized" && (
          <Tag>综合{item.confidence && CONFIDENCE_LABEL[item.confidence] ? ` · ${CONFIDENCE_LABEL[item.confidence]}` : ""}</Tag>
        )}
        {item.evidence.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {item.evidence.map((evidence, index) => (
              <li key={index} className="max-w-measure">
                <button type="button" onClick={() => onOpen(evidence)}
                  className={evidence.status === "verified" ? "text-left text-caption text-accent hover:underline" : "text-left text-caption text-text-3 hover:underline"}>
                  {evidence.title ? `《${evidence.title}》` : "原文"}{evidence.status === "verified" ? "" : ` · ${UNCONFIRMED}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
