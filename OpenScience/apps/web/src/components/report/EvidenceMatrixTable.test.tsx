import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaimMatrix, type ClaimCheckState } from "@/lib/claimCitations";
import { EvidenceMatrixTable } from "./EvidenceMatrixTable";
import type { VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";

const claims = parseClaimMatrix(JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "不降低主要心血管事件。", claimType: "direct", referenceNumber: 12, sourceType: "rct", accessLevel: "full_text",
    sourceTitle: "ASPREE", identifier: "doi:10.1056/x", artifactPath: ".evimed-sources/aspree/fulltext.md", supportQuote: "did not result in a significantly lower risk" },
  { claimId: "CLM-003", claim: "三项试验综合。", claimType: "synthesized", confidence: "moderate", supportingSources: [
    { sourceType: "systematic-review", sourceTitle: "Meta", sourceUrl: "https://example.org/meta", supportQuote: "lower risk of cardiovascular events" },
    { sourceType: "rct", sourceTitle: "ARRIVE", supportQuote: "event rate was much lower than expected" },
  ] },
] }));

const verified = new Map<string, VerifiedClaim>([
  ["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }],
  ["CLM-003", { claimId: "CLM-003", claimType: "synthesized", status: "source_unavailable", sources: [
    { artifactPath: null, status: "no_quote" }, { artifactPath: null, status: "source_unavailable" },
  ] }],
]);

function renderMatrix(props: Partial<Parameters<typeof EvidenceMatrixTable>[0]> = {}) {
  return render(
    <MemoryRouter>
      <EvidenceMatrixTable claims={claims} verified={verified} verificationState="ready" runId="run_1" {...props} />
    </MemoryRouter>,
  );
}

/** A matrix of `count` claims, alternating direct and synthesized, each checked and one in four not found. */
function manyClaims(count: number) {
  const list = Array.from({ length: count }, (_, index) => {
    const id = `CLM-${String(index + 1).padStart(3, "0")}`;
    return { claimId: id, claim: `第 ${index + 1} 条结论`, claimType: index % 2 ? "synthesized" : "direct", sourceTitle: `文献 ${index + 1}`, supportQuote: `quote ${index + 1}` };
  });
  return {
    claims: parseClaimMatrix(JSON.stringify({ claims: list })),
    verified: new Map<string, VerifiedClaim>(list.map((claim, index) => [claim.claimId, {
      claimId: claim.claimId, claimType: claim.claimType, status: index % 4 === 3 ? "quote_not_found" : "verified", sources: [{ artifactPath: null, status: "verified" }],
    }])),
  };
}

function phone() {
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EvidenceMatrixTable: the list", () => {
  // The audit's finding: the check was the seventh column and cut at the right edge. It is the second one now.
  it("is a compact table with the check as its second column, the id frozen, and no quotation in a row", () => {
    renderMatrix();
    const table = screen.getByRole("table", { name: "证据矩阵：2 条结论" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["结论", "核对", "内容", "来源", "类型"]);
    const first = within(table).getByRole("rowheader", { name: "CLM-001" });
    expect(first).toHaveClass("sticky", "left-0");
    const row = first.closest("tr")!;
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["✓ 已核对", "不降低主要心血管事件。", "ASPREE", "直接证据"]);
    // The reference number, the quotation and the PICO are the drawer's.
    expect(within(row).queryByText("12")).toBeNull();
    expect(within(row).queryByText(/did not result/)).toBeNull();
  });

  it("names the first source and how many more a synthesized claim stands on", () => {
    renderMatrix();
    const row = screen.getByRole("rowheader", { name: "CLM-003" }).closest("tr")!;
    expect(within(row).getByText("Meta")).toBeInTheDocument();
    expect(within(row).getByText("等 2 项")).toBeInTheDocument();
    expect(within(row).getByText("⚠ 原文未保存")).toBeInTheDocument();
    expect(within(row).getByText("综合结论")).toBeInTheDocument();
  });

  it("lists every claim of a matrix of 112, and says it shows all of them", () => {
    const many = manyClaims(112);
    renderMatrix({ claims: many.claims, verified: many.verified });
    expect(screen.getByText("显示 112 / 112 条")).toBeInTheDocument();
    expect(screen.getAllByRole("rowheader")).toHaveLength(112);
  });

  it("keeps the old sentence for a matrix with nothing in it", () => {
    renderMatrix({ claims: new Map() });
    expect(screen.getByText("这个证据矩阵里没有可读的结论。")).toBeInTheDocument();
  });

  // Chromium focuses a scroller by itself; WebKit and Firefox do not, so the matrix says what it is.
  it("is a keyboard-reachable labelled region wherever the table is wider than its box", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    renderMatrix();
    const region = screen.getByRole("region", { name: "证据矩阵" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });
});

describe("EvidenceMatrixTable: finding a claim", () => {
  it("searches the sentence, the id, the source title and the quotation, in any case, and counts what it shows", async () => {
    renderMatrix();
    const search = screen.getByRole("searchbox", { name: "搜索结论" });
    await userEvent.type(search, "aspree");
    expect(screen.getByRole("rowheader", { name: "CLM-001" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "CLM-003" })).toBeNull();
    expect(screen.getByText("显示 1 / 2 条")).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, "EVENT RATE was much");
    expect(screen.getByRole("rowheader", { name: "CLM-003" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "CLM-001" })).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "clm-001");
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["CLM-001"]);

    await userEvent.clear(search);
    await userEvent.type(search, "三项试验");
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["CLM-003"]);
  });

  it("narrows by whether the quotation was found: 已核对, or 需要复核 for everything else", async () => {
    renderMatrix();
    const group = screen.getByRole("group", { name: "核对" });
    await userEvent.click(within(group).getByRole("button", { name: "需要复核" }));
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["CLM-003"]);
    expect(screen.getByText("显示 1 / 2 条")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "已核对" }));
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["CLM-001"]);
    await userEvent.click(within(group).getByRole("button", { name: "全部" }));
    expect(screen.getAllByRole("rowheader")).toHaveLength(2);
  });

  it("narrows by the kind of claim, and offers the kinds only when the matrix has more than one", async () => {
    const view = renderMatrix();
    await userEvent.click(screen.getByRole("button", { name: "类型" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "综合结论" }));
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["CLM-003"]);
    view.unmount();

    const onlyDirect = new Map([...claims].filter(([id]) => id === "CLM-001"));
    renderMatrix({ claims: onlyDirect });
    expect(screen.queryByRole("button", { name: "类型" })).toBeNull();
  });

  it("says nothing fits, and 清除筛选 brings every claim back", async () => {
    renderMatrix();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索结论" }), "没有这个词");
    await userEvent.click(within(screen.getByRole("group", { name: "核对" })).getByRole("button", { name: "已核对" }));
    expect(screen.getByText("没有符合的结论")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getAllByRole("rowheader")).toHaveLength(2);
    expect(screen.getByRole("searchbox", { name: "搜索结论" })).toHaveValue("");
    expect(screen.getByText("显示 2 / 2 条")).toBeInTheDocument();
  });
});

