import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { FrontierCard } from "./FrontierCard";
import { frontierItem } from "./__fixtures__/frontierItems";

const client = vi.hoisted(() => ({ fetchFrontierAbstractZh: vi.fn(), fetchFrontierItem: vi.fn(), addFrontierFollow: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { kind: string; draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="probe">{location.pathname}{location.search}|{intent?.kind}|{intent?.draft}</div>;
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

const PARTS = { authority: 27, impact: 25, novelty: 18, relevance: 16 };
const scored = (overrides: Record<string, unknown> = {}) => frontierItem({ score: 86, scoreBand: "high", scoreParts: PARTS, ...overrides });

beforeEach(() => {
  client.fetchFrontierAbstractZh.mockReset();
  client.fetchFrontierItem.mockReset();
  useToastStore.setState({ toasts: [] });
});

describe("a card of the platform's own content", () => {
  it("says 「EviMed 出品」 beside the source, and says nothing of the kind on any other card", () => {
    renderCard(scored({ source: { id: "evimed-evidence", name: "EviMed 证据中心", homepage: null, platformProduced: true } }));
    const card = screen.getByRole("article");
    expect(within(card).getByText("EviMed 出品")).toBeInTheDocument();
    expect(within(card).getByText("EviMed 证据中心")).toBeInTheDocument();
  });

  it("is absent from a card of an outside source", () => {
    renderCard(scored());
    expect(screen.queryByText("EviMed 出品")).not.toBeInTheDocument();
  });
});

describe("a card", () => {
  const tagged = (overrides: Record<string, unknown> = {}) => scored({
    tags: [{ slug: "hypercholesterolemia", name: "高胆固醇血症" }, { slug: "pcsk9", name: "PCSK9 抑制剂" }, { slug: "mace", name: "心血管事件" }, { slug: "fourth", name: "第四个" }],
    ...overrides,
  });

  it("says who said it, what it is, and what it says, under a title that is the row's one title, in the brand's deep ink", () => {
    renderCard(tagged({ alsoReportedBy: [{ sourceId: "stat", sourceName: "STAT", url: "https://www.statnews.com/x" }], alsoReportedCount: 3 }));
    const card = screen.getByRole("article", { name: "口服 PCSK9 抑制剂降低主要心血管事件" });
    const title = within(card).getByRole("heading", { level: 3 });
    expect(title).toHaveAttribute("data-row-title");
    expect(within(title).getByRole("link")).toHaveClass("text-title-ink", "group-hover:text-accent");
    for (const text of ["NEJM", "RCT", "多中心双盲试验纳入 12000 例患者。", "另有 3 家报道 ›", "#高胆固醇血症", "#PCSK9 抑制剂", "#心血管事件"]) {
      expect(card).toHaveTextContent(text);
    }
    // Three of its tags at most; the specialties are not tags.
    expect(card).not.toHaveTextContent("#第四个");
    expect(card).not.toHaveTextContent("#心血管 ");
    expect(within(card).getByText("RCT")).toHaveClass("rounded-tag");
  });

  it("says the lane in the eyebrow where it is not a paper", () => {
    renderCard(scored({ evidenceType: null, evidenceTypeLabel: null, lane: "regulatory", laneLabel: "审批监管" }));
    expect(within(screen.getByRole("article")).getByText("审批监管")).toHaveClass("rounded-tag");
  });

  it("carries none of what the plan took off it, and no 展开摘要 or 详情", () => {
    renderCard(scored({ facts: { journal: "The New England Journal of Medicine", impact_factor: 78.5, authors_short: "Ray KK, et al." } }));
    const card = screen.getByRole("article");
    // The reason box, the two folds, the original title, the facts line, the source type and the 精选 chip.
    for (const gone of ["为什么值得看", "首个口服 PCSK9 抑制剂的硬终点证据。", "为什么入选", "评估与核对", "因为你在做",
      "Oral PCSK9 Inhibition and Cardiovascular Outcomes", "影响因子", "Ray KK", "期刊", "精选", "来源权威", "展开摘要", "收起摘要", "详情", "编辑评分"]) {
      expect(card).not.toHaveTextContent(gone);
    }
    // The summary is cut by its lines, two on a phone and three from 640 px: there is nothing to expand.
    expect(within(card).getByText("多中心双盲试验纳入 12000 例患者。")).toHaveClass("line-clamp-2", "sm:line-clamp-3");
  });

  it("puts 「AI 评分」 at the right of the meta row as a pill with its name and its number, in its tier's ground", () => {
    renderCard(scored());
    const pill = within(screen.getByRole("article")).getByRole("button", { name: "AI 评分 86，查看构成" });
    expect(pill).toHaveTextContent(/^AI 评分\s*86$/);
    expect(pill).toHaveAttribute("data-score", "high");
    expect(pill).toHaveClass("bg-accent", "text-accent-fg");
    // ☆ and ⋯ follow it on the same row; a card with no tags and no other reports has no footer line for them.
    const row = pill.closest("div.ml-auto");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "收藏" })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "更多操作" })).toBeInTheDocument();
  });

  it("draws no footer line when there is nothing for it", () => {
    renderCard(scored({ tags: [], alsoReportedCount: 0, alsoReportedBy: [] }));
    const card = screen.getByRole("article");
    expect(within(card).queryByText(/^#/)).not.toBeInTheDocument();
    expect(card.querySelectorAll(":scope > div")).toHaveLength(2);
  });

  it.each([
    ["medium", 74, "bg-accent-soft"],
    ["low", 52, "bg-surface-3"],
  ])("draws a %s score in its own ground", (band, value, ground) => {
    renderCard(scored({ score: value, scoreBand: band, scoreParts: { authority: 20, impact: 20, novelty: (value - 40) / 2, relevance: (value - 40) / 2 } }));
    expect(screen.getByRole("button", { name: `AI 评分 ${value}，查看构成` })).toHaveClass(ground);
  });

  it("is a label and not a control where the server sent no parts", () => {
    renderCard(scored({ scoreParts: null }));
    const card = screen.getByRole("article");
    expect(within(card).queryByRole("button", { name: /AI 评分/ })).not.toBeInTheDocument();
    expect(card.querySelector("[data-score='high']")).toHaveTextContent(/^AI 评分\s*86$/);
  });

  it("opens the score's four parts on keyboard focus, with what it measures, and never a dimension elsewhere", async () => {
    renderCard(scored({ scoreParts: { authority: 27, impact: 25, novelty: 18, relevance: 16 } }));
    const card = screen.getByRole("article");
    // Closed, no part's number is on the card.
    for (const part of ["27/30", "25/30", "18/20", "16/20"]) expect(card.textContent).not.toContain(part);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "AI 评分 86，查看构成" })).toHaveFocus();
    const breakdown = await screen.findByRole("dialog", { name: "AI 评分构成" });
    expect(breakdown).toHaveTextContent("实践影响25/30权威性27/30新颖性18/20国内相关性16/20");
    expect(breakdown).toHaveTextContent("衡量对临床和科研读者的重要程度，不代表证据等级");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "AI 评分构成" })).not.toBeInTheDocument();
  });

  it("opens the parts on a tap too, and the press does not open the article", async () => {
    renderCard(scored({ scoreParts: { authority: 27, impact: 25, novelty: 18, relevance: 16 } }));
    await userEvent.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: "AI 评分 86，查看构成" }) });
    expect(await screen.findByRole("dialog", { name: "AI 评分构成" })).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
  });

  it("scores no safety notice, and says 安全警示 first", () => {
    renderCard(frontierItem({ score: 90, scoreBand: "high", safetyAlert: true, evidenceType: "safety-notice", evidenceTypeLabel: "安全通告",
      sourceType: "regulator", sourceTypeLabel: "监管", source: { id: "fda-recalls", name: "FDA" } }));
    const card = screen.getByRole("article");
    expect(within(card).queryByRole("button", { name: /AI 评分/ })).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent("AI 评分");
    expect(card.textContent?.indexOf("安全警示")).toBe(0);
    expect(within(card).getByText("安全警示")).toHaveClass("bg-danger-soft");
    // The safety tag already says what the evidence type would, and the lane.
    expect(card).not.toHaveTextContent("安全通告");
    expect(card).not.toHaveTextContent("药物安全");
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

  it("in a day group, puts the clock in its own column with a dot, the accent for 精选, and says 精选 where not every item is", () => {
    renderCard(frontierItem({ timelineAt: new Date(2026, 8, 22, 9, 5).toISOString() }), { markSelected: true, grouped: true });
    const item = screen.getByRole("listitem");
    const column = item.querySelector(".w-14");
    expect(within(column as HTMLElement).getByText("09:05")).toHaveClass("tabular-nums");
    expect(column?.querySelector(".bg-accent")).not.toBeNull();
    expect(column).toHaveClass("hidden", "sm:flex");
    // On a phone the column is not drawn and the clock joins the source line.
    const line = within(within(item).getByRole("article")).getAllByText("09:05").find((node) => node.closest(".sm\\:hidden"));
    expect(line).toBeDefined();
    expect(within(item).getByText("精选")).toHaveClass("sr-only");
  });

  it("in a list not cut into days, has no time column and says the date in its meta row after the source", () => {
    renderCard(frontierItem({ timelineAt: new Date(2026, 9, 20, 9, 5).toISOString(), source: { id: "annonc", name: "肿瘤学年鉴" } }));
    const item = screen.getByRole("listitem");
    expect(item.querySelector(".w-14")).toBeNull();
    expect(within(item).getByRole("article")).toHaveTextContent("肿瘤学年鉴 · 10月20日");
    expect(within(item).getByText("10月20日").tagName).toBe("TIME");
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
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
  });

  it("shows its star and 「⋯」 without a pointer over it, no 深入研究 button, and no second link to the article or the original", () => {
    renderCard();
    const card = screen.getByRole("article");
    for (const name of ["收藏", "更多操作"]) {
      let node: HTMLElement | null = within(card).getByRole("button", { name });
      for (; node && node !== card; node = node.parentElement) expect(node.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    }
    expect(within(card).queryByRole("button", { name: "深入研究" })).not.toBeInTheDocument();
    expect(within(card).getAllByRole("link")).toHaveLength(1);
  });

  it("is one link to its addressed reader, stretched over the whole card, which records the reading", async () => {
    const item = frontierItem();
    const handlers = renderCard(item);
    const original = within(screen.getByRole("heading", { level: 3 })).getByRole("link", { name: item.title });
    expect(original).toHaveAttribute("href", `/app/frontier/items/${encodeURIComponent(item.id)}`);
    expect(original).not.toHaveAttribute("target");
    // The link's box covers the card (`after:inset-0` in the card's `relative` box); what sits above it presses on its own.
    expect(original).toHaveClass("after:absolute", "after:inset-0");
    expect(screen.getByRole("article")).toHaveClass("relative", "hover:bg-surface-2");
    expect(screen.getByRole("button", { name: "收藏" }).closest(".z-sticky")).not.toBeNull();
    await userEvent.click(original);
    expect(handlers.onOpened).toHaveBeenCalledWith(item);
    expect(await screen.findByTestId("probe")).toHaveTextContent(`/app/frontier/items/${item.id}`);
  });

  it("has 深入研究 first in 「⋯」: a new conversation with the draft in the composer at once, and nothing sent", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const entries = await screen.findAllByRole("menuitem");
    expect(entries[0]).toHaveTextContent("深入研究");
    await userEvent.click(entries[0]);
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
    const entries = (await screen.findAllByRole("menuitem")).map((entry) => entry.textContent);
    expect(entries).toEqual(expect.arrayContaining(["深入研究", "存入知识库", "复制为 Markdown", "不感兴趣", `关注 ${item.source.name}`, `屏蔽 ${item.source.name}`]));
    expect(entries).not.toContain("详情");
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

  it("narrows the feed by one of its tags, and a tag never opens the item", async () => {
    const handlers = renderCard(frontierItem({ tags: [{ slug: "hcc", name: "肝细胞癌" }] }));
    await userEvent.click(screen.getByRole("button", { name: "#肝细胞癌" }));
    expect(handlers.onTag).toHaveBeenLastCalledWith({ slug: "hcc", name: "肝细胞癌" });
    expect(handlers.onOpened).not.toHaveBeenCalled();
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
  });

  it("links a tag to 全部 with it where the page does not narrow in place", () => {
    render(<MemoryRouter><ul><FrontierCard item={frontierItem({ tags: [{ slug: "hcc", name: "肝细胞癌" }] })} onStar={vi.fn()} onHide={vi.fn()} /></ul></MemoryRouter>);
    expect(screen.getByRole("link", { name: "#肝细胞癌" })).toHaveAttribute("href", "/app/frontier?view=all&tag=hcc");
  });
});

it("follows a card's structured source identity without invoking hide or external navigation", async () => {
  client.addFrontierFollow.mockResolvedValue({ id: "9", kind: "source", key: "nejm", label: "NEJM", muted: false });
  const item = frontierItem();
  const handlers = renderCard(item);
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: `关注 ${item.source.name}` }));
  expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: item.source.id, label: item.source.name, muted: false });
  expect(handlers.onHide).not.toHaveBeenCalled();
  expect(await screen.findByText("已关注")).toBeInTheDocument();
});

