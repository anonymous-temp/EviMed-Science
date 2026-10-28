import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronLeft, FileQuestion, MessageSquare } from "lucide-react";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import { downloadArtifact, downloadSourceFile } from "@/lib/artifactFile";
import { parseFailureMessage } from "@/lib/errorText";
import { listPath, readReaderView, readerPath, type KnowledgeListState, type ReaderTab } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import {
  decideDuplicateGroup, getSource, listDuplicateCandidates, refetchSource, removeSource, retrySource,
  type DuplicateGroup, type KnowledgePage, type SourceRecord,
} from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
// eslint-disable-next-line no-restricted-imports -- the switch of the document's own two views (内容 · 原文), inside the pane that holds it: not a view of the page, which a master-detail page has none of
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { AppliesTo, AppliesToDialog, appliesView, conversationProjects } from "./AppliesTo";
import { ConversationProjectDialog } from "./ConversationProjectDialog";
import { DuplicateGroups } from "./DuplicateGroups";
import { KnowledgePageView } from "./KnowledgePageView";
import { SourceDependents } from "./SourceDependents";
import { SourceKeyPoints } from "./SourceKeyPoints";
import { SourceOriginal } from "./SourceOriginal";
import { SourceQuotation, type ConversationExcerpt } from "./SourceQuotation";
import { sourceMenuItems } from "./SourceRow";
import { conversationReferences, knowledgeConversationDraft } from "./knowledgeView";
import { conversationDraft, isEditableNote, isKnowledgePage, isReading, isUsable, originalPathOf, readerMeta } from "./sourceView";
import { COLUMN_GAP, fitsTwoColumns, MIN_PANE_HEIGHT, POINTS_WIDTH, useReaderBox } from "./useReaderBox";
import { useProjectGroups } from "./useProjectGroups";

/** A reading document is asked again this often, so the page shows its text and key points as soon as they are in. */
const READING_POLL_MS = 5000;

type Loaded =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "error"; message: string }
  | { phase: "ready"; source: SourceRecord };

/**
 * One document of the knowledge base, read: its original and what it says. Two places hold it (`mode`):
 *
 *  - `page`, a page of its own — what `/app/files/:sourceId` is where the list has no room beside it (a phone, a narrow window): the
 *    original is on the left and what the document says on the right when the page has room for both (the original is never narrower
 *    than 560 px; the box's own width decides, not the window's), and two tabs, 「内容」 and 「原文」, when it has not;
 *  - `pane`, the right-hand side of the knowledge base beside the list of documents. A pane has room for the two columns only on a very
 *    wide screen; otherwise the two views are a switch (「内容」 · 「原文」) over the body, which is a switch of the document and not a
 *    tab list of the page: the page beside it is a master-detail page and has none.
 *
 * The header is one line: the title with what the document is and where it takes effect (「生效于 所有项目」, which is the press that
 * changes it), and what can be done with it — use it in a conversation, download it, and 「⋯」 for reading it again, settling a duplicate,
 * deleting it. The tab and the page of the original are in the address, as are the list's own parameters, so the way back (「知识库」) is
 * the list as it was left.
 *
 * A document that is not there, or is not this account's, is one sentence — the same one for both, so the page does not say which — and
 * the way back.
 */
