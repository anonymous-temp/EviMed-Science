import { render, screen, within } from "@testing-library/react";
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
const open = async () => {
  render(<TaskForm projectId="project-one" onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
  await userEvent.click(screen.getByText("高级设置"));
};

describe("the task form's budgets", () => {
  it("offers the domain's default caps, not a copy of its own", async () => {
    await open();
    expect(screen.getByLabelText("单次上限 ¥")).toHaveValue(7);
    expect(screen.getByLabelText("每日上限 ¥")).toHaveValue(11);
    expect(screen.getByLabelText("每周上限 ¥")).toHaveValue(13);
  });

  it("says the minimum where the cap is edited, and refuses a cap below it before anything is sent", async () => {
    await open();
    expect(screen.getByText(/单次上限最低 ¥3\.50/)).toBeInTheDocument();
    expect(screen.getByLabelText("单次上限 ¥")).toHaveAttribute("min", "3.5");
    await userEvent.type(screen.getByLabelText("任务指令"), "跟进心衰");
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeEnabled();
    const field = screen.getByLabelText("单次上限 ¥");
    await userEvent.clear(field);
    await userEvent.type(field, "3.4");
    expect(screen.getByRole("alert")).toHaveTextContent("单次上限不能低于 ¥3.50");
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "3.5");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeEnabled();
  });

  it("opens the settings of a task saved below the minimum, because that is what stops it from being saved", () => {
    const agenda = { id: "agenda-old", projectId: "project-one", revision: 3, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
      title: "旧任务", prompt: "跟进", topics: ["x"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 8, weeklyBudgetCny: 40, maxEpisodeCny: 1,
      scheduleHour: 7, timeZone: "Asia/Shanghai", schedule: { kind: "daily" as const, timeZone: "Asia/Shanghai", time: "07:00" },
      enabled: false, status: "paused", pauseReason: null, outcomes: [] } };
    render(<TaskForm projectId="project-one" agenda={agenda} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    const dialog = screen.getByRole("button", { name: "保存修改" }).closest("form")!;
    expect(within(dialog).getByLabelText("单次上限 ¥")).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("单次上限不能低于 ¥3.50");
    expect(within(dialog).getByRole("button", { name: "保存修改" })).toBeDisabled();
  });
});

describe("the task form's summary line", () => {
  const task = (schedule: AgendaSchedule) => ({ id: "agenda-one", projectId: "project-one", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
    title: "心衰追踪", prompt: "跟进心衰", topics: ["x"], taskTypes: ["literature-sentinel"], dailyBudgetCny: 11, weeklyBudgetCny: 40, maxEpisodeCny: 7,
    scheduleHour: 7, timeZone: "Asia/Shanghai", schedule, enabled: false, status: "paused", pauseReason: null, outcomes: [] } });

  it("says above the buttons where the task runs, how often, in which zone and at what cost, and follows the fields", async () => {
    useProjectStore.setState({ projects: [{ id: "project-one", name: "我的研究" } as never] });
    try {
      render(<TaskForm projectId="project-one" agenda={task({ kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" })} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
      const summary = screen.getByText("在“我的研究”运行 · 每天 07:00 · 中国标准时间 · 单次最多 ¥7");
      expect(summary.compareDocumentPosition(screen.getByRole("button", { name: "保存修改" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("重复"), "weekly");
      expect(screen.getByText(/^在“我的研究”运行 · 每周一 07:00 · /)).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText("周一"));
      expect(screen.getByText(/^在“我的研究”运行 · 请选择星期 · /)).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText("周一")); await userEvent.click(screen.getByLabelText("周五"));
      expect(screen.getByText(/^在“我的研究”运行 · 每周一、周五 07:00 · 中国标准时间 · /)).toBeInTheDocument();
      await userEvent.click(screen.getByText("高级设置"));
      const field = screen.getByLabelText("单次上限 ¥");
      await userEvent.clear(field); await userEvent.type(field, "9");
      expect(screen.getByText(/ · 单次最多 ¥9$/)).toBeInTheDocument();
    } finally { useProjectStore.setState({ projects: [] }); }
  });

  it("says a one-time task by its day, and leaves out a zone it cannot name", async () => {
    render(<TaskForm projectId="project-one" agenda={task({ kind: "once", timeZone: "Asia/Shanghai", time: "08:30", date: "2031-02-03" })} onSaved={noop} onRecorded={noop} onBusyChange={noop} onCancel={noop} />);
    expect(screen.getByText("2031年2月3日 · 仅一次 08:30 · 中国标准时间 · 单次最多 ¥7")).toBeInTheDocument();
    await userEvent.click(screen.getByText("高级设置"));
    const zone = screen.getByLabelText("时区");
    await userEvent.clear(zone); await userEvent.type(zone, "Mars/Base");
    expect(screen.getByText("2031年2月3日 · 仅一次 08:30 · 单次最多 ¥7")).toBeInTheDocument();
  });
});
