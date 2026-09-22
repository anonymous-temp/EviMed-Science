import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Cloud, Copy, Database, FilePlus2, FileSearch, FileText, Folder, FolderSync, Image as ImageIcon, Link2, Loader2, MoreHorizontal, Pause, Play, RefreshCw, Sheet, Upload, XCircle } from "lucide-react";
import { getWebProjectId, hasWebApi, webErrorMessage } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { addToLibrary, browseOpenList, cancelSource, decideDuplicateGroup, getSourceFamily, importOpenListSource, listDuplicateCandidates,
  listLibrary, listSourceFolders, listSources, overrideSource, registerSourceFolder, removeFromLibrary, removeSource, retrySource,
  setSourceFolderStatus, sourceFailureMessage, syncSourceFolder, type DuplicateGroup, type OpenListEntry, type SourceFamily,
  type SourceFolderRecord, type SourceMetadata, type SourceOmissionNotice, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { baseName } from "@/lib/format";
import { extOf, extToKind, previewKindForName } from "@/lib/artifacts";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { useFileDrop } from "@/lib/useFileDrop";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { SourceUnderstandingPanel } from "@/components/sources/SourceUnderstandingPanel";
import { PageHeader } from "@/components/layout/PageHeader";
import { labelFor } from "@/lib/statusLabel";
import { useOperator } from "@/lib/useOperator";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "./FilesPage";

const STATUS: Record<string, string> = {
  queued: "等待分析", parsing: "正在解析", complete: "已完成", needs_attention: "需要你看一下",
  failed: "分析失败", missing: "原始资料已移除", canceled: "已取消",
};
/** The tone a status badge wears: quiet for the ordinary, accent while working, warn when a person is needed. */
const STATUS_TONE: Record<string, string> = {
  queued: "text-muted", parsing: "text-accent", complete: "text-ok", needs_attention: "text-warn",
  failed: "text-error", missing: "text-muted", canceled: "text-muted",
};
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
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_OPTIONS);
const DEPTH_LABEL: Record<string, string> = Object.fromEntries(DEPTH_OPTIONS);

/** Where an upload lands, and the folder the list is of. */
const KNOWLEDGE_ROOT = "knowledge-base";

/** A synced folder's path as the researcher typed it: the tenant namespace the
 *  gateway prefixes is the platform's, not theirs (review B, SourcesPage). */
function displayPath(path: string) {
  return path.replace(/^\/tenants\/[^/]+/, "") || "/";
}

/** How much of this project's material still needs something. What 知识库
 *  says as one line at the top. */
export interface SourceProgress {
  needsAttention: number;
  working: number;
}

type Filter = "all" | "needs_attention" | "parsing" | "complete" | "duplicates";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "needs_attention", label: "需要处理" },
  { value: "parsing", label: "分析中" },
  { value: "complete", label: "已完成" },
  { value: "duplicates", label: "疑似重复" },
];

/**
 * The knowledge base: one list of the documents in it, each row carrying its
 * own state, with upload at the top and everything else behind the row.
 *
 * Until 2026-09-22 this was a stack of cards — every document a card with its
 * summary, classification reason, coverage and eight buttons — over a second
 * component that browsed the same folder as a file tree beside a preview
 * pane, so an empty knowledge base showed three empty states at once, and
 * 「疑似重复」 was a button at the top that opened a third list. The owner's
 * reading was 「乱」, and that a duplicate is a badge on the row, not a
 * separate desk. NotebookLM, Claude Projects and ChatGPT keep sources as one
 * list with a status per row and a single add button; so does this.
 *
 * @param embedded rendered as part of 知识库 rather than as its own
 *  destination, so the page above it owns the title.
 * @param onProgress told what still needs attention, so the page above can say
 *  so once instead of keeping a tab for it.
 */
export function SourcesPage({ embedded = false, onProgress }: { embedded?: boolean; onProgress?: (progress: SourceProgress) => void } = {}) {
  // Store fallback repairs do not reload the document. Subscribe to those
  // repairs, while the tab's current selection still owns in-flight requests.
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ProjectSourcesPage key={projectId} projectId={projectId} embedded={embedded} onProgress={onProgress} />;
}

