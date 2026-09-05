import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Brain, Plus, RotateCcw } from "lucide-react";
import { CapsuleTransferPanel } from "./CapsuleTransferPanel";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea, inputClasses } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { EmptyState } from "@/components/cards/EmptyState";
import { cn } from "@/lib/cn";
import {
  activateCapsule, addCapsuleEntry, createCapsule, listCapsuleEntries, listCapsules,
  productErrorMessage, restoreCapsule, trashCapsule, updateCapsuleEntry,
  type CapsuleEntry, type CapsuleRecord,
} from "@/lib/productClient";

const ENTRY_TYPES = [
  { value: "method_preference", label: "研究方法", layer: "methods" },
  { value: "writing_style", label: "写作偏好", layer: "profile" },
  { value: "preference", label: "一般偏好", layer: "profile" },
  { value: "expertise", label: "背景知识", layer: "knowledge" },
  { value: "project_fact", label: "项目事实", layer: "knowledge" },
  { value: "correction", label: "经验教训", layer: "episodes" },
];
const STATUS_LABEL: Record<string, string> = { candidate: "待确认", approved: "已采用", retired: "已停用" };

export function CapsulesPage() {
  const [view, setView] = useState<"active" | "trash">("active");
  const [capsules, setCapsules] = useState<CapsuleRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<CapsuleEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [entryCursor, setEntryCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [entryType, setEntryType] = useState(ENTRY_TYPES[0].value);
  const [mode, setMode] = useState("own");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entryRefresh, setEntryRefresh] = useState(0);
  const listGeneration = useRef(0);
  const currentView = useRef(view);
  const currentSelection = useRef(selected);
  currentView.current = view;
  currentSelection.current = selected;
  const current = capsules.find((item) => item.id === selected) ?? null;

  const reload = useCallback(async () => {
    if (currentView.current !== view) return;
    const generation = ++listGeneration.current;
    setLoading(true); setError(null);
    try {
      const page = await listCapsules({ deleted: view === "trash" });
      if (generation !== listGeneration.current || currentView.current !== view) return;
      setCapsules(page.items); setCursor(page.nextCursor);
      setSelected((id) => page.items.some((item) => item.id === id) ? id : page.items[0]?.id ?? null);
      setEntryRefresh((value) => value + 1);
    } catch (caught) { if (generation === listGeneration.current) setError(productErrorMessage(caught)); }
    finally { if (generation === listGeneration.current) setLoading(false); }
  }, [view]);

  useEffect(() => {
    const generation = listGeneration;
    void reload();
    return () => { generation.current++; };
  }, [reload]);
  useEffect(() => {
    let active = true;
    setEntries(null); setEntryCursor(null); setContent("");
    if (!selected || view === "trash") { setEntries([]); return () => { active = false; }; }
    void listCapsuleEntries(selected).then((page) => {
      if (active) { setEntries(page.items); setEntryCursor(page.nextCursor); }
    }).catch((caught) => { if (active) { setEntries([]); setError(productErrorMessage(caught)); } });
    return () => { active = false; };
  }, [selected, view, entryRefresh]);

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return false;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); return true; }
    catch (caught) { setError(productErrorMessage(caught)); return false; }
    finally { setBusy(false); }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const saved = await createCapsule({ title: title.trim(), description: description.trim() });
      listGeneration.current++;
      setLoading(false);
      setCapsules((items) => [saved, ...items]); setSelected(saved.id);
      setCreating(false); setTitle(""); setDescription(""); setView("active");
    });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!current || entries === null) return;
    void perform(async () => {
      const type = ENTRY_TYPES.find((item) => item.value === entryType) ?? ENTRY_TYPES[0];
      const saved = await addCapsuleEntry(current.id, { factKind: type.value, layer: type.layer, content: content.trim() });
      if (currentSelection.current === current.id) { setEntries((items) => [saved, ...(items ?? [])]); setContent(""); }
    });
  };
  const update = (entry: CapsuleEntry, values: { content?: string; status?: string }) => perform(async () => {
    if (!current) return;
    const saved = await updateCapsuleEntry(current.id, entry.id, { ...values, expectedRevision: entry.revision });
    setEntries((items) => items?.map((item) => item.id === saved.id ? saved : item) ?? []);
  });

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-content-full space-y-5 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div><h1 className="font-serif text-title text-text">记忆胶囊</h1><p className="mt-2 text-ui text-muted">保存研究方法、偏好与经验，在后续研究中继续使用。</p></div>
          <div className="flex gap-2"><Button variant="ghost" disabled={busy} onClick={() => setTransferring(value => !value)}>分享与导入</Button><Button disabled={busy} onClick={() => setCreating((value) => !value)}><Plus size={15} />新建胶囊</Button></div>
        </header>
        <fieldset disabled={busy}><SegmentedControl value={view} onChange={(value) => { setView(value); setSelected(null); }} aria-label="胶囊列表"
          options={[{ value: "active", label: "我的胶囊" }, { value: "trash", label: "回收站" }]} /></fieldset>
        {error && <div role="alert" className="flex items-center gap-3 rounded-card border border-error/30 bg-surface p-3 text-ui text-error">{error}<Button variant="ghost" size="sm" onClick={() => void reload()}>重试</Button></div>}
        {notice && <p role="status" className="text-ui text-ok">{notice}</p>}
        {transferring && <CapsuleTransferPanel capsule={current} onImported={saved => { listGeneration.current++; setLoading(false); setView("active"); setCapsules(items => [saved, ...items]); setSelected(saved.id); }} />}
        {creating && <Card title="新建胶囊"><form onSubmit={create} className="space-y-3">
          <Input label="胶囊名称" disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={150} required />
          <Textarea label="用途说明" disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={2} />
          <div className="flex gap-2"><Button type="submit" loading={busy} disabled={!title.trim()}>创建</Button><Button variant="ghost" onClick={() => setCreating(false)}>取消</Button></div>
        </form></Card>}
        {loading ? <MemorySkeleton /> : capsules.length === 0 ? (error ? null : <EmptyState icon={Brain} title={view === "trash" ? "回收站为空" : "还没有记忆胶囊"}
          description={view === "trash" ? "移入回收站的胶囊可以在这里恢复。" : "从一条常用的研究方法或写作偏好开始。"} />) : (
          <div className="grid items-start gap-5 lg:grid-cols-3">
            <div className="space-y-2">
              {capsules.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}
                className={cn("block w-full rounded-card border bg-surface p-4 text-left", selected === item.id ? "border-accent" : "border-border hover:bg-surface-2")}>
                <span className="block font-medium text-ui text-text">{item.payload.title}</span>
                {item.payload.description && <span className="mt-1 block text-ui-sm text-muted">{item.payload.description}</span>}
              </button>)}
              {cursor && <Button variant="ghost" loading={busy} onClick={() => void perform(async () => {
                const page = await listCapsules({ deleted: view === "trash", cursor }); setCapsules((items) => [...items, ...page.items]); setCursor(page.nextCursor);
              })}>加载更多胶囊</Button>}
            </div>
            {current && <Card className="lg:col-span-2" title={current.payload.title} hint="胶囊提供背景和方法，不改变研究证据的校验规则。">
              {view === "trash" ? <Button loading={busy} onClick={() => void perform(async () => { await restoreCapsule(current.id, current.revision); await reload(); setNotice("胶囊已恢复，可在我的胶囊中查看。"); })}><RotateCcw size={15} />恢复胶囊</Button> : <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="使用方式" disabled={busy} className={inputClasses({ className: "w-auto" })} value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="own">主要胶囊</option><option value="guest">参考胶囊</option><option value="blend">合并参考</option>
                  </select>
                  <Button loading={busy} onClick={() => void perform(async () => { await activateCapsule(current.id, mode); setNotice("已用于当前项目。"); })}>用于当前项目</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => { await trashCapsule(current.id, current.revision); await reload(); setNotice("已移至回收站，可在那里恢复。"); })}>移至回收站</Button>
                </div>
                <form onSubmit={add} className="space-y-3 border-t border-border pt-4">
                  <select aria-label="条目类型" disabled={busy} className={inputClasses()} value={entryType} onChange={(event) => setEntryType(event.target.value)}>
                    {ENTRY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                  <Textarea label="新增条目" disabled={busy} value={content} onChange={(event) => setContent(event.target.value)} maxLength={20000} rows={3} placeholder="例如：先说明结论，再列出证据和不确定性。" />
                  <Button type="submit" loading={busy} disabled={entries === null || !content.trim()}>保存条目</Button>
                </form>
                {entries === null ? <MemorySkeleton /> : entries.length === 0 ? <EmptyState title="还没有条目" description="手动保存的内容会直接采用；自动提取的建议需要你确认。" /> : <div className="space-y-3">
                  {entries.map((entry) => <EntryCard key={entry.id} entry={entry} busy={busy} onUpdate={(values) => update(entry, values)} />)}
                  {entryCursor && <Button variant="ghost" loading={busy} onClick={() => void perform(async () => {
                    const page = await listCapsuleEntries(current.id, entryCursor); setEntries((items) => [...(items ?? []), ...page.items]); setEntryCursor(page.nextCursor);
                  })}>加载更多条目</Button>}
                </div>}
              </div>}
            </Card>}
          </div>
        )}
      </main>
    </div>
  );
}

