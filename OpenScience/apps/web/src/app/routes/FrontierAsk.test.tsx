import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFrontierItemDetail } from "@/lib/frontierClient";
import { frontierItemDetail, rawXPost } from "@/components/frontier/__fixtures__/frontierItems";
import { pendingFrontierEvents, resetFrontierTracking } from "@/lib/frontierTracking";
import { FrontierArticlePage } from "./FrontierArticlePage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
  starFrontierItem: vi.fn(), unstarFrontierItem: vi.fn(), hideFrontierItem: vi.fn(), unhideFrontierItem: vi.fn(), addFrontierFollow: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));

const detail = (raw: Record<string, unknown>) => parseFrontierItemDetail(raw)!;
const ID = "a1b2c3d4e5f60718";
const QUESTIONS = ["这个结果适用于中国患者吗？", "和现有标准治疗比差别在哪？", "安全性数据有哪些？"];

type Intent = { kind: string; draft?: string; originReference?: { kind: string; id: string; title: string } };
function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: Intent } | null)?.runtimeUiIntent;
  return <div data-testid="probe">{location.pathname}|{JSON.stringify(intent ? { kind: intent.kind, draft: intent.draft, origin: intent.originReference } : null)}</div>;
}
const intentOf = () => JSON.parse(screen.getByTestId("probe").textContent!.split("|").slice(1).join("|")) as { kind: string; draft: string; origin: { kind: string; id: string; title: string } };

