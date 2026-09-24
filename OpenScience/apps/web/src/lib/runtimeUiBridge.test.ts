// The shell's half of the frame's run view: which run a conversation is
// bound to, how its stream folds into the state the frame draws, how often
// that state is sent, and what the evidence tab is told.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "./apiClient";
import type { RunStreamEvent } from "./runEvents";
import {
  boundRunFor, createThrottledSender, foldRunEvent, forgetKnowledgeSources, frameEvidenceFrom, reportPathOf, runStateFromRecord,
  searchKnowledgeSources, useFrameRunBinding, type FrameRunState,
} from "./runtimeUiBridge";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  subscribe: vi.fn(),
  readArtifact: vi.fn(),
  readClaimVerification: vi.fn(),
  listSources: vi.fn(),
}));
vi.mock("./sourceClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("./sourceClient")>()), listSources: mocks.listSources }));
vi.mock("./apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("./apiClient")>()), listWebAgentRuns: mocks.listRuns }));
vi.mock("./runEvents", async (importOriginal) => ({ ...(await importOriginal<typeof import("./runEvents")>()), subscribeRunEvents: mocks.subscribe }));
vi.mock("./artifactFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifactFile")>()), readArtifact: mocks.readArtifact, readClaimVerification: mocks.readClaimVerification,
}));

function run(overrides: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: "run-1", dispatchId: null, dispatchStatus: "accepted", sessionId: "session-a", mode: "specialist", agentId: null, agentVersion: null,
    runtimeAgent: null, model: "deepseek-flash", status: "running", createdAt: "2026-09-18T01:00:00.000Z", startedAt: "2026-09-18T01:00:00.000Z",
    finishedAt: null, durationMs: null, errorCode: null, artifacts: [], unverifiedArtifacts: [], question: "老年房颤抗凝的证据",
    planItems: [{ id: "evidence", title: "证据综述", status: "delegated", attempts: 0 }],
    ...overrides,
  };
}
const event = (type: string, fields: Record<string, unknown>, seq = 1): RunStreamEvent => ({ seq, time: `2026-09-18T01:0${seq}:00.000Z`, type, ...fields });

describe("which run a conversation shows", () => {
  it("is the latest run on the conversation's own session", () => {
    const runs = [run({ id: "old", startedAt: "2026-09-17T01:00:00.000Z" }), run({ id: "new" }), run({ id: "other", sessionId: "session-b", startedAt: "2026-09-19T01:00:00.000Z" })];
    expect(boundRunFor(runs, "session-a")?.id).toBe("new");
    expect(boundRunFor(runs, "session-c")).toBeNull();
    expect(boundRunFor(runs, null)).toBeNull();
  });

  it("starts from the ledger record: the plan items stand in until the stream speaks", () => {
    const state = runStateFromRecord(run());
    expect(state).toMatchObject({ runId: "run-1", sessionId: "session-a", state: "running", title: "老年房颤抗凝的证据" });
    expect(state.progress).toMatchObject({ deliverables: [{ id: "evidence", title: "证据综述", status: "delegated", attempts: 0 }] });
  });
});

describe("folding the run's stream", () => {
  it("reads the state, the progress aggregate and each deliverable, and keeps what a later frame leaves out", () => {
    let state: FrameRunState = runStateFromRecord(run());
    state = foldRunEvent(state, event("run/state", { state: "running", phase: "repairing", verification: null }));
    expect(state.phase).toBe("repairing");
    state = foldRunEvent(state, event("deliverable/update", { id: "evidence", title: "老年房颤抗凝证据综述", capability: "clinical-evidence-synthesis", status: "rejected", childSessionId: "child-1", issues: [] }, 2));
    expect(state.progress?.deliverables).toEqual([{ id: "evidence", title: "老年房颤抗凝证据综述", capability: "clinical-evidence-synthesis", status: "rejected", attempts: 0, childSessionId: "child-1" }]);
    // A progress frame without deliverables does not erase the item frames' ones.
    state = foldRunEvent(state, event("run/progress", { phaseCounts: { search: 3 }, currentPhase: "search", sources: { searched: 10, included: 2, fullText: 0 }, children: [] }, 3));
    expect(state.progress).toMatchObject({ currentPhase: "search", deliverables: [{ id: "evidence", status: "rejected" }] });
    expect(state.progress).not.toHaveProperty("seq");
    // An accepted item's receipt names files the gate took: artifacts already.
    state = foldRunEvent(state, event("deliverable/update", { id: "evidence", status: "accepted", receipt: {
      attempt: 3, files: [{ path: "deliverables/evidence/clinical-evidence-report.md" }, { path: "deliverables/evidence/clinical-evidence-matrix.json" }],
    } }, 4));
    expect(state.artifacts).toEqual(["deliverables/evidence/clinical-evidence-report.md", "deliverables/evidence/clinical-evidence-matrix.json"]);
    expect(state.progress?.deliverables).toEqual([expect.objectContaining({ status: "accepted", attempts: 3, title: "老年房颤抗凝证据综述" })]);
    expect(reportPathOf(state)).toBe("deliverables/evidence/clinical-evidence-report.md");
    // Events it does not read leave the state alone.
    expect(foldRunEvent(state, event("tool/call", { tool: "grep" }, 5))).toBe(state);
  });
});

