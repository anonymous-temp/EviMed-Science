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
/**
 * Component: NeedsBar; owner: H; rules: DS23.
 * Anatomy: First outstanding need, its action, total count and optional route to remaining needs.
 * Variants: Warning note by default; quiet inline presentation when embedded in GEO.
 * States: Empty needs render nothing; displays caller-supplied needs without a loading state.
 * Hit area: Shared controls retain their standard targets.
 * Keyboard: Native controls preserve Tab and activation behavior.
 * Long content: Text wraps within the available reading width.
 * Theme: Shared surface, border and ink tokens.
 * Responsive: Content follows the parent workspace width.
 * Verification: Focused component behavior tests and fixture walkthrough.
 */
export function NeedsBar({ needs, more, quiet = false }: { needs: readonly WorkNeed[]; more?: ReactNode; quiet?: boolean }) {
  const first = needs[0];
  if (!first) return null;
  if (quiet) return <div data-work-needs={needs.length} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-2"><span>{`等你 · ${WORK_NEED_LABEL[first.kind]} ${first.text}`}{needs.length > 1 ? `（共 ${needs.length} 项）` : ""}</span>{first.action}{needs.length > 1 && more}</div>;
  return (
    <div data-work-needs={needs.length} className="mb-4">
      <Note tone="warn" action={<span className="flex flex-wrap items-center gap-3">{first.action}{needs.length > 1 && more}</span>}>
        <span>{`等你 · ${WORK_NEED_LABEL[first.kind]}`}</span>{` ${first.text}`}{needs.length > 1 ? `（共 ${needs.length} 项）` : ""}
      </Note>
    </div>
  );
}
