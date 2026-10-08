import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronLeft, FileQuestion, MessageSquare } from "lucide-react";
import { getWebProjectId, WebApiError, webErrorMessage } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import { parseFailureMessage } from "@/lib/errorText";
import { listPath, readListState, readReaderView, readerPath, SHARED_SCOPE, type ReaderTab } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import {
  addToLibrary, decideDuplicateGroup, getSource, listDuplicateCandidates, refetchSource, removeFromLibrary, removeSource, retrySource,
  type DuplicateGroup, type SourceRecord,
} from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { DuplicateGroups } from "@/components/sources/DuplicateGroups";
import { SourceKeyPoints } from "@/components/sources/SourceKeyPoints";
import { SourceOriginal } from "@/components/sources/SourceOriginal";
import { sourceMenuItems } from "@/components/sources/SourceRow";
import { conversationDraft, isEditableNote, isReading, isUsable, originalPathOf, readerMeta } from "@/components/sources/sourceView";
import { COLUMN_GAP, fitsTwoColumns, MIN_PANE_HEIGHT, POINTS_WIDTH, useReaderBox } from "@/components/sources/useReaderBox";

/** A reading document is asked again this often, so the page shows its text and key points as soon as they are in. */
const READING_POLL_MS = 5000;

type Loaded =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "error"; message: string }
  | { phase: "ready"; source: SourceRecord };

/**
 * One document of the knowledge base, on a page of its own (`/app/files/:sourceId`, design reference §13.1, E-19): a
 * document is read, not glanced at, and a long one does not belong in a drawer. The original is on the left and what the
 * document says on the right — `SourceOriginal` and `SourceKeyPoints` — when the page has room for both (the original is
 * never narrower than 560 px; the page's own width decides, not the window's), and two tabs, 「内容」 and 「原文」, when it
 * has not.
 *
 * The header is one line: the way back, the title with what the document is, and what can be done with it — use it in a
 * conversation, download it, and 「⋯」 for reading it again, sharing it, settling a duplicate, deleting it (the row's own
 * four, from `sourceMenuItems`). The tab and the page of the original are in the address, as are the list's scope, type
 * and search, so the way back (「知识库」) is the list as it was left.
 *
 * A document that is not there, or is not this account's, is one sentence — the same one for both, so the page does not
 * say which — and the way back.
 */
export function SourceReaderPage() {
  const { sourceId = "" } = useParams();
  // Another document (an earlier version, a note's next one) is another page, not the same one with new data.
  return <SourceReader key={sourceId} sourceId={sourceId} />;
}

