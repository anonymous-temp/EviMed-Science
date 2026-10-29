import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { FrontierEvent } from "@/lib/frontierClient";
import { pendingFrontierEvents, resetFrontierTracking } from "@/lib/frontierTracking";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierEventPage } from "./FrontierEventPage";
import { expectComposed } from "@/test/expectComposed";

const client = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), fetchFrontierEvent: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
// 18:01 in Beijing, whatever the machine's zone is.
const FIRST = "2026-09-22T10:01:00.000Z";

function event(overrides: Partial<FrontierEvent> = {}): FrontierEvent {
  return {
    id: "ev1",
    title: "不饱和磷脂多层多囊脂质体实现亲水药物超缓释",
    digest: "DOPC 脂质体包封率约为饱和类似物的 3 倍，初始释放低 11 倍。",
    latest: { text: "缓释脂质体注射剂在大鼠中实现持续 2 至 3 周神经阻滞", at: ago(3) },
    status: "developing",
    lane: "evidence", laneLabel: "临床证据",
    specialties: [{ key: "pharmacy", label: "药学" }],
    sourceCount72h: 2, reportCount: 2,
    firstAt: FIRST, lastAt: ago(3),
    heat: 38, hasPrimary: true, primary: "paper",
    institutions72h: { total: 2, byType: [{ type: "journal", label: "期刊", count: 1 }, { type: "media", label: "媒体", count: 1 }] },
    trend: Array.from({ length: 12 }, (_, index) => ({ at: ago(11 - index), heat: 20 + index })),
    items: [
      { ...frontierItem({ id: "p1", title: "不饱和磷脂脂质体原文", source: { id: "nbe", name: "自然-生物医学工程" }, sourceType: "journal", sourceTypeLabel: "期刊",
        url: "https://www.nature.com/x", timelineAt: ago(5) }), role: "primary" },
      { ...frontierItem({ id: "r1", title: "缓释脂质体注射剂在大鼠中实现持续神经阻滞", source: { id: "mx", name: "Medical Xpress" }, sourceType: "media", sourceTypeLabel: "媒体",
        url: "https://medicalxpress.com/x", timelineAt: ago(4), selected: false }), role: "report" },
    ],
    related: [{ id: "ev0", title: "同类缓释制剂的早先报道", relation: "follows", at: ago(24 * 6) }],
    ...overrides,
  };
}

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { draft?: string; originReference?: { kind: string; id: string } } } | null)?.runtimeUiIntent;
  return <div data-testid="location" data-origin={intent?.originReference ? `${intent.originReference.kind}:${intent.originReference.id}` : undefined}>{location.pathname}{location.search}{intent?.draft ? `|${intent.draft}` : ""}</div>;
}

/** The rows of the timeline, in the order of the page. */
const timelineRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-event-timeline] li"));
/** A window from 1024 px: the record in the right column. jsdom matches no query otherwise, which is the narrow page. */
function wide() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

