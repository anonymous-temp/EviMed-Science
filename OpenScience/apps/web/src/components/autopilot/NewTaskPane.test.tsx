import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { NewTaskPane, type NewTaskDraft } from "./NewTaskPane";
import { RECOMMENDATIONS } from "./taskPresentation";

const mocks = vi.hoisted(() => ({ createAgenda: vi.fn(), startAgenda: vi.fn(), updateAgenda: vi.fn(), getAgenda: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/sourceList", () => ({ listAllSources: vi.fn() }));
vi.mock("@/lib/evolutionClient", () => ({ useEvolutionAccess: () => ({ enabled: false }), listEvolutionOpportunities: vi.fn(), adoptEvolutionOpportunity: vi.fn() }));

const noop = () => {};
const pane = (props: Partial<Parameters<typeof NewTaskPane>[0]> = {}) => <MemoryRouter><NewTaskPane projectId="project-one" onChooseExample={noop} onDraftChange={noop} onRecorded={noop} onSaved={noop} onAdopted={noop} {...props} /></MemoryRouter>;

describe("the new-task pane", () => {
  it("is a heading and the form, and says what a scheduled task is only at first use", () => {
    const first = render(pane({ intro: true }));
    expect(screen.getByRole("heading", { name: "新建定时任务", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/按你定的时间，让 EviMed 自己去做一件事/)).toBeInTheDocument();
    expect(screen.getByLabelText("任务指令")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
    first.unmount();
    render(pane());
    expect(screen.queryByText(/按你定的时间/)).not.toBeInTheDocument();
  });

  it("is the page's standard header with the way back over it where the form is the whole page", () => {
    render(pane({ backTo: "/app/autopilot" }));
    expect(screen.getByRole("heading", { name: "新建定时任务", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "定时任务" })).toHaveAttribute("href", "/app/autopilot");
  });

  it("starts from an example, and offers the examples as buttons over the form only when asked to", async () => {
    const choose = vi.fn();
    const view = render(pane({ recommendation: RECOMMENDATIONS[3], examples: true, onChooseExample: choose }));
    expect(screen.getByLabelText("任务指令")).toHaveValue(RECOMMENDATIONS[3].prompt);
    const section = screen.getByRole("region", { name: "从示例开始" });
    expect(within(section).getAllByRole("button")).toHaveLength(RECOMMENDATIONS.length);
    await userEvent.click(within(section).getByRole("button", { name: RECOMMENDATIONS[0].title }));
    expect(choose).toHaveBeenCalledWith(RECOMMENDATIONS[0]);
    view.rerender(pane({ examples: false }));
    expect(screen.queryByRole("region", { name: "从示例开始" })).not.toBeInTheDocument();
  });

  it("reports an edit and a form that is saving to the page, and withdraws the report when it goes", async () => {
    const reports: NewTaskDraft[] = [];
    let resolveCreate!: (value: unknown) => void;
    mocks.createAgenda.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve; }));
    const view = render(pane({ onDraftChange: draft => reports.push(draft) }));
    expect(reports.at(-1)).toEqual({ dirty: false, locked: false });
    await userEvent.type(screen.getByLabelText("任务指令"), "每天一份简报");
    await waitFor(() => expect(reports.at(-1)).toEqual({ dirty: true, locked: false }));
    await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
    await waitFor(() => expect(reports.at(-1)?.locked).toBe(true));
    resolveCreate({ id: "agenda-new", revision: 1, projectId: "project-one", payload: {} });
    mocks.startAgenda.mockResolvedValue({ id: "agenda-new", revision: 2, projectId: "project-one", payload: {} });
    view.unmount();
    expect(reports.at(-1)).toEqual({ dirty: false, locked: false });
  });

  it("asks before 取消 gives an edit up, and goes at once without one", async () => {
    const cancel = vi.fn();
    render(pane({ onCancel: cancel }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByLabelText("任务指令"), "没写完");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" })).getByRole("button", { name: "取消" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" })).getByRole("button", { name: "放弃修改" }));
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
