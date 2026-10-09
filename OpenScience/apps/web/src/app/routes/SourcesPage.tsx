import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router";
import { Cloud, FileUp, Folder, Globe, Plus, Search, StickyNote, Upload } from "lucide-react";
import { SOURCE_KINDS } from "@evimed/domain";
import { fetchWebMe, getWebProjectId, hasWebApi, webErrorMessage } from "@/lib/apiClient";
import { projectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { addToLibrary, decideDuplicateGroup, listDuplicateCandidates, listSources, openListOffered, refetchSource, removeFromLibrary,
  removeSource, retrySource, type DuplicateGroup, type SourceCounts, type SourceKind, type SourceRecord, type SourceScope } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "@/lib/knowledgeBaseFiles";
import { legacySourceParam, listParams, readListState, readerPath, recallListPosition, rememberListPosition, scopeOf, scopeParam, type KnowledgeListState, type ListPosition } from "@/lib/knowledgeNav";
import { useFileDrop } from "@/lib/useFileDrop";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { AddLinkDialog, NewNoteDialog } from "@/components/sources/AddEntryDialogs";
import { DriveImportDrawerBody } from "@/components/sources/DriveImport";
import { DuplicateGroups } from "@/components/sources/DuplicateGroups";
import { KnowledgeScopeMenu } from "@/components/sources/KnowledgeScopeMenu";
import { SourceRow } from "@/components/sources/SourceRow";
import { isReading } from "@/components/sources/sourceView";

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

/** Whether the window is a phone's width: the chips then keep three inline and the rest under 「更多」, since a row of seven is cut off. */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * 知识库: the documents a researcher hands EviMed to read — papers and guidelines, protocols, tables, a hospital's
 * rules, a web page, a note — which a conversation reads and cites. One list, in a scope: a project's, or the
 * documents made available to every project.
 *
 * The header is the title, the scope (choosing it changes this page's list and nothing else: it does not move the
 * tab to that project), a search and one primary action, 「添加」, which holds the four ways in. Under it, one row of
 * chips by what a document is, counted by the server over the whole scope and the search — not over the page — and
 * one list. A row says what the document is called, one line of what it says and where it came from; it is a link
 * to the document's own page (`/app/files/:sourceId`), where its original and what it says are side by side. The
 * scope, the type and the search are in the address, so a reload, the back button and a link all land on the list as
 * it was, and coming back from a document puts the list back where it was left. A page is fifty documents; the rest
 * load as the list is scrolled, and the search runs where the documents are, so the fifty-first is as findable as the
 * first.
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
  const location = useLocation();
  const navigationType = useNavigationType();
  const projects = useProjectStore((state) => state.projects);
  // The scope, the type and the search live in the address (E-8): a reload, the back button and a link all land on the
  // list as it was, and a document opened from it comes back to it.
  const [params, setParams] = useSearchParams();
  const listState = useMemo(() => readListState(params), [params]);
  const scope = useMemo(() => scopeOf(listState, currentProjectId), [listState, currentProjectId]);
  const kind = listState.kind;
  const update = useCallback((patch: Partial<KnowledgeListState>) => {
    setParams((current) => {
      const next = { ...readListState(current), ...patch };
      return listParams(next);
    }, { replace: true });
  }, [setParams]);
  const setScope = (next: SourceScope) => update({ scope: scopeParam(next, currentProjectId), kind: null });
  const setKind = (next: SourceKind | null) => update({ kind: next });
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
  const narrow = useNarrow();
  const [items, setItems] = useState<SourceRecord[] | null>(null);
  const [counts, setCounts] = useState<SourceCounts | null>(null);
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
  // 从网盘导入 is offered only when there is a drive to open: OpenList configured and a storage mounted under its tenant
  // root (`/api/me` `features.openList`). An entry that led to a drive with nothing in it answered every browse with an
  // error (audit I3-4). Off until `/api/me` says so, and when it cannot.
  const [driveOffered, setDriveOffered] = useState(false);
  useEffect(() => {
    let active = true;
    fetchWebMe().then((me) => { if (active) setDriveOffered(openListOffered(me)); }).catch(() => { /* not offered */ });
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
  // Where a new document goes: the project the page lists, or — in the shared scope, which belongs to no project —
  // the project the tab is in.
  const addProjectId = scopeProjectId ?? currentProjectId;
  const projectNames = useMemo(() => projectLabels(projects), [projects]);

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
      if (!background) {
        // The pages the reader had open are read again until the document they opened is among them (bounded).
        let loadedItems = page.items;
        let cursor = page.nextCursor;
        for (let more = 0; position && loadedItems.length < position.count && cursor && more < 10; more += 1) {
          const next = await listSources(scope, { ...(kind ? { kind } : {}), q: search, cursor, limit: PAGE_SIZE });
          if (generation.current !== current) return;
          const known = new Set(loadedItems.map((item) => item.id));
          loadedItems = [...loadedItems, ...next.items.filter((item) => !known.has(item.id))];
          cursor = next.nextCursor;
        }
        if (position) { restore.current = null; pendingScroll.current = position.scroll; }
        setItems(loadedItems);
        setNextCursor(cursor);
        return;
      }
      // A refresh of the head of the list: what it holds replaces those rows, and what was loaded beyond it stays.
      setItems((previous) => {
        if (!previous || !page.nextCursor) { setNextCursor(page.nextCursor); return page.items; }
        const oldest = page.items.at(-1)?.createdAt ?? "";
        const fresh = new Set(page.items.map((item) => item.id));
        const tail = previous.filter((item) => !fresh.has(item.id) && item.createdAt < oldest);
        if (tail.length === 0) setNextCursor(page.nextCursor);
        return [...page.items, ...tail];
      });
    } catch (loadError) {
      if (generation.current === current) {
        if (!background) setItems([]);
        setError(`无法加载资料：${productErrorMessage(loadError)}`);
      }
    }
  }, [scope, kind, search]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
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
      const page = await listSources(scope, { ...(kind ? { kind } : {}), q: search, cursor: nextCursor, limit: PAGE_SIZE });
      if (generation.current !== current) return;
      setItems((previous) => {
        const known = new Set((previous ?? []).map((item) => item.id));
        return [...(previous ?? []), ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      toast.error(`无法加载更多：${productErrorMessage(loadError)}`);
    } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, scope, kind, search]);
  // The list loads the next page as its end comes into view; the 「加载更多」 row is the same thing for a browser
  // that cannot tell, and for a keyboard.
  const sentinel = useRef<HTMLLIElement>(null);
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

  const kindOptions: FilterOption<SourceKind | "all">[] = useMemo(() => {
    if (!counts) return [];
    return [
      { value: "all" as const, label: "全部", count: counts.all },
      ...SOURCE_KINDS.filter((entry) => counts[entry.id as SourceKind] > 0 || entry.id === kind)
        .map((entry) => ({ value: entry.id as SourceKind, label: entry.label, count: counts[entry.id as SourceKind] })),
    ];
  }, [counts, kind]);
  const kindsPresent = kindOptions.length - 1;
  const duplicateOpen = duplicatesFor ? groups.filter((group) => !group.decision && group.sourceIds.includes(duplicatesFor)) : [];
  const filtered = kind !== null || search !== "";

  const rowActions = (source: SourceRecord) => ({
    busy,
    duplicate: groupOf(source.id) !== null,
    onRetry: () => readAgain(source),
    onShare: () => toggleShared(source),
    onDuplicates: () => setDuplicatesFor(source.id),
    onDelete: () => setDeleting(source),
  });

  const addMenu = (
    <Menu label="添加" items={[
      { label: "上传文件", icon: FileUp, onSelect: () => void uploadFiles() },
      { label: "添加网页链接", icon: Globe, onSelect: () => setDialog("link") },
      { label: "新建笔记", icon: StickyNote, onSelect: () => setDialog("note") },
      ...(driveOffered ? [{ label: "从网盘导入", icon: Cloud, onSelect: () => setConnecting(true) }] : []),
    ]}>
      <Button disabled={!hasWebApi || uploading} loading={uploading}>{!uploading && <Plus size={16} aria-hidden="true" />}添加</Button>
    </Menu>
  );

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
        width="wide"
        meta={<KnowledgeScopeMenu scope={scope} onChange={setScope} />}
        actions={<>
          <SearchInput label="搜索资料和内容" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} className="w-60" />
          {addMenu}
        </>}
      >
        {(kindsPresent >= 2 || kind !== null) && (
          <FilterChips label="资料类型" className="mb-4" options={kindOptions} maxVisible={narrow ? 3 : kindOptions.length} value={kind ?? "all"} onChange={(value) => setKind(value === "all" ? null : value)} />
        )}
        {error && <LoadError message={error} onRetry={() => void load()} className="mb-4" />}
        {items === null ? <FilesSkeleton /> : items.length === 0 ? (error ? null
          : filtered ? <EmptyState icon={Search} title="没有找到相关资料" />
            : shared ? <EmptyState icon={Folder} title="还没有资料设为所有项目可用。" description="在资料的“⋯”菜单里选“设为所有项目可用”。" />
              : <EmptyState icon={Folder} title="把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。" action={addMenu} />
        ) : (
          <List label="资料">
            {items.map((source) => (
              <SourceRow key={source.id} source={source} showShared={!shared} {...rowActions(source)}
                projectName={shared ? projectNames.get(source.projectId) ?? null : null}
                to={readerLink(source)} onOpen={keepPlace} />
            ))}
            {nextCursor && (
              <li ref={sentinel} className="flex justify-center py-3">
                <Button variant="text" loading={loadingMore} onClick={() => void loadMore()}>加载更多</Button>
              </li>
            )}
          </List>
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
