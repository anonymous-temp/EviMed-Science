import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { card, zone } from "@/components/frontier/__fixtures__/evidenceCards";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceReadingPage } from "./EvidenceReadingPage";

const client = vi.hoisted(() => ({
  fetchEvidenceZone: vi.fn(), fetchZoneEvidence: vi.fn(), fetchEvidenceCardLinks: vi.fn(), continueResearchFromCard: vi.fn(),
  prepareEvidenceResearch: vi.fn(), publishEvidenceCard: vi.fn(),
}));
const frontier = vi.hoisted(() => ({ fetchFrontierItem: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...frontier }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: async (_id: string, land?: () => void) => { land?.(); } }) } }));

/** Stands in for the author's page: it shows what the link handed over. */
function AuthorProbe() {
  const location = useLocation();
  return <pre data-testid="author-state">{JSON.stringify(location.state)}</pre>;
}
const mount = (search = "") => render(
  <MemoryRouter initialEntries={[`/app/frontier/zones/ez_1/evidence/${card.id}${search}`]}>
    <Routes>
      <Route path="/app/frontier/zones/:zoneId/evidence/:cardId" element={<EvidenceReadingPage />} />
      <Route path="/app/frontier/authors/:authorId" element={<AuthorProbe />} />
    </Routes>
  </MemoryRouter>,
);
beforeEach(() => {
  vi.clearAllMocks();
  client.fetchEvidenceZone.mockResolvedValue(zone);
  client.fetchZoneEvidence.mockResolvedValue(card);
  client.fetchEvidenceCardLinks.mockResolvedValue({ author: { id: "alice", name: "李研究" }, origin: null, previous: null, related: [] });
  frontier.fetchFrontierItem.mockResolvedValue({ id: "item_1" });
});

