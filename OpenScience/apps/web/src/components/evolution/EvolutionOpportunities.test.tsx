import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { runtimeUiIntentFromState } from "@/lib/runtimeUiNavigation";
import { EvolutionOpportunities } from "./EvolutionOpportunities";

const client = vi.hoisted(() => ({ useEvolutionAccess: vi.fn(), listEvolutionOpportunities: vi.fn() }));
vi.mock("@/lib/evolutionClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evolutionClient")>()), ...client }));

const opportunity = (id: string, title: string, description?: string, prompt?: string) => ({ id, revision: 1, payload: { title, description, prompt, projectId: "project-one", origin: "evolution" } });

let landed: { pathname: string; state: unknown } | null = null;
/** The draft the conversation was opened with, read back the way the chat surface reads it. */
const draftOf = () => runtimeUiIntentFromState(landed?.state, (landed?.state as { runtimeUiIntent: { projectId: string } }).runtimeUiIntent.projectId)?.draft;
function Landing() { const location = useLocation(); landed = { pathname: location.pathname, state: location.state }; return null; }
const show = () => render(<MemoryRouter initialEntries={["/here"]}><Routes>
  <Route path="/here" element={<EvolutionOpportunities projectId="project-one" />} />
  <Route path="/app/chat" element={<Landing />} />
</Routes></MemoryRouter>);

describe("研究机会", () => {
  beforeEach(() => {
    vi.clearAllMocks(); landed = null;
    client.useEvolutionAccess.mockReturnValue({ enabled: true, operator: false });
    client.listEvolutionOpportunities.mockResolvedValue([]);
  });

  it("is a group of rows, and adopting one opens a new conversation with its brief as the draft", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进 SGLT2 抑制剂的新试验", "最近两个月有三项新的随机对照试验。", "检索最近两个月 SGLT2 抑制剂的新试验并汇总。")]);
    show();
    const group = await screen.findByRole("region", { name: "研究机会" });
    expect(group).toHaveTextContent("跟进 SGLT2 抑制剂的新试验");
    expect(group).toHaveTextContent("最近两个月有三项新的随机对照试验。");
    await userEvent.click(within(group).getByRole("button", { name: "在对话中开始" }));
    await waitFor(() => expect(landed?.pathname).toBe("/app/chat"));
    expect(draftOf()).toBe("检索最近两个月 SGLT2 抑制剂的新试验并汇总。");
  });

  it("uses the title and the summary when the opportunity has no brief of its own", async () => {
    client.listEvolutionOpportunities.mockResolvedValue([opportunity("op-1", "跟进新试验", "有三项新的试验。")]);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "在对话中开始" }));
    await waitFor(() => expect(landed?.pathname).toBe("/app/chat"));
    expect(draftOf()).toBe("跟进新试验\n\n有三项新的试验。");
  });

  it("is not drawn when there is nothing to suggest, nor when the account has no evolution, nor while it is being read", async () => {
    const { container, unmount } = show();
    await waitFor(() => expect(client.listEvolutionOpportunities).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    client.useEvolutionAccess.mockReturnValue({ enabled: false, operator: false });
    client.listEvolutionOpportunities.mockClear();
    const off = show();
    expect(off.container).toBeEmptyDOMElement();
    expect(client.listEvolutionOpportunities).not.toHaveBeenCalled();
  });

  it("says when the suggestions could not be read, with a retry, rather than looking empty", async () => {
    client.listEvolutionOpportunities.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([opportunity("op-2", "补充亚组分析")]);
    show();
    const group = await screen.findByRole("region", { name: "研究机会" });
    await userEvent.click(within(group).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("补充亚组分析")).toBeInTheDocument();
  });
});
