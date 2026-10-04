import { act, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { AutopilotPage } from "./AutopilotPage";

const identity = vi.hoisted(() => ({ projectId: "project-one" }));
const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), getAgenda: vi.fn(), createAgenda: vi.fn(), updateAgenda: vi.fn(), archiveAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), runAgendaNow: vi.fn(), followUpAgenda: vi.fn(), listEpisodes: vi.fn(), getDigest: vi.fn(), markDigestOpened: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId }));
const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, createdAt: "2026-09-28T00:00:00Z", payload: {
  title: "心衰证据追踪", prompt: "完整跟进心衰与肾病\n保留原始指令", topics: ["heart failure"], taskTypes: ["evidence-update"],
  dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 7, timeZone: "Asia/Shanghai",
  schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "07:30", weekdays: [1, 5] }, nextRunAt: "2026-10-02T23:30:00Z", scheduleState: "scheduled",
  enabled: true, status: "active", pauseReason: null, outcomes: [],
} };
const episode = { id: "ep-one", projectId: "project-one", revision: 1, payload: { agendaId: agenda.id, taskType: "evidence-update", date: "2026-09-29", status: "merged", runId: "run-one", sessionId: "ses-one", digestId: "digest-one", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T01:00:00Z", trigger: "scheduled", instruction: "Previous frozen instruction", claims: [{ id: "c1", statement: "已有研究结果" }] } };
const digest = { id: "digest-one", projectId: "project-one", payload: { episodeIds: ["ep-one"] } };
function Location() { const loc = useLocation(); return <p data-testid="location">{loc.pathname}{loc.search}</p>; }
function render(path = "/app/autopilot?task=agenda-one") { return renderView(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/app/autopilot" element={<><AutopilotPage /><Location /></>} />
  <Route path="/app/chat/:sessionId" element={<Location />} /><Route path="/app/runs" element={<Location />} />
</Routes></MemoryRouter>); }
const detail = async () => screen.findByRole("region", { name: "任务详情" });

describe("scheduled tasks", () => {
  beforeEach(() => {
    vi.useRealTimers(); identity.projectId = "project-one"; Object.values(mocks).forEach(fn => fn.mockReset());
    mocks.listAgendas.mockResolvedValue({ items: [agenda] }); mocks.getAgenda.mockResolvedValue(agenda);
    mocks.listEpisodes.mockResolvedValue({ items: [episode] }); mocks.createAgenda.mockResolvedValue(agenda);
    mocks.startAgenda.mockResolvedValue(agenda); mocks.stopAgenda.mockResolvedValue(agenda); mocks.updateAgenda.mockResolvedValue(agenda);
    mocks.archiveAgenda.mockResolvedValue(agenda); mocks.runAgendaNow.mockResolvedValue({ episode: { ...episode, id: "manual-one", payload: { ...episode.payload, status: "queued" } } });
    mocks.followUpAgenda.mockResolvedValue({ episode: { ...episode, id: "follow-one", payload: { ...episode.payload, status: "queued", trigger: "follow-up", followUpNote: "补充肾病亚组" } } });
    mocks.getDigest.mockResolvedValue(digest); mocks.markDigestOpened.mockResolvedValue(digest);
  });
  it("shows the server schedule and full instruction in a selectable split view", async () => {
    render(); const panel = await detail();
    expect(screen.getByRole("heading", { name: "定时任务", level: 1 })).toBeInTheDocument();
    expect(panel).toHaveTextContent("完整跟进心衰与肾病"); expect(panel).toHaveTextContent("保留原始指令");
    expect(panel).toHaveTextContent("Asia/Shanghai"); expect(panel).toHaveTextContent("10月3日");
    expect(panel).toHaveTextContent("已有研究结果"); expect(mocks.markDigestOpened).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole("button", { name: "返回任务列表" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/autopilot$/);
  });
  it("says what a model-chosen run was set to look into, and nothing for one the date rotation chose", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [
      { ...episode, payload: { ...episode.payload, selection: { source: "model", taskType: "evidence-update", focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核" } } },
      { ...episode, id: "ep-two", payload: { ...episode.payload, createdAt: "2026-09-30T00:00:00Z", selection: { source: "date-rotation", taskType: "evidence-update", fallbackReason: "usage_budget_exceeded" } } },
    ] });
    render(); const panel = await detail();
    expect(panel).toHaveTextContent("本次关注：核对尚未复核的结论");
    expect(panel).not.toHaveTextContent("usage_budget_exceeded");
    expect(within(panel).getAllByText(/本次关注/)).toHaveLength(1);
  });
  it("tells the researcher why a task stopped itself and which task type was paused, and that a restart resumes it", async () => {
    const stopped = { ...agenda, payload: { ...agenda.payload, enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null,
      pauseReason: "问题已经回答", plannerStop: { kind: "needs_input", reason: "请补充原始数据表", at: "2026-10-01T00:00:00Z" },
      taskTypeState: { "evidence-update": { consecutiveFailures: 2, pausedAt: "2026-10-01T00:00:00Z" }, "literature-sentinel": { consecutiveFailures: 1 } } } };
    mocks.listAgendas.mockResolvedValue({ items: [stopped] }); mocks.getAgenda.mockResolvedValue(stopped);
    render(); const panel = await detail();
    expect(panel).toHaveTextContent("需要你补充：请补充原始数据表");
    expect(panel).toHaveTextContent("证据更新连续未能运行，已暂停");
    expect(panel).not.toHaveTextContent("文献追踪连续未能运行");
    expect(within(panel).getByRole("button", { name: "启用任务" })).toBeEnabled();
  });
  it("searches tasks and keeps selection in the URL", async () => {
    render("/app/autopilot"); await screen.findByText("心衰证据追踪");
    await userEvent.type(screen.getByRole("searchbox"), "missing"); expect(screen.queryByRole("button", { name: "心衰证据追踪" })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox")); await userEvent.click(screen.getByRole("button", { name: "心衰证据追踪" }));
    expect(screen.getByTestId("location")).toHaveTextContent("task=agenda-one");
  });
  it("offers a clear return to the workbench and a compact editor with optional settings collapsed", async () => {
    render();
    expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute("href", "/app/chat");
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = screen.getByRole("dialog", { name: "新建任务" });
    expect(dialog).not.toHaveClass("h-full");
    const advanced = within(dialog).getByText("高级设置").closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    await userEvent.click(within(dialog).getByText("高级设置"));
    expect(advanced).toHaveAttribute("open");
    expect(within(dialog).getByLabelText("时区")).toBeVisible();
    expect(within(dialog).getByLabelText("单次上限 ¥")).toBeVisible();
  });
  it("creates and enables a weekly task without altering its raw prompt", async () => {
    render(); await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const form = await screen.findByRole("dialog", { name: "新建任务" });
    const raw = "  肾病与心衰\n保留换行与全部指令  ";
    fireEvent.change(within(form).getByLabelText("任务指令"), { target: { value: raw } });
    await userEvent.selectOptions(within(form).getByLabelText("重复"), "weekly");
    fireEvent.change(within(form).getByLabelText("时间"), { target: { value: "09:45" } });
    await userEvent.click(within(form).getByText("高级设置"));
    fireEvent.change(within(form).getByLabelText("时区"), { target: { value: "America/New_York" } });
    await userEvent.click(within(form).getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(mocks.createAgenda).toHaveBeenCalledWith(expect.objectContaining({ prompt: raw, schedule: { kind: "weekly", weekdays: [1], time: "09:45", timeZone: "America/New_York" } })));
    expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2);
  });
  it("keeps a successfully created task when enabling fails and retries only enabling", async () => {
    mocks.startAgenda.mockRejectedValueOnce(new Error("offline")); render();
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(await screen.findByLabelText("任务指令"), "保留这个任务");
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    expect(await screen.findByText(/任务已创建，启用未成功/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试启用" }));
    await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledTimes(2)); expect(mocks.createAgenda).toHaveBeenCalledTimes(1);
  });
  it("edits a one-time schedule and handles revision conflicts visibly", async () => {
    mocks.updateAgenda.mockRejectedValueOnce({ status: 409 }); render();
    await userEvent.click(within(await detail()).getByRole("button", { name: "编辑任务" }));
    const form = await screen.findByRole("dialog", { name: "编辑任务" });
    await userEvent.selectOptions(within(form).getByLabelText("重复"), "once");
    fireEvent.change(within(form).getByLabelText("日期"), { target: { value: "2026-12-01" } });
    await userEvent.click(within(form).getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(mocks.updateAgenda).toHaveBeenCalledWith(agenda.id, expect.objectContaining({ expectedRevision: 2, schedule: { kind: "once", date: "2026-12-01", time: "07:30", timeZone: "Asia/Shanghai" } })));
    expect(await screen.findByText(/任务已被更新/)).toBeInTheDocument(); expect(mocks.getAgenda).toHaveBeenCalledWith(agenda.id);
  });
  it("confirms pause cancellation and archive retention", async () => {
    render(); await userEvent.click(within(await detail()).getByRole("button", { name: "暂停任务" }));
    const pause = screen.getByRole("alertdialog"); expect(pause).toHaveTextContent("取消正在进行和排队中的研究");
    expect(mocks.stopAgenda).not.toHaveBeenCalled(); await userEvent.click(within(pause).getByRole("button", { name: "暂停任务" }));
    await waitFor(() => expect(mocks.stopAgenda).toHaveBeenCalledWith(agenda.id, 2));
    await userEvent.click(within(await detail()).getByRole("button", { name: "删除任务" }));
    const archive = screen.getByRole("alertdialog"); expect(archive).toHaveTextContent("保留历史研究结果");
    await userEvent.click(within(archive).getByRole("button", { name: "删除任务" }));
    await waitFor(() => expect(mocks.archiveAgenda).toHaveBeenCalledWith(agenda.id, 2));
  });
  it("never starts an existing paused task on read or on follow-up", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, enabled: false, status: "paused", scheduleState: "paused" } }] });
    render(); const panel = await detail(); expect(within(panel).getByRole("button", { name: "立即运行" })).toBeDisabled();
    expect(within(panel).getByLabelText("针对任务追问")).toBeDisabled(); expect(panel).toHaveTextContent("请先启用任务");
    expect(mocks.startAgenda).not.toHaveBeenCalled(); await userEvent.click(within(panel).getByRole("button", { name: "启用任务" }));
    await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2));
  });
  it("uses the same request id on retry and a new id for a deliberate new run", async () => {
    mocks.runAgendaNow.mockRejectedValueOnce(new Error("offline")); render(); const panel = await detail();
    await userEvent.click(within(panel).getByRole("button", { name: "立即运行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "立即运行" }));
    await userEvent.click(await screen.findByRole("button", { name: "重试操作" }));
    await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(2));
    expect(mocks.runAgendaNow.mock.calls[0]).toEqual(mocks.runAgendaNow.mock.calls[1]);
    await userEvent.click(within(panel).getByRole("button", { name: "立即运行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "立即运行" }));
    await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(3));
    expect(mocks.runAgendaNow.mock.calls[2][1]).not.toEqual(mocks.runAgendaNow.mock.calls[0][1]);
  });
  it("sends a real follow-up and immediately shows its queued episode", async () => {
    render(); const panel = await detail();
    await userEvent.type(within(panel).getByLabelText("针对任务追问"), "补充肾病亚组");
    await userEvent.click(within(panel).getByRole("button", { name: "发送追问" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith(agenda.id, expect.objectContaining({ note: "补充肾病亚组", requestId: expect.any(String) })));
    expect(await screen.findByText("排队中")).toBeInTheDocument(); expect(within(panel).getByLabelText("针对任务追问")).toHaveValue("");
  });
  it("retains findings and secured artifact links, tracks actual result opening", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, payload: { ...episode.payload, artifactRefs: [
      { projectId: "project-one", runId: "run-one", sessionId: "ses-one", path: "reports/result.csv" },
      { projectId: "other", runId: "run-one", sessionId: "ses-one", path: "private.csv" },
      { projectId: "project-one", runId: "run-one", sessionId: "ses-one", path: "../secret.csv" },
    ] } }] });
    render(); const panel = await detail();
    expect(within(panel).getByRole("link", { name: "result.csv" })).toHaveAttribute("href", "/app/runs/run-one/files/reports/result.csv");
    expect(screen.queryByRole("link", { name: "private.csv" })).not.toBeInTheDocument(); expect(screen.queryByRole("link", { name: "secret.csv" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("link", { name: "打开运行对话" }));
    expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one"); expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-one");
  });
  it("shows resource waits with previous results", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [episode, { ...episode, id: "wait", payload: { ...episode.payload, runId: null, sessionId: null, status: "queued", resourceDeferrals: { episode: { code: "credits_exhausted", status: "waiting" } } } }] });
    render(); expect(await screen.findByText("等待余额")).toBeInTheDocument(); expect(screen.getAllByText(/已有研究结果/).length).toBeGreaterThan(0);
  });
  // A simulated wallet refuses under its own code, and a run it holds back waits, and reads, exactly as one a real wallet holds back.
  it.each([
    ["credits_exhausted", "waiting", "等待余额"], ["simulated_credits_exhausted", "waiting", "等待余额"],
    ["credits_exhausted", "exhausted", "余额不足"], ["simulated_credits_exhausted", "exhausted", "余额不足"],
    ["runtime_busy", "waiting", "等待运行资源"], ["runtime_busy", "exhausted", "运行资源暂不可用"],
  ])("says a run held back by %s (%s) is 「%s」", async (code, status, label) => {
    mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, id: "held", payload: { ...episode.payload, runId: null, sessionId: null, status: "queued", resourceDeferrals: { episode: { code, status } } } }] });
    render(); expect(await screen.findByText(label)).toBeInTheDocument();
    for (const other of ["等待余额", "余额不足", "等待运行资源", "运行资源暂不可用"].filter(each => each !== label)) expect(screen.queryByText(other)).not.toBeInTheDocument();
  });
  it("fills a research recommendation with a prompt and weekly schedule", async () => {
    render("/app/autopilot"); await userEvent.click(await screen.findByRole("button", { name: "指南更新周报" }));
    expect((await screen.findByLabelText("任务指令") as HTMLTextAreaElement).value).toContain("指南"); expect(screen.getByLabelText("重复")).toHaveValue("weekly");
  });
  it("keeps legacy digest links and resolves cross-project conversations", async () => {
    mocks.getDigest.mockResolvedValue({ ...digest, projectId: "another-project" }); render("/app/autopilot?digest=digest-one");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/runs?run=run-one")); expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one");
  });
  it("offers retry on a list failure", async () => {
    mocks.listAgendas.mockRejectedValueOnce(new Error("offline")); render("/app/autopilot");
    expect(await screen.findByRole("alert")).toHaveTextContent("定时任务暂不可用"); await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
  });
  it("refreshes queued work without a page reload", async () => {
    mocks.listEpisodes.mockResolvedValueOnce({ items: [{ ...episode, payload: { ...episode.payload, status: "queued" } }] }).mockResolvedValueOnce({ items: [{ ...episode, payload: { ...episode.payload, status: "queued" } }] });
    vi.useFakeTimers(); render(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("排队中")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    vi.useRealTimers(); await waitFor(() => expect(mocks.listEpisodes.mock.calls.length).toBeGreaterThan(2));
  });
  it("allows deliberate runs after a one-time schedule completes", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, scheduleState: "completed", nextRunAt: null, schedule: { kind: "once", date: "2026-09-29", time: "07:30", timeZone: "Asia/Shanghai" } } }] });
    render(); await screen.findByText("完整跟进心衰与肾病", { exact: false });
    expect(within(await detail()).getByRole("button", { name: "立即运行" })).toBeEnabled();
    expect(within(await detail()).getByLabelText("针对任务追问")).toBeEnabled(); expect(mocks.startAgenda).not.toHaveBeenCalled();
  });
  it("retries a failed follow-up with the original note and request identity", async () => {
    mocks.followUpAgenda.mockRejectedValueOnce(new Error("offline")); render(); const panel = await detail();
    await userEvent.type(within(panel).getByLabelText("针对任务追问"), "补充肾病亚组");
    await userEvent.click(within(panel).getByRole("button", { name: "发送追问" }));
    const retryButton = await screen.findByRole("button", { name: "重试操作" });
    expect(within(panel).getByLabelText("针对任务追问")).toHaveValue("补充肾病亚组");
    await userEvent.click(retryButton); await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledTimes(2));
    expect(mocks.followUpAgenda.mock.calls[0]).toEqual(mocks.followUpAgenda.mock.calls[1]);
  });
  it("ignores an old project's deferred digest redirect after switching projects", async () => {
    let resolveDigest!: (value: unknown) => void;
    mocks.getDigest.mockImplementationOnce(() => new Promise(resolve => { resolveDigest = resolve; })).mockResolvedValue({ ...digest, payload: { episodeIds: [] } });
    render("/app/autopilot?digest=digest-one"); await screen.findByRole("button", { name: "心衰证据追踪" });
    mocks.listEpisodes.mockResolvedValue({ items: [] });
    await act(async () => { identity.projectId = "project-two"; useProjectStore.setState({ currentId: "project-two" }); });
    await act(async () => { resolveDigest(digest); });
    expect(mocks.markDigestOpened).not.toHaveBeenCalled(); expect(screen.getByTestId("location")).not.toHaveTextContent("/app/chat/");
  });
  it("ignores late task creation after the project is switched", async () => {
    let finish!: (value: unknown) => void;
    mocks.createAgenda.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render();
    await userEvent.click(screen.getByRole("button", { name: "新建任务" })); await userEvent.type(await screen.findByLabelText("任务指令"), "创建后切换项目");
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await act(async () => { identity.projectId = "project-three"; useProjectStore.setState({ currentId: "project-three" }); });
    await act(async () => { finish(agenda); });
    expect(mocks.startAgenda).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reads an older task's own history outside the project-wide newest 100", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ ...episode, id: `other-${index}`, payload: { ...episode.payload, agendaId: "other-task" } }));
    mocks.listEpisodes.mockImplementation((_project: string, id?: string) => Promise.resolve({ items: id === agenda.id ? [episode] : others }));
    render(); expect(await screen.findByText(/已有研究结果/)).toBeInTheDocument();
    expect(mocks.listEpisodes).toHaveBeenCalledWith("project-one", agenda.id);
  });
  it("does not replace a newly selected history with a late previous task response", async () => {
    let finish!: (value: unknown) => void;
    mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务" } }] });
    mocks.listEpisodes.mockImplementation((_project: string, id?: string) => id === agenda.id ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ items: [] }));
    render(); await userEvent.click(await screen.findByRole("button", { name: "第二个任务" }));
    await act(async () => { finish({ items: [episode] }); });
    expect(within(await detail()).getByRole("heading", { name: "第二个任务" })).toBeInTheDocument(); expect(screen.queryByText(/已有研究结果/)).not.toBeInTheDocument();
  });
  it("keeps the editor open through create and enable despite close or Escape", async () => {
    let finish!: (value: unknown) => void;
    mocks.createAgenda.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render();
    await userEvent.click(screen.getByRole("button", { name: "新建任务" })); await userEvent.type(await screen.findByLabelText("任务指令"), "继续完成创建并启用");
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" })); await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "新建任务" })).toBeInTheDocument();
    await act(async () => { finish(agenda); });
    await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2)); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not let a previous task's completed pause replace the selected history", async () => {
    let finish!: (value: unknown) => void;
    const second = { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务", enabled: false, status: "paused", scheduleState: "paused" } };
    mocks.listAgendas.mockResolvedValue({ items: [agenda, second] });
    mocks.listEpisodes.mockImplementation((_project: string, id?: string) => Promise.resolve({ items: id === "second" ? [{ ...episode, id: "second-episode", payload: { ...episode.payload, agendaId: "second", claims: [{ id: "second-claim", statement: "第二个任务的结果" }] } }] : [episode] }));
    mocks.stopAgenda.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render();
    await userEvent.click(within(await detail()).getByRole("button", { name: "暂停任务" })); await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "暂停任务" }));
    await userEvent.click(screen.getByRole("button", { name: "第二个任务" })); expect(await screen.findByText(/第二个任务的结果/)).toBeInTheDocument();
    const count = mocks.listEpisodes.mock.calls.filter(call => call[1] === agenda.id).length;
    await act(async () => { finish({ ...agenda, payload: { ...agenda.payload, enabled: false, status: "paused" } }); });
    expect(screen.getByText(/第二个任务的结果/)).toBeInTheDocument(); expect(mocks.listEpisodes.mock.calls.filter(call => call[1] === agenda.id)).toHaveLength(count);
  });
  it("refreshes pending history even when it is outside the project's latest 100", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, scheduleState: "completed", nextRunAt: null } }] });
    let historyReads = 0;
    mocks.listEpisodes.mockImplementation((_project: string, id?: string) => Promise.resolve({ items: id === agenda.id
      ? [{ ...episode, payload: { ...episode.payload, status: ++historyReads === 1 ? "queued" : "merged" } }]
      : Array.from({ length: 100 }, (_, index) => ({ ...episode, id: `other-${index}`, payload: { ...episode.payload, agendaId: "other" } })) }));
    vi.useFakeTimers(); render(); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(screen.getByText("排队中")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); vi.useRealTimers();
    expect(historyReads).toBeGreaterThan(1); expect(screen.queryByText("排队中")).not.toBeInTheDocument(); expect(screen.getByText("研究结果")).toBeInTheDocument();
  });

});
