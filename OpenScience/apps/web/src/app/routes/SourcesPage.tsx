import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Cloud, CornerLeftUp, FileText, Folder, FolderSync, Image as ImageIcon, Link2, RefreshCw, Search, Sheet, Upload, XCircle } from "lucide-react";
import { getWebProjectId, hasWebApi, webErrorMessage } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { addToLibrary, browseOpenList, cancelSource, decideDuplicateGroup, getSourceFamily, importOpenListSource, listDuplicateCandidates,
  listLibrary, listSourceFolders, listSources, overrideSource, registerSourceFolder, removeFromLibrary, removeSource, retrySource,
  setSourceFolderStatus, sourceFailureMessage, syncSourceFolder, type DuplicateGroup, type OpenListEntry, type SourceFamily,
  type SourceFolderRecord, type SourceListState, type SourceMetadata, type SourceOmissionNotice, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { baseName, formatClock, formatDay, humanSize } from "@/lib/format";
import { extOf, extToKind, previewKindForName } from "@/lib/artifacts";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { useFileDrop } from "@/lib/useFileDrop";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { labelFor } from "@/lib/statusLabel";
import { useOperator } from "@/lib/useOperator";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { IconButton } from "@/components/ui/IconButton";
import { Input, inputClasses } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Switch } from "@/components/ui/Switch";
import { Tag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { PageShell } from "@/components/layout/PageShell";
import { SourceUnderstandingPanel } from "@/components/sources/SourceUnderstandingPanel";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "./FilesPage";

/** Whether the assistant can use a document now: the server's `readable`,
 *  true as soon as the text is read, whatever the pipeline still does with it
 *  after that. A record from before the field existed answers by its status. */
function isUsable(source: SourceRecord): boolean {
  return source.readable ?? (source.payload.status === "complete" || source.payload.status === "needs_attention");
}

/** Whether a document cannot be used yet because it is still being read. */
function isReading(source: SourceRecord): boolean {
  return !isUsable(source) && (source.payload.status === "queued" || source.payload.status === "parsing");
}

/**
 * A document's state in the words a row says it, or "" when there is nothing
 * to say — a usable document shows its type and date, and no internal state
 * (2026-09-24: no 「分析中」 or 「理解中」; the understanding that runs after
 * the reading is not the researcher's concern).
 */
function stateLabel(source: SourceRecord): string {
  const status = source.payload.status;
  if (status === "needs_attention") return "部分没能读取";
  if (isUsable(source)) return "";
  if (status === "queued" || status === "parsing") return "读取中";
  if (status === "failed") return "没能读取";
  if (status === "missing") return "原件已移除";
  if (status === "canceled") return "已取消";
  return "";
}
const TYPE_OPTIONS = [
  ["published-paper", "已发表论文"], ["preprint-manuscript", "手稿或预印本"], ["review-guideline", "综述或指南"],
  ["book-chapter", "书籍章节"], ["conference-material", "会议材料"], ["grant-proposal", "标书或课题申请"],
  ["research-protocol", "研究方案、SOP 或检查表"], ["peer-review", "审稿意见"], ["medical-case", "医案"],
  ["patient-record", "病例或病历"], ["cohort-data", "队列数据或数据字典"], ["statistical-output", "统计输出"],
  ["lecture-slides", "讲课 PPT"], ["audio-recording", "录音"], ["video-recording", "视频"],
  ["course-bundle", "课程包"], ["note-memo", "笔记或备忘"], ["message-export", "邮件或聊天导出"],
  ["administrative-record", "行政或财务资料"], ["certificate-scan", "证书或扫描件"], ["image-figure", "图片或图表"], ["other", "其他"],
] as const;
const DEPTH_OPTIONS = [["skip", "仅保留指纹"], ["index_only", "只建索引"], ["structured", "结构化抽取"], ["deep", "深度分析"]] as const;

/** A file's format as a list names it: 「PDF」「Word」「Excel」, not its extension. */
const FORMAT_LABEL: Record<string, string> = {
  pdf: "PDF", doc: "Word", docx: "Word", rtf: "Word", ppt: "PPT", pptx: "PPT",
  xls: "Excel", xlsx: "Excel", xlsm: "Excel", csv: "表格", tsv: "表格",
  jpg: "图片", jpeg: "图片", png: "图片", bmp: "图片", gif: "图片",
  epub: "电子书", mobi: "电子书", htm: "网页", html: "网页", xml: "网页",
  txt: "文本", md: "文本", json: "文本", yaml: "文本", yml: "文本", r: "代码", py: "代码", sql: "代码",
};

/** @param name a file name */
function formatLabel(name: string): string {
  return FORMAT_LABEL[extOf(name)] ?? (extOf(name) ? extOf(name).toUpperCase() : "文件");
}

/** The states from which a document can be read again. */
const RETRYABLE = ["failed", "needs_attention", "complete", "canceled"];

/** Where an upload lands, and the folder the list is of. */
const KNOWLEDGE_ROOT = "knowledge-base";

/** A synced folder's path as the researcher typed it: the tenant namespace the
 *  gateway prefixes is the platform's, not theirs (review B, SourcesPage). */
function displayPath(path: string) {
  return path.replace(/^\/tenants\/[^/]+/, "") || "/";
}

/** The filters, in the words the rows say (`SourceListState` on the server). */
type Filter = "all" | SourceListState | "duplicates";

/**
 * The reader's grouping of a knowledge base, by extension. Deliberately not
 * `ArtifactKind`: that is a preview concern (which viewer opens the bytes),
 * and a researcher filing a document thinks 「文献」 and 「表格」.
 */
type Kind = "paper" | "document" | "sheet" | "slides" | "page" | "image" | "other";
const KIND_LABELS: ReadonlyArray<[Kind, string]> = [
  ["paper", "文献"], ["document", "文档"], ["sheet", "表格"],
  ["slides", "幻灯"], ["page", "网页"], ["image", "图片"], ["other", "其他"],
];
const KIND_BY_EXT: Record<string, Kind> = {
  pdf: "paper", docx: "document", doc: "document", md: "document", txt: "document", rtf: "document", epub: "document",
  xlsx: "sheet", xls: "sheet", csv: "sheet", tsv: "sheet",
  pptx: "slides", ppt: "slides",
  html: "page", htm: "page",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
};
const kindOf = (source: SourceRecord): Kind =>
  KIND_BY_EXT[extOf(source.payload.paths[0] ?? source.id).toLowerCase()] ?? "other";

const STATUS_FILTERS: readonly FilterOption<Filter>[] = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需要处理" },
  { value: "reading", label: "读取中" },
  { value: "ready", label: "已读取" },
];