export function SourceReader({ sourceId, listState, mode, backLabel, refresh = 0, onApplied, onRemoved }: {
  sourceId: string;
  /** The list the document was opened from: its way back, and what the document's own links carry on. */
  listState: KnowledgeListState;
  mode: "page" | "pane";
  /** The word of the way back above a pane's title, for a compiled page, whose list is not beside it (「知识页」, 「图谱」). */
  backLabel?: string;
  /** Counts up when something the page changed about the document (where it takes effect) should be read again. */
  refresh?: number;
  /** Where the document takes effect was changed here: the list beside the pane says the same at once. */
  onApplied?: (change: { sourceId: string; libraryProjects: "all" | string[]; appliesTo: "all" | string[] }) => void;
  /** The document was deleted here: the list beside the pane drops its row and reads itself again. */
  onRemoved?: (sourceId: string) => void;
}) {
  useProjectStore((state) => state.currentId);

  const navigate = useNavigate();
  const select = useProjectStore((state) => state.select);
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => readReaderView(params), [params]);
  const back = listPath(listState);
  const groups = useProjectGroups();
  const [conversation, setConversation] = useState<{ draft: string; excerpt?: ConversationExcerpt } | null>(null);
  const [applying, setApplying] = useState(false);

  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  // A knowledge page's cited documents, once the page is read: they go into a conversation with it.
  const [knowledgePage, setKnowledgePage] = useState<KnowledgePage | null>(null);
  const { rootRef, bodyRef, box } = useReaderBox();
  const twoColumns = fitsTwoColumns(box.width);

  const source = loaded.phase === "ready" ? loaded.source : null;
  const generation = useRef(0);
  const load = useCallback(async (background: boolean) => {
    const current = ++generation.current;
    if (!background) setLoaded({ phase: "loading" });
    try {
      const value = await getSource(sourceId);
      if (generation.current === current) setLoaded({ phase: "ready", source: value });
    } catch (failure) {
      if (generation.current !== current) return;
      // One answer for a document that is gone and one that was never this account's.
      if (failure instanceof WebApiError && failure.status === 404) setLoaded({ phase: "missing" });
      else if (!background) setLoaded({ phase: "error", message: `无法打开这份资料：${productErrorMessage(failure)}` });
    }
  }, [sourceId]);
  useEffect(() => {
    void load(false);
    return () => { generation.current += 1; };
  }, [load]);
  const seen = useRef(refresh);
  useEffect(() => {
    if (seen.current === refresh) return;
    seen.current = refresh;
    void load(true);
  }, [refresh, load]);

  // Polled while it is still being read: the text and the key points appear without a reload.
  // Compiled pages are already readable from their mirror. Ingestion status belongs to
  // raw sources; polling a superseded page ID would unmount an unsaved page editor.
  const reading = source ? !isKnowledgePage(source) && isReading(source) : false;
  useEffect(() => {
    if (!reading) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { void load(true).then(schedule); }, READING_POLL_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [reading, load]);

  // The suspected duplicates of the project the document is in; the menu offers them only when this document is in one. They are a
  // project's — the list of every document has none — so the document's page is where they are settled.
  const projectId = source?.projectId ?? null;
  const loadDuplicates = useCallback(async () => {
    if (!projectId) return;
    try { setDuplicates((await listDuplicateCandidates(projectId)).items); }
    catch { setDuplicates([]); }
  }, [projectId]);
  useEffect(() => { void loadDuplicates(); }, [loadDuplicates]);
  const group = source ? duplicates.find((candidate) => !candidate.decision && candidate.sourceIds.includes(source.id)) ?? null : null;

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await load(true); }
    catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  const readAgain = () => source && void mutate(async () => {
    // A saved page is read again from its address; anything else from the copy the platform holds.
    if (source.display.origin === "link") {
      const result = await refetchSource(source.id);
      toast.success(result.changed ? "页面有更新，正在重新读取" : "页面没有变化");
    } else await retrySource(source.id, source.revision);
  });
  const decide = async (candidate: DuplicateGroup, decision: "linked" | "dismissed") => {
    if (!source) return;
    setBusy(true);
    try { await decideDuplicateGroup({ projectId: source.projectId, groupKey: candidate.groupKey, sourceIds: candidate.sourceIds, decision }); await loadDuplicates(); }
    catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!source) return;
    setBusy(true);
    try {
      await removeSource(source.id, source.revision);
      setDeleting(false);
      onRemoved?.(source.id);
      navigate(back, { replace: true, state: { kbRestore: true } });
    } catch (failure) { toast.error(productErrorMessage(failure)); setDeleting(false); }
    finally { setBusy(false); }
  };

  // 「在对话中使用」: the project whose conversation reads the document — the one project it takes effect in, with no question asked; when it
  // takes effect in several (or in all of them) the person says which. The sidebar's project is never switched behind their back. The
  // question is left in the composer unsent, naming the document by its title and its file.
  const openConversation = (projectOf: string, draft: string, excerpt?: ConversationExcerpt) => {
    if (!source) return;
    const page = isKnowledgePage(source) ? knowledgePage : null;
    void select(projectOf, () => {
      navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: {
        ...newRuntimeUiIntent(excerpt
          ? `请结合“${source.display.title}”第 ${source.revision} 版${excerpt.page ? `，第 ${excerpt.page} 页` : ""}的这段原文继续讨论（字符 ${excerpt.start}–${excerpt.end}）：\n\n${excerpt.text}`
          : page ? knowledgeConversationDraft(source.display.title) : draft),
        references: conversationReferences({ id: source.id, title: source.display.title }, page?.sources ?? []),
      } } });
    }).catch((failure) => toast.error(webErrorMessage(failure)));
  };
  const prepareConversation = (excerpt?: ConversationExcerpt) => {
    if (!source) return;
    const draft = excerpt ? `请结合“${source.display.title}”的这段原文继续讨论：\n\n${excerpt.text}` : conversationDraft(source);
    const candidates = conversationProjects([source], groups);
    if (candidates.length === 0) { toast.error("这份资料还没有用于任何项目：先在“生效项目”里选择。"); return; }
    if (candidates.length > 1) { setConversation({ draft, excerpt }); return; }
    openConversation(candidates[0].id, draft, excerpt);
  };

  const path = source ? originalPathOf(source) : null;
  const filename = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const download = async () => {
    if (!source || !path) return;
    try { if (source.personal) downloadSourceFile(source.id, filename); else await downloadArtifact(path, "base", filename, source.projectId); }
    catch (failure) { toast.error(`无法下载 ${filename}：${parseFailureMessage(failure, "该文件")}`); }
  };

  const setView = (change: { tab?: ReaderTab; page?: number }) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (change.tab) next.set("tab", change.tab);
    if (change.page) next.set("page", String(change.page));
    return next;
  }, { replace: true });
  // A page of the original: both columns are on screen, or the original's tab is brought up.
  const showPage = (page: number) => setView(twoColumns ? { page } : { page, tab: "original" });
  const versionPath = useCallback((id: string) => readerPath(id, listState), [listState]);
  // A note's next version is a new document: the page follows it.
  const noteSaved = (saved: SourceRecord) => {
    if (saved.id !== sourceId) navigate(readerPath(saved.id, listState, view), { replace: true });
    else void load(true);
  };

  const title = source?.display.title ?? "资料";
  const tab: ReaderTab = view.tab ?? (source && isEditableNote(source) ? "original" : "content");
  const menu = source ? sourceMenuItems(source, {
    duplicate: group !== null, busy, onRetry: readAgain, onDuplicates: () => setDuplicatesOpen(true), onDelete: () => setDeleting(true),
  }).filter((item) => source.payload.publication?.current !== false || item === "separator" || !("label" in item) || item.label !== "重新读取") : [];

  const start = Number(params.get("start")), end = Number(params.get("end")), sha = params.get("sha") ?? "";
  const span = params.has("start") && Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(end)
    && end > start && end - start <= 2000 && /^[a-f0-9]{64}$/.test(sha) ? { start, end, sha } : undefined;
  const original = source && (span ? <SourceQuotation source={source} page={view.page ?? undefined} span={span} onNoteSaved={noteSaved} onUseExcerpt={prepareConversation} />
    : <SourceOriginal source={source} page={view.page ?? undefined} onNoteSaved={noteSaved} />);
  const points = source && (
    <div className="space-y-6">
      <SourceKeyPoints source={source} busy={busy} versionPath={versionPath} onShowPage={showPage} onRetry={readAgain} />
      <SourceDependents source={source} />
    </div>
  );
  const applies = source && !isKnowledgePage(source) && appliesView(source, groups.labels) !== null;
  const meta = source && (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1">
      <span>{readerMeta(source)}</span>
      {applies && <><span aria-hidden="true">·</span><AppliesTo source={source} labels={groups.labels} disabled={busy} onOpen={() => setApplying(true)} /></>}
    </span>
  );
  const asPage = mode === "page";
  // The pane's own buttons; the page's header takes the same three as an action plan.
  const actions = source && (
    <>
      <Button variant="secondary" disabled={!isUsable(source)} onClick={() => prepareConversation()}>
        <MessageSquare size={16} aria-hidden="true" />在对话中使用
      </Button>
      <Button variant="text" disabled={!path || source.payload.status === "missing"} onClick={() => void download()}>下载</Button>
      <Menu label={`“${source.display.title}”的操作`} items={menu} />
    </>
  );

  // What is read: the three states a document can be in before it is on the page, and the document in its layout.
  const content = (
    <>
      {loaded.phase === "loading" && (
        <div role="status" aria-label="正在打开资料" className="animate-pulse space-y-3">
          <div className="h-4 w-1/3 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /><div className="h-4 w-2/3 rounded bg-surface-2" />
        </div>
      )}
      {loaded.phase === "missing" && (
        <EmptyState icon={FileQuestion} title="这份资料不存在或已删除。"
          action={view.knowledge ? <Link to={`/app/files/open?${new URLSearchParams({ project: view.knowledge.projectId, tree: view.knowledge.tree, path: view.knowledge.path })}`}
            className={buttonClasses({ variant: "secondary" })}>打开当前知识页</Link>
            : <Link to={back} className={buttonClasses({ variant: "secondary" })}>回到知识库</Link>} />
      )}
      {loaded.phase === "error" && <LoadError message={loaded.message} onRetry={() => void load(false)} />}
      {source && isKnowledgePage(source) && <KnowledgePageView source={source} onPage={setKnowledgePage} />}
      {source && !isKnowledgePage(source) && twoColumns && (
        <div className="flex h-full min-h-0" style={{ gap: COLUMN_GAP }}>
          <section aria-label="原文" data-reader-column="original" className="min-w-0 flex-1 overflow-hidden rounded-card border border-border bg-surface">{original}</section>
          <section aria-label="要点" data-reader-column="points" style={{ width: POINTS_WIDTH }} className="shrink-0 overflow-y-auto pr-1">{points}</section>
        </div>
      )}
      {source && !isKnowledgePage(source) && !twoColumns && (
        <div data-reader-column={tab === "content" ? "points" : "original"}
          className={tab === "original" ? "h-full min-h-0 overflow-hidden rounded-card border border-border bg-surface" : "h-full min-h-0 overflow-y-auto"}>
          {tab === "content" ? points : original}
        </div>
      )}
    </>
  );
  // The columns' own box: the height the window leaves under the header, so each column scrolls by itself. A pane's switch of the
  // document's two views stands above it, inside the box, so the box's height is the one thing the layout is measured by.
  const paneSwitch = !asPage && source && !isKnowledgePage(source) && !twoColumns;
  const body = (
    <div ref={bodyRef} data-reader-layout={source ? (twoColumns ? "columns" : "tabs") : undefined}
      style={{ height: box.height ?? MIN_PANE_HEIGHT }} className={paneSwitch ? "flex min-h-0 flex-col gap-3" : "min-h-0"}>
      {paneSwitch && (
        <SegmentedControl size="sm" aria-label="资料视图" value={tab} onChange={(next: ReaderTab) => setView({ tab: next })} className="self-start"
          options={[{ value: "content", label: "内容" }, { value: "original", label: "原文" }]} />
      )}
      {paneSwitch ? <div className="min-h-0 flex-1">{content}</div> : content}
    </div>
  );

  const dialogs = (
    <>
      {source && conversation && (
        <ConversationProjectDialog options={conversationProjects([source], groups)} onClose={() => setConversation(null)}
          onChoose={(chosen) => { const pending = conversation; setConversation(null); openConversation(chosen, pending.draft, pending.excerpt); }} />
      )}
      {source && applying && (
        <AppliesToDialog source={source} projects={groups.own} labels={groups.labels} onClose={() => setApplying(false)}
          onSaved={(change) => { setApplying(false); toast.success("已更新生效项目"); void load(true); onApplied?.(change); }} />
      )}
      {source && duplicatesOpen && (
        <Drawer title="疑似重复" onClose={() => setDuplicatesOpen(false)}>
          <DuplicateGroups groups={group ? [group] : []} busy={busy} onDecide={decide} />
        </Drawer>
      )}
      {source && deleting && (
        <ConfirmDialog title="删除这份资料？" body="删除后不再用于回答。" confirmLabel="删除"
          onCancel={() => setDeleting(false)} onConfirm={() => void remove()} />
      )}
    </>
  );

  if (!asPage) {
    return (
      <div ref={rootRef} data-source-reader="pane" className="h-full min-h-0">
        <div className="h-full min-h-0 overflow-y-auto">
          <div className="px-6 py-6">
            {backLabel && source && isKnowledgePage(source) && <PaneBack to={back} label={backLabel} />}
            <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1 basis-48">
                <h2 className="line-clamp-2 text-section font-semibold text-text">{title}</h2>
                {meta && <div className="mt-1 text-caption text-text-3">{meta}</div>}
              </div>
              {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
            </header>
            {body}
          </div>
        </div>
        {dialogs}
      </div>
    );
  }
  return (
    <div ref={rootRef} data-source-reader="page" className="h-full">
      <PageShell
        title={title}
        width="full"
        back={<Back to={back} />}
        // Where the original would be too narrow for two columns, the two views are the page's own tabs, in the band: the body below is their panel.
        tabs={source && !isKnowledgePage(source) && !twoColumns ? {
          label: "资料视图", panelId: "source-reader-panel", value: tab, onChange: (next: ReaderTab) => setView({ tab: next }),
          items: [{ value: "content", label: "内容" }, { value: "original", label: "原文" }],
        } : undefined}
        meta={meta}
        actionPlan={source ? {
          primary: { id: "conversation", label: "在对话中使用", icon: MessageSquare, disabled: !isUsable(source), onSelect: () => prepareConversation() },
          secondary: [{ id: "download", label: "下载", disabled: !path || source.payload.status === "missing", onSelect: () => void download() }],
          overflowLabel: `“${source.display.title}”的操作`, overflow: menu,
        } : undefined}
      >
        {body}
      </PageShell>
      {dialogs}
    </div>
  );
}

/** 「‹ 知识库」: the way back is the list the document was opened from, as it was left. */
function Back({ to }: { to: string }) {
  return (
    <nav aria-label="返回" className="flex min-w-0 items-center">
      <Link to={to} state={{ kbRestore: true }} className={buttonClasses({ variant: "text", size: "sm", className: "-ml-2 gap-1 px-2 text-text-3 hover:text-text" })}>
        <ChevronLeft size={16} aria-hidden="true" />知识库
      </Link>
    </nav>
  );
}

/** 「‹ 知识页」: above a pane's title, the way back to what the pane showed before the document (the project's pages or graph). */
function PaneBack({ to, label }: { to: string; label: string }) {
  return (
    <nav aria-label="返回" className="-mt-2 mb-2 flex min-w-0 items-center">
      <Link to={to} state={{ kbRestore: true }} className={buttonClasses({ variant: "text", size: "sm", className: "-ml-2 gap-1 px-2 text-text-3 hover:text-text" })}>
        <ChevronLeft size={16} aria-hidden="true" />{label}
      </Link>
    </nav>
  );
}