function ProjectSourcesPage({ projectId, embedded, onProgress }: { projectId: string; embedded: boolean; onProgress?: (progress: SourceProgress) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SourceRecord | null>(null);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [previewing, setPreviewing] = useState<SourceRecord | null>(null);
  const [understandingId, setUnderstandingId] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [showOpenList, setShowOpenList] = useState(false);
  const [duplicatesFor, setDuplicatesFor] = useState<string | null>(null);
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generation = useRef(0);
  const loadingRequest = useRef<number | null>(null);
  const load = useCallback(async (background = false) => {
    if (getWebProjectId() !== projectId || (background && loadingRequest.current != null)) return;
    const current = ++generation.current;
    loadingRequest.current = current;
    if (!background) { setSources(null); setError(null); }
    try {
      const page = await listSources(projectId, { status: filter === "all" || filter === "duplicates" ? "" : filter });
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
  const processing = sources?.some(source => ["queued", "parsing"].includes(source.payload.status)) ?? false;
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
  const mutate = async (operation: () => Promise<unknown>) => {
    if (getWebProjectId() !== projectId) return;
    setBusy(true);
    setActionError(null);
    try {
      await operation();
      if (getWebProjectId() !== projectId) return;
      setEditing(null); setDeleting(null); await load();
    } catch (operationError) { if (getWebProjectId() === projectId) setActionError(productErrorMessage(operationError)); }
    finally { if (getWebProjectId() === projectId) setBusy(false); }
  };
  const selectedSource = sources?.find(source => source.id === understandingId);
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
    setActionError(null);
    try {
      if (sharedSources?.has(source.id)) await removeFromLibrary(source.id);
      else await addToLibrary(source.id);
      await loadShared();
    } catch (operationError) { if (getWebProjectId() === projectId) setActionError(productErrorMessage(operationError)); }
    finally { if (getWebProjectId() === projectId) setBusy(false); }
  };
  // The duplicate groups, read once per list and again after a decision: a
  // row in an undecided group wears the badge; the filter lists only those.
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const loadGroups = useCallback(async () => {
    if (getWebProjectId() !== projectId) return;
    try { const page = await listDuplicateCandidates(projectId); if (getWebProjectId() === projectId) setGroups(page.items); }
    catch { if (getWebProjectId() === projectId) setGroups([]); }
  }, [projectId]);
  useEffect(() => { void loadGroups(); }, [loadGroups, sources]);
  const groupOf = (sourceId: string) => groups?.find(group => !group.decision && group.sourceIds.includes(sourceId)) ?? null;
  const duplicateCount = sources?.filter(source => groupOf(source.id)).length ?? 0;
  const decide = async (group: DuplicateGroup, decision: "linked" | "dismissed") => {
    setBusy(true); setActionError(null);
    try { await decideDuplicateGroup({ projectId, groupKey: group.groupKey, sourceIds: group.sourceIds, decision }); await loadGroups(); }
    catch (operationError) { setActionError(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };
  // What the page above says as one line, and only when it is true.
  useEffect(() => {
    if (!onProgress) return;
    onProgress({
      needsAttention: sources?.filter(source => source.payload.status === "needs_attention").length ?? 0,
      working: sources?.filter(source => ["queued", "parsing"].includes(source.payload.status)).length ?? 0,
    });
  }, [sources, onProgress]);

  // Upload: the one primary action, and the whole list is its drop target.
  const uploadFiles = async (dropped?: File[]) => {
    setUploading(true);
    try {
      const { accepted, refused } = partitionKnowledgeBaseFiles(dropped ?? await pickFiles(KNOWLEDGE_BASE_ACCEPT));
      if (refused.length > 0) {
        toast.error(`没有上传：${refused.map((file) => `${file.name}（${file.reason}）`).join("、")}。${KNOWLEDGE_BASE_UPLOAD_HINT}`);
      }
      const names = accepted.length > 0 ? await uploadFilesToWorkspace(accepted, KNOWLEDGE_ROOT, "base") : [];
      if (names.length > 0) {
        toast.success(`已上传 ${names.length} 个文件，正在解析。`);
        await load(true);
      }
    } catch (e) {
      toast.error(`文件上传失败：${webErrorMessage(e)}`);
    } finally {
      setUploading(false);
    }
  };
  const { dragging, dropProps } = useFileDrop({ disabled: !hasWebApi, onDrop: (files) => void uploadFiles(files) });

  const shown = (sources ?? []).filter(source => filter !== "duplicates" || groupOf(source.id));
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" onClick={() => setShowOpenList(true)} title="从你的网盘导入或持续同步一个文件夹"><Cloud size={14} aria-hidden="true" />连接网盘</Button>
      <Button size="sm" disabled={!hasWebApi || uploading} loading={uploading} onClick={() => void uploadFiles()} title={KNOWLEDGE_BASE_UPLOAD_HINT}>
        {!uploading && <Upload size={14} aria-hidden="true" />}上传资料
      </Button>
    </div>
  );

  return (
    <div {...dropProps} className={cn("relative", embedded ? undefined : "h-full overflow-y-auto px-5 py-6")}>
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface px-6 py-4 text-ui font-medium text-accent">
            <Upload size={15} aria-hidden="true" />
            松开以上传到知识库
          </div>
        </div>
      )}
      <div className={embedded ? "space-y-4" : "mx-auto max-w-content-wide space-y-4"}>
        {!embedded && <PageHeader title="知识库" description="你放进来的资料：文献、方案、数据。" actions={actions} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="radiogroup" aria-label="资料状态" className="flex flex-wrap items-center gap-1">
            {FILTERS.map((option) => {
              const selected = filter === option.value;
              const count = option.value === "duplicates" ? duplicateCount : null;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-full border px-3 text-ui transition-colors duration-fast",
                    selected ? "border-text bg-surface-2 font-medium text-text" : "border-border bg-surface text-muted hover:border-strong hover:text-text",
                  )}
                >
                  {option.label}
                  {count ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-warn-soft px-1 text-badge tabular-nums text-warn">{count}</span> : null}
                </button>
              );
            })}
          </div>
          {embedded && actions}
        </div>
        {error && <Card><div className="flex items-center gap-2 text-ui text-error"><AlertCircle size={16} aria-hidden="true" /><span className="flex-1">{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}
        {/* A failed delete or re-analysis is not a failed read: it used to
            overwrite the page error, whose 「重试」 re-listed the page instead of
            retrying the action (review B, SourcesPage P1). */}
        {actionError && <div role="alert" className="flex items-center gap-2 rounded-card border border-danger bg-danger-soft px-3 py-2 text-ui text-danger-strong">
          <AlertCircle size={16} aria-hidden="true" /><span className="flex-1">{actionError}</span>
          <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>知道了</Button></div>}
        {sources === null ? <MemorySkeleton /> : shown.length === 0 && !error ? (
          filter === "all"
            ? <EmptyState icon={Database} title="知识库还是空的"
              description={`把文献、方案或数据放进来，EviMed 回答和做研究时会去读。${KNOWLEDGE_BASE_UPLOAD_HINT}`}
              action={<Button disabled={!hasWebApi || uploading} onClick={() => void uploadFiles()}><Upload size={14} aria-hidden="true" />上传资料</Button>} />
            : <EmptyState icon={Database} title={filter === "duplicates" ? "没有疑似重复的资料" : "这一类里没有资料"} />
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {shown.map((source) => <SourceRow key={source.id} source={source} busy={busy}
              shared={sharedSources ? sharedSources.has(source.id) : null}
              duplicate={groupOf(source.id)}
              chainOpen={chainId === source.id}
              onPreview={() => setPreviewing(source)}
              onDuplicates={() => setDuplicatesFor(source.id)}
              onShare={() => void toggleShared(source)}
              onUnderstanding={() => setUnderstandingId(source.id)}
              onEdit={() => setEditing(source)} onRaiseDepth={() => setEditing(source)}
              onRetry={() => void mutate(() => retrySource(source.id, source.revision))}
              onCancel={() => void mutate(() => cancelSource(source.id, source.revision))}
              onChain={() => setChainId(chainId === source.id ? null : source.id)}
              onDelete={() => setDeleting(source)} />)}
          </ul>
        )}
      </div>
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
            onClose={() => setPreviewing(null)}
          />
        </Drawer>
      )}
      {selectedSource && (
        <Drawer title="资料理解" onClose={() => setUnderstandingId(null)} widthClassName="max-w-3xl" bare>
          <div className="h-full overflow-y-auto p-4">
            <SourceUnderstandingPanel key={selectedSource.id} projectId={projectId} sourceId={selectedSource.id}
              sourceName={baseName(selectedSource.payload.paths[0] ?? selectedSource.id)} generation={selectedSource.payload.generation}
              error={selectedSource.payload.error} onClose={() => setUnderstandingId(null)} />
          </div>
        </Drawer>
      )}
      {editing && (
        <Drawer title="调整分析" description={baseName(editing.payload.paths[0] ?? editing.id)} onClose={() => setEditing(null)}>
          <EditSource source={editing} busy={busy} onCancel={() => setEditing(null)}
            onSave={(input) => void mutate(() => overrideSource(editing.id, input))} />
        </Drawer>
      )}
      {showOpenList && (
        <Drawer title="连接网盘" description="从你自己的网盘空间导入资料，或注册一个文件夹持续同步。" onClose={() => setShowOpenList(false)} widthClassName="max-w-2xl">
          <div className="space-y-5">
            <OpenListBrowser projectId={projectId} busy={busy} setBusy={setBusy} onImported={load}
              onFolderRegistered={() => setFolderRefresh((value) => value + 1)} onError={setActionError} />
            <SyncedFolders projectId={projectId} refreshToken={folderRefresh} onError={setActionError} />
          </div>
        </Drawer>
      )}
      {duplicatesFor && (
        <Drawer title="疑似重复" description="只按哈希、版本家族、文件大小和归一化文件名判断，不做语义比对。" onClose={() => setDuplicatesFor(null)}>
          <DuplicateGroups groups={(groups ?? []).filter(group => !group.decision && group.sourceIds.includes(duplicatesFor))} busy={busy} onDecide={decide} />
        </Drawer>
      )}
      {deleting && <ConfirmDialog title="删除资料分析记录？" body="原始文件仍由知识库管理；来源索引和后续派生理解会停止使用。"
        confirmLabel="删除记录" onCancel={() => setDeleting(null)} onConfirm={() => void mutate(() => removeSource(deleting.id, deleting.revision))} />}
    </div>
  );
}

