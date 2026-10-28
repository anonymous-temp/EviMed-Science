import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { useTaskPane } from "@/lib/taskPane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveResearchPage } from "./ActiveResearchPage";

const identity = vi.hoisted(() => ({ projectId: "project-a" }));
const skillMocks = vi.hoisted(() => ({ listPlatformSkills: vi.fn() }));
vi.mock("@/lib/skillLibraryClient", () => skillMocks);
const dbMocks = vi.hoisted(() => ({ listResearchDatabases: vi.fn(), saveResearchDatabase: vi.fn(), snapshotResearchDatabase: vi.fn(), removeResearchDatabase: vi.fn() }));
vi.mock("@/lib/researchDatabaseClient", () => dbMocks);
const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), listWebAgentRuns: vi.fn(), steerWebAgentRun: vi.fn(), listEpisodes: vi.fn(), getResearchState: vi.fn(), addAgendaMaterials: vi.fn(), removeAgendaMaterial: vi.fn(), cancelEpisode: vi.fn(), followUpAgenda: vi.fn(), runAgendaNow: vi.fn(), pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), sha256Hex: vi.fn(), partition: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId, listWebAgentRuns: mocks.listWebAgentRuns, steerWebAgentRun: mocks.steerWebAgentRun }));
vi.mock("@/lib/backend", async (original) => ({ ...(await original<object>()), pickFiles: mocks.pickFiles, uploadFilesToWorkspace: mocks.uploadFilesToWorkspace }));
vi.mock("@/lib/fileDigest", () => ({ sha256Hex: mocks.sha256Hex }));
vi.mock("@/lib/knowledgeBaseFiles", async (original) => ({ ...(await original<object>()), partitionKnowledgeBaseFiles: mocks.partition }));
vi.mock("@/components/autopilot/ResearchObservatory", () => ({ ResearchObservatory: ({ runId }: { runId: string | null }) => <p data-testid="observatory">{runId ?? "no-run"}</p> }));
vi.mock("@/components/autopilot/TaskDialog", () => ({ TaskDialog: () => <p>任务表单</p> }));
vi.mock("@/components/autopilot/MaterialPicker", () => ({ MaterialPicker: ({ onChoose }: { onChoose: (ids: string[]) => void }) => <button onClick={() => onChoose(["src_new"])}>选择示例资料</button> }));
const task = (id: string, title: string) => ({ id, projectId: "project-a", revision: 1, payload: { title, topics: [], taskTypes: ["routine"], enabled: true, status: "active", materials: [] } });
const episode = (id: string, agendaId: string, status: string, path?: string) => ({ id, projectId: "project-a", revision: 1, payload: { agendaId, taskType: "routine", status, runId: `run-${id}`, sessionId: `session-${id}`, createdAt: "2026-10-28T01:00:00Z", artifactRefs: path ? [{ projectId: "project-a", runId: `run-${id}`, sessionId: `session-${id}`, path }] : [] } });
const running = { ...episode("active", "a", "running"), payload: { ...episode("active", "a", "running").payload, interactive: true } };
const finished = episode("done", "b", "merged", "output/paper.docx");
const states = (agendaId: string) => ({ agendaId, materials: agendaId === "a" ? [{ sourceId: "src_data", name: "cohort.csv", state: "ready", addedAt: "2026-10-28" }] : [], found: [], unresolved: [] });
function PaneProbe() { const pane = useTaskPane(); const location = useLocation(); return <><p data-testid="native-pane">{pane ? `${pane.projectId}:${pane.sessionId}` : "none"}</p><p data-testid="intent">{JSON.stringify(location.state)}</p><button onClick={() => pane?.onSessionAcknowledged?.("stale", "wrong-session")}>stale ack</button><button onClick={() => pane?.onSessionAcknowledged?.(location.state?.runtimeUiIntent?.requestId, "actual-session")}>ack</button></>; }
const renderPage = (state: unknown = null) => render(<MemoryRouter initialEntries={[{ pathname: "/app/active-research", state }]}><ActiveResearchPage /><PaneProbe /></MemoryRouter>);

