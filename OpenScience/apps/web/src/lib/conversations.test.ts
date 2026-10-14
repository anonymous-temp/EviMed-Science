import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { groupConversations, isConversationRun } from "./conversations";

function run(id: string, sessionId: string, at: string, overrides: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id, sessionId, dispatchId: null, question: `问题 ${id}`, dispatchStatus: "accepted", mode: "open-domain", agentId: null, agentVersion: null,
    runtimeAgent: null, model: "deepseek", status: "succeeded", createdAt: at, startedAt: at, finishedAt: at, durationMs: 1, errorCode: null,
    artifacts: [], ...overrides,
  };
}

describe("groupConversations", () => {
  it("groups the runs of one session into one conversation, newest first", () => {
    const rows = groupConversations([
      run("a", "ses-1", "2026-10-13T08:00:00Z"),
      run("b", "ses-2", "2026-10-13T09:00:00Z"),
      run("c", "ses-1", "2026-10-13T10:00:00Z"),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(["ses-1", "ses-2"]);
    expect(rows[0].runs.map((item) => item.id)).toEqual(["c", "a"]);
    expect(rows[0].titleRun.id).toBe("a");
  });

  // The platform's re-check of a scheduled task's claim is a run of its own in the ledger; the server marks it, and no conversation is made of it.
  it("draws no conversation from a run the server marks as the platform's own, whatever its title says", () => {
    const rows = groupConversations([
      run("own", "ses-own", "2026-10-13T08:00:00Z", { question: "独立核验另一研究：我自己写的问题" }),
      run("check-1", "ses-check-1", "2026-10-13T09:00:00Z", { role: "verification", question: "独立核验另一研究：主张 1" }),
      run("check-2", "ses-check-2", "2026-10-13T10:00:00Z", { role: "verification", question: "普通的标题" }),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(["ses-own"]);
    expect(isConversationRun(run("x", "ses-x", "2026-10-13T08:00:00Z"))).toBe(true);
    expect(isConversationRun(run("y", "ses-y", "2026-10-13T08:00:00Z", { role: "verification" }))).toBe(false);
  });

  it("keeps a conversation whole when a mark sits on one of its runs only", () => {
    const rows = groupConversations([
      run("a", "ses-1", "2026-10-13T08:00:00Z"),
      run("b", "ses-1", "2026-10-13T09:00:00Z", { role: "verification" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs.map((item) => item.id)).toEqual(["a"]);
  });
});
