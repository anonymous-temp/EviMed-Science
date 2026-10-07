import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { SkillPackagePanel } from "@/components/skills/SkillPackagePanel";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import {
  confirmPersonalSkillTransfer, importPersonalSkill, pendingPersonalSkillTransfers, previewPersonalSkillImport, previewPersonalSkillRepository,
  previewPersonalSkillTransfer, uploadPersonalSkill, uploadPersonalSkillTransfer,
  type PendingSkillTransfer, type SkillImportPreview, type SkillTransferFormat, type SkillTransferIntent, type SkillTransferPreview,
  type SkillTransferResult, type SkillTransferUpload,
} from "@/lib/skillLibraryClient";

/**
 * Bringing a skill in: a file, a public repository at one commit, or the history and account data of an earlier export.
 * The three live in one drawer, opened from the page's 「新建技能」 menu, so the list stays where it is.
 */
export function SkillImportForm({ recovery, onBusy, onDone, onCancel }: {
  /** An unfinished account migration to pick up where it stopped. */
  recovery?: PendingSkillTransfer;
  onBusy: (busy: boolean) => void;
  /** The new skill's id, or nothing when a migration finished (it saves several). */
  onDone: (skillId?: string) => void;
  onCancel: () => void;
}) {
  const alive = useRef(true), importingRequest = useRef(false);
  const [busy, setBusyState] = useState(false), [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null), [title, setTitle] = useState("");
  const [mode, setMode] = useState<"file" | "repository" | "transfer">(recovery ? "transfer" : "file");
  const [repository, setRepository] = useState(""), [commit, setCommit] = useState(""), [subdirectory, setSubdirectory] = useState("");
  const [preview, setPreview] = useState<{ resourceId: string; content: SkillImportPreview; source?: { repository: string; commit: string; subdirectory?: string } } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  const importFile = async () => {
    if (!title.trim() || importingRequest.current || mode === "file" && !file) return;
    if (mode === "repository" && (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.trim()) || !/^[a-f0-9]{40}$/.test(commit.trim()))) { setError("请填写公开仓库名称和完整的 40 位提交编号。"); return; }
    importingRequest.current = true;
    setBusy(true); setError(null);
    try {
      if (mode === "repository") {
        const result = await previewPersonalSkillRepository({ repository: repository.trim(), commit: commit.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) });
        if (alive.current) setPreview({ resourceId: result.resourceId, content: result.preview, source: result.immutableSource });
      } else {
        const upload = await uploadPersonalSkill(file!);
        const content = await previewPersonalSkillImport(upload.resourceId);
        if (alive.current) setPreview({ resourceId: upload.resourceId, content });
      }
    } catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { importingRequest.current = false; if (alive.current) setBusy(false); }
  };
  const confirmImport = async () => {
    if (!preview || !title.trim() || importingRequest.current) return;
    importingRequest.current = true;
    setBusy(true); setError(null);
    try {
      const created = await importPersonalSkill(preview.resourceId, title);
      if (alive.current) onDone(created.id);
    } catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { importingRequest.current = false; if (alive.current) setBusy(false); }
  };
  if (mode === "transfer") return <SkillTransferImport recovery={recovery} onBusy={onBusy} onClose={() => onDone()} />;
  return (
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void importFile(); }}>
      <div className="flex gap-2">
        <Button type="button" variant={mode === "file" ? "secondary" : "text"} disabled={busy} onClick={() => { setMode("file"); setPreview(null); }}>本地文件</Button>
        <Button type="button" variant="text" disabled={busy} onClick={() => { setMode("repository"); setPreview(null); }}>公开仓库</Button>
        <Button type="button" variant="text" disabled={busy} onClick={() => { setMode("transfer"); setPreview(null); }}>历史与账户数据</Button>
      </div>
      <Input label="技能名称" value={title} required disabled={busy} onChange={event => setTitle(event.target.value)} />
      {mode === "file" ? <Input label="技能文件" type="file" accept=".md,.zip,.tgz,.gz" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} /> : <>
        <Input label="公开仓库" placeholder="owner/repository" value={repository} required disabled={busy} onChange={event => { setRepository(event.target.value); setPreview(null); }} />
        <Input label="固定提交" placeholder="完整的 40 位提交编号" value={commit} required pattern="[a-f0-9]{40}" disabled={busy} onChange={event => { setCommit(event.target.value); setPreview(null); }} />
        <Input label="技能子目录" placeholder="例如 skills/source-check，可留空" value={subdirectory} disabled={busy} onChange={event => { setSubdirectory(event.target.value); setPreview(null); }} />
      </>}
      {preview && <section aria-label="导入预览" className="flex flex-col gap-3">
        {preview.source && <div className="text-caption text-text-2"><p>{preview.source.repository}</p><p className="break-all">{preview.source.commit}</p>{preview.source.subdirectory && <p>{preview.source.subdirectory}</p>}</div>}
        <p className="text-ui text-text-2">{preview.content.description}</p>
        <pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{preview.content.instructions}</pre>
        <p className="text-caption text-text-2">{preview.content.invocation.userInvocable ? "可主动调用" : "不支持主动调用"} · {preview.content.invocation.modelInvocable ? "可在科研中选用" : "不会自动选用"}</p>
        {preview.content.supply && <SkillPackagePanel view={preview.content.supply.package} availability={preview.content.supply} />}
        {preview.content.resources.length > 0 && <List label="导入资源" divided>{preview.content.resources.map(resource => <ListRow key={resource.path} title={resource.path} meta={/^scripts\//.test(resource.path) ? "脚本" : "资源"} />)}</List>}
      </section>}
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      <div className="flex gap-2"><Button type="submit" variant={preview ? "secondary" : "primary"} loading={busy}>预览</Button>{preview && <Button type="button" disabled={busy} onClick={() => void confirmImport()}>确认导入</Button>}<Button type="button" variant="text" disabled={busy} onClick={onCancel}>取消</Button></div>
    </form>
  );
}

/** One confirmed intent survives pauses and transport errors; each receipt is partial until complete. */
function SkillTransferImport({ onBusy, onClose, recovery }: { recovery?: PendingSkillTransfer; onBusy: (busy: boolean) => void; onClose: () => void }) {
  const [format, setFormat] = useState<SkillTransferFormat>("portable"), [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<SkillTransferUpload | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<SkillTransferPreview | null>(null), [result, setResult] = useState<SkillTransferResult | null>(null);
  const [busy, setBusy] = useState(false), [started, setStarted] = useState(false), [paused, setPaused] = useState(false), [error, setError] = useState<string | null>(null);
  const alive = useRef(true), pending = useRef(false), stop = useRef(false), intent = useRef<(SkillTransferIntent & { idempotencyKey: string }) | null>(null);
  useEffect(() => { const stopRef = stop; alive.current = true; return () => { alive.current = false; stopRef.current = true; }; }, []);
  const recover = useCallback(async () => {
    if (!recovery || pending.current) return;
    pending.current = true; setBusy(true); setStarted(true); setPaused(true); setError(null); onBusy(true);
    const request = { reference: recovery.reference, ...(recovery.format === "account" ? { sourceSkillIds: [...recovery.sourceSkillIds] } : {}) };
    intent.current = { ...request, idempotencyKey: recovery.idempotencyKey };
    setFormat(recovery.format); setSelected([...recovery.sourceSkillIds]); setResult({ reference: recovery.reference, status: recovery.status, mappings: recovery.mappings, activation: false });
    try {
      const value = await previewPersonalSkillTransfer(request);
      if (value.reference !== recovery.reference || value.format !== recovery.format || value.activation !== false || value.nativeValidation !== "pending") throw new Error("迁移记录尚未确认，请重新读取预览。");
      if (alive.current) setPreview(value);
    } catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, [recovery, onBusy]);
  useEffect(() => { if (recovery) void recover(); }, [recovery, recover]);
  const stage = async () => {
    if (!file || pending.current || started) return;
    pending.current = true; setBusy(true); setError(null); setUpload(null); setPreview(null); setSelected([]);
    try { const staged = await uploadPersonalSkillTransfer(file, format); if (staged.format !== format) throw new Error("迁移文件格式已变化，请重新上传。"); if (alive.current) setUpload(staged); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const inspect = async () => {
    if (!upload || pending.current || started || format === "account" && selected.length === 0) return;
    const request = { reference: upload.reference, ...(format === "account" ? { sourceSkillIds: [...selected] } : {}) };
    pending.current = true; setBusy(true); setError(null); setPreview(null);
    try {
      const value = await previewPersonalSkillTransfer(request);
      if (value.reference !== upload.reference || value.sourceDigest !== upload.sourceDigest || value.format !== format || value.activation !== false || value.nativeValidation !== "pending") throw new Error("迁移预览已变化，请重新上传。");
      if (alive.current) setPreview(value);
    } catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const run = async () => {
    if (!preview || pending.current || result?.status === "complete") return;
    intent.current ??= { reference: preview.reference, ...(format === "account" ? { sourceSkillIds: [...selected] } : {}), idempotencyKey: crypto.randomUUID() };
    const request = intent.current;
    pending.current = true; stop.current = false; setBusy(true); setStarted(true); setPaused(false); setError(null); onBusy(true);
    try {
      for (let calls = 0; calls < 64 && alive.current && !stop.current; calls++) {
        const receipt = await confirmPersonalSkillTransfer(request);
        if (receipt.reference !== request.reference || receipt.activation !== false || !["in-progress", "complete"].includes(receipt.status)) throw new Error("迁移结果尚未确认，请继续核对进度。");
        if (!alive.current) return;
        setResult(receipt);
        if (receipt.status === "complete") { onBusy(false); return; }
      }
      if (alive.current) setPaused(true);
    } catch (caught) { if (alive.current) { setError(productErrorMessage(caught)); setPaused(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section aria-label="技能历史迁移" className="flex flex-col gap-4">
    <p className="text-ui text-text-2">迁移技能内容、资源和历史版本。账户数据中的角色、连接和启用设置不会导入。</p>
    <label className="text-ui text-text">数据格式<select className={inputClasses({ className: "mt-2" })} aria-label="数据格式" disabled={busy || started} value={format} onChange={event => { setFormat(event.target.value as SkillTransferFormat); setFile(null); setUpload(null); setPreview(null); setSelected([]); }}><option value="portable">技能历史文件</option><option value="account">账户导出文件</option></select></label>
    <Input label="迁移文件" type="file" accept={format === "account" ? ".json,.tar.gz,.tgz" : ".json"} disabled={busy || started} onChange={event => { setFile(event.target.files?.[0] ?? null); setUpload(null); setPreview(null); setSelected([]); }} />
    {!started && <Button disabled={!file || busy} loading={busy && !upload} onClick={() => void stage()}>上传迁移文件</Button>}
    {upload && format === "account" && <fieldset disabled={busy || started} className="flex flex-col gap-2"><legend className="text-ui text-text">选择要导入的技能</legend>{upload.sourceSkills.map(skill => <label key={skill.sourceId} className="flex items-center gap-2 text-ui text-text"><input type="checkbox" checked={selected.includes(skill.sourceId)} onChange={event => { setSelected(current => event.target.checked ? [...current, skill.sourceId] : current.filter(id => id !== skill.sourceId)); setPreview(null); }} />{skill.title}</label>)}{upload.sourceSkills.length === 0 && <p className="text-ui text-text-2">文件中没有可导入的技能。</p>}</fieldset>}
    {upload && !started && <Button variant="secondary" disabled={busy || format === "account" && !selected.length} onClick={() => void inspect()}>预览迁移</Button>}
    {preview && <section aria-label="迁移预览" className="flex flex-col gap-3"><p className="text-ui text-text-2">尚未完成原生验证，确认导入后逐个版本验证并保存。</p><List label="迁移技能" divided>{preview.skills.map(skill => <ListRow key={skill.sourceId} title={skill.title} meta={<><p>{skill.revisions} 个历史版本 · {skill.invocation.userInvocable ? "可主动调用" : "不支持主动调用"} · {skill.invocation.modelInvocable ? "可在科研中选用" : "不会自动选用"}</p>{skill.resources.map(resource => <p key={resource.path}>{resource.path} · {resource.size} 字节</p>)}</>} />)}</List></section>}
    {result?.mappings.some(mapping => mapping.imported > 0) && <List label="已保存的技能" divided>{result.mappings.filter(mapping => mapping.imported > 0).map(mapping => <ListRow key={mapping.sourceId} title={preview?.skills.find(skill => skill.sourceId === mapping.sourceId)?.title ?? "已保存的技能"} meta={`已保存 ${mapping.imported} 个版本`} to={`/app/extensions/skills/${encodeURIComponent(mapping.targetId)}`} />)}</List>}
    {result?.mappings.some(mapping => mapping.imported === 0) && <List label="待验证的技能" divided>{result.mappings.filter(mapping => mapping.imported === 0).map(mapping => <ListRow key={mapping.sourceId} title={preview?.skills.find(skill => skill.sourceId === mapping.sourceId)?.title ?? "待导入的技能"} meta="待验证，尚未保存" />)}</List>}
    {error && <p role="alert" className="text-ui text-error">{error}{recovery && !preview && <Button variant="text" disabled={busy} onClick={() => void recover()}>重试恢复预览</Button>}</p>}
    {result?.status === "complete" ? <p role="status" className="text-ui text-text">迁移完成；技能已保存，尚未启用。</p> : paused ? <p role="status" className="text-ui text-text-2">迁移已暂停；继续时会核对同一迁移进度。</p> : busy && started ? <p role="status" className="text-ui text-text-2">正在验证并保存历史版本</p> : null}
    <div className="flex gap-2">{preview && !started && <Button disabled={busy || !preview.skills.length} onClick={() => void run()}>确认迁移</Button>}{started && busy && <Button variant="secondary" onClick={() => { stop.current = true; setPaused(true); }}>暂停迁移</Button>}{started && !busy && result?.status !== "complete" && <Button disabled={!preview} onClick={() => void run()}>继续迁移</Button>}{(!started || result?.status === "complete" || recovery) && <Button variant="text" disabled={busy} onClick={onClose}>{started ? "完成" : "取消"}</Button>}</div>
  </section>;
}

/** Recovery comes only from current authenticated adoption journals, never browser persistence. */
export function PendingSkillTransfers({ onResume }: { onResume: (entry: PendingSkillTransfer) => void }) {
  const projectId = useProjectStore(state => state.currentId), requests = useRef(0), alive = useRef(true), pagePending = useRef(false);
  const [snapshot, setSnapshot] = useState<{ projectId: string; items: PendingSkillTransfer[]; nextCursor: string | null } | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const failedCursor = useRef<string | null>(null);
  const load = useCallback(async (cursor?: string | null) => {
    if (cursor && pagePending.current) return;
    const request = ++requests.current;
    if (!cursor) { setSnapshot(null); pagePending.current = false; }
    else pagePending.current = true;
    setError(null); setLoading(true); failedCursor.current = cursor ?? null;
    try {
      const value = await pendingPersonalSkillTransfers(cursor);
      if (alive.current && request === requests.current) setSnapshot(current => ({ projectId, nextCursor: value.nextCursor ?? null,
        items: [...new Map([...(cursor && current?.projectId === projectId ? current.items : []), ...value.items.filter(entry => entry.status === "in-progress")].map(entry => [`${entry.reference}\0${entry.idempotencyKey}`, entry])).values()],
      }));
    } catch (caught) { if (alive.current && request === requests.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current && request === requests.current) { setLoading(false); pagePending.current = false; } }
  }, [projectId]);
  useEffect(() => { const counter = requests; alive.current = true; void load(); return () => { alive.current = false; counter.current++; }; }, [load]);
  const current = snapshot?.projectId === projectId ? snapshot : null;
  if (!current?.items.length && !current?.nextCursor && !error) return null;
  return <section aria-label="未完成的技能迁移" className="mb-4"><h2 className="text-ui font-medium text-text">未完成的技能迁移</h2>
    {error && <p role="status" className="text-ui text-text-2">未能读取迁移记录。{error}<Button variant="text" disabled={loading} onClick={() => void load(failedCursor.current)}>重试读取迁移记录</Button></p>}
    {current && <List divided>{current.items.map(entry => <ListRow key={`${entry.reference}\0${entry.idempotencyKey}`} title={entry.format === "account" ? "账户技能迁移" : "技能历史迁移"} meta={`已保存 ${entry.mappings.reduce((total, mapping) => total + mapping.imported, 0)} / ${entry.mappings.reduce((total, mapping) => total + mapping.total, 0)} 个版本`} actions={<Button variant="text" aria-label="继续未完成的迁移" onClick={() => onResume(entry)}>继续</Button>} />)}</List>}
    {current?.nextCursor && <Button variant="text" disabled={loading} loading={loading} onClick={() => void load(current.nextCursor)}>加载更多迁移记录</Button>}
  </section>;
}
