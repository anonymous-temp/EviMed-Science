import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { useTaskPane } from "@/lib/taskPane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { ActiveResearchPage } from "./ActiveResearchPage";

const identity = vi.hoisted(() => ({ projectId: "project-a" }));
const skillMocks = vi.hoisted(() => ({ listPlatformSkills: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", () => skillMocks);
const dbMocks = vi.hoisted(() => ({ researchDatabaseStatus: vi.fn(), listResearchDatabases: vi.fn(), listResearchDatabaseTables: vi.fn(), saveResearchDatabase: vi.fn(), snapshotResearchDatabase: vi.fn(), removeResearchDatabase: vi.fn() }));
vi.mock("@/lib/researchDatabaseClient", () => dbMocks);
const goalMocks = vi.hoisted(() => ({ listResearchGoals: vi.fn(), pauseResearchGoal: vi.fn(), resumeResearchGoal: vi.fn() }));
vi.mock("@/lib/researchGoalClient", () => goalMocks);
const dispatchMocks = vi.hoisted(() => ({ startResearchGoal: vi.fn() }));
vi.mock("@/lib/dispatch", async (original) => ({ ...(await original<object>()), startResearchGoal: dispatchMocks.startResearchGoal }));
const mocks = vi.hoisted(() => ({ listWebAgentRuns: vi.fn(), cancelWebAgentRun: vi.fn(), pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), partition: vi.fn() }));
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId, listWebAgentRuns: mocks.listWebAgentRuns, cancelWebAgentRun: mocks.cancelWebAgentRun }));
vi.mock("@/lib/backend", async (original) => ({ ...(await original<object>()), pickFiles: mocks.pickFiles, uploadFilesToWorkspace: mocks.uploadFilesToWorkspace }));
vi.mock("@/lib/knowledgeBaseFiles", async (original) => ({ ...(await original<object>()), partitionKnowledgeBaseFiles: mocks.partition }));
// The observatory is drawn elsewhere; what the page needs of it is the run it is shown, what its stream says of that run, and the ways to begin it stands by with.
vi.mock("@/components/activeResearch/ResearchObservatory", () => ({ ResearchObservatory: ({ runId, onObserved, standbyActions }: { runId: string | null; onObserved?: (observed: unknown) => void; standbyActions?: React.ReactNode }) => <>
  <p data-testid="observatory">{runId ?? "no-run"}</p>
  {standbyActions}<p>{standbyActions ? "写下研究目标" : ""}</p>
  <button onClick={() => onObserved?.({ runId, state: "succeeded", connected: true })}>stream: ended</button>
  <button onClick={() => onObserved?.({ runId, state: "running", connected: true })}>stream: running</button>
  <button onClick={() => onObserved?.(null)}>stream: closed</button>
</> }));
function PaneProbe() { const pane = useTaskPane(); return <><p data-testid="native-pane">{pane ? `${pane.projectId}:${pane.sessionId}` : "none"}</p></>; }
const renderPage = (state: unknown = null) => render(<MemoryRouter initialEntries={[{ pathname: "/app/active-research", state }]}><ActiveResearchPage /><PaneProbe /></MemoryRouter>);

