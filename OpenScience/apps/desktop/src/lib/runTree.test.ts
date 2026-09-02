import { describe, expect, it } from "vitest";

import { buildRunTree } from "./runTree";
import { emptyRunView, type DeliverableNode, type RunView, type SubagentNode } from "./runStream";

function child(overrides: Partial<SubagentNode> & { childSessionId: string }): SubagentNode {
  return { label: overrides.childSessionId, capability: "", status: "running", ...overrides };
}

function deliverable(overrides: Partial<DeliverableNode> & { id: string }): DeliverableNode {
  return {
    contractKind: "research-brief",
    capability: "",
    title: overrides.id,
    childSessionId: null,
    status: "planned",
    issues: [],
    ...overrides,
  };
}

function view(overrides: Partial<RunView> = {}): RunView {
  return { ...emptyRunView("run_1"), ...overrides };
}

describe("joining two streams into one tree", () => {
  it("hangs each deliverable under the child it was delegated to", () => {
    const tree = buildRunTree(view({
      subagents: [child({ childSessionId: "c1", label: "证据综述", capability: "clinical-evidence-synthesis" })],
      deliverables: [deliverable({ id: "d1", childSessionId: "c1", status: "accepted" })],
    }));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].deliverables.map((item) => item.id)).toEqual(["d1"]);
    expect(tree.unassigned).toEqual([]);
    expect(tree.deliverableCount).toBe(1);
  });

  it("keeps an undelegated item at the top level instead of filing it under someone who did not do it", () => {
    // A planned-but-not-yet-delegated item is the normal state of a plan, and
    // work the orchestrator keeps for itself never gets a child at all.
    const tree = buildRunTree(view({
      subagents: [child({ childSessionId: "c1" })],
      deliverables: [deliverable({ id: "d1" })],
    }));
    expect(tree.children[0].deliverables).toEqual([]);
    expect(tree.unassigned.map((item) => item.id)).toEqual(["d1"]);
  });

  it("draws a child nothing announced, and says that is what happened", () => {
    // The two streams describing one run can disagree: the plan index records
    // a childSessionId when it delegates, and the child's own `subagent/update`
    // can be missed (a replay gap, a pump that reconnected). Dropping the
    // deliverable would hide the work; inventing a child that reads like any
    // other would hide the disagreement.
    const tree = buildRunTree(view({
      subagents: [],
      deliverables: [deliverable({ id: "d1", childSessionId: "ghost", capability: "meta-analysis" })],
    }));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].announced).toBe(false);
    expect(tree.children[0].child.capability).toBe("meta-analysis");
    expect(tree.children[0].deliverables.map((item) => item.id)).toEqual(["d1"]);
  });

  it("keeps a child that has produced nothing yet, because that is the fact worth seeing", () => {
    // A delegating run's transcript goes silent while children work. A child
    // with no deliverable yet is exactly what says the silence is work.
    const tree = buildRunTree(view({ subagents: [child({ childSessionId: "c1" }), child({ childSessionId: "c2" })] }));
    expect(tree.children.map((node) => node.child.childSessionId)).toEqual(["c1", "c2"]);
    expect(tree.deliverableCount).toBe(0);
  });
});
