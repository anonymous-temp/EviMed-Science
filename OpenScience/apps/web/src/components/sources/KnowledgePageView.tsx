import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Pencil } from "lucide-react";
import { knowledgePageTypeLabel } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Tag } from "@/components/ui/Tag";
import { Textarea } from "@/components/ui/Input";
import { LoadError } from "@/components/cards/LoadError";
import { WebApiError } from "@/lib/apiClient";
import { readListState, readerPath } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import {
  getKnowledgePage, getKnowledgePageAt, getKnowledgeStatus, requestKnowledgeCompile, saveKnowledgePage,
  type KnowledgePage, type KnowledgeStatus, type SourceRecord,
} from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { useWide } from "@/lib/useMediaQuery";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { STALE_LABEL, maskEngineAddresses, staleReasons, statusLine } from "./knowledgeView";

/** A page of this many sections or more has a contents beside it. */
const OUTLINE_FROM = 4;

/**
 * 「知识页」, opened: the page as the compile wrote it, drawn as a document (`KnowledgeMarkdown`), with what a reader needs
 * to know first above it — the documents it quotes that have changed since, a quiet 「重新整理」, the paragraphs of the
 * person's own that a compile dropped and the platform put back — and how many of its quotations the platform found in
 * the documents. Editing is the whole page's text in one field; saving makes the page's next version (a new document, so
 * the address follows it), and from then on the person's wording is what a recompile adds to and never rewrites.
 */
