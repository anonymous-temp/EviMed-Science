import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { parseFrontierItemDetail } from "@/lib/frontierClient";
import { frontierItemDetail, rawChineseNews, rawOpenAccessPaper, rawStructuredAbstract, rawXPost } from "@/components/frontier/__fixtures__/frontierItems";
import { expectComposed } from "@/test/expectComposed";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { FrontierArticlePage } from "./FrontierArticlePage";
const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
  starFrontierItem: vi.fn(), unstarFrontierItem: vi.fn(), hideFrontierItem: vi.fn(), unhideFrontierItem: vi.fn(), addFrontierFollow: vi.fn(),
  listFrontierFollows: vi.fn(), removeFrontierFollow: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));
const detail = (raw: Record<string, unknown>) => parseFrontierItemDetail(raw)!;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1" }), abstract: "Original abstract", abstractZh: "已保存的中文摘要" });
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
/** A window from 1024 px: the right column beside the text. jsdom matches no query otherwise, which is the narrow page. */
function wide() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}
function show(path = "/app/frontier/items/item-1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/frontier/items/:itemId" element={<><FrontierArticlePage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("a journal article", () => {
  it("opens with its guide, its stored abstract in Chinese, its original title and the way to the original", async () => {
    show();
    expect(await screen.findByRole("heading", { name: "口服 PCSK9 抑制剂降低主要心血管事件", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 导读" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "摘要 · AI 翻译" })).toBeInTheDocument();
    expect(screen.getByText("已保存的中文摘要")).toBeInTheDocument();
    expect(screen.getByText("Oral PCSK9 Inhibition and Cardiovascular Outcomes")).toBeInTheDocument();
    // The end of the article: where it came from and the way to the original.
    const end = screen.getByText(/^来源：/).parentElement!;
    expect(end).toHaveTextContent("来源：NEJM· nejm.org打开原文");
    const original = within(end).getByRole("link", { name: "打开原文" });
    expect(original).toHaveAttribute("href", "https://www.nejm.org/doi/full/10.1056/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
    expect(client.markFrontierItemRead).toHaveBeenCalled();
    // The header is the title alone (owner: 「查看原文又跑到右上角去了」): the actions are the right column's, or the bar's.
    expectComposed(document.body, { tablists: 0, stepRail: false, toolbar: false });
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).queryAllByRole("button")).toEqual([]);
    expect(within(header).queryAllByRole("link")).toEqual([]);
  });

  it("switches the abstract between 中文 and 原文, and keeps the choice for the session", async () => {
    const { unmount } = show();
    await screen.findByText("已保存的中文摘要");
    const switcher = screen.getByRole("group", { name: "摘要语言" });
    await userEvent.click(within(switcher).getByRole("button", { name: "原文" }));
    expect(screen.getByText("Original abstract")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "摘要 · 原文" })).toBeInTheDocument();
    expect(screen.queryByText("已保存的中文摘要")).not.toBeInTheDocument();
    unmount();
    show();
    expect(await screen.findByText("Original abstract")).toBeInTheDocument();
  });

  it("requests the shared Chinese abstract when only an original is stored", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1" }), abstract: "Original abstract", abstractZh: null });
    client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: "新生成的中文摘要", abstract: "Original abstract", note: null });
    show();
    expect(await screen.findByText("新生成的中文摘要")).toBeInTheDocument();
    expect(client.fetchFrontierAbstractZh).toHaveBeenCalledWith("item-1");
  });

  it("names an original abstract as such where no Chinese one can be written, and offers a retry for a failed read", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1" }), abstract: "Background: original.", abstractZh: null });
    client.fetchFrontierAbstractZh.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null })).mockResolvedValueOnce(null);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    const text = await screen.findByRole("region", { name: "摘要 · 原文" });
    expect(text.querySelector("[data-prose] p")).toHaveTextContent(/^Background: original\.$/);
  });

  it("does not look for an abstract an item does not have, and draws no block for it", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", flags: [{ key: "no-abstract", label: "无摘要" }] }), abstract: null, abstractZh: null });
    show();
    await screen.findByRole("heading", { name: "AI 导读" });
    expect(screen.queryByRole("heading", { name: /^摘要/ })).not.toBeInTheDocument();
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
  });

  it("keeps what the card left out of a paper: its facts, the free full text and what the paper is", async () => {
    client.fetchFrontierItem.mockResolvedValue(frontierItemDetail({ id: "item-1", sourceType: "preprint", evidenceType: "preprint", evidenceTypeLabel: "预印本",
      flags: [{ key: "preprint", label: "预印本 · 未经同行评议" }], facts: { journal: "medRxiv", impact_factor: 78.456 },
      openAccess: { status: "gold", pdfUrl: "https://europepmc.org/articles/PMC1/pdf" }, abstract: "Abstract.", abstractZh: "中文摘要。" }));
    show();
    await screen.findByText("中文摘要。");
    for (const text of ["期刊", "medRxiv", "影响因子", "78.5", "预印本 · 未经同行评议"]) expect(document.body).toHaveTextContent(text);
    expect(screen.getByRole("link", { name: "免费全文" })).toHaveAttribute("href", "https://europepmc.org/articles/PMC1/pdf");
  });

  it("says a retraction in the safety colour over the text", async () => {
    client.fetchFrontierItem.mockResolvedValue(frontierItemDetail({ id: "item-1", flags: [{ key: "retracted", label: "已撤稿" }] }));
    show();
    const tag = await screen.findByText("已撤稿");
    expect(tag).toHaveAttribute("data-tag");
    expect(tag.className).toContain("text-danger-strong");
  });
});

