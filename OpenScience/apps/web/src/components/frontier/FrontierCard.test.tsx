import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { FrontierCard } from "./FrontierCard";
import { frontierItem } from "./__fixtures__/frontierItems";

const client = vi.hoisted(() => ({ fetchFrontierAbstractZh: vi.fn(), fetchFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { kind: string; draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="probe">{location.pathname}|{intent?.kind}|{intent?.draft}</div>;
}

function renderCard(item = frontierItem(), props: Partial<Parameters<typeof FrontierCard>[0]> = {}) {
  const handlers = { onStar: vi.fn(), onHide: vi.fn(), onSave: vi.fn(), onOpened: vi.fn(), onTag: vi.fn() };
  render(
    <MemoryRouter initialEntries={["/app/frontier"]}>
      <Routes>
        <Route path="/app/frontier" element={<ul><FrontierCard item={item} {...handlers} {...props} /></ul>} />
        <Route path="*" element={<Probe />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
  return handlers;
}

const scored = (overrides: Record<string, unknown> = {}) => frontierItem({ score: 86, scoreBand: "high", ...overrides });

beforeEach(() => {
  client.fetchFrontierAbstractZh.mockReset();
  client.fetchFrontierItem.mockReset();
  useToastStore.setState({ toasts: [] });
});

describe("a card", () => {
  it("says who said it, how hard the evidence is, and what it says, under a title that is the row's one title", () => {
    renderCard(scored({ alsoReportedBy: [{ sourceId: "stat", sourceName: "STAT", url: "https://www.statnews.com/x" }], alsoReportedCount: 3,
      entities: { drugs: [], trials: [], orgs: [], diseases: ["高胆固醇血症"] } }));
    const card = screen.getByRole("article", { name: "口服 PCSK9 抑制剂降低主要心血管事件" });
    const title = within(card).getByRole("heading", { level: 3 });
    expect(title).toHaveAttribute("data-row-title");
    expect(within(title).getByRole("link")).toHaveClass("text-text");
    for (const text of ["NEJM", "RCT", "多中心双盲试验纳入 12000 例患者。", "另有 3 家报道 ›", "#心血管", "#高胆固醇血症"]) {
      expect(card).toHaveTextContent(text);
    }
    expect(within(card).getByText("RCT")).toHaveClass("rounded-tag");
  });

  it("carries none of what the plan took off it", () => {
    renderCard(scored({ facts: { journal: "The New England Journal of Medicine", impact_factor: 78.5, authors_short: "Ray KK, et al." } }));
    const card = screen.getByRole("article");
    // The reason box, the two folds, the original title, the facts line, the source type and the 精选 chip.
    for (const gone of ["为什么值得看", "首个口服 PCSK9 抑制剂的硬终点证据。", "为什么入选", "评估与核对", "因为你在做",
      "Oral PCSK9 Inhibition and Cardiovascular Outcomes", "影响因子", "Ray KK", "期刊", "精选", "来源权威"]) {
      expect(card).not.toHaveTextContent(gone);
    }
    // No dimension's number either; only the total, 86.
    for (const score of ["87", "29", "17", "13"]) expect(card.textContent).not.toContain(score);
  });

  it("puts the editorial score at the top right, a grey number after a dot in its band's colour, and says what it is", () => {
    renderCard(scored());
    const score = screen.getByTitle("编辑评分 · 满分 100");
    expect(score).toHaveTextContent("编辑评分86");
    expect(score).toHaveClass("tabular-nums", "text-text-3");
    expect(score.querySelector("[data-band]")).toHaveClass("bg-accent");
  });

  it.each([
    ["medium", 68, "bg-text-2"],
    ["low", 42, "bg-text-3"],
  ])("dots a %s score in its own grey", (band, value, dot) => {
    renderCard(scored({ score: value, scoreBand: band }));
    expect(screen.getByTitle("编辑评分 · 满分 100").querySelector("[data-band]")).toHaveClass(dot);
  });

  it("scores no safety notice, and says 安全警示 first", () => {
    renderCard(frontierItem({ score: 90, scoreBand: "high", safetyAlert: true, evidenceType: "safety-notice", evidenceTypeLabel: "安全通告",
      sourceType: "regulator", sourceTypeLabel: "监管", source: { id: "fda-recalls", name: "FDA" } }));
    const card = screen.getByRole("article");
    expect(screen.queryByTitle("编辑评分 · 满分 100")).not.toBeInTheDocument();
    expect(card.textContent?.indexOf("安全警示")).toBe(0);
    expect(within(card).getByText("安全警示")).toHaveClass("bg-danger-soft");
    // The safety tag already says what the evidence type would.
    expect(card).not.toHaveTextContent("安全通告");
  });

  it("steps a read card's title down to the secondary colour", () => {
    renderCard(scored({ state: { starred: false, hidden: false, read: true } }));
    expect(within(screen.getByRole("heading", { level: 3 })).getByRole("link")).toHaveClass("text-text-2");
  });

  it("says in words the flags that change how to take it, and a retraction in the safety colour", () => {
    renderCard(frontierItem({ flags: [{ key: "preprint", label: "未经同行评议" }, { key: "retracted", label: "已撤稿" }, { key: "no-abstract", label: "无摘要" }] }));
    expect(screen.getByText("· 未经同行评议")).toBeInTheDocument();
    expect(screen.getByText("已撤稿")).toHaveClass("bg-danger-soft");
    expect(screen.queryByText(/无摘要/)).not.toBeInTheDocument();
  });

  it("puts the time in its own column with a dot, teal for 精选, and says 精选 where not every item is", () => {
    renderCard(frontierItem({ timelineAt: new Date(2026, 8, 22, 9, 5).toISOString() }), { markSelected: true });
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("09:05")).toHaveClass("tabular-nums");
    expect(item.querySelector(".bg-accent")).not.toBeNull();
    expect(within(item).getByText("精选")).toHaveClass("sr-only");
  });
});

describe("its actions", () => {
  it("stars with a pressed star", async () => {
    const item = frontierItem({ state: { starred: true, hidden: false, read: false } });
    const handlers = renderCard(item);
    const star = screen.getByRole("button", { name: "收藏" });
    expect(star).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(star);
    expect(handlers.onStar).toHaveBeenCalledWith(item);
  });

  it("shows its star, 深入研究 and 「⋯」 without a pointer over it, and no second 原文 control", () => {
    renderCard();
    const card = screen.getByRole("article");
    for (const name of ["收藏", "深入研究", "更多操作"]) {
      let node: HTMLElement | null = within(card).getByRole("button", { name });
      for (; node && node !== card; node = node.parentElement) expect(node.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    }
    expect(within(card).getAllByRole("link")).toHaveLength(1);
  });

  it("opens the original from its title, in a new tab, and records the reading", async () => {
    const item = frontierItem();
    const handlers = renderCard(item);
    const original = within(screen.getByRole("heading", { level: 3 })).getByRole("link", { name: item.title });
    expect(original).toHaveAttribute("href", "https://www.nejm.org/doi/full/10.1056/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(original).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.click(original);
    expect(handlers.onOpened).toHaveBeenCalledWith(item);
  });

  it("opens a new conversation with the draft in the composer at once, and sends nothing", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "深入研究" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const probe = await screen.findByTestId("probe");
    expect(probe.textContent?.startsWith("/app/chat|create|这项研究可靠吗？")).toBe(true);
    expect(probe).toHaveTextContent("原文：https://www.nejm.org/doi/full/10.1056/example");
  });

  it("keeps 存入知识库, 复制为 Markdown and 不感兴趣 in 「⋯」", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const item = frontierItem();
    const handlers = renderCard(item);
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect((await screen.findAllByRole("menuitem")).map((entry) => entry.textContent)).toEqual(["详情", "存入知识库", "复制为 Markdown", "不感兴趣"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "存入知识库" }));
    expect(handlers.onSave).toHaveBeenCalledWith(item);
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "复制为 Markdown" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("**[口服 PCSK9 抑制剂降低主要心血管事件](https://www.nejm.org/doi/full/10.1056/example)**"));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    expect(handlers.onHide).toHaveBeenCalledWith(item);
  });

  it("offers 存入知识库 only where the page does", async () => {
    renderCard(frontierItem(), { onSave: undefined });
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("lists the other institutions and the whole event behind 「另有 N 家报道」", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const item = frontierItem({ alsoReportedBy: [{ sourceId: "stat", sourceName: "STAT", url: "https://www.statnews.com/x" }], alsoReportedCount: 2,
      event: { id: "ev1", title: "口服 PCSK9 抑制剂" } });
    const handlers = renderCard(item);
    await userEvent.click(screen.getByRole("button", { name: "另有 2 家报道 ›" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "STAT" }));
    expect(open).toHaveBeenCalledWith("https://www.statnews.com/x", "_blank", "noopener,noreferrer");
    expect(handlers.onOpened).toHaveBeenCalledWith(item);
    await userEvent.click(screen.getByRole("button", { name: "另有 2 家报道 ›" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "同一事件的全部报道" }));
    expect(await screen.findByTestId("probe")).toHaveTextContent("/app/frontier/events/ev1");
    open.mockRestore();
  });

  it("narrows the feed by a #tag: a specialty filters, a disease searches", async () => {
    const handlers = renderCard(frontierItem({ entities: { drugs: [], trials: [], orgs: [], diseases: ["高胆固醇血症"] } }));
    await userEvent.click(screen.getByRole("button", { name: "#心血管" }));
    expect(handlers.onTag).toHaveBeenLastCalledWith({ kind: "specialty", key: "cardiology", label: "心血管" });
    await userEvent.click(screen.getByRole("button", { name: "#高胆固醇血症" }));
    expect(handlers.onTag).toHaveBeenLastCalledWith({ kind: "term", key: "高胆固醇血症", label: "高胆固醇血症" });
  });
});

describe("「⋯ › 详情」", () => {
  async function openDetails() {
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "详情" }));
    return screen.findByRole("dialog", { name: "口服 PCSK9 抑制剂降低主要心血管事件" });
  }

  it("holds what the card left out: the original title, the facts and the free full text", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: "这是中文摘要。", abstract: "Abstract.", note: null });
    renderCard(frontierItem({ sourceType: "media", facts: { journal: "NEJM", impact_factor: 78.456 },
      openAccess: { status: "gold", pdfUrl: "https://europepmc.org/articles/PMC1/pdf" } }));
    const details = await openDetails();
    for (const text of ["Oral PCSK9 Inhibition and Cardiovascular Outcomes", "期刊", "影响因子", "78.5"]) expect(details).toHaveTextContent(text);
    expect(within(details).getByRole("link", { name: "免费全文" })).toHaveAttribute("href", "https://europepmc.org/articles/PMC1/pdf");
    expect(await within(details).findByText("这是中文摘要。")).toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "中文摘要" })).toBeInTheDocument();
  });

  it("reads the abstract only when the details are opened, and names the original one as such", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue(null);
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItem(), abstract: "Background: an original abstract.", abstractZh: null });
    renderCard();
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
    const details = await openDetails();
    expect(await within(details).findByText("Background: an original abstract.")).toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "原文摘要" })).toBeInTheDocument();
  });

  it("offers a retry when the abstract could not be read", async () => {
    client.fetchFrontierAbstractZh.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }))
      .mockResolvedValueOnce({ abstractZh: "重试之后的中文摘要。", abstract: null, note: null });
    renderCard();
    const details = await openDetails();
    await userEvent.click(await within(details).findByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(details).getByText("重试之后的中文摘要。")).toBeInTheDocument());
  });

  it("does not look for an abstract an item does not have", async () => {
    renderCard(frontierItem({ flags: [{ key: "no-abstract", label: "无摘要" }] }));
    const details = await openDetails();
    expect(within(details).queryByRole("heading", { name: "中文摘要" })).not.toBeInTheDocument();
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
  });
});
