import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { parseFrontierItemDetail } from "@/lib/frontierClient";
import { frontierItemDetail, rawChineseNews, rawXPost } from "@/components/frontier/__fixtures__/frontierItems";
import { expectComposed } from "@/test/expectComposed";
import { FrontierArticlePage } from "./FrontierArticlePage";
const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
  starFrontierItem: vi.fn(), unstarFrontierItem: vi.fn(), hideFrontierItem: vi.fn(), addFrontierFollow: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));
const detail = (raw: Record<string, unknown>) => parseFrontierItemDetail(raw)!;
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1" }), abstract: "Original abstract", abstractZh: "已保存的中文摘要" });
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
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
    const original = screen.getByRole("link", { name: "查看原文" });
    expect(original).toHaveAttribute("href", "https://www.nejm.org/doi/full/10.1056/example");
    expect(original).toHaveAttribute("target", "_blank");
    expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
    expect(client.markFrontierItemRead).toHaveBeenCalled();
    // The header holds the title and the item's actions, nothing else: one link-button, 收藏 and ⋯.
    expectComposed(document.body, { tablists: 0, stepRail: false, toolbar: false });
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["收藏", "更多操作"]);
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
    expect(await screen.findByText("Background: original.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "摘要 · 原文" })).toBeInTheDocument();
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
    show("/app/frontier/items/x-post-0001");
    await screen.findByRole("heading", { name: "正文 · AI 翻译" });
    const article = screen.getByRole("article", { name: "正文" });
    // Who said it, the handle, the platform, when.
    expect(article).toHaveTextContent(/Arena\.ai·@arena·X·.+·2 天前/);
    expect(screen.getByRole("link", { name: "在 X 查看原帖" })).toHaveAttribute("href", "https://x.com/arena/status/1");
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
    // The right column: 推荐理由 with 精选 and AI 评分, then 主题 and 标签 — none of them a control but a specialty.
    const notes = screen.getByRole("complementary", { name: "推荐与主题" });
    const reason = within(notes).getByRole("region", { name: "推荐理由" });
    expect(reason).toHaveTextContent("精选");
    expect(reason).toHaveTextContent("AI 评分 74");
    expect(reason).toHaveTextContent("读者可据此权衡 Agent 场景的性价比");
    expect(within(within(notes).getByRole("region", { name: "主题" })).getAllByText(/DeepSeek|Agent 智能体|评测基准/)).toHaveLength(3);
    expect(within(within(notes).getByRole("region", { name: "主题" })).queryAllByRole("link")).toEqual([]);
    expect(within(within(notes).getByRole("region", { name: "标签" })).getAllByText(/^#/).map((tag) => tag.textContent)).toEqual(["#评测/基准", "#Agent", "#DeepSeek"]);
    expectComposed(document.body, { tablists: 0, stepRail: false });
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

  it("opens a long text at its first paragraphs, and the rest in place", async () => {
    const paragraph = "这是很长的一段正文。".repeat(40);
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ body: { zh: Array.from({ length: 12 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n\n"), original: null, zhKind: "translation", complete: true } })));
    show("/app/frontier/items/x-post-0001");
    await screen.findByText(/^1\. /);
    expect(screen.queryByText(/^12\. /)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(screen.getByText(/^12\. /)).toBeInTheDocument();
  });

  it("is the other report of a selected occurrence: one line to the selected one, and no 推荐理由", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ sameEvent: { itemId: "sel-1", title: "精选收录的那一篇" } })));
    show("/app/frontier/items/x-post-0001");
    const line = await screen.findByText(/同一件事，精选收录的是/);
    expect(within(line).getByRole("link", { name: "《精选收录的那一篇》" })).toHaveAttribute("href", "/app/frontier/items/sel-1");
    expect(screen.queryByRole("region", { name: "推荐理由" })).not.toBeInTheDocument();
    expect(screen.queryByText("AI 评分 74")).not.toBeInTheDocument();
  });

  it("keeps the item's actions: 收藏, 深入研究, 不感兴趣 and following its source", async () => {
    client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: true });
    client.hideFrontierItem.mockResolvedValue({ starred: true, hidden: true, read: true });
    client.addFrontierFollow.mockResolvedValue({ id: "9", kind: "source", key: "x-arena", label: "Arena.ai", muted: false });
    show("/app/frontier/items/x-post-0001");
    const star = await screen.findByRole("button", { name: "收藏" });
    await userEvent.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect((await screen.findAllByRole("menuitem")).map((entry) => entry.textContent)).toEqual(expect.arrayContaining(["深入研究", "整理为证据卡片", "复制为 Markdown", "不感兴趣", "关注 Arena.ai"]));
    await userEvent.click(screen.getByRole("menuitem", { name: "关注 Arena.ai" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: "x-arena", label: "Arena.ai", muted: false });
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "深入研究" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/chat");
  });
});