describe("EvidenceMatrixTable: the check says what is known", () => {
  const rowsRead = (state: ClaimCheckState, checks?: Map<string, VerifiedClaim>) => {
    renderMatrix({ verificationState: state, verified: checks ?? new Map() });
    return screen.getAllByRole("rowheader").map((header) => within(header.closest("tr")!).getAllByRole("cell")[0].textContent);
  };

  it("says 核对中 while the checks are still being read, never 未核对", () => {
    expect(rowsRead("loading")).toEqual(["核对中", "核对中"]);
    expect(screen.queryByText("未核对")).toBeNull();
    // One quiet announcement, no tally and no filter on a check nobody has.
    expect(screen.getByRole("status")).toHaveTextContent("正在读取这些结论的核对结果");
    // The count is of rows, known before the checks: it shows while they load too (release-11 walk).
    expect(screen.getByText("显示 2 / 2 条")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "核对" })).toBeNull();
  });

  it("says 暂无核对结果 when they could not be read, and offers no filter on them", () => {
    expect(rowsRead("unavailable")).toEqual(["暂无核对结果", "暂无核对结果"]);
    expect(screen.queryByText("未核对")).toBeNull();
    expect(screen.queryByRole("group", { name: "核对" })).toBeNull();
    expect(screen.getByText("显示 2 / 2 条")).toBeInTheDocument();
  });

  it("says 未核对 only when they were read and the claim is not among them", () => {
    expect(rowsRead("ready", new Map([["CLM-001", verified.get("CLM-001")!]]))).toEqual(["✓ 已核对", "未核对"]);
    expect(screen.getByRole("group", { name: "核对" })).toBeInTheDocument();
  });

  it("treats a claim as the checks read it when the caller gives no state: found checks mean read, none mean unreadable", () => {
    const first = renderMatrix({ verificationState: undefined });
    expect(screen.getAllByText("✓ 已核对")).toHaveLength(1);
    first.unmount();
    renderMatrix({ verificationState: undefined, verified: new Map() });
    expect(screen.getAllByText("暂无核对结果")).toHaveLength(2);
  });

  it("says a derived claim has no quotation to check, whatever the state", () => {
    const derived = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-009", claim: "合并后的绝对风险差 0.4%。", claimType: "derived", method: "由 CLM-001 与 CLM-003 的事件数相减", derivedFrom: ["CLM-001", "CLM-003"] },
    ] }));
    renderMatrix({ claims: derived, verificationState: "loading", verified: new Map() });
    expect(screen.getByText("推导，无引文")).toBeInTheDocument();
  });
});

