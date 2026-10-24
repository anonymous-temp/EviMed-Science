import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseFrontierItemDetail } from "@/lib/frontierClient";
import { rawBriefedPaper, rawIndustryShort, rawNewsLong, rawPolicy, rawSafetyAlert, rawWechatCommentary } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierArticlePage } from "./FrontierArticlePage";

// The reader by genre (ct-write W6, 2026-10-24): what the item is in its byline, 导读 → 要点 → 解读 → the text once, folded under what was
// written about it or open, as its genre is read.
const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));
const detail = (raw: Record<string, unknown>) => parseFrontierItemDetail(raw)!;
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
function show(raw: Record<string, unknown>) {
  client.fetchFrontierItem.mockResolvedValue(detail(raw));
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/items/${String(raw.id)}`]}>
      <Routes><Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} /></Routes>
    </MemoryRouter>,
  );
}
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("a paper", () => {
  it("names itself in the byline, then 导读, 要点 with the authors' own words, and its abstract folded once", async () => {
    show(rawBriefedPaper());
    const text = await screen.findByRole("region", { name: "摘要 · AI 翻译" });
    const lead = screen.getByRole("region", { name: "AI 导读" });
    const brief = screen.getByRole("region", { name: "AI 要点" });
    expect(before(lead, brief) && before(brief, text)).toBe(true);
    // The byline over the title: what the item is, and its design.
    const genre = screen.getByText("研究论文");
    expect(genre).toHaveAttribute("data-tag");
    expect(before(genre, screen.getByRole("heading", { level: 1 }))).toBe(true);
    expect(genre.parentElement).toHaveTextContent("RCT");
    expect([...brief.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["研究问题", "设计与对象", "主要结果"]);
    expect(within(brief).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual(["主要终点事件 7.2% 对 8.8%（风险比 0.82；95% CI：0.75–0.90）。", "LDL-C 平均下降 52%。"]);
    const quote = brief.querySelector("figure")!;
    expect(quote).toHaveTextContent("作者结论");
    expect(quote.querySelector("blockquote")).toHaveAttribute("lang", "en");
    expect(quote).toHaveTextContent("口服 PCSK9 抑制降低了主要心血管事件的风险。");
    // The abstract once, folded to its first paragraph under what was written about it.
    expect(within(text).getByText(/^口服 PCSK9 抑制可降低/)).toBeInTheDocument();
    expect(within(text).queryByText(/^在一项双盲试验中/)).not.toBeInTheDocument();
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect(within(text).getByText(/^在一项双盲试验中/)).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "正文" })).toHaveAttribute("data-frontier-reader", "briefed-paper-1");
  });
});

describe("a 公众号 reading", () => {
  it("opens the report it reads, and folds the article behind its 导读 and 要点 with 阅读原文", async () => {
    show(rawWechatCommentary());
    const brief = await screen.findByRole("region", { name: "AI 要点" });
    expect(within(brief).getByRole("link", { name: "《Atacicept in IgA Nephropathy》" })).toHaveAttribute("href", "/app/frontier/items/nejm-origin3");
    expect(brief.querySelector("dt")).toHaveTextContent("解读的研究");
    const text = screen.getByRole("region", { name: "正文" });
    const original = within(text).getByRole("link", { name: "阅读原文" });
    expect(original).toHaveAttribute("href", "https://mp.weixin.qq.com/s/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(within(text).queryByText(/^第 6 段/)).not.toBeInTheDocument();
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect(within(text).getByText(/^第 6 段/)).toBeInTheDocument();
    expect(screen.getByText("解读评论")).toHaveAttribute("data-tag");
  });
});

describe("a policy, an industry report, a news report", () => {
  it("folds a policy's text to its preview", async () => {
    show(rawPolicy());
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByRole("button", { name: "展开全文" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "AI 要点" })).getByText("国家医疗保障局，医保发〔2026〕23号。")).toBeInTheDocument();
  });

  it("shows a short industry report whole", async () => {
    show(rawIndustryShort());
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByText(/^交易预计/)).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
    expect(screen.getByText("行业动态")).toHaveAttribute("data-tag");
  });

  it("folds a long news report to its preview", async () => {
    show(rawNewsLong());
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).queryByText(/^第 8 段/)).not.toBeInTheDocument();
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect(within(text).getByText(/^第 8 段/)).toBeInTheDocument();
  });
});

describe("a safety alert", () => {
  it("says 安全警示 once, lists what professionals should do, and quotes the warning", async () => {
    show(rawSafetyAlert());
    const brief = await screen.findByRole("region", { name: "AI 要点" });
    expect(screen.getAllByText("安全警示")).toHaveLength(1);
    expect(within(brief).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual(["仅在有 Wi-Fi 或蜂窝信号的区域使用。", "随时备好备用超声设备。"]);
    expect(brief.querySelector("figure")).toHaveTextContent("警示原文");
    expect(screen.queryByText("安全通告")).not.toBeInTheDocument();
  });
});