describe("an X post with every block", () => {
  beforeEach(() => { client.fetchFrontierItem.mockResolvedValue(detail(rawXPost())); });

  it("reads like AIHOT's detail page: byline, AI 导读, 正文 · AI 翻译, pictures, the quoted post, 来源, 事件后续 and the right column", async () => {
    wide();
    show("/app/frontier/items/x-post-0001");
    await screen.findByRole("heading", { name: "正文 · AI 翻译" });
    const article = screen.getByRole("article", { name: "正文" });
    // Who said it, the handle, the platform, when — over the title, on the text's own edge.
    const byline = screen.getAllByText("@arena")[0].closest("div")!;
    expect(byline).toHaveTextContent(/Arena\.ai·@arena·X·.+·2 天前/);
    expect(byline.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(article).getByRole("link", { name: "在 X 查看原帖" })).toHaveAttribute("href", "https://x.com/arena/status/1");
    expect(screen.getByText(/基于超 7\.5K 真实会话净提升/)).toBeInTheDocument();
    expect(screen.getByText(/它以综合第 11 名的成绩上榜/)).toBeInTheDocument();
    // Two pictures, from this deployment's proxy.
    const pictures = screen.getAllByRole("button", { name: /^查看大图/ });
    expect(pictures).toHaveLength(2);
    expect(pictures[0].querySelector("img")).toHaveAttribute("src", `/api/frontier/media/${"a".repeat(64)}`);
    // The quoted post: who, the translation, the original a press away, and the way to it.
    const quote = screen.getByText(/激动人心的消息/).closest("figure")!;
    expect(within(quote).getByText("引用")).toBeInTheDocument();
    expect(within(quote).getByText("@arena")).toBeInTheDocument();
    expect(within(quote).getByText("原文")).toBeInTheDocument();
    expect(within(quote).getByRole("link", { name: "在 X 查看被引用的帖子" })).toHaveAttribute("href", "https://x.com/arena/status/0");
    expect(article).toHaveTextContent("来源：Arena.ai· x.com");
    // 事件后续 · 2, each row its own article, with the way to the whole event.
    const followups = screen.getByRole("region", { name: "事件后续 · 2" });
    expect(within(followups).getByRole("link", { name: "查看事件全部 ›" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    const rows = within(followups).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^(后续|同事件)$/).textContent)).toEqual(["后续", "同事件"]);
    expect(within(rows[0]).getByRole("link")).toHaveAttribute("href", "/app/frontier/items/f-1");
    expect(rows[0]).toHaveTextContent("Artificial Analysis · 2 天前");
    // The right column: 推荐理由 with 精选, 「AI 评分」, its four parts and the reason; then 标签, every chip a link. No 主题.
    const notes = screen.getByRole("complementary", { name: "文章操作与推荐" });
    const reason = within(notes).getByRole("region", { name: "推荐理由" });
    expect(reason).toHaveTextContent("精选");
    expect(reason).toHaveTextContent("AI 评分 74");
    expect(reason).toHaveTextContent("实践影响22/30权威性22/30新颖性16/20国内相关性14/20");
    expect(reason).toHaveTextContent("读者可据此权衡 Agent 场景的性价比");
    expect(within(notes).queryByRole("region", { name: "主题" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Agent 智能体");
    const tags = within(within(notes).getByRole("region", { name: "标签" })).getAllByRole("link");
    expect(tags.map((tag) => [tag.textContent, tag.getAttribute("href")])).toEqual([
      ["#评测/基准", "/app/frontier?view=all&tag=benchmarks"], ["#Agent", "/app/frontier?view=all&tag=agent"], ["#DeepSeek", "/app/frontier?view=all&tag=deepseek"],
    ]);
    expectComposed(document.body, { tablists: 0, stepRail: false });
  });

  it("puts the actions at the head of the right column, its top on the back row: 「在 X 查看原帖 ↗」 with ☆ and ⋯, then 深入研究", async () => {
    wide();
    show("/app/frontier/items/x-post-0001");
    const rail = await screen.findByRole("complementary", { name: "文章操作与推荐" });
    const controls = within(rail).getAllByRole("link").concat(within(rail).getAllByRole("button"));
    expect(within(rail).getAllByRole("link")[0]).toHaveAccessibleName("在 X 查看原帖");
    expect(within(rail).getAllByRole("link")[0]).toHaveAttribute("href", "https://x.com/arena/status/1");
    expect(within(rail).getAllByRole("button").slice(0, 3).map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["收藏", "更多操作", "深入研究"]);
    expect(controls.length).toBeGreaterThan(3);
    // The rail is the column beside the page, from the back row down; the blocks follow in their order.
    const blocks = within(rail).getAllByRole("region").map((region) => region.getAttribute("aria-label")
      ?? (region.getAttribute("aria-labelledby") && document.getElementById(region.getAttribute("aria-labelledby")!)!.textContent));
    // The actions are a section of their own, so ☆ and ⋯ belong to the article and not to a list in its text.
    expect(blocks).toEqual(["文章操作", "就此提问", "推荐理由", "标签"]);
    expect(rail.parentElement!.firstElementChild).toContainElement(screen.getByRole("navigation", { name: "返回" }));
    // No bar at the window's bottom where the column is there.
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).not.toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: "深入研究" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/chat");
  });

  it("on a narrow screen puts the actions in a bar at the window's bottom and the notes under the text", async () => {
    client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: true });
    show("/app/frontier/items/x-post-0001");
    const bar = await screen.findByRole("navigation", { name: "阅读工具" });
    expect(bar).toHaveClass("fixed", "bottom-0");
    expect(within(bar).getByRole("link", { name: "查看原帖" })).toHaveAttribute("href", "https://x.com/arena/status/1");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    const article = screen.getByRole("article", { name: "正文" });
    expect(within(article).getByRole("region", { name: "推荐理由" })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "收藏" }));
    await waitFor(() => expect(within(bar).getByRole("button", { name: "已收藏" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(within(bar).getByRole("button", { name: "更多" }));
    expect((await screen.findAllByRole("menuitem")).map((entry) => entry.textContent)).toContain("复制为 Markdown");
  });

  it("reads the original, quoted post included, on 原文", async () => {
    show("/app/frontier/items/x-post-0001");
    await userEvent.click(within(await screen.findByRole("group", { name: "正文语言" })).getByRole("button", { name: "原文" }));
    expect(screen.getByRole("heading", { name: "正文 · 原文" })).toBeInTheDocument();
    expect(screen.getByText(/It lands at #11 overall/).closest("[lang]")).toHaveAttribute("lang", "en");
    expect(screen.getByText(/Exciting news: DeepSeek/)).toBeInTheDocument();
    expect(screen.queryByText(/激动人心的消息/)).not.toBeInTheDocument();
  });

  it("opens a picture in the viewer, steps through them with the arrow keys and closes on Escape", async () => {
    show("/app/frontier/items/x-post-0001");
    const tile = (await screen.findAllByRole("button", { name: /^查看大图/ }))[0];
    await userEvent.click(tile);
    const viewer = screen.getByRole("dialog", { name: "图片 1 / 2" });
    expect(within(viewer).getByRole("img")).toHaveAttribute("alt", "Agent Arena 排行榜");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "图片 2 / 2" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves out a picture this deployment can no longer serve", async () => {
    show("/app/frontier/items/x-post-0001");
    const tiles = await screen.findAllByRole("button", { name: /^查看大图/ });
    act(() => { fireEvent.error(tiles[1].querySelector("img")!); });
    expect(screen.getAllByRole("button", { name: /^查看大图/ })).toHaveLength(1);
  });

  it("says once that a translation is partial, with the way to the whole original", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ body: { zh: "只译了第一段。", original: "First.\n\nSecond.", zhKind: "translation", complete: false } })));
    show("/app/frontier/items/x-post-0001");
    expect(await screen.findByText("译文尚不完整")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看原文" }));
    expect(screen.getByText("Second.")).toBeInTheDocument();
    expect(screen.queryByText("译文尚不完整")).not.toBeInTheDocument();
  });

  it("shows a post whole, however long: the post is the item (ct-write W6)", async () => {
    const paragraph = "这是很长的一段正文。".repeat(40);
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ body: { zh: Array.from({ length: 12 }, (_, index) => `段落${index + 1}：${paragraph}`).join("\n\n"), original: null, zhKind: "translation", complete: true } })));
    show("/app/frontier/items/x-post-0001");
    await screen.findByText(/^段落1：/);
    expect(screen.getByText(/^段落12：/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开全文" })).not.toBeInTheDocument();
  });

  it("is the other report of a selected occurrence: one line to the selected one, and no 推荐理由", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ sameEvent: { itemId: "sel-1", title: "精选收录的那一篇" } })));
    show("/app/frontier/items/x-post-0001");
    const line = await screen.findByText(/同一件事，精选收录的是/);
    expect(within(line).getByRole("link", { name: "《精选收录的那一篇》" })).toHaveAttribute("href", "/app/frontier/items/sel-1");
    expect(screen.queryByRole("region", { name: "推荐理由" })).not.toBeInTheDocument();
    expect(screen.queryByText("AI 评分 74")).not.toBeInTheDocument();
  });

  it("keeps the item's actions: 收藏, 不感兴趣 and following its source in ⋯, and 深入研究 a button of its own", async () => {
    wide();
    client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: true });
    client.hideFrontierItem.mockResolvedValue({ starred: true, hidden: true, read: true });
    client.addFrontierFollow.mockResolvedValue({ id: "9", kind: "source", key: "x-arena", label: "Arena.ai", muted: false });
    show("/app/frontier/items/x-post-0001");
    const star = await screen.findByRole("button", { name: "收藏" });
    await userEvent.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const entries = (await screen.findAllByRole("menuitem")).map((entry) => entry.textContent);
    expect(entries).toEqual(expect.arrayContaining(["整理为证据卡片", "复制为 Markdown", "不感兴趣", "关注 Arena.ai"]));
    expect(entries).not.toContain("深入研究");
    await userEvent.click(screen.getByRole("menuitem", { name: "关注 Arena.ai" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: "x-arena", label: "Arena.ai", muted: false });
  });
});