describe("active research workspace", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    identity.projectId = "project-a"; sessionStorage.clear(); skillMocks.listPlatformSkills.mockReset().mockResolvedValue({ items: [{ id: "loopx:loopx" }] }); Object.values(mocks).forEach(fn => fn.mockReset()); Object.values(dbMocks).forEach(fn => fn.mockReset()); dbMocks.listResearchDatabases.mockResolvedValue({ items: [] });
    mocks.listWebAgentRuns.mockResolvedValue([]);
    mocks.listAgendas.mockResolvedValue({ items: [task("b", "已完成研究"), task("a", "进行中研究")], nextCursor: null, available: true });
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [running] : agendaId === "b" ? [finished] : [finished, running], nextCursor: null }));
    mocks.getResearchState.mockImplementation(async (id: string) => states(id));
    mocks.addAgendaMaterials.mockResolvedValue({}); mocks.removeAgendaMaterial.mockResolvedValue({}); mocks.cancelEpisode.mockResolvedValue({ ...running, payload: { ...running.payload, status: "canceled" } }); mocks.followUpAgenda.mockResolvedValue({ episode: null }); mocks.partition.mockImplementation((files: File[]) => ({ accepted: files, refused: [] }));
  });
  it("selects an active execution first and keeps project data and output scoped", async () => {
    const user = userEvent.setup(); renderPage();
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active"));
    expect(await screen.findByText("cohort.csv")).toHaveAttribute("href", "/app/files/src_data");
    expect(within(screen.getByLabelText("研究任务列表")).getByText("执行中 · 1")).toBeInTheDocument();
    await user.click(within(screen.getByLabelText("研究任务列表")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-done"));
    expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "paper.docx" })).toHaveAttribute("href", "/app/runs/run-done/files/output/paper.docx");
  });
  it("shows observed long-goal continuations without attributing the agenda materials to them", async () => {
    const user = userEvent.setup(); mocks.listWebAgentRuns.mockResolvedValue([{ id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running" }]);
    renderPage(); await screen.findByText("cohort.csv");
    const area = await screen.findByLabelText("长期目标续跑记录");
    expect(within(area).getByRole("link", { name: "打开所属对话" })).toHaveAttribute("href", "/app/chat/goal-session?project=project-a");
    await user.click(within(area).getByRole("button", { name: /查看续跑/ }));
    expect(screen.getByTestId("observatory")).toHaveTextContent("goal-run");
    expect(screen.queryByText("cohort.csv")).not.toBeInTheDocument();
    expect(screen.getByText(/目标当前状态可能不同/)).toBeInTheDocument();
  });
  it("does not offer to start long research when the deployment does not advertise it", async () => {
    skillMocks.listPlatformSkills.mockResolvedValue({ items: [] }); renderPage();
    expect(await screen.findByText(/当前环境未启用长期研究/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增长期研究" })).toBeDisabled();
  });
  it("does not replay an unacknowledged create restored from browser history", async () => {
    renderPage({ runtimeUiIntent: { kind: "create", projectId: "project-a", requestId: "old-request", sessionId: "old-session", draft: "/loopx " } });
    expect(await screen.findByText(/创建结果尚不明确/)).toBeInTheDocument();
    expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
    await waitFor(() => expect(screen.getByTestId("intent")).not.toHaveTextContent("runtimeUiIntent"));
  });
  it("opens a new native long-research draft inside the same page", async () => {
    const user = userEvent.setup(); renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "新增长期研究" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "新增长期研究" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent(/^project-a:/);
    expect(screen.getByTestId("intent")).toHaveTextContent('"kind":"create"');
    expect(screen.getByTestId("intent")).toHaveTextContent('/loopx');
    expect(screen.getByRole("region", { name: "原生研究对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增长期研究" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "stale ack" }));
    expect(screen.getByTestId("intent")).toHaveTextContent('"kind":"create"');
    await user.click(screen.getByRole("button", { name: "ack" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("project-a:actual-session");
    expect(screen.getByTestId("intent")).not.toHaveTextContent("runtimeUiIntent");
    expect(screen.getByRole("button", { name: "新增长期研究" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "收起对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("none");
  });
  it("opens an observed goal's own native conversation inside the page", async () => {
    const user = userEvent.setup(); mocks.listWebAgentRuns.mockResolvedValue([{ id: "goal-run", sessionId: "goal-session", automated: true, effectiveRouteReason: "loopx-continuation", goal: { id: "goal", runId: null }, startedAt: "2026-10-28T01:00:00Z", status: "running" }]);
    renderPage(); const area = await screen.findByLabelText("长期目标续跑记录");
    await user.click(within(area).getByRole("button", { name: /查看续跑/ }));
    await user.click(screen.getByRole("button", { name: "在本页打开对话" }));
    expect(screen.getByTestId("native-pane")).toHaveTextContent("project-a:goal-session");
  });
  it("loads subsequent project episode pages so older running work is not hidden", async () => {
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string, cursor?: string) => {
      if (agendaId) return { items: agendaId === "a" ? [running] : [finished], nextCursor: null };
      return cursor ? { items: [running], nextCursor: null } : { items: [finished], nextCursor: "next-page" };
    });
    renderPage(); await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-active"));
    expect(mocks.listEpisodes).toHaveBeenCalledWith("project-a", undefined, "next-page");
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
    expect(await screen.findByText(/资料已上传到知识库，但未能关联本研究/)).toBeInTheDocument();
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
    await user.click(within(screen.getByLabelText("研究任务列表")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即执行" })).toBeEnabled());
    fail = true;
    await user.click(screen.getByRole("button", { name: "从知识库选择" }));
    await user.click(screen.getByRole("button", { name: "选择示例资料" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即执行" })).toBeDisabled());
    expect(screen.getByRole("link", { name: "paper.docx" })).toBeInTheDocument();
  });
  it("reuses a request id after an uncertain run-now failure", async () => {
    const user = userEvent.setup(); mocks.runAgendaNow.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ episode: { ...running, payload: { ...running.payload, agendaId: "b" } } });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究任务列表")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即执行" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "立即执行" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "立即执行" }));
    await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(2));
    expect(mocks.runAgendaNow.mock.calls[0]).toEqual(mocks.runAgendaNow.mock.calls[1]);
  });
  it("keeps an acknowledged new execution visible while the list is stale", async () => {
    const user = userEvent.setup(); mocks.runAgendaNow.mockResolvedValue({ episode: { ...running, payload: { ...running.payload, agendaId: "b" } } });
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究任务列表")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "立即执行" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "立即执行" }));
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
    await waitFor(() => expect(screen.getByRole("button", { name: "立即执行" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "停止本次" })).not.toBeInTheDocument();
  });
  it("sends a direction to the selected research without replacing the current execution", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "提出研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "优先分析年龄差异");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.steerWebAgentRun).toHaveBeenCalledWith("run-active", "优先分析年龄差异"));
    expect(mocks.followUpAgenda).not.toHaveBeenCalled();
    expect(await screen.findByText(/方向已送入当前执行/)).toBeInTheDocument();
  });
  it("does not silently schedule a follow-up if live direction delivery fails", async () => {
    mocks.steerWebAgentRun.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "提出研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "检查结果");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    expect(await screen.findByText(/方向提交结果未确认/)).toBeInTheDocument();
    expect(mocks.followUpAgenda).not.toHaveBeenCalled();
  });
  it("schedules a follow-up for a completed research task", async () => {
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(within(screen.getByLabelText("研究任务列表")).getByRole("button", { name: "已完成研究" }));
    await waitFor(() => expect(screen.getByTestId("observatory")).toHaveTextContent("run-done"));
    await user.click(screen.getByRole("button", { name: "提出研究方向" }));
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "补充分析");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith("b", expect.objectContaining({ note: "补充分析", episodeId: "done" })));
    expect(mocks.steerWebAgentRun).not.toHaveBeenCalled();
  });
  it("schedules a follow-up instead of steering a bounded execution", async () => {
    const bounded = { ...running, payload: { ...running.payload, interactive: false } };
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => ({ items: agendaId === "a" ? [bounded] : agendaId === "b" ? [finished] : [finished, bounded], nextCursor: null }));
    const user = userEvent.setup(); renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "提出研究方向" }));
    expect(screen.getByText(/不会改变当前执行/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "希望研究如何调整" }), "补充分析");
    await user.click(screen.getByRole("button", { name: "提交方向" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith("a", expect.objectContaining({ note: "补充分析", episodeId: "active" })));
    expect(mocks.steerWebAgentRun).not.toHaveBeenCalled();
  });
  it("remounts the database dialog when the selected task changes", async () => {
    const user = userEvent.setup(); sessionStorage.setItem("evimed.research-db.snapshot.project-a.a", "request-for-a"); sessionStorage.setItem("evimed.research-db.snapshot.project-a.b", "request-for-b");
    renderPage(); await screen.findByText("cohort.csv");
    await user.click(screen.getByRole("button", { name: "连接数据库" }));
    expect(await screen.findByText(/上次快照结果待确认/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("研究任务列表")).getByText("已完成研究"));
    await waitFor(() => expect(dbMocks.listResearchDatabases).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "开始新的快照请求" }));
    expect(sessionStorage.getItem("evimed.research-db.snapshot.project-a.b")).toBeNull();
    expect(sessionStorage.getItem("evimed.research-db.snapshot.project-a.a")).toBe("request-for-a");
  });
  it("does not report an empty history when the history request fails", async () => {
    mocks.listEpisodes.mockImplementation(async (_project: string, agendaId?: string) => { if (agendaId) throw new Error("offline"); return { items: [running], nextCursor: null }; });
    renderPage(); expect(await screen.findByText("执行记录暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("尚无执行记录")).not.toBeInTheDocument();
  });
});
