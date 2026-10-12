import { useMemo, useState } from "react";
import { ListRow, List } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { WordCloud } from "@/components/charts/WordCloud";
import { webErrorMessage } from "@/lib/apiClient";
import { editTopic, type MapTopic, type TopicEdit } from "@/lib/memoryMapClient";
import { toast } from "@/lib/toast";

/** Fewer topics than this and a cloud is a handful of words: the ranking says it better. */
export const MIN_TOPICS = 6;

/** 「近 30 天 +3」 / 「持平」 / 「近 30 天 −2」: the trend as words and a sign, never colour alone. */
export function trendWords(trend: number): string {
  return trend > 0 ? `↑ 近 30 天 +${trend}` : trend < 0 ? `↓ 近 30 天 −${Math.abs(trend)}` : "→ 持平";
}

/**
 * 「主题」: what the memories are about, as a cloud beside the ranking it is a picture of (spec §2, V2). Every word is a topic, its
 * size the number of memories in it — the number the ranking prints — so the cloud is never a guess; choosing a word or a row
 * narrows the whole map to that topic, and choosing it again lets go. The researcher's word is the stronger one: a topic can be
 * renamed in place, merged into another, or dismissed with 「不是这个」, and a regrouping keeps all three.
 */
export function TopicsView({ topics, selected, grouping, status, onChoose, onChanged }: {
  topics: readonly MapTopic[];
  selected: string | null;
  /** A regrouping is on its way. */
  grouping: boolean;
  status: "ready" | "stale" | "empty" | "off";
  onChoose: (id: string | null) => void;
  /** After an edit: the document is read again. */
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ranked = useMemo(() => [...topics].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id)), [topics]);
  const widest = Math.max(1, ...ranked.map((topic) => topic.weight));

  const edit = async (id: string, change: TopicEdit, done: string) => {
    setBusy(true);
    try {
      await editTopic(id, change);
      toast.success(done);
      if ("dismiss" in change && selected === id) onChoose(null);
      onChanged();
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "没有改成，请重试。" }));
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  };

  if (ranked.length === 0) {
    return (
      <p role="status" className="text-ui text-text-2">
        {grouping || status === "stale" ? "正在把记忆整理成主题……" : status === "off" ? "这里还没有开通主题。" : "记下的内容还不多，再多聊几次，这里会长出你关心的主题。"}
      </p>
    );
  }

  const menuFor = (topic: MapTopic): MenuEntry[] => [
    { label: "改名", onSelect: () => setRenaming({ id: topic.id, text: topic.label }) },
    ...(ranked.length > 1 ? ["separator" as const, { heading: "合并到" }, ...ranked.filter((other) => other.id !== topic.id).slice(0, 12).map((other) => ({
      label: other.label, onSelect: () => void edit(topic.id, { mergeInto: other.id }, `已合并到“${other.label}”`),
    }))] : []),
    "separator",
    { label: "不是这个", destructive: true, onSelect: () => void edit(topic.id, { dismiss: true }, "已去掉这个主题") },
  ];

  return (
    <div className="grid items-start gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {ranked.length >= MIN_TOPICS
        ? <WordCloud topics={ranked} selected={selected} onChoose={(id) => onChoose(id === selected ? null : id)} label={`主题云，共 ${ranked.length} 个主题，排行在旁边。`} />
        : <p className="text-ui text-text-2">主题还不多，先看右边的排行。</p>}
      <List label="主题排行">
        {ranked.map((topic) => (
          renaming?.id === topic.id ? (
            <li key={topic.id} className="px-2 py-2">
              <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (renaming.text.trim()) void edit(topic.id, { label: renaming.text.trim() }, "已改名"); }}>
                <Input aria-label="主题的新名字" autoFocus maxLength={20} value={renaming.text} onChange={(event) => setRenaming({ id: topic.id, text: event.target.value })} />
                <Button type="submit" size="sm" loading={busy} disabled={!renaming.text.trim()}>保存</Button>
                <Button size="sm" variant="text" onClick={() => setRenaming(null)}>取消</Button>
              </form>
            </li>
          ) : (
            <ListRow
              key={topic.id}
              title={topic.label}
              selected={selected === topic.id}
              onOpen={() => onChoose(selected === topic.id ? null : topic.id)}
              meta={
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(6, Math.round((topic.weight / widest) * 96))}px` }} />
                  <span>{`${topic.weight} 条记忆 · ${trendWords(topic.trend)}`}</span>
                </span>
              }
              menu={<Menu label={`“${topic.label}”的操作`} items={menuFor(topic)} />}
            />
          )
        ))}
      </List>
    </div>
  );
}
