import { act, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { AutopilotPage } from "./AutopilotPage";

const identity = vi.hoisted(() => ({ projectId: "project-one" }));
const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), getAgenda: vi.fn(), createAgenda: vi.fn(), updateAgenda: vi.fn(), archiveAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), runAgendaNow: vi.fn(), followUpAgenda: vi.fn(), listEpisodes: vi.fn(), getDigest: vi.fn(), markDigestOpened: vi.fn(),
  getResearchState: vi.fn(), addAgendaMaterials: vi.fn(), removeAgendaMaterial: vi.fn() }));
const files = vi.hoisted(() => ({ pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), sha256Hex: vi.fn(), listSources: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/backend", async (original) => ({ ...(await original<object>()), pickFiles: files.pickFiles, uploadFilesToWorkspace: files.uploadFilesToWorkspace }));
vi.mock("@/lib/fileDigest", () => ({ sha256Hex: files.sha256Hex }));
vi.mock("@/lib/sourceClient", async (original) => ({ ...(await original<object>()), listSources: files.listSources }));
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId }));
const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, createdAt: "2026-09-28T00:00:00Z", payload: {
  title: "心衰证据追踪", prompt: "完整跟进心衰与肾病\n保留原始指令", topics: ["heart failure"], taskTypes: ["evidence-update"],
  dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 7, timeZone: "Asia/Shanghai",
  schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "07:30", weekdays: [1, 5] }, nextRunAt: "2026-10-02T23:30:00Z", scheduleState: "scheduled",
  enabled: true, status: "active", pauseReason: null, outcomes: [],
} };
const episode = { id: "ep-one", projectId: "project-one", revision: 1, payload: { agendaId: agenda.id, taskType: "evidence-update", date: "2026-09-29", status: "merged", runId: "run-one", sessionId: "ses-one", digestId: "digest-one", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T01:00:00Z", trigger: "scheduled", instruction: "Previous frozen instruction", claims: [{ id: "c1", statement: "已有研究结果" }] } };
const digest = { id: "digest-one", projectId: "project-one", payload: { episodeIds: ["ep-one"] } };
/** The researcher's reading of the question, as the server projects it. */
const state = (extra: Record<string, unknown>) => ({ agendaId: "agenda-one", asOf: "2026-10-04T00:00:00Z", truncated: false, found: [], unresolved: [], materials: [], ...extra });
const planned = (kind: "answered" | "needs_input" | "paused_by_researcher", reason: string) => ({ ...agenda, payload: { ...agenda.payload, enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null,
  pauseReason: reason, plannerStop: { kind, reason, at: "2026-10-01T00:00:00Z" } } });
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
    Object.values(files).forEach(fn => fn.mockReset());
    mocks.getResearchState.mockResolvedValue(state({})); mocks.addAgendaMaterials.mockResolvedValue(agenda); mocks.removeAgendaMaterial.mockResolvedValue(agenda);
    files.listSources.mockResolvedValue({ items: [], nextCursor: null });
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
  // 2026-10-04: a task with ¥3 a day was refused in the account's words (近 24 小时额度已达上限 / 超出账户设定的用量上限) by an
  // account whose other research had cost ¥16, while the task had spent nothing. The task's own cap now has its own refusal.
  it("says a spent task budget is the task's own, that raising it is editing the task, and when it frees", async () => {
    mocks.runAgendaNow.mockRejectedValueOnce(new WebApiError("This task's own daily budget is spent.", { status: 402, code: "autopilot_daily_budget_spent", retryAfterSeconds: 19 * 3600 + 60 }));
    render(); const panel = await detail();
    await userEvent.click(within(panel).getByRole("button", { name: "立即运行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "立即运行" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("这个任务近 24 小时的花费已达它自己设定的“每日上限”");
    expect(alert).toHaveTextContent("账户里其他研究的花费不占用它");
    expect(alert).toHaveTextContent("在“编辑任务”里调高每日上限");
    expect(alert).toHaveTextContent(/请在约 19 小时 1 分后重试/);
    expect(alert).not.toHaveTextContent(/账户设定的用量上限|近 24 小时额度|额度开始释放/);
    expect(mocks.listEpisodes).toHaveBeenCalled(); // the page itself is still there, the refusal is not a failed load
  });
  it("says the weekly cap as the week's, for a follow-up as for a run", async () => {
    mocks.followUpAgenda.mockRejectedValueOnce(new WebApiError("This task's own weekly budget is spent.", { status: 402, code: "autopilot_weekly_budget_spent", retryAfterSeconds: 3 * 86400 }));
    render(); const panel = await detail();
    await userEvent.type(within(panel).getByLabelText("针对任务追问"), "补充肾病亚组");
    await userEvent.click(within(panel).getByRole("button", { name: "发送追问" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("这个任务近 7 天的花费已达它自己设定的“每周上限”");
    expect(alert).toHaveTextContent("在“编辑任务”里调高每周上限");
    expect(alert).toHaveTextContent(/请在约 3 天后重试/);
    expect(alert).not.toHaveTextContent(/账户设定的用量上限|近 7 天额度|额度开始释放/);
  });
  it("shows an episode the task's budget did not allow to start as that, not as an unexplained failure", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, payload: { ...episode.payload, status: "failed", digestId: null, runId: null, sessionId: null,
      error: { code: "autopilot_daily_budget_spent" } } }] });
    render(); const panel = await detail();
    expect(await within(panel).findByText("任务预算已用完")).toBeInTheDocument();
    expect(panel).toHaveTextContent("账户里其他研究的花费不占用它");
    expect(panel).not.toHaveTextContent("未完成");
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


  // ——— Question and material to observable research to supplement (plan §11.3 N11) ———
  it("shows what was found, what is unresolved and the material added, from the server's reading of the question", async () => {
    mocks.getResearchState.mockResolvedValue(state({
      found: [{ statement: "获益在亚组中一致", check: "stands", sources: 2, date: "2026-09-28" }, { statement: "死亡率下降 30%", check: "refuted", sources: 2, date: "2026-09-27" }, { statement: "已重算的结论", check: "reproduced", sources: 1, date: "2026-09-27" }],
      unresolved: [{ kind: "question", text: "亚组 B 的结果呢？" }, { kind: "not_run", date: "2026-09-29" }, { kind: "unchecked", text: "无酮症酸中毒增加" }, { kind: "check_unavailable", text: "住院减少" }, { kind: "weakened", text: "HFpEF 获益更大" }],
      materials: [{ sourceId: "src_a", name: "年龄分布.xlsx", addedAt: "2026-10-04T01:00:00Z", state: "ready" }, { sourceId: "src_b", name: "scan.pdf", addedAt: "2026-10-04T01:01:00Z", state: "reading" }] }));
    render(); const panel = await detail();
    const found = await within(panel).findByRole("region", { name: "已发现" });
    expect(found).toHaveTextContent("独立复核后仍成立：获益在亚组中一致"); expect(found).toHaveTextContent("已被推翻：死亡率下降 30%"); expect(found).toHaveTextContent("已复现：已重算的结论");
    const open = within(panel).getByRole("region", { name: "尚未解决" });
    expect(open).toHaveTextContent("你的问题：亚组 B 的结果呢？"); expect(open).toHaveTextContent("最近一次研究没有完成，结果未知。");
    expect(open).toHaveTextContent("尚未独立复核：无酮症酸中毒增加"); expect(open).toHaveTextContent("复核未能进行：住院减少"); expect(open).toHaveTextContent("被复核削弱：HFpEF 获益更大");
    const material = within(panel).getByRole("region", { name: "补充材料" });
    expect(material).toHaveTextContent("年龄分布.xlsx"); expect(material).toHaveTextContent("scan.pdf"); expect(material).toHaveTextContent("正在读取");
    expect(mocks.getResearchState).toHaveBeenCalledWith(agenda.id);
    expect(panel).not.toHaveTextContent("运行记录");
  });
  it("says in one line each why a conclusion was not re-checked, and that a stopped task's re-checks will not be made", async () => {
    mocks.getResearchState.mockResolvedValue(state({
      unresolved: [{ kind: "not_rechecked", reason: "agenda_stopped", text: "停止时尚未开始" }, { kind: "not_rechecked", reason: "agenda_stopped", text: "停止时已被取消" },
        { kind: "not_rechecked", reason: "verification_budget_unavailable", text: "单次上限太小" }, { kind: "not_rechecked", reason: "verification_cap", text: "超出条数" },
        { kind: "not_rechecked", reason: "agenda_paused", text: "暂停时没做" }, { kind: "unchecked", text: "还在排队" }] }));
    render(); const panel = await detail();
    const open = await within(panel).findByRole("region", { name: "尚未解决" });
    expect(open).toHaveTextContent("任务已停止，未做独立复核：停止时尚未开始"); expect(open).toHaveTextContent("任务已停止，未做独立复核：停止时已被取消");
    expect(open).toHaveTextContent("单次上限不够再支付一次复核，未安排独立复核：单次上限太小"); expect(open).toHaveTextContent("超出每次研究复核的条数，未安排独立复核：超出条数");
    expect(open).toHaveTextContent("任务已暂停，未做独立复核：暂停时没做");
    expect(open).toHaveTextContent("尚未独立复核：还在排队");
    expect(open).not.toHaveTextContent("尚未独立复核：停止时"); expect(open).not.toHaveTextContent("复核未能进行");
    for (const code of ["agenda_stopped", "verification_canceled_by_stop", "queued"]) expect(open).not.toHaveTextContent(code);
  });
  it("says why a task whose cap cannot fund a run was paused, in the sentence the edit form gives, and says nothing of it once the pause is lifted", async () => {
    const tooSmall = { ...agenda, payload: { ...agenda.payload, enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null, maxEpisodeCny: 0.5,
      pauseReason: "x", pauseCode: "autopilot_episode_budget_too_small" } };
    mocks.listAgendas.mockResolvedValue({ items: [tooSmall] }); mocks.getAgenda.mockResolvedValue(tooSmall);
    render(); const panel = await detail();
    expect(panel).toHaveTextContent(/已暂停：“单次上限”不能低于 ¥\d+\.\d{2}/); expect(panel).toHaveTextContent("在“编辑任务”里调高单次上限即可");
    expect(panel).not.toHaveTextContent("autopilot_episode_budget_too_small");
  });
  it("shows no findings section for a question that has found nothing, and still offers to add material", async () => {
    render(); const panel = await detail();
    await within(panel).findByRole("region", { name: "补充材料" });
    expect(within(panel).queryByRole("region", { name: "已发现" })).not.toBeInTheDocument(); expect(within(panel).queryByRole("region", { name: "尚未解决" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "添加材料" })).toBeEnabled();
  });
  it("offers a retry when the question's progress cannot be read, and the rest of the task still shows", async () => {
    mocks.getResearchState.mockRejectedValueOnce(new Error("offline")); render(); const panel = await detail();
    expect(await within(panel).findByText(/研究进展暂不可用/)).toBeInTheDocument(); expect(panel).toHaveTextContent("已有研究结果");
    await userEvent.click(within(panel).getByRole("button", { name: /重试/ }));
    expect(await within(panel).findByRole("region", { name: "补充材料" })).toBeInTheDocument();
  });
  it("adds an upload as material by the digest of what was uploaded: through the knowledge base, never a plan to approve", async () => {
    const file = new File(["age,n"], "年龄分布.csv", { type: "text/csv" });
    files.pickFiles.mockResolvedValue([file]); files.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/年龄分布.csv"]); files.sha256Hex.mockResolvedValue("a".repeat(64));
    mocks.addAgendaMaterials.mockResolvedValue({ ...agenda, revision: 3, payload: { ...agenda.payload, materials: [{ sourceId: "src_a", addedAt: "2026-10-04T01:00:00Z" }] } });
    render(); const panel = await detail();
    await userEvent.click(await within(panel).findByRole("button", { name: "添加材料" }));
    await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith(agenda.id, { sha256: ["a".repeat(64)] }));
    expect(files.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base");
    expect(mocks.startAgenda).not.toHaveBeenCalled(); expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.getResearchState.mock.calls.length).toBeGreaterThan(1));
  });
  it("says a format the knowledge base cannot read is not added, and adds nothing", async () => {
    files.pickFiles.mockResolvedValue([new File(["x"], "talk.mp4", { type: "video/mp4" })]);
    render(); const panel = await detail(); await userEvent.click(await within(panel).findByRole("button", { name: "添加材料" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("没有添加：talk.mp4");
    expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled(); expect(mocks.addAgendaMaterials).not.toHaveBeenCalled();
  });
  it("continues a task that stopped for material when the material is added, without choosing anything again", async () => {
    const waiting = planned("needs_input", "请补充受试者年龄分布");
    mocks.listAgendas.mockResolvedValue({ items: [waiting] }); mocks.getAgenda.mockResolvedValue(waiting);
    files.pickFiles.mockResolvedValue([new File(["age,n"], "年龄分布.csv", { type: "text/csv" })]); files.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/年龄分布.csv"]); files.sha256Hex.mockResolvedValue("b".repeat(64));
    mocks.addAgendaMaterials.mockResolvedValue({ ...waiting, revision: 3 }); mocks.startAgenda.mockResolvedValue({ ...agenda, revision: 4 });
    render(); const panel = await detail(); expect(panel).toHaveTextContent("需要你补充：请补充受试者年龄分布");
    await userEvent.click(await within(panel).findByRole("button", { name: "补充材料并继续" }));
    await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 3));
    expect(mocks.addAgendaMaterials.mock.invocationCallOrder[0]).toBeLessThan(mocks.startAgenda.mock.invocationCallOrder[0]);
  });
  it("adds documents already in the knowledge base, and offers only those not yet added", async () => {
    files.listSources.mockResolvedValue({ items: [
      { id: "src_a", projectId: "project-one", revision: 1, payload: { paths: ["knowledge-base/已添加.pdf"], status: "complete" } },
      { id: "src_b", projectId: "project-one", revision: 1, payload: { paths: ["knowledge-base/新的.pdf"], status: "complete" } }], nextCursor: null });
    const withMaterial = { ...agenda, payload: { ...agenda.payload, materials: [{ sourceId: "src_a", addedAt: "2026-10-04T01:00:00Z" }] } };
    mocks.listAgendas.mockResolvedValue({ items: [withMaterial] });
    render(); const panel = await detail(); await userEvent.click(await within(panel).findByRole("button", { name: "从知识库选择" }));
    const dialog = await screen.findByRole("dialog", { name: "从知识库添加资料" });
    expect(files.listSources).toHaveBeenCalledWith("project-one", expect.objectContaining({ state: "ready" }));
    expect(await within(dialog).findByText("新的.pdf")).toBeInTheDocument(); expect(within(dialog).queryByText("已添加.pdf")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "添加到这个任务" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox")); await userEvent.click(within(dialog).getByRole("button", { name: "添加到这个任务" }));
    await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith(agenda.id, { sourceIds: ["src_b"] }));
    expect(screen.queryByRole("dialog", { name: "从知识库添加资料" })).not.toBeInTheDocument();
  });
  it("takes a document out of the question's material without touching the knowledge base", async () => {
    mocks.getResearchState.mockResolvedValue(state({ materials: [{ sourceId: "src_a", name: "年龄分布.xlsx", addedAt: "2026-10-04T01:00:00Z", state: "ready" }] }));
    render(); const panel = await detail(); await userEvent.click(await within(panel).findByRole("button", { name: "移除 年龄分布.xlsx" }));
    await waitFor(() => expect(mocks.removeAgendaMaterial).toHaveBeenCalledWith(agenda.id, "src_a"));
    expect(mocks.startAgenda).not.toHaveBeenCalled();
  });
  it("lets the researcher reply to a task the planner paused, and the reply continues it", async () => {
    const answered = planned("answered", "问题已经回答");
    mocks.listAgendas.mockResolvedValue({ items: [answered] }); mocks.startAgenda.mockResolvedValue({ ...agenda, revision: 3 });
    render(); const panel = await detail(); const box = within(panel).getByLabelText("针对任务追问");
    expect(box).toBeEnabled(); expect(panel).toHaveTextContent("发送后任务将继续");
    await userEvent.type(box, "还想看看肾功能不全的亚组"); await userEvent.click(within(panel).getByRole("button", { name: "发送追问" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledWith(agenda.id, expect.objectContaining({ note: "还想看看肾功能不全的亚组" })));
    expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2);
    expect(mocks.startAgenda.mock.invocationCallOrder[0]).toBeLessThan(mocks.followUpAgenda.mock.invocationCallOrder[0]);
  });
  it("retries a reply from the restarted task, not from the stale one", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [planned("answered", "问题已经回答")] }); mocks.startAgenda.mockResolvedValue({ ...agenda, revision: 3 });
    mocks.followUpAgenda.mockRejectedValueOnce(new Error("offline"));
    render(); const panel = await detail(); await userEvent.type(within(panel).getByLabelText("针对任务追问"), "继续");
    await userEvent.click(within(panel).getByRole("button", { name: "发送追问" })); await userEvent.click(await screen.findByRole("button", { name: "重试操作" }));
    await waitFor(() => expect(mocks.followUpAgenda).toHaveBeenCalledTimes(2));
    expect(mocks.startAgenda).toHaveBeenCalledTimes(1);
    expect(mocks.followUpAgenda.mock.calls[0]).toEqual(mocks.followUpAgenda.mock.calls[1]);
  });
  it("does not offer a reply to a task the researcher stopped or one that nothing paused for a reason of its own", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, enabled: false, status: "stopped", scheduleState: "paused", plannerStop: null } }] });
    render(); const panel = await detail(); expect(within(panel).getByLabelText("针对任务追问")).toBeDisabled(); expect(panel).toHaveTextContent("请先启用任务");
  });
  it("answers a message that asked to hold the research by showing the pause, not an episode", async () => {
    const paused = planned("paused_by_researcher", "你要求先暂停，等你说继续再往下做");
    mocks.followUpAgenda.mockResolvedValue({ episode: null, job: null, stopped: { kind: "paused_by_researcher" } });
    mocks.listAgendas.mockResolvedValueOnce({ items: [agenda] }).mockResolvedValue({ items: [{ ...paused, payload: { ...paused.payload, messages: [{ requestId: "r1", note: "先停一下，我要核对数据来源", runEpisodeId: null, outcome: "paused", at: "2026-10-04T01:00:00Z" }] } }] });
    render(); const panel = await detail(); await userEvent.type(within(panel).getByLabelText("针对任务追问"), "先停一下，我要核对数据来源");
    await userEvent.click(within(panel).getByRole("button", { name: "发送追问" }));
    expect(await within(panel).findByText("已按你的要求暂停")).toBeInTheDocument();
    expect(panel).toHaveTextContent("已暂停：你要求先暂停，等你说继续再往下做"); expect(within(panel).getByText("先停一下，我要核对数据来源")).toBeInTheDocument();
    expect(within(panel).getByLabelText("针对任务追问")).toHaveValue(""); expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
  });
  it("tells the researcher in the box what it takes: a question, a correction or a pause", async () => {
    render(); const panel = await detail(); expect(within(panel).getByLabelText("针对任务追问")).toHaveAttribute("placeholder", "提问、更正上面的结论，或说明需要暂停…");
  });
});
