import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TaskDialog } from "@/components/autopilot/TaskDialog";
import { EvolutionOpportunities } from "./EvolutionOpportunities";

const client = vi.hoisted(() => ({ useEvolutionAccess: vi.fn(), listEvolutionOpportunities: vi.fn(), adoptEvolutionOpportunity: vi.fn() }));
vi.mock("@/lib/evolutionClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evolutionClient")>()), ...client }));

const opportunity = (id: string, title: string, description?: string) => ({ id, revision: 1, payload: { title, description, projectId: "project-one", origin: "evolution" } });

describe("研究机会, a group of the scheduled tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.useEvolutionAccess.mockReturnValue({ enabled: true, operator: false });
    client.listEvolutionOpportunities.mockResolvedValue([]);
  });

  it("is a group of rows — the suggestion, what it is about, and one button to make it a task", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进 SGLT2 抑制剂的新试验", "最近两个月有三项新的随机对照试验。")]);
    const adopted = vi.fn();
    client.adoptEvolutionOpportunity.mockResolvedValue({ id: "agenda-new" });
    render(<EvolutionOpportunities projectId="project-one" onAdopted={adopted} />);
    const group = await screen.findByRole("region", { name: "研究机会" });
    expect(group).toHaveTextContent("跟进 SGLT2 抑制剂的新试验");
    expect(group).toHaveTextContent("最近两个月有三项新的随机对照试验。");
    await userEvent.click(within(group).getByRole("button", { name: "创建研究议程" }));
    await waitFor(() => expect(adopted).toHaveBeenCalledWith("agenda-new"));
    expect(client.adoptEvolutionOpportunity).toHaveBeenCalledWith("project-one", "op-1");
  });

  it("locks draft creation and templates while adopting an opportunity", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进新试验")]);
    let finish!: (value: { id: string }) => void;
    client.adoptEvolutionOpportunity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const busy = vi.fn(); const adopted = vi.fn();
    render(<MemoryRouter><TaskDialog projectId="project-one" showBudgets={false} saving={false} onBusyChange={busy} onClose={() => {}} onRecorded={() => {}} onSaved={() => {}} onAdopted={adopted} /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "创建研究议程" }));
    await userEvent.type(screen.getByLabelText("任务指令"), "不要同时创建第二项任务");
    expect(screen.getByLabelText("任务指令")).toHaveValue("");
    expect(screen.getByRole("button", { name: "创建并启用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "行业要闻日报" })).toBeDisabled();
    expect(busy).toHaveBeenLastCalledWith(true);
    await act(async () => { finish({ id: "adopted-task" }); });
    expect(adopted).toHaveBeenCalledWith("adopted-task");
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it("preserves a dirty task draft instead of replacing it with an opportunity", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进新试验")]);
    render(<MemoryRouter><TaskDialog projectId="project-one" showBudgets={false} saving={false} onBusyChange={() => {}} onClose={() => {}} onRecorded={() => {}} onSaved={() => {}} onAdopted={() => {}} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText("任务指令"), "保留这个未保存的任务");
    const adopt = await screen.findByRole("button", { name: "创建研究议程" });
    expect(adopt).toBeDisabled();
    await userEvent.click(adopt);
    expect(client.adoptEvolutionOpportunity).not.toHaveBeenCalled();
    expect(screen.getByLabelText("任务指令")).toHaveValue("保留这个未保存的任务");
  });
  it("does not allow adoption while a form save is pending", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进新试验")]);
    render(<MemoryRouter><TaskDialog projectId="project-one" showBudgets={false} saving onBusyChange={() => {}} onClose={() => {}} onRecorded={() => {}} onSaved={() => {}} onAdopted={() => {}} /></MemoryRouter>);
    const action = await screen.findByRole("button", { name: "创建研究议程" });
    expect(action).toBeDisabled(); await userEvent.click(action);
    expect(client.adoptEvolutionOpportunity).not.toHaveBeenCalled();
  });

  it("is not drawn when there is nothing to suggest, nor when the account has no evolution, nor while it is being read", async () => {
    const { container, unmount } = render(<EvolutionOpportunities projectId="project-one" onAdopted={() => {}} />);
    await waitFor(() => expect(client.listEvolutionOpportunities).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    client.useEvolutionAccess.mockReturnValue({ enabled: false, operator: false });
    client.listEvolutionOpportunities.mockClear();
    const off = render(<EvolutionOpportunities projectId="project-one" onAdopted={() => {}} />);
    expect(off.container).toBeEmptyDOMElement();
    expect(client.listEvolutionOpportunities).not.toHaveBeenCalled();
  });

  it("says when the suggestions could not be read, with a retry, rather than looking empty", async () => {
    client.listEvolutionOpportunities.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([opportunity("op-2", "补充亚组分析")]);
    render(<EvolutionOpportunities projectId="project-one" onAdopted={() => {}} />);
    const group = await screen.findByRole("region", { name: "研究机会" });
    await userEvent.click(within(group).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("补充亚组分析")).toBeInTheDocument();
  });
});
