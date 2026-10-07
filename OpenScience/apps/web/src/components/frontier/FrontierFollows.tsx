import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { addFrontierFollow, removeFrontierFollow, listFrontierFollows, frontierErrorMessage,
  FRONTIER_SPECIALTIES, FRONTIER_FOLLOWS_CHANGED, type FrontierFollow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { DataTable } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";

type EditableKind = "topic" | "drug" | "specialty";

/** What a reader types for each kind, shown as the field's example; a specialty is chosen from the list instead. */
const EXAMPLES: Record<"topic" | "drug", string> = { topic: "例如：房颤抗凝", drug: "例如：司美格鲁肽" };
/** The kinds a follow can be, in the reader's words; the card's menu makes the source and event ones. */
const KIND_WORDS: Record<FrontierFollow["kind"], string> = { topic: "主题", drug: "药物", specialty: "专科", source: "来源", event: "事件" };
export function FrontierFollows({ selected, onSelect, onChanged }: {
  selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void;
}) {
  const [kind, setKind] = useState<EditableKind>("topic");
  const [text, setText] = useState("");
  const [specialty, setSpecialty] = useState(FRONTIER_SPECIALTIES[0]?.key ?? "");
  const [rows, setRows] = useState<FrontierFollow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The follow the reader tried to add twice, said where they are looking. */
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selection = useRef(selected);
  selection.current = selected;
  const alive = useRef(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const at = ++generation.current;
    setLoading(true); setError(null);
    try { const result = await listFrontierFollows(); if (alive.current && at === generation.current) setRows(result); }
    catch (failure) { if (alive.current && at === generation.current) setError(frontierErrorMessage(failure)); }
    finally { if (alive.current && at === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    const changed = () => { void load(); };
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, changed);
    return () => { alive.current = false; window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, changed); };
  }, [load]);
  const act = async (operation: () => Promise<unknown>, clearSelection?: string, clearDraft?: string) => {
    if (pending) return;
    setPending(true); setActionError(null);
    try {
      await operation();
      if (!alive.current) return;
      if (clearSelection && selection.current === clearSelection) onSelect(null);
      onChanged();
      if (clearDraft !== undefined) setText((current) => current === clearDraft ? "" : current);
      await load();
    } catch (failure) { if (alive.current) setActionError(frontierErrorMessage(failure)); }
    finally { if (alive.current) setPending(false); }
  };
  const key = kind === "specialty" ? specialty : text.trim();
  const label = kind === "specialty" ? FRONTIER_SPECIALTIES.find((item) => item.key === specialty)?.label ?? specialty : key;
  const submit = () => {
    if (!key) return;
    // The server upserts on the lower-cased kind and key, so a second add changes nothing: say so instead of asking. A muted
    // follow is the one exception — adding it again is how it is turned back on.
    const held = rows.find((row) => row.kind === kind && row.key.toLowerCase() === key.toLowerCase());
    if (held && !held.muted) { setDuplicate(`已经关注了“${held.label}”`); return; }
    setDuplicate(null);
    void act(() => addFrontierFollow({ kind, key, label }), undefined, kind === "specialty" ? undefined : text);
  };
  return <div className="space-y-4">
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Select label="关注类型" value={kind} onChange={(event) => { setKind(event.target.value as EditableKind); setDuplicate(null); }}>
        <option value="topic">主题</option><option value="drug">药物</option><option value="specialty">专科</option>
      </Select>
      {kind === "specialty"
        ? <Select label="关注专科" value={specialty} onChange={(event) => { setSpecialty(event.target.value); setDuplicate(null); }}>
          {FRONTIER_SPECIALTIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </Select>
        : <Input label="关注内容" value={text} maxLength={120} placeholder={EXAMPLES[kind]} onChange={(event) => { setText(event.target.value); setDuplicate(null); }} />}
      <Button type="submit" disabled={!key || pending}>添加关注</Button>
    </form>
    {duplicate && <p role="status" className="text-ui text-text-2">{duplicate}</p>}
    {actionError && <p role="alert" className="text-caption text-error">{actionError}</p>}
    <DataTable label="我的关注" rows={rows} rowKey={(row) => row.id} state={loading ? "loading" : error ? "error" : "content"}
      errorMessage={error ?? undefined} onRetry={() => void load()} emptyText="还没有关注。" columns={[
        { key: "label", header: "关注内容", rowHeader: true, cell: (row) => <Button size="sm" variant="text" aria-pressed={selected === row.id}
          disabled={row.muted} onClick={() => onSelect(row.id)}>{row.label}</Button> },
        { key: "kind", header: "类型", cell: (row) => <Tag>{KIND_WORDS[row.kind]}</Tag> },
        { key: "state", header: "状态", cell: (row) => row.muted ? "已屏蔽" : "关注中" },
        { key: "actions", header: "管理", cell: (row) => <div className="flex gap-2">
          <Button size="sm" variant="text" disabled={pending} aria-label={`${row.muted ? "取消屏蔽" : "屏蔽"} ${row.label}`}
            onClick={() => void act(() => addFrontierFollow({ kind: row.kind, key: row.key, label: row.label, muted: !row.muted }), !row.muted ? row.id : undefined)}>{row.muted ? "取消屏蔽" : "屏蔽"}</Button>
          <Button size="sm" variant="text" disabled={pending} aria-label={`移除 ${row.label}`}
            onClick={() => void act(() => removeFrontierFollow(row.id), row.id)}>移除</Button>
        </div> },
      ]} />
    <p><Link to="/app/frontier/zones?scope=following" className="text-caption text-text-3 hover:text-accent">已关注的证据专区在“证据专区”里管理 ›</Link></p>
  </div>;
}