/**
 * 知识库: the project's documents, which the assistant reads and cites in this
 * project — one list, with search, the cloud drive and upload in the header,
 * and everything else behind the row.
 *
 * A row is what a file browser shows — the file, its format and length, the
 * day it arrived — and says a state only while the document cannot be used
 * yet (「读取中…」, a few seconds) or when it could not be read (「没能读取 ·
 * 重试」). A document is usable as soon as its text is read; the understanding
 * that follows runs behind it and is never a state on the row (2026-09-24:
 * every stage used to be the same spinner, for minutes). Until 2026-09-23
 * every row also carried the pipeline's bookkeeping (plan §5.5). The
 * document's summary opens with its preview; the rest of what was read about
 * it is one click away, under 「查看理解」.
 *
 * The filters appear once there is something to filter, and a duplicate is a
 * tag on its row (09-22), resolved from the row's menu.
 */
export function SourcesPage() {
  // Store fallback repairs do not reload the document. Subscribe to those
  // repairs, while the tab's current selection still owns in-flight requests.
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ProjectSourcesPage key={projectId} projectId={projectId} />;
}

function ProjectSourcesPage({ projectId }: { projectId: string }) {
  // Whose knowledge base this is, and the account's other ones. The page used
  // to name neither, so a reader looking at a library of twelve documents had
  // no way to tell which project's twelve they were.
  const projects = useProjectStore(state => state.projects);
  const select = useProjectStore(state => state.select);
  const projectName = projects.find(project => project.id === projectId)?.name ?? null;
  const [filter, setFilter] = useState<Filter>("all");
  /** The rail's kind selection; `null` is 全部. */
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SourceRecord | null>(null);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [previewing, setPreviewing] = useState<SourceRecord | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [duplicatesFor, setDuplicatesFor] = useState<string | null>(null);
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const generation = useRef(0);
  const loadingRequest = useRef<number | null>(null);
  const load = useCallback(async (background = false) => {
    if (getWebProjectId() !== projectId || (background && loadingRequest.current != null)) return;
    const current = ++generation.current;
    loadingRequest.current = current;
    if (!background) { setSources(null); setError(null); }
    try {
      const page = await listSources(projectId, filter === "all" || filter === "duplicates" ? {} : { state: filter });
      if (generation.current !== current || getWebProjectId() !== projectId) return;
      if (page.items.some(source => source.projectId !== projectId)) throw new Error("Source project changed.");
      setSources(page.items); setError(null);
    } catch (loadError) {
      if (generation.current === current && getWebProjectId() === projectId) {
        if (!background) setSources([]);
        setError(`无法加载资料状态：${productErrorMessage(loadError)}`);
      }
    } finally { if (loadingRequest.current === current) loadingRequest.current = null; }
  }, [filter, projectId]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  // Polled while a row is still being read: that is the one change a row shows.
  const processing = sources?.some(isReading) ?? false;
  useEffect(() => {
    if (!processing || error) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { void load(true); }, 5000);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [sources, processing, error, load]);
  // A failed delete or re-analysis is not a failed read: it is said as a
  // notice and the list stays as it was, rather than replacing the list with
  // an error whose 「重试」 would re-list the page (review B, SourcesPage P1).
  const mutate = async (operation: () => Promise<unknown>) => {
    if (getWebProjectId() !== projectId) return;
    setBusy(true);
    try {
      await operation();
      if (getWebProjectId() !== projectId) return;
      setEditing(null); setDeleting(null); await load();
    } catch (operationError) { if (getWebProjectId() === projectId) toast.error(productErrorMessage(operationError)); }
    finally { if (getWebProjectId() === projectId) setBusy(false); }
  };
  // Which of this project's documents every project of this account can read
  // (「所有项目可用」). Null while unknown or when the store is unavailable:
  // the row then offers nothing rather than a switch that cannot work.
  const [sharedSources, setSharedSources] = useState<Set<string> | null>(null);
  const loadShared = useCallback(async () => {
    try { setSharedSources(new Set((await listLibrary()).items.flatMap(item => item.sourceIds))); }
    catch { setSharedSources(null); }
  }, []);
  useEffect(() => { void loadShared(); }, [loadShared]);
  const toggleShared = async (source: SourceRecord) => {
    if (getWebProjectId() !== projectId) return;
    setBusy(true);
    try {
      if (sharedSources?.has(source.id)) await removeFromLibrary(source.id);
      else await addToLibrary(source.id);
      await loadShared();
    } catch (operationError) { if (getWebProjectId() === projectId) toast.error(productErrorMessage(operationError)); }
    finally { if (getWebProjectId() === projectId) setBusy(false); }
  };
  // The duplicate groups, read once per list and again after a decision: a
  // row in an undecided group wears the tag; the filter lists only those.
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const loadGroups = useCallback(async () => {
    if (getWebProjectId() !== projectId) return;
    try { const page = await listDuplicateCandidates(projectId); if (getWebProjectId() === projectId) setGroups(page.items); }
    catch { if (getWebProjectId() === projectId) setGroups([]); }
  }, [projectId]);
  useEffect(() => { void loadGroups(); }, [loadGroups, sources]);
  const groupOf = (sourceId: string) => groups?.find(group => !group.decision && group.sourceIds.includes(sourceId)) ?? null;
  const duplicateCount = new Set((groups ?? []).filter(group => !group.decision).flatMap(group => group.sourceIds)).size;
  const decide = async (group: DuplicateGroup, decision: "linked" | "dismissed") => {
    setBusy(true);
    try { await decideDuplicateGroup({ projectId, groupKey: group.groupKey, sourceIds: group.sourceIds, decision }); await loadGroups(); }
    catch (operationError) { toast.error(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };

  // Upload: the one primary action, and the whole page is its drop target.
  const uploadFiles = async (dropped?: File[]) => {
    setUploading(true);
    try {
      const { accepted, refused } = partitionKnowledgeBaseFiles(dropped ?? await pickFiles(KNOWLEDGE_BASE_ACCEPT));
      // The formats are said here, to the file that was refused, and nowhere
      // else on the page.
      if (refused.length > 0) {
        toast.error(`没有上传：${refused.map((file) => `${file.name}（${file.reason}）`).join("、")}。${KNOWLEDGE_BASE_UPLOAD_HINT}`);
      }
      const names = accepted.length > 0 ? await uploadFilesToWorkspace(accepted, KNOWLEDGE_ROOT, "base") : [];
      if (names.length > 0) {
        // The row says 「读取中…」 until the document can be used; the toast
        // says only what happened.
        toast.success(`已上传 ${names.length} 个文件。`);
        await load(true);
      }
    } catch (e) {
      toast.error(`文件上传失败：${webErrorMessage(e)}`);
    } finally {
      setUploading(false);
    }
  };
  const { dragging, dropProps } = useFileDrop({ disabled: !hasWebApi, onDrop: (files) => void uploadFiles(files) });

  // Filters and search are for a library that has something in it; an empty
  // one is a sentence and the two buttons above it (m07b).
  const hasLibrary = filter !== "all" || (sources?.length ?? 0) > 0;
  const needle = query.trim().toLowerCase();
  const shown = (sources ?? []).filter(source => (filter !== "duplicates" || groupOf(source.id))
    && (kind === null || kindOf(source) === kind)
    && (!needle || matches(source, needle)));
  // What is in this knowledge base, by kind, over everything loaded — not over
  // what the current filter shows, or the counts would move as the reader
  // filters and stop being an inventory.
  const kindCounts = new Map<Kind, number>();
  for (const source of sources ?? []) kindCounts.set(kindOf(source), (kindCounts.get(kindOf(source)) ?? 0) + 1);
  const kinds = KIND_LABELS.filter(([kind]) => (kindCounts.get(kind) ?? 0) > 0);
  const filterOptions: FilterOption<Filter>[] = [
    ...STATUS_FILTERS,
    ...(duplicateCount > 0 || filter === "duplicates" ? [{ value: "duplicates" as const, label: "疑似重复", count: duplicateCount }] : []),
  ];
  const detailsSource = sources?.find(source => source.id === detailsId) ?? null;

  return (
    <div {...dropProps} className="relative h-full">
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg">
          <div className="flex items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface px-6 py-4 text-ui font-medium text-accent">
            <Upload size={16} aria-hidden="true" />
            松开即可上传
          </div>
        </div>
      )}
      <PageShell
        title="知识库"
        width="wide"
        meta={projectName}
        actions={<>
          {hasLibrary && <SearchInput label="搜索资料" value={query} onChange={(event) => setQuery(event.target.value)} className="w-60" />}
          <Button variant="secondary" onClick={() => setConnecting(true)}><Cloud size={16} aria-hidden="true" />连接网盘</Button>
          <Button disabled={!hasWebApi || uploading} loading={uploading} onClick={() => void uploadFiles()}>
            {!uploading && <Upload size={16} aria-hidden="true" />}上传
          </Button>
        </>}
      >
        <div className="flex gap-6">
          {/* The rail answers the question the page could not: whose knowledge
              base is this, and what is in it. A project switch lands back here,
              so browsing another project's library is one click rather than a
              trip through the sidebar. */}
          {hasLibrary && (
            <nav aria-label="项目与类型" className="hidden w-44 shrink-0 space-y-6 lg:block">
              <div>
                <p className="mb-2 text-meta text-text-3">项目</p>
                <ul className="space-y-0.5">
                  {projects.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={item.id === projectId ? "true" : undefined}
                        className={cn(
                          "block w-full truncate rounded px-2 py-1 text-left text-ui",
                          item.id === projectId ? "bg-accent-soft text-accent-strong" : "text-text-2 hover:bg-surface-2 hover:text-text",
                        )}
                        onClick={() => { if (item.id !== projectId) void select(item.id); }}
                      >{item.name}</button>
                    </li>
                  ))}
                </ul>
              </div>
              {kinds.length > 1 && (
                <div>
                  <p className="mb-2 text-meta text-text-3">类型</p>
                  <ul className="space-y-0.5">
                    {[["全部", null, sources?.length ?? 0] as const,
                      ...kinds.map(([value, label]) => [label, value, kindCounts.get(value) ?? 0] as const)].map(([label, value, count]) => (
                      <li key={label}>
                        <button
                          type="button"
                          aria-pressed={kind === value}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-2 py-1 text-left text-ui",
                            kind === value ? "bg-accent-soft text-accent-strong" : "text-text-2 hover:bg-surface-2 hover:text-text",
                          )}
                          onClick={() => setKind(value)}
                        >
                          <span className="truncate">{label}</span>
                          <span className="ml-2 text-meta text-text-3 tabular-nums">{count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </nav>
          )}
          <div className="min-w-0 flex-1">
        {hasLibrary && <FilterChips label="资料状态" className="mb-4" options={filterOptions} value={filter} onChange={setFilter} />}
        {error && <LoadError message={error} onRetry={() => void load()} className="mb-4" />}
        {sources === null ? <FilesSkeleton /> : shown.length === 0 ? (error ? null
          : filter === "all" && kind === null && !needle ? <EmptyState icon={Folder} title="还没有资料。拖进来，或点右上角上传。" />
            : <EmptyState icon={Search} title={needle ? "没有找到相关资料" : filter === "duplicates" ? "没有疑似重复的资料" : "这一类里没有资料"} />
        ) : (
          <List label="资料">
            {shown.map((source) => <SourceRow key={source.id} source={source} busy={busy}
              shared={sharedSources ? sharedSources.has(source.id) : null}
              duplicate={groupOf(source.id)}
              onPreview={() => setPreviewing(source)}
              onDetails={() => setDetailsId(source.id)}
              onDuplicates={() => setDuplicatesFor(source.id)}
              onShare={() => void toggleShared(source)}
              onEdit={() => setEditing(source)}
              onRetry={() => void mutate(() => retrySource(source.id, source.revision))}
              onCancel={() => void mutate(() => cancelSource(source.id, source.revision))}
              onDelete={() => setDeleting(source)} />)}
          </List>
        )}
          </div>
        </div>
      </PageShell>
      {previewing && (
        <Drawer title={baseName(previewing.payload.paths[0] ?? previewing.id)} onClose={() => setPreviewing(null)} widthClassName="max-w-3xl" bare>
          <FilePreviewInspector
            data={{
              variant: "file",
              path: previewing.payload.paths[0] ?? previewing.id,
              filename: baseName(previewing.payload.paths[0] ?? previewing.id),
              artifact: extToKind(extOf(previewing.payload.paths[0] ?? previewing.id)),
              root: "base",
            }}
            kindLabel={formatLabel(baseName(previewing.payload.paths[0] ?? previewing.id))}
            lead={documentSummary(previewing)}
            onClose={() => setPreviewing(null)}
          />
        </Drawer>
      )}
      {detailsSource && (
        <Drawer title={baseName(detailsSource.payload.paths[0] ?? detailsSource.id)} onClose={() => setDetailsId(null)} widthClassName="max-w-3xl">
          <SourceDetails source={detailsSource} projectId={projectId}
            onRaiseDepth={() => { setDetailsId(null); setEditing(detailsSource); }} />
        </Drawer>
      )}
      {editing && (
        <Drawer title="调整分析" description={baseName(editing.payload.paths[0] ?? editing.id)} onClose={() => setEditing(null)}>
          <EditSource source={editing} busy={busy} onCancel={() => setEditing(null)}
            onSave={(input) => void mutate(() => overrideSource(editing.id, input))} />
        </Drawer>
      )}
      {connecting && (
        <Drawer title="连接网盘" onClose={() => setConnecting(false)} widthClassName="max-w-2xl">
          <div className="space-y-8">
            <OpenListBrowser projectId={projectId} onImported={() => load()}
              onFolderRegistered={() => setFolderRefresh((value) => value + 1)} />
            <SyncedFolders projectId={projectId} refreshToken={folderRefresh} />
          </div>
        </Drawer>
      )}
      {duplicatesFor && (
        <Drawer title="疑似重复" onClose={() => setDuplicatesFor(null)}>
          <DuplicateGroups groups={(groups ?? []).filter(group => !group.decision && group.sourceIds.includes(duplicatesFor))} busy={busy} onDecide={decide} />
        </Drawer>
      )}
      {deleting && <ConfirmDialog title="删除这份资料？" body="删除后不再用于回答。"
        confirmLabel="删除" onCancel={() => setDeleting(null)} onConfirm={() => void mutate(() => removeSource(deleting.id, deleting.revision))} />}
    </div>
  );
}

/** Whether a document answers the search: its file name, or the title and
 *  authors the parser read from it. */
function matches(source: SourceRecord, needle: string): boolean {
  const metadata = source.payload.metadata;
  return [...source.payload.paths.map(baseName), metadata?.title ?? "", ...(metadata?.authors ?? [])]
    .some((text) => text.toLowerCase().includes(needle));
}

/**
 * The document's summary, shown above its preview: what the understanding
 * says the document is and says. Undefined while there is no understanding
 * yet — the parser's opening lines are the document's own text, not a summary
 * of it — and then the preview has nothing above it.
 */
function documentSummary(source: SourceRecord) {
  const summary = source.payload.currentUnderstandingId ? source.payload.outputs?.summary?.trim() : "";
  if (!summary) return undefined;
  return (
    <Disclosure summary="摘要" defaultOpen>
      <p className="max-h-40 max-w-measure-body overflow-auto whitespace-pre-wrap text-ui text-text">{summary}</p>
    </Disclosure>
  );
}

function SourceIcon({ name }: { name: string }) {
  const kind = previewKindForName(name);
  const Icon = kind === "image" ? ImageIcon : kind === "table" || kind === "xlsx" ? Sheet : FileText;
  return <Icon size={20} className="shrink-0 text-text-3" aria-hidden="true" />;
}

/**
 * One document. The row opens its preview; its format and length are under
 * the name, and the day it arrived — or, when something went wrong, what went
 * wrong — at the end. Everything one can do to it is in 「⋯」.
 */
function SourceRow({ source, busy, shared, duplicate, onPreview, onDetails, onDuplicates, onShare, onEdit, onRetry, onCancel, onDelete }: {
  source: SourceRecord; busy: boolean; shared: boolean | null; duplicate: DuplicateGroup | null;
  onPreview: () => void; onDetails: () => void; onDuplicates: () => void; onShare: () => void; onEdit: () => void;
  onRetry: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const name = baseName(source.payload.paths[0] ?? source.id);
  const status = source.payload.status;
  const reading = isReading(source);
  const items: MenuEntry[] = [
    ...(duplicate ? [{ label: "处理疑似重复", onSelect: onDuplicates }] : []),
    ...(shared === true ? [{ label: "改为仅本项目", onSelect: onShare }] : []),
    ...(shared === false && isUsable(source) ? [{ label: "所有项目可用", onSelect: onShare }] : []),
    { label: "调整分析", onSelect: onEdit },
    ...(RETRYABLE.includes(status) ? [{ label: "重新读取", onSelect: onRetry }] : []),
    ...(reading ? [{ label: "取消读取", onSelect: onCancel }] : []),
    { label: "查看理解", onSelect: onDetails },
    "separator",
    { label: "删除", onSelect: onDelete, destructive: true },
  ];
  return (
    <ListRow
      leading={<SourceIcon name={name} />}
      title={<span className="block truncate" title={name}>{name}</span>}
      onOpen={onPreview}
      meta={<SourceMeta source={source} name={name} shared={shared === true} duplicate={duplicate !== null} />}
      trailing={<SourceState source={source} name={name} busy={busy} onRetry={onRetry} />}
      menu={<Menu label={`「${name}」的操作`} items={items.map((item) => item === "separator" ? item : { ...item, disabled: busy })} />}
    />
  );
}

/** 「PDF · 14 页」, the title the parser read when it is not the file name,
 *  and the two tags a row may wear. */
function SourceMeta({ source, name, shared, duplicate }: { source: SourceRecord; name: string; shared: boolean; duplicate: boolean }) {
  const pages = source.payload.analysis?.pageCount;
  const title = source.payload.metadata?.title?.trim();
  const stem = name.replace(/\.[^.]+$/, "");
  const parts = [
    formatLabel(name),
    pages ? `${pages} 页` : humanSize(source.payload.fingerprint?.size),
    title && title !== stem && title !== name ? `《${title}》` : "",
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
      {shared && <Tag>所有项目</Tag>}
      {duplicate && <Tag>疑似重复</Tag>}
    </span>
  );
}

/**
 * The end of a row: the day the document arrived once it can be used, and
 * words while it cannot — 「读取中…」 for the few seconds its text is read,
 * 「没能读取」 when it could not be, 「部分没能读取」 when parts of it could
 * not, the last two with 「重试」 beside them. The reason a reading failed is
 * the words' tooltip and the first line of 「查看理解」. An understanding that
 * failed after the text was read leaves a usable document, and the row says
 * nothing about it.
 */
function SourceState({ source, name, busy, onRetry }: { source: SourceRecord; name: string; busy: boolean; onRetry: () => void }) {
  // `/api/me` is read once and shared, so a row asking costs nothing more —
  // and an empty library asks nothing at all.
  const operator = useOperator();
  const label = stateLabel(source);
  if (isReading(source)) return <span className="text-text-3">读取中…</span>;
  if (label === "没能读取" || label === "部分没能读取") {
    const failed = label === "没能读取";
    const failure = source.payload.error;
    // The code is the handle support searches on: an operator gets it after
    // the sentence, a researcher only the sentence.
    const reason = failed ? sourceFailureMessage(failure) : null;
    const tooltip = reason && operator && failure ? `${reason}（${failure.code}）` : reason ?? undefined;
    return (
      <span className={cn("inline-flex items-center gap-1", failed ? "text-danger" : "text-warn")}>
        <span title={tooltip}>{label}</span>
        <span aria-hidden="true">·</span>
        <Button variant="text" size="sm" destructive={failed} disabled={busy} aria-label={`重新读取「${name}」`} onClick={onRetry} className="px-1 text-caption">重试</Button>
      </span>
    );
  }
  if (label) return <span>{label}</span>;
  return <span className="tabular-nums">{formatDay(source.createdAt)}</span>;
}

/**
 * What 「查看理解」 opens: what the parser read about the document, the
 * understanding and its history, and — when there is more than one — its
 * versions. The omission notice sits here rather than on the row: it is the
 * one thing in the audit a researcher can act on.
 */
function SourceDetails({ source, projectId, onRaiseDepth }: { source: SourceRecord; projectId: string; onRaiseDepth: () => void }) {
  const name = baseName(source.payload.paths[0] ?? source.id);
  return (
    <div className="space-y-6">
      <SourceFacts metadata={source.payload.metadata} pageCount={source.payload.analysis?.pageCount} fileName={name} />
      <OmissionNotice notice={source.payload.omissionNotice} onRaiseDepth={onRaiseDepth} />
      <SourceUnderstandingPanel key={source.id} projectId={projectId} sourceId={source.id}
        generation={source.payload.generation} error={source.payload.error} />
      <VersionChain sourceId={source.id} />
    </div>
  );
}

/** What the parser read about the document: its title, authors, where and
 *  when it was published and how long it is. Nothing when it read nothing. */
export function SourceFacts({ metadata, pageCount, fileName }: { metadata?: SourceMetadata | null; pageCount?: number; fileName: string }) {
  const title = metadata?.title?.trim();
  const authors = metadata?.authors?.filter(Boolean) ?? [];
  const published = [metadata?.source, metadata?.publicationDate].filter(Boolean).join("，");
  const parts = [
    title && title !== fileName ? `《${title}》` : null,
    authors.length ? `${authors.slice(0, 3).join("、")}${authors.length > 3 ? " 等" : ""}` : null,
    published || null,
    pageCount ? `共 ${pageCount} 页` : null,
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return null;
  return <p className="max-w-measure text-caption text-text-3">{parts.join(" · ")}</p>;
}

/** A rate as a percentage the notice can state without inventing precision the
 * audit does not have: the notice's rates are fractions of a bounded sample. */
function percent(value: number) { return `${Math.round(value * 1000) / 10}%`; }

/** The omission audit's own reading of a *delivered* understanding.
 *
 * Observation phase, and shown as one. `sourceUnderstandingOmissionNotice`
 * returns `blocking:false`, appears in no issue list, and its 5%/15% targets
 * have never been checked against an observed distribution of real sources —
 * per the development principles a new check ships as a notice first. So this
 * says what was measured and offers the one thing a researcher can do about
 * it. `disagreements` are the control plane's own English diagnostics; an
 * operator gets them as a count, a researcher not at all. */
function OmissionNotice({ notice, onRaiseDepth }: { notice?: SourceOmissionNotice | null; onRaiseDepth: () => void }) {
  const operator = useOperator();
  if (!notice) return null;
  const over = notice.withinTarget === false && typeof notice.omissionRate === "number" ? notice.omissionRate : null;
  const disagreements = notice.disagreements?.length ?? 0;
  if (over === null && !(operator && disagreements)) return null;
  return <div className="space-y-2 text-ui text-text">
    {over !== null && <div className="flex flex-wrap items-center gap-3 rounded bg-surface-1 px-3 py-2">
      <p className="min-w-0 max-w-measure flex-1">抽查 {notice.audited} 个片段，约 {percent(over)} 的内容没有被理解进来，高于当前分析深度的参考值 {percent(notice.target)}。</p>
      <Button size="sm" variant="secondary" onClick={onRaiseDepth}>提高分析深度</Button>
    </div>}
    {operator && disagreements > 0 && <p className="text-caption text-text-3" title={notice.disagreements.join("\n")}>
      运行自报的审计与它实际交付的引用至少有 {disagreements} 处对不上；遗漏率按交付内容重算。</p>}
  </div>;
}

/** The versions of one document, when it has more than one. */
function VersionChain({ sourceId }: { sourceId: string }) {
  const [family, setFamily] = useState<SourceFamily | null>(null);
  const headingId = useId();
  useEffect(() => {
    let active = true;
    // The chain is extra: a document whose family cannot be read is still
    // readable, so a failure here shows nothing rather than an error.
    getSourceFamily(sourceId).then((value) => { if (active) setFamily(value); }).catch(() => { /* optional section */ });
    return () => { active = false; };
  }, [sourceId]);
  if (!family || family.items.length < 2) return null;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1 text-ui font-semibold text-text">版本</h3>
      <List>
        {family.items.map((item) => (
          <ListRow
            key={item.id}
            title={`第 ${item.payload.version} 版`}
            meta={[formatDay(item.updatedAt), stateLabel(item)].filter(Boolean).join(" · ")}
            trailing={item.id === sourceId ? <Tag>当前</Tag> : undefined}
          />
        ))}
      </List>
    </section>
  );
}

/** The researcher's own reason for their last adjustment, when there is one.
 *  The classifier's rationale is the pipeline's English note to itself. */
function lastOverrideReason(source: SourceRecord): string | null {
  const reason = source.payload.reasons.find((value) => value.startsWith("User override: "));
  return reason ? reason.slice("User override: ".length).trim() || null : null;
}

function EditSource({ source, busy, onSave, onCancel }: { source: SourceRecord; busy: boolean;
  onSave: (input: { expectedRevision: number; docType: string; depth: string; reason: string }) => void; onCancel: () => void }) {
  const [docType, setDocType] = useState(source.payload.docType);
  const [depth, setDepth] = useState(source.payload.depth);
  const [reason, setReason] = useState("");
  const typeId = useId();
  const depthId = useId();
  const previous = lastOverrideReason(source);
  return <form className="grid gap-4" onSubmit={(event) => {
    event.preventDefault(); onSave({ expectedRevision: source.revision, docType, depth, reason });
  }}>
    {previous && <p className="text-caption text-text-3">上次调整：{previous}</p>}
    <div>
      <label htmlFor={typeId} className="mb-2 block text-ui font-medium text-text">资料类型</label>
      <select id={typeId} value={docType} onChange={(event) => setDocType(event.target.value)} className={inputClasses()}>
        {TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    <div>
      <label htmlFor={depthId} className="mb-2 block text-ui font-medium text-text">分析深度</label>
      <select id={depthId} value={depth} onChange={(event) => setDepth(event.target.value as SourceRecord["payload"]["depth"])} className={inputClasses()}>
        {DEPTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    <Input label="调整原因" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} />
    <div className="flex gap-2"><Button type="submit" loading={busy}>保存并重新分析</Button><Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}

/**
 * The researcher's own cloud drive, browsed a folder at a time: a folder
 * opens, a file is imported, and a folder can be registered to sync. A file the
 * drive gives no content fingerprint for cannot be imported from here.
 */
export function OpenListBrowser({ projectId, onImported, onFolderRegistered }: { projectId: string;
  onImported: () => Promise<void> | void; onFolderRegistered: () => void }) {
  const [remotePath, setRemotePath] = useState("/");
  const [entries, setEntries] = useState<OpenListEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  /** One drive request at a time; a late answer for a page the reader left is dropped. */
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    const valid = () => request.current === current && getWebProjectId() === projectId;
    setBusy(true);
    try { await operation(valid); }
    catch (error) { if (valid()) toast.error(productErrorMessage(error)); }
    finally { if (valid()) setBusy(false); }
  };
  const browse = (selected = remotePath) => run(async (valid) => {
    try { const page = await browseOpenList(projectId, selected); if (valid()) { setRemotePath(selected); setEntries(page.entries); } }
    catch (error) { if (valid()) setEntries([]); throw error; }
  });
  const importFile = (selected: string) => run(async (valid) => { await importOpenListSource(projectId, selected); if (valid()) await onImported(); });
  const registerFolder = (selected: string) => run(async (valid) => { await registerSourceFolder(projectId, selected); if (valid()) onFolderRegistered(); });
  const parent = remotePath === "/" ? "/" : remotePath.split("/").slice(0, -1).join("/") || "/";
  return <section aria-labelledby={headingId}>
    <h3 id={headingId} className="mb-3 text-ui font-semibold text-text">网盘资料</h3>
    <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
      <div className="min-w-0 flex-1"><Input label="网盘路径" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} /></div>
      <Button type="submit" loading={busy}>浏览</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void registerFolder(remotePath)}><FolderSync size={16} aria-hidden="true" />同步此文件夹</Button>
    </form>
    {entries && <List className="mt-3">
      {remotePath !== "/" && <ListRow leading={<CornerLeftUp size={16} className="text-text-3" aria-hidden="true" />} title="返回上级" onOpen={() => void browse(parent)} />}
      {entries.length === 0 ? <li className="px-2 py-3 text-ui text-text-3">这里没有可导入的资料。</li> : entries.map((entry) => entry.entryType === "dir"
        ? <ListRow key={entry.path} leading={<Folder size={16} className="text-text-3" aria-hidden="true" />} title={entry.name} onOpen={() => void browse(entry.path)}
          actions={<Button variant="text" size="sm" disabled={busy} onClick={() => void registerFolder(entry.path)}><FolderSync size={16} aria-hidden="true" />同步</Button>} />
        : <ListRow key={entry.path} leading={<FileText size={16} className="text-text-3" aria-hidden="true" />} title={entry.name}
          trailing={entry.providerHash?.startsWith("sha256:")
            ? <Button variant="text" size="sm" disabled={busy} onClick={() => void importFile(entry.path)}>导入</Button>
            : <span>不支持此文件</span>} />)}
    </List>}
  </section>;
}

// Every code the folder sync can record as a skip reason. `openlist_sha256_required`
// is not one of them: the sync filters on the SHA-256 pattern before it ever
// builds a manifest, so that code cannot reach this list.
const SKIP_REASONS: Record<string, string> = {
  provider_hash_unsupported: "网盘无法提供内容指纹",
  entry_budget_exhausted: "超出本文件夹的跟踪上限",
  source_scope_conflict: "同样内容已属于其他项目",
  source_payload_invalid: "文件路径或属性不合规",
  source_path_invalid: "文件路径或属性不合规",
  source_digest_invalid: "网盘给出的内容指纹不合规",
  source_size_invalid: "文件大小超出可入库范围",
  source_connector_invalid: "网盘条目无法映射成资料",
  source_format_unsupported: "知识库不支持这种文件格式",
  source_media_unsupported: "音视频暂不支持解析",
};

/** A researcher reads Chinese. An unmapped code is a sentence here, not a token
 * copied out of the server. */
function skipReason(code: string) { return SKIP_REASONS[code] ?? "这一项无法入库"; }

/**
 * The folders registered to sync, one row each: its name, how its last sync
 * went, a switch that pauses and resumes it, and 「立即同步」 on hover. Syncing
 * runs when the researcher registers, resumes or asks for it; nothing polls.
 */
export function SyncedFolders({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
  const operator = useOperator();
  const [folders, setFolders] = useState<SourceFolderRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const request = useRef(0);
  const load = useCallback(async () => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    setLoadError(null);
    try {
      const page = await listSourceFolders(projectId);
      if (request.current === current && getWebProjectId() === projectId) setFolders(page.items);
    } catch (error) {
      if (request.current === current && getWebProjectId() === projectId) { setFolders([]); setLoadError(productErrorMessage(error)); }
    }
  }, [projectId]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load, refreshToken]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await load(); }
    catch (error) { toast.error(productErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby={headingId}>
    <h3 id={headingId} className="mb-1 text-ui font-semibold text-text">同步文件夹</h3>
    {loadError ? <LoadError message={loadError} onRetry={() => void load()} />
      : folders === null ? <FilesSkeleton />
        : folders.length === 0 ? <p className="py-2 text-ui text-text-3">暂无同步文件夹</p>
          : <List>{folders.map((folder) => {
            // The folder's own name, not the connector id it is stored under
            // (which is the gateway path, tenant namespace and all).
            const path = displayPath(folder.payload.connector.id);
            const name = baseName(path);
            const active = folder.payload.status === "active";
            return <ListRow
              key={folder.id}
              leading={<Folder size={20} className="text-text-3" aria-hidden="true" />}
              title={<span title={path}>{name}</span>}
              meta={<FolderSyncLine folder={folder} operator={operator} />}
              actions={<IconButton icon={RefreshCw} label="立即同步" size="sm" disabled={busy || !active}
                onClick={() => void mutate(() => syncSourceFolder(folder.id, folder.revision))} />}
              trailing={<Switch checked={active} label={`同步「${name}」`} disabled={busy}
                onChange={(on) => void mutate(() => setSourceFolderStatus(folder.id, folder.revision, on ? "active" : "paused"))} />}
            />;
          })}</List>}
  </section>;
}

/**
 * How a folder's last sync went. `lastSync` is written only on the success
 * path, so on its own it says a folder that has been failing for a week is
 * healthy; `lastError`, when present, is what is said instead. What a run
 * skipped is folded under its count — the list holds examples, the count is
 * the total.
 */
function FolderSyncLine({ folder, operator }: { folder: SourceFolderRecord; operator: boolean }) {
  const sync = folder.payload.lastSync;
  const lastError = folder.payload.lastError;
  return <div className="space-y-0.5">
    {lastError
      ? <p className="text-danger" title={operator ? lastError.code : undefined}>上次同步失败：{sourceFailureMessage(lastError)}</p>
      : <p>{sync ? `上次同步${sync.at ? ` ${formatDay(sync.at)} ${formatClock(sync.at)}` : ""} · 新增 ${sync.registered}` : "尚未同步"}</p>}
    {sync && sync.skippedCount > 0 && <Disclosure summary={`跳过 ${sync.skippedCount} 项`} summaryClassName="text-caption">
      <ul className="space-y-0.5">
        {sync.skipped.slice(0, 5).map((item) => <li key={item.path}>{baseName(item.path)}（{skipReason(item.reason)}）</li>)}
      </ul>
    </Disclosure>}
  </div>;
}

const DUPLICATE_KINDS: Record<string, string> = {
  "version-family": "同一路径的多个版本",
  "shared-content": "同样内容出现在多个路径",
  "similar-name": "文件名归一化后相同",
};

/** The groups a row's 「处理疑似重复」 opened: what each holds and the two decisions. */
function DuplicateGroups({ groups, busy, onDecide }: { groups: DuplicateGroup[]; busy: boolean; onDecide: (group: DuplicateGroup, decision: "linked" | "dismissed") => void }) {
  if (groups.length === 0) return <p className="text-ui text-text-3">没有发现疑似重复的资料。</p>;
  return <div className="divide-y divide-border">{groups.map((group) => <section key={group.groupKey} className="space-y-2 py-4 first:pt-0">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <h3 className="min-w-0 flex-1 truncate text-ui font-medium text-text">{baseName(group.label)}</h3>
      <span className="text-caption text-text-3">{labelFor(DUPLICATE_KINDS, group.kind, "其他相似情况")}</span>
    </div>
    <ul className="space-y-0.5 text-caption text-text-3">{group.members.map((item) => <li key={item.sourceId}>
      {[item.paths.map(baseName).join("、"), formatDay(item.updatedAt)].filter(Boolean).join(" · ")}
    </li>)}</ul>
    {group.decision && <p className="text-caption text-text-3">已标记为{group.decision.decision === "linked" ? "同一份资料" : "不是重复"}</p>}
    <div className="flex flex-wrap gap-2">
      {/* Linking is a statement about two sources. A shared-content group is
          one source under several paths, so there is nothing to link. */}
      {group.sourceIds.length > 1 && <Button size="sm" variant="secondary" disabled={busy}
        onClick={() => onDecide(group, "linked")}><Link2 size={16} aria-hidden="true" />标记为同一份</Button>}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(group, "dismissed")}><XCircle size={16} aria-hidden="true" />不是重复</Button>
    </div>
  </section>)}</div>;
}