function iconFor(name: string) {
  const kind = previewKindForName(name);
  const cls = "shrink-0 text-muted";
  if (kind === "image") return <ImageIcon size={16} className={cls} aria-hidden="true" />;
  if (kind === "table") return <Sheet size={16} className={cls} aria-hidden="true" />;
  return <FileText size={16} className={cls} aria-hidden="true" />;
}

/**
 * One document: its name, what was read about it, its state, and the badges
 * that need a person — behind a menu, everything one can do to it.
 */
function SourceRow({ source, busy, shared, duplicate, chainOpen, onPreview, onDuplicates, onShare, onEdit, onRaiseDepth, onRetry, onCancel, onChain, onDelete, onUnderstanding }: {
  source: SourceRecord; busy: boolean; shared: boolean | null; duplicate: DuplicateGroup | null; chainOpen: boolean;
  onPreview: () => void; onDuplicates: () => void; onShare: () => void; onEdit: () => void; onRaiseDepth: () => void;
  onRetry: () => void; onCancel: () => void; onChain: () => void; onDelete: () => void; onUnderstanding: () => void;
}) {
  const operator = useOperator();
  const name = baseName(source.payload.paths[0] ?? source.id);
  const coverage = source.payload.coverage;
  const accountedPercent = coverage ? coverage.accountedPercent ?? Math.round((coverage.accounted / Math.max(1, coverage.total)) * 100) : 0;
  const status = source.payload.status;
  const statusText = status === "parsing" && source.payload.analysis?.phase === "understanding" ? "正在理解资料" : labelFor(STATUS, status);
  const audit = source.payload.omissionAudit;
  const failure = source.payload.error;
  const auditLabel = !audit || audit.status === "not_run" ? "理解遗漏尚未审计"
    : typeof audit.omissionRate === "number" ? `理解遗漏 ${Math.round(audit.omissionRate * 100)}%`
      : labelFor({ not_run: "理解遗漏尚未审计", audited: "理解遗漏已审计" }, audit.status, "理解遗漏审计状态未登记");
  const generationNote = operator && source.payload.generation != null ? ` · 处理第 ${source.payload.generation} 代` : "";
  const working = ["queued", "parsing"].includes(status);
  const menu: { label: string; onClick: () => void; danger?: boolean }[] = [
    { label: "预览原文", onClick: onPreview },
    { label: "查看理解", onClick: onUnderstanding },
    ...(shared === true ? [{ label: "改为仅本项目", onClick: onShare }] : []),
    ...(shared === false && ["complete", "needs_attention"].includes(status) ? [{ label: "所有项目可用", onClick: onShare }] : []),
    { label: "调整分析", onClick: onEdit },
    ...(["failed", "needs_attention", "complete", "canceled"].includes(status) ? [{ label: "重新分析", onClick: onRetry }] : []),
    ...(working ? [{ label: "取消", onClick: onCancel }] : []),
    { label: chainOpen ? "收起版本链" : "查看版本链", onClick: onChain },
    { label: "删除记录", onClick: onDelete, danger: true },
  ];
  return (
    <li className="px-4 py-3" data-source={source.id}>
      <div className="flex items-start gap-3">
        {iconFor(name)}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onPreview} title={`预览 ${name}`} className="min-w-0 truncate text-left text-ui font-medium text-text hover:underline">{name}</button>
            <span className={cn("text-caption font-medium", STATUS_TONE[status] ?? "text-muted")}>{working && <Loader2 size={11} className="mr-0.5 inline animate-spin motion-reduce:animate-none" aria-hidden="true" />}{statusText}</span>
            {shared === true && <span className="rounded-full border border-border px-1.5 text-badge text-muted" title="你的每个项目都能读取和检索它">所有项目</span>}
            {duplicate && (
              <button type="button" onClick={onDuplicates} title={`${labelFor(DUPLICATE_KINDS, duplicate.kind, "其他相似情况")}：点开决定是不是同一份`}
                className="flex items-center gap-1 rounded-full bg-warn-soft px-1.5 text-badge font-medium text-warn hover:opacity-80">
                <Copy size={10} aria-hidden="true" />疑似重复
              </button>
            )}
          </div>
          <SourceMetadataLine metadata={source.payload.metadata} pageCount={source.payload.analysis?.pageCount} fileName={name} />
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-caption text-muted" title={`分类依据：${source.payload.reasons[0] ?? ""}`}>
            <span>{labelFor(TYPE_LABEL, source.payload.docType, "其他资料")}</span><span>·</span>
            <span>{labelFor(DEPTH_LABEL, source.payload.depth, "分析深度未登记")}</span><span>·</span>
            <span>第 {source.payload.version} 版{generationNote}</span>
            {coverage && <><span>·</span><span>已解析 {coverage.percent}%{coverage.failed > 0 ? ` · ${coverage.failed} 个片段未能解析` : ""}</span></>}
            {coverage && operator && <><span>·</span><span>处理台账 {accountedPercent}% · 失败单元 {coverage.failed}/{coverage.total}</span></>}
            <span>·</span><span>{auditLabel}</span>
          </div>
          {/* The failure, before anything else — keyed on the code, never on the
              stored English `message`. The classification reason is said only
              when a person is being asked to look. */}
          {failure && <p className="mt-1 text-caption text-error" title={operator ? failure.code : undefined}>
            <AlertCircle size={12} className="mr-1 inline" aria-hidden="true" />解析失败：{sourceFailureMessage(failure)}原件已保留，「重新分析」会新起一代。</p>}
          {(failure || status === "needs_attention") && source.payload.reasons[0] && (
            <p className="mt-0.5 text-caption text-muted"><FileSearch size={12} className="mr-1 inline" aria-hidden="true" />分类依据：{source.payload.reasons[0]}</p>
          )}
          <OmissionNotice notice={source.payload.omissionNotice} onRaiseDepth={onRaiseDepth} />
          {chainOpen && <div className="mt-2"><VersionChain sourceId={source.id} /></div>}
        </div>
        <RowMenu name={name} items={menu} disabled={busy} />
      </div>
    </li>
  );
}

