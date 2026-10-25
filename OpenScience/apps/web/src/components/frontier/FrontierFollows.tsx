import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { addFrontierFollow, removeFrontierFollow, listFrontierFollows, frontierErrorMessage,
  FRONTIER_SPECIALTIES, FRONTIER_FOLLOWS_CHANGED, type FrontierFollow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { DataTable } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";
import { FrontierPrefsRow } from "./FrontierOnboarding";
import { TypedFollowInput } from "./TypedFollowInput";

/** The kinds a follow can be, in the reader's words; the card's menu makes the source and event ones, the feed's tag chip the tag ones. */
const KIND_WORDS: Record<FrontierFollow["kind"], string> = { topic: "主题", drug: "药物", specialty: "专科", source: "来源", event: "事件", tag: "标签", query: "关注词" };
/** What a typed follow was read as, in the reader's words. */
const READING_WORDS: Record<NonNullable<FrontierFollow["query"]>["kind"], string> = { drug: "药物", trial: "试验", disease: "疾病", topic: "主题", question: "问题" };

/** What a typed follow will match, said as the names it looks for: the things it is about, together. */
export function followReadingText(follow: FrontierFollow): string | null {
  if (!follow.query) return null;
  return follow.query.concepts.map((names) => names.join("、")).join(" ＋ ");
}

export function FrontierFollows({ selected, onSelect, onChanged }: {
  selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void;
}) {
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
  const act = async (operation: () => Promise<unknown>, clearSelection?: string) => {
    if (pending) return;
    setPending(true); setActionError(null);
    try {
      await operation();
      if (!alive.current) return;
      if (clearSelection && selection.current === clearSelection) onSelect(null);
      onChanged();
      await load();
    } catch (failure) { if (alive.current) setActionError(frontierErrorMessage(failure)); }
    finally { if (alive.current) setPending(false); }
  };
  const label = FRONTIER_SPECIALTIES.find((item) => item.key === specialty)?.label ?? specialty;
  const submitSpecialty = () => {
    if (!specialty) return;
    // The server upserts on the kind and key, so a second add changes nothing: say so instead of asking. A muted follow is the one
    // exception — adding it again is how it is turned back on.
    const held = rows.find((row) => row.kind === "specialty" && row.key === specialty);
    if (held && !held.muted) { setDuplicate(`已经关注了“${held.label}”`); return; }
    setDuplicate(null);
    void act(() => addFrontierFollow({ kind: "specialty", key: specialty, label }));
  };
  return <div className="space-y-4">
    <FrontierPrefsRow />
    {/* One input for what a reader wants to hear about, in their own words (c3-watch): its feed is what opens. */}
    <TypedFollowInput held={rows} onAdded={(follow) => { onChanged(); void load(); onSelect(follow.id); }} />
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); submitSpecialty(); }}>
      <Select label="按专科关注" value={specialty} onChange={(event) => { setSpecialty(event.target.value); setDuplicate(null); }}>
        {FRONTIER_SPECIALTIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
      </Select>
      <Button type="submit" variant="secondary" disabled={!specialty || pending}>关注专科</Button>
    </form>
    {duplicate && <p role="status" className="text-ui text-text-2">{duplicate}</p>}
    {actionError && <p role="alert" className="text-caption text-error">{actionError}</p>}
    <DataTable label="我的关注" rows={rows} rowKey={(row) => row.id} state={loading ? "loading" : error ? "error" : "content"}
      errorMessage={error ?? undefined} onRetry={() => void load()} emptyText="还没有关注。" columns={[
        { key: "label", header: "关注内容", rowHeader: true, cell: (row) => <div className="min-w-0">
          <Button size="sm" variant="text" aria-pressed={selected === row.id} disabled={row.muted} onClick={() => onSelect(row.id)}>{row.label}</Button>
          {followReadingText(row) && <p className="text-caption text-text-3">匹配：{followReadingText(row)}</p>}
        </div> },
        { key: "kind", header: "类型", cell: (row) => <Tag>{row.query ? `${KIND_WORDS[row.kind]} · ${READING_WORDS[row.query.kind]}` : KIND_WORDS[row.kind]}</Tag> },
        { key: "state", header: "状态", cell: (row) => row.muted ? "已屏蔽" : row.newItems ? `关注中 · ${row.newItems >= 99 ? "99+" : row.newItems} 条新动态` : "关注中" },
        { key: "actions", header: "管理", cell: (row) => <div className="flex gap-2">
          {row.kind !== "query" && <Button size="sm" variant="text" disabled={pending} aria-label={`${row.muted ? "取消屏蔽" : "屏蔽"} ${row.label}`}
            onClick={() => void act(() => addFrontierFollow({ kind: row.kind, key: row.key, label: row.label, muted: !row.muted }), !row.muted ? row.id : undefined)}>{row.muted ? "取消屏蔽" : "屏蔽"}</Button>}
          <Button size="sm" variant="text" disabled={pending} aria-label={`移除 ${row.label}`}
            onClick={() => void act(() => removeFrontierFollow(row.id), row.id)}>移除</Button>
        </div> },
      ]} />
    <p><Link to="/app/frontier?view=zones&scope=following" className="text-caption text-text-3 hover:text-accent">已关注的证据专区在“证据专区”里管理 ›</Link></p>
  </div>;
}
