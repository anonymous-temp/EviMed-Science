import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readEffectShrinkageCards, readVcrData, type VcrEffectShrinkageCard } from "@/lib/vcrClient";
import { VcrEffectShrinkage } from "./VcrEffectShrinkage";
import payloads from "./__fixtures__/evidenceSynthesisPayloads.json";

/**
 * 已发表效应的对照: the card drawn from what the server's presenter makes of the engine's real results
 * (`__fixtures__/evidenceSynthesisPayloads.json`). A comparison line: the value the person wrote is shown first and unchanged, and the
 * other is beside it, never in its place.
 */

afterEach(cleanup);

const sample = (key: "shrinkage" | "shrinkage-null"): VcrEffectShrinkageCard => {
  const [card] = readEffectShrinkageCards([payloads[key]]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const draw = (card: VcrEffectShrinkageCard) => {
  const view = render(<VcrEffectShrinkage cards={[card]} />);
  return { ...view, root: view.container.querySelector("[data-vcr-effect-shrinkage]") as HTMLElement };
};
const follows = (earlier: Element, later: Element) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("已发表效应的对照 · the card", () => {
  it("opens with the title and the question, then a row for each value", () => {
    const { root } = draw(sample("shrinkage"));
    const title = within(root).getByRole("heading", { name: "已发表效应的对照：phase 2 hazard ratio" });
    const question = root.querySelector("[data-vcr-evidence-question]") as HTMLElement;
    expect(question).toHaveTextContent("会打几折？再做一次还能不能成功？");
    expect(follows(title, question)).toBe(true);
    const rows = [...root.querySelectorAll("[data-vcr-shrinkage-row]")];
    expect(rows.map((row) => row.getAttribute("data-vcr-shrinkage-row"))).toEqual(["phase2", "other"]);
    // two rows are told apart by their names
    expect(within(root).getByRole("heading", { name: "phase2" })).toBeInTheDocument();
    expect(within(root).getByRole("heading", { name: "other" })).toBeInTheDocument();
  });

  it("puts the value the person wrote first and unchanged, and the other beside it at the same weight", () => {
    const { root } = draw(sample("shrinkage"));
    const row = root.querySelector("[data-vcr-shrinkage-row='phase2']") as HTMLElement;
    const stated = row.querySelector("[data-vcr-shrinkage-stated]") as HTMLElement;
    const shrunken = row.querySelector("[data-vcr-shrinkage-shrunken]") as HTMLElement;
    expect(within(stated).getByText("你写的值")).toBeInTheDocument();
    expect(within(stated).getByText("0.66")).toBeInTheDocument();
    expect(within(shrunken).getByText("按 Cochrane 里这类试验的总体来看")).toBeInTheDocument();
    expect(shrunken).toHaveTextContent("0.761");
    expect(shrunken).toHaveTextContent("95% 可信区间 0.528–1.043");
    // the person's value is the first of the two and the two are siblings in one list of terms
    expect(follows(stated, shrunken)).toBe(true);
    expect(stated.parentElement).toBe(shrunken.parentElement);
    expect(stated.parentElement?.tagName).toBe("DL");
    // and the same type size, so neither reads as the answer
    expect(stated.querySelector("dd")?.className).toContain("text-ui");
    expect(shrunken.querySelector("dd")?.className).toContain("text-ui");
    // the person's value is not repeated as the shrunken one and nothing in the row points from one to the other
    expect(row.textContent).not.toMatch(/→|⇒|改为|替换|修正为/);
    expect(stated).not.toHaveTextContent("0.761");
    expect(shrunken).not.toHaveTextContent("你写的值");
  });

  it("follows the pair with the row's own sentence, then the card's note and premises", () => {
    const { root } = draw(sample("shrinkage"));
    const row = root.querySelector("[data-vcr-shrinkage-row='phase2']") as HTMLElement;
    const pair = row.querySelector("dl") as HTMLElement;
    const sentence = row.querySelector("[data-vcr-shrinkage-sentence]") as HTMLElement;
    expect(sentence).toHaveTextContent("你写的值是 0.66（z = -2.19）；Cochrane 里同类试验的总体读下来，真实的比值更可能是 0.761");
    expect(sentence).toHaveTextContent("方向正确的概率约 95%");
    expect(follows(pair, sentence)).toBe(true);
    const note = root.querySelector("[data-vcr-shrinkage-note]") as HTMLElement;
    expect(note).toHaveTextContent("你写的值保持原样，设计和假设卡不会改用它");
    expect(follows(sentence, note)).toBe(true);
    const premises = within(root).getByRole("heading", { name: "这个结论的前提" }).closest("section") as HTMLElement;
    expect(follows(note, premises)).toBe(true);
    expect(premises.querySelector("[data-vcr-premise='population']")).toHaveTextContent("23,551 项随机对照试验");
  });

  it("shows only the sentence for an estimate of exactly 0, which has no direction to shrink, and no heading for a single row", () => {
    const { root } = draw(sample("shrinkage-null"));
    expect(root.querySelector("[data-vcr-shrinkage-stated], [data-vcr-shrinkage-shrunken], dl")).toBeNull();
    expect(root.querySelector("[data-vcr-shrinkage-sentence]")).toHaveTextContent("估计恰为 0，没有方向可言：只能说方向对错各一半。");
    expect(within(root).queryByRole("heading", { name: "value1" })).toBeNull();
  });

  it("falls back to the sentence when one side of the pair is missing, rather than drawing half a comparison", () => {
    const card = sample("shrinkage");
    const { root } = draw({ ...card, rows: [{ ...card.rows[0], shrunken: null }, { ...card.rows[1], stated: null }] });
    expect(root.querySelector("[data-vcr-shrinkage-stated], [data-vcr-shrinkage-shrunken]")).toBeNull();
    expect(root.querySelectorAll("[data-vcr-shrinkage-sentence]")).toHaveLength(2);
  });

  it("draws no banner or disclaimer of its own, and no back-office word", () => {
    const { root } = draw(sample("shrinkage"));
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
    expect(root.textContent).not.toMatch(/bayesmeta|evidence\.|diagnostics|引擎|job_|the primary efficacy/);
  });

  it("draws nothing for no cards, and a card without premises or note ends at its rows", () => {
    expect(render(<VcrEffectShrinkage cards={[]} />).container).toBeEmptyDOMElement();
    cleanup();
    const { root } = draw({ ...sample("shrinkage"), note: null, premises: [] });
    expect(root.querySelector("[data-vcr-shrinkage-note]")).toBeNull();
    expect(within(root).queryByRole("heading", { name: "这个结论的前提" })).toBeNull();
  });
});

describe("读取 · the payload", () => {
  it("keeps the stated value exactly and the shrunken one with its credible interval", () => {
    const [card] = readEffectShrinkageCards([payloads.shrinkage]);
    expect(card.rows).toHaveLength(2);
    expect(card.rows[0].stated?.value).toBe(0.66);
    expect(card.rows[0].shrunken?.value).toBe(0.76139602);
    expect(card.rows[0].shrunken?.interval).toMatchObject({ kind: "credible", low: 0.528, high: 1.043, level: 95 });
    expect(card.rows[0].degenerate).toBe(false);
    const [zero] = readEffectShrinkageCards([payloads["shrinkage-null"]]);
    expect(zero.rows[0]).toMatchObject({ degenerate: true, shrunken: null });
  });

  it("reads anything of an unknown shape as no card, and a row without a sentence as no row", () => {
    for (const garbage of [undefined, null, 7, "x", {}, [], [null], [{}], [{ id: "a", title: "t" }], [{ id: "a", title: "t", rows: [{ id: "r" }] }]]) {
      expect(readEffectShrinkageCards(garbage)).toEqual([]);
    }
    const broken = { ...payloads.shrinkage, rows: [{ id: "a", sentence: "s", stated: { value: 3 }, shrunken: { value: { source: "calculated" } } }, { id: "b" }], note: 5, premises: "x" };
    const [card] = readEffectShrinkageCards([broken]);
    expect(card.rows).toHaveLength(1);
    // a value that is not an object is no value; one that is, but holds no number, reads as a dash and never as a zero
    expect(card.rows[0].stated).toBeNull();
    expect(card.rows[0].shrunken).toMatchObject({ value: null, source: "calculated" });
    expect(card).toMatchObject({ note: null, premises: [] });
  });

  it("comes through the evidence tab's reader as a list, empty when the server sent none", () => {
    expect(readVcrData({ effectShrinkages: [payloads.shrinkage] }).effectShrinkages?.map((card) => card.id)).toEqual(["res_shrinkage"]);
    for (const junk of [undefined, null, "x", {}, 5]) expect(readVcrData({ effectShrinkages: junk }).effectShrinkages).toEqual([]);
  });
});
