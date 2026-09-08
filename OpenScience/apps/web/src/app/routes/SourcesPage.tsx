import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Cloud, Copy, Database, FilePlus2, FileSearch, Folder, FolderSync, GitBranch, Link2, Pause, Play, RefreshCw, RotateCcw, SlidersHorizontal, Trash2, XCircle } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { browseOpenList, cancelSource, decideDuplicateGroup, getSourceFamily, importOpenListSource, listDuplicateCandidates,
  listSourceFolders, listSources, overrideSource, registerSourceFolder, removeSource, retrySource, setSourceFolderStatus,
  sourceFailureMessage, syncSourceFolder, type DuplicateGroup, type OpenListEntry, type SourceFamily,
  type SourceFolderRecord, type SourceOmissionNotice, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { baseName } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { SourceUnderstandingPanel } from "@/components/sources/SourceUnderstandingPanel";

const STATUS: Record<string, string> = {
  queued: "等待分析", parsing: "正在解析", complete: "已完成", needs_attention: "需要你看一下",
  failed: "分析失败", missing: "原始资料已移除", canceled: "已取消",
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

export function SourcesPage() {
  // Store fallback repairs do not reload the document. Subscribe to those
  // repairs, while the tab's current selection still owns in-flight requests.
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <ProjectSourcesPage key={projectId} projectId={projectId} />;
}

function ProjectSourcesPage({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState("all");
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SourceRecord | null>(null);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [understandingId, setUnderstandingId] = useState<string | null>(null);
  const [showOpenList, setShowOpenList] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [folderRefresh, setFolderRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const loadingRequest = useRef<number | null>(null);
  const load = useCallback(async (background = false) => {
    if (getWebProjectId() !== projectId || (background && loadingRequest.current != null)) return;
    const current = ++generation.current;
    loadingRequest.current = current;
    if (!background) { setSources(null); setError(null); }
    try {
      const page = await listSources(projectId, { status: filter === "all" ? "" : filter });
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
    try {
      await operation();
      if (getWebProjectId() !== projectId) return;
      setEditing(null); setDeleting(null); await load();
    } catch (operationError) { if (getWebProjectId() === projectId) setError(productErrorMessage(operationError)); }
    finally { if (getWebProjectId() === projectId) setBusy(false); }
  };
  const selectedSource = sources?.find(source => source.id === understandingId);

  return (
    <main className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-content-wide space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="font-serif text-title text-text">资料整理台</h1><p className="mt-2 text-ui text-muted">查看每份资料为什么这样分类、抽取是否完整，并随时调整分析深度。</p></div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setShowDuplicates((value) => !value)}><Copy size={15} />疑似重复</Button>
            <Button variant="ghost" onClick={() => setShowOpenList((value) => !value)}><Cloud size={15} />连接网盘资料</Button>
          </div></header>
        {showDuplicates && <DuplicateDesk projectId={projectId} onError={setError} />}
        {showOpenList && <OpenListBrowser projectId={projectId} busy={busy} setBusy={setBusy} onImported={load}
          onFolderRegistered={() => setFolderRefresh((value) => value + 1)} onError={setError} />}
        {showOpenList && <SyncedFolders projectId={projectId} refreshToken={folderRefresh} onError={setError} />}
        <SegmentedControl value={filter} onChange={setFilter} aria-label="资料状态"
          options={[{ value: "all", label: "全部" }, { value: "needs_attention", label: "需要处理" }, { value: "parsing", label: "分析中" }, { value: "complete", label: "已完成" }]} />
        {error && <Card><div className="flex items-center gap-2 text-ui text-error"><AlertCircle size={16} /><span className="flex-1">{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}
        {sources === null ? <MemorySkeleton /> : sources.length === 0 && !error ? <EmptyState icon={Database} title="还没有进入分析流程的资料"
          description="从知识库上传资料后，系统会先建立索引，再按价值进行结构化或深度分析。" /> : (
          <div className="space-y-4">{sources.map((source) => <SourceCard key={source.id} source={source} busy={busy}
            onUnderstanding={() => setUnderstandingId(source.id)}
            onEdit={() => setEditing(source)} onRetry={() => void mutate(() => retrySource(source.id, source.revision))}
            onCancel={() => void mutate(() => cancelSource(source.id, source.revision))} onDelete={() => setDeleting(source)} />)}</div>
        )}
        {selectedSource && <SourceUnderstandingPanel key={selectedSource.id} projectId={projectId} sourceId={selectedSource.id}
          sourceName={baseName(selectedSource.payload.paths[0] ?? selectedSource.id)} generation={selectedSource.payload.generation}
          error={selectedSource.payload.error} onClose={() => setUnderstandingId(null)} />}
        {editing && <EditSource source={editing} busy={busy} onCancel={() => setEditing(null)}
          onSave={(input) => void mutate(() => overrideSource(editing.id, input))} />}
      </div>
      {deleting && <ConfirmDialog title="删除资料分析记录？" body="原始文件仍由知识库管理；来源索引和后续派生理解会停止使用。"
        confirmLabel="删除记录" onCancel={() => setDeleting(null)} onConfirm={() => void mutate(() => removeSource(deleting.id, deleting.revision))} />}
    </main>
  );
}

function OpenListBrowser({ projectId, busy, setBusy, onImported, onFolderRegistered, onError }: { projectId: string; busy: boolean; setBusy: (value: boolean) => void;
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
  return <Card title="OpenList 网盘" hint="每个账号只能浏览自己的 /tenants 命名空间；未提供 SHA-256 的存储请改用平台上传。">
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
        <Input label="网盘路径" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} />
        <Button className="self-end" type="submit" loading={busy}>浏览</Button>
        <Button className="self-end" variant="ghost" type="button" disabled={busy} onClick={() => void registerFolder(remotePath)}><FolderSync size={13} />同步当前文件夹</Button>
      </form>
      {entries && <div className="divide-y divide-border rounded-input border border-border">{remotePath !== "/" && <button type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-text hover:bg-surface-2" onClick={() => void browse(parent)}><Folder size={15} />返回上级</button>}
        {entries.length === 0 ? <p className="px-3 py-4 text-ui-sm text-muted">这里没有可导入的资料。</p> : entries.map((entry) => <div key={entry.path}
          className="flex items-center gap-3 px-3 py-2 text-ui text-text"><span className="flex min-w-0 flex-1 items-center gap-2">{entry.entryType === "dir" ? <Folder size={15} /> : <FileSearch size={15} />}<span className="truncate">{entry.name}</span></span>
          {entry.entryType === "dir" ? <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void browse(entry.path)}>打开</Button>
            <Button size="sm" variant="ghost" disabled={busy} title="持续同步这个文件夹" onClick={() => void registerFolder(entry.path)}><FolderSync size={13} />同步</Button></>
            : <Button size="sm" variant="ghost" disabled={busy || !entry.providerHash?.startsWith("sha256:")} title={entry.providerHash?.startsWith("sha256:") ? "导入并分析" : "此存储未提供 SHA-256，请改用平台上传"}
              onClick={() => void importFile(entry.path)}><FilePlus2 size={13} />导入</Button>}</div>)}</div>}
    </div>
  </Card>;
}

// Every code the folder sync can record as a skip reason. `openlist_sha256_required`
// is not one of them: the sync filters on the SHA-256 pattern before it ever
// builds a manifest, so that code cannot reach this card.
const SKIP_REASONS: Record<string, string> = {
  provider_hash_unsupported: "网盘未提供 SHA-256",
  entry_budget_exhausted: "超出本文件夹的跟踪上限",
  source_scope_conflict: "同样内容已属于其他项目",
  source_payload_invalid: "文件路径或属性不合规",
  source_path_invalid: "文件路径或属性不合规",
  source_digest_invalid: "网盘给出的 SHA-256 不合规",
  source_size_invalid: "文件大小超出可入库范围",
  source_connector_invalid: "网盘条目无法映射成资料",
};

/** A researcher reads Chinese. An unmapped code is a sentence here, not a token
 * copied out of the server. */
function skipReason(code: string) { return SKIP_REASONS[code] ?? "这一项无法入库"; }

function SyncedFolders({ projectId, refreshToken, onError }: { projectId: string; refreshToken: number; onError: (value: string | null) => void }) {
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
      ? <p className="text-ui-sm text-muted">还没有注册同步文件夹。在上面的网盘目录里点“同步”即可。</p>
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
            <Folder size={15} /><span className="flex-1 truncate">{folder.payload.connector.id}</span>
            <span className="text-ui-sm text-muted">{folder.payload.status === "active" ? "已启用同步" : "已暂停"}</span>
            <Button size="sm" variant="ghost" disabled={busy || folder.payload.status !== "active"}
              onClick={() => void mutate(() => syncSourceFolder(folder.id, folder.revision))}><RefreshCw size={13} />立即同步</Button>
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => void mutate(() => setSourceFolderStatus(folder.id, folder.revision, folder.payload.status === "active" ? "paused" : "active"))}>
              {folder.payload.status === "active" ? <><Pause size={13} />暂停同步</> : <><Play size={13} />恢复同步</>}</Button>
          </div>
          {lastError && <p className="text-ui-sm text-error" title={lastError.code}>上次同步失败：{sourceFailureMessage(lastError)}
            {folder.payload.status === "paused" ? "同步已暂停，处理后点「恢复同步」。" : "已入库的资料不受影响，可点「立即同步」重试。"}</p>}
          <p className="text-ui-sm text-muted">{sync
            ? `上次成功同步：新增 ${sync.registered} · 更新 ${sync.updated} · 未变化 ${sync.unchanged} · 已看到 ${sync.scanned} 项${sync.complete ? "" : "（本轮未走完，已排入后续任务）"}`
            : "尚未完成第一次同步。"}</p>
          {/* The lists are bounded examples; the counts are what actually happened. */}
          {sync && sync.skippedCount > 0 && <p className="text-ui-sm text-muted">跳过 {sync.skippedCount} 项，例如：
            {sync.skipped.slice(0, 3).map((item) => `${baseName(item.path)}（${skipReason(item.reason)}）`).join("、")}</p>}
          {sync && sync.removalCheck === "full" && sync.removedCount > 0 && <p className="text-ui-sm text-muted">
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

function DuplicateDesk({ projectId, onError }: { projectId: string; onError: (value: string | null) => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    if (getWebProjectId() !== projectId) return;
    const current = ++request.current;
    try {
      const page = await listDuplicateCandidates(projectId);
      if (request.current === current && getWebProjectId() === projectId) setGroups(page.items);
    } catch (error) {
      if (request.current === current && getWebProjectId() === projectId) { setGroups([]); onError(productErrorMessage(error)); }
    }
  }, [projectId, onError]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load]);
  const decide = async (group: DuplicateGroup, decision: "linked" | "dismissed") => {
    setBusy(true); onError(null);
    try { await decideDuplicateGroup({ projectId, groupKey: group.groupKey, sourceIds: group.sourceIds, decision }); await load(); }
    catch (error) { onError(productErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return <Card title="疑似重复" hint="只按哈希、版本家族、文件大小和归一化文件名判断，不做语义比对。">
    {groups === null ? <MemorySkeleton /> : groups.length === 0
      ? <p className="text-ui-sm text-muted">没有发现疑似重复的资料。</p>
      : <div className="space-y-3">{groups.map((group) => <div key={group.groupKey} className="space-y-2 rounded-input border border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-ui text-text">
          <Copy size={15} /><span className="flex-1 truncate">{baseName(group.label)}</span>
          <span className="text-ui-sm text-muted">{DUPLICATE_KINDS[group.kind] ?? group.kind}</span>
        </div>
        <ul className="space-y-1 text-ui-sm text-muted">{group.members.map((item) => <li key={item.sourceId}>
          第 {item.version} 版 · {item.paths.map(baseName).join("、")} · {Math.max(1, Math.round(item.size / 1024))} KB · {STATUS[item.status] ?? item.status}
        </li>)}</ul>
        {group.decision
          ? <p className="text-ui-sm text-muted">已标记为{group.decision.decision === "linked" ? "同一份资料" : "不是重复"}。可重新选择。</p>
          : null}
        <div className="flex flex-wrap gap-2">
          {/* Linking is a statement about two sources. A shared-content group is
              one source under several paths, so there is nothing to link. */}
          {group.sourceIds.length > 1 && <Button size="sm" variant="ghost" disabled={busy}
            onClick={() => void decide(group, "linked")}><Link2 size={13} />标记为同一份</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(group, "dismissed")}><XCircle size={13} />不是重复</Button>
        </div>
      </div>)}</div>}
  </Card>;
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
  if (error) return <p className="text-ui-sm text-error">{error}</p>;
  if (!family) return <p className="text-ui-sm text-muted">正在读取版本链…</p>;
  if (family.items.length === 0) return <p className="text-ui-sm text-muted">这份资料还没有其他版本。</p>;
  return <ul className="space-y-1 rounded-input bg-surface-2 px-3 py-2 text-ui-sm text-muted">
    {family.items.map((item) => <li key={item.id} className={item.id === sourceId ? "text-text" : undefined}>
      第 {item.payload.version} 版 · {baseName(item.payload.paths[0] ?? item.id)} · {STATUS[item.payload.status] ?? item.payload.status}
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
 * says what was measured and says out loud that it changes nothing, rather than
 * looking like a verdict the researcher has to clear.
 *
 * `disagreements` are the control plane's own English diagnostics and are
 * capped at five lines by `boundedOmissionNotice`, so they are stated as a
 * count ("at least"), in Chinese, with the raw lines kept in `title` for
 * support. Putting English validator prose in front of a Chinese-reading
 * researcher is the defect this whole pass exists to remove, not a shortcut to
 * reuse here. */
function OmissionNotice({ notice }: { notice?: SourceOmissionNotice | null }) {
  if (!notice) return null;
  const over = notice.withinTarget === false && typeof notice.omissionRate === "number" ? notice.omissionRate : null;
  const disagreements = notice.disagreements?.length ?? 0;
  if (over === null && !disagreements) return null;
  return <div className="space-y-1 rounded-input bg-surface-2 px-3 py-2 text-ui-sm text-muted">
    <p className="text-text">遗漏审计提示 · 仅供参考，不影响这份资料入库，也不需要你处理</p>
    {over !== null && <p>抽查了 {notice.audited} 个单元，实测遗漏率 {percent(over)}，高于当前分析深度的参考值 {percent(notice.target)}。想补齐可以提高分析深度后重新分析。</p>}
    {/* Capped at five lines by `boundedOmissionNotice`, so the count is a floor,
        not a total — the same discipline the skipped-entry list already keeps. */}
    {disagreements > 0 && <p title={notice.disagreements.join("\n")}>
      运行自报的审计与它实际交付的引用至少有 {disagreements} 处对不上；页面上的遗漏率按交付内容重算，不采用自报值。</p>}
  </div>;
}

function SourceCard({ source, busy, onEdit, onRetry, onCancel, onDelete, onUnderstanding }: {
  source: SourceRecord; busy: boolean; onEdit: () => void; onRetry: () => void; onCancel: () => void; onDelete: () => void; onUnderstanding: () => void;
}) {
  const [showChain, setShowChain] = useState(false);
  const coverage = source.payload.coverage;
  const accountedPercent = coverage ? coverage.accountedPercent ?? Math.round((coverage.accounted / Math.max(1, coverage.total)) * 100) : 0;
  const status = source.payload.status === "parsing" && source.payload.analysis?.phase === "understanding" ? "正在理解资料" : STATUS[source.payload.status] ?? source.payload.status;
  // The audit verdict comes from the understanding contract; the card states what
  // that contract said instead of asserting a fixed "not audited".
  const audit = source.payload.omissionAudit;
  const failure = source.payload.error;
  const auditLabel = !audit || audit.status === "not_run" ? "理解遗漏尚未审计"
    : typeof audit.omissionRate === "number" ? `理解遗漏 ${Math.round(audit.omissionRate * 100)}%`
      : `理解遗漏审计：${audit.status}`;
  return <Card title={baseName(source.payload.paths[0] ?? source.id)} hint={`文件版本 ${source.payload.version}${source.payload.generation != null ? ` · 处理第 ${source.payload.generation} 代` : ""} · ${status}`}>
    <div className="space-y-3 text-ui text-text">
      {source.payload.outputs.summary && <p>{source.payload.outputs.summary}</p>}
      <div className="flex flex-wrap gap-2 text-ui-sm text-muted">
        <span>{TYPE_OPTIONS.find(([value]) => value === source.payload.docType)?.[1] ?? source.payload.docType}</span><span>·</span>
        <span>{DEPTH_OPTIONS.find(([value]) => value === source.payload.depth)?.[1] ?? source.payload.depth}</span>
        {coverage && <><span>·</span><span>解析处理成功 {coverage.percent}% · 处理台账 {accountedPercent}% · 失败单元 {coverage.failed}/{coverage.total}</span></>}
        <span>·</span><span>{auditLabel}</span>
      </div>
      {/* The failure, before anything else. Until 2026-09-08 a failed source
          showed only 「分析失败」 next to `reasons[0]`, which explains why the
          document was *typed* the way it was and has nothing to do with why the
          analysis died — the stored `error` was typed all the way to this
          component and rendered by nothing. Key on the code, never on the stored
          `message`: that is the literal English "Source analysis failed." for
          every failure, while the code is the fact `@evimed/domain` translates. */}
      {failure && <div className="rounded-input bg-surface-2 px-3 py-2 text-ui-sm text-error" title={failure.code}>
        <AlertCircle size={14} className="mr-1 inline" />解析失败：{sourceFailureMessage(failure)}原件已保留，「重新分析」会新起一代。</div>}
      <div className="rounded-input bg-surface-2 px-3 py-2 text-ui-sm text-muted"><FileSearch size={14} className="mr-1 inline" />分类依据：{source.payload.reasons[0]}</div>
      <OmissionNotice notice={source.payload.omissionNotice} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={onUnderstanding}><FileSearch size={13} />查看理解</Button>
        <Button size="sm" variant="ghost" onClick={() => setShowChain((value) => !value)}><GitBranch size={13} />查看版本链</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><SlidersHorizontal size={13} />调整分析</Button>
        {["failed", "needs_attention", "complete", "canceled"].includes(source.payload.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}><RotateCcw size={13} />重新分析</Button>}
        {["queued", "parsing"].includes(source.payload.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}><XCircle size={13} />取消</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}><Trash2 size={13} />删除记录</Button>
      </div>
      {showChain && <VersionChain sourceId={source.id} />}
    </div>
  </Card>;
}

function EditSource({ source, busy, onSave, onCancel }: { source: SourceRecord; busy: boolean;
  onSave: (input: { expectedRevision: number; docType: string; depth: string; reason: string }) => void; onCancel: () => void }) {
  const [docType, setDocType] = useState(source.payload.docType);
  const [depth, setDepth] = useState(source.payload.depth);
  const [reason, setReason] = useState("");
  return <Card title="调整分析" hint={baseName(source.payload.paths[0] ?? source.id)}><form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => {
    event.preventDefault(); onSave({ expectedRevision: source.revision, docType, depth, reason });
  }}>
    <label className="space-y-1 text-ui-sm text-text"><span>资料类型</span><select aria-label="资料类型" value={docType} onChange={(event) => setDocType(event.target.value)}
      className="h-9 w-full rounded-input border border-border bg-bg px-2 text-ui">{TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="space-y-1 text-ui-sm text-text"><span>分析深度</span><select aria-label="分析深度" value={depth} onChange={(event) => setDepth(event.target.value as SourceRecord["payload"]["depth"])}
      className="h-9 w-full rounded-input border border-border bg-bg px-2 text-ui">{DEPTH_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <Input label="调整原因" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} />
    <div className="flex gap-2 md:col-span-3"><Button type="submit" loading={busy}>保存并重新分析</Button><Button variant="ghost" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form></Card>;
}