describe("不感兴趣 on the reading page asks why first (c2-hide)", () => {
  async function chooseHide() {
    show("/app/frontier/items/x-post-0001");
    render(<Toaster />);
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    return screen.findByRole("menu", { name: "不感兴趣的原因" });
  }
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    wide();
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost()));
    client.hideFrontierItem.mockResolvedValue({ starred: false, hidden: true, read: true });
    client.unhideFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: true });
  });

  it("opens the reasons — the same words — instead of hiding at once", async () => {
    const menu = await chooseHide();
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      "与我无关", "看过了", "内容质量不高", "像广告或软文", "不是我的专科", expect.stringMatching(/^不想看“.+”$/), "不说原因，直接隐藏"]);
    expect(client.hideFrontierItem).not.toHaveBeenCalled();
  });

  it("hides with the reason chosen and shows the toast, whose 撤销 unhides", async () => {
    const menu = await chooseHide();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "看过了" }));
    await waitFor(() => expect(client.hideFrontierItem).toHaveBeenCalledWith("x-post-0001", "already-seen"));
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    const toast = await screen.findByText("已隐藏");
    expect(toast).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(client.unhideFrontierItem).toHaveBeenCalledWith("x-post-0001"));
  });

  it("hides with no reason on 「不说原因，直接隐藏」", async () => {
    const menu = await chooseHide();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "不说原因，直接隐藏" }));
    await waitFor(() => expect(client.hideFrontierItem).toHaveBeenCalledWith("x-post-0001", undefined));
    expect(await screen.findByText("已隐藏")).toBeInTheDocument();
  });

  it("hides nothing when the reasons are dismissed, and opens them again on the next 不感兴趣", async () => {
    await chooseHide();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "不感兴趣的原因" })).not.toBeInTheDocument());
    expect(client.hideFrontierItem).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    expect(await screen.findByRole("menu", { name: "不感兴趣的原因" })).toBeInTheDocument();
  });

  it("mutes the source for its own reason, and 撤销 takes the mute back with the hide", async () => {
    client.listFrontierFollows.mockResolvedValue([]);
    client.addFrontierFollow.mockResolvedValue({ id: "21", kind: "source", key: "x-arena", label: "Arena.ai", muted: true });
    client.removeFrontierFollow.mockResolvedValue(undefined);
    const menu = await chooseHide();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "不想看“Arena.ai”" }));
    await waitFor(() => expect(client.hideFrontierItem).toHaveBeenCalledWith("x-post-0001", "source"));
    await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: "x-arena", label: "Arena.ai", muted: true }));
    expect(await screen.findByText("已隐藏，并屏蔽该来源")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(client.removeFrontierFollow).toHaveBeenCalledWith("21"));
    expect(client.unhideFrontierItem).toHaveBeenCalledWith("x-post-0001");
  });
});

