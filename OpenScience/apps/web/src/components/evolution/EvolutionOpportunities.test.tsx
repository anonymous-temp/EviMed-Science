import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