function SourceReader({ sourceId }: { sourceId: string }) {
  useProjectStore((state) => state.currentId);
  const currentProjectId = getWebProjectId();
  const navigate = useNavigate();
  const select = useProjectStore((state) => state.select);
  const [params, setParams] = useSearchParams();
  const listState = useMemo(() => readListState(params), [params]);
  const view = useMemo(() => readReaderView(params), [params]);
  const back = listPath(listState);

  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
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

  // Polled while it is still being read: the text and the key points appear without a reload.
  const reading = source ? isReading(source) : false;
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

  // The suspected duplicates of the project the document is in; the menu offers them only when this document is in one.
  const projectId = source?.projectId ?? null;
  const loadGroups = useCallback(async () => {
    if (!projectId) return;
    try { setGroups((await listDuplicateCandidates(projectId)).items); }
    catch { setGroups([]); }
  }, [projectId]);
  useEffect(() => { void loadGroups(); }, [loadGroups]);
  const group = source ? groups.find((candidate) => !candidate.decision && candidate.sourceIds.includes(source.id)) ?? null : null;

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
  const toggleShared = () => source && void mutate(async () => {
    if (source.display.shared) await removeFromLibrary(source.id);
    else await addToLibrary(source.id);
  });
  const decide = async (candidate: DuplicateGroup, decision: "linked" | "dismissed") => {
    if (!source) return;
    setBusy(true);
    try { await decideDuplicateGroup({ projectId: source.projectId, groupKey: candidate.groupKey, sourceIds: candidate.sourceIds, decision }); await loadGroups(); }
    catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!source) return;
    setBusy(true);
    try {
      await removeSource(source.id, source.revision);
      setDeleting(false);
      navigate(back, { replace: true, state: { kbRestore: true } });
    } catch (failure) { toast.error(productErrorMessage(failure)); setDeleting(false); }
    finally { setBusy(false); }
  };

  // 「在对话中使用」: the document's own project when it is a project's (the conversation reads that project's knowledge
  // base), else the project the tab is in (a shared document is readable from every project). The question is left in
  // the composer unsent, naming the document by its title and its file.
  const useInConversation = () => {
    if (!source) return;
    const target = listState.scope === SHARED_SCOPE ? currentProjectId : source.projectId;
    void select(target, () => {
      navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: newRuntimeUiIntent(conversationDraft(source)) } });
    }).catch((failure) => toast.error(webErrorMessage(failure)));
  };

  const path = source ? originalPathOf(source) : null;
  const filename = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const download = async () => {
    if (!source || !path) return;
    try { await downloadArtifact(path, "base", filename, source.projectId); }
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
    duplicate: group !== null, busy, onRetry: readAgain, onShare: toggleShared, onDuplicates: () => setDuplicatesOpen(true), onDelete: () => setDeleting(true),
  }) : [];

  const original = source && <SourceOriginal source={source} page={view.page ?? undefined} onNoteSaved={noteSaved} />;
  const points = source && <SourceKeyPoints source={source} busy={busy} versionPath={versionPath} onShowPage={showPage} onRetry={readAgain} />;
  return (
    <div ref={rootRef} className="h-full">
      <PageShell
        title={title}
        width="full"
        back={<Back to={back} />}
        meta={source ? readerMeta(source) : undefined}
        actions={source && (
          <>
            <Button disabled={!isUsable(source)} onClick={useInConversation}>
              <MessageSquare size={16} aria-hidden="true" />在对话中使用
            </Button>
            <Button variant="secondary" disabled={!path || source.payload.status === "missing"} onClick={() => void download()}>下载</Button>
            <Menu label={`“${source.display.title}”的操作`} items={menu} />
          </>
        )}
      >
        {/* The columns' own box: the height the window leaves under the header, so each column scrolls by itself. */}
        <div ref={bodyRef} data-reader-layout={source ? (twoColumns ? "columns" : "tabs") : undefined}
          style={{ height: box.height ?? MIN_PANE_HEIGHT }} className="min-h-0">
          {loaded.phase === "loading" && (
            <div role="status" aria-label="正在打开资料" className="animate-pulse space-y-3">
              <div className="h-4 w-1/3 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /><div className="h-4 w-2/3 rounded bg-surface-2" />
            </div>
          )}
          {loaded.phase === "missing" && (
            <EmptyState icon={FileQuestion} title="这份资料不存在或已删除。"
              action={<Link to={back} className={buttonClasses({ variant: "secondary" })}>回到知识库</Link>} />
          )}
          {loaded.phase === "error" && <LoadError message={loaded.message} onRetry={() => void load(false)} />}
          {source && twoColumns && (
            <div className="flex h-full min-h-0" style={{ gap: COLUMN_GAP }}>
              <section aria-label="原文" data-reader-column="original" className="min-w-0 flex-1 overflow-hidden rounded-card border border-border bg-surface">{original}</section>
              <section aria-label="要点" data-reader-column="points" style={{ width: POINTS_WIDTH }} className="shrink-0 overflow-y-auto pr-1">{points}</section>
            </div>
          )}
          {source && !twoColumns && (
            <div className="flex h-full min-h-0 flex-col">
              <Tabs label="资料视图" panelId="source-reader-panel" value={tab} onChange={(next) => setView({ tab: next })}
                items={[{ value: "content", label: "内容" }, { value: "original", label: "原文" }]} />
              <div id="source-reader-panel" role="tabpanel" aria-labelledby={`source-reader-panel-tab-${tab}`}
                data-reader-column={tab === "content" ? "points" : "original"}
                className={tab === "original" ? "mt-4 min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-surface" : "min-h-0 flex-1 overflow-y-auto pt-4"}>
                {tab === "content" ? points : original}
              </div>
            </div>
          )}
        </div>
      </PageShell>
      {source && duplicatesOpen && (
        <Drawer title="疑似重复" onClose={() => setDuplicatesOpen(false)}>
          <DuplicateGroups groups={group ? [group] : []} busy={busy} onDecide={decide} />
        </Drawer>
      )}
      {source && deleting && (
        <ConfirmDialog title="删除这份资料？" body="删除后不再用于回答。" confirmLabel="删除"
          onCancel={() => setDeleting(false)} onConfirm={() => void remove()} />
      )}
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