describe("EvidenceMatrixTable: a claim in the drawer", () => {
  it("opens from a click on the row with the sentence, the quotation in full, the way to the original and the check", async () => {
    renderMatrix();
    await userEvent.click(screen.getByText("不降低主要心血管事件。"));
    const drawer = await screen.findByRole("dialog", { name: "CLM-001" });
    for (const label of ["内容", "来源与引文", "核对"]) expect(within(drawer).getByRole("heading", { name: label })).toBeInTheDocument();
    expect(within(drawer).getByText("不降低主要心血管事件。")).toBeInTheDocument();
    expect(within(drawer).getByText("文献 [12]")).toBeInTheDocument();
    expect(within(drawer).getByText("“did not result in a significantly lower risk”")).toBeInTheDocument();
    expect(within(drawer).getByText("ASPREE")).toBeInTheDocument();
    expect(within(drawer).getByText("全文")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /定位原文/ })).toHaveAttribute(
      "href", "/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=did%20not%20result%20in%20a%20significantly%20lower%20risk",
    );
    // The check sits under the id, so a long panel never hides it, and the dialog is described by it.
    expect(within(drawer).getByText("✓ 已核对")).toBeInTheDocument();
    expect(drawer).toHaveAccessibleDescription("✓ 已核对");
    expect(within(drawer).getByText("引文已在保存的原文中核对")).toBeInTheDocument();
  });

  it("opens from the keyboard, closes on Escape and gives the focus back to the row's button", async () => {
    renderMatrix();
    const opener = screen.getByRole("button", { name: "CLM-003" });
    opener.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "CLM-003" })).toBeInTheDocument();
    // The drawer focuses its panel, so no tooltip is up and one Escape closes it (release-11 walk).
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("gives the focus back to a card on a phone, where a tap does not focus the button it lands on", async () => {
    phone();
    renderMatrix();
    const search = screen.getByRole("searchbox", { name: "搜索结论" });
    search.focus();
    // A tap that leaves focus where it was (iOS Safari): the click event alone, no focus change.
    fireEvent.click(document.getElementById("matrix-CLM-003")!.querySelector("button")!);
    await screen.findByRole("dialog", { name: "CLM-003" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.getElementById("matrix-CLM-003")!.querySelector("button")).toHaveFocus();
  });

  it("returns the focus to the row's button also when the row was clicked elsewhere", async () => {
    renderMatrix();
    await userEvent.click(screen.getByText("三项试验综合。"));
    await screen.findByRole("dialog", { name: "CLM-003" });
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "CLM-003" })).toHaveFocus();
  });

  it("does not open when the click ended a text selection", async () => {
    renderMatrix();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "三项" } as unknown as Selection);
    await userEvent.click(screen.getByText("三项试验综合。"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives a synthesized claim every source with its own quotation, check and place, and links one with no preserved copy to the source", async () => {
    const placed = new Map<string, VerifiedClaim>([
      ["CLM-001", verified.get("CLM-001")!],
      ["CLM-003", { claimId: "CLM-003", claimType: "synthesized", status: "quote_not_found", sources: [
        { artifactPath: null, status: "verified", sourceType: "systematic-review", location: { status: "unknown", page: { status: "unknown", reason: "no_page_markers" }, reason: "not_in_a_table" } },
        { artifactPath: null, status: "quote_not_found" },
      ] }],
    ]);
    renderMatrix({ verified: placed });
    await userEvent.click(screen.getByRole("button", { name: "CLM-003" }));
    const drawer = await screen.findByRole("dialog", { name: "CLM-003" });
    const sources = within(drawer).getAllByRole("listitem");
    expect(sources).toHaveLength(2);
    expect(within(sources[0]).getByText("“lower risk of cardiovascular events”")).toBeInTheDocument();
    expect(within(sources[0]).getByText("✓ 已核对")).toBeInTheDocument();
    expect(within(sources[0]).getByRole("link", { name: "打开原始来源" })).toHaveAttribute("href", "https://example.org/meta");
    expect(within(sources[1]).getByText("⚠ 原文中未找到")).toBeInTheDocument();
    // Only the source that carries a location says anything about one.
    expect(within(drawer).getAllByText(/^位置：/)).toHaveLength(1);
    expect(within(sources[0]).getByText("位置：位置未知")).toBeInTheDocument();
    expect(within(drawer).getByText("把握度中")).toBeInTheDocument();
    // What to do about the second quotation, by position.
    expect(within(drawer).getByText(/第 2 段引文没有在保存的原文中找到/)).toBeInTheDocument();
  });

  it("shows a claim's PICO and certainty, the level stated and the one its parts give", async () => {
    const appraised = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "不降低主要心血管事件。", claimType: "direct", referenceNumber: 12, artifactPath: ".evimed-sources/aspree/fulltext.md",
        supportQuote: "did not result in a significantly lower risk",
        pico: { population: "≥70 岁社区成人", intervention: "阿司匹林", comparator: "安慰剂", outcome: "主要心血管事件" },
        certainty: { start: "high", imprecision: -1, upgrades: { largeEffect: 1 }, rationale: "见正文", label: "high" } },
    ] }));
    // The control plane stamped the source a randomized trial: the upgrade does not count.
    const checked = new Map<string, VerifiedClaim>([["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [
      { artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified", sourceType: "rct" },
    ] }]]);
    renderMatrix({ claims: appraised, verified: checked });
    // Not in the row: that is what made three rows a screen.
    expect(screen.queryByLabelText("PICO")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "CLM-001" }));
    const drawer = await screen.findByRole("dialog", { name: "CLM-001" });
    expect(within(drawer).getByLabelText("PICO")).toHaveTextContent("结局主要心血管事件");
    expect(within(drawer).getByLabelText("证据确定性：高")).toBeInTheDocument();
    expect(within(drawer).getByText("标注为“高”，按各分项计算为“中”")).toBeInTheDocument();
  });

  it("shows where each quotation sits in its source: the table and cell, the page, or that it is not known", async () => {
    const placed = new Map<string, VerifiedClaim>([
      ["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified", location: {
        status: "located", table: { id: "tbl-1", index: 1, label: "Table 2" }, row: 3, cell: { row: 3, column: 2 }, page: { status: "located", pages: [7] } } }] }],
    ]);
    renderMatrix({ verified: placed });
    await userEvent.click(screen.getByRole("button", { name: "CLM-001" }));
    expect(await screen.findByText("位置：Table 2 第 3 行第 2 列 · 第 7 页")).toBeInTheDocument();
  });

  it("says what a derived claim rests on and that it has no quotation", async () => {
    const derived = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-009", claim: "合并后的绝对风险差 0.4%。", claimType: "derived", method: "两组事件数相减", uncertainty: "未校正随访时间差异", derivedFrom: ["CLM-001"] },
    ] }));
    renderMatrix({ claims: derived, verified: new Map() });
    await userEvent.click(screen.getByRole("button", { name: "CLM-009" }));
    const drawer = await screen.findByRole("dialog", { name: "CLM-009" });
    expect(within(drawer).getByText("方法：两组事件数相减")).toBeInTheDocument();
    expect(within(drawer).getByText("不确定性：未校正随访时间差异")).toBeInTheDocument();
    expect(within(drawer).getByText("这条结论没有给出来源。")).toBeInTheDocument();
    expect(within(drawer).getByText("推导结果：由其他结论计算或推断，本身没有引文")).toBeInTheDocument();
  });

  it("says in the drawer, too, that the checks are on their way or could not be read", async () => {
    const loading = renderMatrix({ verificationState: "loading", verified: new Map() });
    await userEvent.click(screen.getByRole("button", { name: "CLM-001" }));
    expect(await within(await screen.findByRole("dialog")).findByText("正在读取这条结论的核对结果。")).toBeInTheDocument();
    loading.unmount();
    renderMatrix({ verificationState: "unavailable", verified: new Map() });
    await userEvent.click(screen.getByRole("button", { name: "CLM-001" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("暂无核对结果")).toBeInTheDocument();
    expect(within(drawer).queryByText("未核对")).toBeNull();
  });
});

