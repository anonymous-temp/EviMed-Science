import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { FrontierCard } from "./FrontierCard";
import { frontierItem } from "./__fixtures__/frontierItems";

const client = vi.hoisted(() => ({ fetchFrontierAbstractZh: vi.fn(), fetchFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

function ChatProbe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { kind: string; draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="chat">{intent?.kind}|{intent?.draft}</div>;
}

function renderCard(item = frontierItem(), props: Partial<Parameters<typeof FrontierCard>[0]> = {}) {
  const handlers = { onStar: vi.fn(), onHide: vi.fn(), onSave: vi.fn(), onOpened: vi.fn() };
  render(
    <MemoryRouter initialEntries={["/app/frontier"]}>
      <Routes>
        <Route path="/app/frontier" element={<FrontierCard item={item} {...handlers} {...props} />} />
        <Route path="/app/chat" element={<ChatProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return handlers;
}

beforeEach(() => {
  client.fetchFrontierAbstractZh.mockReset();
  client.fetchFrontierItem.mockReset();
});

describe("a card", () => {
  it("says who said it, how hard the evidence is, what it says and why it matters", () => {
    renderCard();
    const card = screen.getByRole("article", { name: "口服 PCSK9 抑制剂降低主要心血管事件" });
    for (const text of ["期刊", "NEJM", "RCT", "心血管", "Oral PCSK9 Inhibition and Cardiovascular Outcomes", "多中心双盲试验纳入 12000 例患者。", "为什么值得看"]) {
      expect(card).toHaveTextContent(text);
    }
    const original = within(card).getByRole("link", { name: "原文" });
    expect(original).toHaveAttribute("href", "https://www.nejm.org/doi/full/10.1056/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(original).toHaveAttribute("rel", "noopener noreferrer");
    // No open-access copy, no second link; 精选 is said only where not everything is.
    expect(within(card).queryByRole("link", { name: "免费全文" })).not.toBeInTheDocument();
    expect(within(card).queryByText("精选")).not.toBeInTheDocument();
  });

  it("marks a safety alert on the danger ground, first", () => {
    renderCard(frontierItem({ safetyAlert: true, sourceType: "regulator", sourceTypeLabel: "监管", source: { id: "nmpa", name: "国家药监局" } }));
    const card = screen.getByRole("article");
    expect(card).toHaveClass("bg-danger-soft");
    expect(card.textContent?.indexOf("安全警示")).toBe(0);
  });

  it("always says a preprint has not been peer reviewed, and a newsroom that its data are unpublished", () => {
    renderCard(frontierItem({ sourceType: "preprint", sourceTypeLabel: "预印本", flags: [{ key: "preprint", label: "未经同行评议" }] }));
    expect(screen.getByRole("article")).toHaveTextContent("预印本");
    expect(screen.getByText("未经同行评议")).toBeInTheDocument();
  });

  it("says a company topline is the company's own", () => {
    renderCard(frontierItem({ sourceType: "company", sourceTypeLabel: "企业", flags: [{ key: "press-release", label: "企业新闻稿 · 数据未发表" }] }));
    expect(screen.getByText("企业新闻稿 · 数据未发表")).toBeInTheDocument();
  });

  it("offers the free full text beside the original when there is one", () => {
    renderCard(frontierItem({ openAccess: { status: "gold", pdfUrl: "https://europepmc.org/articles/PMC1/pdf" } }));
    expect(screen.getByRole("link", { name: "免费全文" })).toHaveAttribute("href", "https://europepmc.org/articles/PMC1/pdf");
  });

  it("names who else is reporting it", () => {
    renderCard(frontierItem({ alsoReportedBy: [{ sourceId: "stat", sourceName: "STAT", url: "https://www.statnews.com/x" }] }));
    expect(screen.getByText(/还有谁在说/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "STAT" })).toHaveAttribute("href", "https://www.statnews.com/x");
  });

  it("marks 精选 where it is asked to", () => {
    renderCard(frontierItem(), { markSelected: true });
    expect(within(screen.getByRole("article")).getByText("精选")).toBeInTheDocument();
  });
});

describe("its actions", () => {
  it("stars, hides and records the reading of the original", async () => {
    const item = frontierItem();
    const handlers = renderCard(item);
    await userEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(handlers.onStar).toHaveBeenCalledWith(item);
    await userEvent.click(screen.getByRole("button", { name: "不感兴趣" }));
    expect(handlers.onHide).toHaveBeenCalledWith(item);
    await userEvent.click(screen.getByRole("link", { name: "原文" }));
    expect(handlers.onOpened).toHaveBeenCalledWith(item);
  });

  it("shows a starred item as starred", () => {
    renderCard(frontierItem({ state: { starred: true, hidden: false, read: false } }));
    expect(screen.getByRole("button", { name: "已收藏" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hides 存入知识库 where the page does not offer it", () => {
    renderCard(frontierItem(), { onSave: undefined });
    expect(screen.queryByRole("button", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("opens a new conversation with the draft in the composer, and sends nothing", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /深入研究/ }));
    const menu = screen.getByRole("menu", { name: "深入研究" });
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      "这项研究可靠吗", "对我的课题意味着什么", "围绕这个问题做一份证据综合", "自己写问题",
    ]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "围绕这个问题做一份证据综合" }));
    const chat = await screen.findByTestId("chat");
    expect(chat.textContent?.startsWith("create|围绕这条进展涉及的临床问题做一份证据综合")).toBe(true);
    expect(chat).toHaveTextContent("原文：https://www.nejm.org/doi/full/10.1056/example");
  });
});

describe("为什么入选", () => {
  it("gives the four levels in words and the number check, and no number the server scored", async () => {
    // The fixture carries scoreTotal 87 and scores 29 / 17 / 13 that the contract never sends.
    // A day-precision date keeps 「N 小时前」 out of the text this test reads for digits.
    renderCard(frontierItem({ datePrecision: "day" }));
    await userEvent.click(screen.getByText("为什么入选"));
    const levels = screen.getByRole("list", { name: "四个维度" });
    expect(levels).toHaveTextContent("来源权威 高");
    expect(levels).toHaveTextContent("实践影响 高");
    expect(levels).toHaveTextContent("新颖性 中");
    expect(levels).toHaveTextContent("与国内相关 低");
    expect(screen.getByText("导读里的数字都已在原文里核对到。")).toBeInTheDocument();
    expect(screen.getByText("综合评估达到精选线。")).toBeInTheDocument();
    const card = screen.getByRole("article").textContent ?? "";
    for (const score of ["87", "29", "17", "13", "/100"]) expect(card).not.toContain(score);
  });

  it("is 评估与核对 for an item that was not selected", () => {
    renderCard(frontierItem({ selected: false, selectedRule: null }));
    expect(screen.getByText("评估与核对")).toBeInTheDocument();
    expect(screen.queryByText("为什么入选")).not.toBeInTheDocument();
  });
});

describe("中文摘要", () => {
  it("reads nothing until it is opened", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: "这是中文摘要。", abstract: "Abstract.", note: null });
    renderCard();
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("中文摘要"));
    expect(await screen.findByText("这是中文摘要。")).toBeInTheDocument();
    expect(client.fetchFrontierAbstractZh).toHaveBeenCalledWith("a1b2c3d4e5f60718");
  });

  it("shows the original abstract, and says why, where the Chinese one is not offered yet", async () => {
    client.fetchFrontierAbstractZh.mockResolvedValue(null);
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItem(), abstract: "Background: an original abstract.", abstractZh: null });
    renderCard();
    await userEvent.click(screen.getByText("中文摘要"));
    expect(await screen.findByText("中文摘要还在准备，下面是原文摘要。")).toBeInTheDocument();
    expect(screen.getByText("Background: an original abstract.")).toBeInTheDocument();
  });

  it("offers a retry when the abstract could not be read", async () => {
    client.fetchFrontierAbstractZh.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }))
      .mockResolvedValueOnce({ abstractZh: "重试之后的中文摘要。", abstract: null, note: null });
    renderCard();
    await userEvent.click(screen.getByText("中文摘要"));
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("重试之后的中文摘要。")).toBeInTheDocument());
  });

  it("is not offered for an item that has no abstract", () => {
    renderCard(frontierItem({ flags: [{ key: "no-abstract", label: "无摘要" }] }));
    expect(screen.queryByText("中文摘要")).not.toBeInTheDocument();
  });
});
