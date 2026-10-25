import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AgendaSchedule } from "@/lib/autopilotClient";
import { useProjectStore } from "@/lib/projects";
import { TaskForm } from "./TaskForm";
import { RECOMMENDATIONS } from "./taskPresentation";

const mocks = vi.hoisted(() => ({ createAgenda: vi.fn(), startAgenda: vi.fn(), updateAgenda: vi.fn(), getAgenda: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
// Numbers nobody would type by hand: a form that read its own copy would show 100 / 500 / 3000 and a floor of 0.01.
vi.mock("@evimed/domain", async (original) => ({
  ...(await original<object>()),
  AGENDA_DEFAULT_BUDGETS: { maxEpisodeCny: 7, dailyBudgetCny: 11, weeklyBudgetCny: 13 },
  AGENDA_MIN_EPISODE_BUDGET_CNY: 3.5,
}));

const sources = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sourceList", () => ({ listAllSources: sources }));
const noop = () => {};
const open = async (showBudgets = true) => {
  render(<TaskForm projectId="project-one" showBudgets={showBudgets} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
  await userEvent.click(screen.getByText("高级设置"));
};

describe("the task form's budgets", () => {
  // The platform sets the budget (the owner's rulings of 2026-09-19 and 2026-09-20): the form asks for it only when a budget is why a task stopped.
  it("does not ask for a budget, and sends the domain's defaults for the task it creates", async () => {
    const created = vi.fn();
    mocks.createAgenda.mockImplementation(async (input: unknown) => { created(input); return { id: "agenda-new", revision: 1, projectId: "project-one", payload: {} }; });
    mocks.startAgenda.mockResolvedValue({ id: "agenda-new", revision: 2, projectId: "project-one", payload: {} });
    await open(false);
    expect(screen.queryByLabelText(/上限/)).not.toBeInTheDocument();
    expect(screen.queryByText(/单次上限最低|¥/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("任务指令"), "跟进心衰");
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(expect.objectContaining({ maxEpisodeCny: 7, dailyBudgetCny: 11, weeklyBudgetCny: 13 })));
  });

  it("offers the domain's default caps in 灵豆, not a copy of its own, when a budget is the reason", async () => {
    await open();
    expect(screen.getByLabelText("单次上限（灵豆）")).toHaveValue(7);
    expect(screen.getByLabelText("每日上限（灵豆）")).toHaveValue(11);
    expect(screen.getByLabelText("每周上限（灵豆）")).toHaveValue(13);
    expect(document.body).not.toHaveTextContent("¥");
  });

  it("opens the fold for them, so the one thing asked is in front of the reader", () => {
    render(<TaskForm projectId="project-one" showBudgets onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect(screen.getByLabelText("单次上限（灵豆）")).toBeVisible();
  });

  it("says the minimum where the cap is edited, in 灵豆, and refuses a cap below it before anything is sent", async () => {
    await open();
    expect(screen.getByText(/单次上限最低 3\.5 灵豆：模型每次调用要先预留约 1 灵豆/)).toBeInTheDocument();
    expect(screen.getByLabelText("单次上限（灵豆）")).toHaveAttribute("min", "3.5");
    await userEvent.type(screen.getByLabelText("任务指令"), "跟进心衰");
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeEnabled();
    const field = screen.getByLabelText("单次上限（灵豆）");
    await userEvent.clear(field);
    await userEvent.type(field, "3.4");
    expect(screen.getByRole("alert")).toHaveTextContent("单次上限不能低于 3.5 灵豆");
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "3.5");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeEnabled();
  });

  it("shows the cap of a task saved below the minimum, because that is what stops it from being saved", () => {
    const agenda = { id: "agenda-old", projectId: "project-one", revision: 3, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
      title: "旧任务", prompt: "跟进", topics: ["x"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 8, weeklyBudgetCny: 40, maxEpisodeCny: 1,
      scheduleHour: 7, timeZone: "Asia/Shanghai", schedule: { kind: "daily" as const, timeZone: "Asia/Shanghai", time: "07:00" },
      enabled: false, status: "paused", pauseReason: null, outcomes: [] } };
    render(<TaskForm projectId="project-one" agenda={agenda} showBudgets onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    const dialog = screen.getByRole("button", { name: "保存修改" }).closest("form")!;
    expect(within(dialog).getByLabelText("单次上限（灵豆）")).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("单次上限不能低于 3.5 灵豆");
    expect(within(dialog).getByRole("button", { name: "保存修改" })).toBeDisabled();
  });
});

const task = (schedule: AgendaSchedule) => ({ id: "agenda-one", projectId: "project-one", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
    title: "心衰追踪", prompt: "跟进心衰", topics: ["x"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 11, weeklyBudgetCny: 40, maxEpisodeCny: 7,
    scheduleHour: 7, timeZone: "Asia/Shanghai", schedule, enabled: false, status: "paused", pauseReason: null, outcomes: [] } });

describe("the task form's summary line", () => {


  it("says above the buttons where the task runs, how often and in which zone, and follows the fields: no cost is said", async () => {
    useProjectStore.setState({ projects: [{ id: "project-one", name: "我的研究" } as never] });
    try {
      render(<TaskForm projectId="project-one" agenda={task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" })} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      const summary = screen.getByText("在“我的研究”运行 · 每天 07:00 · 中国标准时间");
      expect(summary.compareDocumentPosition(screen.getByRole("button", { name: "保存修改" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("重复"), "weekly");
      expect(screen.getByText(/^在“我的研究”运行 · 每周一 07:00 · /)).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText("周一"));
      expect(screen.getByText(/^在“我的研究”运行 · 请选择星期 · /)).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText("周一")); await userEvent.click(screen.getByLabelText("周五"));
      expect(screen.getByText("在“我的研究”运行 · 每周一、周五 07:00 · 中国标准时间")).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/单次最多|¥/);
    } finally { useProjectStore.setState({ projects: [] }); }
  });

  it("says a one-time task by its day, and leaves out a zone it cannot name", async () => {
    render(<TaskForm projectId="project-one" agenda={task({ kind: "once", timeZone: "Asia/Shanghai", time: "08:30", date: "2031-02-03" })} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect(screen.getByText("在当前项目运行 · 2031年2月3日 · 仅一次 08:30 · 中国标准时间")).toBeInTheDocument();
    await userEvent.click(screen.getByText("高级设置"));
    const zone = screen.getByLabelText("时区");
    await userEvent.clear(zone); await userEvent.type(zone, "Mars/Base");
    expect(screen.getByText("在当前项目运行 · 2031年2月3日 · 仅一次 08:30")).toBeInTheDocument();
  });

  it("names the project the way every picker does, so a namesake is told apart", () => {
    const year = new Date().getFullYear();
    useProjectStore.setState({ projects: [
      { id: "project-one", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() } as never,
      { id: "project-two", name: "波立维", createdAt: new Date(year, 9, 1, 9, 30).toISOString() } as never,
    ] });
    try {
      render(<TaskForm projectId="project-two" agenda={task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" })} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      expect(screen.getByText(/^在“波立维 · 10月1日”运行 · 每天 07:00 · /)).toBeInTheDocument();
    } finally { useProjectStore.setState({ projects: [] }); }
  });
});

describe("the task types a new task holds", () => {
  const save = async (instruction: string) => {
    const created = vi.fn();
    mocks.createAgenda.mockImplementation(async (input: unknown) => { created(input); return { id: "agenda-new", revision: 1, projectId: "project-one", payload: {} }; });
    mocks.startAgenda.mockResolvedValue({ id: "agenda-new", revision: 2, projectId: "project-one", payload: {} });
    await userEvent.type(screen.getByLabelText("任务指令"), instruction);
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    return created.mock.calls[0][0] as { taskTypes: string[] };
  };

  it("holds what a task made in a conversation holds, so the instruction decides what kind of work it is", async () => {
    render(<TaskForm projectId="project-one" onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect((await save("每个工作日早上给我一份昨天的行业要闻")).taskTypes).toEqual(["routine", "literature-sentinel", "evidence-update", "data-prospecting"]);
  });

  it("starts a general template as an ordinary job and a research template as the research it was written for", async () => {
    expect(RECOMMENDATIONS[0].taskTypes).toEqual(["routine"]);
    render(<TaskForm projectId="project-one" recommendation={RECOMMENDATIONS[0]} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect(screen.getByLabelText("任务指令")).toHaveValue(RECOMMENDATIONS[0].prompt);
    await userEvent.click(screen.getByText("高级设置"));
    expect(screen.getByLabelText("日常任务")).toBeChecked();
    expect(screen.getByLabelText("文献追踪")).not.toBeChecked();
    mocks.createAgenda.mockClear();
    mocks.createAgenda.mockImplementation(async (input: unknown) => ({ id: "agenda-new", revision: 1, projectId: "project-one", payload: {}, input }));
    mocks.startAgenda.mockResolvedValue({ id: "agenda-new", revision: 2, projectId: "project-one", payload: {} });
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(mocks.createAgenda).toHaveBeenCalledWith(expect.objectContaining({ taskTypes: ["routine"] })));
  });
});

describe("schedule preview and ordinary materials", () => {
  it("previews the exact next date using the schedule's zone and explains result delivery", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    try {
      render(<TaskForm projectId="project-one" agenda={{ ...task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:30" }), payload: { ...task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:30" }).payload, scheduleChangedAt: "2026-10-01T02:00:00Z" } }} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      expect(screen.getByText(/预计开始：2026年10月2日周五 07:30 · 中国标准时间/)).toBeInTheDocument();
      expect(screen.getByText(/这是开始执行的时间，完成后结果保留在任务对话中/)).toBeInTheDocument();
      expect(screen.getByLabelText("时区")).toBeVisible();
      fireEvent.change(screen.getByLabelText("时间"), { target: { value: "15:30" } });
      expect(screen.getByText(/预计开始：2026年10月1日周四 15:30/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it("previews the saved paused schedule's latest missed occurrence, but changed calendars start now", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    try {
      const saved = task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:30" });
      render(<TaskForm projectId="project-one" agenda={{ ...saved, payload: { ...saved.payload, scheduleChangedAt: "2026-09-01T00:00:00Z", lastScheduledOccurrence: { key: "2026-09-30T07:30@Asia/Shanghai", scheduledAt: "2026-09-29T23:30:00Z", localDate: "2026-09-30" } } }} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      expect(screen.getByText(/启用后补跑最近一次：2026年10月1日周四 07:30/)).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("时间"), { target: { value: "08:30" } });
      expect(screen.getByText(/启用后预计开始：2026年10月2日周五 08:30/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])("does not replay an occurrence already recorded by the saved watermark (legacy=%s)", legacy => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    try {
      const saved = task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" });
      render(<TaskForm projectId="project-one" agenda={{ ...saved, payload: { ...saved.payload, schedule: legacy ? undefined : saved.payload.schedule, lastScheduledDate: "2026-10-01", ...(legacy ? {} : { lastScheduledOccurrence: { key: "2026-10-01T07:00@Asia/Shanghai", scheduledAt: "2026-09-30T23:00:00Z", localDate: "2026-10-01" } }) } }} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      expect(screen.getByText(/启用后预计开始：2026年10月2日周五 07:00/)).toBeInTheDocument();
      expect(screen.queryByText(/启用后补跑最近一次/)).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it("does not promise another execution when editing an unchanged completed once-only task", () => {
    const completed = task({ kind: "once", timeZone: "Asia/Shanghai", time: "07:30", date: "2026-01-01" });
    render(<TaskForm projectId="project-one" agenda={{ ...completed, payload: { ...completed.payload, enabled: true, scheduleState: "completed" } }} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect(screen.getByText("任务已完成，保留原计划不会再次执行。")).toBeInTheDocument();
    expect(screen.queryByText(/预计开始/)).not.toBeInTheDocument();
  });
  it("saves chosen project materials with the task before activation", async () => {
    sources.mockResolvedValue([{ id: "src_" + "a".repeat(32), payload: { paths: ["knowledge-base/weekly.xlsx"] } }]);
    mocks.createAgenda.mockResolvedValue({ id: "with-materials", revision: 1, payload: {} });
    mocks.startAgenda.mockResolvedValue({ id: "with-materials", revision: 2, payload: {} });
    render(<MemoryRouter><TaskForm projectId="project-one" onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText("任务指令"), "每周汇总这份表格");
    await userEvent.click(screen.getByRole("button", { name: "从知识库选择" }));
    await userEvent.click(await screen.findByLabelText("weekly.xlsx"));
    await userEvent.click(screen.getByRole("button", { name: "添加到这个任务" }));
    expect(mocks.createAgenda).not.toHaveBeenCalledWith(expect.objectContaining({ sourceIds: expect.anything() }));
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(mocks.createAgenda).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "project-one", sourceIds: ["src_" + "a".repeat(32)] })));
    expect(mocks.startAgenda).toHaveBeenLastCalledWith("with-materials", 1);
  });
});
