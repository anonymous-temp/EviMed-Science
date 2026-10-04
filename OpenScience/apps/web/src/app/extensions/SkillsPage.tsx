import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BookOpen, Plus, Upload } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { productErrorMessage } from "@/lib/productClient";
import { createPersonalSkill, importPersonalSkill, listPersonalSkills, uploadPersonalSkill, previewPersonalSkillImport, previewPersonalSkillRepository, type SkillImportPreview, type PersonalSkill, type SkillWrite } from "@/lib/skillLibraryClient";
import { listWebResearchSessions, listWebAgentRuns } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { effectiveSkills, effectiveSkill, duplicateEffectiveSkill, type EffectiveSkill, type EffectiveSkillCatalogue, type EffectiveSkillDetail } from "@/lib/skillLibraryClient";
import { pendingPersonalSkillTransfers, type PendingSkillTransfer, uploadPersonalSkillTransfer, previewPersonalSkillTransfer, confirmPersonalSkillTransfer, personalSkillPortableUrl, type SkillTransferFormat, type SkillTransferUpload, type SkillTransferPreview, type SkillTransferResult, type SkillTransferIntent } from "@/lib/skillLibraryClient";
import { Tag } from "@/components/ui/Tag";
import { SkillPackagePanel } from "@/components/skills/SkillPackagePanel";
import { ExtensionsNavigation } from "./ExtensionsNavigation";
import { SkillEditor } from "./SkillEditor";

