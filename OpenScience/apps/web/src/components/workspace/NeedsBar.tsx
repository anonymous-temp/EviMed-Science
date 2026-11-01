import { type ReactNode } from "react";
import { Note } from "@/components/ui/Note";
import type { WorkNeedKind } from "@/lib/workState";
import { WORK_NEED_LABEL } from "@evimed/domain";

export interface WorkNeed {
  key: string;
  kind: WorkNeedKind;
  text: string;
  /** Where it is done: the need is answered in its own place, never from here. */
  action?: ReactNode;
}

/**
 * What the work is waiting for from its person, over the results of every view (DESIGN.md, 模块工作台): 待提供, 待确认, 需处理, 平台外.
 * It lists only what already needs a person; adding a row here is never a way to add an approval. The first need is said and the rest are
 * counted, with `more` the way to the whole list; with nothing waiting it draws nothing.
 */
export function NeedsBar({ needs, more }: { needs: readonly WorkNeed[]; more?: ReactNode }) {
  const first = needs[0];
  if (!first) return null;
  return (
    <div data-work-needs={needs.length} className="mb-4">
      <Note tone="warn" action={<span className="flex flex-wrap items-center gap-3">{first.action}{needs.length > 1 && more}</span>}>
        <span className="font-semibold">{`等你 · ${WORK_NEED_LABEL[first.kind]}`}</span>{`　${first.text}`}{needs.length > 1 ? `（共 ${needs.length} 项）` : ""}
      </Note>
    </div>
  );
}
