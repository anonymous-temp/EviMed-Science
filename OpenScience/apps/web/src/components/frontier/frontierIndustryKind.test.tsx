import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRONTIER_INDUSTRY_KIND_OPTIONS, listFrontierItems, parseFrontierItem } from "@/lib/frontierClient";
import { FrontierCard } from "./FrontierCard";
import { ReaderByline } from "./FrontierReader";
import { NO_FILTERS, feedFilters, readIndustryKind } from "./FrontierFilters";
import { cardEyebrow, industryKindTag } from "./frontierText";
import { frontierItem, rawFrontierItem } from "./__fixtures__/frontierItems";

/** The kinds of 行业动态 (c5-biz 2026-10-26): what the client reads, what the card and the reader say, what the filter offers and asks. */

const industry = (overrides: Record<string, unknown> = {}) => frontierItem({
  genre: "industry", genreLabel: "行业动态", evidenceType: null, evidenceTypeLabel: null, lane: "pipeline", laneLabel: "研发产业",
  industryKind: "financing", industryKindLabel: "融资与上市", ...overrides,
});

describe("the kind the client reads", () => {
  it("is the server's for an item of 行业动态, with its label, and the closed list's words when the server sent none", () => {
    const named = parseFrontierItem(rawFrontierItem({ genre: "industry", genreLabel: "行业动态", industryKind: "people", industryKindLabel: "人事与组织" }));
    expect([named?.industryKind, named?.industryKindLabel]).toEqual(["people", "人事与组织"]);
    const unlabelled = parseFrontierItem(rawFrontierItem({ genre: "industry", industryKind: "deal" }));
    expect([unlabelled?.industryKind, unlabelled?.industryKindLabel]).toEqual(["deal", "交易与授权"]);
  });

  it("is none for a word outside the list, for an item of another genre, and for a server that has none to say", () => {
    for (const raw of [
      rawFrontierItem({ genre: "industry", industryKind: "merger", industryKindLabel: "并购" }),
      rawFrontierItem({ genre: "industry", industryKind: "融资与上市" }),
      rawFrontierItem({ genre: "paper", industryKind: "deal", industryKindLabel: "交易与授权" }),
      rawFrontierItem({ genre: "industry" }),
      rawFrontierItem({ genre: "industry", industryKind: null, industryKindLabel: "融资与上市" }),
      rawFrontierItem(),
    ]) {
      const item = parseFrontierItem(raw);
      expect([item?.industryKind, item?.industryKindLabel], JSON.stringify(raw.genre)).toEqual([null, null]);
    }
  });

  it("offers the six kinds in the filter's order, each with its Chinese label", () => {
    expect(FRONTIER_INDUSTRY_KIND_OPTIONS.map((kind) => [kind.key, kind.label])).toEqual([
      ["deal", "交易与授权"], ["financing", "融资与上市"], ["people", "人事与组织"], ["operations", "公司经营"], ["pipeline", "研发管线"], ["other", "其他"],
    ]);
  });
});

describe("the list asks for one kind", () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const params = () => new URL(String(fetchMock.mock.calls[0][0]), "http://localhost").searchParams;
  const answer = () => new Response(JSON.stringify({ data: { items: [], nextCursor: null, version: 1, mode: "list" } }), { status: 200, headers: { "content-type": "application/json" } });

  it("names it by its key, and names nothing when there is none", async () => {
    fetchMock.mockResolvedValue(answer());
    await listFrontierItems({ view: "all", industryKind: "financing" });
    expect(params().get("industryKind")).toBe("financing");
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(answer());
    await listFrontierItems({ view: "all", industryKind: null });
    expect(params().has("industryKind")).toBe(false);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(answer());
    await listFrontierItems({ view: "all" });
    expect(params().has("industryKind")).toBe(false);
  });
});

