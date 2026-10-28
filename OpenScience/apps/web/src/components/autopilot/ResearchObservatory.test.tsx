import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStreamEvent } from "@/lib/runEvents";
import { ResearchObservatory, observeResearch } from "./ResearchObservatory";

const mocks = vi.hoisted(() => ({ list: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({ listWebAgentRuns: mocks.list }));
vi.mock("@/lib/runEvents", () => ({ useRunEvents: mocks.stream }));
const frame = (seq: number, type: string, fields: Record<string, unknown> = {}): RunStreamEvent => ({ seq, type, time: `2026-10-28T01:0${seq}:00Z`, ...fields });
const record = (id: string, title: string) => ({ id, title, status: "succeeded", startedAt: "2026-10-28T01:00:00Z", finishedAt: "2026-10-28T01:05:00Z", durationMs: 300000, artifacts: [] });

describe("research observatory", () => {
  beforeEach(() => { mocks.list.mockReset(); mocks.stream.mockReset(); mocks.stream.mockReturnValue({ events: [], connected: false, lastEvent: null }); });
  it("switches records without carrying the previous execution across", async () => {
    mocks.list.mockResolvedValue([record("one", "第一项研究"), record("two", "第二项研究")]);
    const view = render(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("第一项研究")).toBeInTheDocument();
    view.rerender(<ResearchObservatory runId="two" />);
    expect(screen.queryByText("第一项研究")).not.toBeInTheDocument();
    expect(await screen.findByText("第二项研究")).toBeInTheDocument();
    view.rerender(<ResearchObservatory runId={null} />);
    expect(screen.getByText("选择一次研究执行，查看实时进展。")).toBeInTheDocument();
  });
  it("does not let an older initial record overwrite the terminal refresh", async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; })).mockResolvedValue([record("one", "已结束记录")]);
    mocks.stream.mockReturnValue({ events: [frame(1, "run/state", { state: "succeeded" })], connected: true });
    render(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("已结束记录")).toBeInTheDocument();
    await act(async () => { resolveInitial([{ ...record("one", "过期记录"), status: "running" }]); });
    expect(screen.getByText("已结束记录")).toBeInTheDocument(); expect(screen.queryByText("过期记录")).not.toBeInTheDocument();
  });
  it("reads an archived execution when it is absent from the active shelf", async () => {
    mocks.list.mockImplementation(async (options?: { archived?: boolean }) => options?.archived ? [record("one", "归档研究")] : []);
    render(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("归档研究")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({ archived: true });
  });
  it("shows observed child updates, tool outcomes and the stream gap without inventing usage", async () => {
    mocks.list.mockResolvedValue([record("one", "研究")]);
    const events = [
      frame(1, "run/progress", { children: [{ childSessionId: "c1", deliverableId: "d1", state: "running" }], deliverables: [{ id: "d1", title: "证据检索" }], phaseCounts: {}, sources: {}, claims: {} }),
      frame(2, "run/event", { child: true, sessionId: "c1", event: { type: "tool/call", callId: "t1", tool: "search", narration: "检索文献" } }),
      frame(3, "run/event", { child: true, sessionId: "c1", event: { type: "tool/result", callId: "t1", tool: "search", status: "error", narration: "检索文献" } }),
      frame(4, "subagent/update", { childSessionId: "c1", status: "completed" }),
      frame(5, "stream/gap"),
    ];
    mocks.stream.mockReturnValue({ events, connected: false, lastEvent: events[4] });
    render(<ResearchObservatory runId="one" />);
    expect(screen.getAllByText("证据检索").length).toBeGreaterThan(0);
    expect(screen.getByText("检索文献")).toBeInTheDocument();
    expect(screen.getByText("证据检索 · 出错")).toBeInTheDocument();
    expect(screen.getByText(/部分早期事件已不可用/)).toBeInTheDocument();
    expect(screen.getByText("未知 / 未知")).toBeInTheDocument();
    expect(screen.getByText("连接中断或暂不可用")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("5 分钟")).toBeInTheDocument());
  });
  it("opens observed agent and tool details with actual input and output", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([{ ...record("one", "研究"), sessionId: "root" }]);
    const events = [
      frame(1, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c1", parentSessionId: "root", label: "证据分析" } }),
      frame(2, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "a", tool: "write", input: { code: "print(1)" }, narration: "编写脚本" } }),
      frame(3, "run/event", { sessionId: "c1", child: true, event: { type: "tool/call", callId: "b", tool: "search", input: { query: "actual query" }, narration: "检索证据" } }),
      frame(4, "run/event", { sessionId: "c1", child: true, event: { type: "tool/result", callId: "b", tool: "search", status: "completed", output: "actual result" } }),
      frame(5, "run/event", { sessionId: "root", event: { type: "message/assistant", reasoning: "private reasoning" } }),
    ];
    mocks.stream.mockReturnValue({ events, connected: true, lastEvent: events[4] });
    render(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("由 EviMed 主理 发起")).toBeInTheDocument();
    expect(screen.getByText("actual result")).toBeInTheDocument();
    expect(screen.getByText(/actual query/)).toBeInTheDocument();
    expect(screen.queryByText("private reasoning")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看 EviMed 总指挥" }));
    expect(screen.queryByText("actual result")).not.toBeInTheDocument();
    expect(screen.getByText(/print\(1\)/)).toBeInTheDocument();
    expect(screen.getByText("尚未收到")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看 证据分析" }));
    expect(screen.getByText("actual result")).toBeInTheDocument();
    expect(screen.queryByText(/print\(1\)/)).not.toBeInTheDocument();
  });
  it("collapses long results while keeping their observed beginning visible", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([record("one", "研究")]);
    const events = [frame(1, "run/event", { event: { type: "tool/result", callId: "a", tool: "read", status: "completed", output: `开始${"x".repeat(700)}结束` } })];
    mocks.stream.mockReturnValue({ events, connected: true, lastEvent: events[0] });
    render(<ResearchObservatory runId="one" />);
    expect(screen.getByText(/^开始.*…$/)).toBeInTheDocument();
    await user.click(screen.getByText("展开完整内容"));
    expect(screen.getByText(/^开始.*结束$/)).toBeVisible();
  });
  it("keeps a newer settled agent state when older events are replayed", () => {
    const run = { ...record("one", "研究"), progress: { updatedAt: "2026-10-28T01:10:00Z", children: [{ childSessionId: "c", state: "done" }], deliverables: [], phaseCounts: {} } };
    const old = frame(1, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c", label: "检索" } });
    const result = observeResearch([old], run as never);
    expect(result.children[0].state).toBe("done");
    expect(result.children[0].label).toBe("检索");
  });
  it("does not treat a replayed old start as a new running child", () => {
    const run = { ...record("one", "研究"), progress: { updatedAt: "2026-10-28T01:10:00Z", children: [{ childSessionId: "c", state: "done" }], deliverables: [], phaseCounts: {} } };
    const replay = { ...frame(1, "run/event", { event: { type: "subagent/started", childSessionId: "c", label: "检索" } }), time: "2026-10-28T01:20:00Z" };
    expect(observeResearch([replay], run as never).children[0].state).toBe("unknown");
    const aggregate = { ...frame(2, "run/progress", { children: [{ childSessionId: "c", state: "running" }], updatedAt: "2026-10-28T01:21:00Z" }), time: "2026-10-28T01:21:00Z" };
    expect(observeResearch([replay, aggregate], run as never).children[0].state).toBe("running");
  });
  it("does not mark a resumed child complete from a replayed old ending", () => {
    const run = { ...record("one", "研究"), progress: { updatedAt: "2026-10-28T01:10:00Z", children: [{ childSessionId: "c", state: "running" }], deliverables: [], phaseCounts: {} } };
    const end = { ...frame(1, "subagent/update", { childSessionId: "c", status: "completed" }), time: "2026-10-28T01:20:00Z" };
    const repeated = { ...frame(2, "subagent/update", { childSessionId: "c", status: "completed" }), time: "2026-10-28T01:21:00Z" };
    expect(observeResearch([end, repeated], run as never).children[0].state).toBe("unknown");
    const aggregate = { ...frame(3, "run/progress", { children: [{ childSessionId: "c", state: "running" }], updatedAt: "2026-10-28T01:22:00Z" }), time: "2026-10-28T01:22:00Z" };
    expect(observeResearch([end, repeated, aggregate], run as never).children[0].state).toBe("running");
  });
  it.each(["aborted", "blocked", "max-tokens", "interrupted"])("treats %s as a conflicting terminal status", (endKind) => {
    const run = { ...record("one", "研究"), progress: { updatedAt: "2026-10-28T01:10:00Z", children: [{ childSessionId: "c", state: "running" }], deliverables: [], phaseCounts: {} } };
    const end = { ...frame(1, "subagent/update", { childSessionId: "c", status: endKind }), time: "2026-10-28T01:20:00Z" };
    expect(observeResearch([end], run as never).children[0].state).toBe("unknown");
  });
  it.each([["idle", "running"], ["failed", "completed"]])("keeps %s versus replayed %s uncertain", (recorded, replayed) => {
    const run = { ...record("one", "研究"), progress: { updatedAt: "2026-10-28T01:10:00Z", children: [{ childSessionId: "c", state: recorded }], deliverables: [], phaseCounts: {} } };
    const update = { ...frame(1, "subagent/update", { childSessionId: "c", status: replayed }), time: "2026-10-28T01:20:00Z" };
    expect(observeResearch([update], run as never).children[0].state).toBe("unknown");
  });
  it("marks the initial retained event range as partial when its sequence starts later", () => {
    expect(observeResearch([frame(40, "run/state", {state: "running"})], null).gap).toBe(true);
  });
  it("does not infer subagent nesting or completion from a call alone", () => {
    const result = observeResearch([frame(1, "run/event", { sessionId: "c", child: true, event: { type: "tool/call", callId: "x", tool: "fetch" } })], null);
    expect(result.children).toHaveLength(0);
    expect(result.tools[0].state).toBe("已调用，结果未知");
  });
});