it("offers an explicit draft bridge from the feed to an evidence zone", async () => {
  renderCard(frontierItem({ id: "source/item" }));
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "整理为证据卡片" }));
  expect(await screen.findByTestId("probe")).toHaveTextContent("/app/frontier/zones?fromItem=source%2Fitem");
});

it("opens an event from more actions even when it has only one report", async () => {
  renderCard(frontierItem({ alsoReportedCount: 0, alsoReportedBy: [], event: { id: "single-event", title: "Single-source event" } }));
  expect(screen.queryByRole("button", { name: /另有/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "同一事件的全部报道" }));
  expect(await screen.findByTestId("probe")).toHaveTextContent("/app/frontier/events/single-event");
});

describe("a social post's card", () => {
  const post = (overrides: Record<string, unknown> = {}) => frontierItem({
    platform: "x", channel: "x", author: { name: "Arena.ai", handle: "arena", url: null, role: "organisation" },
    source: { id: "x-arena", name: "X 精选账号", homepage: null, platformProduced: false }, ...overrides,
  });

  it("is said by its account, its handle and its platform, where any other item is said by its institution", () => {
    renderCard(post());
    expect(screen.getByRole("article")).toHaveTextContent("Arena.ai @arena · X");
    expect(screen.getByRole("article")).not.toHaveTextContent("X 精选账号");
  });

  it("shows its first picture beside the title, from this deployment's proxy, and the title stays the card's one link to the article", async () => {
    renderCard(post({ thumb: { id: "c".repeat(64), width: 400, height: 300, alt: "图" } }));
    const picture = document.querySelector("article img") as HTMLImageElement;
    expect(picture).toHaveAttribute("src", `/api/frontier/media/${"c".repeat(64)}`);
    expect(picture.closest("a")).toBeNull();
    expect(document.querySelectorAll('article a[aria-hidden="true"]')).toHaveLength(0);
  });

  it("draws no picture where there is none, or where it cannot be served", () => {
    renderCard(frontierItem());
    expect(document.querySelector("article img")).toBeNull();
  });
});