describe("the filter", () => {
  it("reads a kind from the address, and nothing else", () => {
    for (const kind of ["deal", "financing", "people", "operations", "pipeline", "other"]) expect(readIndustryKind(kind)).toBe(kind);
    for (const value of [null, "", "merger", "融资与上市", "industry", "Deal", "deal,people"]) expect(readIndustryKind(value)).toBe("");
    expect(NO_FILTERS.industryKind).toBe("");
  });

  it("is one more choice of 「筛选」, beside 栏目: all, then the six kinds, and a choice is applied at once", () => {
    const onChange = vi.fn();
    const filters = feedFilters({ value: { ...NO_FILTERS, byTime: false }, showWindow: true, searching: false, onChange,
      hotTags: { loading: false, tags: [] } });
    const labels = filters.map((filter) => filter.label);
    expect(labels.indexOf("行业动态")).toBe(labels.indexOf("栏目") + 1);
    const group = filters.find((filter) => filter.label === "行业动态");
    expect(group).toMatchObject({ kind: "chips", folded: true, value: "", neutral: "" });
    if (!group || group.kind !== "chips") throw new Error("the kinds are a choice");
    expect(group.options.map((option) => option.label)).toEqual(["全部", "交易与授权", "融资与上市", "人事与组织", "公司经营", "研发管线", "其他"]);
    (group.onChange as (value: string) => void)("people");
    expect(onChange).toHaveBeenLastCalledWith({ industryKind: "people" });
    (group.onChange as (value: string) => void)("merger");
    expect(onChange).toHaveBeenLastCalledWith({ industryKind: "" });
    (group.onChange as (value: string) => void)("");
    expect(onChange).toHaveBeenLastCalledWith({ industryKind: "" });
  });
});

describe("what a card and the reader say", () => {
  afterEach(cleanup);

  it("puts the kind beside the genre in the eyebrow, and the genre alone when there is no kind or the kind is 「其他」", () => {
    expect(cardEyebrow(industry())).toBe("行业动态 · 融资与上市");
    expect(cardEyebrow(industry({ industryKind: "pipeline", industryKindLabel: "研发管线" }))).toBe("行业动态 · 研发管线");
    expect(cardEyebrow(industry({ industryKind: "other", industryKindLabel: "其他" }))).toBe("行业动态");
    expect(cardEyebrow(industry({ industryKind: null, industryKindLabel: null }))).toBe("行业动态");
    // Another genre never takes a kind, and a safety alert says 「安全警示」 already.
    expect(cardEyebrow(frontierItem({ genre: "news", genreLabel: "医学新闻", industryKind: "deal", industryKindLabel: "交易与授权" }))).toBe("医学新闻");
    expect(cardEyebrow(industry({ safetyAlert: true }))).toBeNull();
    // A card built before the kind existed has none.
    expect(cardEyebrow({ evidenceType: null, evidenceTypeLabel: null, safetyAlert: false, flags: [], laneLabel: "研发产业", genre: "industry", genreLabel: "行业动态" })).toBe("行业动态");
    expect(industryKindTag({ industryKind: "deal", industryKindLabel: "交易与授权" })).toBe("交易与授权");
    expect(industryKindTag({ industryKind: "other", industryKindLabel: "其他" })).toBeNull();
    expect(industryKindTag({})).toBeNull();
  });

  it("draws the card's eyebrow with the kind", () => {
    render(
      <MemoryRouter>
        <ul><FrontierCard item={industry()} onStar={vi.fn()} onHide={vi.fn()} onSave={vi.fn()} onOpened={vi.fn()} onTag={vi.fn()} /></ul>
      </MemoryRouter>,
    );
    expect(within(screen.getByRole("article")).getByText("行业动态 · 融资与上市")).toBeInTheDocument();
  });

  it("puts the kind in the reader's line beside the genre, as its own tag", () => {
    render(<MemoryRouter><ReaderByline item={industry()} /></MemoryRouter>);
    expect(screen.getByText("行业动态")).toBeInTheDocument();
    expect(screen.getByText("融资与上市")).toBeInTheDocument();
    cleanup();
    render(<MemoryRouter><ReaderByline item={industry({ industryKind: "other", industryKindLabel: "其他" })} /></MemoryRouter>);
    expect(screen.getByText("行业动态")).toBeInTheDocument();
    expect(screen.queryByText("其他")).not.toBeInTheDocument();
    cleanup();
    render(<MemoryRouter><ReaderByline item={frontierItem()} /></MemoryRouter>);
    expect(screen.queryByText("融资与上市")).not.toBeInTheDocument();
  });
});