function renderEvent(id = "ev1", search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/events/${id}${search}`]}>
      <Routes>
        <Route path="/app/frontier/events/:eventId" element={<><FrontierEventPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetFrontierTracking();
  client.useFrontierFeature.mockReset().mockReturnValue("on");
  client.fetchFrontierEvent.mockReset().mockResolvedValue(event());
});
afterEach(() => resetFrontierTracking());

describe("an event", () => {
  it("heads the page with the way back, the title, one line of facts and 深入研究", async () => {
    renderEvent();
    const title = await screen.findByRole("heading", { level: 1, name: "不饱和磷脂多层多囊脂质体实现亲水药物超缓释" });
    expect(screen.getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
    expect(title.closest("header")).toContainElement(screen.getByRole("button", { name: "深入研究" }));
    // The line of facts is the first thing in the page body, directly under the header. How many reports and from how many sources is the
    // record's, so the line does not say it twice.
    const facts = title.closest("header")!.nextElementSibling!.firstElementChild!;
    expect(facts).toHaveTextContent("3 小时前更新药学");
    expect(facts).not.toHaveTextContent("机构");
    expect(within(facts as HTMLElement).getByText("药学")).toHaveClass("rounded-tag");
    // No explanation under any heading: the old cards each said how they were made.
    for (const gone of ["由多篇报道综合", "当事方自己的说法", "最新在前", "仍在发展", "篇报道"]) expect(document.body).not.toHaveTextContent(gone);
  });

  it("says in the line of facts what the record does not: the studies the reports were tied to, and those not yet", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ counts: { reports: 5, institutions: 4, studies: 2, unlinkedReports: 1 } }));
    renderEvent();
    const title = await screen.findByRole("heading", { level: 1, name: event().title });
    const facts = title.closest("header")!.nextElementSibling!.firstElementChild!;
    expect(facts).toHaveTextContent("2 项已识别研究（1 篇尚未关联研究）·3 小时前更新药学");
    cleanup();
    client.fetchFrontierEvent.mockResolvedValue(event({ counts: { reports: 5, institutions: 4, studies: 0, unlinkedReports: 5 } }));
    renderEvent();
    const again = await screen.findByRole("heading", { level: 1, name: event().title });
    expect(again.closest("header")!.nextElementSibling!.firstElementChild!).toHaveTextContent(/^3 小时前更新药学$/);
  });

  it("says what is known, and the latest turn", async () => {
    renderEvent();
    const digest = (await screen.findByRole("heading", { name: "概要" })).closest("section")!;
    expect(digest).toHaveTextContent("DOPC 脂质体包封率约为饱和类似物的 3 倍，初始释放低 11 倍。");
    expect(digest).toHaveTextContent("最新缓释脂质体注射剂在大鼠中实现持续 2 至 3 周神经阻滞 · 3 小时前");
  });

  it("puts the parties' own texts first under 「一手材料」, then the other reports on the timeline, each newest first, and no filter below ten", async () => {
    renderEvent();
    const primary = await screen.findByRole("list", { name: "一手材料" });
    const others = timelineRows();
    const first = within(primary).getAllByRole("listitem");
    expect(first.map((row) => row.querySelector("p")?.textContent)).toEqual(["一手来源：不饱和磷脂脂质体原文"]);
    expect(others.map((row) => row.querySelector("p")?.textContent)).toEqual(["缓释脂质体注射剂在大鼠中实现持续神经阻滞"]);
    // The record leads the page (a strip below 1024 px), then 概要; 一手材料 is the first thing under it, and the timeline follows.
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 4)).toEqual(["事件记录（北京时间）", "概要", "一手材料", "报道时间线"]);
    expect(screen.getByRole("heading", { level: 2, name: "一手材料" }).parentElement).toHaveTextContent("一手材料1");
    expect(first[0].querySelector(".bg-accent")).not.toBeNull();
    expect(others[0].querySelector(".bg-accent")).toBeNull();
    expect(first[0]).toHaveTextContent("自然-生物医学工程·期刊·5 小时前·原文");
    // On the timeline the day is the heading above a row, so a row says the clock (Beijing time) and not how long ago.
    expect(others[0]).toHaveTextContent(/^缓释脂质体注射剂在大鼠中实现持续神经阻滞Medical Xpress·媒体·\d{2}:\d{2}·原文 ↗$/);
    expect(within(first[0]).getByRole("link", { name: "原文" })).toHaveAttribute("href", "https://www.nature.com/x");
    expect(screen.queryByRole("button", { name: "全部来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "同类缓释制剂的早先报道" })).toHaveAttribute("href", "/app/frontier/events/ev0");
  });

  it("is the timeline alone when nobody's own text is among the reports, and says 「暂无」 in the record", async () => {
    const reports = event().items.map((item) => ({ ...item, role: "report" as const }));
    client.fetchFrontierEvent.mockResolvedValue(event({ items: reports, hasPrimary: false, primary: null }));
    renderEvent();
    const heading = await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(heading.parentElement).toHaveTextContent("报道时间线2");
    // The record says nobody's own text is among them; the timeline does not say it a second time.
    expect(screen.queryByText("暂无一手材料，以下均为转述报道。")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /一手材料/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /其他报道/ })).not.toBeInTheDocument();
    expect(timelineRows()).toHaveLength(2);
    const side = screen.getByRole("complementary", { name: "事件记录" });
    expect(within(side).getAllByRole("definition").at(-1)).toHaveTextContent("暂无");
  });

  it("carries the heat, its trend and the event's record in a strip above the summary: first report, last update, how many reports and sources", async () => {
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "事件记录" });
    expect(side).toHaveTextContent("38热度");
    expect(side.querySelector("svg[data-sparkline] path")).not.toBeNull();
    const facts = within(side).getAllByRole("definition").map((entry) => entry.textContent);
    expect(within(side).getAllByRole("term").map((entry) => entry.textContent)).toEqual(["最早报道", "最近更新", "报道", "来源", "一手材料"]);
    // 18:01 in Beijing is 10:01 UTC: the clock is Beijing's whatever zone the machine is in.
    expect(facts[0]).toBe("9月22日 18:01");
    expect(facts[1]).toMatch(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
    expect(facts.slice(2)).toEqual(["2 篇", "2 家（期刊 1 · 媒体 1）", "有论文原文"]);
    // The zone is said once, in the heading: both times are in it.
    expect(within(side).getByRole("heading", { level: 2 })).toHaveTextContent("事件记录（北京时间）");
    expect(document.body.textContent?.match(/北京时间/g)).toHaveLength(1);
  });

  it("keeps the record honest on a server that sends no heat or counts yet", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ heat: undefined, trend: undefined, institutions72h: undefined, primary: undefined, hasPrimary: undefined, sourceCount72h: 7 }));
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "事件记录" });
    expect(side).not.toHaveTextContent("热度");
    expect(within(side).getAllByRole("definition").map((entry) => entry.textContent)).toEqual(["9月22日 18:01", expect.stringMatching(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/), "2 篇", "7 家", "有一手材料"]);
  });

  it("counts by the event's own counts where the server sends them, and says the kinds only where they add up to the sources", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ counts: { reports: 9, institutions: 5, studies: 1, unlinkedReports: 0 } }));
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "事件记录" });
    expect(within(side).getAllByRole("definition").slice(2).map((entry) => entry.textContent)).toEqual(["9 篇", "5 家", "有论文原文"]);
  });

  it("leaves a time out of the record that the event does not have, and says no zone for none", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ firstAt: null, lastAt: null }));
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "事件记录" });
    expect(within(side).getAllByRole("term").map((entry) => entry.textContent)).toEqual(["报道", "来源", "一手材料"]);
    expect(within(side).getByRole("heading", { level: 2 })).toHaveTextContent(/^事件记录$/);
  });

  it("stands in the right column from 1024 px — the shell's own aside, once, with the title's column to its left", async () => {
    wide();
    const { container } = renderEvent();
    const side = await screen.findByRole("complementary", { name: "事件记录" });
    expect(container.querySelectorAll("aside")).toHaveLength(1);
    expect(side).toHaveTextContent("事件记录（北京时间）");
    expect(side).toHaveTextContent("38热度");
    expect(within(side).getAllByRole("term").map((entry) => entry.textContent)).toEqual(["最早报道", "最近更新", "报道", "来源", "一手材料"]);
    expect(screen.getByRole("heading", { level: 1 }).compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It is beside the page and not above the summary.
    expect(side.compareDocumentPosition(screen.getByRole("heading", { level: 2, name: "概要" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("says there is no digest yet rather than inventing one", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ digest: null, latest: null }));
    renderEvent();
    expect(await screen.findByText("暂无综述")).toBeInTheDocument();
  });

  it("opens a new conversation with the event and its first-hand sources in the composer", async () => {
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "深入研究" }));
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent(/^\/app\/chat\|请围绕这个事件做一次深入研究/);
    expect(location).toHaveTextContent("一手来源：");
    expect(location).toHaveTextContent("自然-生物医学工程：不饱和磷脂脂质体原文（https://www.nature.com/x）");
  });

  it("offers the questions of the first-hand report under 就此提问: a question opens the conversation with that report as its origin", async () => {
    const ID = "a1b2c3d4e5f60718";
    const base = event();
    client.fetchFrontierEvent.mockResolvedValue(event({
      items: [{ ...base.items[0], id: ID }, base.items[1]],
      ask: { itemId: ID, title: "不饱和磷脂脂质体原文", questions: ["脂质体的包封率是怎么测的？", "这在人体里也成立吗？"] },
    }));
    renderEvent();
    const block = await screen.findByRole("region", { name: "就此提问" });
    expect(within(block).getAllByRole("button").map((button) => button.textContent)).toEqual(["脂质体的包封率是怎么测的？", "这在人体里也成立吗？", "自己提问…"]);
    await userEvent.click(within(block).getByRole("button", { name: "这在人体里也成立吗？" }));
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent(/^\/app\/chat\|这在人体里也成立吗？/);
    expect(location).toHaveTextContent("“不饱和磷脂脂质体原文”（自然-生物医学工程 · ");
    expect(location).toHaveTextContent(`frontier:${ID}`);
    expect(location).toHaveTextContent("原文：https://www.nature.com/x");
    expect(location).toHaveAttribute("data-origin", `frontier-item:${ID}`);
    expect(pendingFrontierEvents().filter((entry) => entry.type === "ask").map((entry) => [entry.item, entry.surface, entry.detail])).toEqual([[ID, "event", "suggested"]]);
  });

  it("has no 就此提问 where the event's first-hand report has no questions, and keeps its own 深入研究", async () => {
    renderEvent();
    await screen.findByRole("button", { name: "深入研究" });
    expect(screen.queryByRole("region", { name: "就此提问" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "深入研究" }));
    expect(screen.getByTestId("location")).toHaveAttribute("data-origin", expect.stringMatching(/^frontier-event:ev1$/));
  });

  it("moves its own address to the surviving event when the old id was merged", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ id: "ev-survivor" }));
    renderEvent("ev-old");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/frontier/events/ev-survivor"));
    expect(client.fetchFrontierEvent).toHaveBeenCalledWith("ev-old", undefined);
    expect(await screen.findByRole("heading", { level: 1, name: /脂质体/ })).toBeInTheDocument();
  });
});

describe("where there is no event to show", () => {
  it("says the event page is still being prepared on a server without it, with the way back", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("no route", { status: 404, code: "not_found" }));
    renderEvent();
    expect(await screen.findByText("事件页还在准备")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到前沿动态" })).toHaveAttribute("href", "/app/frontier");
  });

  it("says the event is gone when the server does not know it", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_event_not_found" }));
    renderEvent();
    expect(await screen.findByText("这个事件已不存在")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看热榜" })).toHaveAttribute("href", "/app/frontier?view=hot");
  });

  it("offers a retry on a failure", async () => {
    client.fetchFrontierEvent.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }));
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 1, name: /脂质体/ })).toBeInTheDocument();
  });

  it("is the one sentence where the module is off", async () => {
    client.useFrontierFeature.mockReturnValue("off");
    renderEvent();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.fetchFrontierEvent).not.toHaveBeenCalled();
  });
});

it("returns to the originating filtered feed rather than resetting its address", async () => {
  render(<MemoryRouter initialEntries={[
    "/app/frontier?view=all&lane=safety&q=lipid",
    { pathname: "/app/frontier/events/ev1", state: { frontierOrigin: "/app/frontier?view=all&lane=safety&q=lipid" } },
  ]} initialIndex={1}><Routes>
    <Route path="/app/frontier/events/:eventId" element={<FrontierEventPage />} />
    <Route path="/app/frontier" element={<div>Originating feed</div>} />
  </Routes></MemoryRouter>);
  await screen.findByRole("heading", { level: 1, name: event().title });
  const back = within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "前沿动态" });
  expect(back).toHaveAttribute("href", "/app/frontier?view=all&lane=safety&q=lipid");
  await userEvent.click(back);
  expect(await screen.findByText("Originating feed")).toBeInTheDocument();
});

describe("an event with many reports", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({
    ...frontierItem({ id: `m${index}`, title: `第 ${index + 1} 篇报道`, source: { id: `s${index}`, name: `来源 ${index + 1}` },
      sourceType: index % 3 === 0 ? "journal" : "media", sourceTypeLabel: index % 3 === 0 ? "期刊" : "媒体", timelineAt: ago(index + 1) }),
    role: index === 0 ? "primary" as const : "report" as const,
  }));

  it("narrows the reports to one kind of source, and the headings' counts follow", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: many(12) }));
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "全部来源" }));
    expect((await screen.findAllByRole("menuitemradio")).map((entry) => entry.textContent)).toEqual(["全部来源", "期刊", "媒体"]);
    expect(screen.getByRole("heading", { level: 2, name: "报道时间线" }).parentElement).toHaveTextContent("报道时间线11");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "期刊" }));
    // 12 reports: journals are 0, 3, 6, 9; the first one is the primary.
    expect(screen.getByRole("heading", { level: 2, name: "一手材料" }).parentElement).toHaveTextContent("一手材料1");
    expect(screen.getByRole("heading", { level: 2, name: "报道时间线" }).parentElement).toHaveTextContent("报道时间线3");
    expect(timelineRows()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "全部来源：期刊" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "全部来源" }));
    expect(screen.getByRole("heading", { level: 2, name: "报道时间线" }).parentElement).toHaveTextContent("报道时间线11");
  });

  it("hides a group the chosen kind has nothing in — except the one that holds the filter, which stays with its count of nothing", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: many(12) }));
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "全部来源" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "媒体" }));
    // 12 reports: the one primary is a journal. The first group keeps its heading — and the filter, which is what brings it back.
    const first = screen.getByRole("heading", { level: 2, name: "一手材料" });
    expect(first.parentElement).toHaveTextContent("一手材料0");
    expect(first.closest("section")).toContainElement(screen.getByRole("button", { name: "全部来源：媒体" }));
    expect(screen.getByRole("heading", { level: 2, name: "报道时间线" }).parentElement).toHaveTextContent("报道时间线8");
    await userEvent.click(screen.getByRole("button", { name: "全部来源：媒体" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "全部来源" }));
    expect(screen.getByRole("heading", { level: 2, name: "一手材料" }).parentElement).toHaveTextContent("一手材料1");
  });

  it("puts the source filter in the first group's heading, over the rows it narrows", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: many(12) }));
    renderEvent();
    const filter = await screen.findByRole("button", { name: "全部来源" });
    expect(screen.getByRole("heading", { level: 2, name: "一手材料" }).closest("section")).toContainElement(filter);
    expect(within(screen.getByRole("group", { name: "报道的顺序与来源" })).getByRole("button", { name: "全部来源" })).toBe(filter);
  });
  it("offers no menu when all the reports are of one kind", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: many(12).map((item) => ({ ...item, sourceTypeLabel: "媒体" })) }));
    renderEvent();
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(screen.queryByRole("button", { name: "全部来源" })).not.toBeInTheDocument();
  });
});

describe("the order of the reports", () => {
  const reportTitles = () => timelineRows().map((row) => row.querySelector("a")?.textContent);
  it("reads newest first, then oldest first on 最早 — asked of the server and kept in the address — and back", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: [
      { ...frontierItem({ id: "a", title: "最早的报道", timelineAt: ago(30) }), role: "report" },
      { ...frontierItem({ id: "b", title: "最新的报道", timelineAt: ago(1) }), role: "report" },
      { ...frontierItem({ id: "c", title: "中间的报道", timelineAt: ago(10) }), role: "report" },
    ] }));
    renderEvent();
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(reportTitles()).toEqual(["最新的报道", "中间的报道", "最早的报道"]);
    const order = screen.getByRole("group", { name: "报道顺序" });
    expect(within(order).getByRole("button", { name: "最新" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(order).getByRole("button", { name: "最早" }));
    expect(reportTitles()).toEqual(["最早的报道", "中间的报道", "最新的报道"]);
    expect(screen.getByTestId("location")).toHaveTextContent("/app/frontier/events/ev1?order=asc");
    await waitFor(() => expect(client.fetchFrontierEvent).toHaveBeenLastCalledWith("ev1", "asc"));
    // The event stays on screen while it is read again.
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("group", { name: "报道顺序" })).getByRole("button", { name: "最新" }));
    expect(reportTitles()).toEqual(["最新的报道", "中间的报道", "最早的报道"]);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/frontier\/events\/ev1$/);
  });

  it("opens in the order its address names", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event());
    renderEvent("ev1", "?order=asc");
    await screen.findByRole("heading", { level: 1 });
    expect(client.fetchFrontierEvent).toHaveBeenCalledWith("ev1", "asc");
    expect(within(screen.getByRole("group", { name: "报道顺序" })).getByRole("button", { name: "最早" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the timeline by Beijing day", () => {
  /** [id, title, the moment it stands at]: three Beijing days, and a report that is another UTC day than the one beside it. */
  const reports = (extra: Array<ReturnType<typeof report>> = []) => [
    report("a", "凌晨的报道", "2026-03-13T17:30:00.000Z"), // 3月14日 01:30 in Beijing, the 13th in UTC
    report("b", "上午的报道", "2026-03-14T02:00:00.000Z"), // 3月14日 10:00
    report("c", "次日的报道", "2026-03-15T03:00:00.000Z"), // 3月15日 11:00
    report("d", "夜里的报道", "2026-03-15T16:30:00.000Z"), // 3月16日 00:30 in Beijing, the 15th in UTC
    ...extra,
  ];
  function report(id: string, title: string, timelineAt: string, over: Record<string, unknown> = {}) {
    return { ...frontierItem({ id, title, timelineAt, source: { id: `s-${id}`, name: `来源 ${id}` }, sourceType: "media", sourceTypeLabel: "媒体", selected: false, ...over }), role: "report" as const };
  }
  const days = () => Array.from(document.querySelectorAll<HTMLElement>("[data-event-timeline] > section")).map((section) => ({
    heading: section.querySelector("h3")?.firstChild?.textContent,
    rows: Array.from(section.querySelectorAll("li p")).map((row) => row.textContent),
  }));

  it("groups the reports by the day they stand at in Beijing — not by UTC's, not by the browser's — newest day first", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: reports(), hasPrimary: false, primary: null }));
    renderEvent();
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(days()).toEqual([
      { heading: "3月16日 周一", rows: ["夜里的报道"] },
      { heading: "3月15日 周日", rows: ["次日的报道"] },
      { heading: "3月14日 周六", rows: ["上午的报道", "凌晨的报道"] },
    ]);
    // The heading is the day, and it says how many reports the day holds.
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["3月16日 周一1 篇", "3月15日 周日1 篇", "3月14日 周六2 篇"]);
    expect(screen.getByRole("heading", { level: 2, name: "报道时间线" }).parentElement).toHaveTextContent("报道时间线4");
  });

  it("says each row's clock in Beijing time, and no clock for a source that stated only its day", async () => {
    const dayOnly = report("e", "只有日期的报道", "2026-03-14T15:59:59.999Z", { datePrecision: "day" }); // the 14th's last millisecond in Beijing
    client.fetchFrontierEvent.mockResolvedValue(event({ items: [...reports(), dayOnly], hasPrimary: false, primary: null }));
    renderEvent();
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    const row = (title: string) => timelineRows().find((entry) => entry.querySelector("p")?.textContent === title)!;
    expect(row("凌晨的报道")).toHaveTextContent("来源 a·媒体·01:30·原文");
    expect(row("夜里的报道")).toHaveTextContent("来源 d·媒体·00:30·原文");
    expect(row("只有日期的报道")).toHaveTextContent(/^只有日期的报道来源 e·媒体·原文 ↗$/);
    expect(days().find((entry) => entry.heading === "3月14日 周六")?.rows).toContain("只有日期的报道");
  });

  it("reads the oldest day first on 最早, the days and the rows inside them both", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: reports(), hasPrimary: false, primary: null }));
    renderEvent("ev1", "?order=asc");
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(days()).toEqual([
      { heading: "3月14日 周六", rows: ["凌晨的报道", "上午的报道"] },
      { heading: "3月15日 周日", rows: ["次日的报道"] },
      { heading: "3月16日 周一", rows: ["夜里的报道"] },
    ]);
  });

  it("leaves the parties' own texts out of the days: they are the group above, with the day gone from their rows", async () => {
    const own = { ...report("p", "论文原文", "2026-03-15T03:00:00.000Z"), role: "primary" as const };
    client.fetchFrontierEvent.mockResolvedValue(event({ items: [own, ...reports()] }));
    renderEvent();
    await screen.findByRole("list", { name: "一手材料" });
    expect(days().flatMap((entry) => entry.rows)).not.toContain("论文原文");
    expect(days().map((entry) => entry.heading)).toEqual(["3月16日 周一", "3月15日 周日", "3月14日 周六"]);
  });

  it("opens a report from its day through the addressed reader, as it did", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ items: reports(), hasPrimary: false, primary: null }));
    renderEvent();
    await screen.findByRole("heading", { level: 2, name: "报道时间线" });
    expect(within(screen.getAllByRole("list", { name: "3月15日 周日的报道" })[0]).getByRole("link", { name: "次日的报道" })).toHaveAttribute("href", "/app/frontier/items/c");
  });
});

describe("the event page's composition", () => {
  it("is a reader — the document's serif title, the one action on the title's row — with the sections as Section headings", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event());
    const { container } = renderEvent();
    const title = await screen.findByRole("heading", { level: 1, name: "不饱和磷脂多层多囊脂质体实现亲水药物超缓释" });
    expect(title).toHaveClass("text-doc-title");
    expectComposed(container, { tablists: 0, stepRail: false, toolbar: false });
    expect(title.closest("[data-page-header]")).toContainElement(screen.getByRole("button", { name: "深入研究" }));
    expect(screen.getByRole("heading", { level: 2, name: "概要" })).toHaveClass("text-section");
  });

  it("is a screen of its own — an icon, one sentence, the way on and the way back — for an event that is gone", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_event_not_found" }));
    const { container } = renderEvent();
    expect(await screen.findByRole("heading", { level: 1, name: "这个事件已不存在" })).toBeInTheDocument();
    expect(container.querySelector("[data-state-screen]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "看热榜" })).toHaveAttribute("href", "/app/frontier?view=hot");
    expect(screen.getByRole("link", { name: "回到前沿动态" })).toHaveAttribute("href", "/app/frontier");
  });
});

describe("tracking (G12, 2026-10-25)", () => {
  it("registers its reports as a list: an open from a report is an `event` open at its place in the order shown, not a direct arrival", async () => {
    const user = userEvent.setup();
    const base = event();
    // Public ids as the server makes them (the validator refuses any other shape).
    client.fetchFrontierEvent.mockResolvedValue({ ...base, items: [{ ...base.items[0], id: "a1b2c3d4e5f60718" }, { ...base.items[1], id: "0f1e2d3c4b5a6978" }] });
    renderEvent();
    await screen.findByRole("list", { name: "一手材料" });
    await user.click(within(document.querySelector<HTMLElement>("[data-event-timeline]")!).getByRole("link", { name: "缓释脂质体注射剂在大鼠中实现持续神经阻滞" }));
    const opens = pendingFrontierEvents().filter((entry) => entry.type === "open");
    // The parties' own text is first on the page, so the other report is the second entry of the list.
    expect(opens.map((entry) => [entry.item, entry.surface, entry.position, entry.list])).toEqual([["0f1e2d3c4b5a6978", "event", 1, null]]);
    expect(opens[0].view).toMatch(/^view_/);
  });

  it("does not count a link to a related event as a report of the list", async () => {
    const user = userEvent.setup();
    renderEvent();
    await user.click(await screen.findByRole("link", { name: "同类缓释制剂的早先报道" }));
    expect(pendingFrontierEvents().filter((entry) => entry.type === "open" && entry.surface === "event")).toEqual([]);
  });
});