/** The row's 「…」: what one can do to this document, in one menu. */
function RowMenu({ name, items, disabled }: { name: string; items: { label: string; onClick: () => void; danger?: boolean }[]; disabled: boolean }) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node | null)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [open]);
  const item = "flex w-full items-center rounded-input px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2";
  return (
    <div ref={root} className="relative shrink-0">
      <button type="button" aria-label={`「${name}」的操作`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        disabled={disabled} onClick={() => setOpen((value) => !value)}
        className="grid h-7 w-7 place-items-center rounded-input text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">
        <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={`「${name}」的操作`} className="absolute right-0 z-30 mt-1 min-w-40 rounded-card border border-border bg-surface p-1 shadow-pop">
          {items.map((entry) => (
            <button key={entry.label} type="button" role="menuitem" onClick={() => { setOpen(false); entry.onClick(); }}
              className={entry.danger ? `${item} text-error` : item}>{entry.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenListBrowser({ projectId, busy, setBusy, onImported, onFolderRegistered, onError }: { projectId: string; busy: boolean; setBusy: (value: boolean) => void;
  onImported: () => Promise<void>; onFolderRegistered: () => void; onError: (value: string | null) => void }) {
  const [remotePath, setRemotePath] = useState("/");
  const [entries, setEntries] = useState<OpenListEntry[] | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const browse = async (selected = remotePath) => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    setBusy(true); onError(null);
    const valid = () => request.current === current && getWebProjectId() === projectId;
    try { const page = await browseOpenList(projectId, selected); if (valid()) { setRemotePath(selected); setEntries(page.entries); } }
    catch (error) { if (valid()) { onError(productErrorMessage(error)); setEntries([]); } }
    finally { if (valid()) setBusy(false); }
  };
  const importFile = async (selected: string) => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    setBusy(true); onError(null);
    const valid = () => request.current === current && getWebProjectId() === projectId;
    try { await importOpenListSource(projectId, selected); if (valid()) await onImported(); }
    catch (error) { if (valid()) onError(productErrorMessage(error)); }
    finally { if (valid()) setBusy(false); }
  };
  const registerFolder = async (selected: string) => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    setBusy(true); onError(null);
    const valid = () => request.current === current && getWebProjectId() === projectId;
    try { await registerSourceFolder(projectId, selected); if (valid()) onFolderRegistered(); }
    catch (error) { if (valid()) onError(productErrorMessage(error)); }
    finally { if (valid()) setBusy(false); }
  };
  const parent = remotePath === "/" ? "/" : remotePath.split("/").slice(0, -1).join("/") || "/";
  return <Card title="网盘资料" hint="只显示你自己的网盘空间。无法提供内容指纹的文件，请改用平台上传。">
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
        <Input label="网盘路径" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} />
        <Button className="self-end" type="submit" loading={busy}>浏览</Button>
        <Button className="self-end" variant="ghost" type="button" disabled={busy} onClick={() => void registerFolder(remotePath)}><FolderSync size={13} aria-hidden="true" />同步当前文件夹</Button>
      </form>
      {entries && <div className="divide-y divide-border rounded-input border border-border">{remotePath !== "/" && <button type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-text hover:bg-surface-2" onClick={() => void browse(parent)}><Folder size={15} aria-hidden="true" />返回上级</button>}
        {entries.length === 0 ? <p className="px-3 py-4 text-ui text-muted">这里没有可导入的资料。</p> : entries.map((entry) => <div key={entry.path}
          className="flex items-center gap-3 px-3 py-2 text-ui text-text"><span className="flex min-w-0 flex-1 items-center gap-2">{entry.entryType === "dir" ? <Folder size={15} aria-hidden="true" /> : <FileSearch size={15} aria-hidden="true" />}<span className="truncate">{entry.name}</span></span>
          {entry.entryType === "dir" ? <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void browse(entry.path)}>打开</Button>
            <Button size="sm" variant="ghost" disabled={busy} title="持续同步这个文件夹" onClick={() => void registerFolder(entry.path)}><FolderSync size={13} aria-hidden="true" />同步</Button></>
            : <Button size="sm" variant="ghost" disabled={busy || !entry.providerHash?.startsWith("sha256:")} title={entry.providerHash?.startsWith("sha256:") ? "导入并分析" : "这个存储无法提供内容指纹，请改用平台上传"}
              onClick={() => void importFile(entry.path)}><FilePlus2 size={13} aria-hidden="true" />导入</Button>}</div>)}</div>}
    </div>
  </Card>;
}

// Every code the folder sync can record as a skip reason. `openlist_sha256_required`
// is not one of them: the sync filters on the SHA-256 pattern before it ever
// builds a manifest, so that code cannot reach this card.
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

export function SyncedFolders({ projectId, refreshToken, onError }: { projectId: string; refreshToken: number; onError: (value: string | null) => void }) {
  const operator = useOperator();
  const [folders, setFolders] = useState<SourceFolderRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    try {
      const page = await listSourceFolders(projectId);
      if (request.current === current && getWebProjectId() === projectId) setFolders(page.items);
    } catch (error) {
      if (request.current === current && getWebProjectId() === projectId) { setFolders([]); onError(productErrorMessage(error)); }
    }
  }, [projectId, onError]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load, refreshToken]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); onError(null);
    try { await operation(); await load(); }
    catch (error) { onError(productErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return <Card title="已注册的同步文件夹" hint="同步只走你明确注册的文件夹，不会自行遍历整个网盘；子文件夹请单独注册。同步在注册、恢复同步或点击“立即同步”时执行，不会自动定时轮询。">
    {folders === null ? <MemorySkeleton /> : folders.length === 0
      ? <p className="text-ui text-muted">还没有注册同步文件夹。在上面的网盘目录里点“同步”即可。</p>
      : <div className="space-y-3">{folders.map((folder) => {
        const sync = folder.payload.lastSync;
        // `lastSync` is written only on the success path, so on its own it says a
        // folder that has been failing for a week is healthy. `lastError` is what
        // gives the failure and the pause a reason; absent (older records, and
        // every record until the server side lands) the card degrades to exactly
        // what it showed before.
        const lastError = folder.payload.lastError;
        return <div key={folder.id} className="space-y-2 rounded-input border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-ui text-text">
            {/* The folder's own name, not the connector id it is stored under
                (which is the gateway path, tenant namespace and all). */}
            <Folder size={15} aria-hidden="true" /><span className="min-w-0 flex-1 truncate" title={displayPath(folder.payload.connector.id)}>
              {baseName(displayPath(folder.payload.connector.id))}</span>
            <span className="text-ui text-muted">{folder.payload.status === "active" ? "已启用同步" : "已暂停"}</span>
            <Button size="sm" variant="ghost" disabled={busy || folder.payload.status !== "active"}
              onClick={() => void mutate(() => syncSourceFolder(folder.id, folder.revision))}><RefreshCw size={13} aria-hidden="true" />立即同步</Button>
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => void mutate(() => setSourceFolderStatus(folder.id, folder.revision, folder.payload.status === "active" ? "paused" : "active"))}>
              {folder.payload.status === "active" ? <><Pause size={13} aria-hidden="true" />暂停同步</> : <><Play size={13} aria-hidden="true" />恢复同步</>}</Button>
          </div>
          {lastError && <p className="text-ui text-error" title={operator ? lastError.code : undefined}>上次同步失败：{sourceFailureMessage(lastError)}
            {folder.payload.status === "paused" ? "同步已暂停，处理后点「恢复同步」。" : "已入库的资料不受影响，可点「立即同步」重试。"}</p>}
          <p className="text-ui text-muted">{sync
            ? `上次成功同步：新增 ${sync.registered} · 更新 ${sync.updated} · 未变化 ${sync.unchanged} · 已看到 ${sync.scanned} 项${sync.complete ? "" : "（本轮未走完，已排入后续任务）"}`
            : "尚未完成第一次同步。"}</p>
          {/* The lists are bounded examples; the counts are what actually happened. */}
          {sync && sync.skippedCount > 0 && <p className="text-ui text-muted">跳过 {sync.skippedCount} 项，例如：
            {sync.skipped.slice(0, 3).map((item) => `${baseName(item.path)}（${skipReason(item.reason)}）`).join("、")}</p>}
          {sync && sync.removalCheck === "full" && sync.removedCount > 0 && <p className="text-ui text-muted">
            网盘里已不见 {sync.removedCount} 个文件；已入库的分析结果仍然保留。</p>}
        </div>;
      })}</div>}
  </Card>;
}