export function SkillsPage() {
  const projectId = useProjectStore(state => state.currentId);
  const [recovery, setRecovery] = useState<{ projectId: string; entry: PendingSkillTransfer } | null>(null);
  const navigate = useNavigate(), alive = useRef(true), generation = useRef(0), pageRequest = useRef<number | null>(null), importingRequest = useRef(false);
  const [items, setItems] = useState<PersonalSkill[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false), [file, setFile] = useState<File | null>(null), [title, setTitle] = useState("");
  const [importMode, setImportMode] = useState<"file" | "repository" | "transfer">("file"), [repository, setRepository] = useState(""), [commit, setCommit] = useState(""), [subdirectory, setSubdirectory] = useState("");
  const [preview, setPreview] = useState<{ resourceId: string; content: SkillImportPreview; source?: { repository: string; commit: string; subdirectory?: string } } | null>(null);
  const load = useCallback(async (after?: string | null) => {
    const paging = !!after;
    if (paging && pageRequest.current !== null) return;
    const request = paging ? generation.current : ++generation.current;
    if (paging) { pageRequest.current = request; setLoadingMore(true); }
    else { pageRequest.current = null; setLoadingMore(false); setLoading(true); }
    setError(null);
    try {
      const page = await listPersonalSkills(after);
      if (alive.current && request === generation.current) {
        setItems(current => [...new Map([...(paging ? current ?? [] : []), ...page.items].map(item => [item.id, item])).values()]); setCursor(page.nextCursor);
      }
    } catch (caught) { if (alive.current && request === generation.current) setError(productErrorMessage(caught)); }
    finally {
      if (alive.current && request === generation.current) {
        if (paging && pageRequest.current === request) { pageRequest.current = null; setLoadingMore(false); }
        if (!paging) setLoading(false);
      }
    }
  }, []);
  useEffect(() => { setRecovery(null); setImporting(false); setBusy(false); }, [projectId]);
  useEffect(() => { const requests = generation; alive.current = true; void load(); return () => { alive.current = false; requests.current++; }; }, [load]);
  const save = async (value: SkillWrite) => {
    setBusy(true); setError(null);
    try { const created = await createPersonalSkill(value); if (alive.current) navigate(`/app/extensions/skills/${encodeURIComponent(created.id)}`); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current) setBusy(false); }
  };
  const importFile = async () => {
    if (!title.trim() || importingRequest.current || importMode === "file" && !file) return;
    if (importMode === "repository" && (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.trim()) || !/^[a-f0-9]{40}$/.test(commit.trim()))) { setError("请填写公开仓库名称和完整的 40 位提交编号。"); return; }
    importingRequest.current = true;
    setBusy(true); setError(null);
    try {
      if (importMode === "repository") {
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
      if (alive.current) navigate(`/app/extensions/skills/${encodeURIComponent(created.id)}`);
    } catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { importingRequest.current = false; if (alive.current) setBusy(false); }
  };
  const visible = items?.filter(item => `${item.payload.title} ${item.payload.description}`.toLowerCase().includes(query.toLowerCase()));
  return <PageShell title="技能" actions={<><Button variant="text" aria-label="刷新技能" disabled={loading || busy} onClick={() => void load()}>刷新</Button><Button variant="text" disabled={busy} onClick={() => { setRecovery(null); setImporting(true); setEditing(false); setPreview(null); }}><Upload size={16} aria-hidden />导入</Button><Button disabled={busy} onClick={() => { setEditing(true); setImporting(false); setPreview(null); }}><Plus size={16} aria-hidden />创建技能</Button></>}>
    <ExtensionsNavigation value="skills" />
    {error && <p role="alert" className="my-4 text-ui text-error">{error}<Button variant="text" onClick={() => void load()}>重试</Button></p>}
    <div className="mt-6">
      {editing ? <SkillEditor initial={{ expectedRevision: 0, title: "", description: "", instructions: "" }} busy={busy} onSave={value => void save(value)} onCancel={() => setEditing(false)} />
        : importing && importMode === "transfer" && (!recovery || recovery.projectId === projectId) ? <SkillTransferImport key={projectId} recovery={recovery?.entry} onBusy={setBusy} onClose={() => { setBusy(false); setRecovery(null); setImporting(false); setImportMode("file"); void load(); }} />
        : importing ? <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void importFile(); }}>
          <div className="flex gap-2"><Button type="button" variant={importMode === "file" ? "secondary" : "text"} disabled={busy} onClick={() => { setImportMode("file"); setPreview(null); }}>本地文件</Button><Button type="button" variant={importMode === "repository" ? "secondary" : "text"} disabled={busy} onClick={() => { setImportMode("repository"); setPreview(null); }}>公开仓库</Button><Button type="button" variant="text" disabled={busy} onClick={() => { setImportMode("transfer"); setPreview(null); }}>历史与账户数据</Button></div>
          <Input label="技能名称" value={title} required disabled={busy} onChange={event => setTitle(event.target.value)} />
          {importMode === "file" ? <Input label="技能文件" type="file" accept=".md,.zip,.tgz,.gz" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} /> : <>
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
          <div className="flex gap-2"><Button type="submit" variant={preview ? "secondary" : "primary"} loading={busy}>预览</Button>{preview && <Button type="button" disabled={busy} onClick={() => void confirmImport()}>确认导入</Button>}<Button type="button" variant="text" disabled={busy} onClick={() => { setImporting(false); setPreview(null); }}>取消</Button></div>
        </form> : <>
          <PendingSkillTransfers onResume={entry => { setRecovery({ projectId, entry }); setImportMode("transfer"); setImporting(true); setEditing(false); setBusy(true); }} />
          <div className="mb-4 flex items-center gap-4"><Input aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)} /><Link to="/app/memory?tab=methods" className="shrink-0 text-ui text-accent">已学方法</Link></div>
          {items === null ? loading && <FilesSkeleton /> : visible?.length ? <List label="我的技能" divided>{visible.map(item => <ListRow key={item.id} leading={<BookOpen size={20} aria-hidden className="text-text-3" />} title={item.payload.title} meta={item.payload.description} actions={<a href={personalSkillPortableUrl(item.id)} download className="text-caption text-accent" aria-label={`导出 ${item.payload.title} 的历史`}>导出历史</a>} to={`/app/extensions/skills/${encodeURIComponent(item.id)}`} />)}</List>
            : <EmptyState icon={BookOpen} title={query ? "没有找到技能" : "还没有个人技能"} action={!query ? <Button onClick={() => setEditing(true)}>创建技能</Button> : undefined} />}
          {cursor && <Button variant="text" disabled={loading || loadingMore} loading={loadingMore} onClick={() => void load(cursor)}>加载更多</Button>}
        </>}
    </div>
    {!editing && !importing && <CurrentSessionSkills />}
  </PageShell>;
}