describe("不感兴趣 on a phone's reading page (c2-hide)", () => {
  it("opens the reasons beside the bar at the window's bottom", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost()));
    show("/app/frontier/items/x-post-0001");
    await userEvent.click(await screen.findByRole("button", { name: "更多" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    const menu = await screen.findByRole("menu", { name: "不感兴趣的原因" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(7);
    expect(client.hideFrontierItem).not.toHaveBeenCalled();
  });
});

describe("an open-access paper with its whole text", () => {
  beforeEach(() => { client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper())); });

  it("sets the 导读 as the lead, a size above the text, and then the 解读, both before the text", async () => {
    show("/app/frontier/items/oa-paper-1");
    const text = await screen.findByRole("region", { name: "全文 · AI 翻译" });
    const lead = screen.getByRole("region", { name: "AI 导读" });
    const insight = screen.getByRole("region", { name: "AI 解读" });
    // One paragraph each, the 导读 a step above the text: 18 / 20 where the text is 16 / 18 (below and from 1280 px), all at 1.8.
    expect(within(lead).getByText(/口服 PCSK9 抑制剂使主要心血管事件风险降低 18%/)).toHaveClass("text-reading-lg", "xl:text-reading-xl");
    expect(text.querySelector("[data-prose]")).toHaveClass("text-reading", "xl:text-reading-lg", "space-y-5", "max-w-measure-body", "xl:max-w-read");
    expect(lead.compareDocumentPosition(insight) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(insight.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links each report the 解读 cites to its own article by its title, lists them under it, and leaves an unnamed [n] as text", async () => {
    show("/app/frontier/items/oa-paper-1");
    const insight = await screen.findByRole("region", { name: "AI 解读" });
    const paragraph = insight.querySelector("p")!;
    const cites = within(paragraph).getAllByRole("link");
    expect(cites.map((link) => [link.textContent, link.getAttribute("aria-label"), link.getAttribute("href")])).toEqual([
      ["[1]", "MedPage Today：口服 PCSK9 抑制剂降低心血管事件 18%", "/app/frontier/items/f-2"],
      ["[2]", "FDA 受理口服 PCSK9 抑制剂的上市申请", "/app/frontier/items/f-1"],
    ]);
    expect(cites.every((link) => link.parentElement!.tagName === "SUP")).toBe(true);
    // The marker's size is a step of the scale, not the base sheet's 75% of the paragraph (13.5 px beside an 18 px text).
    expect(cites.every((link) => link.parentElement!.classList.contains("text-caption"))).toBe(true);
    // [3] names no report: it stays the words it is.
    expect(paragraph).toHaveTextContent("还要看后续数据[3]。");
    const rows = within(within(insight).getByRole("list", { name: "解读引用的报道" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^1MedPage Today：口服 PCSK9 抑制剂降低心血管事件 18%MedPage Today · 4 小时前/),
      expect.stringMatching(/^2FDA 受理口服 PCSK9 抑制剂的上市申请FDA · 2 天前/),
    ]);
    expect(within(rows[1]).getByRole("link")).toHaveAttribute("href", "/app/frontier/items/f-1");
  });

  it("opens a cited report as its own article, whose way back returns to this one", async () => {
    client.fetchFrontierItem.mockImplementation(async (id: string) => (id === "f-1"
      ? detail(rawXPost({ id: "f-1", title: "FDA 受理口服 PCSK9 抑制剂的上市申请", followups: null }))
      : detail(rawOpenAccessPaper())));
    show("/app/frontier/items/oa-paper-1");
    const insight = await screen.findByRole("region", { name: "AI 解读" });
    await userEvent.click(within(insight.querySelector("p")!).getByRole("link", { name: "FDA 受理口服 PCSK9 抑制剂的上市申请" }));
    expect(await screen.findByRole("heading", { level: 1, name: "FDA 受理口服 PCSK9 抑制剂的上市申请" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link")).toHaveTextContent("口服 PCSK9 抑制剂降低主要心血管事件");
  });

  it("sets the full text's sections as headings, in Chinese and in the original", async () => {
    show("/app/frontier/items/oa-paper-1");
    const text = await screen.findByRole("region", { name: "全文 · AI 翻译" });
    // A paper's full text is folded to its preview under the 导读 and 要点 (ct-write W6): its first section, then 展开全文.
    expect(within(text).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["引言"]);
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect(within(text).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["引言", "方法", "结果", "讨论"]);
    expect(text).not.toHaveTextContent("##");
    await userEvent.click(within(screen.getByRole("group", { name: "全文语言" })).getByRole("button", { name: "原文" }));
    const original = screen.getByRole("region", { name: "全文 · 原文" });
    expect(within(original).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Introduction", "Methods", "Results", "Discussion"]);
    expect(within(original).getByRole("heading", { name: "Methods" }).closest("[lang]")).toHaveAttribute("lang", "en");
  });

  it("folds a long full text to its first section's opening: a heading is never the last line before 展开全文", async () => {
    const section = (index: number) => `## 第 ${index} 节\n\n${"这是一段很长的正文。".repeat(30)}`;
    client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper({ body: { zh: Array.from({ length: 12 }, (_, index) => section(index + 1)).join("\n\n"),
      original: null, zhKind: "original-zh", complete: true, source: "body" } })));
    show("/app/frontier/items/oa-paper-1");
    const text = await screen.findByRole("region", { name: "全文" });
    const prose = text.querySelector("[data-prose]")!;
    expect(prose.lastElementChild!.tagName).toBe("P");
    expect(prose.lastElementChild).toHaveClass("line-clamp-4");
    expect(within(text).queryByRole("heading", { name: "第 2 节" })).not.toBeInTheDocument();
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect(within(text).getByRole("heading", { name: "第 12 节" })).toBeInTheDocument();
  });
});

describe("a paper whose text is its structured abstract", () => {
  beforeEach(() => { client.fetchFrontierItem.mockResolvedValue(detail(rawStructuredAbstract())); });

  it("names the text 摘要 and sets each paragraph's own heading in 600, in Chinese and in the original", async () => {
    show("/app/frontier/items/abstract-1");
    const text = await screen.findByRole("region", { name: "摘要 · AI 翻译" });
    // Folded to its first paragraph under the 导读 and 要点 (ct-write W6), the rest a press away.
    expect([...text.querySelectorAll("[data-prose] p > span")].map((head) => head.textContent)).toEqual(["背景："]);
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    const heads = [...text.querySelectorAll("[data-prose] p > span")];
    expect(heads.map((head) => [head.textContent, head.className])).toEqual([["背景：", "font-semibold"], ["方法：", "font-semibold"], ["结果：", "font-semibold"]]);
    // The colon inside a sentence (「95% CI：」) is not a heading's.
    expect(text).toHaveTextContent("（风险比 0.82；95% CI：0.75–0.90）");
    await userEvent.click(within(screen.getByRole("group", { name: "摘要语言" })).getByRole("button", { name: "原文" }));
    const original = screen.getByRole("region", { name: "摘要 · 原文" });
    expect([...original.querySelectorAll("[data-prose] p > span")].map((head) => head.textContent)).toEqual(["Background:", "Methods:", "Results:"]);
    expect(original.querySelector("[data-prose] p")).toHaveTextContent(/^Background: Oral PCSK9/);
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
  });

  it("sets no run-in heading in an article's own text, whatever its first words", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawChineseNews({ body: { zh: "变化一：降压目标值收紧。", original: null, zhKind: "original-zh", complete: true, source: "body" } })));
    show("/app/frontier/items/cn-news-0001");
    const text = await screen.findByRole("region", { name: "正文" });
    expect(text.querySelector("[data-prose] p > span")).toBeNull();
    expect(text).toHaveTextContent("变化一：降压目标值收紧。");
  });

  it("runs the headings in where the abstract stands in for a missing text too", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1" }), abstract: "Background: original.\n\nMethods: a trial.", abstractZh: "背景：原文。\n\n方法：一项试验。" });
    show();
    const text = await screen.findByRole("region", { name: "摘要 · AI 翻译" });
    await userEvent.click(within(text).getByRole("button", { name: "展开全文" }));
    expect([...text.querySelectorAll("[data-prose] p > span")].map((head) => head.textContent)).toEqual(["背景：", "方法："]);
  });
});