function EntryCard({ entry, busy, onUpdate }: { entry: CapsuleEntry; busy: boolean; onUpdate: (values: { content?: string; status?: string }) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.payload.content);
  const status = entry.payload.status;
  useEffect(() => { if (!editing) setValue(entry.payload.content); }, [entry.payload.content, editing]);
  return <article className="space-y-3 rounded-card border border-border p-4">
    <div className="flex items-center justify-between gap-2 text-ui-sm"><span className="text-muted">{ENTRY_TYPES.find((item) => item.value === entry.payload.factKind)?.label ?? "研究记录"} · 版本 {entry.revision}</span>
      <span className={status === "candidate" ? "text-warn" : "text-muted"}>{STATUS_LABEL[status] ?? status}</span></div>
    {editing ? <><Textarea label="修订条目" disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} maxLength={20000} rows={4} />
      <details className="text-ui-sm text-muted"><summary>当前已保存内容</summary><p className="mt-2 whitespace-pre-wrap">{entry.payload.content}</p></details></> : <p className="whitespace-pre-wrap text-ui text-text">{entry.payload.content}</p>}
    <div className="flex flex-wrap gap-2">
      {editing ? <><Button size="sm" disabled={busy || !value.trim()} onClick={() => void onUpdate({ content: value.trim() }).then((saved) => { if (saved) setEditing(false); })}>保存修订</Button><Button variant="ghost" size="sm" onClick={() => setEditing(false)}>取消修订</Button></>
        : <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(true)}>修订</Button>}
      {status !== "approved" ? <Button size="sm" disabled={busy} onClick={() => void onUpdate({ status: "approved" })}>{status === "candidate" ? "采用" : "恢复采用"}</Button>
        : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onUpdate({ status: "retired" })}>停用</Button>}
    </div>
    {entry.payload.provenance.length > 0 && <p className="text-caption text-muted">保留 {entry.payload.provenance.length} 条来源记录 · {entry.payload.origin === "explicit" ? "手动记录" : "从研究过程提取"}</p>}
  </article>;
}
