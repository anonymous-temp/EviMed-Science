import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Cloud, Database, FilePlus2, FileSearch, Folder, RotateCcw, SlidersHorizontal, Trash2, XCircle } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { browseOpenList, cancelSource, importOpenListSource, listSources, overrideSource, removeSource, retrySource,
  type OpenListEntry, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { baseName } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";

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
  const [filter, setFilter] = useState("all");
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SourceRecord | null>(null);
  const [deleting, setDeleting] = useState<SourceRecord | null>(null);
  const [showOpenList, setShowOpenList] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setSources(null); setError(null);
    try {
      const page = await listSources(getWebProjectId(), { status: filter === "all" ? "" : filter });
      if (generation.current === current) setSources(page.items);
    } catch (loadError) {
      if (generation.current === current) { setSources([]); setError(`无法加载资料状态：${productErrorMessage(loadError)}`); }
    }
  }, [filter]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); setEditing(null); setDeleting(null); await load(); }
    catch (operationError) { setError(productErrorMessage(operationError)); }
    finally { setBusy(false); }
  };

  return (
    <main className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-content-wide space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="font-serif text-title text-text">资料整理台</h1><p className="mt-2 text-ui text-muted">查看每份资料为什么这样分类、抽取是否完整，并随时调整分析深度。</p></div>
          <Button variant="ghost" onClick={() => setShowOpenList((value) => !value)}><Cloud size={15} />连接网盘资料</Button></header>
        {showOpenList && <OpenListBrowser busy={busy} setBusy={setBusy} onImported={load} onError={setError} />}
        <SegmentedControl value={filter} onChange={setFilter} aria-label="资料状态"
          options={[{ value: "all", label: "全部" }, { value: "needs_attention", label: "需要处理" }, { value: "parsing", label: "分析中" }, { value: "complete", label: "已完成" }]} />
        {error && <Card><div className="flex items-center gap-2 text-ui text-error"><AlertCircle size={16} /><span className="flex-1">{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div></Card>}
        {sources === null ? <MemorySkeleton /> : sources.length === 0 && !error ? <EmptyState icon={Database} title="还没有进入分析流程的资料"
          description="从知识库上传资料后，系统会先建立索引，再按价值进行结构化或深度分析。" /> : (
          <div className="space-y-4">{sources.map((source) => <SourceCard key={source.id} source={source} busy={busy}
            onEdit={() => setEditing(source)} onRetry={() => void mutate(() => retrySource(source.id, source.revision))}
            onCancel={() => void mutate(() => cancelSource(source.id, source.revision))} onDelete={() => setDeleting(source)} />)}</div>
        )}
        {editing && <EditSource source={editing} busy={busy} onCancel={() => setEditing(null)}
          onSave={(input) => void mutate(() => overrideSource(editing.id, input))} />}
      </div>
      {deleting && <ConfirmDialog title="删除资料分析记录？" body="原始文件仍由知识库管理；来源索引和后续派生理解会停止使用。"
        confirmLabel="删除记录" onCancel={() => setDeleting(null)} onConfirm={() => void mutate(() => removeSource(deleting.id, deleting.revision))} />}
    </main>
  );
}

function OpenListBrowser({ busy, setBusy, onImported, onError }: { busy: boolean; setBusy: (value: boolean) => void;
  onImported: () => Promise<void>; onError: (value: string | null) => void }) {
  const [remotePath, setRemotePath] = useState("/");
  const [entries, setEntries] = useState<OpenListEntry[] | null>(null);
  const browse = async (selected = remotePath) => {
    setBusy(true); onError(null);
    try { const page = await browseOpenList(getWebProjectId(), selected); setRemotePath(selected); setEntries(page.entries); }
    catch (error) { onError(productErrorMessage(error)); setEntries([]); }
    finally { setBusy(false); }
  };
  const importFile = async (selected: string) => {
    setBusy(true); onError(null);
    try { await importOpenListSource(getWebProjectId(), selected); await onImported(); }
    catch (error) { onError(productErrorMessage(error)); }
    finally { setBusy(false); }
  };
  const parent = remotePath === "/" ? "/" : remotePath.split("/").slice(0, -1).join("/") || "/";
  return <Card title="OpenList 网盘" hint="每个账号只能浏览自己的 /tenants 命名空间；大文件请使用本地分析代理。">
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
        <Input label="网盘路径" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} />
        <Button className="self-end" type="submit" loading={busy}>浏览</Button>
      </form>
      {entries && <div className="divide-y divide-border rounded-input border border-border">{remotePath !== "/" && <button type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-text hover:bg-surface-2" onClick={() => void browse(parent)}><Folder size={15} />返回上级</button>}
        {entries.length === 0 ? <p className="px-3 py-4 text-ui-sm text-muted">这里没有可导入的资料。</p> : entries.map((entry) => <div key={entry.path}
          className="flex items-center gap-3 px-3 py-2 text-ui text-text"><span className="flex min-w-0 flex-1 items-center gap-2">{entry.entryType === "dir" ? <Folder size={15} /> : <FileSearch size={15} />}<span className="truncate">{entry.name}</span></span>
          {entry.entryType === "dir" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void browse(entry.path)}>打开</Button>
            : <Button size="sm" variant="ghost" disabled={busy || !entry.providerHash?.startsWith("sha256:")} title={entry.providerHash?.startsWith("sha256:") ? "导入并分析" : "此存储未提供 SHA-256，请改用平台上传或本地代理"}
              onClick={() => void importFile(entry.path)}><FilePlus2 size={13} />导入</Button>}</div>)}</div>}
    </div>
  </Card>;
}

function SourceCard({ source, busy, onEdit, onRetry, onCancel, onDelete }: {
  source: SourceRecord; busy: boolean; onEdit: () => void; onRetry: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const coverage = source.payload.coverage;
  const accountedPercent = coverage ? coverage.accountedPercent ?? Math.round((coverage.accounted / Math.max(1, coverage.total)) * 100) : 0;
  return <Card title={baseName(source.payload.paths[0] ?? source.id)} hint={`版本 ${source.payload.version} · ${STATUS[source.payload.status] ?? source.payload.status}`}>
    <div className="space-y-3 text-ui text-text">
      {source.payload.outputs.summary && <p>{source.payload.outputs.summary}</p>}
      <div className="flex flex-wrap gap-2 text-ui-sm text-muted">
        <span>{TYPE_OPTIONS.find(([value]) => value === source.payload.docType)?.[1] ?? source.payload.docType}</span><span>·</span>
        <span>{DEPTH_OPTIONS.find(([value]) => value === source.payload.depth)?.[1] ?? source.payload.depth}</span>
        {coverage && <><span>·</span><span>处理成功 {coverage.percent}% · 已逐单元核对 {accountedPercent}% · 遗漏 {Math.round(coverage.omissionRate * 100)}%</span></>}
        <span>·</span><span>事实 {source.payload.outputs.facts ?? 0} · 方法线索 {source.payload.outputs.methods ?? 0}</span>
      </div>
      <div className="rounded-input bg-surface-2 px-3 py-2 text-ui-sm text-muted"><FileSearch size={14} className="mr-1 inline" />{source.payload.reasons[0]}</div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><SlidersHorizontal size={13} />调整分析</Button>
        {["failed", "needs_attention", "complete", "canceled"].includes(source.payload.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}><RotateCcw size={13} />重新分析</Button>}
        {["queued", "parsing"].includes(source.payload.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}><XCircle size={13} />取消</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}><Trash2 size={13} />删除记录</Button>
      </div>
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