describe("a Chinese news article", () => {
  it("has its text in Chinese and no switch, its author beside its institution, and a specialty topic that narrows the feed", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawChineseNews()));
    show("/app/frontier/items/cn-news-0001");
    expect(await screen.findByRole("heading", { name: "正文" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正文语言" })).not.toBeInTheDocument();
    expect(screen.getByText("王编辑").closest("div")).toHaveTextContent(/医脉通·王编辑·/);
    expect(within(screen.getByRole("article", { name: "正文" })).getByRole("link", { name: "打开原文" })).toBeInTheDocument();
    // A score without a reason is 「AI 评分」 alone; 精选 only where the item is selected.
    const verdict = screen.getByRole("region", { name: "AI 评分" });
    expect(verdict).toHaveTextContent("AI 评分 58");
    expect(verdict).not.toHaveTextContent("精选");
    const specialty = within(screen.getByRole("region", { name: "专科" })).getByRole("link", { name: "内分泌代谢" });
    expect(specialty).toHaveAttribute("href", "/app/frontier?view=all&specialty=endocrinology");
    expect(screen.queryByRole("region", { name: "主题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "标签" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /事件后续/ })).not.toBeInTheDocument();
    // A 导读 and no 解读: the block is not drawn for an item the server wrote none for.
    expect(screen.getByRole("region", { name: "AI 导读" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI 解读" })).not.toBeInTheDocument();
  });
});

describe("an item whose blocks the server could not fill", () => {
  it("leaves each block out rather than drawing it empty or guessing it", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ lead: null, summary: null, reason: null, score: null, body: null, media: [], quoted: null,
      topics: [], tags: [], followups: null, author: null, platform: null, channel: null, abstract: null, abstractZh: null, flags: [{ key: "no-abstract", label: "无摘要" }], selected: false })));
    show("/app/frontier/items/x-post-0001");
    await screen.findByRole("heading", { level: 1 });
    for (const name of [/AI 导读/, /AI 解读/, /^正文/, /^摘要/, /事件后续/, "推荐理由", "AI 评分", "主题", "专科", "标签", "本文目录"]) {
      expect(screen.queryByRole("heading", { name }), String(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /^查看大图/ })).not.toBeInTheDocument();
    expect(screen.queryByText("引用")).not.toBeInTheDocument();
    // What is left: who said it, where it came from, and the way to the original.
    expect(screen.getByRole("article", { name: "正文" })).toHaveTextContent("来源：Arena.ai");
    expect(within(screen.getByRole("article", { name: "正文" })).getByRole("link", { name: "打开原文" })).toBeInTheDocument();
  });

  it("says nothing of why a Chinese headline and guide are missing: the source headline and one plain way to the source (G5, 2026-10-25)", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1",
      title: "Original source headline", titleRaw: "Original source headline", titleZh: null, summary: null, lead: null,
      verification: "title-only", editorDiagnostics: { schemaVersion: 1, outcome: "title-only", attempts: 2,
        inputSha256: "a".repeat(64), editorVersion: "editor-test", checkedAt: "2026-10-20T00:00:00.000Z",
        reason: null, fields: { title_zh: ["language"], summary_zh: ["number"] } } }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByRole("heading", { name: "Original source headline", level: 1 })).toBeInTheDocument();
    // Nothing about the checking: no number that did not match, no check not finished, no cause at all.
    expect(document.body).not.toHaveTextContent(/未能|暂不展示|尚未完成|暂缺|暂未|保留原标题|核对|editor-test/);
    expect(document.querySelector("[data-note]")).toBeNull();
    const source = screen.getByRole("link", { name: "阅读来源" });
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("href", "https://www.nejm.org/doi/full/10.1056/example");
  });

  it.each([
    ["source_missing", "pending"],
    ["not_checked", "pending"],
    ["number", "title-only"],
  ])("offers only the way to the source for %s, without inventing Chinese content or explaining it", async (code, verification) => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", title: "Source headline", titleRaw: "Source headline",
      titleZh: null, summary: null, lead: null, verification,
      editorDiagnostics: { schemaVersion: 1, outcome: verification, attempts: 0, inputSha256: null,
        editorVersion: null, checkedAt: "2026-10-20T00:00:00Z", reason: null, fields: { title_zh: ["not_checked"], summary_zh: [code] } } }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByRole("heading", { name: "Source headline", level: 1 })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/来源暂未提供|暂未完成|数字未能|导读暂缺/);
    expect(screen.getByRole("link", { name: "阅读来源" })).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("heading", { name: "AI 导读" })).not.toBeInTheDocument();
  });

  it("has no note and no 「阅读来源」 beside a Chinese title, whatever the checks said before — and no old record's cause either", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", summary: null, lead: null, verification: "title-only",
      editorDiagnostics: { schemaVersion: 1, outcome: "title-only", attempts: 2, inputSha256: null, editorVersion: null, checkedAt: "2026-10-20T00:00:00Z",
        reason: null, fields: { title_zh: ["passed"], summary_zh: ["number"] } } }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByRole("heading", { name: "口服 PCSK9 抑制剂降低主要心血管事件", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "阅读来源" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/数字未能与来源对应|中文导读暂缺/);
  });

  it("shows the card's own summary as the first block while no 导读 was written (G2: a record with no text still reads)", async () => {
    // The server sends the card's summary as `lead` until a 导读 exists, and the page sets it first, labelled 「AI 导读」.
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", summary: "FDA 批准 JEMPERLI 的补充申请，审评类别为标准审评。",
      lead: "FDA 批准 JEMPERLI 的补充申请，审评类别为标准审评。", brief: null, insight: null, body: null, flags: [] }), abstract: null, abstractZh: null });
    show();
    const lead = await screen.findByRole("region", { name: "AI 导读" });
    expect(within(lead).getByText("FDA 批准 JEMPERLI 的补充申请，审评类别为标准审评。")).toBeInTheDocument();
    expect(screen.queryByText("摘要")).not.toBeInTheDocument();
  });
});

