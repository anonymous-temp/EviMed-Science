import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { frontierItem } from "./__fixtures__/frontierItems";
import type { FrontierApprovalRow, FrontierApprovals, FrontierCongress, FrontierGuidelineRow, FrontierGuidelines } from "@/lib/frontierClient";
import {
  ApprovalsBody,
  CongressNowLine,
  CongressesBody,
  GuidelinesBody,
  congressDates,
  monthDay,
  readTrackSegment,
  trackControls,
  type TrackListState,
} from "./FrontierTrackView";

const client = vi.hoisted(() => ({ listFrontierCongresses: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));

function approvalRow(id: string, at: string, over: Partial<FrontierApprovalRow> = {}): FrontierApprovalRow {
  return { item: frontierItem({ id, title: `审批 ${id}` }), at, approval: "new-drug", approvalLabel: "首次获批", agency: { key: "fda", label: "FDA" }, drug: `药物 ${id}`, indication: "慢性乙型肝炎", ...over };
}
function approvalsPage(over: Partial<FrontierApprovals> = {}): FrontierApprovals {
  return { items: [], nextCursor: null, from: "2026-07-27", agencies: [{ key: "fda", label: "FDA", region: "us", regionLabel: "美国", count: 2 }, { key: "ema", label: "EMA", region: "eu", regionLabel: "欧洲", count: 1 }],
    ytd: { year: 2026, since: "2026-09-22", total: 12, byAgency: [{ key: "fda", label: "FDA", count: 7 }, { key: "ema", label: "EMA", count: 3 }, { key: "none", label: "未注明机构", count: 2 }] }, listId: null, ...over };
}
function paging<Page, Row>(state: TrackListState<Page>, rows: Row[], extra: Record<string, unknown> = {}) {
  return { state, rows, hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn(), ...extra };
}
const ready = <Page,>(page: Page, rows: number): TrackListState<Page> => ({ kind: "ready", page, rows });
const wrap = (node: React.ReactNode) => render(<MemoryRouter initialEntries={["/app/frontier?view=track"]}>{node}</MemoryRouter>);

// Braces: a function a hook returns is its teardown, and the spy must not be one.
beforeEach(() => { client.listFrontierCongresses.mockReset().mockResolvedValue([]); });

describe("the words and the address of 追踪", () => {
  it("reads a segment from the address, 审批 by default", () => {
    expect(readTrackSegment(null)).toBe("approvals");
    expect(readTrackSegment("guidelines")).toBe("guidelines");
    expect(readTrackSegment("congresses")).toBe("congresses");
    expect(readTrackSegment("nope")).toBe("approvals");
  });
  it("says a day and a meeting's dates", () => {
    expect(monthDay("2026-10-24")).toBe("10月24日");
    expect(congressDates("2026-10-23", "2026-10-27")).toBe("10月23日—27日");
    expect(congressDates("2026-10-30", "2026-11-02")).toBe("10月30日—11月2日");
    expect(congressDates("2026-10-30", "2026-10-30")).toBe("10月30日");
  });
});

describe("the toolbar's controls", () => {
  const base = { segment: "approvals" as const, onSegment: vi.fn(), agency: "", onAgency: vi.fn(), specialty: "", onSpecialty: vi.fn() };
  it("is the three segments and, for 审批, the agency with its counts", () => {
    const filters = trackControls({ ...base, approvals: ready(approvalsPage(), 3), guidelines: { kind: "idle" } });
    expect(filters).toHaveLength(2);
    expect(filters[0]).toMatchObject({ kind: "chips", value: "approvals", pinned: true });
    expect((filters[0] as unknown as { options: Array<{ label: string }> }).options.map((option) => option.label)).toEqual(["审批", "指南", "会议"]);
    expect(filters[1]).toMatchObject({ kind: "select", label: "机构", allLabel: "全部机构", value: null });
    expect((filters[1] as unknown as { options: Array<{ label: string }> }).options.map((option) => option.label)).toEqual(["FDA 2", "EMA 1"]);
  });
  it("is the specialty for 指南 and nothing but the segment for 会议 or while the list is read", () => {
    const guidelines = ready({ items: [], nextCursor: null, listId: null, specialties: [{ key: "oncology", label: "肿瘤", count: 2 }] } as FrontierGuidelines, 0);
    const forGuidelines = trackControls({ ...base, segment: "guidelines", specialty: "oncology", approvals: { kind: "idle" }, guidelines });
    expect(forGuidelines[1]).toMatchObject({ kind: "select", label: "专科", value: "oncology" });
    expect(trackControls({ ...base, segment: "congresses", approvals: ready(approvalsPage(), 1), guidelines })).toHaveLength(1);
    expect(trackControls({ ...base, approvals: { kind: "loading" }, guidelines: { kind: "idle" } })).toHaveLength(1);
  });
  it("changes the segment through the chips", () => {
    const onSegment = vi.fn();
    const chips = trackControls({ ...base, onSegment, approvals: { kind: "idle" }, guidelines: { kind: "idle" } })[0] as { onChange: (value: string) => void };
    chips.onChange("guidelines");
    chips.onChange("bogus");
    expect(onSegment.mock.calls).toEqual([["guidelines"], ["approvals"]]);
  });
});

describe("审批", () => {
  it("heads the list with the count by agency, each figure the filter to that agency, then groups the rows by month, each opening its article", async () => {
    const onAgency = vi.fn();
    const rows = [approvalRow("a1", "2026-10-24"), approvalRow("a2", "2026-10-10", { agency: { key: "ema", label: "EMA" }, approvalLabel: "新增适应症", indication: null }), approvalRow("a3", "2026-09-29")];
    wrap(<ApprovalsBody paging={paging(ready(approvalsPage({ items: rows }), 3), rows)} agency="" onAgency={onAgency} />);
    const note = document.querySelector("[data-note]")!;
    expect(note).toHaveTextContent("9月22日以来共收录 12 项审批：FDA 7，EMA 3");
    expect(note).not.toHaveTextContent("未注明");
    await userEvent.click(within(note as HTMLElement).getByRole("button", { name: "FDA 7 项，只看这个机构" }));
    expect(onAgency).toHaveBeenCalledWith("fda");
    expect(screen.getByRole("heading", { level: 2, name: "2026年10月" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "2026年9月" })).toBeInTheDocument();
    const october = screen.getByRole("list", { name: "2026年10月" });
    expect(within(october).getAllByRole("listitem")).toHaveLength(2);
    const first = within(october).getAllByRole("listitem")[0];
    expect(first).toHaveAttribute("data-frontier-item", "a1");
    expect(first).toHaveTextContent("10-24");
    expect(first).toHaveTextContent("药物 a1");
    expect(first).toHaveTextContent("慢性乙型肝炎");
    expect(first).toHaveTextContent("FDA");
    expect(first).toHaveTextContent("首次获批");
    // The row is one link to its article, its title's: stretched over the row as a feed card's is, so the row's link is one look at any
    // number of lines (a whole-row block link was a kind of control per height, release walk of evimed-5ae53861dc26-1).
    const link = within(first).getByRole("link");
    expect(link).toHaveAttribute("href", "/app/frontier/items/a1");
    expect(link).toHaveAccessibleName("药物 a1");
    expect(link.closest("[data-row-title]")).not.toBeNull();
    expect(link).toHaveClass("after:absolute", "after:inset-0");
    expect(link.parentElement!.closest(".relative")).toContainElement(within(first).getByText("慢性乙型肝炎"));
    expect(within(october).getAllByRole("listitem")[1]).toHaveTextContent("EMA·新增适应症");
    // No back office on the page.
    for (const gone of ["track_facts", "引文", "已核对", "模型"]) expect(document.body).not.toHaveTextContent(gone);
  });
  it("says the year when the count reaches back to January", () => {
    const rows = [approvalRow("a1", "2026-10-24")];
    wrap(<ApprovalsBody paging={paging(ready(approvalsPage({ items: rows, ytd: { year: 2026, since: "2026-01-09", total: 80, byAgency: [{ key: "fda", label: "FDA", count: 40 }] } }), 1), rows)} agency="" onAgency={vi.fn()} />);
    expect(document.querySelector("[data-note]")).toHaveTextContent("2026 年共收录 80 项审批：FDA 40");
  });
  it("shows more by the cursor", async () => {
    const loadMore = vi.fn();
    const rows = [approvalRow("a1", "2026-10-24")];
    wrap(<ApprovalsBody paging={paging(ready(approvalsPage({ items: rows }), 1), rows, { hasMore: true, loadMore })} agency="" onAgency={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "显示更多" }));
    expect(loadMore).toHaveBeenCalled();
  });
  it("is an empty state with a way on: out of an agency, or to the official sources", async () => {
    const onAgency = vi.fn();
    const { unmount } = wrap(<ApprovalsBody paging={paging(ready(approvalsPage({ items: [] }), 0), [])} agency="ema" onAgency={onAgency} />);
    expect(screen.getByText("这个机构最近 90 天没有收录到审批")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看全部机构" }));
    expect(onAgency).toHaveBeenCalledWith("");
    unmount();
    wrap(<ApprovalsBody paging={paging(ready(approvalsPage({ items: [], ytd: { year: 2026, since: null, total: 0, byAgency: [] } }), 0), [])} agency="" onAgency={vi.fn()} />);
    expect(screen.getByText("最近 90 天还没有收录到审批")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看官方来源的动态" })).toHaveAttribute("href", "/app/frontier?view=all&channel=official");
    expect(document.querySelector("[data-note]")).toBeNull();
  });
  it("says that the tracker is being prepared where the server has no route, and a failure asks again", async () => {
    const { unmount } = wrap(<ApprovalsBody paging={paging({ kind: "absent" }, [])} agency="" onAgency={vi.fn()} />);
    expect(screen.getByText("审批追踪还在准备")).toBeInTheDocument();
    unmount();
    const retry = vi.fn();
    wrap(<ApprovalsBody paging={paging({ kind: "error", message: "读取失败" }, [], { retry })} agency="" onAgency={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalled();
  });
});

describe("指南", () => {
  function guidelineRow(id: string, over: Partial<FrontierGuidelineRow> = {}): FrontierGuidelineRow {
    return { item: frontierItem({ id, title: `指南 ${id}` }), at: "2026-10-24", body: "美国内科医师学会", scope: "绝经症状", recommendations: [
      { text: "有子宫的女性使用雌激素联合孕激素", grade: "强推荐" }, { text: "不建议使用复方激素制剂", grade: null }, { text: "每年复查一次", grade: null }, { text: "第四条不显示", grade: null }], ...over };
  }
  it("lists the body, the date, the title and up to three recommendations with their grade; the row opens the article", () => {
    const rows = [guidelineRow("g1"), guidelineRow("g2", { recommendations: [], body: null })];
    wrap(<GuidelinesBody paging={paging(ready({ items: rows, nextCursor: null, specialties: [], listId: null } as FrontierGuidelines, 2), rows)} specialty="" onSpecialty={vi.fn()} />);
    const list = screen.getByRole("list", { name: "指南更新" });
    const first = within(list).getAllByRole("listitem")[0];
    expect(first).toHaveAttribute("data-frontier-item", "g1");
    expect(first).toHaveTextContent("美国内科医师学会");
    expect(first).toHaveTextContent("10月24日");
    expect(first).toHaveTextContent("指南 g1");
    const recommendations = within(first).getByRole("list", { name: "主要推荐" });
    expect(within(recommendations).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
      "有子宫的女性使用雌激素联合孕激素强推荐", "不建议使用复方激素制剂", "每年复查一次"]);
    expect(within(first).getAllByRole("link")).toHaveLength(1);
    expect(within(first).getByRole("link", { name: "指南 g1" })).toHaveAttribute("href", "/app/frontier/items/g1");
    expect(within(first).getByRole("link").closest("[data-row-title]")).not.toBeNull();
    // A row without recommendations says its scope instead.
    const topRows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li[data-frontier-item]"));
    expect(topRows).toHaveLength(2);
    expect(topRows[1]).toHaveTextContent("绝经症状");
    expect(within(topRows[1]).queryByRole("list", { name: "主要推荐" })).toBeNull();
  });
  it("marks an item that may change practice, with its reason on hover, once the item carries one", () => {
    const rows = [guidelineRow("g1", { item: { ...frontierItem({ id: "g1" }), practice: { reason: "首个获批的靶向药" } } as FrontierGuidelineRow["item"] }), guidelineRow("g2")];
    wrap(<GuidelinesBody paging={paging(ready({ items: rows, nextCursor: null, specialties: [], listId: null } as FrontierGuidelines, 2), rows)} specialty="" onSpecialty={vi.fn()} />);
    expect(screen.getAllByText("可能改变实践")).toHaveLength(1);
    // A label, never inside the row's link; above the stretched link, so its reason shows on hover.
    const mark = screen.getByText("可能改变实践");
    expect(mark.closest("a")).toBeNull();
    expect(mark).toHaveClass("relative", "z-sticky");
  });
  it("is an empty state with a way on", async () => {
    const onSpecialty = vi.fn();
    wrap(<GuidelinesBody paging={paging(ready({ items: [], nextCursor: null, specialties: [], listId: null } as FrontierGuidelines, 0), [])} specialty="oncology" onSpecialty={onSpecialty} />);
    await userEvent.click(screen.getByRole("button", { name: "看全部专科" }));
    expect(onSpecialty).toHaveBeenCalledWith("");
  });
});

describe("会议", () => {
  const congress = (over: Partial<FrontierCongress> = {}): FrontierCongress => ({ id: "esmo-2026", code: "ESMO 2026", name: "欧洲肿瘤内科学会年会", nameEn: "ESMO Congress 2026", start: "2026-10-23", end: "2026-10-27",
    city: "Madrid", specialty: "oncology", specialtyLabel: "肿瘤学", status: "ongoing", itemCount: 57, ...over });
  it("groups the congresses by where they stand, each with its dates, city, specialty and item count, opening its hub", () => {
    const state = { kind: "ready" as const, retry: vi.fn(), congresses: [congress(), congress({ id: "aha-2026", code: "AHA 2026", name: "美国心脏协会科学年会", status: "upcoming", start: "2026-11-06", end: "2026-11-09", itemCount: 0, city: "Chicago", specialtyLabel: "心血管" }),
      congress({ id: "gw-icc-2026", code: "GW-ICC 2026", name: "长城会", status: "recent", start: "2026-10-15", end: "2026-10-18", itemCount: 12, city: null })] };
    wrap(<CongressesBody state={state} />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["正在进行", "即将召开", "近期结束"]);
    const ongoing = within(screen.getByRole("list", { name: "正在进行" })).getByRole("link");
    expect(ongoing).toHaveAttribute("href", "/app/frontier/congress/esmo-2026");
    expect(ongoing).toHaveTextContent("ESMO 2026 · 欧洲肿瘤内科学会年会");
    expect(ongoing).toHaveTextContent("10月23日—27日 · Madrid · 肿瘤学");
    expect(ongoing).toHaveTextContent("57 条");
    const upcoming = within(screen.getByRole("list", { name: "即将召开" })).getByRole("link");
    expect(upcoming).toHaveTextContent("11月6日—9日 · Chicago · 心血管");
    expect(upcoming).toHaveTextContent(/天后开始|即将开始/);
    expect(within(screen.getByRole("list", { name: "近期结束" })).getByRole("link")).toHaveTextContent("12 条");
  });
  it("says when the calendar has none, and when the route does not exist", () => {
    const { unmount } = wrap(<CongressesBody state={{ kind: "ready", congresses: [], retry: vi.fn() }} />);
    expect(screen.getByText("近期没有大型学术会议")).toBeInTheDocument();
    unmount();
    wrap(<CongressesBody state={{ kind: "absent", retry: vi.fn() }} />);
    expect(screen.getByText("会议追踪还在准备")).toBeInTheDocument();
  });
});

describe("热榜's line while a congress is on", () => {
  it("is one link to the hub of the congress on now with the most items", async () => {
    client.listFrontierCongresses.mockResolvedValue([
      { id: "asn-kidney-week-2026", code: "ASN 2026", name: "肾脏周", nameEn: "", start: "2026-10-21", end: "2026-10-25", city: null, specialty: null, specialtyLabel: null, status: "ongoing", itemCount: 4 },
      { id: "esmo-2026", code: "ESMO 2026", name: "欧洲肿瘤内科学会年会", nameEn: "", start: "2026-10-23", end: "2026-10-27", city: null, specialty: null, specialtyLabel: null, status: "ongoing", itemCount: 57 },
      { id: "aha-2026", code: "AHA 2026", name: "x", nameEn: "", start: "2026-11-06", end: "2026-11-09", city: null, specialty: null, specialtyLabel: null, status: "upcoming", itemCount: 0 },
    ]);
    wrap(<CongressNowLine />);
    const link = await screen.findByRole("link", { name: /ESMO 2026/ });
    expect(link).toHaveTextContent("ESMO 2026进行中·57 条");
    expect(link).toHaveAttribute("href", "/app/frontier/congress/esmo-2026");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("is nothing while no congress is on, or the one on has no items", async () => {
    client.listFrontierCongresses.mockResolvedValue([{ id: "esmo-2026", code: "ESMO 2026", name: "x", nameEn: "", start: "2026-10-23", end: "2026-10-27", city: null, specialty: null, specialtyLabel: null, status: "ongoing", itemCount: 0 }]);
    const { container } = wrap(<CongressNowLine />);
    await waitFor(() => expect(client.listFrontierCongresses).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
  it("is nothing when the read failed", async () => {
    client.listFrontierCongresses.mockRejectedValue(new WebApiError("down", { status: 500, code: "server_error" }));
    const { container } = wrap(<CongressNowLine />);
    await waitFor(() => expect(client.listFrontierCongresses).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