const DUPLICATE_KINDS: Record<string, string> = {
  "version-family": "同一路径的多个版本",
  "shared-content": "同样内容出现在多个路径",
  "similar-name": "文件名归一化后相同",
};

/** The groups a badge opened: what each holds and the two decisions. */
function DuplicateGroups({ groups, busy, onDecide }: { groups: DuplicateGroup[]; busy: boolean; onDecide: (group: DuplicateGroup, decision: "linked" | "dismissed") => void }) {
  if (groups.length === 0) return <p className="text-ui text-muted">没有发现疑似重复的资料。</p>;
  return <div className="space-y-3">{groups.map((group) => <div key={group.groupKey} className="space-y-2 rounded-input border border-border px-3 py-2">
    <div className="flex flex-wrap items-center gap-2 text-ui text-text">
      <Copy size={15} aria-hidden="true" /><span className="flex-1 truncate">{baseName(group.label)}</span>
      <span className="text-ui text-muted">{labelFor(DUPLICATE_KINDS, group.kind, "其他相似情况")}</span>
    </div>
    <ul className="space-y-1 text-ui text-muted">{group.members.map((item) => <li key={item.sourceId}>
      第 {item.version} 版 · {item.paths.map(baseName).join("、")} · {Math.max(1, Math.round(item.size / 1024))} KB · {labelFor(STATUS, item.status)}
    </li>)}</ul>
    {group.decision
      ? <p className="text-ui text-muted">已标记为{group.decision.decision === "linked" ? "同一份资料" : "不是重复"}。可重新选择。</p>
      : null}
    <div className="flex flex-wrap gap-2">
      {/* Linking is a statement about two sources. A shared-content group is
          one source under several paths, so there is nothing to link. */}
      {group.sourceIds.length > 1 && <Button size="sm" variant="ghost" disabled={busy}
        onClick={() => onDecide(group, "linked")}><Link2 size={13} aria-hidden="true" />标记为同一份</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(group, "dismissed")}><XCircle size={13} aria-hidden="true" />不是重复</Button>
    </div>
  </div>)}</div>;
}

