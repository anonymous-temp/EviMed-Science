import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readNetworkMetaCards, readVcrData, type VcrNetworkMetaCard } from "@/lib/vcrClient";
import { VcrNetworkMeta } from "./VcrNetworkMeta";
import payloads from "./__fixtures__/evidenceSynthesisPayloads.json";

/**
 * 网络荟萃分析: the card drawn from what the server's presenter makes of the engine's real results
 * (`__fixtures__/evidenceSynthesisPayloads.json`). The web places the numbers it is sent; it computes none of them.
 */

afterEach(cleanup);

const sample = (key: "network" | "network-chain"): VcrNetworkMetaCard => {
  const [card] = readNetworkMetaCards([payloads[key]]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const draw = (card: VcrNetworkMetaCard) => {
  const view = render(<VcrNetworkMeta cards={[card]} />);
  return { ...view, root: view.container.querySelector("[data-vcr-network-meta]") as HTMLElement };
};
const follows = (earlier: Element, later: Element) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("网络荟萃分析 · the card", () => {
  it("opens with its title, then the question as its first sentence", () => {
    const { root } = draw(sample("network"));
    const title = within(root).getByRole("heading", { name: "网络荟萃分析：response" });
    const question = root.querySelector("[data-vcr-evidence-question]") as HTMLElement;
    expect(question).toHaveTextContent("这几种治疗互相比起来怎么样？证据前后一致吗？谁排在前面？");
    expect(follows(title, question)).toBe(true);
    expect(root.querySelector("table")).not.toBeNull();
    expect(follows(question, root.querySelector("table") as Element)).toBe(true);
  });

  it("ranks the treatments best first with the reference marked, each score as a bar and its number", () => {
    const { root } = draw(sample("network"));
    const table = within(root).getByRole("table", { name: "网络荟萃分析：response：治疗排名" });
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-vcr-treatment"))).toEqual(["C", "B", "A"]);
    expect(rows.map((row) => row.getAttribute("data-vcr-rank"))).toEqual(["1", "2", "3"]);
    for (const header of ["排名", "治疗", "研究数", "排序得分"]) expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("96.1");
    expect(rows[0]).toHaveTextContent("%");
    expect(within(rows[0] as HTMLElement).getByRole("img", { name: "C 排序得分 96.1%" })).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByRole("img", { name: "A 排序得分 0.5%" })).toBeInTheDocument();
    // 「对照」 is on the reference alone
    expect(within(table).getAllByText("对照")).toHaveLength(1);
    expect(rows[2]).toHaveTextContent("对照");
    expect(rows[0]).not.toHaveTextContent("对照");
  });

  it("keeps the ranking in rank order whatever order the rows came in", () => {
    const shuffled = { ...payloads.network, ranking: [...payloads.network.ranking].reverse() };
    const [card] = readNetworkMetaCards([shuffled]);
    const { root } = draw(card);
    expect([...root.querySelectorAll("tr[data-vcr-rank]")].map((row) => row.getAttribute("data-vcr-treatment"))).toEqual(["C", "B", "A"]);
  });

  it("says what the score is under the ranking, before the league table", () => {
    const { root } = draw(sample("network"));
    const note = root.querySelector("[data-vcr-network-score-note]") as HTMLElement;
    expect(note).toHaveTextContent("不是“最好”的概率");
    const [ranking, league] = root.querySelectorAll("table");
    expect(follows(ranking, note)).toBe(true);
    expect(follows(note, league)).toBe(true);
  });

  it("draws the league table with its one-line meaning, a dash on the diagonal and, in every other cell, the effect, its named interval and the direct studies", () => {
    const { root } = draw(sample("network"));
    expect(root.querySelector("[data-vcr-league-meaning]")).toHaveTextContent("每格是“行”这种治疗比“列”这种治疗的效应");
    const table = within(root).getByRole("table", { name: "网络荟萃分析：response：两两比较" });
    for (const treatment of ["C", "B", "A"]) expect(within(table).getByRole("columnheader", { name: treatment })).toBeInTheDocument();
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute("data-vcr-league-row"))).toEqual(["C", "B", "A"]);
    // row i, column i is the treatment against itself
    rows.forEach((row, index) => {
      const cells = [...row.querySelectorAll("td")];
      expect(cells).toHaveLength(3);
      expect(cells[index].querySelector("[data-vcr-league-self]")).not.toBeNull();
      expect(cells[index].querySelector("[data-vcr-league-cell]")).toBeNull();
      cells.forEach((cell, column) => {
        if (column !== index) expect(cell.querySelector("[data-vcr-league-cell]")).not.toBeNull();
      });
    });
    const cb = rows[0].querySelectorAll("td")[1] as HTMLElement;
    expect(cb).toHaveTextContent("1.41");
    expect(cb).toHaveTextContent("95% 置信区间 0.88–2.25");
    expect(cb).toHaveTextContent("直接证据 2 项");
    // the pair is one table read two ways: B against C is the inverse of C against B
    expect((rows[1].querySelectorAll("td")[0] as HTMLElement)).toHaveTextContent("0.711");
  });

  it("marks the cells whose interval clears the null line, by ground and weight and for a reader without colour, and says what the mark is", () => {
    const { root } = draw(sample("network"));
    const marked = [...root.querySelectorAll("[data-vcr-league-excludes='true']")];
    const unmarked = [...root.querySelectorAll("[data-vcr-league-excludes='false']")];
    // C~A, B~A, A~C, A~B clear the line; C~B and B~C do not
    expect(marked).toHaveLength(4);
    expect(unmarked).toHaveLength(2);
    for (const cell of marked) {
      expect(cell.className).toContain("bg-accent-soft");
      expect(cell).toHaveTextContent("区间不含无效线");
      expect(cell.querySelector(".sr-only")).toHaveTextContent("区间不含无效线");
    }
    for (const cell of unmarked) {
      expect(cell.className).not.toContain("bg-accent-soft");
      expect(cell.querySelector(".sr-only")).toBeNull();
    }
    // the legend appears once, with the line that explains the meaning
    expect((root.querySelector("[data-vcr-league-meaning]") as HTMLElement).textContent?.match(/区间不含无效线/g)).toHaveLength(1);
  });

  it("draws no legend for a mark nothing carries", () => {
    const card = sample("network");
    const league = card.league!;
    const quiet = { ...card, league: { ...league, rows: league.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => (cell ? { ...cell, excludesNull: false } : cell)) })) } };
    const { root } = draw(quiet);
    expect(root.querySelector("[data-vcr-league-meaning]")).toHaveTextContent("每格是“行”这种治疗比“列”这种治疗的效应");
    expect(root.querySelector("[data-vcr-league-meaning]")).not.toHaveTextContent("区间不含无效线");
  });

  it("says how many studies compared a pair directly, including none, in a network that is a chain", () => {
    const { root } = draw(sample("network-chain"));
    const cells = [...root.querySelectorAll("[data-vcr-league-cell]")].map((cell) => cell.textContent ?? "");
    expect(cells.filter((text) => text.includes("直接证据 0 项"))).toHaveLength(2);
    expect(cells.filter((text) => text.includes("直接证据 1 项"))).toHaveLength(4);
    expect(root.querySelector("[data-vcr-network-consistency]")).toHaveTextContent("没有环");
    // the reference is B in this network
    expect(root.querySelector("tr[data-vcr-treatment='B']")).toHaveTextContent("对照");
  });

  it("states the consistency and the heterogeneity after the league table, and ends with the premises block", () => {
    const { root } = draw(sample("network"));
    const consistency = root.querySelector("[data-vcr-network-consistency]") as HTMLElement;
    const heterogeneity = root.querySelector("[data-vcr-network-heterogeneity]") as HTMLElement;
    expect(consistency).toHaveTextContent("没有发现不同比较组合之间不一致的证据（Q = 2.95，自由度 3，P = 0.4）");
    expect(heterogeneity).toHaveTextContent("研究之间的差异：I² = 0%，τ² = 0（总体 Q 检验 P = 0.4）。");
    const league = root.querySelectorAll("table")[1];
    expect(follows(league, consistency)).toBe(true);
    expect(follows(consistency, heterogeneity)).toBe(true);
    const premises = within(root).getByRole("heading", { name: "这个结论的前提" }).closest("section") as HTMLElement;
    expect(follows(heterogeneity, premises)).toBe(true);
    expect(premises.querySelectorAll("[data-vcr-premise]").length).toBeGreaterThanOrEqual(3);
    expect(premises.querySelector("[data-vcr-premise='direction']")).toHaveTextContent("数值越大越好");
    expect(premises.querySelector("[data-vcr-premise='transitivity']")).toHaveTextContent("间接比较成立的前提");
  });

  it("draws no banner or disclaimer of its own, and no back-office word", () => {
    const { root } = draw(sample("network"));
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
    expect(root.textContent).not.toMatch(/netmeta|evidence\.|diagnostics|引擎|job_/);
  });

  it("stacks one card per result, newest first as sent, each by its own id", () => {
    const { container } = render(<VcrNetworkMeta cards={[sample("network-chain"), sample("network")]} />);
    expect([...container.querySelectorAll("[data-vcr-network-meta]")].map((card) => card.getAttribute("data-vcr-network-meta"))).toEqual(["res_network-chain", "res_network"]);
  });
});