describe("a Chinese news article", () => {
  it("has its text in Chinese and no switch, its author beside its institution, and a specialty topic that narrows the feed", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawChineseNews()));
    show("/app/frontier/items/cn-news-0001");
    expect(await screen.findByRole("heading", { name: "正文" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正文语言" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "正文" })).toHaveTextContent(/医脉通·王编辑·/);
    expect(screen.getByRole("link", { name: "查看原文" })).toBeInTheDocument();
    // A score without a reason is 「AI 评分」 alone; 精选 only where the item is selected.
    const verdict = screen.getByRole("region", { name: "AI 评分" });
    expect(verdict).toHaveTextContent("AI 评分 58");
    expect(verdict).not.toHaveTextContent("精选");
    expect(within(screen.getByRole("region", { name: "主题" })).getByRole("link", { name: "内分泌" })).toHaveAttribute("href", "/app/frontier?view=all&specialty=endocrinology");
    expect(screen.queryByRole("region", { name: "标签" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /事件后续/ })).not.toBeInTheDocument();
  });
});

describe("an item whose blocks the server could not fill", () => {
  it("leaves each block out rather than drawing it empty or guessing it", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ lead: null, summary: null, reason: null, score: null, body: null, media: [], quoted: null,
      topics: [], tags: [], followups: null, author: null, platform: null, channel: null, abstract: null, abstractZh: null, flags: [{ key: "no-abstract", label: "无摘要" }], selected: false })));
    show("/app/frontier/items/x-post-0001");
    await screen.findByRole("heading", { level: 1 });
    for (const name of [/AI 导读/, /^正文/, /^摘要/, /事件后续/, "推荐理由", "AI 评分", "主题", "标签"]) {
      expect(screen.queryByRole("heading", { name }), String(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^查看大图/ })).not.toBeInTheDocument();
    expect(screen.queryByText("引用")).not.toBeInTheDocument();
    // What is left: who said it, where it came from, and the way to the original.
    expect(screen.getByRole("article", { name: "正文" })).toHaveTextContent("来源：Arena.ai");
    expect(screen.getByRole("link", { name: "查看原文" })).toBeInTheDocument();
  });

  it("explains a rejected Chinese headline and guide while preserving the source headline", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1",
      title: "Original source headline", titleRaw: "Original source headline", titleZh: null, summary: null,
      verification: "title-only", editorDiagnostics: { schemaVersion: 1, outcome: "title-only", attempts: 2,
        inputSha256: "a".repeat(64), editorVersion: "editor-test", checkedAt: "2026-10-20T00:00:00.000Z",
        reason: null, fields: { title_zh: ["language"], summary_zh: ["number"] } } }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByRole("heading", { name: "Original source headline", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/中文标题未能完整表达来源内容，保留原标题/)).toBeInTheDocument();
    expect(screen.getByText(/导读中的数字未能与来源对应/)).toBeInTheDocument();
    expect(screen.queryByText("editor-test")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "阅读来源" })).toHaveAttribute("target", "_blank");
  });

  it.each([
    ["source_missing", "来源暂未提供可用于导读的摘要或正文"],
    ["not_checked", "中文内容暂未完成"],
  ])("offers source reading for %s without inventing Chinese content", async (code, message) => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", title: "Source headline", titleRaw: "Source headline",
      titleZh: null, summary: null, verification: "pending",
      editorDiagnostics: { schemaVersion: 1, outcome: "pending", attempts: 0, inputSha256: null,
        editorVersion: null, checkedAt: "2026-10-20T00:00:00Z", reason: null, fields: { title_zh: ["not_checked"], summary_zh: [code] } } }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByRole("heading", { name: "Source headline", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "阅读来源" })).toHaveAttribute("target", "_blank");
  });

  it("keeps historical fallback causes unknown", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: "item-1", titleZh: null, summary: null, verification: "title-only", editorDiagnostics: null }), abstract: null, abstractZh: null });
    show();
    expect(await screen.findByText(/目前保留来源标题，中文导读暂缺/)).toBeInTheDocument();
    expect(screen.queryByText(/数字未能与来源对应/)).not.toBeInTheDocument();
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