function VersionChain({ sourceId }: { sourceId: string }) {
  const [family, setFamily] = useState<SourceFamily | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getSourceFamily(sourceId).then((value) => { if (active) setFamily(value); })
      .catch((failure) => { if (active) setError(productErrorMessage(failure)); });
    return () => { active = false; };
  }, [sourceId]);
  if (error) return <p className="text-ui text-error">{error}</p>;
  if (!family) return <p className="text-ui text-muted">正在读取版本链…</p>;
  if (family.items.length === 0) return <p className="text-ui text-muted">这份资料还没有其他版本。</p>;
  return <ul className="space-y-1 rounded-input bg-surface-2 px-3 py-2 text-ui text-muted">
    {family.items.map((item) => <li key={item.id} className={item.id === sourceId ? "text-text" : undefined}>
      第 {item.payload.version} 版 · {baseName(item.payload.paths[0] ?? item.id)} · {labelFor(STATUS, item.payload.status)}
      {item.id === sourceId ? " · 当前查看" : ""}
    </li>)}
  </ul>;
}

/** A rate as a percentage the card can state without inventing precision the
 * audit does not have: the notice's rates are fractions of a bounded sample. */
function percent(value: number) { return `${Math.round(value * 1000) / 10}%`; }

/** The omission audit's own reading of a *delivered* understanding.
 *
 * Observation phase, and shown as one. `sourceUnderstandingOmissionNotice`
 * returns `blocking:false`, appears in no issue list, and its 5%/15% targets
 * have never been checked against an observed distribution of real sources —
 * per the development principles a new check ships as a notice first. So this
 * says what was measured and offers the one thing a researcher can do about
 * it, rather than looking like a verdict they have to clear. `disagreements`
 * are the control plane's own English diagnostics, capped at five lines; an
 * operator gets them as a count, a researcher not at all. */
