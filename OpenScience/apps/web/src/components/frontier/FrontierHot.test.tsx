import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { FrontierHotEvent } from "@/lib/frontierClient";
import { HotBoard, HotCard } from "./FrontierHot";

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const event = (rank: number, overrides: Partial<FrontierHotEvent> = {}): FrontierHotEvent => ({
  rank, id: `ev${rank}`, title: `俄罗斯鼠疫疫情：世界卫生组织的评估 ${rank}`, latest: null, sourceCount72h: 4, reportCount: 5, primary: null, hasPrimary: false,
  firstAt: ago(30), lastAt: ago(3), status: "developing", heat: 40 - rank, rankChange: null, badge: null,
  trend: [20, 22, 25, 27, 30].map((heat, index) => ({ at: ago(24 - index * 4), heat })), period: null, ...overrides,
});

// jsdom has no viewport: what the phone sees is said by the classes that answer to it.
describe("当前热点 on a phone", () => {
  it("is its first line and 「完整热榜 ›」; the second and third rows wait for a wider screen", () => {
    render(<MemoryRouter><HotCard events={[event(1), event(2), event(3), event(4)]} onOpenAll={vi.fn()} /></MemoryRouter>);
    const rows = within(screen.getByRole("list", { name: "当前热点" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toHaveClass("max-sm:hidden");
    expect(rows[1]).toHaveClass("max-sm:hidden");
    expect(rows[2]).toHaveClass("max-sm:hidden");
    expect(screen.getByRole("button", { name: "完整热榜 ›" })).toBeInTheDocument();
  });

  it("is not drawn at all when nothing is hot", () => {
    const { container } = render(<MemoryRouter><HotCard events={[]} onOpenAll={vi.fn()} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("热榜's rows on a phone", () => {
  const board = (events: FrontierHotEvent[]) => render(<MemoryRouter><HotBoard state={{ board: { window: "current", takenAt: ago(0.2), since: ago(72.2), events }, error: null }} onRetry={vi.fn()} /></MemoryRouter>);

  it("wrap the title to two lines on a phone and cut it to one from `sm` up, so a headline is readable", () => {
    board([event(1)]);
    const title = screen.getByText("俄罗斯鼠疫疫情：世界卫生组织的评估 1");
    expect(title).toHaveClass("max-sm:line-clamp-2", "sm:truncate");
    expect(title).not.toHaveClass("truncate");
  });

  it("narrow the heat to its number on a phone and leave the trend line to the desktop", () => {
    board([event(1)]);
    const row = screen.getByRole("listitem");
    const heat = within(row).getByText("热度").closest("div")!;
    expect(heat).toHaveClass("w-16", "sm:w-28");
    expect(heat.querySelector(".max-sm\\:hidden")).not.toBeNull();
    expect(within(row).getByText("39")).toBeInTheDocument();
  });

  it("keep the meta line whole: how many institutions, whether their own texts are among them", () => {
    board([event(1, { primary: "paper" })]);
    expect(screen.getByText(/4 家机构报道 · 含原始论文/)).toBeInTheDocument();
  });
});

describe("热榜 with nothing on it", () => {
  // An empty list is a recipe with a way on (DESIGN.md rule 8): the full list is a link away, and the state that is still being
  // prepared says why there is nothing to press.
  it("has a mark, a title and the way to the full feed", () => {
    const { container } = render(<MemoryRouter><HotBoard state={{ board: { window: "current", takenAt: ago(0.2), since: ago(72.2), events: [] }, error: null }} onRetry={vi.fn()} /></MemoryRouter>);
    const empty = container.querySelector("[data-empty]") as HTMLElement;
    expect(empty.querySelector("svg")).not.toBeNull();
    expect(within(empty).getByText("暂无热点")).toBeInTheDocument();
    expect(within(empty).getByRole("link", { name: "看全部动态" })).toHaveAttribute("href", "/app/frontier?view=all");
  });

  it("says why there is nothing to press while the board is being prepared", () => {
    const { container } = render(<MemoryRouter><HotBoard state={{ board: null, error: null }} onRetry={vi.fn()} /></MemoryRouter>);
    const empty = container.querySelector("[data-empty]") as HTMLElement;
    expect(empty).toHaveAttribute("data-reason");
    expect(within(empty).getByText("热榜还在准备")).toBeInTheDocument();
  });
});

describe("热榜's 「新」 and 「升温」", () => {
  it("stand beside the title's link, not in it: a tag is a label and never part of a control", () => {
    render(<MemoryRouter><HotBoard state={{ board: { window: "current", takenAt: ago(0.2), since: ago(72.2), events: [event(1, { badge: "new" }), event(2, { badge: "warming" as FrontierHotEvent["badge"] })] }, error: null }} onRetry={vi.fn()} /></MemoryRouter>);
    for (const row of screen.getAllByRole("listitem")) {
      const tag = row.querySelector("[data-tag]");
      expect(tag).not.toBeNull();
      expect(tag!.closest("a, button")).toBeNull();
      // The link still names the title alone, and the badge comes after it: every title starts on one left edge.
      expect(within(row).getByRole("link")).not.toContainElement(tag as HTMLElement);
      expect(within(row).getByRole("link").compareDocumentPosition(tag as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});