function show() {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/items/${ID}`]}>
      <Routes>
        <Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}
/** A window from 1024 px: the right column beside the text. jsdom matches no query otherwise, which is the narrow page. */
function wide() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

beforeEach(() => {
  vi.resetAllMocks();
  resetFrontierTracking();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: ID, ask: QUESTIONS }), abstract: "Original abstract", abstractZh: "已保存的中文摘要" });
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); resetFrontierTracking(); });

describe("继续追问 on the reading page (c3-ask; chips at the article's end since 2026-10-27)", () => {
  it("is the end of the article on a wide screen too, not the right column: the questions as chips, then 「自己提问…」", async () => {
    wide();
    show();
    const article = await screen.findByRole("article", { name: "正文" });
    const block = within(article).getByRole("region", { name: "继续追问" });
    expect(within(block).getAllByRole("button").map((button) => button.textContent)).toEqual([...QUESTIONS, "自己提问…"]);
    expect(screen.getAllByRole("region", { name: "继续追问" })).toHaveLength(1);
    // The column no longer has it, and starts at 推荐理由.
    const rail = screen.getByRole("complementary", { name: "文章操作与推荐" });
    expect(within(rail).queryByRole("region", { name: /就此提问|继续追问/ })).not.toBeInTheDocument();
    expect(screen.queryByText("就此提问")).not.toBeInTheDocument();
    const names = within(rail).getAllByRole("region").map((region) => region.getAttribute("aria-label")
      ?? (region.getAttribute("aria-labelledby") && document.getElementById(region.getAttribute("aria-labelledby")!)!.textContent));
    expect(names).toEqual(["推荐理由", "出处", "专科"]);
  });

  it("is chips, not rows: each question one line that wraps with the others, cut where the room is short, its whole text its name", async () => {
    wide();
    const long = "这个结果在中国人群中的外推性如何，需要哪些额外证据？";
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: ID, ask: [long, ...QUESTIONS.slice(0, 2)] }), abstract: "Original abstract", abstractZh: null });
    show();
    const block = await screen.findByRole("region", { name: "继续追问" });
    const list = within(block).getByRole("list", { name: "可以问的问题" });
    expect(list).toHaveClass("flex-wrap");
    const chip = within(list).getByRole("button", { name: long });
    // One line, cut with an ellipsis: the chip may not be wider than the line it stands on.
    expect(chip).toHaveClass("max-w-full", "rounded-full");
    expect(chip.querySelector(".truncate")).toHaveTextContent(long);
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("is at the end of the article on a narrow screen too, in the same place: before the notes (出处 among them)", async () => {
    show();
    const article = await screen.findByRole("article", { name: "正文" });
    const block = within(article).getByRole("region", { name: "继续追问" });
    expect(within(block).getAllByRole("button")).toHaveLength(4);
    const regions = within(article).getAllByRole("region").map((region) => region.getAttribute("aria-labelledby") && document.getElementById(region.getAttribute("aria-labelledby")!)!.textContent);
    expect(regions.indexOf("继续追问")).toBeGreaterThan(-1);
    expect(regions.indexOf("继续追问")).toBeLessThan(regions.indexOf("推荐理由"));
    expect(screen.getAllByRole("region", { name: "继续追问" })).toHaveLength(1);
  });

  it("follows what the AI view says and its 事件后续, and leads the notes", async () => {
    client.fetchFrontierItem.mockResolvedValue(detail(rawXPost({ id: ID, ask: QUESTIONS })));
    show();
    const article = await screen.findByRole("article", { name: "正文" });
    const followups = within(article).getByRole("region", { name: "事件后续 · 2" });
    const ask = within(article).getByRole("region", { name: "继续追问" });
    expect(followups.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ask.compareDocumentPosition(within(article).getByRole("region", { name: "推荐理由" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a question opens a new conversation with it as the draft, the item's line under it, the item as its origin, and nothing sent", async () => {
    show();
    const block = await screen.findByRole("region", { name: "继续追问" });
    await userEvent.click(within(block).getByRole("button", { name: QUESTIONS[1] }));
    expect(screen.getByTestId("probe").textContent?.startsWith("/app/chat|")).toBe(true);
    const intent = intentOf();
    expect(intent.kind).toBe("create");
    const [question, line, original] = intent.draft.split("\n").filter(Boolean);
    expect(question).toBe(QUESTIONS[1]);
    expect(line).toBe(`“口服 PCSK9 抑制剂降低主要心血管事件”（NEJM · 2026-09-22） frontier:${ID}`);
    expect(original).toBe("原文：https://www.nejm.org/doi/full/10.1056/example");
    expect(intent.origin).toEqual({ kind: "frontier-item", id: ID, title: "口服 PCSK9 抑制剂降低主要心血管事件" });
    expect(pendingFrontierEvents().filter((event) => event.type === "ask").map((event) => [event.item, event.surface, event.detail])).toEqual([[ID, "reader", "suggested"]]);
  });

  it("「自己提问…」 opens it with the item's line alone", async () => {
    show();
    await userEvent.click(within(await screen.findByRole("region", { name: "继续追问" })).getByRole("button", { name: "自己提问…" }));
    const intent = intentOf();
    expect(intent.draft.startsWith(`“口服 PCSK9 抑制剂降低主要心血管事件”`)).toBe(true);
    expect(intent.draft).toContain(`frontier:${ID}`);
    expect(intent.draft).not.toContain("？");
    expect(intent.origin.kind).toBe("frontier-item");
    expect(pendingFrontierEvents().filter((event) => event.type === "ask").map((event) => event.detail)).toEqual(["own"]);
  });

  it("with no questions written it is the reader's own question alone", async () => {
    client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: ID }), abstract: "Original abstract", abstractZh: null });
    show();
    const block = await screen.findByRole("region", { name: "继续追问" });
    expect(within(block).getAllByRole("button").map((button) => button.textContent)).toEqual(["自己提问…"]);
  });

  it("深入研究 is the same way in, from the title row: the question that fits the item, the item's line, the item as origin", async () => {
    wide();
    show();
    await screen.findByRole("group", { name: "阅读视图与操作" });
    await userEvent.click(within(document.querySelector("[data-page-header]") as HTMLElement).getByRole("button", { name: "深入研究" }));
    const intent = intentOf();
    expect(intent.draft.startsWith("这项研究可靠吗？")).toBe(true);
    expect(intent.draft).toContain(`frontier:${ID}`);
    expect(intent.origin).toEqual({ kind: "frontier-item", id: ID, title: "口服 PCSK9 抑制剂降低主要心血管事件" });
    expect(pendingFrontierEvents().filter((event) => event.type === "research").map((event) => event.item)).toEqual([ID]);
  });
});