function OmissionNotice({ notice, onRaiseDepth }: { notice?: SourceOmissionNotice | null; onRaiseDepth: () => void }) {
  const operator = useOperator();
  if (!notice) return null;
  const over = notice.withinTarget === false && typeof notice.omissionRate === "number" ? notice.omissionRate : null;
  const disagreements = notice.disagreements?.length ?? 0;
  if (over === null && !(operator && disagreements)) return null;
  return <div className="mt-1 space-y-1 text-caption text-muted">
    {over !== null && <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-text">抽查 {notice.audited} 个片段，约 {percent(over)} 的内容没有被理解进来，高于当前分析深度的参考值 {percent(notice.target)}。</p>
      <Button size="sm" variant="ghost" onClick={onRaiseDepth}>提高分析深度</Button>
    </div>}
    {operator && disagreements > 0 && <p title={notice.disagreements.join("\n")}>
      运行自报的审计与它实际交付的引用至少有 {disagreements} 处对不上；页面上的遗漏率按交付内容重算，不采用自报值。</p>}
  </div>;
}

/** What the parser read about the document, with the DOI said as checked as it
 *  is: confirmed against Crossref's registered title, not confirmed, or
 *  dropped because Crossref registered it for another work. Nothing when the
 *  parse brought no metadata and the document has no page count. */
