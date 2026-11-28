import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type RingCanvas from "@/components/charts/ring/RingCanvas";
import type { RunStreamEvent } from "@/lib/runEvents";
import { elapsedClock, ResearchObservatory } from "./ResearchObservatory";

const mocks = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn() }));
const ring = vi.hoisted(() => ({
  allowed: false,
  props: null as ComponentProps<typeof RingCanvas> | null,
  pulse: vi.fn(),
}));
vi.mock("@/components/charts/ring/ringSupport", () => ({ useRingAllowed: () => ring.allowed }));
vi.mock("@/components/charts/ring/RingCanvas", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  function StandIn(props: ComponentProps<typeof RingCanvas>) {
    ring.props = props;
    React.useImperativeHandle(props.handle, () => ({ replay: () => false, stopReplay: () => {}, peek: () => {}, pulse: ring.pulse }), []);
    return React.createElement("div", { role: "img", "aria-label": props.label, "data-testid": "research-ring" });
  }
  return { default: StandIn };
});
vi.mock("@/vendor/haloflux/stage.js", () => ({ createHaloFlux: () => ({ resize() {}, draw() {}, signal() {} }) }));
vi.mock("@/lib/apiClient", () => ({ listWebAgentRuns: mocks.list }));
vi.mock("@/lib/runEvents", () => ({ subscribeRunEvents: mocks.subscribe }));
const frame = (seq: number, type: string, fields: Record<string, unknown> = {}): RunStreamEvent => ({ seq, type, time: `2026-10-28T01:${String(seq).padStart(2, "0")}:00Z`, ...fields });
const record = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, status: "succeeded", sessionId: "root", startedAt: "2026-10-28T01:00:00Z", finishedAt: "2026-10-28T01:05:00Z", durationMs: 300000, artifacts: [], ...extra });
let emit: (frames: RunStreamEvent[]) => void = () => {};
let connection: (connected: boolean) => void = () => {};

