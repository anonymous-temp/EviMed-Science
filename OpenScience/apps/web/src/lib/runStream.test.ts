import { describe, expect, it, vi } from "vitest";

import {
  RUN_STREAM_FRAME_TYPES,
  applyRunEvent,
  applyRunFrame,
  emptyRunView,
  markInteractionAnswered,
  openRunStream,
  type RunEvent,
  type RunStreamFrame,
  runIsSettled,
  TERMINAL_RUN_STATUSES,
  transcriptToRunView,
  type RunView,
} from "./runStream";

const at = (seq: number) => ({ seq, time: "2026-08-23T00:00:00Z" });

function fold(view: RunView, frames: RunStreamFrame[]): RunView {
  return frames.reduce(applyRunFrame, view);
}

describe("the browser's own run vocabulary", () => {
  it("knows nothing about a kernel", async () => {
    const source = await import("./runStream?raw" as string).catch(() => null);
    // The check that matters is structural rather than textual, so it is stated
    // as one: the frame union is the control plane's, and every member of it is
    // handled below.
    expect([...RUN_STREAM_FRAME_TYPES]).toEqual([
      "run/state",
      "run/event",
      "subagent/update",
      "deliverable/update",
      "evidence/update",
      "budget/update",
      "approval/requested",
      "question/requested",
      "stream/gap",
    ]);
    expect(source).toBeDefined();
  });

  it("applies a run's state and carries its verdict fields", () => {
    const view = fold(emptyRunView("run_1"), [
      { type: "run/state", ...at(1), state: "running", errorCode: null, verification: null, attempts: 0 },
      { type: "run/state", ...at(2), state: "degraded", errorCode: null, verification: "unverified", attempts: 2 },
    ]);
    expect(view.state).toBe("degraded");
    expect(view.verification).toBe("unverified");
    expect(view.attempts).toBe(2);
    expect(view.seq).toBe(2);
  });

  it("ignores a frame it has already applied, so a reconnect does not duplicate anything", () => {
    const frame: RunStreamFrame = { type: "run/event", ...at(1), event: { type: "message/user", seq: 1, text: "题面", source: "user" } };
    const once = applyRunFrame(emptyRunView("run_1"), frame);
    const twice = applyRunFrame(once, frame);
    expect(twice.blocks).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("shows an injected context as an injection, never as something the user typed", () => {
    const view = fold(emptyRunView("run_1"), [
      { type: "run/event", ...at(1), event: { type: "message/user", seq: 1, text: "我的问题", source: "user" } },
      { type: "run/event", ...at(2), event: { type: "message/user", seq: 2, text: "<evimed-brief>题面…</evimed-brief>", source: "plugin" } },
    ]);
    expect(view.blocks[0]).toEqual({ kind: "user", text: "我的问题" });
    expect(view.blocks[1]).toMatchObject({ kind: "status-line", tone: "muted" });
    expect((view.blocks[1] as { text: string }).text).toContain("系统注入的上下文");
  });

  it("pairs a tool result with its call by id, not by position", () => {
    const events: RunEvent[] = [
      { type: "tool/call", seq: 1, callId: "a", tool: "mcp__evimed__literature_search", input: { query: "x" }, narration: "检索文献：「x」" },
      { type: "tool/call", seq: 2, callId: "b", tool: "bash", input: { command: "ls" }, narration: "执行命令 ls" },
      { type: "tool/result", seq: 3, callId: "b", tool: "bash", status: "completed", output: "a\nb", narration: "执行命令 ls" },
      { type: "tool/result", seq: 4, callId: "a", tool: "mcp__evimed__literature_search", status: "error", output: "", errorCode: "full_text_not_available", narration: "检索文献：「x」" },
    ];
    const view = events.reduce(applyRunEvent, emptyRunView("run_1"));
    const [first, second] = view.blocks as Array<{ kind: string; callId?: string; status?: string; meta?: string }>;
    expect(first.callId).toBe("a");
    expect(first.status).toBe("failed");
    expect(first.meta).toContain("全文取不到");
    expect(second.callId).toBe("b");
    expect(second.status).toBe("success");
  });

  it("streams an assistant tail into one block instead of many", () => {
    const view = ([
      { type: "assistant/delta", seq: 1, kind: "text", text: "我先" },
      { type: "assistant/delta", seq: 2, kind: "text", text: "写下计划。" },
      { type: "assistant/delta", seq: 3, kind: "reasoning", text: "（不显示）" },
    ] as RunEvent[]).reduce(applyRunEvent, emptyRunView("run_1"));
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toEqual({ kind: "agent", markdown: "我先写下计划。" });
  });

  it("marks a compaction without replacing what the reader already saw", () => {
    const view = ([
      { type: "message/assistant", seq: 1, text: "早期结论", reasoning: "", usage: null, interrupted: false },
      { type: "compaction", seq: 2, replaced: 12, estimatedTokens: 6000 },
    ] as RunEvent[]).reduce(applyRunEvent, emptyRunView("run_1"));
    expect(view.blocks).toHaveLength(2);
    expect(view.blocks[0]).toEqual({ kind: "agent", markdown: "早期结论" });
    expect((view.blocks[1] as { text: string }).text).toContain("已压缩早期对话");
  });

  it("counts an event it cannot render rather than dropping it", () => {
    const view = applyRunEvent(emptyRunView("run_1"), { type: "unknown", seq: 1, rawType: "hook/invoked" });
    expect(view.unknownEvents).toEqual({ "hook/invoked": 1 });
    expect(view.blocks).toHaveLength(0);
  });

  it("collects deliverables, evidence and the budget on the same channel as the events", () => {
    const view = fold(emptyRunView("run_1"), [
      { type: "deliverable/update", ...at(1), id: "d1", contractKind: "clinical-evidence-report", status: "rejected", issues: [{ code: "x", message: "缺少文件", severity: "required" }] },
      { type: "deliverable/update", ...at(2), id: "d1", contractKind: "clinical-evidence-report", status: "accepted", issues: [] },
      { type: "evidence/update", ...at(3), total: 1, byStatus: { ready: 1 } },
      { type: "evidence/update", ...at(4), total: 2, byStatus: { ready: 1, queued: 1 } },
      { type: "budget/update", ...at(5), steps: 12, tokens: 4000, children: 3, limits: { maxSteps: 100 } },
      { type: "subagent/update", ...at(6), childSessionId: "c1", label: "证据综述", capability: "clinical-evidence-synthesis", status: "completed" },
    ]);
    expect(view.deliverables).toEqual([{
      id: "d1",
      contractKind: "clinical-evidence-report",
      capability: "",
      title: "d1",
      childSessionId: null,
      status: "accepted",
      issues: [],
    }]);
    expect(view.evidence).toEqual({ total: 2, byStatus: { ready: 1, queued: 1 } });
    expect(view.budget.steps).toBe(12);
    expect(view.subagents).toHaveLength(1);
  });

  it("keeps a deliverable in plan order when its verdict changes, rather than moving it to the end", () => {
    // The control plane sends the deliverable's whole current record on every
    // change, so a plan whose second item is graded first must still read as a
    // plan. Appending on update reordered it into a recency list, which is the
    // one thing a plan must not be.
    const view = fold(emptyRunView("run_1"), [
      { type: "deliverable/update", ...at(1), id: "d1", contractKind: "research-brief", status: "planned" },
      { type: "deliverable/update", ...at(2), id: "d2", contractKind: "clinical-evidence-report", status: "planned" },
      { type: "deliverable/update", ...at(3), id: "d3", contractKind: "meta-analysis-report", status: "planned" },
      // The one in the MIDDLE is graded first. An update that removes and
      // re-appends leaves the order unchanged whenever the item happens to be
      // last, so the assertion below only means something on this shape.
      { type: "deliverable/update", ...at(4), id: "d2", contractKind: "clinical-evidence-report", status: "accepted" },
    ]);
    expect(view.deliverables.map((item) => item.id)).toEqual(["d1", "d2", "d3"]);
    expect(view.deliverables[1].status).toBe("accepted");
  });

  it("carries the receipt and the child that produced a deliverable, so a run tree can be drawn", () => {
    const view = fold(emptyRunView("run_1"), [
      {
        type: "deliverable/update",
        ...at(1),
        id: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        title: "二甲双胍证据综述",
        childSessionId: "child-1",
        status: "accepted",
        receipt: {
          deliverableId: "d1",
          contractKind: "clinical-evidence-report",
          capability: "clinical-evidence-synthesis",
          attempt: 2,
          acceptedAt: "2026-08-31T10:00:00Z",
          files: [{ path: "clinical-evidence-report.md", sha256: "a".repeat(64), bytes: 4096 }],
          notices: ["背景章节占比偏高"],
        },
      },
    ]);
    expect(view.deliverables[0].childSessionId).toBe("child-1");
    expect(view.deliverables[0].receipt?.attempt).toBe(2);
    expect(view.deliverables[0].receipt?.files[0].path).toBe("clinical-evidence-report.md");
  });

  it("hears the kernel ask in the shape the kernel actually asks", () => {
    // The frames are the control plane's, forwarded from the kernel: one event
    // name per kind, three states told apart by `status`, and `eventId` as the
    // id — which is also the path segment the answer is POSTed to, so decoding
    // it into any other field name breaks the reply and nothing else.
    const view = fold(emptyRunView("run_1"), [
      { type: "approval/requested", ...at(1), eventId: "ev-1", status: "pending", sessionId: "s1", request: { toolName: "bash", callId: "call_9", reason: "escalate sandbox to danger-full-access: cat /etc/hosts" } },
      { type: "question/requested", ...at(2), eventId: "ev-2", status: "pending", sessionId: "s1", request: { question: "要包含 2019 年前的文献吗？" } },
      // Replayed after a reconnect: the same request, not a second card.
      { type: "approval/requested", ...at(3), eventId: "ev-1", status: "pending", sessionId: "s1", request: { toolName: "bash", callId: "call_9", reason: "escalate sandbox to danger-full-access: cat /etc/hosts" } },
    ]);
    expect(view.interactions.map((item) => item.eventId)).toEqual(["ev-1", "ev-2"]);
    expect(view.interactions[0].kind).toBe("approval");
    expect(view.interactions[0].tool).toBe("bash");
    expect(view.interactions[0].prompt).toContain("danger-full-access");
    expect(view.interactions[0].detail).toBe("call_9");
    expect(view.interactions[1].prompt).toBe("要包含 2019 年前的文献吗？");
  });

  it("settles a request when the control plane says it was answered, not only when this tab answers", () => {
    const asked = fold(emptyRunView("run_1"), [
      { type: "approval/requested", ...at(1), eventId: "ev-1", status: "pending", request: { toolName: "bash", reason: "需要批准" } },
    ]);
    // Another tab answered. Before the control plane forwarded a resolution
    // this tab kept asking forever, and a second click answered an event the
    // kernel had already forgotten.
    const settled = applyRunFrame(asked, { type: "approval/requested", ...at(2), eventId: "ev-1", status: "answered" });
    expect(settled.interactions[0].answered).toBe(true);

    // The local echo and the forwarded frame set the same field, so applying
    // either after the other changes nothing.
    expect(markInteractionAnswered(settled, "ev-1").interactions[0].answered).toBe(true);
    const replayed = applyRunFrame(settled, { type: "approval/requested", ...at(3), eventId: "ev-1", status: "pending", request: { toolName: "bash", reason: "需要批准" } });
    expect(replayed.interactions[0].answered).toBe(true);
  });

  it("keeps a withdrawn request visible, with the reason it was taken back", () => {
    // The kernel withdraws when its connection drops or the call is cancelled.
    // Removing the card would leave a reader who looked away unable to tell a
    // retracted question from one that was never asked — the same failure as
    // an empty result standing in for an unread one.
    const asked = fold(emptyRunView("run_1"), [
      { type: "question/requested", ...at(1), eventId: "ev-2", status: "pending", request: { question: "要包含 2019 年前的文献吗？" } },
    ]);
    const gone = applyRunFrame(asked, { type: "question/requested", ...at(2), eventId: "ev-2", status: "withdrawn", reason: "runtime_disconnected" });
    expect(gone.interactions).toHaveLength(1);
    expect(gone.interactions[0].withdrawn).toBe("runtime_disconnected");
    expect(gone.interactions[0].answered).toBe(false);
  });

  it("shows an unreadable request rather than dropping it", () => {
    // No live question frame has been recorded, so the payload's field names
    // are a guess. A guess that misses must still leave a card: the run is
    // blocked either way, and a silent drop is the one outcome that cannot be
    // acted on.
    const view = fold(emptyRunView("run_1"), [
      { type: "question/requested", ...at(1), eventId: "ev-3", status: "pending", request: { somethingNobodyHasSeen: 42 } },
    ]);
    expect(view.interactions).toHaveLength(1);
    expect(view.interactions[0].prompt).toBe("运行提出了一个问题。");
  });

  it("surfaces a replay gap so a client that fell too far behind re-reads instead of guessing", () => {
    const view = applyRunFrame(emptyRunView("run_1"), { type: "stream/gap", ...at(500), since: 3, resumedAt: 120 });
    expect(view.missedRange).toEqual({ since: 3, resumedAt: 120 });
  });

  it("subscribes with resumption and forwards every frame type", () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    let opened = "";
    const frames: RunStreamFrame[] = [];
    const handle = openRunStream("run_1", {
      apiBase: "/api",
      since: 7,
      onFrame: (frame) => frames.push(frame),
      factory: (url) => {
        opened = url;
        return {
          addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
          close,
          onerror: null,
        } as unknown as EventSource;
      },
    });
    expect(opened).toBe("/api/runs/run_1/events?since=7");
    expect([...listeners.keys()]).toEqual([...RUN_STREAM_FRAME_TYPES]);

    listeners.get("run/state")?.(new MessageEvent("run/state", { data: JSON.stringify({ type: "run/state", seq: 8, time: "t", state: "running", errorCode: null, verification: null, attempts: 0 }) }));
    expect(frames).toHaveLength(1);
    handle.close();
    expect(close).toHaveBeenCalled();
  });

  it("isolates a malformed frame instead of taking the view down", () => {
    const listeners = new Map<string, EventListener>();
    const errors: unknown[] = [];
    openRunStream("run_1", {
      onFrame: () => { throw new Error("should not be reached"); },
      onError: (error) => errors.push(error),
      factory: () => ({
        addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
        close: () => {},
        onerror: null,
      } as unknown as EventSource),
    });
    listeners.get("run/event")?.(new MessageEvent("run/event", { data: "{not json" }));
    expect(errors).toHaveLength(1);
  });
});

describe("a reloaded conversation and a watched one cannot drift", () => {
  it("builds the same blocks from a transcript that the stream builds live", () => {
    const transcript = {
      sessionId: "s-1",
      lastSeq: 6,
      turnEnd: null,
      subagents: [{ sessionId: "c1", parentSessionId: "s-1", label: "证据综述", capability: "clinical-evidence-synthesis" }],
      messages: [
        { role: "user" as const, source: "user" as const, seq: 1, time: 1, turn: 1, step: 1, parts: [{ type: "text" as const, text: "题面" }], usage: null, interrupted: false },
        {
          role: "tool" as const,
          source: "system" as const,
          seq: 2,
          time: 2,
          turn: 1,
          step: 1,
          parts: [{
            type: "tool" as const,
            tool: "mcp__evimed__literature_search",
            callId: "a",
            status: "completed" as const,
            input: { query: "x" },
            output: "12 results",
            error: null,
          }],
          usage: null,
          interrupted: false,
        },
        { role: "assistant" as const, source: "system" as const, seq: 3, time: 3, turn: 1, step: 1, parts: [{ type: "text" as const, text: "结论。" }], usage: null, interrupted: false },
      ],
    };
    const fromTranscript = transcriptToRunView("run_1", transcript);

    const live = ([
      { type: "message/user", seq: 1, text: "题面", source: "user" },
      { type: "tool/call", seq: 2, callId: "a", tool: "mcp__evimed__literature_search", input: { query: "x" }, narration: "检索文献：「x」" },
      { type: "tool/result", seq: 3, callId: "a", tool: "mcp__evimed__literature_search", status: "completed", output: "12 results", narration: "检索文献：「x」" },
      { type: "message/assistant", seq: 4, text: "结论。", reasoning: "", usage: null, interrupted: false },
    ] as RunEvent[]).reduce(applyRunEvent, emptyRunView("run_1"));

    expect(fromTranscript.blocks).toEqual(live.blocks);
    expect(fromTranscript.subagents).toHaveLength(1);
    expect(fromTranscript.seq).toBe(6);
  });

  it("leaves a call whose result never arrived visibly unfinished", () => {
    const view = transcriptToRunView("run_1", {
      sessionId: "s-1",
      lastSeq: 2,
      turnEnd: null,
      subagents: [],
      messages: [{
        role: "tool" as const,
        source: "system" as const,
        seq: 1,
        time: 1,
        turn: 1,
        step: 1,
        parts: [{ type: "tool" as const, tool: "bash", callId: "a", status: "pending" as const, input: {}, output: "", error: null }],
        usage: null,
        interrupted: false,
      }],
    });
    expect((view.blocks[0] as { status: string }).status).toBe("running");
  });

  it("distinguishes a settled run from one nobody has heard about", () => {
    // The vocabulary is the one the control plane publishes on `run/state`,
    // which is the run ledger's `run.status` — not `@evimed/domain`'s nine-value
    // `RUN_PHASES`. This test previously named `accepted` and `degraded`, which
    // the ledger never assigns, and omitted `succeeded`, which it always does:
    // a delivered run was therefore never recognized as finished, so the
    // browser held its subscription open and spun on a completed run.
    for (const state of TERMINAL_RUN_STATUSES) {
      expect(runIsSettled({ ...emptyRunView("r"), state })).toBe(true);
    }
    expect([...TERMINAL_RUN_STATUSES]).toEqual(["succeeded", "failed", "canceled"]);
    expect(runIsSettled({ ...emptyRunView("r"), state: "running" })).toBe(false);
    expect(runIsSettled(emptyRunView("r"))).toBe(false);
    // Named explicitly so that a ledger which one day *does* distinguish a
    // degraded delivery cannot start emitting it while the browser quietly
    // treats it as still running.
    expect(runIsSettled({ ...emptyRunView("r"), state: "degraded" })).toBe(false);
  });
});