export function SourceMetadataLine({ metadata, pageCount, fileName }: { metadata?: SourceMetadata | null; pageCount?: number; fileName: string }) {
  const title = metadata?.title?.trim();
  const authors = metadata?.authors?.filter(Boolean) ?? [];
  const published = [metadata?.source, metadata?.publicationDate].filter(Boolean).join("，");
  const check = metadata?.doiCheck;
  const parts = [
    title && title !== fileName ? `《${title}》` : null,
    authors.length ? `${authors.slice(0, 3).join("、")}${authors.length > 3 ? " 等" : ""}` : null,
    published || null,
    pageCount ? `共 ${pageCount} 页` : null,
  ].filter((part): part is string => Boolean(part));
  const doi = metadata?.doi
    ? `DOI ${metadata.doi}（${check?.status === "verified" ? "已与 Crossref 登记的题名核对" : "未经 Crossref 确认"}）`
    : check?.status === "mismatch" && check.droppedDoi
      ? `解析出的 DOI ${check.droppedDoi} 在 Crossref 登记的是另一篇文献，已不采用`
      : null;
  if (!parts.length && !doi) return null;
  return <div className="mt-0.5 space-y-0.5 text-caption text-muted">
    {parts.length > 0 && <p>{parts.join(" · ")}</p>}
    {doi && <p>{doi}</p>}
  </div>;
}

function EditSource({ source, busy, onSave, onCancel }: { source: SourceRecord; busy: boolean;
  onSave: (input: { expectedRevision: number; docType: string; depth: string; reason: string }) => void; onCancel: () => void }) {
  const [docType, setDocType] = useState(source.payload.docType);
  const [depth, setDepth] = useState(source.payload.depth);
  const [reason, setReason] = useState("");
  return <form className="grid gap-3" onSubmit={(event) => {
    event.preventDefault(); onSave({ expectedRevision: source.revision, docType, depth, reason });
  }}>
    <label className="space-y-1 text-ui text-text"><span>资料类型</span><select aria-label="资料类型" value={docType} onChange={(event) => setDocType(event.target.value)}
      className="h-9 w-full rounded-input border border-strong bg-bg px-2 text-ui">{TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="space-y-1 text-ui text-text"><span>分析深度</span><select aria-label="分析深度" value={depth} onChange={(event) => setDepth(event.target.value as SourceRecord["payload"]["depth"])}
      className="h-9 w-full rounded-input border border-strong bg-bg px-2 text-ui">{DEPTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <Input label="调整原因" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} />
    <div className="flex gap-2"><Button type="submit" loading={busy}>保存并重新分析</Button><Button variant="ghost" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}
