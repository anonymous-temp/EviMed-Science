import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStreamEvent } from "@/lib/runEvents";
import { elapsedClock, ResearchObservatory } from "./ResearchObservatory";

const mocks = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({ listWebAgentRuns: mocks.list }));
vi.mock("@/lib/runEvents", () => ({ subscribeRunEvents: mocks.subscribe }));
const frame = (seq: number, type: string, fields: Record<string, unknown> = {}): RunStreamEvent => ({ seq, type, time: `2026-10-28T01:${String(seq).padStart(2, "0")}:00Z`, ...fields });
const record = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, status: "succeeded", sessionId: "root", startedAt: "2026-10-28T01:00:00Z", finishedAt: "2026-10-28T01:05:00Z", durationMs: 300000, artifacts: [], ...extra });
let emit: (frames: RunStreamEvent[]) => void = () => {};
let connection: (connected: boolean) => void = () => {};

describe("research observatory", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.list.mockReset(); mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((_runId: string, onEvent: (event: RunStreamEvent) => void, options: { onConnection?: (connected: boolean) => void }) => {
      emit = (frames) => frames.forEach(onEvent); connection = options.onConnection ?? (() => {});
      return () => {};
    });
  });
  const flush = async (frames: RunStreamEvent[]) => { await act(async () => { emit(frames); await new Promise(resolve => setTimeout(resolve, 200)); }); };

  it("waits for a selection, then shows one run at a time", async () => {
    mocks.list.mockResolvedValue([record("one", "第一项研究"), record("two", "第二项研究")]);
    const view = render(<ResearchObservatory runId={null} />);
    expect(screen.getByText("等待研究启动")).toBeInTheDocument();
    view.rerender(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("第一项研究")).toBeInTheDocument();
    view.rerender(<ResearchObservatory runId="two" />);
    expect(screen.queryByText("第一项研究")).not.toBeInTheDocument();
    expect(await screen.findByText("第二项研究")).toBeInTheDocument();
  });
  it("does not let an older initial record overwrite the terminal refresh", async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; })).mockResolvedValue([record("one", "已结束记录")]);
    render(<ResearchObservatory runId="one" />);
    await flush([frame(1, "run/state", { state: "succeeded" })]);
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
  it("counts what the run reported and leaves an unreported count unknown", async () => {
    mocks.list.mockResolvedValue([record("one", "研究")]);
    render(<ResearchObservatory runId="one" />);
    await screen.findByText("研究");
    const hud = screen.getByText("模型调用").closest("dl") as HTMLElement;
    expect(within(hud).getAllByText("—").length).toBe(6);
    expect(screen.getByLabelText("运行时长 5 分钟")).toHaveTextContent("00:05:00");
    await flush([frame(1, "run/progress", { progress: { deliverables: [{ id: "d1", title: "证据检索", status: "delegated" }], phaseCounts: { search: 4, screen: 1, fulltext: 2, claims: 3, write: 0, deliver: 0 },
      currentPhase: "claims", sources: { searched: 120, included: 18, fullText: 6 }, claims: { total: 10, verified: 7 }, children: [],
      usage: { requests: 31, inputTokens: 52000, outputTokens: 8000, cachedInputTokens: 0, costCny: 3.5 }, updatedAt: "2026-10-28T01:04:00Z" } })]);
    expect(within(hud).getByText("31")).toBeInTheDocument();
    expect(within(hud).getByText("6万")).toBeInTheDocument();
    expect(within(hud).getByText("18")).toBeInTheDocument();
    expect(within(hud).getByText("7/10")).toBeInTheDocument();
    expect(within(hud).getByText("3.50")).toBeInTheDocument();
    expect(screen.getByLabelText("研究任务")).toHaveTextContent("证据检索进行中");
    expect(screen.getByRole("img", { name: /检索 4 次，阅读 3 次，核对 3 次/ })).toBeInTheDocument();
  });
  it("shows a live run's operations, each with its input and result, and filters them by member", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([record("one", "研究", { status: "running", finishedAt: null, durationMs: null })]);
    render(<ResearchObservatory runId="one" />);
    await screen.findByText("研究");
    await act(async () => { connection(true); });
    await flush([
      frame(1, "run/state", { state: "running" }),
      frame(2, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c1", parentSessionId: "root", label: "证据分析" } }),
      frame(3, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "a", tool: "write", input: { path: "analysis/run.py", code: "print(1)" }, narration: "" } }),
      frame(4, "run/event", { sessionId: "c1", child: true, event: { type: "tool/call", callId: "b", tool: "mcp__evimed__literature_search", input: { query: "actual query" }, narration: "" } }),
      frame(5, "run/event", { sessionId: "c1", child: true, event: { type: "tool/result", callId: "b", tool: "mcp__evimed__literature_search", status: "completed", output: "actual result", durationMs: 2000 } }),
      frame(6, "run/event", { sessionId: "root", event: { type: "assistant/delta", kind: "reasoning", text: "先看两项试验的终点" } }),
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("实时");
    const feed = screen.getByRole("region", { name: "实时动态" });
    expect(within(feed).getByText("文献检索")).toBeInTheDocument();
    expect(within(feed).getByText(/“actual query”/)).toBeInTheDocument();
    expect(screen.getByText("先看两项试验的终点")).toBeInTheDocument();
    // The newest operation is open in the inspector.
    const inspector = screen.getByRole("region", { name: "操作详情" });
    expect(within(inspector).getByText("actual result")).toBeInTheDocument();
    await user.click(within(feed).getByRole("button", { name: /写入文件/ }));
    expect(within(inspector).getByText(/print\(1\)/)).toBeInTheDocument();
    expect(within(inspector).getByText("等待结果")).toBeInTheDocument();
    await user.click(within(feed).getByRole("button", { name: "主研究员" }));
    expect(within(feed).queryByText("文献检索")).not.toBeInTheDocument();
    await user.click(within(feed).getByRole("button", { name: /证据分析/ }));
    expect(within(feed).getByText("文献检索")).toBeInTheDocument();
    expect(within(feed).queryByText("写入文件")).not.toBeInTheDocument();
  });
  it("collapses a long result while keeping its beginning visible", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([record("one", "研究")]);
    render(<ResearchObservatory runId="one" />);
    await screen.findByText("研究");
    await flush([frame(1, "run/event", { sessionId: "root", event: { type: "tool/result", callId: "a", tool: "read", status: "completed", output: `开始${"x".repeat(1300)}结束` } })]);
    expect(screen.getByText(/^开始x+…$/)).toBeInTheDocument();
    await user.click(screen.getByText("展开全部"));
    expect(screen.getByText(/^开始x+结束$/)).toBeVisible();
  });
  it("opens what the run handed over", async () => {
    const user = userEvent.setup(); const open = vi.fn();
    mocks.list.mockResolvedValue([record("one", "研究", { outputFiles: ["deliverables/report.docx", "../escape.txt"] })]);
    render(<ResearchObservatory runId="one" onOpenFile={open} />);
    await user.click(await screen.findByRole("button", { name: "report.docx" }));
    expect(open).toHaveBeenCalledWith("deliverables/report.docx", "one");
    expect(screen.queryByText("escape.txt")).not.toBeInTheDocument();
  });
  it("writes a long run's time the way a long study is read", () => {
    expect(elapsedClock(null)).toBe("--:--:--");
    expect(elapsedClock((228 * 3600 + 28 * 60 + 33) * 1000)).toBe("228:28:33");
  });
});