describe("网络荟萃分析 · what is not there", () => {
  it("draws nothing for no cards", () => {
    const { container } = render(<VcrNetworkMeta cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the ranking alone when the league table is missing, and drops a score column nobody has", () => {
    const card = sample("network");
    const { root } = draw({ ...card, league: null, consistency: null, heterogeneity: null, scoreNote: null, premises: [], ranking: card.ranking.map((row) => ({ ...row, score: null, studies: null })) });
    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(within(root).queryByRole("heading", { name: "两两比较" })).toBeNull();
    expect(within(root).queryByRole("columnheader", { name: "排序得分" })).toBeNull();
    expect(within(root).queryByRole("columnheader", { name: "研究数" })).toBeNull();
    expect(root.querySelector("[data-vcr-network-consistency], [data-vcr-network-heterogeneity], [data-vcr-network-score-note]")).toBeNull();
    expect(within(root).queryByRole("heading", { name: "这个结论的前提" })).toBeNull();
  });

  it("draws a pair with no estimate as a dash that is not the diagonal's", () => {
    const card = sample("network");
    const league = card.league!;
    const rows = league.rows.map((row, index) => (index === 0 ? { ...row, cells: [row.cells[0], null, row.cells[2]] } : row));
    const { root } = draw({ ...card, league: { ...league, rows } });
    const first = root.querySelector("tr[data-vcr-league-row='C']") as HTMLElement;
    expect(first.querySelector("[data-vcr-league-missing]")).toHaveTextContent("—");
    expect(first.querySelectorAll("[data-vcr-league-self]")).toHaveLength(1);
  });
});

describe("读取 · the payload", () => {
  it("keeps the numbers number for number, and pads a short league row to the treatments", () => {
    const [card] = readNetworkMetaCards([payloads.network]);
    expect(card.ranking.map((row) => row.treatment)).toEqual(["C", "B", "A"]);
    expect(card.ranking[0].score?.value).toBe(96.09670667);
    expect(card.league?.rows[0].cells[0]).toBeNull();
    expect(card.league?.rows[0].cells[1]?.value.interval).toMatchObject({ kind: "confidence", low: 0.88, high: 2.25, level: 95 });
    expect(card.league?.rows[0].cells[1]?.directStudies).toBe(2);
    expect(card.league?.rows[2].cells[0]?.excludesNull).toBe(true);
    const short = { ...payloads.network, league: { ...payloads.network.league, rows: [{ treatment: "C", cells: [null] }] } };
    expect(readNetworkMetaCards([short])[0].league?.rows[0].cells).toEqual([null, null, null]);
  });

  it("reads anything of an unknown shape as no card, and a malformed part as a part that is not there", () => {
    for (const garbage of [undefined, null, 7, "x", {}, [], [null], [{}], [{ id: "a" }], [{ id: "a", title: "t" }], [{ id: "a", title: "t", ranking: [{ rank: "1" }] }]]) {
      expect(readNetworkMetaCards(garbage)).toEqual([]);
    }
    const broken = { ...payloads.network, league: "none", consistency: 3, heterogeneity: null, premises: "x", ranking: [{ rank: 1, treatment: "A", score: "high" }] };
    const [card] = readNetworkMetaCards([broken]);
    expect(card).toMatchObject({ league: null, consistency: null, heterogeneity: null, premises: [] });
    expect(card.ranking).toEqual([{ rank: 1, treatment: "A", studies: null, score: null, isReference: false }]);
  });

  it("comes through the evidence tab's reader as a list, empty when the server sent none", () => {
    expect(readVcrData({ networkMeta: [payloads.network, payloads["network-chain"]] }).networkMeta?.map((card) => card.id)).toEqual(["res_network", "res_network-chain"]);
    for (const junk of [undefined, null, "x", {}, 5]) expect(readVcrData({ networkMeta: junk }).networkMeta).toEqual([]);
  });
});