describe("research observatory", () => {
  beforeEach(() => {
    vi.useRealTimers();
    ring.allowed = false; ring.props = null; ring.pulse.mockClear();
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
    expect(screen.queryByText(/写下研究目标/)).not.toBeInTheDocument();
    view.rerender(<ResearchObservatory runId="one" />);
    expect(await screen.findByText("第一项研究")).toBeInTheDocument();
    view.rerender(<ResearchObservatory runId="two" />);
    expect(screen.queryByText("第一项研究")).not.toBeInTheDocument();
    expect(await screen.findByText("第二项研究")).toBeInTheDocument();
  });
  it("keeps the same operation through the flow, inline halo, fullscreen inspector and file visit", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();
    mocks.list.mockResolvedValue([record("one", "归档演示", { outputFiles: ["outputs/report.md"] })]);
    const view = render(<ResearchObservatory runId="one" onOpenFile={openFile} />);
    await screen.findByText("归档演示");
    await flush([
      frame(1, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "a", tool: "web_search", input: { query: "first query" } } }),
      frame(2, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "b", tool: "web_read" } }),
      frame(3, "run/event", { sessionId: "root", event: { type: "tool/result", callId: "a", tool: "web_search", output: "first result" } }),
    ]);
    const feed = within(screen.getByRole("region", { name: "实时动态" }));
    await user.click(feed.getByRole("button", { name: /first query/ }));
    await user.click(screen.getByRole("tab", { name: "研究光环" }));
    expect(screen.getByRole("slider", { name: "浏览操作" })).toHaveValue("1");
    expect(screen.getByText("first result")).toBeInTheDocument();
    expect(screen.getByText("检索词")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /研究流程/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一个操作" }));
    expect(screen.getByRole("slider")).toHaveValue("2");
    const expand = screen.getByRole("button", { name: "全屏观测" });
    await user.click(expand);
    const dialog = within(screen.getByRole("dialog", { name: "归档演示" }));
    expect(document.querySelectorAll(".obs-halo-stage canvas")).toHaveLength(1);
    expect(dialog.getByRole("combobox", { name: "操作记录" })).toHaveValue("root:b");
    await user.selectOptions(dialog.getByRole("combobox"), "root:a");
    await user.keyboard("{Escape}");
    expect(expand).toHaveFocus();
    expect(within(screen.getByRole("region", { name: "实时动态" })).getByRole("button", { name: /first query/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(expand);
    await user.click(screen.getByRole("button", { name: "report.md" }));
    expect(openFile).toHaveBeenCalledWith("outputs/report.md", "one", { view: "halo", expanded: true, member: "all", callId: "root:a" });
    view.rerender(<ResearchObservatory runId={null} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "全屏观测" }));
    expect(within(screen.getByRole("dialog")).getByText("示例动画")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps a pinned live operation while newer calls arrive and resumes following on request", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([record("one", "实时研究", { status: "running", finishedAt: null })]);
    render(<ResearchObservatory runId="one" />);
    await user.click(await screen.findByRole("tab", { name: "研究光环" }));
    const call = (n: number) => frame(n, "run/event", { sessionId: "root", event: { type: "tool/call", callId: String(n), tool: "web_search", input: { query: `query ${n}` } } });
    await flush([call(1), call(2)]);
    expect(screen.getByRole("slider")).toHaveValue("2");
    await user.click(screen.getByRole("button", { name: "上一个操作" }));
    await flush([call(3)]);
    expect(screen.getByRole("slider")).toHaveValue("1");
    const follow = screen.getByRole("button", { name: "跟随最新" });
    expect(follow).toHaveAttribute("aria-pressed", "false");
    await user.click(follow);
    expect(follow).toHaveFocus();
    expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("slider")).toHaveValue("3");
    await user.click(follow);
    await flush([call(4)]);
    expect(screen.getByRole("slider")).toHaveValue("3");
    expect(screen.queryByRole("button", { name: "回放操作" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    expect(within(screen.getByRole("region", { name: "操作详情" })).getByText(/query 2/)).toBeInTheDocument();
    fireEvent(document.querySelector(".obs-halo-stage canvas")!, new Event("contextlost"));
    expect(screen.getByText("研究光环暂时无法显示")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新加载光环" }));
    expect(document.querySelector(".obs-halo-stage canvas")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveValue("2");
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
  it("selects operations and filters members through the research ring, then falls back on context loss", async () => {
    ring.allowed = true;
    mocks.list.mockResolvedValue([record("one", "研究", { status: "running", finishedAt: null, durationMs: null })]);
    render(<ResearchObservatory runId="one" />);
    await screen.findByTestId("research-ring");
    expect(screen.queryByLabelText(/研究流程图/)).not.toBeInTheDocument();
    expect(ring.pulse).not.toHaveBeenCalled();

    await flush([
      frame(1, "run/state", { state: "running" }),
      frame(2, "run/event", { sessionId: "root", event: { type: "subagent/started", childSessionId: "c1", parentSessionId: "root", label: "证据分析" } }),
      frame(3, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "a", tool: "write", input: { path: "analysis/run.py" } } }),
      frame(4, "run/event", { sessionId: "c1", child: true, event: { type: "tool/call", callId: "b", tool: "mcp__evimed__literature_search" } }),
    ]);
    expect(ring.props?.moving).toBe(true);
    expect(ring.pulse.mock.calls).toEqual(expect.arrayContaining([["root:a", "centre"], ["c1:b", "c1"]]));
    expect(ring.pulse).toHaveBeenCalledTimes(2);

    const feed = screen.getByRole("region", { name: "实时动态" });
    const inspector = screen.getByRole("region", { name: "操作详情" });
    act(() => ring.props?.onOpen({ kind: "cluster", id: "c1" }));
    const filters = within(feed).getByRole("group", { name: "按成员查看" });
    expect(within(filters).getByRole("button", { name: /证据分析/, pressed: true })).toBeInTheDocument();
    expect(within(inspector).getByText("文献检索")).toBeInTheDocument();

    act(() => ring.props?.onOpen({ kind: "cell", id: "root:a" }));
    expect(within(feed).getByRole("button", { name: /写入文件/, pressed: true })).toBeInTheDocument();
    expect(within(inspector).getByText("写入文件")).toBeInTheDocument();
    expect(within(inspector).getByText(/analysis\/run.py/)).toBeInTheDocument();
    expect(ring.props?.describe({ kind: "cell", id: "root:a" })?.facts).toEqual(["撰写", "主研究员", expect.any(String), "—"]);

    await flush([
      frame(5, "run/event", { sessionId: "root", event: { type: "tool/result", callId: "a", tool: "write", status: "completed" } }),
      frame(6, "run/state", { state: "succeeded" }),
    ]);
    expect(ring.props?.moving).toBe(false);
    expect(ring.pulse).toHaveBeenCalledTimes(2);
    act(() => ring.props?.onLost());
    expect(screen.queryByTestId("research-ring")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/研究流程图/)).toBeInTheDocument();
    expect(within(inspector).getByText("写入文件")).toBeInTheDocument();
  });

  it("shows a stationary research ring in standby when the renderer is available", async () => {
    ring.allowed = true;
    render(<ResearchObservatory runId={null} />);
    expect(await screen.findByTestId("research-ring")).toHaveAccessibleName("研究流程：等待第一个操作");
    expect(ring.props?.moving).toBe(false);
    expect(screen.queryByLabelText(/研究流程图/)).not.toBeInTheDocument();
  });

  it("keeps the goal machinery out of the feed and out of the thinking line", async () => {
    mocks.list.mockResolvedValue([record("one", "研究", { status: "running", finishedAt: null, durationMs: null })]);
    render(<ResearchObservatory runId="one" />);
    await screen.findByText("研究");
    await act(async () => { connection(true); });
    await flush([
      frame(1, "run/state", { state: "running" }),
      frame(2, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "m", tool: "bash", input: { command: "loopx --registry /home/user/.loopx/r.json goal status" }, narration: "" } }),
      frame(3, "run/event", { sessionId: "root", event: { type: "tool/result", callId: "m", tool: "bash", status: "completed", output: "registry ok" } }),
      frame(4, "run/event", { sessionId: "root", event: { type: "tool/call", callId: "a", tool: "web_search", input: { query: "SGLT2 inhibitors" }, narration: "" } }),
      frame(5, "run/event", { sessionId: "root", event: { type: "assistant/delta", kind: "reasoning", text: "现在把进度写回 LoopX，再看 quota" } }),
    ]);
    const feed = screen.getByRole("region", { name: "实时动态" });
    expect(feed.querySelectorAll(".obs-line")).toHaveLength(1);
    expect(within(feed).getByText("网页搜索")).toBeInTheDocument();
    expect(within(feed).queryByText(/loopx|registry/i)).not.toBeInTheDocument();
    expect(screen.queryByText("registry ok")).not.toBeInTheDocument();
    expect(screen.getByText("研究操作").closest("div")).toHaveTextContent("1");
    expect(screen.queryByText("思考")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/loopx/i);
    await flush([frame(6, "run/event", { sessionId: "root", event: { type: "assistant/delta", kind: "reasoning", text: "。".repeat(300) } })]);
    expect(screen.getByText("思考")).toBeInTheDocument();
  });
  describe("whether a run that is going is live", () => {
    const status = () => screen.getByRole("status");
    const at = () => new Date(Date.now()).toISOString();
    const quiet = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const start = async () => {
      vi.useFakeTimers({ now: new Date("2026-11-03T10:00:00Z") });
      mocks.list.mockResolvedValue([record("one", "研究", { status: "running", startedAt: "2026-11-03T09:59:00Z", finishedAt: null, durationMs: null })]);
      render(<ResearchObservatory runId="one" />);
      await quiet(10);
      await act(async () => { connection(true); });
    };
    const send = async (...frames: RunStreamEvent[]) => { await act(async () => { emit(frames); await vi.advanceTimersByTimeAsync(200); }); };
    const delta = (seq: number) => ({ seq, type: "run/event", time: at(), sessionId: "root", event: { type: "assistant/delta", kind: "reasoning", text: "比较终点" } }) as RunStreamEvent;
    const finishedCall = (seq: number, callId: string) => [
      { seq, type: "run/event", time: at(), sessionId: "root", event: { type: "tool/call", callId, tool: "web_search", input: { query: "q" }, narration: "" } },
      { seq: seq + 1, type: "run/event", time: at(), sessionId: "root", event: { type: "tool/result", callId, tool: "web_search", status: "completed", output: "out" } },
    ] as RunStreamEvent[];

    it("says the run is waiting on the model once ninety seconds pass with no frame and no call under way, and live again at the next frame", async () => {
      await start();
      await send({ seq: 1, type: "run/state", time: at(), state: "running" }, ...finishedCall(2, "a"));
      expect(status()).toHaveTextContent("实时");
      await quiet(80_000);
      expect(status()).toHaveTextContent("实时");
      await quiet(11_000);
      expect(status()).toHaveTextContent("等待模型响应");
      expect(status()).not.toHaveTextContent("实时");
      await send(delta(4));
      expect(status()).toHaveTextContent("实时");
    });
    it("does not call a run that is inside a long call silent, and still says reconnecting when the stream is down", async () => {
      await start();
      await send({ seq: 1, type: "run/state", time: at(), state: "running" }, { seq: 2, type: "run/event", time: at(), sessionId: "root", event: { type: "tool/call", callId: "long", tool: "bash", input: { command: "python slow.py" }, narration: "" } } as RunStreamEvent);
      await quiet(300_000);
      expect(status()).toHaveTextContent("实时");
      await act(async () => { connection(false); });
      expect(status()).toHaveTextContent("重新连接");
    });
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
    expect(open).toHaveBeenCalledWith("deliverables/report.docx", "one", { view: "flow", expanded: false, member: "all", callId: null });
    expect(screen.queryByText("escape.txt")).not.toBeInTheDocument();
  });
  it("writes a long run's time the way a long study is read", () => {
    expect(elapsedClock(null)).toBe("--:--:--");
    expect(elapsedClock((228 * 3600 + 28 * 60 + 33) * 1000)).toBe("228:28:33");
  });
});
