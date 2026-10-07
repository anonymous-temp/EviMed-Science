import { Link2, XCircle } from "lucide-react";
import { baseName, formatDay } from "@/lib/format";
import { labelFor } from "@/lib/statusLabel";
import type { DuplicateGroup } from "@/lib/sourceClient";
import { Button } from "@/components/ui/Button";

const DUPLICATE_KINDS: Record<string, string> = {
  "version-family": "同一路径的多个版本",
  "shared-content": "同样内容出现在多个路径",
  "similar-name": "文件名归一化后相同",
};

/** The groups a row's 「处理疑似重复」 opened: what each holds and the two decisions. */
export function DuplicateGroups({ groups, busy, onDecide }: { groups: DuplicateGroup[]; busy: boolean; onDecide: (group: DuplicateGroup, decision: "linked" | "dismissed") => void }) {
  if (groups.length === 0) return <p className="text-ui text-text-3">没有发现疑似重复的资料。</p>;
  return <div className="divide-y divide-border">{groups.map((group) => <section key={group.groupKey} className="space-y-2 py-4 first:pt-0">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <h3 className="min-w-0 flex-1 truncate text-ui font-medium text-text">{baseName(group.label)}</h3>
      <span className="text-caption text-text-3">{labelFor(DUPLICATE_KINDS, group.kind, "其他相似情况")}</span>
    </div>
    <ul className="space-y-0.5 text-caption text-text-3">{group.members.map((item) => <li key={item.sourceId}>
      {[item.paths.map(baseName).join("、"), formatDay(item.updatedAt)].filter(Boolean).join(" · ")}
    </li>)}</ul>
    {group.decision && <p className="text-caption text-text-3">已标记为{group.decision.decision === "linked" ? "同一份资料" : "不是重复"}</p>}
    <div className="flex flex-wrap gap-2">
      {/* Linking is a statement about two sources. A shared-content group is
          one source under several paths, so there is nothing to link. */}
      {group.sourceIds.length > 1 && <Button size="sm" variant="secondary" disabled={busy}
        onClick={() => onDecide(group, "linked")}><Link2 size={16} aria-hidden="true" />标记为同一份</Button>}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(group, "dismissed")}><XCircle size={16} aria-hidden="true" />不是重复</Button>
    </div>
  </section>)}</div>;
}