describe("the page's states and its way back", () => {
  it("offers retry for a failed direct read", async () => {
    client.fetchFrontierItem.mockRejectedValueOnce(new Error("offline"));
    show();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByText("已保存的中文摘要")).toBeInTheDocument();
  });

  it("distinguishes an unavailable article", async () => {
    client.fetchFrontierItem.mockRejectedValue(new WebApiError("missing", { status: 404, code: "frontier_item_not_found" }));
    show();
    expect(await screen.findByText("这条动态已下架，不再提供。")).toBeInTheDocument();
  });

  it("does not fetch an article when the module is off", () => {
    client.useFrontierFeature.mockReturnValue("off");
    show();
    expect(client.fetchFrontierItem).not.toHaveBeenCalled();
  });

  it("returns to the exact existing feed history entry and its reading position", async () => {
    const reading = { query: "view=all&lane=safety", pages: 3, scroll: 640, expanded: ["item-1"] };
    function Feed() { const location = useLocation(); return <pre data-testid="restored">{JSON.stringify({ search: location.search, state: location.state })}</pre>; }
    render(<MemoryRouter initialIndex={1} initialEntries={[
      { pathname: "/app/frontier", search: "?view=all&lane=safety", state: { frontierReading: reading } },
      { pathname: "/app/frontier/items/item-1", state: { evidenceFrom: { to: "/app/frontier?view=all&lane=safety", label: "前沿动态" } } },
    ]}><Routes><Route path="/app/frontier" element={<Feed />} /><Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} /></Routes></MemoryRouter>);
    await screen.findByText("已保存的中文摘要");
    await userEvent.click(screen.getByRole("link", { name: "前沿动态" }));
    expect(JSON.parse(screen.getByTestId("restored").textContent!)).toEqual({ search: "?view=all&lane=safety", state: { frontierReading: reading } });
  });

  it("opens a follow-up as its own article, whose way back returns to this one", async () => {
    client.fetchFrontierItem.mockImplementation(async (id: string) => (id === "f-1"
      ? detail(rawXPost({ id: "f-1", title: "后续那一篇", followups: null }))
      : detail(rawXPost())));
    show("/app/frontier/items/x-post-0001");
    await userEvent.click(within(await screen.findByRole("region", { name: "事件后续 · 2" })).getAllByRole("link")[1]);
    expect(await screen.findByRole("heading", { level: 1, name: "后续那一篇" })).toBeInTheDocument();
    const back = within(screen.getByRole("navigation", { name: "返回" })).getByRole("link");
    expect(back).toHaveTextContent("Arena：DeepSeek-V4.1-Flash 登顶 Agent Arena 开源榜首");
    await userEvent.click(back);
    expect(await screen.findByRole("heading", { level: 1, name: "Arena：DeepSeek-V4.1-Flash 登顶 Agent Arena 开源榜首" })).toBeInTheDocument();
  });
});