export function KnowledgePageView({ source, onPage }: { source: SourceRecord; onPage?: (page: KnowledgePage) => void }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [page, setPage] = useState<KnowledgePage | null>(null);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState(false);
  const report = useRef(onPage);
  report.current = onPage;
  // A page of four sections or more has its contents (the reader's T5 rule): read off the headings the page rendered, in a column beside
  // it from `lg` and folded above it below.
  const wide = useWide();
  const body = useRef<HTMLDivElement>(null);
  const outlineId = `kp${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const { entries, active, select } = useOutline(body, { enabled: page !== null && !editing, idPrefix: outlineId, refresh: [page] });
  const outlined = entries.length >= OUTLINE_FROM;
  useEffect(() => {
    let active = true;
    setError(null);
    getKnowledgePage(source.id).then(
      (value) => { if (active) { setPage(value); report.current?.(value); } },
      (failure) => { if (active) setError(`无法打开这页：${productErrorMessage(failure)}`); },
    );
    getKnowledgeStatus(source.projectId).then((value) => { if (active) setStatus(value); }, () => { /* the page stands without it */ });
    return () => { active = false; };
  }, [source.id, source.projectId, attempt]);

  const follow = useCallback((id: string) => navigate(readerPath(id, readListState(params)), { replace: true }), [navigate, params]);
  const compile = async () => {
    setAsking(true);
    try {
      setStatus(await requestKnowledgeCompile(source.projectId));
      toast.success("已开始重新整理，稍后回来即可看到");
    } catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setAsking(false); }
  };

  if (error && !page) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!page) return <p role="status" className="text-ui text-text-3">正在打开</p>;
  if (editing) {
    return (
      <div className="h-full max-w-read overflow-y-auto pb-8">
        <PageEditor
          page={page}
          projectId={source.projectId}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => { setEditing(false); toast.success("已保存"); if (saved.sourceId === source.id) { setPage(saved); report.current?.(saved); } else follow(saved.sourceId); }}
          onReloaded={(fresh) => { setPage(fresh); report.current?.(fresh); if (fresh.sourceId !== source.id) follow(fresh.sourceId); }}
        />
      </div>
    );
  }
  // As `ScrollRegion` writes them: a spread, because the lint rule cannot model a scroll region.
  const region = { tabIndex: 0, role: "region", "aria-label": page.title };
  const reasons = staleReasons(page.stale);
  const titles = new Map(page.sources.map((entry) => [entry.sourceId, entry.title]));
  const line = statusLine(status);
  const canCompile = Boolean(line?.canCompile) && !asking;
  const counts = page.quotations;
  return (
    // The page scrolls in its own box, so the box is a region a keyboard can reach and a screen reader can name (axe
    // `scrollable-region-focusable`: a document of one paragraph of data has no link in it to put the focus on).
    <div {...region} className="flex h-full items-start gap-8 overflow-y-auto pb-8" data-knowledge-page="">
      <div ref={body} className="min-w-0 max-w-read flex-1 space-y-4">
        {outlined && !wide && <Outline layout="folded" entries={entries} active={active} onSelect={select} className="mb-2" />}
        <div className="flex flex-wrap items-center gap-2">
          <Tag>{knowledgePageTypeLabel(page.type)}</Tag>
          {page.tags.slice(0, 4).map((tag) => <Tag key={tag}>{tag}</Tag>)}
          {page.editable && (
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
              <Pencil size={16} aria-hidden="true" />编辑
            </Button>
          )}
        </div>
        {page.description && <p className="text-ui text-text-2">{page.description}</p>}
        {reasons.length > 0 && (
          <div role="status" data-knowledge-stale="" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-warn-soft px-3 py-2 text-ui text-warn-strong">
            {reasons.map((reason) => {
              const named = page.stale.filter((entry) => (entry.reason in STALE_LABEL ? entry.reason : "changed") === reason);
              return (
                <span key={reason} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium">{STALE_LABEL[reason]}</span>
                  {named.map((entry) => (
                    <Link key={entry.sourceId} to={`/app/files/${encodeURIComponent(entry.sourceId)}`} className="text-link underline underline-offset-2">
                      {titles.get(entry.sourceId) ?? "这份资料"}
                    </Link>
                  ))}
                </span>
              );
            })}
            {canCompile && <Button variant="text" size="sm" className="ml-auto" onClick={() => void compile()}>重新整理</Button>}
          </div>
        )}
        {page.restored && page.restored.count > 0 && (
          <Note className="text-caption" result={["上一次重新整理时丢掉了你写的 ", { n: page.restored.count }, " 处补充，已经放回原处。"]} />
        )}
        {counts && counts.present + counts.absent > 0 && (
          <p className="text-caption text-text-3">
            {counts.present > 0 ? `${counts.present} 处引文已在原文里找到` : ""}
            {counts.present > 0 && counts.absent > 0 ? " · " : ""}
            {counts.absent > 0 ? `${counts.absent} 处没能核对` : ""}
          </p>
        )}
        <KnowledgeMarkdown page={page} />
      </div>
      {outlined && wide && <Outline layout="column" entries={entries} active={active} onSelect={select} />}
    </div>
  );
}

/**
 * The whole page's text in one field. The version it was loaded from goes back with the text; if a compile has rewritten
 * the page meanwhile the control plane refuses (`knowledge_page_changed`), the editor takes the newer version in and says
 * so in one sentence — the person's change is theirs to make again, never silently laid over the new one.
 */
function PageEditor({ page, projectId, onCancel, onSaved, onReloaded }: {
  page: KnowledgePage;
  projectId: string;
  onCancel: () => void;
  onSaved: (page: KnowledgePage) => void;
  onReloaded: (page: KnowledgePage) => void;
}) {
  const [base, setBase] = useState(page);
  // The engine's address in front of each link to a document is not the person's to read or to keep; it goes back on when saved.
  const masked = useMemo(() => maskEngineAddresses(base.markdown), [base.markdown]);
  const [text, setText] = useState(masked.text);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const changed = text !== masked.text;
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await saveKnowledgePage({ sourceId: base.sourceId, markdown: masked.restore(text), baseSha256: base.sha256 });
      if (live.current) onSaved(saved.page);
    } catch (failure) {
      if (!live.current) return;
      if (failure instanceof WebApiError && failure.code === "knowledge_page_changed") {
        try {
          const fresh = await getKnowledgePageAt(projectId, base.tree, base.path);
          if (!live.current) return;
          setBase(fresh);
          setText(maskEngineAddresses(fresh.markdown).text);
          onReloaded(fresh);
          setMessage("这一页刚被重新整理过，已换成最新的版本，请在它的基础上再改一次。");
        } catch (reloadFailure) { setMessage(productErrorMessage(reloadFailure)); }
      } else setMessage(productErrorMessage(failure));
    } finally {
      if (live.current) setSaving(false);
    }
  };
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (changed && text.trim() && !saving) void save(); }}>
      <Textarea label="页面全文" value={text} rows={22} onChange={(event) => setText(event.target.value)} disabled={saving} error={message}
        className="font-mono" />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="text" onClick={onCancel} disabled={saving}>取消</Button>
        <Button type="submit" loading={saving} disabled={!changed || !text.trim()}>保存</Button>
      </div>
    </form>
  );
}
