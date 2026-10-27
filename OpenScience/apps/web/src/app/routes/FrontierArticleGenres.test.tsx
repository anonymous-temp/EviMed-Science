import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFrontierItemDetail } from "@/lib/frontierClient";
import { rawBriefedPaper, rawIndustryShort, rawNewsLong, rawPolicy, rawSafetyAlert, rawWechatCommentary } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierArticlePage } from "./FrontierArticlePage";

// The reader by genre (ct-write W6, 2026-10-24; the text a view of its own, 2026-10-26): what the item is in its byline, then the AI view —
// 导读 → 要点 → 解读 — and behind 「查看正文」 (摘要, 全文) the text once, whole, as its genre is read. A post keeps its text on the AI view.
const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));
const detail = (raw: Record<string, unknown>) => parseFrontierItemDetail(raw)!;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
/** A window from 1024 px: the right column beside the text, with the switch to the text at its head. */
function wide() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}
/** The page's toolbar row (2026-10-27): the switch at its left, the actions at its right. */
const toolbar = () => screen.getByRole("group", { name: "阅读视图与操作" });
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
  it("names itself in the byline, then 导读 and 要点 with the authors' own words; its abstract is behind 查看摘要, whole", async () => {
    wide();
    show(rawBriefedPaper());
    const lead = await screen.findByRole("region", { name: "AI 导读" });
    const brief = screen.getByRole("region", { name: "AI 要点" });
    expect(before(lead, brief)).toBe(true);
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
    // The abstract is the other view's: not under the 要点, and not folded to a first paragraph either.
    expect(screen.queryByRole("region", { name: /^摘要/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^口服 PCSK9 抑制可降低/)).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "正文" })).toHaveAttribute("data-frontier-reader", "briefed-paper-1");

    await userEvent.click(within(toolbar()).getByRole("tab", { name: "查看摘要" }));
    const text = await screen.findByRole("region", { name: "摘要 · AI 翻译" });
    expect(within(text).getByText(/^口服 PCSK9 抑制可降低/)).toBeInTheDocument();
    expect(within(text).getByText(/^在一项双盲试验中/)).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI 导读" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI 要点" })).not.toBeInTheDocument();
  });
});

describe("a 公众号 reading", () => {
  it("opens the report it reads; the article is behind 查看正文, whole, and the way to it is the toolbar's 打开原文", async () => {
    wide();
    show(rawWechatCommentary());
    const brief = await screen.findByRole("region", { name: "AI 要点" });
    expect(within(brief).getByRole("link", { name: "《Atacicept in IgA Nephropathy》" })).toHaveAttribute("href", "/app/frontier/items/nejm-origin3");
    // One row: the report as its own article, the reading's words about it under the link.
    expect([...brief.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["解读的研究", "解读要点"]);
    expect(brief.querySelector("dd")).toHaveTextContent("NEJM 同日发表的 ORIGIN 3 与 VISIONARY 两项 3 期试验。");
    expect(screen.queryByRole("region", { name: "正文" })).not.toBeInTheDocument();
    expect(screen.getByText("解读评论")).toHaveAttribute("data-tag");
    const original = within(toolbar()).getByRole("link", { name: "打开原文" });
    expect(original).toHaveAttribute("href", "https://mp.weixin.qq.com/s/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "阅读原文" })).not.toBeInTheDocument();

    await userEvent.click(within(toolbar()).getByRole("tab", { name: "查看正文" }));
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByText(/^第 1 段/)).toBeInTheDocument();
    expect(within(text).getByText(/^第 6 段/)).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI 要点" })).not.toBeInTheDocument();
  });
});

describe("a policy, an industry report, a news report", () => {
  it("keeps a policy's 要点 on the AI view and its whole text behind 查看正文", async () => {
    wide();
    show(rawPolicy());
    expect(within(await screen.findByRole("region", { name: "AI 要点" })).getByText("国家医疗保障局，医保发〔2026〕23号。")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "正文" })).not.toBeInTheDocument();
    await userEvent.click(within(toolbar()).getByRole("tab", { name: "查看正文" }));
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByText("为支持医疗技术创新，……")).toBeInTheDocument();
    expect(within(text).getByText("只需 1 家三级医院牵头直接向省级医保部门申报。")).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
  });

  it("shows a short industry report's 要点 and genre on the AI view and its text, whole, on the other", async () => {
    wide();
    show(rawIndustryShort());
    const brief = await screen.findByRole("region", { name: "AI 要点" });
    expect([...brief.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["事件", "交易条款"]);
    expect(screen.getByText("行业动态")).toHaveAttribute("data-tag");
    expect(screen.queryByText(/^交易预计/)).not.toBeInTheDocument();
    await userEvent.click(within(toolbar()).getByRole("tab", { name: "查看正文" }));
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByText(/^吉利德科学宣布/)).toBeInTheDocument();
    expect(within(text).getByText(/^交易预计/)).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
    expect(screen.getByText("行业动态")).toHaveAttribute("data-tag");
  });

  it("shows a long news report whole on its text view: the last paragraph is there, and nothing is folded", async () => {
    wide();
    show(rawNewsLong());
    await screen.findByRole("region", { name: "AI 导读" });
    expect(screen.queryByRole("region", { name: "正文" })).not.toBeInTheDocument();
    await userEvent.click(within(toolbar()).getByRole("tab", { name: "查看正文" }));
    const text = await screen.findByRole("region", { name: "正文" });
    expect(within(text).getByText(/^第 1 段/)).toBeInTheDocument();
    expect(within(text).getByText(/^第 8 段/)).toBeInTheDocument();
    expect(within(text).queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
    expect(text.querySelector(".line-clamp-4")).toBeNull();
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