describe("the text's addresses, lists and contents (2026-10-23)", () => {
  it("draws a bare address as its site and the start of its path, the whole address its description, and leaves the item's own out", async () => {
    const long = "https://www.fda.gov/vaccines-blood-biologics/safety-availability-biologics/important-information";
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ body: {
      zh: `详见 ${long}。\n\n（美国FDA网站）\n\n原文链接：\n\nhttps://www.fda.gov/news/x\n\nhttps://x.com/arena/status/1\n\n1. 第一项\n2. 第二项\n\n> 一段引文`,
      original: null, zhKind: "original-zh", complete: true,
    } })));
    show("/app/frontier/items/x-post-0001");
    const text = await screen.findByRole("region", { name: "正文" });
    const prose = text.querySelector("[data-prose]") as HTMLElement;
    const link = within(prose).getByRole("link", { name: "fda.gov/vaccines-blood-biologics/…" });
    expect(link).toHaveAttribute("href", long);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAccessibleDescription(long);
    expect(link).toHaveClass("text-accent");
    expect(link.parentElement).toHaveTextContent(`详见 fda.gov/vaccines-blood-biologics/… ↗。`);
    // The address and the two short lines before it: one small line.
    const source = within(prose).getByRole("link", { name: "fda.gov/news/x" }).closest("p")!;
    expect(source).toHaveClass("text-caption", "text-text-3");
    expect(source).toHaveTextContent("（美国FDA网站） 原文链接： fda.gov/news/x ↗");
    // The item's own address is the end row's, not the text's.
    expect(within(prose).queryByRole("link", { name: /x\.com/ })).not.toBeInTheDocument();
    expect(within(prose).getByRole("list")).toHaveTextContent("第一项第二项");
    expect(prose.querySelector("ol")).toHaveAttribute("start", "1");
    expect(prose.querySelector("blockquote")).toHaveTextContent("一段引文");
  });

  it("lists the contents in the right column at three sections or more, each a press away, and the one asked for marked", async () => {
    wide();
    client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper()));
    show("/app/frontier/items/oa-paper-1");
    const rail = await screen.findByRole("complementary", { name: "文章操作与推荐" });
    const contents = within(rail).getByRole("navigation", { name: "本文目录" });
    expect(within(contents).getAllByRole("button").map((entry) => entry.textContent)).toEqual(["引言", "方法", "结果", "讨论"]);
    await userEvent.click(within(contents).getByRole("button", { name: "结果" }));
    expect(within(contents).getByRole("button", { name: "结果" })).toHaveAttribute("aria-current", "location");
    // The ids are the text's own headings'.
    const heading = screen.getByRole("heading", { level: 3, name: "结果" });
    expect(heading.id).toMatch(/-sec-3$/);
  });

  it("opens a long text's folded rest from the contents, to the section asked for", async () => {
    wide();
    const section = (index: number) => `## 第 ${index} 节\n\n${"这是一段很长的正文。".repeat(30)}`;
    client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper({ body: { zh: Array.from({ length: 12 }, (_, index) => section(index + 1)).join("\n\n"),
      original: null, zhKind: "original-zh", complete: true, source: "body" } })));
    show("/app/frontier/items/oa-paper-1");
    const contents = await screen.findByRole("navigation", { name: "本文目录" });
    expect(screen.queryByRole("heading", { level: 3, name: "第 12 节" })).not.toBeInTheDocument();
    await userEvent.click(within(contents).getByRole("button", { name: "第 12 节" }));
    expect(await screen.findByRole("heading", { level: 3, name: "第 12 节" })).toBeInTheDocument();
    await waitFor(() => expect(within(contents).getByRole("button", { name: "第 12 节" })).toHaveAttribute("aria-current", "location"));
  });

  it("has no contents under three sections", async () => {
    wide();
    client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper({ body: { zh: "## 方法\n\n一。\n\n## 结果\n\n二。", original: null, zhKind: "original-zh", complete: true, source: "body" } })));
    show("/app/frontier/items/oa-paper-1");
    await screen.findByRole("heading", { level: 3, name: "方法" });
    expect(screen.queryByRole("navigation", { name: "本文目录" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-outline]")).toBeNull();
  });

  it("folds the contents above the text on a narrow screen", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawOpenAccessPaper()));
    show("/app/frontier/items/oa-paper-1");
    const text = await screen.findByRole("region", { name: "全文 · AI 翻译" });
    const outline = document.querySelector("[data-outline]") as HTMLElement;
    expect(outline).toHaveTextContent("目录 · 4 节");
    expect(outline.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