describe("active research workspace", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    identity.projectId = "project-a"; sessionStorage.clear(); dispatchMocks.startResearchGoal.mockReset(); skillMocks.listPlatformSkills.mockReset().mockResolvedValue({ items: [{ id: "loopx:loopx" }] }); Object.values(mocks).forEach(fn => fn.mockReset()); Object.values(dbMocks).forEach(fn => fn.mockReset()); dbMocks.listResearchDatabases.mockResolvedValue({ items: [] }); dbMocks.researchDatabaseStatus.mockResolvedValue({ available: true });
    mocks.listWebAgentRuns.mockResolvedValue([]);
    // A deployment without the goal service, unless a test says otherwise: the page reads a goal by its rounds alone.
    Object.values(goalMocks).forEach(fn => fn.mockReset());
    goalMocks.listResearchGoals.mockResolvedValue({ available: false, goals: [] });
    goalMocks.pauseResearchGoal.mockResolvedValue({ sessionId: "goal-session", status: "paused" }); goalMocks.resumeResearchGoal.mockResolvedValue({ sessionId: "goal-session", status: "active" });
    mocks.partition.mockImplementation((files: File[]) => ({ accepted: files, refused: [] }));
  });
  it("does not offer to start long research when the deployment does not advertise it", async () => {
    skillMocks.listPlatformSkills.mockResolvedValue({ items: [] }); renderPage();
    expect(await screen.findByText(/暂未开通/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发起研究" })).toBeDisabled();
  });
  it("starts a research from one sentence, without leaving the page, and watches it from its first second", async () => {
    const user = userEvent.setup();
    const started = { id: "new-run", sessionId: "new-session", effectiveRouteReason: "research-goal", question: "评估心衰队列的再入院风险", startedAt: "2026-11-01T00:00:00Z", status: "running" };
    dispatchMocks.startResearchGoal.mockResolvedValue(started);
    renderPage(); await screen.findByTestId("observatory");
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
    await user.type(screen.getByLabelText("研究目标"), "  评估心衰队列的再入院风险 ");
    mocks.listWebAgentRuns.mockResolvedValue([started]);
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(dispatchMocks.startResearchGoal).toHaveBeenCalledWith(expect.objectContaining({ text: "评估心衰队列的再入院风险" }));
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("new-run"));
    expect(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "评估心衰队列的再入院风险" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "原生研究对话" })).not.toBeInTheDocument();
    expect(screen.queryByText(/loopx/i)).not.toBeInTheDocument();
  });
  it("retries a goal that could not be confirmed as the same request", async () => {
    const user = userEvent.setup();
    dispatchMocks.startResearchGoal.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue({ id: "new-run", sessionId: "new-session", effectiveRouteReason: "research-goal", question: "目标", startedAt: "2026-11-01T00:00:00Z", status: "running" });
    renderPage(); await screen.findByTestId("observatory");
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    await waitFor(() => expect(dispatchMocks.startResearchGoal).toHaveBeenCalledTimes(2));
    const [first, second] = dispatchMocks.startResearchGoal.mock.calls.map(call => call[0]);
    expect(second.dispatchId).toBe(first.dispatchId); expect(second.sessionId).toBe(first.sessionId);
  });
  it("REVIEWFIX 10 reopening the dialog after a lost answer is the same request until the goal is known to have started", async () => {
    const user = userEvent.setup();
    dispatchMocks.startResearchGoal.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue({ id: "new-run", sessionId: "new-session", effectiveRouteReason: "research-goal", question: "目标", startedAt: "2026-11-01T00:00:00Z", status: "running" });
    renderPage(); await screen.findByTestId("observatory");
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // the answer was lost: the person closes the dialog and opens it again with the same goal
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByLabelText("研究目标")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    await waitFor(() => expect(dispatchMocks.startResearchGoal).toHaveBeenCalledTimes(2));
    const [first, second] = dispatchMocks.startResearchGoal.mock.calls.map(call => call[0]);
    expect(second.dispatchId).toBe(first.dispatchId); expect(second.sessionId).toBe(first.sessionId);
  });
  it("REVIEWFIX 10 another goal is another request, even when the first answer was lost", async () => {
    const user = userEvent.setup();
    dispatchMocks.startResearchGoal.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue({ id: "new-run", sessionId: "new-session", effectiveRouteReason: "research-goal", question: "另一个目标", startedAt: "2026-11-01T00:00:00Z", status: "running" });
    renderPage(); await screen.findByTestId("observatory");
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByLabelText("研究目标")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    await user.type(screen.getByLabelText("研究目标"), "另一个目标");
    await user.click(screen.getByRole("button", { name: "开始研究" }));
    await waitFor(() => expect(dispatchMocks.startResearchGoal).toHaveBeenCalledTimes(2));
    const [first, second] = dispatchMocks.startResearchGoal.mock.calls.map(call => call[0]);
    expect(second.dispatchId).not.toBe(first.dispatchId);
  });
  it("connects files to the project's knowledge base, with no study named", async () => {
    const user = userEvent.setup(); const file = new File(["x"], "cohort-2.csv");
    mocks.pickFiles.mockResolvedValue([file]); mocks.partition.mockReturnValue({ accepted: [file], refused: [] }); mocks.uploadFilesToWorkspace.mockResolvedValue(["cohort-2.csv"]);
    dbMocks.researchDatabaseStatus.mockResolvedValue({ available: false });
    renderPage(); await screen.findByTestId("observatory");
    await user.click(screen.getByRole("button", { name: "接入数据" }));
    expect(await screen.findByText(/已接入 1 份资料/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base", "project-a", expect.any(Function));
  });
  it("offers the database beside the files where the deployment has the connector, and imports with no study named", async () => {
    const user = userEvent.setup(); dbMocks.researchDatabaseStatus.mockResolvedValue({ available: true });
    renderPage(); await screen.findByTestId("observatory");
    await user.click(await screen.findByRole("button", { name: "接入数据" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "上传文件" })).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "从数据库导入" }));
    await waitFor(() => expect(dbMocks.listResearchDatabases).toHaveBeenCalled());
  });
  it("opens an observed goal's own native conversation inside the page", async () => {
    const user = userEvent.setup(); mocks.listWebAgentRuns.mockResolvedValue([{ id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running" }]);
    renderPage(); await screen.findByTestId("observatory");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "长期研究" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("project-a:goal-session");
    // Closing it goes back to the goal's results, and the conversation is withdrawn.
    await user.click(screen.getByRole("button", { name: "收起对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
    expect(screen.getByRole("tab", { name: "结果", selected: true })).toBeInTheDocument();
  });
  it("says a goal round's real outcome in the queue, as the goal's own record does", async () => {
    const user = userEvent.setup();
    const round = (id: string, session: string, status: string) => ({ id, sessionId: session, automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: `goal-${session}`, runId: null }, startedAt: "2026-10-28T01:00:00Z", finishedAt: "2026-10-28T01:30:00Z", status, title: `目标 ${status}` });
    mocks.listWebAgentRuns.mockResolvedValue([round("r-failed", "s-failed", "failed"), round("r-stopped", "s-stopped", "canceled"), round("r-done", "s-done", "succeeded")]);
    renderPage(); await screen.findByTestId("observatory");
    const queue = within(await screen.findByLabelText("研究队列"));
    for (const [title, word, record] of [["目标 failed", "未完成", "未完成"], ["目标 canceled", "已停止", "已停止"], ["目标 succeeded", "本轮完成", "已完成"]] as const) {
      const card = queue.getByRole("button", { name: title });
      expect(card).toHaveTextContent(word);
      await user.click(card);
      // The record in the 记录 view names the round itself; a round that ran to its end does not say the goal is finished.
      await user.click(screen.getByRole("tab", { name: "记录" }));
      expect(within(screen.getByLabelText("推进记录")).getByText(new RegExp(`第 1 轮 · ${record}`))).toBeInTheDocument();
    }
    expect(queue.getByRole("button", { name: "目标 succeeded" })).not.toHaveTextContent("已完成");
    expect(queue.getByRole("button", { name: "目标 failed" })).not.toHaveTextContent("已完成");
  });
  it("does not show the first-research recipe while the long goals are still being read, or when they could not be read", async () => {
    let release: (runs: unknown[]) => void = () => {};
    mocks.listWebAgentRuns.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const first = renderPage();
    await waitFor(() => expect(mocks.listWebAgentRuns).toHaveBeenCalled());
    expect(await screen.findByRole("status", { name: "正在载入研究" })).toBeInTheDocument();
    expect(screen.queryByText(/写下研究目标/)).not.toBeInTheDocument();
    await act(async () => { release([]); });
    expect(await screen.findByText(/写下研究目标/)).toBeInTheDocument();
    first.unmount();
    mocks.listWebAgentRuns.mockReset().mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByText("长期研究暂时无法载入。")).toBeInTheDocument();
    expect(screen.queryByText(/写下研究目标/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在载入研究" })).not.toBeInTheDocument();
  });
  describe("a long goal's own state", () => {
    const ASKED = "评估心衰队列的再入院风险";
    const anchor = { id: "anchor-run", sessionId: "goal-session", question: `/loopx ${ASKED}`, effectiveRouteReason: "research-goal", startedAt: "2026-11-03T00:00:00Z", finishedAt: "2026-11-03T00:10:00Z", status: "succeeded" };
    const round = (id: string, startedAt: string, status = "succeeded", extra: Record<string, unknown> = {}) => ({ id, sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: "anchor-run" }, startedAt, finishedAt: status === "running" ? null : startedAt.replace("T0", "T1"), status, ...extra });
    const resting = [anchor, round("round-1", "2026-11-03T01:00:00Z")];
    const goalState = (status: string, reason: string | null = null) => ({ available: true, goals: [{ sessionId: "goal-session", status, reason, statusAt: "2026-11-03T02:00:00Z", goalId: "goal", progress: null }] });
    const showGoal = async (runs: unknown[], states: unknown) => {
      mocks.listWebAgentRuns.mockResolvedValue(runs); goalMocks.listResearchGoals.mockResolvedValue(states);
      renderPage(); await screen.findByTestId("observatory");
      const card = await within(await screen.findByLabelText("研究队列")).findByRole("button", { name: ASKED });
      await userEvent.setup().click(card);
      return { card, row: within(screen.getByLabelText("当前研究")) };
    };

    it.each([
      ["active", null, "进行中", ["暂停"], null],
      ["paused", "person", "已暂停", ["继续"], null],
      ["paused", "no_progress", "已暂停", ["继续"], "连续几轮没有新的产出，已自动暂停。"],
      ["paused", "budget", "已暂停", ["继续"], "到了这项研究的花费上限，已自动暂停。"],
      ["stopped", "person", "已停止", ["继续"], null],
      ["finished", null, "已完成", [], null],
      ["waiting", null, "等你决定", ["继续"], "还有没做完的部分，AI 没有继续。"],
      ["interrupted", "runtime_stopped", "已中断", ["继续"], "运行被中断后没能自动接上。"],
    ])("says a goal at rest that the control plane reports %s (%s) as %s, with the buttons that fit it", async (status, reason, word, buttons, note) => {
      const { card, row } = await showGoal(resting, goalState(status, reason));
      expect(card).toHaveTextContent(word);
      expect(card).not.toHaveTextContent("本轮完成");
      for (const label of ["暂停", "继续"]) {
        if (buttons.includes(label)) expect(row.getByRole("button", { name: label })).toBeEnabled(); else expect(row.queryByRole("button", { name: label })).not.toBeInTheDocument();
      }
      // No round is going, so there is nothing to stop; the conversation stays.
      expect(row.queryByRole("button", { name: "停止本轮" })).not.toBeInTheDocument();
      expect(row.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
      if (note) expect(row.getByText(note)).toBeInTheDocument(); else expect(row.queryByText(/已自动暂停|没能自动接上|AI 没有继续/)).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/loopx|目标 ID|配额|结算|回写/i);
    });
    it("says a goal between two rounds is going, and that the next round starts at once", async () => {
      const { card } = await showGoal(resting, goalState("active"));
      expect(card).toHaveTextContent("下一轮马上开始");
      expect(within(screen.getByLabelText("研究队列")).getByText(/1 项进行中/)).toBeInTheDocument();
    });
    it("offers to pause and to stop the round that is going, whatever the goal's state, and stops it through the run's own route", async () => {
      const user = userEvent.setup(); mocks.cancelWebAgentRun.mockResolvedValue({});
      const { card, row } = await showGoal([anchor, round("round-1", "2026-11-03T01:00:00Z"), round("round-2", "2026-11-03T02:00:00Z", "running")], goalState("finished"));
      expect(card).toHaveTextContent("进行中");
      expect(row.getByRole("button", { name: "暂停" })).toBeEnabled();
      expect(row.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
      goalMocks.listResearchGoals.mockClear();
      await user.click(row.getByRole("button", { name: "停止本轮" }));
      expect(mocks.cancelWebAgentRun).toHaveBeenCalledWith("round-2");
      await waitFor(() => expect(goalMocks.listResearchGoals).toHaveBeenCalled());
    });
    it("does not offer to pause a goal that is already paused, nor to resume one whose round is going", async () => {
      const { row } = await showGoal([anchor, round("round-2", "2026-11-03T02:00:00Z", "running")], goalState("paused", "person"));
      expect(row.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
      expect(row.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
      expect(row.getByRole("button", { name: "停止本轮" })).toBeInTheDocument();
    });
    it("pauses and resumes through the goal's routes and reads the goals again at once, so the page says what happened", async () => {
      const user = userEvent.setup();
      const { card, row } = await showGoal(resting, goalState("active"));
      goalMocks.listResearchGoals.mockClear(); goalMocks.listResearchGoals.mockResolvedValue(goalState("paused", "person"));
      await user.click(row.getByRole("button", { name: "暂停" }));
      expect(goalMocks.pauseResearchGoal).toHaveBeenCalledWith("project-a", "goal-session");
      await waitFor(() => expect(card).toHaveTextContent("已暂停"));
      expect(goalMocks.listResearchGoals).toHaveBeenCalled();
      goalMocks.listResearchGoals.mockClear(); goalMocks.listResearchGoals.mockResolvedValue(goalState("active"));
      await user.click(await row.findByRole("button", { name: "继续" }));
      expect(goalMocks.resumeResearchGoal).toHaveBeenCalledWith("project-a", "goal-session");
      await waitFor(() => expect(card).toHaveTextContent("下一轮马上开始"));
    });
    it("says a refused resume in plain words and leaves the goal where it was", async () => {
      const user = userEvent.setup();
      goalMocks.resumeResearchGoal.mockRejectedValue(new WebApiError("busy", { status: 409, code: "agent_run_active" }));
      const { card, row } = await showGoal(resting, goalState("paused", "person"));
      await user.click(row.getByRole("button", { name: "继续" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(card).toHaveTextContent("已暂停");
    });
    it("reads a goal by its rounds alone where the deployment keeps no goal state, with no pause or resume", async () => {
      const { card, row } = await showGoal(resting, { available: false, goals: [{ sessionId: "goal-session", status: "paused", reason: "person", statusAt: null, goalId: "goal", progress: null }] });
      expect(card).toHaveTextContent("本轮完成");
      for (const label of ["暂停", "继续", "停止本轮"]) expect(row.queryByRole("button", { name: label })).not.toBeInTheDocument();
      expect(row.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
    });
    it("reads a goal by its rounds when the control plane has no state for it", async () => {
      const { card } = await showGoal(resting, { available: true, goals: [{ sessionId: "another-session", status: "paused", reason: "person", statusAt: null, goalId: "x", progress: null }] });
      expect(card).toHaveTextContent("本轮完成");
    });
    it("keeps the last state it had when a later read of it fails, and says nothing of it", async () => {
      const user = userEvent.setup();
      const { card } = await showGoal(resting, goalState("paused", "budget"));
      expect(card).toHaveTextContent("已暂停");
      goalMocks.listResearchGoals.mockReset().mockRejectedValue(new Error("offline"));
      await user.click(screen.getByRole("button", { name: "stream: ended" }));
      await waitFor(() => expect(goalMocks.listResearchGoals).toHaveBeenCalled());
      expect(card).toHaveTextContent("已暂停");
      expect(screen.queryByText("长期研究暂时无法载入。")).not.toBeInTheDocument();
      expect(screen.getByText("到了这项研究的花费上限，已自动暂停。")).toBeInTheDocument();
    });
    it("totals what every round cost, the way the observatory says a cost, and says nothing where no round reported one", async () => {
      const usage = (costCny: number) => ({ usage: { requests: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costCny } });
      const { row } = await showGoal([{ ...anchor, ...usage(0.5) }, round("round-1", "2026-11-03T01:00:00Z", "succeeded", usage(1.25)), round("round-2", "2026-11-03T02:00:00Z", "succeeded", usage(0.004))], goalState("active"));
      expect(row.getByText("长期研究 · 已推进 3 轮 · 累计消耗 1.75 灵豆")).toBeInTheDocument();
    });
    it("reads a small total as under a hundredth, and an unreported cost as none shown", async () => {
      const usage = (costCny: number) => ({ usage: { requests: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costCny } });
      const first = await showGoal([anchor, round("round-1", "2026-11-03T01:00:00Z", "succeeded", usage(0.004))], goalState("active"));
      expect(first.row.getByText("长期研究 · 已推进 2 轮 · 累计消耗 不足 0.01 灵豆")).toBeInTheDocument();
      cleanup();
      const second = await showGoal(resting, goalState("active"));
      expect(second.row.getByText("长期研究 · 已推进 2 轮")).toBeInTheDocument();
    });
    it("lists a file one round after round rewrote once, from the newest round", async () => {
      const user = userEvent.setup();
      await showGoal([{ ...anchor, outputFiles: ["output/report.docx"] }, round("round-1", "2026-11-03T01:00:00Z", "succeeded", { outputFiles: ["output/report.docx", "output/notes.md"], presentedFiles: ["output/report.docx"] }),
        round("round-2", "2026-11-03T02:00:00Z", "succeeded", { presentedFiles: ["output/report.docx"] })], goalState("active"));
      await user.click(screen.getByRole("tab", { name: "结果" }));
      const files = within(screen.getByLabelText("研究文件")).getAllByRole("link");
      expect(files.map(link => link.textContent)).toEqual(["report.docx", "notes.md"]);
      expect(files[0]).toHaveAttribute("href", "/app/runs/round-2/files/output/report.docx");
      expect(files[1]).toHaveAttribute("href", "/app/runs/round-1/files/output/notes.md");
    });
    it("counts a person's message between two rounds, and a turn started to take the goal up again, as rounds of it", async () => {
      const { card, row } = await showGoal([anchor, round("round-1", "2026-11-03T01:00:00Z"),
        { id: "said", sessionId: "goal-session", question: "先看一下亚组", startedAt: "2026-11-03T02:00:00Z", status: "running" },
        { id: "other", sessionId: "other-session", question: "与它无关", startedAt: "2026-11-03T02:30:00Z", status: "running" }], goalState("active"));
      expect(row.getByText(/已推进 3 轮/)).toBeInTheDocument();
      expect(card).toHaveTextContent("进行中");
      expect(card).toHaveTextContent("本轮");
    });
  });
  describe("the conversation inside the page", () => {
    const original = window.innerHeight;
    let spy: { mockRestore: () => void } | null = null;
    afterEach(() => { Object.defineProperty(window, "innerHeight", { value: original, configurable: true }); spy?.mockRestore(); spy = null; });
    const goalRun = { id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running" };
    const rect = (top: number) => { spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }); };
    it("is as tall as the window leaves below its top, and follows the window", async () => {
      const user = userEvent.setup();
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true }); rect(85);
      mocks.listWebAgentRuns.mockResolvedValue([goalRun]);
      renderPage(); await screen.findByTestId("observatory");
      await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "长期研究" }));
      await user.click(screen.getByRole("tab", { name: "对话" }));
      const pane = screen.getByRole("region", { name: "原生研究对话" });
      expect(pane).toHaveStyle({ height: "815px" });
      expect(pane).not.toHaveClass("min-h-screen");
      Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(pane).toHaveStyle({ height: "615px" });
      // A window too short for a conversation keeps a floor.
      Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(pane).toHaveStyle({ height: "360px" });
    });
  });
  it("does not upload to a different project when the selection changes while the picker is open", async () => {
    const user = userEvent.setup(); let finish: (files: File[]) => void = () => {};
    mocks.pickFiles.mockReturnValue(new Promise<File[]>(resolve => { finish = resolve; }));
    dbMocks.researchDatabaseStatus.mockResolvedValue({ available: false }); renderPage(); await screen.findByTestId("observatory");
    await user.click(screen.getByRole("button", { name: "接入数据" }));
    identity.projectId = "project-b";
    await act(async () => { finish([new File(["x"], "data.csv")]); });
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
  });
  it("refuses more than ten uploads before sending bytes", async () => {
    const user = userEvent.setup();
    mocks.pickFiles.mockResolvedValue(Array.from({ length: 11 }, (_, i) => new File(["x"], `file${i}.csv`)));
    dbMocks.researchDatabaseStatus.mockResolvedValue({ available: false }); renderPage(); await screen.findByTestId("observatory");
    await user.click(screen.getByRole("button", { name: "接入数据" }));
    expect(await screen.findByText(/每次最多添加 10 份资料/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
  });
  it("rejects a mixed invalid selection before uploading any file", async () => {
    const user = userEvent.setup();
    mocks.pickFiles.mockResolvedValue([new File(["ok"], "a.csv"), new File(["bad"], "b.csv")]);
    mocks.partition.mockReturnValue({ accepted: [new File(["ok"], "a.csv")], refused: [{ name: "b.csv", reason: "不支持" }] });
    dbMocks.researchDatabaseStatus.mockResolvedValue({ available: false }); renderPage(); await screen.findByTestId("observatory"); await user.click(screen.getByRole("button", { name: "接入数据" }));
    expect(await screen.findByText(/b.csv（不支持）/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
  });
  it("stands by in the observatory when the project has no research, with the two ways to begin in the scene", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId("observatory")).toHaveTextContent("no-run");
    expect(screen.queryByLabelText("研究队列")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    expect(screen.getAllByRole("button", { name: "发起研究" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "接入数据" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    expect(screen.getByLabelText("研究目标")).toBeInTheDocument();
  });
  it("reads the run list at the sidebar's pace and again at once when the stream says the round is over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    renderPage(); await screen.findByTestId("observatory"); await act(async () => { await Promise.resolve(); });
    mocks.listWebAgentRuns.mockClear();
    await advance(19_000); expect(mocks.listWebAgentRuns).not.toHaveBeenCalled();
    await advance(1_000); expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(1);
    await advance(20_000); expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(2);
  });
  it("leaves what was shown where it was when a later read fails, and shows the error alone when the first one did", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const goal = { id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running", title: "长期目标" };
    mocks.listWebAgentRuns.mockResolvedValue([goal]);
    renderPage(); await screen.findByLabelText("研究队列"); await act(async () => { await Promise.resolve(); });
    mocks.listWebAgentRuns.mockRejectedValue(new Error("网络中断"));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(await screen.findByText("长期研究暂时无法载入。")).toBeInTheDocument();
    expect(screen.getByLabelText("研究队列")).toBeInTheDocument();
    mocks.listWebAgentRuns.mockResolvedValue([goal]);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.queryByText("长期研究暂时无法载入。")).not.toBeInTheDocument();
  });
});
