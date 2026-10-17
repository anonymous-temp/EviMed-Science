import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router";
import { Cloud, Download, FileUp, Folder, Globe, Plus, RefreshCw, Search, StickyNote, Upload } from "lucide-react";
import { SOURCE_KINDS } from "@evimed/domain";
import { fetchWebMe, getWebProjectId, hasWebApi, webErrorMessage } from "@/lib/apiClient";
import { downloadKnowledgeVault, getSourceComposition, listProjectOutputs, vaultErrorMessage, type LibraryComposition as Composition, type ProjectOutput } from "@/lib/knowledgeBaseClient";
import { projectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { addToLibrary, decideDuplicateGroup, knowledgePagesOffered, listDuplicateCandidates, listSources, openListOffered, refetchSource, removeFromLibrary,
  removeSource, requestKnowledgeCompile, retrySource, type DuplicateGroup, type SourceCounts, type SourceKind, type SourcePassage, type SourceRecord, type SourceScope } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { legacySourceParam, listParams, readListState, readerPath, recallListPosition, rememberListPosition, scopeOf, scopeParam, type KnowledgeListState, type ListPosition } from "@/lib/knowledgeNav";
import { useFileDrop } from "@/lib/useFileDrop";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { ShowMore } from "@/components/ui/ShowMore";
import { StepState } from "@/components/ui/StepState";
import type { ToolbarFilter, ToolbarProps } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { AddLinkDialog, NewNoteDialog } from "@/components/sources/AddEntryDialogs";
import { DriveImportDrawerBody } from "@/components/sources/DriveImport";
import { DuplicateGroups } from "@/components/sources/DuplicateGroups";
import { KnowledgeGraphView } from "@/components/sources/KnowledgeGraphView";
import { useKnowledgeScope } from "@/components/sources/KnowledgeScopeMenu";
import { KnowledgeStatusDot } from "@/components/sources/KnowledgeStatusDot";
import { KnowledgeTree, KnowledgeTreeMissing } from "@/components/sources/KnowledgeTree";
import { LibraryComposition } from "@/components/sources/LibraryComposition";
import { ProjectOutputsList } from "@/components/sources/ProjectOutputsList";
import { SourceRow } from "@/components/sources/SourceRow";
import { groupRows, statusLine } from "@/components/sources/knowledgeView";
import { isKnowledgePage, isReading, isUsable } from "@/components/sources/sourceView";
import { roundKey, useKnowledgeStatus, useKnowledgeTree } from "@/components/sources/useKnowledge";

/** The folder an upload lands in, under the project's base folder. */
const KNOWLEDGE_ROOT = "knowledge-base";
/** How long the search waits for the researcher to stop typing before it asks the server. */
const SEARCH_DEBOUNCE_MS = 250;
/** The first page and the polling refresh ask for at least this many documents. */
const PAGE_SIZE = 50;

/** A value that follows `value` once it has held still for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** How many pages one load follows to find enough documents once the compiled files are left out of the list (50 documents a page). */
const MAX_FOLLOWED_PAGES = 10;

/** The three views of the knowledge base: what was put in, what the platform made of it, and the picture of that. */
type KnowledgeTab = "sources" | "pages" | "graph";

/** The tab an address is at: `view=graph` is 图谱, the 知识页 type is 知识页, anything else is the documents. */
function tabOf(state: KnowledgeListState): KnowledgeTab {
  if (state.view === "graph") return "graph";
  return state.kind === "wiki" ? "pages" : "sources";
}

/**
 * 知识库: the documents a researcher hands EviMed to read — papers and guidelines, protocols, tables, a hospital's
 * rules, a web page, a note — which a conversation reads and cites. One list, in a scope: a project's, or the
 * documents made available to every project.
 *
 * The page is one frame (R19, plan §5.5, audit D C1c): the title with its scope (`ScopeMenu`) and, only while something needs
 * attention, one status dot; the primary action, 「添加」, which holds the four ways in; three tabs — 资料 · 知识页 · 图谱 — and
 * under them **one** toolbar row, which is the only row of controls before the content. Four rows used to stand there (the type
 * chips, a status line, the 页面 / 图谱 tabs, the graph's own chips). The row holds what the tab is filtered by — the type of a
 * document, the kind of graph — then the search and a count; with documents selected it is replaced by 「已选 N 份 · 在对话中使用 ·
 * 取消」, and the bar that used to stand at the bottom of the page is gone.
 *
 * 资料 is what the researcher put in — the documents a conversation reads: a row says what the document is called, one line of what
 * it says and where it came from, and is a link to the document's own page (`/app/files/:sourceId`), where its original and what it
 * says are side by side. The files the platform compiled out of them are not documents and are the 知识页 tab's, as a tree by type,
 * and the 图谱 tab's, as a picture of the pages and of the entities. The scope, the tab, the type and the search are in the address,
 * so a reload, the back button and a link all land on the page as it was, and coming back from a document puts the list back where
 * it was left. A page is fifty documents; the rest load as the list is scrolled, and the search runs where the documents are, so
 * the fifty-first is as findable as the first.
 *
 * A row says a state only while the document cannot be used yet (「正在读取」, a few seconds) or when it could not be
 * read (「没能读取 · 重试」). Reading state is not a filter: nobody comes to the knowledge base to look for documents
 * by the pipeline's progress.
 */
export function SourcesPage() {
  // Store fallback repairs do not reload the document. Subscribe to those repairs, while the tab's current selection
  // still owns in-flight requests.
  useProjectStore((state) => state.currentId);
  const projectId = getWebProjectId();
  const [params] = useSearchParams();
  // A document is opened at its own address. `?source=<id>` is not one of the list's parameters, but it names a
  // document, so it lands on that document's page (the drawer it used to open had no address at all).
  const legacy = legacySourceParam(params);
  if (legacy) return <Navigate to={readerPath(legacy, readListState(params))} replace />;
  return <KnowledgeBase key={projectId} currentProjectId={projectId} />;
}

function KnowledgeBase({ currentProjectId }: { currentProjectId: string }) {
  const navigate = useNavigate();
  const selectProject = useProjectStore((state) => state.select);
  const location = useLocation();
  const navigationType = useNavigationType();
  const projects = useProjectStore((state) => state.projects);
  // The scope, the type and the search live in the address (E-8): a reload, the back button and a link all land on the
  // list as it was, and a document opened from it comes back to it.
  const [params, setParams] = useSearchParams();
  const listState = useMemo(() => readListState(params), [params]);
  const scope = useMemo(() => scopeOf(listState, currentProjectId), [listState, currentProjectId]);
  const kind = listState.kind;
  // The compiled files are a project's; the shared documents are one list, whatever the address says of a tab.
  const tab = scope.kind === "shared" ? "sources" : tabOf(listState);
  const update = useCallback((patch: Partial<KnowledgeListState>) => {
    setParams((current) => {
      const next = { ...readListState(current), ...patch };
      return listParams(next);
    }, { replace: true });
  }, [setParams]);
  // A project's types and files are its own: the documents' type is let go when the scope changes, the pages' tab is kept (the
  // pages of the other project are what the researcher came to see), and a focus on a mark of the old project's graph is dropped.
  const setScope = (next: SourceScope) => update({ scope: scopeParam(next, currentProjectId), ...(tab === "sources" || next.kind === "shared" ? { kind: null, view: null } : {}), focus: null, depth: null });
  const scopeMenu = useKnowledgeScope(scope, setScope);
  // What is typed is the box's own until the researcher stops; the address follows, and an address changed from outside
  // (the back button between two lists) moves the box.
  const [query, setQuery] = useState(listState.q);
  const settled = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const written = useRef(listState.q);
  useEffect(() => {
    if (settled === written.current) return;
    written.current = settled;
    update({ q: settled });
  }, [settled, update]);
  useEffect(() => {
    if (listState.q === written.current) return;
    written.current = listState.q;
    setQuery(listState.q);
  }, [listState.q]);
  const search = listState.q;
  const [items, setItems] = useState<SourceRecord[] | null>(null);
  const [selected, setSelected] = useState<Map<string, SourceRecord>>(() => new Map());
  const [counts, setCounts] = useState<SourceCounts | null>(null);
  // Where the search matched inside documents' text, by document: what the server answers with a page of the list while
  // something is searched for, shown under each row.
  const [passages, setPassages] = useState<Record<string, SourcePassage[]>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [duplicatesFor, setDuplicatesFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"link" | "note" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 从网盘导入 is offered only when there is a drive to open: OpenList configured and a storage mounted under its tenant
  // root (`/api/me` `features.openList`). An entry that led to a drive with nothing in it answered every browse with an
  // error (audit I3-4). Off until `/api/me` says so, and when it cannot.
  const [driveOffered, setDriveOffered] = useState(false);
  // Where the project's pages stand, and 「重新整理」, only where the deployment compiles them (`features.knowledgePages`).
  const [pagesOffered, setPagesOffered] = useState(false);
  const [compileAsking, setCompileAsking] = useState(false);
  useEffect(() => {
    let active = true;
    fetchWebMe().then((me) => { if (active) { setDriveOffered(openListOffered(me)); setPagesOffered(knowledgePagesOffered(me)); } }).catch(() => { /* not offered */ });
    return () => { active = false; };
  }, []);

  // A scope whose project is gone (deleted elsewhere) falls back to the project the tab is in.
  useEffect(() => {
    if (scope.kind === "project" && projects.length > 0 && !projects.some((project) => project.id === scope.projectId)) {
      update({ scope: null });
    }
  }, [projects, scope, update]);

  const shared = scope.kind === "shared";
  const scopeProjectId = scope.kind === "project" ? scope.projectId : null;
  const { status: knowledge, setStatus: setKnowledge } = useKnowledgeStatus(scopeProjectId, pagesOffered && scopeProjectId !== null);
  const knowledgeRound = roundKey(knowledge);
  const compileNow = async () => {
    if (!scopeProjectId) return;
    setCompileAsking(true);
    try { setKnowledge(await requestKnowledgeCompile(scopeProjectId)); toast.success("已开始重新整理，稍后回来即可看到"); }
    catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setCompileAsking(false); }
  };
  useEffect(() => setSelected(new Map()), [shared, scopeProjectId]);
  // 「对话产出」: the files the listed project's conversations delivered, read once for the project — the row of filters needs to
  // know whether there are any — and again on 重试. An index of the run ledger; nothing in it is a document of the library.
  const [outputs, setOutputs] = useState<ProjectOutput[] | null>(null);
  const [outputsFailed, setOutputsFailed] = useState(false);
  const [outputsAttempt, setOutputsAttempt] = useState(0);
  useEffect(() => {
    setOutputs(null);
    setOutputsFailed(false);
    if (!scopeProjectId) return undefined;
    let active = true;
    listProjectOutputs(scopeProjectId).then(
      (items) => { if (active) setOutputs(items); },
      () => { if (active) { setOutputs([]); setOutputsFailed(true); } },
    );
    return () => { active = false; };
  }, [scopeProjectId, outputsAttempt]);
  const outputsView = listState.view === "outputs" && scopeProjectId !== null;
  // 「资料组成」: what the project's library is made of, counted by the control plane over the whole project and read again when the
  // number of documents moves. An addition to the page: a read that fails leaves the page without it.
  const [composition, setComposition] = useState<Composition | null>(null);
  const documentCount = counts?.all ?? null;
  useEffect(() => {
    setComposition(null);
    if (!scopeProjectId || documentCount === null) return undefined;
    let active = true;
    getSourceComposition(scopeProjectId).then(
      (value) => { if (active) setComposition(value); },
      () => { /* the page stands without it */ },
    );
    return () => { active = false; };
  }, [scopeProjectId, documentCount]);
  // Where a new document goes: the project the page lists, or — in the shared scope, which belongs to no project —
  // the project the tab is in.
  const addProjectId = scopeProjectId ?? currentProjectId;
  const projectNames = useMemo(() => projectLabels(projects), [projects]);

  // The compiled files are the 知识页 tab's: the documents' list leaves them out where there is a tab for them. They are the newest
  // files a compile writes, so a page of the list can be all of them, and the load follows pages until it holds documents.
  const hideCompiled = tab === "sources" && !shared;
  const documentsOf = useCallback((rows: SourceRecord[]) => (hideCompiled ? rows.filter((row) => !isKnowledgePage(row)) : rows), [hideCompiled]);

  const pageRoot = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loaded = useRef(0);
  // Coming back to a list (the back button, or 「知识库」 on a document's page) puts it where it was left: the same
  // documents loaded and the same scroll, once. A visit of its own — the sidebar, a typed address — starts at the top.
  const restore = useRef<ListPosition | null>(
    navigationType === "POP" || (location.state as { kbRestore?: boolean } | null)?.kbRestore === true ? recallListPosition(listState) : null,
  );
  const pendingScroll = useRef<number | null>(null);
  const load = useCallback(async (background = false) => {
    const current = ++generation.current;
    if (!background) { setItems(null); setNextCursor(null); setError(null); }
    const position = background ? null : restore.current;
    try {
      const page = await listSources(scope, { ...(kind ? { kind } : {}), q: search,
        limit: background ? Math.min(100, Math.max(PAGE_SIZE, loaded.current)) : position ? Math.min(100, Math.max(PAGE_SIZE, position.count)) : PAGE_SIZE });
      if (generation.current !== current) return;
      setCounts(page.counts ?? null);
      setError(null);
      setPassages((previous) => (background ? { ...previous, ...(page.passages ?? {}) } : page.passages ?? {}));
      if (!background) {
        // The pages the reader had open are read again until the document they opened is among them, and a page that was mostly the
        // platform's own files is followed until it holds the documents it should (both bounded).
        let loadedItems = documentsOf(page.items);
        let cursor = page.nextCursor;
        const wanted = position ? position.count : PAGE_SIZE;
        const dropped = page.items.length - loadedItems.length;
        for (let more = 0; cursor && (position !== null || dropped > 0) && loadedItems.length < wanted && more < MAX_FOLLOWED_PAGES; more += 1) {
          const next = await listSources(scope, { ...(kind ? { kind } : {}), q: search, cursor, limit: PAGE_SIZE });
          if (generation.current !== current) return;
          const known = new Set(loadedItems.map((item) => item.id));
          loadedItems = [...loadedItems, ...documentsOf(next.items).filter((item) => !known.has(item.id))];
          cursor = next.nextCursor;
          if (next.passages) setPassages((previous) => ({ ...previous, ...next.passages }));
        }
        if (position) { restore.current = null; pendingScroll.current = position.scroll; }
        setItems(loadedItems);
        setNextCursor(cursor);
        return;
      }
      // A refresh of the head of the list: what it holds replaces those rows, and what was loaded beyond it stays.
      setItems((previous) => {
        const fresh = documentsOf(page.items);
        if (!previous || !page.nextCursor) { setNextCursor(page.nextCursor); return fresh; }
        const oldest = page.items.at(-1)?.createdAt ?? "";
        const known = new Set(fresh.map((item) => item.id));
        const tail = previous.filter((item) => !known.has(item.id) && item.createdAt < oldest);
        if (tail.length === 0) setNextCursor(page.nextCursor);
        return [...fresh, ...tail];
      });
    } catch (loadError) {
      if (generation.current === current) {
        if (!background) setItems([]);
        setError(`无法加载资料：${productErrorMessage(loadError)}`);
      }
    }
  }, [scope, kind, search, documentsOf]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  // A round that ends brings pages: the chips' counts and the list are read again, once, when what it left changes.
  const lastRound = useRef(knowledgeRound);
  useEffect(() => {
    if (lastRound.current === knowledgeRound) return;
    const first = lastRound.current === "";
    lastRound.current = knowledgeRound;
    if (!first) void load(true);
  }, [knowledgeRound, load]);
  useEffect(() => { loaded.current = items?.length ?? 0; }, [items]);
  // The place a list is brought back to is set once its rows are on the page: before, there is nothing to scroll.
  useLayoutEffect(() => {
    if (pendingScroll.current === null || items === null) return;
    const top = pendingScroll.current;
    pendingScroll.current = null;
    const scroller = pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto");
    if (scroller) scroller.scrollTop = top;
  }, [items]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      // The next page may be the platform's own files from end to end: pages are followed until a document comes (bounded).
      let cursor: string | null = nextCursor;
      let added: SourceRecord[] = [];
      for (let followed = 0; cursor && added.length === 0 && followed < MAX_FOLLOWED_PAGES; followed += 1) {
        const page = await listSources(scope, { ...(kind ? { kind } : {}), q: search, cursor, limit: PAGE_SIZE });
        if (generation.current !== current) return;
        added = documentsOf(page.items);
        if (page.passages) setPassages((previous) => ({ ...previous, ...page.passages }));
        cursor = page.nextCursor;
      }
      setItems((previous) => {
        const known = new Set((previous ?? []).map((item) => item.id));
        return [...(previous ?? []), ...added.filter((item) => !known.has(item.id))];
      });
      setNextCursor(cursor);
    } catch (loadError) {
      toast.error(`无法加载更多：${productErrorMessage(loadError)}`);
    } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, scope, kind, search, documentsOf]);
  // The list loads the next page as its end comes into view; the 「显示更多」 button is the same thing for a browser
  // that cannot tell, and for a keyboard.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !nextCursor || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loadMore, items]);

  // Polled while a row is still being read: that is the one change a row shows.
  const processing = items?.some(isReading) ?? false;
  useEffect(() => {
    if (!processing || error) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { void load(true); }, 5000);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [items, processing, error, load]);

  // The suspected duplicates of the project the page lists, read once per list and again after a decision: a row in an
  // undecided group wears the tag.
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const loadGroups = useCallback(async () => {
    if (!scopeProjectId) { setGroups([]); return; }
    try { setGroups((await listDuplicateCandidates(scopeProjectId)).items); }
    catch { setGroups([]); }
  }, [scopeProjectId]);
  useEffect(() => { void loadGroups(); }, [loadGroups, items]);
  const groupOf = (sourceId: string) => groups.find((group) => !group.decision && group.sourceIds.includes(sourceId)) ?? null;
  const decide = async (group: DuplicateGroup, decision: "linked" | "dismissed") => {
    if (!scopeProjectId) return;
    setBusy(true);
    try { await decideDuplicateGroup({ projectId: scopeProjectId, groupKey: group.groupKey, sourceIds: group.sourceIds, decision }); await loadGroups(); }
    catch (operationError) { toast.error(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };

  // A failed read, share or delete is said as a notice and the list stays as it was, rather than replacing the list
  // with an error whose 「重试」 would re-list the page.
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      setDeleting(null);
      await load(true);
    } catch (operationError) { toast.error(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };
  const readAgain = (source: SourceRecord) => void mutate(async () => {
    // A saved page is read again from its address; anything else from the copy the platform holds.
    if (source.display.origin === "link") {
      const result = await refetchSource(source.id);
      toast.success(result.changed ? "页面有更新，正在重新读取" : "页面没有变化");
    } else await retrySource(source.id, source.revision);
  });
  const toggleShared = (source: SourceRecord) => void mutate(async () => {
    if (source.display.shared) await removeFromLibrary(source.id);
    else await addToLibrary(source.id);
  });

  /** Something was added: show where it landed. The shared scope holds nothing new, so the page moves to the project. */
  const added = () => {
    if (shared) update({ scope: null, kind: null });
    else void load(true);
  };

  // Upload: the whole page is its drop target. Files go to the project the page lists.
  const uploadFiles = async (dropped?: File[]) => {
    setUploading(true);
    try {
      const { accepted, refused } = partitionKnowledgeBaseFiles(dropped ?? await pickFiles(KNOWLEDGE_BASE_ACCEPT));
      // The formats are said here, to the file that was refused, and nowhere else on the page.
      if (refused.length > 0) {
        toast.error(`没有上传：${refused.map((file) => `${file.name}（${file.reason}）`).join("、")}。${KNOWLEDGE_BASE_UPLOAD_HINT}`);
      }
      const names = accepted.length > 0 ? await uploadFilesToWorkspace(accepted, KNOWLEDGE_ROOT, "base", addProjectId) : [];
      if (names.length > 0) {
        // The row says 「正在读取」 until the document can be used; the toast says only what happened.
        toast.success(`已上传 ${names.length} 个文件`);
        added();
      }
    } catch (failure) {
      toast.error(`无法上传文件：${webErrorMessage(failure)}`);
    } finally {
      setUploading(false);
    }
  };
  const { dragging, dropProps } = useFileDrop({ disabled: !hasWebApi, onDrop: (files) => void uploadFiles(files) });

  const onLinkAdded = () => { setDialog(null); toast.success("已添加，正在读取"); added(); };
  // A note just written opens on its own page, where its editor is; the list it came from is the way back (the shared
  // scope holds nothing new, so a note written from it was filed in the project the tab is in).
  const onNoteAdded = (source: SourceRecord) => {
    setDialog(null);
    navigate(readerPath(source.id, shared ? { scope: null, kind: null, q: "" } : listState));
  };

  // A document's own page, and what the list keeps of its place as the page is followed: how far it was scrolled and
  // how many documents it had loaded, which is what brings the reader back to the same row.
  const readerLink = (source: SourceRecord) => readerPath(source.id, listState);
  const keepPlace = () => {
    const scroller = pageRoot.current?.querySelector<HTMLElement>(".overflow-y-auto");
    rememberListPosition(listState, { scroll: scroller?.scrollTop ?? 0, count: items?.length ?? PAGE_SIZE });
  };
  const toggleSelected = (source: SourceRecord) => {
    if (!isUsable(source)) return;
    setSelected(previous => {
      const next = new Map(previous);
      if (next.has(source.id)) next.delete(source.id);
      else if (next.size < 50) next.set(source.id, source);
      else toast.error("一次最多选择 50 份资料");
      return next;
    });
  };
  const openSelected = async () => {
    const references = [...selected.values()].map(source => ({ id: source.id, title: source.display.title }));
    if (!references.length) return;
    keepPlace();
    try {
      await selectProject(scopeProjectId ?? currentProjectId, () => {
        const intent = { ...newRuntimeUiIntent("请根据所选资料回答我的问题，引用时标出处。\n\n我的问题："), references };
        navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: intent } });
      });
    } catch (failure) { toast.error(webErrorMessage(failure)); }
  };

  // The compiled files: the tree is read for the project once the tabs are there, so 知识页 can say how many pages it holds before it
  // is opened, and the tab's body and the count are one read.
  const pagesTabs = !shared && (pagesOffered || (counts?.wiki ?? 0) > 0 || tab !== "sources");
  const { tree, failed: treeFailed, retry: retryTree } = useKnowledgeTree(scopeProjectId, pagesTabs, knowledgeRound);
  const pageCount = tree ? groupRows(tree.pages).reduce((sum, group) => sum + group.rows.length, 0) : 0;
  const line = pagesOffered ? statusLine(knowledge) : null;

  /** What a document count is in the 资料 tab: the platform's own files are not among them. */
  const documentTotal = (tally: SourceCounts | null): number | null => (tally ? tally.all - (hideCompiled || pagesTabs ? tally.wiki : 0) : null);
  const kindOptions: FilterOption<SourceKind | "all">[] = useMemo(() => {
    if (!counts) return [];
    return [
      { value: "all" as const, label: "全部", count: documentTotal(counts) ?? counts.all },
      ...SOURCE_KINDS.filter((entry) => entry.id !== "wiki" && (counts[entry.id as SourceKind] > 0 || entry.id === kind))
        .map((entry) => ({ value: entry.id as SourceKind, label: entry.label, count: counts[entry.id as SourceKind] })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, kind, pagesTabs, hideCompiled]);
  const kindsPresent = kindOptions.length - 1;
  // 「对话产出」 stands in the row of types, last, where the project's conversations have delivered something (or it is the view).
  const outputsChip = (outputs !== null && outputs.length > 0) || outputsView;
  const chipOptions: FilterOption<SourceKind | "all" | "outputs">[] = useMemo(
    () => [...kindOptions, ...(outputsChip ? [{ value: "outputs" as const, label: "对话产出", ...(outputs ? { count: outputs.length } : {}) }] : [])],
    [kindOptions, outputsChip, outputs]);
  const chooseChip = (value: string) => {
    if (value === "outputs") update({ view: "outputs", kind: null });
    else update({ kind: value === "all" ? null : value as SourceKind, view: null });
  };
  const goTab = (next: KnowledgeTab) => update({
    kind: next === "sources" ? null : "wiki", view: next === "graph" ? "graph" : null, graph: null, focus: null, depth: null,
  });
  const duplicateOpen = duplicatesFor ? groups.filter((group) => !group.decision && group.sourceIds.includes(duplicatesFor)) : [];
  const filtered = kind !== null || search !== "";
  // With nothing in the project's library the empty state offers 「添加」, so the header does not: one solid button on the page. It stays
  // wherever the empty state offers none — a search without a hit, the shared library — and while the list is read or failed.
  const firstRun = tab === "sources" && items !== null && items.length === 0 && !error && !filtered && !shared && !outputsView;

  const rowActions = (source: SourceRecord) => ({
    busy,
    duplicate: groupOf(source.id) !== null,
    onRetry: () => readAgain(source),
    onShare: () => toggleShared(source),
    onDuplicates: () => setDuplicatesFor(source.id),
    onDelete: () => setDeleting(source),
  });

  const addMenu = (label = "添加") => (
    <Menu label="添加" items={[
      { label: "上传文件", icon: FileUp, onSelect: () => void uploadFiles() },
      { label: "添加网页链接", icon: Globe, onSelect: () => setDialog("link") },
      { label: "新建笔记", icon: StickyNote, onSelect: () => setDialog("note") },
      ...(driveOffered ? [{ label: "从网盘导入", icon: Cloud, onSelect: () => setConnecting(true) }] : []),
    ]}>
      <Button disabled={!hasWebApi || uploading} loading={uploading}>{!uploading && <Plus size={16} aria-hidden="true" />}{label}</Button>
    </Menu>
  );

  const selectedHere = tab === "sources" && !outputsView && selected.size > 0;
  // How many documents the list holds in all, for what it is showing: the type's, or every document's (the search is the server's).
  const total = outputsView ? outputs?.length ?? null : kind ? counts?.[kind] ?? null : documentTotal(counts);
  const remaining = total === null || items === null ? 0 : Math.max(0, total - items.length);
  const more = nextCursor && (
    <div ref={sentinel}>
      {loadingMore ? <div className="mt-2 flex justify-center"><Button variant="text" size="sm" loading>正在加载</Button></div>
        : remaining > 0 ? <ShowMore remaining={remaining} unit="份" onMore={() => void loadMore()} />
          : <div className="mt-2 flex justify-center"><Button variant="text" size="sm" onClick={() => void loadMore()}>显示更多</Button></div>}
    </div>
  );
  const documentList = outputsView ? null : items === null ? <FilesSkeleton /> : items.length === 0 ? (error ? null : nextCursor ? more
    : filtered ? <EmptyState icon={Search} title="没有找到相关资料" reason="换个关键词试试，或清空搜索框看全部。" />
      : shared ? <EmptyState icon={Folder} title="还没有资料设为所有项目可用。" description="在项目的资料里，用资料的“⋯”菜单选“设为所有项目可用”。"
        action={<Button variant="secondary" onClick={() => update({ scope: null, kind: null })}>回到项目的资料</Button>} />
        : <EmptyState icon={Folder} title="把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。" action={addMenu()} />
  ) : (
    <div>
      <List label="资料">
        {items.map((source) => (
          <SourceRow key={source.id} source={source} showShared={!shared} {...rowActions(source)}
            projectName={shared ? projectNames.get(source.projectId) ?? null : null}
            to={readerLink(source)} onOpen={keepPlace}
            selected={selected.has(source.id)} onSelect={() => toggleSelected(source)}
            passages={passages[source.id]} query={search}
            passageTo={(passage) => readerPath(source.id, listState, passage.page ? { tab: "original", page: passage.page } : { tab: null, page: null })} />
        ))}
      </List>
      {more}
    </div>
  );

  // 「导出到 Obsidian」: the documents of the project the page lists, as a vault. Beside the one primary button, in a menu of its own.
  const exportVault = async () => {
    if (!scopeProjectId) return;
    setExporting(true);
    try { await downloadKnowledgeVault(scopeProjectId); }
    catch (failure) { toast.error(`没能导出：${vaultErrorMessage(failure)}`); }
    finally { setExporting(false); }
  };

  // What the 知识页 and 图谱 tabs say when there is nothing to show: what the pages are made of, what they will be, and the one thing to do.
  // The documents are the 资料 tab's, so 「你的 N 份资料」 opens them; a round that is running is not an empty page (the strip over the tabs
  // says so), and a project that has enough documents is asked to compile, not to add more.
  const readable = knowledge?.readable ?? documentTotal(counts) ?? 0;
  const missing = knowledge ? Math.max(1, knowledge.minSources - knowledge.readable) : null;
  const recipe = (
    <StepState
      phase="empty" step={line?.canCompile ? "整理知识页" : "添加资料"} noun="知识页"
      uses={[{ label: `你的 ${readable} 份资料`, onOpen: () => goTab("sources") }]}
      gives={`按类整理好的页面，和页面之间的关系图${knowledge?.state === "below_threshold" && missing ? `（再加 ${missing} 份资料就会开始整理）` : ""}`}
      onStart={hasWebApi ? (line?.canCompile ? () => void compileNow() : () => void uploadFiles()) : undefined}
      starting={line?.canCompile ? compileAsking : uploading}
      reason="还不能添加资料。"
    />
  );
  const compiling = line?.busy === true;

  // ------------------------------------------------------------------ the one toolbar row
  const typeFilter: ToolbarFilter[] = kindOptions.length > 0 && (kindsPresent >= 2 || kind !== null || outputsChip)
    ? [{ kind: "chips", label: "资料类型", options: chipOptions, value: outputsView ? "outputs" : kind ?? "all", neutral: "all", maxVisible: chipOptions.length, onChange: chooseChip }]
    : [];
  const graphFilter: ToolbarFilter[] = [{
    kind: "chips", label: "图谱的类型", neutral: "wiki", options: [{ value: "wiki", label: "页面之间" }, { value: "kg", label: "实体和关系" }],
    value: listState.graph === "kg" ? "kg" : "wiki", onChange: (next) => update({ graph: next === "kg" ? "kg" : null, focus: null, depth: null }),
  }];
  const clearSearch = () => setQuery("");
  const searchBox = { label: "搜索资料和内容", value: query, onChange: setQuery, onClear: clearSearch };
  const toolbar: ToolbarProps | undefined = selectedHere ? {
    label: "所选资料",
    summary: `已选 ${selected.size} 份`,
    actions: (
      <>
        <Button size="sm" onClick={() => void openSelected()}>在对话中使用</Button>
        <Button size="sm" variant="text" onClick={() => setSelected(new Map())}>取消</Button>
      </>
    ),
  } : firstRun ? undefined : {
    label: tab === "sources" ? "资料的筛选" : tab === "pages" ? "知识页的搜索" : "图谱的筛选",
    filters: tab === "sources" ? typeFilter : tab === "graph" ? graphFilter : [],
    onClear: tab === "sources" && filtered ? () => { setQuery(""); update({ kind: null, view: null, q: "" }); } : undefined,
    search: searchBox,
    summary: tab === "sources" ? (total === null ? undefined : `${total} 份`) : tab === "pages" ? (pageCount > 0 ? `${pageCount} 页` : undefined) : undefined,
  };

  const pagesBody = !scopeProjectId ? null : treeFailed && !tree ? (
    <>
      <KnowledgeTreeMissing onRetry={retryTree} />
      {documentList}
    </>
  ) : !tree || (compiling && tree.pages.length === 0) ? <FilesSkeleton /> : <KnowledgeTree rows={tree.pages} query={listState.q} listState={listState} empty={recipe} />;

  return (
    <div {...dropProps} ref={pageRoot} className="relative h-full">
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-drawer flex items-center justify-center bg-bg">
          <div className="flex items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface px-6 py-4 text-ui font-medium text-accent">
            <Upload size={16} aria-hidden="true" />
            松开即可上传
          </div>
        </div>
      )}
      <PageShell
        title="知识库"
        scope={scopeMenu}
        meta={pagesOffered && !shared ? <KnowledgeStatusDot status={knowledge} asking={compileAsking} onCompile={() => void compileNow()} /> : undefined}
        actions={<>
          {!firstRun && addMenu()}
          {!shared && !firstRun && (
            <Menu label="更多" items={[
              { label: "在记忆地图中查看", onSelect: () => navigate("/app/memory/map") },
              ...(pagesOffered && line?.canCompile ? [{ label: compileAsking ? "正在重新整理" : "重新整理知识页", icon: RefreshCw, disabled: compileAsking, onSelect: () => void compileNow() }] : []),
              { label: exporting ? "正在导出" : "导出到 Obsidian", icon: Download, disabled: exporting || !hasWebApi, onSelect: () => void exportVault() },
            ]} />
          )}
        </>}
        activity={compiling && !shared && knowledge ? {
          label: "整理知识页", phase: [knowledge.pages > 0 ? `已有 ${knowledge.pages} 页` : "", knowledge.typedPages.kg > 0 ? `${knowledge.typedPages.kg} 个实体` : ""].filter(Boolean).join("，") || undefined,
          startedAt: knowledge.stage?.startedAt ?? null, ...(knowledge.state === "queued" ? { waiting: "资料有更新，稍后会自动开始" } : {}),
        } : undefined}
        tabs={pagesTabs ? {
          label: "知识库", value: tab, onChange: goTab, panelId: "knowledge-panel",
          items: [
            { value: "sources" as const, label: "资料", count: documentTotal(counts) || undefined },
            { value: "pages" as const, label: "知识页", count: pageCount || undefined },
            { value: "graph" as const, label: "图谱" },
          ],
        } : undefined}
        toolbar={toolbar}
      >
        {tab === "sources" && composition && !outputsView && <LibraryComposition composition={composition} />}
        {tab === "sources" && outputsView && <ProjectOutputsList items={outputs} failed={outputsFailed} query={search} onRetry={() => setOutputsAttempt((value) => value + 1)} />}
        {tab === "sources" && !outputsView && error && <LoadError message={error} onRetry={() => void load()} className="mb-4" />}
        {tab === "sources" && documentList}
        {tab === "pages" && pagesBody}
        {tab === "graph" && scopeProjectId && (
          <KnowledgeGraphView projectId={scopeProjectId} kind={listState.graph === "kg" ? "kg" : "wiki"} listState={listState} version={knowledgeRound} onChange={update} empty={recipe} />
        )}
      </PageShell>
      {connecting && driveOffered && (
        <Drawer title="从网盘导入" onClose={() => setConnecting(false)} widthClassName="max-w-2xl">
          <DriveImportDrawerBody projectId={addProjectId} refreshToken={folderRefresh}
            onImported={() => { added(); }} onFolderRegistered={() => setFolderRefresh((value) => value + 1)} />
        </Drawer>
      )}
      {dialog === "link" && <AddLinkDialog projectId={addProjectId} onClose={() => setDialog(null)} onAdded={onLinkAdded} />}
      {dialog === "note" && <NewNoteDialog projectId={addProjectId} onClose={() => setDialog(null)} onAdded={onNoteAdded} />}
      {duplicatesFor && (
        <Drawer title="疑似重复" onClose={() => setDuplicatesFor(null)}>
          <DuplicateGroups groups={duplicateOpen} busy={busy} onDecide={decide} />
        </Drawer>
      )}
      {deleting && <ConfirmDialog title="删除这份资料？" body="删除后不再用于回答。"
        confirmLabel="删除" onCancel={() => setDeleting(null)}
        onConfirm={() => void mutate(async () => { await removeSource(deleting.id, deleting.revision); })} />}
    </div>
  );
}
