import { useCallback, useEffect, useState } from "react";
import { WebApiError } from "@/lib/apiClient";
import { fetchFrontierOpsTags, frontierAbsence, frontierErrorMessage, undoFrontierTagChange, type FrontierOpsTags } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { stamp } from "@/components/frontier/frontierText";
import { OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows } from "./OpsCard";

/** What a change of the tag tree did (`tag_changes.action`), in an operator's words; one this build does not know is 「调整」, never its code. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  promote: "启用",
  merge: "合并",
  split: "拆分",
  dormant: "暂停使用",
  wake: "重新启用",
  reject: "不采用",
  undo: "撤回",
};

/** A tag that is not in use for readers, said beside its name (`active` says nothing). */
const STATE_WORDS: Readonly<Record<string, string>> = { candidate: "待启用", dormant: "暂停使用", merged: "已合并", rejected: "不采用" };

/** 「合并 肝癌 → 肝细胞癌」: the action, the tag, and the other tag where there is one. */
function changeLine(change: FrontierOpsTags["changes"][number]): string {
  const action = ACTION_WORDS[change.action] ?? "调整";
  return change.other ? `${action} ${change.tag.name} → ${change.other.name}` : `${action} ${change.tag.name}`;
}

/**
 * 「前沿标签」 in 运维 (operators only, as the other cards; 2026-10-23): each specialty's active tags with their 30-day counts, the
 * tags the editor proposed and that are not in use yet (「待启用」: name, count, sources, first seen), and the recent changes of the tree, each that can be taken back
 * with 「撤回」. A deployment whose 前沿动态 is off, whose server has no tag tree yet or runs no upkeep of it, shows no card.
 */
export function FrontierTagsCard() {
  const [tags, setTags] = useState<FrontierOpsTags | null>(null);
  const [absent, setAbsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTags(await fetchFrontierOpsTags());
    } catch (error) {
      // 前沿动态 off here, no such route yet, or no tag upkeep running (`frontier_tags_unavailable`): there is nothing to show.
      if (frontierAbsence(error) || (error instanceof WebApiError && error.code === "frontier_tags_unavailable")) setAbsent(true);
      else toast.error(`无法读取前沿标签：${frontierErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const undo = async (changeId: string) => {
    setUndoing(changeId);
    try {
      await undoFrontierTagChange(changeId);
      toast.success("已撤回");
      await refresh();
    } catch (error) {
      if (error instanceof WebApiError && error.code === "frontier_tag_change_not_undoable") {
        toast.error("这项调整已不能撤回");
        await refresh();
      } else {
        toast.error(frontierErrorMessage(error));
      }
    } finally {
      setUndoing(null);
    }
  };

  if (absent) return null;
  const specialties = (tags?.specialties ?? []).filter((specialty) => specialty.tags.length > 0);
  return (
    <OpsCard title="前沿标签" description="各专科的标签、待启用的标签和最近的调整" refresh={{ label: "刷新前沿标签", loading, onRefresh: () => void refresh() }}>
      <OpsBody>
        <div className="space-y-5">
          <OpsRows label="各专科的标签">
            {specialties.length === 0 ? <OpsNothing>{tags ? "还没有标签。" : "正在读取"}</OpsNothing> : specialties.map((specialty) => (
              <OpsRow key={specialty.key} className="items-start">
                <span className="w-20 shrink-0 text-text">{specialty.label}</span>
                <span className="min-w-0 flex-1 text-text-2">
                  {specialty.tags.map((tag, index) => (
                    <span key={tag.slug}>
                      {index > 0 && "、"}
                      {tag.name}
                      {STATE_WORDS[tag.state] && <span className="text-text-3">（{STATE_WORDS[tag.state]}）</span>}
                      {" "}<span className="tabular-nums text-text-3">{tag.count30d}</span>
                    </span>
                  ))}
                </span>
              </OpsRow>
            ))}
          </OpsRows>
          <OpsRows label="待启用的标签">
            {(tags?.candidates ?? []).length === 0 ? <OpsNothing>没有待启用的标签。</OpsNothing> : tags!.candidates.map((candidate) => (
              <OpsRow key={candidate.slug}>
                <span className="min-w-0 flex-1 truncate text-text">{candidate.name}</span>
                <span className="shrink-0 tabular-nums text-text-2">{candidate.count30d} 条 · {candidate.sources30d} 个来源</span>
                {candidate.firstSeen && <span className="shrink-0 tabular-nums text-text-3">{stamp(candidate.firstSeen)}</span>}
              </OpsRow>
            ))}
          </OpsRows>
          <OpsRows label="最近的调整">
            {(tags?.changes ?? []).length === 0 ? <OpsNothing>没有调整。</OpsNothing> : tags!.changes.map((change) => (
              <OpsRow key={change.id}>
                <span className="min-w-0 flex-1 truncate text-text">{changeLine(change)}</span>
                {change.reason && <span className="hidden max-w-[16rem] truncate text-caption text-text-3 sm:block">{change.reason}</span>}
                {change.at && <span className="shrink-0 tabular-nums text-text-3">{stamp(change.at)}</span>}
                {change.undoable && (
                  <Button variant="text" size="sm" loading={undoing === change.id} disabled={undoing !== null} onClick={() => void undo(change.id)}>撤回</Button>
                )}
              </OpsRow>
            ))}
          </OpsRows>
        </div>
      </OpsBody>
    </OpsCard>
  );
}
