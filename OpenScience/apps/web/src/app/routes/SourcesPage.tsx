import { WebApiError } from "@/lib/apiClient";
import { sessionGeneration, StaleSessionError } from "@/lib/sessionLifecycle";
import { Combobox } from "@/components/ui/Combobox";
import { FileDrop, type FileDropItem } from "@/components/ui/FileDrop";
import { FormDialog } from "@/components/ui/FormDialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from "react-router";
import { Cloud, FileUp, Folder, Globe, Plus, Search, StickyNote, Upload } from "lucide-react";
import { SOURCE_KINDS } from "@evimed/domain";
import { getWebProjectId, hasWebApi, webErrorMessage } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { removeSource, refetchSource, retrySource, uploadPersonalFile, type SourceCounts, type SourceKind, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { legacySourceParam, listParams, listPath, readListState, readerPath, recallListPosition, rememberListPosition, stateForView, viewOf, type KnowledgeListState } from "@/lib/knowledgeNav";
import { useFileDrop } from "@/lib/useFileDrop";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { MasterDetail, type MasterDetailState } from "@/components/ui/MasterDetail";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { ShowMore } from "@/components/ui/ShowMore";
import { Toolbar, type ToolbarFilter, type ToolbarProps } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageHeader } from "@/components/layout/PageHeader";
import { AddLinkDialog, NewNoteDialog } from "@/components/sources/AddEntryDialogs";
import { AppliesToDialog, conversationProjects } from "@/components/sources/AppliesTo";
import { ConversationProjectDialog } from "@/components/sources/ConversationProjectDialog";
import { KnowledgeViews, ProjectList } from "@/components/sources/KnowledgeColumn";
import { LibraryDriveImport } from "@/components/sources/LibraryDriveImport";
import { ProjectKnowledge, usePagesOffered } from "@/components/sources/ProjectKnowledge";
import { SourceReader } from "@/components/sources/SourceReader";
import { SourceRow } from "@/components/sources/SourceRow";
import { PERSONAL_DESTINATION, destinationHint, isUsable } from "@/components/sources/sourceView";
import { PAGE_SIZE, useDocumentList } from "@/components/sources/useDocumentList";
import { useDriveEntry } from "@/components/sources/useDriveEntry";
import { useProjectGroups } from "@/components/sources/useProjectGroups";

/** The folder an upload lands in, under a project's base folder. */
const KNOWLEDGE_ROOT = "knowledge-base";
/** How long the search waits for the researcher to stop typing before it asks the server. */
const SEARCH_DEBOUNCE_MS = 250;
/** The list column's width beside the pane, and the least the pane is given: the page splits from their sum of its own width. */
const LIST_WIDTH = 400;
const PANE_MIN = 560;
/** The save-place option that is the account's own storage. */
const PERSONAL = "@personal";

/** A value that follows `value` once it has held still for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * 知识库: the documents a researcher hands EviMed to read — papers and guidelines, protocols, tables, a hospital's rules, a web page, a
 * note — which a conversation reads and cites. A master-detail page (T2): the list on the left, the chosen document read on the right.
 *
 * **Every document once.** The list is the account's documents, one row per file, whatever project holds them; there is no project to
 * choose at the top. Where a document takes effect is the document's own choice — each row says it (「生效于 所有项目」, or the project
 * names) and the words are the press that changes it (`AppliesToDialog`): every project, or the ones ticked, the projects that hold the file
 * staying checked. What the person adds from here (upload, a web link, a note, a drive document) is the account's own, which every project
 * reads, unless they pick a project in the dialog.
 *
 * **Four views**, as links at the head of the column and in the address: 资料 is the list above; 知识页, 图谱 and 对话产出 are a project's —
 * what the platform compiled from its documents, the picture of it, and the files its conversations delivered — and in them the column
 * lists the projects and the pane shows the chosen one (`ProjectKnowledge`). The type, the search and the project are in the address, so a
 * reload, the back button and a link land on the page as it was, and a document is `/app/files/:sourceId` — the same page with that
 * document in the pane.
 *
 * Beside the list the pane shows the document in the address, or the first of the list when none is (not written to the address); with no
 * documents at all the pane is the recipe, and 「添加」 is there and not in the header, so the page has one solid button. Where the page has
 * no room for both (a phone, a narrow window) the list is the page, and a document opens as a page of its own with the way back to the list.
 *
 * A row says a state only while the document cannot be used yet (「正在读取」, a few seconds) or when it could not be read (「没能读取 ·
 * 重试」). Reading state is not a filter: nobody comes to the knowledge base to look for documents by the pipeline's progress.
 */
