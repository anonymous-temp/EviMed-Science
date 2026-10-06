import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceCardLinks, EvidenceContinueAction, continuationIntent } from "./EvidenceCardLinks";

const client = vi.hoisted(() => ({ continueResearchFromCard: vi.fn(), fetchEvidenceCardLinks: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
const projects = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: projects.select }) } }));

const continuation = { projectId: "continue-1", sessionId: "card-abc", originCardId: "ec_1", draft: "请基于下面这张证据卡继续研究", library: { folder: "knowledge-base/evidence", saved: [{ index: 1, title: "试验 A", path: "knowledge-base/evidence/a.md", kind: "text" as const }], failed: [] } };
function Where() { const location = useLocation(); return <pre data-testid="where" data-state={JSON.stringify(location.state)}>{location.pathname}</pre>; }
const mount = (ui: React.ReactNode) => render(<MemoryRouter>{ui}<Where /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  projects.select.mockImplementation(async (_id: string, land?: () => void) => { land?.(); });
});

describe("continuing research from a card", () => {
  it("opens the conversation in the new project with the question in the composer, unsent", async () => {
    client.continueResearchFromCard.mockResolvedValue(continuation);
    mount(<EvidenceContinueAction evidence={{ id: "ec_1", canResearch: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "用这张卡继续研究" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/chat"));
    expect(client.continueResearchFromCard).toHaveBeenCalledWith("ec_1");
    expect(projects.select).toHaveBeenCalledWith("continue-1", expect.any(Function));
    const state = JSON.parse(screen.getByTestId("where").getAttribute("data-state")!);
    expect(state.runtimeUiIntent).toMatchObject({ kind: "create", projectId: "continue-1", sessionId: "card-abc", draft: "请基于下面这张证据卡继续研究" });
    expect(continuationIntent(continuation).requestId).toMatch(/\S/);
  });
  it("says which sources could not be saved before it opens, and opens when the researcher goes on", async () => {
    client.continueResearchFromCard.mockResolvedValue({ ...continuation, library: { ...continuation.library, failed: [{ index: 2, code: "project_storage_full" }] } });
    mount(<EvidenceContinueAction evidence={{ id: "ec_1", canResearch: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "用这张卡继续研究" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已存入 1 个来源，有 1 个没有存成：来源 2");
    expect(screen.getByTestId("where")).toHaveTextContent("/");
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/chat"));
  });
  it("shows a refusal by name and stays where it is; and is not offered on a card that may not be researched", async () => {
    client.continueResearchFromCard.mockRejectedValue(new WebApiError("no", { status: 404, code: "evidence_continue_unavailable" }));
    const { container, rerender } = mount(<EvidenceContinueAction evidence={{ id: "ec_1", canResearch: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "用这张卡继续研究" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("这个部署没有开通知识库");
    rerender(<MemoryRouter><EvidenceContinueAction evidence={{ id: "ec_1", canResearch: false }} /></MemoryRouter>);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("what a card points to", () => {
  const links = { author: { id: "alice", name: "李研究" }, origin: null, previous: { id: "ec_0", zoneId: "ez_1", title: "更早的一版", creator: "李研究", producer: null },
    related: [{ id: "ec_2", zoneId: "ez_2", title: "后续研究", creator: "王医生", producer: null, relation: "research_from_card" as const }, { id: "ec_3", zoneId: "ez_1", title: "新版本", creator: "李研究", producer: null, relation: "next_version" as const }] };
  it("links the author's page, the earlier version and the cards that follow or began from it", async () => {
    client.fetchEvidenceCardLinks.mockResolvedValue(links);
    mount(<EvidenceCardLinks cardId="ec_1" />);
    expect(await screen.findByRole("link", { name: "李研究" })).toHaveAttribute("href", "/app/frontier/authors/alice");
    expect(screen.getByRole("link", { name: "更早的一版" })).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_0");
    expect(screen.getByText(/后续研究 ·/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "后续研究" })).toHaveAttribute("href", "/app/frontier/zones/ez_2/evidence/ec_2");
    expect(screen.getByRole("link", { name: "新版本" })).toBeInTheDocument();
    expect(screen.getByText(/后续版本 ·/)).toBeInTheDocument();
  });
  it("shows only the author when nothing points to or from the card, and nothing while it loads", async () => {
    client.fetchEvidenceCardLinks.mockResolvedValue({ author: links.author, origin: null, previous: null, related: [] });
    const { container } = mount(<EvidenceCardLinks cardId="ec_1" />);
    expect(container.querySelector("section")).toBeNull();
    await screen.findByRole("link", { name: "李研究" });
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
  it("says once that it could not be read, and tries again", async () => {
    client.fetchEvidenceCardLinks.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(links);
    mount(<EvidenceCardLinks cardId="ec_1" />);
    expect(await screen.findByRole("status")).toHaveTextContent("暂时读不出来");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "李研究" })).toBeInTheDocument();
  });
});
