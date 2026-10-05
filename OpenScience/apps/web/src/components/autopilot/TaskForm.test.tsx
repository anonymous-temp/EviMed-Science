import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