describe("EvidenceMatrixTable: on a phone", () => {
  it("is a list of cards, not a table that scrolls sideways: id and check on one line, the sentence, the first source", () => {
    phone();
    renderMatrix();
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "证据矩阵" });
    const cards = within(list).getAllByRole("button");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("CLM-001✓ 已核对不降低主要心血管事件。ASPREE");
    expect(cards[1]).toHaveTextContent("CLM-003⚠ 原文未保存三项试验综合。Meta 等 2 项");
    // The check is on the first line of the card, where a thumb sees it.
    expect(within(cards[1]).getByText("⚠ 原文未保存")).toBeInTheDocument();
  });

  it("opens the claim from a card, search and filters included", async () => {
    phone();
    renderMatrix();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索结论" }), "meta");
    expect(within(screen.getByRole("list", { name: "证据矩阵" })).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /CLM-003/ }));
    const drawer = await screen.findByRole("dialog", { name: "CLM-003" });
    expect(within(drawer).getByText("“lower risk of cardiovascular events”")).toBeInTheDocument();
  });

  // A pane beside a conversation is as narrow as a phone on a wide screen: where the box can be measured, the box decides.
  it("goes by the width of its own box where that can be measured, and does not flip at the edge", () => {
    // Every observer of the page (the table's scroll box has one too) hears the same news.
    const observers = new Set<(entries: Array<{ contentRect: { width: number } }>) => void>();
    const measure = (width: number) => observers.forEach((callback) => callback([{ contentRect: { width } }]));
    vi.stubGlobal("ResizeObserver", class {
      private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void;
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { this.callback = callback; observers.add(callback); }
      observe() {}
      unobserve() {}
      disconnect() { observers.delete(this.callback); }
    });
    renderMatrix();
    expect(screen.getByRole("table")).toBeInTheDocument();
    act(() => measure(520));
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(screen.getByRole("list", { name: "证据矩阵" })).getAllByRole("button")).toHaveLength(2);
    // Back to the table only with room to spare, so a scrollbar appearing cannot flip it between the two.
    act(() => measure(650));
    expect(screen.queryByRole("table")).toBeNull();
    act(() => measure(700));
    expect(screen.getByRole("table")).toBeInTheDocument();
    act(() => measure(641));
    expect(screen.getByRole("table")).toBeInTheDocument();
    act(() => measure(639));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says 核对中 on a card too while the checks are being read", () => {
    phone();
    renderMatrix({ verificationState: "loading", verified: new Map() });
    expect(screen.getAllByText("核对中")).toHaveLength(2);
    expect(screen.queryByText("未核对")).toBeNull();
  });
});
