import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { FrontierCongressHub } from "@/lib/frontierClient";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierCongressPage } from "./FrontierCongressPage";

const client = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), fetchFrontierCongress: vi.fn(), addFrontierFollow: vi.fn(), hideFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));

function hub(over: Partial<FrontierCongressHub> = {}): FrontierCongressHub {
  return {
    congress: { id: "esmo-2026", code: "ESMO 2026", name: "欧洲肿瘤内科学会年会", nameEn: "ESMO Congress 2026", start: "2026-10-23", end: "2026-10-27", city: "Madrid",
      specialty: "oncology", specialtyLabel: "肿瘤学", status: "ongoing", sourceUrl: "https://www.esmo.org/meetings/esmo-congress-2026", abstractsAt: null },
    itemCount: 3, listedCount: 3,
    days: [
      { day: "2026-10-24", recap: { text: "药物 A 在随机对照试验中延长了生存期[1]。药物 B 的早期数据属非随机研究[2]。[9]不是引用。", at: "2026-10-24T10:00:00Z",
        refs: [{ n: 1, itemId: "i1", title: "药物 A 三期试验", sourceName: "医脉通" }, { n: 2, itemId: "i2", title: "药物 B 早期数据", sourceName: "OncLive" }] },
        items: [{ item: frontierItem({ id: "i1", title: "药物 A 三期试验", selected: true }), caveat: "随机、双盲；期中分析" }, { item: frontierItem({ id: "i2", title: "药物 B 早期数据", selected: false }), caveat: null }] },
      { day: "2026-10-23", recap: null, items: [{ item: frontierItem({ id: "i3", title: "开幕日的一项研究" }), caveat: null }] },
    ],
    listId: "list-1", ...over,
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}
function renderHub(id = "esmo-2026", entry: unknown = undefined) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/app/frontier/congress/${id}`, state: entry }]}>
      <Routes>
        <Route path="/app/frontier/congress/:congressId" element={<FrontierCongressPage />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.useFrontierFeature.mockReset().mockReturnValue("on");
  client.fetchFrontierCongress.mockReset().mockResolvedValue(hub());
  client.addFrontierFollow.mockReset().mockResolvedValue({ id: "f", kind: "topic", key: "ESMO 2026", label: "ESMO 2026", muted: false });
});

describe("a congress's hub", () => {
  it("says what the congress holds, as its list line does, and how many the days list where it lists fewer (owner, 2026-10-27)", async () => {
    client.fetchFrontierCongress.mockResolvedValue(hub({ itemCount: 624, listedCount: 400 }));
    renderHub();
    expect(await screen.findByText("收录 624 条，显示最新 400 条")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("收录 400 条");
  });

  it("heads the page with the congress, its status, dates, place, specialty and count, and a link to the organiser", async () => {
    renderHub();
    expect(await screen.findByRole("heading", { level: 1, name: "ESMO 2026 · 欧洲肿瘤内科学会年会" })).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("10月23日—27日");
    expect(document.body).toHaveTextContent("Madrid");
    expect(document.body).toHaveTextContent("肿瘤学");
    expect(document.body).toHaveTextContent("收录 3 条");
    expect(document.body).not.toHaveTextContent("显示最新");
    expect(screen.getByRole("link", { name: /会议信息/ })).toHaveAttribute("href", "https://www.esmo.org/meetings/esmo-congress-2026");
    expect(screen.getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier?view=track&segment=congresses");
  });

  it("lists the days newest first, each with its recap, whose marks open the items, and then its items as the feed's cards with the design caveat", async () => {
    renderHub();
    await screen.findByRole("heading", { level: 1 });
    const days = screen.getAllByRole("heading", { level: 2 });
    expect(days.map((heading) => heading.textContent)).toEqual(["10月24日 周六2 条", "10月23日 周五1 条"]);
    const recap = screen.getByText("AI 速递").parentElement!;
    expect(recap).toHaveTextContent("药物 A 在随机对照试验中延长了生存期[1]。药物 B 的早期数据属非随机研究[2]。[9]不是引用。");
    expect(within(recap).getByRole("link", { name: "药物 A 三期试验" })).toHaveAttribute("href", "/app/frontier/items/i1");
    expect(within(recap).getByRole("link", { name: "药物 B 早期数据" })).toHaveAttribute("href", "/app/frontier/items/i2");
    expect(within(recap).getAllByRole("link")).toHaveLength(2);
    const day = screen.getByRole("list", { name: "10月24日 周六的报道" });
    const cards = within(day).getAllByRole("listitem").filter((entry) => entry.hasAttribute("data-frontier-item"));
    expect(cards.map((card) => card.getAttribute("data-frontier-item"))).toEqual(["i1", "i2"]);
    expect(cards[0]).toHaveTextContent("设计与局限：随机、双盲；期中分析");
    expect(cards[1]).not.toHaveTextContent("设计与局限");
    // The day without a recap has none, and says nothing in its place.
    expect(screen.getAllByText("AI 速递")).toHaveLength(1);
    // The list is tracked as a congress list.
    expect(document.querySelector('[data-frontier-list="congress"]')).not.toBeNull();
    // No back office on the page.
    for (const gone of ["track_facts", "deepseek", "预算", "已核对"]) expect(document.body).not.toHaveTextContent(gone);
  });

  it("takes a card the reader said 不感兴趣 to out of its day, as the topic page does", async () => {
    client.hideFrontierItem.mockResolvedValue({ ...frontierItem().state, hidden: true });
    renderHub();
    await screen.findByRole("heading", { level: 1 });
    const day = () => screen.getByRole("list", { name: "10月24日 周六的报道" });
    const card = within(day()).getAllByRole("listitem").find((entry) => entry.getAttribute("data-frontier-item") === "i2")!;
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    await waitFor(() => expect(within(day()).getAllByRole("listitem").filter((entry) => entry.hasAttribute("data-frontier-item"))
      .map((entry) => entry.getAttribute("data-frontier-item"))).toEqual(["i1"]));
    expect(client.hideFrontierItem).toHaveBeenCalledWith("i2");
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("1 条");
  });

  it("has its days as contents, folded above them, each a press away to its day; a hub of one day has none", async () => {
    // A congress of a week ran to 17 windows with no contents (release walk of evimed-b559d4b7ebd0-1): a reading page's outline.
    const { unmount } = renderHub();
    await screen.findByRole("heading", { level: 1 });
    const outline = document.querySelector("[data-outline]")!;
    expect(outline).not.toBeNull();
    expect(outline).toHaveTextContent("目录 · 2 节");
    expect(outline.compareDocumentPosition(document.querySelector('[data-frontier-list="congress"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const entries = within(outline as HTMLElement).getAllByRole("button", { hidden: true });
    expect(entries.map((entry) => entry.textContent)).toEqual(["10月24日 周六 · 2 条", "10月23日 周五 · 1 条"]);
    const scrollTo = vi.fn();
    const scroller = document.querySelector(".overflow-y-auto") as HTMLElement;
    scroller.scrollTo = scrollTo;
    await userEvent.click(entries[1]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 2, name: /10月23日/ }).id).toBe("congress-day-2026-10-23");
    unmount();

    client.fetchFrontierCongress.mockResolvedValue(hub({ itemCount: 2, days: [hub().days[0]] }));
    renderHub();
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector("[data-outline]")).toBeNull();
  });

  it("shows the first ten items of a day and the rest on demand", async () => {
    const items = Array.from({ length: 14 }, (_, index) => ({ item: frontierItem({ id: `m${index}`, title: `第 ${index} 条` }), caveat: null }));
    client.fetchFrontierCongress.mockResolvedValue(hub({ itemCount: 14, days: [{ day: "2026-10-24", recap: null, items }] }));
    renderHub();
    await screen.findByRole("heading", { level: 1 });
    const list = screen.getByRole("list", { name: "10月24日 周六的报道" });
    expect(within(list).getAllByRole("article")).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: /显示更多 · 还有 4 条/ }));
    expect(within(list).getAllByRole("article")).toHaveLength(14);
  });

  it("says when an upcoming congress opens and what will appear, and offers to follow it or open the calendar", async () => {
    client.fetchFrontierCongress.mockResolvedValue(hub({ itemCount: 0, days: [],
      congress: { ...hub().congress, id: "aha-2026", code: "AHA 2026", name: "美国心脏协会科学年会", status: "upcoming", start: "2026-11-06", end: "2026-11-09" } }));
    renderHub("aha-2026");
    expect(await screen.findByText("AHA 2026 将于 11月6日 开幕")).toBeInTheDocument();
    expect(screen.getByText(/开幕后，这里按天列出会议上公布的研究/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看会议日历" })).toHaveAttribute("href", "/app/frontier?view=track&segment=congresses");
    await userEvent.click(screen.getByRole("button", { name: "关注“AHA 2026”" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "topic", key: "AHA 2026", label: "AHA 2026" });
    expect(await screen.findByRole("button", { name: "已关注" })).toBeDisabled();
  });

  it("says in one sentence with an action that a congress on now has nothing yet", async () => {
    client.fetchFrontierCongress.mockResolvedValue(hub({ itemCount: 0, days: [] }));
    renderHub();
    expect(await screen.findByText("还没有收录到 ESMO 2026 的报道")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关注“ESMO 2026”" })).toBeInTheDocument();
  });

  it("goes back to where the reader was", async () => {
    renderHub("esmo-2026", { frontierOrigin: "/app/frontier?view=hot" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier?view=hot");
  });
});

describe("a hub that cannot be shown", () => {
  it("says the congress does not exist, with the calendar as the way on", async () => {
    client.fetchFrontierCongress.mockRejectedValue(new WebApiError("no", { status: 404, code: "frontier_congress_not_found" }));
    renderHub("nope");
    expect(await screen.findByRole("heading", { name: "没有这个会议" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看会议日历" })).toHaveAttribute("href", "/app/frontier?view=track&segment=congresses");
  });
  it("says it is being prepared on a server without the route", async () => {
    client.fetchFrontierCongress.mockRejectedValue(new WebApiError("no", { status: 404, code: "not_found" }));
    renderHub();
    expect(await screen.findByRole("heading", { name: "会议追踪还在准备" })).toBeInTheDocument();
  });
  it("offers a retry on a failure, and the off sentence when the module is off", async () => {
    client.fetchFrontierCongress.mockRejectedValueOnce(new WebApiError("boom", { status: 500, code: "server_error" })).mockResolvedValue(hub());
    const { unmount } = renderHub();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("heading", { level: 1, name: /ESMO 2026/ })).toBeInTheDocument();
    unmount();
    client.useFrontierFeature.mockReturnValue("off");
    renderHub();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    await waitFor(() => expect(client.fetchFrontierCongress).toHaveBeenCalledTimes(2));
  });
});