/** Runtime inventory stays distinct from authored library data and never activates a duplicate. */
function CurrentSessionSkills() {
  const navigate = useNavigate(), projectId = useProjectStore(state => state.currentId);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }> | null>(null), [sessionId, setSessionId] = useState("");
  const [catalogue, setCatalogue] = useState<EffectiveSkillCatalogue | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ entry: EffectiveSkill; content: EffectiveSkillDetail; context: string } | null>(null), [previewing, setPreviewing] = useState(false), [title, setTitle] = useState("");
  const [copying, setCopying] = useState(false), [copyError, setCopyError] = useState<string | null>(null);
  const alive = useRef(true), requests = useRef(0), sessionRequests = useRef(0), previewRequests = useRef(0), copyPending = useRef(false), keys = useRef(new Map<string, string>());
  const context = `${projectId}\0${sessionId}`, currentContext = useRef(context); currentContext.current = context;
  const loadCatalogue = useCallback(async () => {
    const request = ++requests.current; ++previewRequests.current; setPreview(null); setPreviewing(false); setCatalogue(null); setError(null); setCopyError(null);
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    try { const result = await effectiveSkills(projectId, sessionId); if (result.state === "available" && (!result.runtimeGeneration || result.sessionId !== sessionId)) throw new Error("Skill session changed."); if (alive.current && request === requests.current) { setCatalogue(result); } }
    catch (caught) { if (alive.current && request === requests.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current && request === requests.current) setLoading(false); }
  }, [projectId, sessionId]);
  const selectedSession = useRef(sessionId); selectedSession.current = sessionId;
  const loadSessions = useCallback(async (reset = true) => {
    const selected = selectedSession.current; const request = ++sessionRequests.current; ++requests.current; ++previewRequests.current; if (reset) setSessionId(""); setSessions(null); setCatalogue(null); setPreview(null); setPreviewing(false); setError(null); setLoading(true);
    try {
      const [owned, runs] = await Promise.all([listWebResearchSessions(), listWebAgentRuns({ projectId }).catch(() => [])]);
      if (!alive.current || request !== sessionRequests.current) return;
      const titles = new Map(runs.filter(run => run.sessionId).map(run => [run.sessionId, run.title || run.question]));
      const rows = owned.map((session, index) => ({ id: session.sessionId, title: titles.get(session.sessionId) || `${session.mode === "specialist" ? "专项" : "科研"}会话 ${index + 1}` }));
      setSessions(rows); setSessionId(!reset && rows.some(row => row.id === selected) ? selected : rows[0]?.id ?? "");
    } catch (caught) { if (alive.current && request === sessionRequests.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current && request === sessionRequests.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => { const sessionCounter = sessionRequests, catalogueCounter = requests, previewCounter = previewRequests; alive.current = true; void loadSessions(); return () => { alive.current = false; sessionCounter.current++; catalogueCounter.current++; previewCounter.current++; }; }, [loadSessions]);
  useEffect(() => { if (sessions !== null) void loadCatalogue(); }, [loadCatalogue, sessions]);
  const showPreview = async (entry: EffectiveSkill) => {
    if (catalogue?.state !== "available" || !catalogue.runtimeGeneration || !sessionId) return;
    const request = ++previewRequests.current, selected = context; setPreview(null); setPreviewing(true); setCopyError(null);
    try {
      const content = await effectiveSkill(projectId, entry.key, sessionId, catalogue.runtimeGeneration);
      if (!alive.current || request !== previewRequests.current || currentContext.current !== selected) return;
      if (content.state !== "available" || content.sessionId !== sessionId || content.runtimeGeneration !== catalogue.runtimeGeneration || content.skill.key !== entry.key) throw new Error("Skill context changed.");
      setPreview({ entry, content, context: selected }); setTitle(entry.personalRef?.title || entry.name);
    } catch (caught) { if (alive.current && request === previewRequests.current && currentContext.current === selected) setCopyError(productErrorMessage(caught)); }
    finally { if (alive.current && request === previewRequests.current) setPreviewing(false); }
  };
  const duplicate = async () => {
    if (!preview || preview.context !== context || !preview.entry.canDuplicate || !preview.content.skill.canDuplicate || !title.trim() || copyPending.current) return;
    const selected = preview, captured = context, intent = JSON.stringify({ context, key: selected.entry.key, generation: selected.content.runtimeGeneration, title: title.trim() });
    const idempotencyKey = keys.current.get(intent) ?? crypto.randomUUID(); keys.current.set(intent, idempotencyKey); copyPending.current = true; setCopying(true); setCopyError(null);
    try {
      const created = await duplicateEffectiveSkill(projectId, { sessionId, key: selected.entry.key, title: title.trim(), idempotencyKey, expectedRuntimeGeneration: selected.content.runtimeGeneration });
      keys.current.delete(intent); if (alive.current && currentContext.current === captured) navigate(`/app/extensions/skills/${encodeURIComponent(created.id)}`);
    } catch (caught) { if (alive.current && currentContext.current === captured) setCopyError(productErrorMessage(caught)); }
    finally { copyPending.current = false; if (alive.current) setCopying(false); }
  };
  const sourceName = (source: EffectiveSkill["source"]) => ({ builtin: "内置", community: "社区", personal: "个人", unknown: "来源尚未确认" })[source];
  return <section aria-label="当前会话技能" className="mt-8 border-t border-border pt-6">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-ui font-medium text-text">当前会话技能</h2><Button variant="text" aria-label="刷新当前会话技能" disabled={loading || copying} onClick={() => void loadSessions(false)}>刷新</Button></div>
    {sessions && sessions.length > 0 && <label className="mb-4 block text-ui text-text">科研会话<select className={inputClasses({ className: "mt-2" })} value={sessionId} disabled={copying} onChange={event => setSessionId(event.target.value)}>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
    {loading ? <p role="status" className="text-ui text-text-2">正在读取当前会话技能</p> : error ? <p role="status" className="text-ui text-error">{error}<Button variant="text" onClick={() => void (sessions?.length ? loadCatalogue() : loadSessions())}>重试</Button></p>
      : sessions?.length === 0 ? <p className="text-ui text-text-2">请先在科研工作台建立会话，再选择查看技能。<Link to="/app/chat" className="ml-2 text-accent">打开科研工作台</Link></p>
      : catalogue?.state === "unavailable" ? <p role="status" className="text-ui text-text-2">当前会话技能暂不可用</p>
      : catalogue?.state === "unknown" ? <p role="status" className="text-ui text-text-2">当前会话技能状态尚未确认</p>
      : catalogue?.state === "available" && <>
        {catalogue.items.length ? <List label="会话可见技能" divided>{catalogue.items.map(entry => <ListRow key={entry.key} title={entry.personalRef?.title || entry.name} meta={entry.description} trailing={<span className="flex items-center gap-2 text-caption text-text-3">{entry.supply && entry.supply.state !== "installed" && <Tag>{entry.supply.label}</Tag>}{sourceName(entry.source)}</span>} onOpen={() => void showPreview(entry)} actions={<Button variant="text" size="sm" aria-label={`预览 ${entry.personalRef?.title || entry.name}`} disabled={previewing || copying} onClick={() => void showPreview(entry)}>预览</Button>} />)}</List> : <p className="text-ui text-text-2">当前会话没有可见技能。</p>}
        {catalogue.learnedMethods.length > 0 && <section aria-label="当前项目已学方法" className="mt-6"><h3 className="mb-2 text-ui font-medium text-text">已学方法</h3><List divided>{catalogue.learnedMethods.map(method => <ListRow key={method.id} title={method.title} to={method.href} />)}</List></section>}
      </>}
    {previewing && <p role="status" className="mt-4 text-ui text-text-2">正在读取技能内容</p>}
    {copyError && <p role="alert" className="mt-4 text-ui text-error">{copyError}</p>}
    {preview && preview.context === context && <section aria-label="会话技能预览" className="mt-6 flex flex-col gap-3">
      <h3 className="text-ui font-medium text-text">{preview.entry.personalRef?.title || preview.entry.name}</h3>
      <p className="text-ui text-text-2">{preview.content.skill.description}</p>
      {preview.content.skill.whenToUse && <p className="text-ui text-text-2">{preview.content.skill.whenToUse}</p>}
      {preview.entry.supply && <p className="flex flex-wrap items-center gap-2 text-ui text-text-2"><Tag>{preview.entry.supply.label}</Tag><span>{preview.entry.supply.text}</span>{preview.entry.supply.sourceText && <span className="text-caption text-text-3">{preview.entry.supply.sourceText}{preview.entry.supply.licenceText ? ` · ${preview.entry.supply.licenceText}` : ""}</span>}</p>}
      <p className="text-caption text-text-2">{preview.content.skill.invocation.userInvocable ? "可主动调用" : "不支持主动调用"} · {preview.content.skill.invocation.modelInvocable ? "可在科研中选用" : "不会自动选用"}</p>
      <pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{preview.content.skill.instructions}</pre>
      {Object.keys(preview.content.skill.metadata).length > 0 && <details className="text-ui text-text-2"><summary>技能说明</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(preview.content.skill.metadata, null, 2)}</pre></details>}
      {(preview.content.skill.resources.length > 0 || preview.content.skill.scripts.length > 0) && <List label="技能资源" divided>{[...new Map([...preview.content.skill.resources, ...preview.content.skill.scripts].map(resource => [resource.path, resource])).values()].map(resource => <ListRow key={resource.path} title={resource.path} meta={preview.content.skill.scripts.some(script => script.path === resource.path) ? "脚本" : "资源"} />)}</List>}
      {preview.entry.personalRef && <Link to={`/app/extensions/skills/${encodeURIComponent(preview.entry.personalRef.skillId)}`} className="text-ui text-accent">打开个人技能 · 选用版本 {preview.entry.personalRef.revision}</Link>}
      {preview.entry.canDuplicate && preview.content.skill.canDuplicate ? <><Input label="复制后的技能名称" value={title} disabled={copying} onChange={event => setTitle(event.target.value)} /><p className="text-caption text-text-2">复制后进入个人技能库，可继续编辑。项目和新项目默认选用需另行确认。</p><div className="flex gap-2"><Button disabled={copying || !title.trim()} loading={copying} onClick={() => void duplicate()}>确认复制</Button><Button variant="text" disabled={copying} onClick={() => setPreview(null)}>关闭预览</Button></div></>
        : <><p className="text-ui text-text-2">此技能暂不支持复制。{preview.entry.personalRef ? "可打开个人技能继续编辑。" : ""}</p><Button variant="text" onClick={() => setPreview(null)}>关闭预览</Button></>}
    </section>}
  </section>;
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
    <div className="flex gap-2">{preview && !started && <Button disabled={busy || !preview.skills.length} onClick={() => void run()}>确认迁移</Button>}{started && busy && <Button variant="secondary" onClick={() => { stop.current = true; setPaused(true); }}>暂停迁移</Button>}{started && !busy && result?.status !== "complete" && <Button disabled={!preview} onClick={() => void run()}>继续迁移</Button>}{(!started || result?.status === "complete" || recovery) && <Button variant="text" disabled={busy} onClick={onClose}>{started ? "返回技能库" : "取消"}</Button>}</div>
  </section>;
}

/** Recovery comes only from current authenticated adoption journals, never browser persistence. */
function PendingSkillTransfers({ onResume }: { onResume: (entry: PendingSkillTransfer) => void }) {
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