describe("sending the state", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("goes at once, then at most twice a second, and the latest always arrives", () => {
    const sent: number[] = [];
    const sender = createThrottledSender<number>((value) => sent.push(value), 500);
    sender.push(1);
    expect(sent).toEqual([1]);
    sender.push(2); sender.push(3); sender.push(4);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 4]);
    vi.advanceTimersByTime(2000);
    sender.push(5);
    expect(sent).toEqual([1, 4, 5]);
    sender.push(6);
    sender.cancel();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1, 4, 5]);
  });
});

describe("the evidence the frame is told", () => {
  it("is each claim with what the check found, and each cited source with how many claims stand on it", () => {
    const matrix = JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "利伐沙班降低卒中风险。", claimType: "direct", sourceTitle: "ROCKET AF", identifier: "PMID:21830957", sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/21830957/", supportQuote: "q", sourceType: "rct" },
      { claimId: "CLM-002", claim: "x".repeat(400), claimType: "synthesized", supportingSources: [{ sourceTitle: "ROCKET AF", identifier: "PMID:21830957" }, { sourceTitle: "ARISTOTLE", identifier: "PMID:21870978" }] },
    ] });
    const evidence = frameEvidenceFrom("run-1", "deliverables/e/clinical-evidence-report.md", "deliverables/e/clinical-evidence-matrix.json", matrix, {
      claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] }], counts: { verified: 1 },
    });
    expect(evidence.claims.map((claim) => [claim.claimId, claim.status, claim.sourceType ?? null])).toEqual([["CLM-001", "verified", "rct"], ["CLM-002", "unchecked", null]]);
    expect(evidence.claims[1].claim.length).toBe(300);
    expect(evidence.sources).toEqual([
      { title: "ROCKET AF", identifier: "PMID:21830957", url: "https://pubmed.ncbi.nlm.nih.gov/21830957/", sourceType: "rct", claims: 2 },
      { title: "ARISTOTLE", identifier: "PMID:21870978", claims: 1 },
    ]);
  });
});