export function SourcesPage() {
  // A project switch in the sidebar repaints the page: the project views start from the sidebar's project.
  useProjectStore((state) => state.currentId);
  const { sourceId = "" } = useParams();
  const [params] = useSearchParams();
  // A document is opened at its own address. `?source=<id>` is not one of the list's parameters, but it names a document, so it lands on
  // that document's page (the drawer it used to open had no address at all).
  const legacy = legacySourceParam(params);
  if (legacy) return <Navigate to={readerPath(legacy, readListState(params))} replace />;
  return <KnowledgeBase sourceId={sourceId || null} />;
}

/** What a document count is: the platform's own compiled files are not among them. */
function documentTotal(tally: SourceCounts | null): number | null {
  return tally ? tally.all - (tally.wiki ?? 0) : null;
}

/** What a selection of documents asks: which project's conversation reads them. */
interface Choosing { sources: SourceRecord[] }

function KnowledgeBase({ sourceId }: { sourceId: string | null }) {
  const navigate = useNavigate();
  const selectProject = useProjectStore((state) => state.select);
  const location = useLocation();
  const navigationType = useNavigationType();
  const currentProjectId = getWebProjectId();
  // The view, the type, the project and the search live in the address (E-8): a reload, the back button and a link all land on the
  // list as it was, and a document opened from it comes back to it.
  const [params, setParams] = useSearchParams();
  const listState = useMemo(() => readListState(params), [params]);
  const view = viewOf(listState);
  const kind = listState.kind;
  const update = useCallback((patch: Partial<KnowledgeListState>) => {
    setParams((current) => listParams({ ...readListState(current), ...patch }), { replace: true });
  }, [setParams]);
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

  const groups = useProjectGroups();
  const everyProject = useMemo(() => [...groups.own, ...groups.studies, ...groups.communication], [groups]);
  // The project the project views are of: the one the address names, else the sidebar's, else the first there is. A project that is gone
  // (deleted elsewhere) is not taken, and until the account's projects are read the address's is trusted.
  const known = everyProject.map((project) => project.id);
  const scopeProjectId = view === "documents" ? null
    : known.length === 0 ? listState.scope ?? currentProjectId
      : listState.scope && known.includes(listState.scope) ? listState.scope
        : known.includes(currentProjectId) ? currentProjectId : known[0];
  const pagesOffered = usePagesOffered();
  // 从网盘导入 is in the menu only when the drive status for this account says there is something to open (or that it is unreachable for
  // the moment, which its panel says and retries): an entry that always ended in 「请联系管理员」 was a dead end (audit I3-4).
  const driveOffered = useDriveEntry();

  // Coming back to a list puts it where it was left: the same documents loaded and the same scroll, once. Two ways back. After a visit
  // elsewhere (the back button, or 「知识库」 on a document's page reached from another page) the page is drawn again and the place is read
  // from what the list kept when a document was opened (`restore`). Within the page — a narrow window swaps the list for the document and
  // back, and the documents stay loaded — the list's own box is drawn again, and the place is the last one the list kept (`place`).
  // A visit of its own — the sidebar, a typed address — starts at the top.
  const restore = useRef(
    navigationType === "POP" || (location.state as { kbRestore?: boolean } | null)?.kbRestore === true ? recallListPosition(listState) : null,
  );
  const place = useRef<number | null>(null);
  const listScroller = useRef<HTMLDivElement | null>(null);
  /** The list's scroll box, as it is drawn: a place the list has to be brought back to is set the moment the box is there. */
  const setListScroller = useCallback((node: HTMLDivElement | null) => {
    listScroller.current = node;
    if (node && place.current !== null) { node.scrollTop = place.current; place.current = null; }
  }, []);
  const onRestored = useCallback(() => {
    place.current = restore.current?.scroll ?? null;
    restore.current = null;
  }, []);
  const documents = useDocumentList({ enabled: view === "documents", kind, search, restore: restore.current, onRestored });
  const { items, setItems, counts, passages, nextCursor, loadingMore, error, load, loadMore } = documents;
  // A place found once the rows are on the page is set then: before, there is nothing to scroll. (A list that is not drawn — the page is
  // the document's — sets it when it is.)
  useLayoutEffect(() => {
    if (place.current === null || items === null || !listScroller.current) return;
    listScroller.current.scrollTop = place.current;
    place.current = null;
  }, [items]);
  // The list loads the next page as its end comes into view; the 「显示更多」 button is the same thing for a browser that cannot tell, and
  // for a keyboard. The node is state so the observer follows the list when it is drawn again (a narrow window swaps it for a document).
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sentinel || !nextCursor || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); }, { rootMargin: "240px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, nextCursor, loadMore, items]);

  // Whether the list has the pane beside it, as the last drawing of the page saw it: what adding a document does with the one it added.
  const beside = useRef(false);
  const [selected, setSelected] = useState<Map<string, SourceRecord>>(() => new Map());
  useEffect(() => setSelected(new Map()), [view]);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [applying, setApplying] = useState<SourceRecord | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [dialog, setDialog] = useState<"link" | "note" | "upload" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadEpoch = useRef(0);
  useLayoutEffect(() => () => { uploadEpoch.current++; }, []);
  const [uploadItems, setUploadItems] = useState<FileDropItem[]>([]);
  // Where new material goes unless the person says another place: the account's own storage, which every project reads — and, in the views
  // of one project, that project.
  const defaultDestination = scopeProjectId ?? PERSONAL;
  const [destination, setDestination] = useState<string>(PERSONAL);
  useEffect(() => setDestination(defaultDestination), [defaultDestination]);
  const destinationOptions = everyProject;
  const destinationProject = defaultDestination === PERSONAL ? null : defaultDestination;

  // A failed read, delete or change is said as a notice and the list stays as it was, rather than replacing the list with an error whose
  // 「重试」 would re-list the page.
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

  /**
   * A new document is read where it is: the list is read again, and the pane shows it — in the list as it is, with no filter or search
   * hiding it. Where there is no pane (a narrow window) the person stays on the list, in which the new document is the newest row; a note,
   * whose editor is the document's own page, is opened there in any case.
   */
  const openAdded = (source: SourceRecord, { page = false }: { page?: boolean } = {}) => {
    if (page || beside.current) navigate(readerPath(source.id, { ...stateForView(listState, "documents"), q: "" }));
    if (view === "documents") void load(true);
  };

  // Upload: the whole page is its drop target. Files go to the place the dialog says — by default the account's own storage.
  const openUpload = (to: string = defaultDestination) => { setUploadItems([]); setDestination(to); setDialog("upload"); };
  const uploadFiles = async (dropped?: File[]) => {
    const owner = sessionGeneration(), epoch = uploadEpoch.current;
    const valid = () => owner === sessionGeneration() && epoch === uploadEpoch.current;
    setUploading(true);
    try {
      const { accepted, refused } = partitionKnowledgeBaseFiles(dropped ?? await pickFiles(KNOWLEDGE_BASE_ACCEPT));
      if (!valid()) return;
      // The formats are said here, to the file that was refused, and nowhere else on the page.
      if (refused.length > 0) {
        toast.error(`没有上传：${refused.map((file) => `${file.name}（${file.reason}）`).join("、")}。${KNOWLEDGE_BASE_UPLOAD_HINT}`);
      }
      const names: string[] = [];
      const own: SourceRecord[] = [];
      const targetProject = destination === PERSONAL ? null : destination;
      if (accepted.length > 0 && dialog !== "upload") setDialog("upload");
      const pending = accepted.map((file, index) => ({ id: `${Date.now()}-${index}`, name: file.name, state: "transferring" as const }));
      setUploadItems(pending);
      // One existing upload request per file preserves partial outcomes without promising cancellation or byte progress.
      for (let index = 0; index < accepted.length; index++) {
        if (!valid()) return;
        const entry = pending[index];
        try {
          if (targetProject) names.push(...await uploadFilesToWorkspace([accepted[index]], KNOWLEDGE_ROOT, "base", targetProject, valid));
          else { const saved = await uploadPersonalFile(accepted[index], valid); own.push(saved.source); names.push(saved.source.display.title); }
          if (!valid()) return;
          setUploadItems(current => current.map(item => item.id === entry.id ? { ...item, state: "transferred" } : item));
        } catch (failure) {
          if (!valid() || failure instanceof StaleSessionError || failure instanceof WebApiError && failure.status === 401) return;
          setUploadItems(current => current.map(item => item.id === entry.id ? { ...item, state: "failed", error: webErrorMessage(failure) } : item));
        }
      }
      if (names.length > 0) {
        // The row says 「正在读取」 until the document can be used; the toast says only what happened.
        toast.success(`已上传 ${names.length} 个文件`);
        if (own.length > 0) openAdded(own[0]);
        else if (view === "documents") void load(true);
      }
    } catch (failure) {
      if (valid() && !(failure instanceof StaleSessionError)) toast.error(`无法上传文件：${webErrorMessage(failure)}`);
    } finally {
      if (valid()) setUploading(false);
    }
  };
  const { dragging, dropProps } = useFileDrop({ disabled: !hasWebApi || uploading, onDrop: (files) => void uploadFiles(files) });

  const onLinkAdded = (source: SourceRecord) => { setDialog(null); toast.success("已添加，正在读取"); openAdded(source); };
  // A new note opens on its own page, where its editor is.
  const onNoteAdded = (source: SourceRecord) => { setDialog(null); openAdded(source, { page: true }); };

  // A document's own address, and what the list keeps of its place as it is followed: how far it was scrolled and how many documents it
  // had loaded, which is what brings the reader back to the same row.
  const readerLink = (source: SourceRecord) => readerPath(source.id, listState);
  const keepPlace = () => {
    const scroll = listScroller.current?.scrollTop ?? 0;
    place.current = scroll;
    rememberListPosition(listState, { scroll, count: items?.length ?? PAGE_SIZE });
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
  /** 「在对话中使用」 for a selection: the conversation of the one project that reads every one of them; the person says which where several do. */
  const startConversation = async (projectId: string, sources: SourceRecord[]) => {
    keepPlace();
    try {
      await selectProject(projectId, () => {
        const intent = { ...newRuntimeUiIntent("请根据所选资料回答我的问题，引用时标出处。\n\n我的问题："), references: sources.map((source) => ({ id: source.id, title: source.display.title })) };
        navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: intent } });
      });
    } catch (failure) { toast.error(webErrorMessage(failure)); }
  };
  const openSelected = () => {
    const sources = [...selected.values()];
    if (sources.length === 0) return;
    const candidates = conversationProjects(sources, groups);
    if (candidates.length === 0) { toast.error("所选资料没有共同生效的项目：先在“生效项目”里调整，或分开使用。"); return; }
    if (candidates.length > 1) { setChoosing({ sources }); return; }
    void startConversation(candidates[0].id, sources);
  };
  /** The row, the selection and the pane all say where a document takes effect: a change is made in all three at once. */
  const patchApplied = (change: { sourceId: string; libraryProjects: "all" | string[]; appliesTo: "all" | string[] }) => {
    const patch = (source: SourceRecord): SourceRecord => (source.id === change.sourceId ? { ...source, libraryProjects: change.libraryProjects, appliesTo: change.appliesTo } : source);
    setItems((previous) => previous && previous.map(patch));
    setSelected((previous) => { const next = new Map(previous); const held = next.get(change.sourceId); if (held) next.set(change.sourceId, patch(held)); return next; });
  };
  /** A document deleted from the pane is out of the list and of the selection, and the list is read again. */
  const dropped = (id: string) => {
    setItems((previous) => previous && previous.filter((source) => source.id !== id));
    setSelected((previous) => { const next = new Map(previous); next.delete(id); return next; });
    void load(true);
  };
  const applied = (change: { sourceId: string; libraryProjects: "all" | string[]; appliesTo: "all" | string[] }) => {
    patchApplied(change);
    setAppliedCount((count) => count + 1);
    setApplying(null);
    toast.success("已更新生效项目");
  };

  // ------------------------------------------------------------------ the list column's rows of controls
  const kindOptions: FilterOption<SourceKind | "all">[] = useMemo(() => {
    if (!counts) return [];
    return [
      { value: "all" as const, label: "全部", count: documentTotal(counts) ?? counts.all },
      ...SOURCE_KINDS.filter((entry) => entry.id !== "wiki" && (counts[entry.id as SourceKind] > 0 || entry.id === kind))
        .map((entry) => ({ value: entry.id as SourceKind, label: entry.label, count: counts[entry.id as SourceKind] })),
    ];
  }, [counts, kind]);
  const filtered = kind !== null || search !== "";
  const total = kind ? counts?.[kind] ?? null : documentTotal(counts);
  const remaining = total === null || items === null ? 0 : Math.max(0, total - items.length);
  // With nothing in the library the pane is the recipe and offers 「添加」, so the header does not: one solid button on the page. It stays
  // wherever the recipe offers none — a search without a hit — and while the list is read or failed.
  const firstRun = view === "documents" && items !== null && items.length === 0 && !error && !filtered;
  const selectedHere = view === "documents" && selected.size > 0;
  const typeFilter: ToolbarFilter[] = kindOptions.length > 1 && (kindOptions.length - 1 >= 2 || kind !== null)
    ? [{ kind: "chips", label: "资料类型", options: kindOptions, value: kind ?? "all", neutral: "all", maxVisible: kindOptions.length,
      onChange: (value) => update({ kind: value === "all" ? null : value as SourceKind }) }]
    : [];
  const searchBox = { label: "搜索资料和内容", value: query, onChange: setQuery, onClear: () => setQuery("") };
  const toolbar: ToolbarProps | undefined = selectedHere ? {
    label: "所选资料",
    summary: `已选 ${selected.size} 份`,
    actions: (
      <>
        <Button size="sm" onClick={openSelected}>在对话中使用</Button>
        <Button size="sm" variant="text" onClick={() => setSelected(new Map())}>取消</Button>
      </>
    ),
  } : firstRun ? undefined : {
    label: "资料的筛选",
    filters: typeFilter,
    onClear: filtered ? () => { setQuery(""); update({ kind: null, q: "" }); } : undefined,
    search: searchBox,
    summary: total === null ? undefined : `${total} 份`,
  };

  const addItems: MenuEntry[] = [
    { label: "上传文件", icon: FileUp, onSelect: () => openUpload() },
    { label: "添加网页链接", icon: Globe, onSelect: () => setDialog("link") },
    { label: "新建笔记", icon: StickyNote, onSelect: () => setDialog("note") },
    ...(driveOffered ? [{ label: "从网盘导入", icon: Cloud, onSelect: () => setConnecting(true) }] : []),
  ];
  const addMenu = () => (
    <Menu label="添加" items={addItems}>
      <Button disabled={!hasWebApi || uploading} loading={uploading}>{!uploading && <Plus size={16} aria-hidden="true" />}添加</Button>
    </Menu>
  );

  const more = nextCursor && (
    <div ref={setSentinel}>
      {loadingMore ? <div className="mt-2 flex justify-center"><Button variant="text" size="sm" loading>正在加载</Button></div>
        : remaining > 0 ? <ShowMore remaining={remaining} unit="份" onMore={() => void loadMore()} />
          : <div className="mt-2 flex justify-center"><Button variant="text" size="sm" onClick={() => void loadMore()}>显示更多</Button></div>}
    </div>
  );
  const recipe = <EmptyState icon={Folder} title="把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。" action={addMenu()} className="min-h-0 flex-1" />;

  const documentRows = (split: boolean, current: string | null) => {
    if (items === null) return <FilesSkeleton />;
    if (error && items.length === 0) return null;
    if (items.length === 0) {
      if (nextCursor) return more;
      if (filtered) return <EmptyState icon={Search} title="没有找到相关资料" reason="换个关键词试试，或清空搜索框看全部。" />;
      // Beside the pane the recipe is the pane's; alone, it is the page.
      return split ? null : recipe;
    }
    return (
      <div>
        <List label="资料">
          {items.map((source) => (
            <SourceRow key={source.id} source={source} busy={busy} labels={groups.labels} current={source.id === current}
              onRetry={() => readAgain(source)} onApplies={() => setApplying(source)} onDelete={() => setDeleting(source)}
              to={readerLink(source)} onOpen={keepPlace}
              selected={selected.has(source.id)} onSelect={() => toggleSelected(source)}
              passages={passages[source.id]} query={search}
              passageTo={(passage) => readerPath(source.id, listState, passage.page ? { tab: "original", page: passage.page } : { tab: null, page: null })} />
          ))}
        </List>
        {more}
      </div>
    );
  };

  const wikiCount = counts?.wiki ?? 0;
  const viewLinks = <KnowledgeViews view={view} state={listState} pagesOffered={pagesOffered || wikiCount > 0} />;
  const readerBack = view === "graph" ? "图谱" : view === "pages" ? "知识页" : "知识库";
  const projectHref = (projectId: string) => listPath({ ...listState, scope: projectId, focus: null, depth: null });
  const projectLabel = scopeProjectId ? groups.labels.get(scopeProjectId) ?? "当前项目" : "";

  const list = ({ split }: MasterDetailState) => {
    beside.current = split;
    const current = sourceId ?? (split && view === "documents" ? items?.[0]?.id ?? null : null);
    return (
      // Where the list is the page it keeps the page's column and gutter (`PageShell`'s); beside the pane it is a column of its own.
      <div className={cn("flex min-h-0 flex-1 flex-col", !split && "mx-auto w-full max-w-page px-4 md:px-6")}>
        <PageHeader title="知识库" actionPlan={firstRun ? undefined : { primary: { id: "add", label: "添加", items: addItems, disabled: !hasWebApi || uploading, loading: uploading } }} className={cn("shrink-0 pb-2 pt-5", split && "px-4")} />
        <div className={cn("shrink-0 pb-2", split && "px-3")}>{viewLinks}</div>
        {view === "documents" && toolbar && <div className={cn("shrink-0 pb-2", split && "px-4")}><Toolbar {...toolbar} /></div>}
        <div ref={setListScroller} className={cn("min-h-0 flex-1 overflow-y-auto pb-6", split && "px-2")}>
          {view === "documents" && error && <LoadError message={error} onRetry={() => void load()} className="mb-4" />}
          {view === "documents" ? documentRows(split, current) : <ProjectList groups={groups} chosen={scopeProjectId} hrefFor={projectHref} />}
        </div>
      </div>
    );
  };

  const detail = ({ split }: MasterDetailState) => {
    const mode = split ? "pane" as const : "page" as const;
    if (view === "documents") {
      const id = sourceId ?? (split ? items?.[0]?.id ?? null : null);
      if (id) return <SourceReader key={id} sourceId={id} listState={listState} mode={mode} backLabel={readerBack} refresh={appliedCount} onApplied={patchApplied} onRemoved={dropped} />;
      return split && firstRun ? recipe : null;
    }
    if (sourceId) return <SourceReader key={sourceId} sourceId={sourceId} listState={listState} mode={mode} backLabel={readerBack} refresh={appliedCount} onApplied={patchApplied} onRemoved={dropped} />;
    if (!scopeProjectId) return null;
    return (
      <ProjectKnowledge key={scopeProjectId} projectId={scopeProjectId} label={projectLabel} view={view} listState={listState} update={update}
        pagesOffered={pagesOffered} query={query} onQuery={setQuery} split={split} onAddDocuments={(project) => openUpload(project)} />
    );
  };

  // The pane is chosen — and so the page is the pane where there is no room for both — by a document in the address, or in the project
  // views by a project in the address.
  const chosen = sourceId !== null || (view !== "documents" && listState.scope !== null);
  return (
    <div {...dropProps} className="relative h-full">
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-drawer flex items-center justify-center bg-bg">
          <div className="flex items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface px-6 py-4 text-ui text-accent">
            <Upload size={16} aria-hidden="true" />
            松开即可上传
          </div>
        </div>
      )}
      <MasterDetail
        list={list} detail={detail} selected={chosen} narrow="swap" listWidth={LIST_WIDTH} detailMin={PANE_MIN}
        listLabel="资料列表" detailLabel="资料阅读" modeAttribute="data-knowledge-layout"
      />
      {connecting && (
        <Drawer title="从网盘导入" onClose={() => setConnecting(false)} widthClassName="max-w-2xl">
          <LibraryDriveImport projectId={destinationProject} destinations={destinationOptions} refreshToken={folderRefresh}
            onImported={() => { void load(true); }} onFolderRegistered={() => setFolderRefresh((value) => value + 1)}
            onUpload={() => { setConnecting(false); openUpload(); }} />
        </Drawer>
      )}
      {/* What a batch did is shown in the dialog that ran it, and goes with it: the next one opens empty. */}
      {dialog === "upload" && <FormDialog title="上传资料" onClose={() => { setDialog(null); setUploadItems([]); }} busy={uploading}>
        <div className="flex flex-col gap-4"><Combobox clearable={false} label="保存位置" value={destination} options={[{ id: PERSONAL, label: PERSONAL_DESTINATION }, ...destinationOptions]} onChange={id => { if (id) setDestination(id); }} disabled={uploading} />
        <FileDrop initialFocus label="选择资料文件" hint={<>{destinationHint(destination === PERSONAL)}{KNOWLEDGE_BASE_UPLOAD_HINT}传输完成后，资料列表会分别显示读取和可搜索状态。同名文件会成为这份资料的新版本，旧版本仍可查看；内容相同的文件不会重复添加。</>} accept={KNOWLEDGE_BASE_ACCEPT} disabled={uploading} onFiles={files => void uploadFiles(files)} items={uploadItems} />
        </div>
      </FormDialog>}
      {dialog === "link" && <AddLinkDialog destinations={destinationOptions} projectId={destinationProject} onClose={() => setDialog(null)} onAdded={onLinkAdded} />}
      {dialog === "note" && <NewNoteDialog destinations={destinationOptions} projectId={destinationProject} onClose={() => setDialog(null)} onAdded={onNoteAdded} />}
      {applying && <AppliesToDialog source={applying} projects={groups.own} labels={groups.labels} onClose={() => setApplying(null)} onSaved={applied} />}
      {choosing && <ConversationProjectDialog options={conversationProjects(choosing.sources, groups)} onClose={() => setChoosing(null)}
        onChoose={(projectId) => { const sources = choosing.sources; setChoosing(null); void startConversation(projectId, sources); }} />}
      {deleting && <ConfirmDialog title="删除这份资料？" body="删除后不再用于回答。"
        confirmLabel="删除" onCancel={() => setDeleting(null)}
        onConfirm={() => void mutate(async () => {
          await removeSource(deleting.id, deleting.revision);
          setSelected((previous) => { const next = new Map(previous); next.delete(deleting.id); return next; });
          if (sourceId === deleting.id) navigate(listPath(listState), { replace: true, state: { kbRestore: true } });
        })} />}
    </div>
  );
}
