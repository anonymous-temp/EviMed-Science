import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgendaSchedule } from "@/lib/autopilotClient";
import { useProjectStore } from "@/lib/projects";
import { TaskForm } from "./TaskForm";

const mocks = vi.hoisted(() => ({ createAgenda: vi.fn(), startAgenda: vi.fn(), updateAgenda: vi.fn(), getAgenda: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
// Numbers nobody would type by hand: a form that read its own copy would show 100 / 500 / 3000 and a floor of 0.01.
vi.mock("@evimed/domain", async (original) => ({
  ...(await original<object>()),
  AGENDA_DEFAULT_BUDGETS: { maxEpisodeCny: 7, dailyBudgetCny: 11, weeklyBudgetCny: 13 },
  AGENDA_MIN_EPISODE_BUDGET_CNY: 3.5,
}));

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

describe("the task form's summary line", () => {
  const task = (schedule: AgendaSchedule) => ({ id: "agenda-one", projectId: "project-one", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
    title: "心衰追踪", prompt: "跟进心衰", topics: ["x"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 11, weeklyBudgetCny: 40, maxEpisodeCny: 7,
    scheduleHour: 7, timeZone: "Asia/Shanghai", schedule, enabled: false, status: "paused", pauseReason: null, outcomes: [] } });

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
    expect(screen.getByText("2031年2月3日 · 仅一次 08:30 · 中国标准时间")).toBeInTheDocument();
    await userEvent.click(screen.getByText("高级设置"));
    const zone = screen.getByLabelText("时区");
    await userEvent.clear(zone); await userEvent.type(zone, "Mars/Base");
    expect(screen.getByText("2031年2月3日 · 仅一次 08:30")).toBeInTheDocument();
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
