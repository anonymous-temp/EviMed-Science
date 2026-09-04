/**
 * The run tree: orchestrator → subagents → deliverables (§18.2).
 *
 * Hidden knowledge: what joins the three levels, and what happens when the join
 * fails. Two independent streams describe the same run — `subagent/update` says
 * a child exists and how it is doing, `deliverable/update` says a planned item
 * exists and what the gate made of it — and the only thing linking them is the
 * `childSessionId` the run's own plan index records when the item is delegated.
 *
 * So three cases exist and they are not the same fact:
 *
 * - a child with items: the ordinary case;
 * - an item with no child yet (`childSessionId: null`): planned, queued, or
 *   done by the orchestrator itself. It belongs at the top level, not hidden
 *   under some child that did not do it;
 * - an item naming a child nothing ever announced. That is a gap between the
 *   two streams, and inventing a child that reads like any other would bury it.
 *   The node is synthesized and marked `announced: false`, so the tree says
 *   "this work happened somewhere we were not told about" instead of quietly
 *   presenting a guess.
 *
 * Pure, and separate from the component, because the joining is the part worth
 * testing and a component test cannot distinguish "grouped wrong" from
 * "rendered wrong".
 *
 * @module lib/runTree
 */

import type { DeliverableNode, RunView, SubagentNode } from "@/lib/runStream";

export interface RunTreeChild {
  child: SubagentNode;
  /** Whether a `subagent/update` frame ever described this child. */
  announced: boolean;
  deliverables: DeliverableNode[];
}

export interface RunTree {
  /** Deliverables not yet delegated to anyone, in plan order. */
  unassigned: DeliverableNode[];
  children: RunTreeChild[];
  /** Every deliverable in the run, whatever it hangs under. */
  deliverableCount: number;
}

/**
 * @param view the browser's picture of one run
 * @returns the same facts, joined into the tree the page draws
 */
export function buildRunTree(view: RunView): RunTree {
  const children = new Map<string, RunTreeChild>();
  for (const child of view.subagents) {
    children.set(child.childSessionId, { child, announced: true, deliverables: [] });
  }
  const unassigned: DeliverableNode[] = [];
  for (const deliverable of view.deliverables) {
    const sessionId = deliverable.childSessionId;
    if (!sessionId) {
      unassigned.push(deliverable);
      continue;
    }
    let node = children.get(sessionId);
    if (!node) {
      node = {
        child: {
          childSessionId: sessionId,
          label: deliverable.capability || deliverable.title || sessionId,
          capability: deliverable.capability,
          status: "unknown",
        },
        announced: false,
        deliverables: [],
      };
      children.set(sessionId, node);
    }
    node.deliverables.push(deliverable);
  }
  return {
    unassigned,
    children: [...children.values()],
    deliverableCount: view.deliverables.length,
  };
}