describe("reading an evidence card", () => {
  it("is titled by the card's question, with one way back — 前沿动态 / the zone — and no second link or heading for the same", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "试验药能预防卒中吗" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "返回" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["前沿动态", "/app/frontier"], ["卒中研究", "/app/frontier/zones/ez_1"]]);
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^返回/ })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: /试验药能预防卒中吗|卒中研究/ })).toBeNull();
    expect(screen.queryByText("学术证据")).toBeNull();
    expect(document.title).toContain("试验药能预防卒中吗");
  });

  it("opens with one row — the producer, the labels, the day — then the answer, the two ways to go on, and the claims with their marks", async () => {
    mount();
    const header = await screen.findByTestId("evidence-card-header");
    expect(header).toHaveTextContent("出品方 李研究 · 用户 · 与所涉产品无利益关系");
    expect(screen.getByText("引文已核对 1/2")).toBeInTheDocument();
    // The producer line is the first thing in the article.
    expect(header.closest("article")?.querySelector("header")?.firstElementChild).toBe(header);
    expect(screen.getByRole("radio", { name: "临床版" })).toBeChecked();
    expect(screen.getByRole("table", { name: "结局总结表" })).toBeInTheDocument();
    expect(screen.getByLabelText("引文已核对")).toBeInTheDocument();
    expect(screen.getByLabelText("未核对上")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "公众版" }));
    expect(screen.getByText("每 1000 人里")).toBeInTheDocument();
  });

  it("keeps the two research actions together: 问这条证据 in the header, 用这张卡继续研究 directly under the answer, each with its hover line", async () => {
    mount();
    const ask = await screen.findByRole("button", { name: "问这条证据" });
    const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(header).toContainElement(ask);
    const answer = screen.getByText("核心回答").closest("section")!;
    const row = answer.nextElementSibling!;
    const next = within(row as HTMLElement).getByRole("button", { name: "用这张卡继续研究" });
    expect(next).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("编写与核查")).toBeInTheDocument();
    await userEvent.hover(ask);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("在当前项目里带着这张卡提问");
  });

  it("folds who wrote and checked it, and the discussion, review forms and update record, so the page ends with the sources", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canReview: true, discussion: [{ author: "王医生", text: "有一个问题", createdAt: null }], reviews: [{ author: "李药师", score: 4, text: "引文对", createdAt: "2026-10-04T12:00:00Z", revision: 2, current: true }],
      editorial: { author: { kind: "ai", name: "EviMed 证据 AI", model: "deepseek-v4-flash" }, reviewer: null, status: "review-pending", reviewRevision: null },
      revisions: [{ revision: 2, recordedAt: "2026-10-04T00:00:00Z", title: "新版", sourceFingerprint: "b", reviewStatus: null }, { revision: 1, recordedAt: "2026-10-01T00:00:00Z", title: "旧版", sourceFingerprint: "a", reviewStatus: null }] });
    const { container } = mount();
    await screen.findByTestId("evidence-card-header");
    const folds = Array.from(container.querySelectorAll("details"));
    expect(folds.map((fold) => fold.querySelector("summary")?.textContent)).toEqual(["编写与核查", "评议与讨论（2）", "更新记录"]);
    expect(folds.every((fold) => !fold.open)).toBe(true);
    const [authoring, discussion, record] = folds;
    expect(within(authoring).getByText("AI 编写 · EviMed 证据 AI")).toBeInTheDocument();
    for (const inside of [screen.getByText("有一个问题"), screen.getByText("引文对"), screen.getByLabelText("参与讨论"), screen.getByLabelText("评议意见")]) expect(discussion).toContainElement(inside);
    expect(record).toContainElement(screen.getByText("新版"));
    // Everything the card says comes before the first fold that is not about the card itself: after 来源与引用 come only the card's links and the folds.
    const article = container.querySelector("article")!;
    expect(article.lastElementChild).toHaveTextContent("来源与引用");
    expect(article).not.toContainElement(discussion);
    expect(container).not.toHaveTextContent(/deepseek|模型/i);
  });

  it("offers 回到相关动态 while the feed item the card came from can still be read", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, sourceItemId: "40eb64eadac9a8d6" });
    mount();
    expect(await screen.findByRole("link", { name: "回到相关动态" })).toHaveAttribute("href", "/app/frontier?item=40eb64eadac9a8d6");
    expect(frontier.fetchFrontierItem).toHaveBeenCalledTimes(1);
    expect(frontier.fetchFrontierItem).toHaveBeenCalledWith("40eb64eadac9a8d6");
  });

  it("does not offer it for an item that was taken down, nor ask for one the card never had, and keeps it when the check merely failed", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, sourceItemId: "40eb64eadac9a8d6" });
    frontier.fetchFrontierItem.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_item_not_found" }));
    const gone = mount();
    await screen.findByTestId("evidence-card-header");
    await waitFor(() => expect(frontier.fetchFrontierItem).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "回到相关动态" })).toBeNull();
    gone.unmount();
    frontier.fetchFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503 }));
    const failed = mount();
    expect(await screen.findByRole("link", { name: "回到相关动态" })).toBeInTheDocument();
    failed.unmount();
    vi.clearAllMocks();
    client.fetchEvidenceZone.mockResolvedValue(zone);
    client.fetchZoneEvidence.mockResolvedValue(card);
    client.fetchEvidenceCardLinks.mockResolvedValue({ author: { id: "alice", name: "李研究" }, origin: null, previous: null, related: [] });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(frontier.fetchFrontierItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "回到相关动态" })).toBeNull();
  });

  it("links the author with the card as where the reader came from", async () => {
    mount();
    const author = await screen.findByRole("link", { name: "李研究" });
    expect(author).toHaveAttribute("href", "/app/frontier/authors/alice");
    await userEvent.click(author);
    expect(JSON.parse((await screen.findByTestId("author-state")).textContent!)).toEqual({ evidenceFrom: { to: `/app/frontier/zones/ez_1/evidence/${card.id}`, label: "试验药能预防卒中吗" } });
  });

  it("puts the owner's edit and publish in a menu, not among the reader's buttons", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canEdit: true });
    client.publishEvidenceCard.mockResolvedValue({ ...card, state: "draft", canEdit: true });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByRole("button", { name: "编辑证据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "撤回证据" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "撤回证据" }));
    await waitFor(() => expect(client.publishEvidenceCard).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }), "draft"));
    expect(await screen.findByText("草稿")).toBeInTheDocument();
  });

  it("will not offer to publish a draft that has no body or no source, and says what is missing", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, state: "draft", canEdit: true, body: "", sources: [] });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.getByText("发布前请填写正文并添加来源")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "发布证据" })).toBeDisabled();
  });

  it("offers 用这张卡继续研究 only on a card that may be researched", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canResearch: false });
    mount();
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByRole("button", { name: "用这张卡继续研究" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "问这条证据" })).not.toBeInTheDocument();
  });
  it("opens a draft made from a result straight in the card editor, for its owner only", async () => {
    client.fetchZoneEvidence.mockResolvedValue({ ...card, state: "draft", canEdit: true });
    const owner = mount("?edit=1");
    expect(await screen.findByLabelText("证据标题")).toBeInTheDocument();
    owner.unmount();
    client.fetchZoneEvidence.mockResolvedValue({ ...card, canEdit: false });
    mount("?edit=1");
    await screen.findByTestId("evidence-card-header");
    expect(screen.queryByLabelText("证据标题")).not.toBeInTheDocument();
  });
});
