import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { useTaskPane } from "@/lib/taskPane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useToastStore } from "@/lib/toast";
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
const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), listWebAgentRuns: vi.fn(), steerWebAgentRun: vi.fn(), cancelWebAgentRun: vi.fn(), listEpisodes: vi.fn(), getResearchState: vi.fn(), addAgendaMaterials: vi.fn(), removeAgendaMaterial: vi.fn(), cancelEpisode: vi.fn(), followUpAgenda: vi.fn(), runAgendaNow: vi.fn(), pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), sha256Hex: vi.fn(), partition: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId, listWebAgentRuns: mocks.listWebAgentRuns, steerWebAgentRun: mocks.steerWebAgentRun, cancelWebAgentRun: mocks.cancelWebAgentRun }));
vi.mock("@/lib/backend", async (original) => ({ ...(await original<object>()), pickFiles: mocks.pickFiles, uploadFilesToWorkspace: mocks.uploadFilesToWorkspace }));
vi.mock("@/lib/fileDigest", () => ({ sha256Hex: mocks.sha256Hex }));
vi.mock("@/lib/knowledgeBaseFiles", async (original) => ({ ...(await original<object>()), partitionKnowledgeBaseFiles: mocks.partition }));
// The observatory is drawn elsewhere; what the page needs of it is the run it is shown, what its stream says of that run, and the ways to begin it stands by with.
vi.mock("@/components/autopilot/ResearchObservatory", () => ({ ResearchObservatory: ({ runId, onObserved, standbyActions }: { runId: string | null; onObserved?: (observed: unknown) => void; standbyActions?: React.ReactNode }) => <>
  <p data-testid="observatory">{runId ?? "no-run"}</p>
  {standbyActions}<p>{standbyActions ? "写下研究目标" : ""}</p>
  <button onClick={() => onObserved?.({ runId, state: "succeeded", connected: true })}>stream: ended</button>
  <button onClick={() => onObserved?.({ runId, state: "running", connected: true })}>stream: running</button>
  <button onClick={() => onObserved?.(null)}>stream: closed</button>
</> }));
vi.mock("@/components/autopilot/MaterialPicker", () => ({ MaterialPicker: ({ onChoose }: { onChoose: (ids: string[]) => void }) => <button onClick={() => onChoose(["src_new"])}>选择示例资料</button> }));
const task = (id: string, title: string) => ({ id, projectId: "project-a", revision: 1, payload: { title, topics: [], taskTypes: ["routine"], enabled: true, status: "active", materials: [] } });
const episode = (id: string, agendaId: string, status: string, path?: string) => ({ id, projectId: "project-a", revision: 1, payload: { agendaId, taskType: "routine", status, runId: `run-${id}`, sessionId: `session-${id}`, createdAt: "2026-10-28T01:00:00Z", artifactRefs: path ? [{ projectId: "project-a", runId: `run-${id}`, sessionId: `session-${id}`, path }] : [] } });
const running = { ...episode("active", "a", "running"), payload: { ...episode("active", "a", "running").payload, interactive: true } };
const finished = episode("done", "b", "merged", "output/paper.docx");
const states = (agendaId: string) => ({ agendaId, materials: agendaId === "a" ? [{ sourceId: "src_data", name: "cohort.csv", state: "ready", addedAt: "2026-10-28" }] : [], found: [], unresolved: [] });
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
    mocks.listAgendas.mockResolvedValue({ items: [task("b", "已完成研究"), task("a", "进行中研究")], nextCursor: null, available: true });
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [running] : agendaId === "b" ? [finished] : [finished, running], nextCursor: null }));
    mocks.getResearchState.mockImplementation(async (id: string) => states(id));
    mocks.addAgendaMaterials.mockResolvedValue({}); mocks.removeAgendaMaterial.mockResolvedValue({}); mocks.cancelEpisode.mockResolvedValue({ ...running, payload: { ...running.payload, status: "canceled" } }); mocks.followUpAgenda.mockResolvedValue({ episode: null }); mocks.partition.mockImplementation((files: File[]) => ({ accepted: files, refused: [] }));
  });
  it("selects an active execution first and keeps project data and output scoped", async () => {
    const user = userEvent.setup(); renderPage();
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active"));
    expect(await screen.findByText("cohort.csv")).toHaveAttribute("href", "/app/files/src_data");
    expect(within(screen.getByLabelText("研究队列")).getByText(/1 项进行中/)).toBeInTheDocument();
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-done"));
    expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument();
    for (const link of await screen.findAllByRole("link", { name: "paper.docx" })) expect(link).toHaveAttribute("href", "/app/runs/run-done/files/output/paper.docx");
  });
  it("lists a long goal in the queue by what was asked, without attributing the agenda materials to it", async () => {
    const user = userEvent.setup(); mocks.listWebAgentRuns.mockResolvedValue([
      { id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: "anchor-run" }, startedAt: "2026-10-28T01:00:00Z", status: "running" },
      { id: "anchor-run", sessionId: "goal-session", question: "/loopx 评估心衰队列的再入院风险", startedAt: "2026-10-28T00:00:00Z", status: "succeeded" },
    ]);
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(await screen.findByLabelText("研究队列")).getByRole("button", { name: "评估心衰队列的再入院风险" }));
    expect(screen.getByTestId("observatory")).toHaveTextContent("goal-run");
    expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument();
    // What the goal is: its state line, and its views under the observatory; there is no second route to its conversation.
    expect(within(screen.getByLabelText("当前研究")).getByText(/已推进 2 轮/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开所属对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在本页打开对话" })).not.toBeInTheDocument();
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
    renderPage(); await screen.findByText("cohort.csv");
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
    renderPage(); await screen.findByText("cohort.csv");
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
    renderPage(); await screen.findByText("cohort.csv");
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
    renderPage(); await screen.findByText("cohort.csv");
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
  it("makes no scheduled study here: it is shown in the queue and made in 定时任务", async () => {
    renderPage(); await screen.findByText("cohort.csv");
    expect(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "进行中研究" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /定时研究/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /长期研究/ })).not.toBeInTheDocument();
  });
  it("opens on the running goal when no study is on its way, and on the study when one is", async () => {
    const goal = { id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running", title: "长期目标" };
    mocks.listWebAgentRuns.mockResolvedValue([goal]);
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active"));
    first.unmount();
    mocks.listEpisodes.mockResolvedValue({ items: [finished], nextCursor: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("goal-run"));
    expect(within(screen.getByLabelText("当前研究")).getByText(/长期研究/)).toBeInTheDocument();
  });
  it("connects files to the project's knowledge base, with no study named", async () => {
    const user = userEvent.setup(); const file = new File(["x"], "cohort-2.csv");
    mocks.pickFiles.mockResolvedValue([file]); mocks.partition.mockReturnValue({ accepted: [file], refused: [] }); mocks.uploadFilesToWorkspace.mockResolvedValue(["cohort-2.csv"]);
    dbMocks.researchDatabaseStatus.mockResolvedValue({ available: false });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "接入数据" }));
    expect(await screen.findByText(/已接入 1 份资料/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base", "project-a", expect.any(Function));
    expect(mocks.addAgendaMaterials).not.toHaveBeenCalled();
  });
  it("offers the database beside the files where the deployment has the connector, and imports with no study named", async () => {
    const user = userEvent.setup(); dbMocks.researchDatabaseStatus.mockResolvedValue({ available: true });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(await screen.findByRole("button", { name: "接入数据" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "上传文件" })).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "从数据库导入" }));
    await waitFor(() => expect(dbMocks.listResearchDatabases).toHaveBeenCalled());
  });
  it("opens an observed goal's own native conversation inside the page", async () => {
    const user = userEvent.setup(); mocks.listWebAgentRuns.mockResolvedValue([{ id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running" }]);
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "长期研究" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("project-a:goal-session");
    // Closing it goes back to the goal's results, and the conversation is withdrawn.
    await user.click(screen.getByRole("button", { name: "收起对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
    expect(screen.getByRole("tab", { name: "结果", selected: true })).toBeInTheDocument();
  });
  it("loads subsequent project episode pages so older running work is not hidden", async () => {
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string, cursor?: string) => {
      if (agendaId) return { items: agendaId === "a" ? [running] : [finished], nextCursor: null };
      return cursor ? { items: [running], nextCursor: null } : { items: [finished], nextCursor: "next-page" };
    });
    renderPage(); await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active"));
    expect(mocks.listEpisodes).toHaveBeenCalledWith("project-a", undefined, "next-page");
  });
  it("says a goal round's real outcome in the queue, as the goal's own record does", async () => {
    const user = userEvent.setup();
    const round = (id: string, session: string, status: string) => ({ id, sessionId: session, automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: `goal-${session}`, runId: null }, startedAt: "2026-10-28T01:00:00Z", finishedAt: "2026-10-28T01:30:00Z", status, title: `目标 ${status}` });
    mocks.listWebAgentRuns.mockResolvedValue([round("r-failed", "s-failed", "failed"), round("r-stopped", "s-stopped", "canceled"), round("r-done", "s-done", "succeeded")]);
    renderPage(); await screen.findByText("cohort.csv");
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
    mocks.listAgendas.mockResolvedValue({ items: [], nextCursor: null, available: true });
    mocks.listEpisodes.mockResolvedValue({ items: [], nextCursor: null });
    let release: (runs: unknown[]) => void = () => {};
    mocks.listWebAgentRuns.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const first = renderPage();
    await waitFor(() => expect(mocks.listAgendas).toHaveBeenCalled());
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
      renderPage(); await screen.findByText("cohort.csv");
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
      expect(within(screen.getByLabelText("研究队列")).getByText(/2 项进行中/)).toBeInTheDocument();
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
      renderPage(); await screen.findByText("cohort.csv");
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
  describe("reading again while the page is open", () => {
    const settle = () => act(async () => { await Promise.resolve(); });
    // Asynchronously, so each read settles before the next tick (a read still out holds the next one off).
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const forget = () => { for (const fn of [mocks.listAgendas, mocks.listEpisodes, mocks.getResearchState, mocks.listWebAgentRuns]) fn.mockClear(); };
    const projectPages = () => mocks.listEpisodes.mock.calls.filter(call => call[1] === undefined);
    const ofStudy = (id: string) => mocks.listEpisodes.mock.calls.filter(call => call[1] === id);

    it("reads each thing at its own rate: the tasks and the displayed study every 5 s while an execution runs, the run list every 20 s", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      renderPage(); await screen.findByText("cohort.csv"); await settle(); forget();
      await advance(5_000);
      expect(mocks.listAgendas).toHaveBeenCalledTimes(1); expect(projectPages()).toHaveLength(1);
      expect(mocks.getResearchState).toHaveBeenCalledTimes(1); expect(ofStudy("a")).toHaveLength(1);
      expect(mocks.listWebAgentRuns).not.toHaveBeenCalled();
      await advance(15_000);
      expect(mocks.listAgendas).toHaveBeenCalledTimes(4);
      expect(mocks.getResearchState).toHaveBeenCalledTimes(4);
      expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(1);
      await advance(20_000);
      expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(2);
    });
    it("REVIEWFIX 11 a read that fails while the page is open leaves what was shown where it was, with the error said above it; a first read that fails shows the error alone", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      renderPage(); await screen.findByText("cohort.csv"); await settle();
      mocks.listAgendas.mockRejectedValue(new Error("网络中断"));
      await advance(5_000);
      expect(await screen.findByText(/研究暂时无法载入/)).toBeInTheDocument();
      expect(screen.getByLabelText("研究队列")).toBeInTheDocument();
      expect(screen.getByTestId("observatory")).toHaveTextContent("run-active");
      expect(screen.getByText("cohort.csv")).toBeInTheDocument();
      // the next read that succeeds takes the error away
      mocks.listAgendas.mockResolvedValue({ items: [task("b", "已完成研究"), task("a", "进行中研究")], nextCursor: null, available: true });
      await advance(5_000);
      expect(screen.queryByText(/研究暂时无法载入/)).not.toBeInTheDocument();
      expect(screen.getByTestId("observatory")).toHaveTextContent("run-active");
    });
    it("REVIEWFIX 11 the first read failing shows the error and nothing of the research", async () => {
      mocks.listAgendas.mockReset().mockRejectedValue(new Error("网络中断"));
      renderPage();
      expect(await screen.findByText(/研究暂时无法载入/)).toBeInTheDocument();
      expect(screen.queryByLabelText("研究队列")).not.toBeInTheDocument();
      expect(screen.queryByTestId("observatory")).not.toBeInTheDocument();
    });
    it("reads quietly, every 30 s, when no execution is on its way — the run list still at 20 s", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [] : [finished], nextCursor: null }));
      renderPage(); await screen.findByLabelText("研究队列"); await settle(); forget();
      await advance(29_000);
      expect(mocks.listAgendas).not.toHaveBeenCalled(); expect(mocks.getResearchState).not.toHaveBeenCalled();
      expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(1);
      await advance(1_000);
      expect(mocks.listAgendas).toHaveBeenCalledTimes(1); expect(mocks.getResearchState).toHaveBeenCalledTimes(1);
    });
    it("reads only the newest page of executions, and keeps the older ones the first read gave", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string, cursor?: string) => {
        if (agendaId) return { items: agendaId === "a" ? [running] : [finished], nextCursor: null };
        return cursor ? { items: [running], nextCursor: null } : { items: [finished], nextCursor: "next-page" };
      });
      renderPage(); await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active")); await settle();
      expect(mocks.listEpisodes).toHaveBeenCalledWith("project-a", undefined, "next-page");
      forget();
      await advance(10_000);
      expect(projectPages().length).toBeGreaterThan(0);
      expect(mocks.listEpisodes.mock.calls.filter(call => call[2] !== undefined)).toEqual([]);
      // The execution that only the older page held is still running on the screen.
      expect(within(screen.getByLabelText("研究队列")).getByText(/1 项进行中/)).toBeInTheDocument();
    });
    it("does not read a study that is not displayed: a shown goal is read through the run list alone", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.listWebAgentRuns.mockResolvedValue([{ id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running", title: "长期目标" }]);
      renderPage(); await screen.findByText("cohort.csv");
      await user.click(within(await screen.findByLabelText("研究队列")).getByRole("button", { name: "长期目标" }));
      expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument(); await settle(); forget();
      await advance(40_000);
      expect(mocks.getResearchState).not.toHaveBeenCalled(); expect(ofStudy("a")).toEqual([]); expect(ofStudy("b")).toEqual([]);
      expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(2);
      // The tasks are still read: the queue shows them beside the goal.
      expect(mocks.listAgendas).toHaveBeenCalled();
    });
  });
  it("selects project sources through the task association API", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "从知识库选择" }));
    await user.click(screen.getByRole("button", { name: "选择示例资料" }));
    await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith("a", { sourceIds: ["src_new"] }));
  });
  it("explains where an uploaded file went if association fails", async () => {
    const file = new File(["data"], "cohort.csv", { type: "text/csv" });
    mocks.pickFiles.mockResolvedValue([file]); mocks.uploadFilesToWorkspace.mockResolvedValue(["cohort.csv"]); mocks.sha256Hex.mockResolvedValue("abc");
    mocks.addAgendaMaterials.mockRejectedValue(new Error("association failed"));
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "上传资料" }));
    expect(await screen.findByText(/资料已上传到知识库，但没能加入本研究/)).toBeInTheDocument();
  });
  it("does not upload to a different project when the selection changes while the picker is open", async () => {
    const user = userEvent.setup(); let finish: (files: File[]) => void = () => {};
    mocks.pickFiles.mockReturnValue(new Promise<File[]>(resolve => { finish = resolve; }));
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "上传资料" }));
    identity.projectId = "project-b";
    await act(async () => { finish([new File(["x"], "data.csv")]); });
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
    expect(mocks.addAgendaMaterials).not.toHaveBeenCalled();
  });
  it("refuses more than ten uploads before sending bytes", async () => {
    const user = userEvent.setup();
    mocks.pickFiles.mockResolvedValue(Array.from({ length: 11 }, (_, i) => new File(["x"], `file${i}.csv`)));
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "上传资料" }));
    expect(await screen.findByText(/每次最多添加 10 份资料/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
  });
  it("rejects a mixed invalid selection before uploading any file", async () => {
    const user = userEvent.setup();
    mocks.pickFiles.mockResolvedValue([new File(["ok"], "a.csv"), new File(["bad"], "b.csv")]);
    mocks.partition.mockReturnValue({ accepted: [new File(["ok"], "a.csv")], refused: [{ name: "b.csv", reason: "不支持" }] });
    renderPage(); await screen.findByText("cohort.csv"); await user.click(screen.getByRole("button", { name: "上传资料" }));
    expect(await screen.findByText(/b.csv（不支持）/)).toBeInTheDocument();
    expect(mocks.uploadFilesToWorkspace).not.toHaveBeenCalled();
  });
  it("disables execution after a previously loaded history fails to refresh", async () => {
    const user = userEvent.setup(); let fail = false;
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => {
      if (agendaId === "b" && fail) throw new Error("offline");
      return { items: agendaId === "a" ? [running] : agendaId === "b" ? [finished] : [finished, running], nextCursor: null };
    });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeEnabled());
    fail = true;
    await user.click(screen.getByRole("button", { name: "从知识库选择" }));
    await user.click(screen.getByRole("button", { name: "选择示例资料" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeDisabled());
    expect(screen.getAllByRole("link", { name: "paper.docx" }).length).toBeGreaterThan(0);
  });
  it("reuses a request id after an uncertain run-now failure", async () => {
    const user = userEvent.setup(); mocks.runAgendaNow.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ episode: { ...running, payload: { ...running.payload, agendaId: "b" } } });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "立即运行" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "立即运行" }));
    await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(2));
    expect(mocks.runAgendaNow.mock.calls[0]).toEqual(mocks.runAgendaNow.mock.calls[1]);
  });
  it("keeps an acknowledged new execution visible while the list is stale", async () => {
    const user = userEvent.setup(); mocks.runAgendaNow.mockResolvedValue({ episode: { ...running, payload: { ...running.payload, agendaId: "b" } } });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "立即运行" }));
    expect(await screen.findByRole("button", { name: "停止本次" })).toBeInTheDocument();
  });
  it("stops the selected live execution rather than the entire agenda", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "停止本次" }));
    await waitFor(() => expect(mocks.cancelEpisode).toHaveBeenCalledWith("a", "active", expect.any(String)));
  });
  it("refreshes materials after mutation even when an earlier read is pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const user = userEvent.setup(); let hold = false, calls = 0, release: (value: unknown) => void = () => {};
    const stale = new Promise(resolve => { release = resolve; });
    mocks.getResearchState.mockImplementation(async (id: string) => {
      if (!hold) return states(id);
      calls += 1; return calls === 1 ? stale : { ...states(id), materials: [{ sourceId: "src_new", name: "new.csv", state: "ready", addedAt: "2026-10-28" }] };
    });
    renderPage(); await screen.findByText("cohort.csv");
    hold = true; await act(async () => { vi.advanceTimersByTime(10_000); });
    await user.click(screen.getByRole("button", { name: "从知识库选择" }));
    await user.click(screen.getByRole("button", { name: "选择示例资料" }));
    expect(await screen.findByText("new.csv")).toBeInTheDocument();
    await act(async () => { release(states("a")); });
    expect(screen.getByText("new.csv")).toBeInTheDocument(); expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument();
  });
  it("does not let stale polling overwrite an acknowledged cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const user = userEvent.setup(); let delay = false;
    let releaseProject: (value: unknown) => void = () => {}; let releaseHistory: (value: unknown) => void = () => {};
    const projectPage = new Promise(resolve => { releaseProject = resolve; });
    const historyPage = new Promise(resolve => { releaseHistory = resolve; });
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => {
      if (delay) return agendaId ? historyPage : projectPage;
      return { items: agendaId === "a" ? [running] : [finished, running], nextCursor: null };
    });
    mocks.cancelEpisode.mockResolvedValue({ ...running, revision: 2, payload: { ...running.payload, status: "canceled" } });
    renderPage(); await screen.findByText("cohort.csv");
    delay = true; await act(async () => { vi.advanceTimersByTime(10_000); });
    await user.click(screen.getByRole("button", { name: "停止本次" }));
    await waitFor(() => expect(mocks.cancelEpisode).toHaveBeenCalledOnce());
    await act(async () => { releaseProject({ items: [finished, running], nextCursor: null }); releaseHistory({ items: [running], nextCursor: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "停止本次" })).not.toBeInTheDocument();
  });
  it("sends a direction to the selected research without replacing the current execution", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "调整研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "优先分析年龄差异");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.steerWebAgentRun).toHaveBeenCalledWith("run-active", "优先分析年龄差异"));
    expect(mocks.followUpAgenda).not.toHaveBeenCalled();
    expect(await screen.findByText(/方向已送达/)).toBeInTheDocument();
  });
  it("does not silently schedule a follow-up if live direction delivery fails", async () => {
    mocks.steerWebAgentRun.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "调整研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "检查结果");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    expect(await screen.findByText(/没能确认方向是否送达/)).toBeInTheDocument();
    expect(mocks.followUpAgenda).not.toHaveBeenCalled();
  });
  it("schedules a follow-up for a completed research task", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-done"));
    await user.click(screen.getByRole("button", { name: "调整研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "补充分析");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith("b", expect.objectContaining({ note: "补充分析", episodeId: "done" })));
    expect(mocks.steerWebAgentRun).not.toHaveBeenCalled();
  });
  it("schedules a follow-up instead of steering a bounded execution", async () => {
    const bounded = { ...running, payload: { ...running.payload, interactive: false } };
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [bounded] : agendaId === "b" ? [finished] : [finished, bounded], nextCursor: null }));
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "调整研究方向" }));
    expect(screen.getByText(/不会改变当前执行/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "补充分析");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith("a", expect.objectContaining({ note: "补充分析", episodeId: "active" })));
    expect(mocks.steerWebAgentRun).not.toHaveBeenCalled();
  });
  it("remounts the database dialog when the selected task changes", async () => {
    const user = userEvent.setup(); sessionStorage.setItem("evimed.research-db.snapshot.project-a.a", "request-for-a"); sessionStorage.setItem("evimed.research-db.snapshot.project-a.b", "request-for-b");
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(await screen.findByRole("button", { name: "从数据库导入" }));
    expect(await screen.findByText(/上次导入还没有确认结果/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("研究队列")).getByText("已完成研究"));
    await waitFor(() => expect(dbMocks.listResearchDatabases).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "重新开始导入" }));
    expect(sessionStorage.getItem("evimed.research-db.snapshot.project-a.b")).toBeNull();
    expect(sessionStorage.getItem("evimed.research-db.snapshot.project-a.a")).toBe("request-for-a");
  });
  it("does not report an empty history when the history request fails", async () => {
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => { if (agendaId) throw new Error("offline"); return { items: [running], nextCursor: null }; });
    renderPage(); expect(await screen.findByText("执行记录暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("还没有执行过")).not.toBeInTheDocument();
  });
  it("stands by in the observatory when the project has no research, with the two ways to begin in the scene", async () => {
    const user = userEvent.setup();
    mocks.listAgendas.mockResolvedValue({ items: [], nextCursor: null, available: true });
    mocks.listEpisodes.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    expect(await screen.findByTestId("observatory")).toHaveTextContent("no-run");
    expect(screen.queryByLabelText("研究队列")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "发起研究" })).toBeEnabled());
    expect(screen.getAllByRole("button", { name: "发起研究" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "接入数据" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "发起研究" }));
    expect(screen.getByLabelText("研究目标")).toBeInTheDocument();
  });
  describe("the page under the observatory (module workspace audit, D2)", () => {
    it("keeps the observatory first and puts the rest of the research under three views, results first", async () => {
      renderPage(); await screen.findByText("cohort.csv");
      const tabs = screen.getAllByRole("tab").map(tab => tab.textContent);
      expect(tabs).toEqual(["结果", "记录", "对话"]);
      expect(screen.getByRole("tab", { name: "结果", selected: true })).toBeInTheDocument();
      // The observatory comes before the views in the page, and the queue before both.
      const order = [screen.getByLabelText("研究队列"), screen.getByTestId("observatory"), screen.getByRole("tablist")];
      for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // 结果 holds the findings, the files and the data; the history is not under it.
      expect(screen.getByLabelText("研究成果")).toBeInTheDocument();
      expect(screen.getByLabelText("研究资料")).toBeInTheDocument();
      expect(screen.queryByLabelText("执行记录")).not.toBeInTheDocument();
    });
    it("lists the executions under 记录, and joins the controls of the research on show to the observatory's row", async () => {
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      const row = screen.getByLabelText("当前研究");
      for (const name of ["停止本次", "调整研究方向", "打开对话"]) expect(within(row).getByRole("button", { name })).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "记录" }));
      expect(screen.getByLabelText("执行记录")).toBeInTheDocument();
      expect(screen.queryByLabelText("研究资料")).not.toBeInTheDocument();
    });
    it("opens the task's own conversation in the 对话 view by one path, the button or the tab, and never navigates away", async () => {
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
      await user.click(within(screen.getByLabelText("当前研究")).getByRole("button", { name: "打开对话" }));
      expect(screen.getByRole("tab", { name: "对话", selected: true })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("native-pane")).toHaveTextContent("project-a:session-active"));
      expect(screen.queryByRole("button", { name: "打开任务对话" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "打开所属对话" })).not.toBeInTheDocument();
      // Back to the results: the conversation is withdrawn.
      await user.click(screen.getByRole("tab", { name: "结果" }));
      expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
    });
    it("takes the word on whether the run is going from the open stream, and from the poll where there is none", async () => {
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      // The poll says the execution is running.
      expect(screen.getByRole("button", { name: "停止本次" })).toBeInTheDocument();
      const stateOf = () => within(screen.getByLabelText("研究队列")).getByRole("button", { name: "进行中研究" }).querySelector(".rq-state")!;
      expect(stateOf()).toHaveTextContent("进行中");
      // The stream says it has ended before the poll caught up: the button, the queue and the strip agree with the stream.
      await user.click(screen.getByRole("button", { name: "stream: ended" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "停止本次" })).not.toBeInTheDocument();
      expect(stateOf()).toHaveTextContent("已完成");
      expect(document.querySelector("[data-activity]")).toBeNull();
      // It also reads the records again at once rather than waiting for its next poll.
      const reads = mocks.listAgendas.mock.calls.length;
      await user.click(screen.getByRole("button", { name: "stream: closed" }));
      // The stream is gone: the poll's account stands again.
      await waitFor(() => expect(screen.getByRole("button", { name: "停止本次" })).toBeInTheDocument());
      expect(reads).toBeGreaterThan(1);
    });
    it("shows the activity strip in the page's band while a run is going, and not otherwise", async () => {
      renderPage(); await screen.findByText("cohort.csv");
      const strip = document.querySelector<HTMLElement>("[data-page-chrome] [data-activity='strip']");
      expect(strip).not.toBeNull();
      expect(strip).toHaveTextContent("正在运行“进行中研究”");
    });
    it("says before the wall that a bounded execution holds the project's conversation, and lets the researcher end it from the note", async () => {
      const bounded = { ...running, payload: { ...running.payload, interactive: false } };
      mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [bounded] : agendaId === "b" ? [finished] : [finished, bounded], nextCursor: null }));
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      expect(await screen.findByText("运行期间，这个项目的对话会暂停，结束后可继续")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "停止并继续对话" }));
      await waitFor(() => expect(mocks.cancelEpisode).toHaveBeenCalledWith("a", "active", expect.any(String)));
    });
    it("points to the task that holds the conversation when another research is the one on show", async () => {
      const bounded = { ...running, payload: { ...running.payload, interactive: false } };
      mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [bounded] : agendaId === "b" ? [finished] : [finished, bounded], nextCursor: null }));
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
      await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-done"));
      expect(screen.getByRole("link", { name: "查看正在运行的任务" })).toHaveAttribute("href", "/app/autopilot/a");
    });
    it("says nothing of a held conversation for an execution in the researcher's own runtime", async () => {
      renderPage(); await screen.findByText("cohort.csv");
      expect(screen.queryByText("运行期间，这个项目的对话会暂停，结束后可继续")).not.toBeInTheDocument();
    });
  });
  describe("one verb for one act, and what pressing it does (audit D11)", () => {
    it("says 立即运行, never 立即执行, makes no scheduled study here, and declares what each button does", async () => {
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      expect(screen.queryByRole("button", { name: /立即执行|新建定时/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "停止本次" })).toHaveAttribute("data-action-kind", "set");
      expect(screen.getByRole("button", { name: "接入数据" })).toHaveAttribute("data-action-kind", "set");
      await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeEnabled());
      expect(screen.getByRole("button", { name: "立即运行" })).toHaveAttribute("data-action-kind", "start");
      await user.click(screen.getByRole("button", { name: "发起研究" }));
      expect(screen.getByRole("button", { name: "开始研究" })).toHaveAttribute("data-action-kind", "start");
    });
    it("says when a run is started that the project's conversation pauses while it runs", async () => {
      useToastStore.setState({ toasts: [] });
      mocks.runAgendaNow.mockResolvedValue({ episode: { ...running, payload: { ...running.payload, agendaId: "b" } } });
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      await user.click(within(screen.getByLabelText("研究队列")).getByRole("button", { name: "已完成研究" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "立即运行" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "立即运行" }));
      await waitFor(() => expect(useToastStore.getState().toasts.map(item => item.message)).toContain("已开始运行。运行期间，这个项目的对话会暂停，结束后可继续"));
    });
    it("keeps 调整研究方向 as a form of its own: it sends a structured direction, and 提交方向 starts the run it asks for", async () => {
      const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
      expect(screen.getByRole("button", { name: "调整研究方向" })).toHaveAttribute("data-action-kind", "set");
      await user.click(screen.getByRole("button", { name: "调整研究方向" }));
      expect(screen.getByRole("button", { name: "提交方向" })).toHaveAttribute("data-action-kind", "start");
    });
  });
  describe("a run ends while the page is open (audit D14)", () => {
    it("announces the end once, as a toast", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      useToastStore.setState({ toasts: [] });
      renderPage(); await screen.findByText("cohort.csv");
      expect(useToastStore.getState().toasts).toHaveLength(0);
      const ended = { ...running, payload: { ...running.payload, status: "merged" } };
      mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [ended] : agendaId === "b" ? [finished] : [finished, ended], nextCursor: null }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(useToastStore.getState().toasts.map(item => item.message)).toEqual(["“进行中研究”已完成"]);
    });
  });
});
