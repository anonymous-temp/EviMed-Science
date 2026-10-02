import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BookOpen, Plus, Upload } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { productErrorMessage } from "@/lib/productClient";
import { createPersonalSkill, importPersonalSkill, listPersonalSkills, uploadPersonalSkill, previewPersonalSkillImport, type SkillImportPreview, type PersonalSkill, type SkillWrite } from "@/lib/skillLibraryClient";
import { ExtensionsNavigation } from "./ExtensionsNavigation";
import { SkillEditor } from "./SkillEditor";

export function SkillsPage() {
  const navigate = useNavigate(), alive = useRef(true), generation = useRef(0), pageRequest = useRef<number | null>(null), importingRequest = useRef(false);
  const [items, setItems] = useState<PersonalSkill[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false), [file, setFile] = useState<File | null>(null), [title, setTitle] = useState("");
  const [preview, setPreview] = useState<{ resourceId: string; content: SkillImportPreview } | null>(null);
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
  useEffect(() => { const requests = generation; alive.current = true; void load(); return () => { alive.current = false; requests.current++; }; }, [load]);
  const save = async (value: SkillWrite) => {
    setBusy(true); setError(null);
    try { const created = await createPersonalSkill(value); if (alive.current) navigate(`/app/extensions/skills/${encodeURIComponent(created.id)}`); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current) setBusy(false); }
  };
  const importFile = async () => {
    if (!file || !title.trim() || importingRequest.current) return;
    importingRequest.current = true;
    setBusy(true); setError(null);
    try {
      const upload = await uploadPersonalSkill(file);
      const content = await previewPersonalSkillImport(upload.resourceId);
      if (alive.current) setPreview({ resourceId: upload.resourceId, content });
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
  return <PageShell title="技能" actions={<><Button variant="text" aria-label="刷新技能" disabled={loading || busy} onClick={() => void load()}>刷新</Button><Button variant="text" disabled={busy} onClick={() => { setImporting(true); setEditing(false); setPreview(null); }}><Upload size={16} aria-hidden />导入</Button><Button disabled={busy} onClick={() => { setEditing(true); setImporting(false); setPreview(null); }}><Plus size={16} aria-hidden />创建技能</Button></>}>
    <ExtensionsNavigation value="skills" />
    {error && <p role="alert" className="my-4 text-ui text-error">{error}<Button variant="text" onClick={() => void load()}>重试</Button></p>}
    <div className="mt-6">
      {editing ? <SkillEditor initial={{ expectedRevision: 0, title: "", description: "", instructions: "" }} busy={busy} onSave={value => void save(value)} onCancel={() => setEditing(false)} />
        : importing ? <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void importFile(); }}>
          <Input label="技能名称" value={title} required disabled={busy} onChange={event => setTitle(event.target.value)} />
          <Input label="技能文件" type="file" accept=".md,.zip,.tgz,.gz" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} />
          {preview && <section aria-label="导入预览" className="flex flex-col gap-3">
            <p className="text-ui text-text-2">{preview.content.description}</p>
            <pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{preview.content.instructions}</pre>
            <p className="text-caption text-text-2">{preview.content.invocation.userInvocable ? "可主动调用" : "不支持主动调用"} · {preview.content.invocation.modelInvocable ? "可在科研中选用" : "不会自动选用"}</p>
            {preview.content.resources.length > 0 && <List label="导入资源" divided>{preview.content.resources.map(resource => <ListRow key={resource.path} title={resource.path} meta={/^scripts\//.test(resource.path) ? "脚本" : "资源"} />)}</List>}
          </section>}
          <div className="flex gap-2"><Button type="submit" variant={preview ? "secondary" : "primary"} loading={busy}>预览</Button>{preview && <Button type="button" disabled={busy} onClick={() => void confirmImport()}>确认导入</Button>}<Button type="button" variant="text" disabled={busy} onClick={() => { setImporting(false); setPreview(null); }}>取消</Button></div>
        </form> : <>
          <div className="mb-4 flex items-center gap-4"><Input aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)} /><Link to="/app/memory?tab=methods" className="shrink-0 text-ui text-accent">已学方法</Link></div>
          {items === null ? loading && <FilesSkeleton /> : visible?.length ? <List label="我的技能" divided>{visible.map(item => <ListRow key={item.id} leading={<BookOpen size={20} aria-hidden className="text-text-3" />} title={item.payload.title} meta={item.payload.description} to={`/app/extensions/skills/${encodeURIComponent(item.id)}`} />)}</List>
            : <EmptyState icon={BookOpen} title={query ? "没有找到技能" : "还没有个人技能"} action={!query ? <Button onClick={() => setEditing(true)}>创建技能</Button> : undefined} />}
          {cursor && <Button variant="text" disabled={loading || loadingMore} loading={loadingMore} onClick={() => void load(cursor)}>加载更多</Button>}
        </>}
    </div>
  </PageShell>;
}