describe("keeping the frame's run view current", () => {
  beforeEach(() => {
    mocks.listRuns.mockReset(); mocks.subscribe.mockReset(); mocks.readArtifact.mockReset(); mocks.readClaimVerification.mockReset();
  });

  it("binds the conversation's run, follows its stream, reads its report's evidence and clears on a change of task", async () => {
    let onEvent: (event: RunStreamEvent) => void = () => {};
    const unsubscribe = vi.fn();
    mocks.subscribe.mockImplementation((_id: string, handler: (event: RunStreamEvent) => void) => { onEvent = handler; return unsubscribe; });
    mocks.listRuns.mockResolvedValue([run()]);
    mocks.readArtifact.mockResolvedValue({ path: "m", mime: "application/json", encoding: "utf8", data: JSON.stringify({ claims: [{ claimId: "CLM-001", claim: "c", claimType: "direct" }] }), size: 1 });
    mocks.readClaimVerification.mockResolvedValue({ claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] }], counts: {} });
    const postRunState = vi.fn();
    const postEvidence = vi.fn();
    const { rerender } = renderHook((props: { sessionId: string | null }) => useFrameRunBinding({ sessionId: props.sessionId, enabled: true, postRunState, postEvidence }),
      { initialProps: { sessionId: "session-a" as string | null } });
    await vi.waitFor(() => expect(postRunState).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", state: "running" })));
    expect(mocks.subscribe).toHaveBeenCalledWith("run-1", expect.any(Function));
    act(() => onEvent(event("deliverable/update", { id: "evidence", status: "accepted", receipt: { attempt: 1, files: [{ path: "deliverables/evidence/clinical-evidence-report.md" }] } })));
    await vi.waitFor(() => expect(postEvidence).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", reportPath: "deliverables/evidence/clinical-evidence-report.md",
      claims: [expect.objectContaining({ claimId: "CLM-001", status: "verified" })] })));
    expect(mocks.readArtifact).toHaveBeenCalledWith("deliverables/evidence/clinical-evidence-matrix.json", "workspace");
    await vi.waitFor(() => expect(postRunState).toHaveBeenLastCalledWith(expect.objectContaining({ artifacts: ["deliverables/evidence/clinical-evidence-report.md"] })));
    postRunState.mockClear();
    rerender({ sessionId: null });
    expect(unsubscribe).toHaveBeenCalled();
    expect(postRunState).toHaveBeenCalledWith({ runId: null });
    expect(postEvidence).toHaveBeenLastCalledWith(null);
  });

  it("asks the ledger again when the run ends, for its final files", async () => {
    let onEvent: (event: RunStreamEvent) => void = () => {};
    mocks.subscribe.mockImplementation((_id: string, handler: (event: RunStreamEvent) => void) => { onEvent = handler; return () => {}; });
    mocks.listRuns.mockResolvedValueOnce([run()]).mockResolvedValue([run({ status: "succeeded", artifacts: ["deliverables/evidence/brief.md"], finishedAt: "2026-09-18T02:00:00.000Z" })]);
    const postRunState = vi.fn();
    renderHook(() => useFrameRunBinding({ sessionId: "session-a", enabled: true, postRunState, postEvidence: vi.fn() }));
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    act(() => onEvent(event("run/state", { state: "succeeded", phase: "accepted" })));
    await vi.waitFor(() => expect(mocks.listRuns).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(postRunState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "succeeded", artifacts: ["deliverables/evidence/brief.md"] })));
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does nothing until the frame is listening", () => {
    const postRunState = vi.fn();
    renderHook(() => useFrameRunBinding({ sessionId: "session-a", enabled: false, postRunState, postEvidence: vi.fn() }));
    expect(mocks.listRuns).not.toHaveBeenCalled();
    expect(postRunState).not.toHaveBeenCalled();
  });
});

describe("the @ menu's knowledge-base answer", () => {
  beforeEach(() => { mocks.listSources.mockReset(); forgetKnowledgeSources(); });

  const source = (id: string, path: string, summary?: string, deletedAt: string | null = null) => ({
    id, revision: 1, projectId: "default", createdAt: "", updatedAt: "", deletedAt,
    payload: { paths: [path], status: "complete", outputs: summary ? { summary } : {} },
  });

  it("names the project's parsed sources by file, matches name or summary, and asks the ledger at most every 30 s", async () => {
    mocks.listSources.mockResolvedValue({ items: [
      source("src_a1", "文献/ROCKET-AF.pdf", "利伐沙班与华法林在非瓣膜性房颤中的比较"),
      source("src_b2", "指南/2023 房颤指南.pdf"),
      source("src_c3", "removed.pdf", undefined, "2026-09-01T00:00:00.000Z"),
      source("not-an-id", "odd.pdf"),
    ], nextCursor: null });
    expect(await searchKnowledgeSources("default", "rocket")).toEqual([{ id: "src_a1", title: "ROCKET-AF.pdf", detail: "利伐沙班与华法林在非瓣膜性房颤中的比较" }]);
    expect(await searchKnowledgeSources("default", "华法林")).toEqual([expect.objectContaining({ id: "src_a1" })]);
    expect((await searchKnowledgeSources("default", "")).map((item) => item.id)).toEqual(["src_a1", "src_b2"]);
    expect(mocks.listSources).toHaveBeenCalledTimes(1);
    // Readable, not understood: a document can be named once its text is read,
    // while its understanding still runs (2026-09-24).
    expect(mocks.listSources).toHaveBeenCalledWith("default", { state: "ready" });
  });
});

