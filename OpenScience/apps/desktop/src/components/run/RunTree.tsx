import { AlertTriangle, GitBranch, Users } from "lucide-react";
import { budgetLimit, type RunView } from "@/lib/runStream";
import { buildRunTree } from "@/lib/runTree";
import { DeliverableCard } from "@/components/run/DeliverableCard";
import { cn } from "@/lib/cn";

/**
 * The run tree (§18.2): orchestrator → subagents → deliverables.
 *
 * Hidden knowledge: what this shows that the message stream cannot. A
 * delegating run goes quiet in the transcript for as long as its children work
 * — that silence is the normal shape of the work, and it is also exactly what a
 * dead run looks like. The tree is the answer: it says who was given what, what
 * each one is doing, and which contract each piece of work is being judged
 * against, while the conversation says nothing at all.
 *
 * A child whose own record never arrived is drawn, and labelled as such. The
 * alternative — dropping its deliverables, or filing them under the
 * orchestrator — would hide the one thing worth knowing, which is that two
 * streams describing the same run disagree.
 */

/** Subagent lifecycle in the reader's words. The vocabulary is the plan index's. */
const CHILD_STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "未完成",
  unknown: "状态未知",
};

export function RunTree({ view }: { view: RunView }) {
  const tree = buildRunTree(view);
  // Nothing delegated and nothing planned is the ordinary shape of a direct
  // answer, not an empty state to apologise for — so the section is absent
  // rather than showing "no data".
  if (tree.children.length === 0 && tree.unassigned.length === 0) return null;

  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h2 className="flex items-center gap-1.5 text-ui-sm font-medium text-text">
        <GitBranch size={13} aria-hidden />
        运行树
        <span className="text-caption font-normal text-muted">
          {tree.children.length} 个子代理 · {tree.deliverableCount} 件交付物
        </span>
      </h2>

      <div className="mt-3">
        <div className="flex items-center gap-2 text-ui-sm text-text">
          <Users size={13} className="text-muted" aria-hidden />
          编排器
          <span className="text-caption text-muted">
            步骤 {view.budget.steps}
            {budgetLimit(view.budget.limits, "steps") ? ` / ${budgetLimit(view.budget.limits, "steps")}` : ""}
          </span>
        </div>

        <ul className="mt-2 space-y-3 border-l border-border-faint pl-4">
          {tree.children.map((node) => (
            <li key={node.child.childSessionId}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-ui-sm text-text">{node.child.label || node.child.childSessionId}</span>
                {node.child.capability && (
                  <span className="rounded-input bg-surface-2 px-1.5 py-0.5 text-caption text-muted">
                    {node.child.capability}
                  </span>
                )}
                <span
                  className={cn(
                    "text-caption",
                    node.child.status === "failed" ? "text-error" : node.child.status === "completed" ? "text-ok" : "text-muted",
                  )}
                >
                  {CHILD_STATUS_LABEL[node.child.status] ?? node.child.status}
                </span>
                {!node.announced && (
                  <span className="inline-flex items-center gap-1 text-caption text-warn">
                    <AlertTriangle size={11} aria-hidden />
                    该子代理的自身记录未送达，此处由交付物反推
                  </span>
                )}
              </div>
              {node.child.report && (
                <p className="mt-1 whitespace-pre-wrap break-words text-caption leading-relaxed text-muted">
                  {node.child.report}
                </p>
              )}
              {node.deliverables.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {node.deliverables.map((deliverable) => (
                    <DeliverableCard key={deliverable.id} deliverable={deliverable} />
                  ))}
                </ul>
              )}
            </li>
          ))}

          {tree.unassigned.length > 0 && (
            <li>
              {/* Not "orphaned": an item with no child is the normal state of a
                * plan before delegation, and of work the orchestrator keeps. */}
              <div className="text-caption text-muted">尚未委派（或由编排器自己完成）</div>
              <ul className="mt-2 space-y-1.5">
                {tree.unassigned.map((deliverable) => (
                  <DeliverableCard key={deliverable.id} deliverable={deliverable} />
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
