import { useCallback, useEffect, useId, useRef, useState } from "react";
import { addFrontierFollow, removeFrontierFollow, listFrontierFollows, frontierErrorMessage,
  FRONTIER_SPECIALTIES, FRONTIER_FOLLOWS_CHANGED, type FrontierFollow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";
import { DataTable } from "@/components/ui/DataTable";

type EditableKind = "topic" | "drug" | "specialty";
export function FrontierFollows({ selected, onSelect, onChanged }: {
  selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void;
}) {
  const kindId = useId(), specialtyId = useId();
  const [kind, setKind] = useState<EditableKind>("topic");
  const [text, setText] = useState("");
  const [specialty, setSpecialty] = useState(FRONTIER_SPECIALTIES[0]?.key ?? "");
  const [rows, setRows] = useState<FrontierFollow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  return <div className="space-y-4">
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (key) void act(() => addFrontierFollow({ kind, key, label }), undefined, kind === "specialty" ? undefined : text); }}>
      <div><label htmlFor={kindId} className="mb-1 block text-caption text-text-2">关注类型</label>
        <select id={kindId} className={inputClasses()} value={kind} onChange={(event) => setKind(event.target.value as EditableKind)}>
          <option value="topic">主题</option><option value="drug">药物</option><option value="specialty">专科</option>
        </select>
      </div>
      {kind === "specialty" ? <div><label htmlFor={specialtyId} className="mb-1 block text-caption text-text-2">关注专科</label>
        <select id={specialtyId} className={inputClasses()} value={specialty} onChange={(event) => setSpecialty(event.target.value)}>
          {FRONTIER_SPECIALTIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></div> : <Input label="关注内容" value={text} maxLength={120} onChange={(event) => setText(event.target.value)} />}
      <Button type="submit" disabled={!key || pending}>添加关注</Button>
    </form>
    {actionError && <p role="alert" className="text-caption text-error">{actionError}</p>}
    <DataTable label="我的关注" rows={rows} rowKey={(row) => row.id} state={loading ? "loading" : error ? "error" : "content"}
      errorMessage={error ?? undefined} onRetry={() => void load()} emptyText="还没有关注主题。" columns={[
        { key: "label", header: "关注内容", rowHeader: true, cell: (row) => <Button size="sm" variant="text" aria-pressed={selected === row.id}
          disabled={row.muted} onClick={() => onSelect(row.id)}>{row.label}</Button> },
        { key: "state", header: "状态", cell: (row) => row.muted ? "已屏蔽" : "关注中" },
        { key: "actions", header: "管理", cell: (row) => <div className="flex gap-2">
          <Button size="sm" variant="text" disabled={pending} aria-label={`${row.muted ? "取消屏蔽" : "屏蔽"} ${row.label}`}
            onClick={() => void act(() => addFrontierFollow({ kind: row.kind, key: row.key, label: row.label, muted: !row.muted }), !row.muted ? row.id : undefined)}>{row.muted ? "取消屏蔽" : "屏蔽"}</Button>
          <Button size="sm" variant="text" disabled={pending} aria-label={`移除 ${row.label}`}
            onClick={() => void act(() => removeFrontierFollow(row.id), row.id)}>移除</Button>
        </div> },
      ]} />
  </div>;
}
