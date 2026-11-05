import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readTargetTrial, readVcrComparator, type VcrTargetTrialCard } from "@/lib/vcrClient";
import { VcrTargetTrial } from "./VcrTargetTrial";
import payloads from "./__fixtures__/targetTrialPayloads.json";

/**
 * 目标试验模拟: the card of a comparison, drawn from what the server's presenter makes of real engine results
 * (`__fixtures__/targetTrialPayloads.json`). The web places the numbers and words it is sent; it computes and rewrites none of them.
 */

afterEach(cleanup);

type Key = keyof typeof payloads;

const sample = (key: Key): VcrTargetTrialCard => {
  const card = readTargetTrial(payloads[key]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};

describe("目标试验模拟 · the card", () => {
  it("opens with the question as a heading and the server's sentence", () => {
    const card = sample("sequential");
    const { container } = render(<VcrTargetTrial card={card} />);
    const root = container.querySelector("[data-vcr-target-trial]") as HTMLElement;
    expect(within(root).getByRole("heading", { name: card.question })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-target-trial-sentence]")).toHaveTextContent(card.sentence);
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
  });

  it("draws one row per estimand, the risk difference as the headline column, and says each estimand and horizon", () => {
    const card = sample("sequential");
    const { container } = render(<VcrTargetTrial card={card} />);
    const table = within(container).getByRole("table", { name: "效应的估计" });
    for (const header of ["估计目标", "试验组风险", "对照组风险", "风险差", "风险比"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const itt = table.querySelector("tr[data-vcr-target-trial-estimand='itt']") as HTMLElement;
    const pp = table.querySelector("tr[data-vcr-target-trial-estimand='pp']") as HTMLElement;
    expect(itt).toHaveTextContent("意向治疗");
    expect(itt).toHaveTextContent("按每个试验开始时的治疗分组算");
    expect(pp).toHaveTextContent("按方案");
    expect(pp).toHaveTextContent("-17.7");
    expect(pp).toHaveTextContent("0.505");
    expect(itt.querySelector(".font-semibold")).not.toBeNull();
    for (const estimand of card.estimands) {
      expect(container.querySelector(`[data-vcr-target-trial-answers='${estimand.kind}']`)).toHaveTextContent(estimand.answers as string);
      expect(container).toHaveTextContent(estimand.answers as string);
    }
    expect(container.querySelector("[data-vcr-target-trial-naive]")).toBeNull();
    expect(container.querySelectorAll("[data-vcr-target-trial-checks] li")).toHaveLength(card.checks.length);
    expect(container.querySelector("[data-vcr-target-trial-weights]")).toHaveTextContent(card.weights as string);
    expect(container.querySelector("[data-vcr-target-trial-bootstrap]")).toHaveTextContent(card.bootstrap as string);
  });

  it("draws a clone-censor-weight result as one row with the naive number set apart and muted", () => {
    const card = sample("clone-censor-weight");
    const { container } = render(<VcrTargetTrial card={card} />);
    const table = within(container).getByRole("table", { name: "效应的估计" });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table.querySelector("tr[data-vcr-target-trial-estimand='pp']")).toHaveTextContent("-5.7");
    const naive = container.querySelector("[data-vcr-target-trial-naive]") as HTMLElement;
    expect(naive).toHaveTextContent(card.naiveSentence as string);
    expect(naive).toHaveTextContent("-15.9");
    expect(naive.className).toContain("text-text-3");
    expect(naive.textContent).not.toMatch(/置信区间/);
    expect(table).not.toHaveTextContent("-15.9");
  });

  it("shows the sentence of a bootstrap that ran out of time", () => {
    const { container } = render(<VcrTargetTrial card={sample("sequential-stopped")} />);
    const bootstrap = container.querySelector("[data-vcr-target-trial-bootstrap]") as HTMLElement;
    expect(bootstrap).toHaveTextContent("计算时间用完了");
    expect(bootstrap.className).toContain("text-caption");
    expect(bootstrap.className).toContain("text-text-3");
  });

  it("draws a dash for a risk ratio that is not there", () => {
    const card = sample("sequential");
    const estimands = card.estimands.map((row, index) => (index === 0 ? { ...row, riskRatio: null } : row));
    const { container } = render(<VcrTargetTrial card={{ ...card, estimands }} />);
    expect(container.querySelector("tr[data-vcr-target-trial-estimand='itt']")).toHaveTextContent("—");
  });

  it("draws nothing for no card", () => {
    expect(render(<VcrTargetTrial card={null} />).container).toBeEmptyDOMElement();
    expect(render(<VcrTargetTrial card={undefined} />).container).toBeEmptyDOMElement();
  });

  it("shows no raw key: every label on the page is the server's wording", () => {
    for (const key of Object.keys(payloads) as Key[]) {
      const { container, unmount } = render(<VcrTargetTrial card={sample(key)} />);
      const words = [...container.querySelectorAll("*")].flatMap((node) => [...node.childNodes])
        .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "");
      for (const word of words) expect(word).not.toMatch(/[A-Za-z]+_[A-Za-z_]+/);
      unmount();
    }
  });
});

describe("读取 · the comparator payload", () => {
  it("keeps the card the server sent, number for number, on the comparator tab", () => {
    const read = readVcrComparator({ targetTrialEmulation: payloads["sequential"] }).targetTrialEmulation;
    expect(read?.strategy).toBe("sequential");
    expect(read?.horizon).toBe(6);
    expect(read?.estimands.map((row) => row.kind)).toEqual(["itt", "pp"]);
    expect(read?.estimands[1].riskDifference.value).toBe(-17.69507754);
    expect(read?.estimands[1].riskDifference.unit).toBe("%");
    expect(read?.naive).toBeNull();
    expect(readVcrComparator({}).targetTrialEmulation).toBeNull();
  });

  it("reads anything of an unknown shape as nothing", () => {
    for (const garbage of [undefined, null, 7, "x", [], {}, { question: "q" }, { question: "q", sentence: "s" }]) {
      expect(readTargetTrial(garbage)).toBeNull();
    }
  });

  it("drops an estimand of an unknown kind or without a readable risk difference, and a payload with no estimand is nothing", () => {
    const base = payloads["sequential"];
    const unknownKind = { ...base, estimands: [{ ...base.estimands[0], kind: "ate" }, base.estimands[1]] };
    expect(readTargetTrial(unknownKind)?.estimands.map((row) => row.kind)).toEqual(["pp"]);
    const unreadable = { ...base, estimands: [{ ...base.estimands[0], riskDifference: null }, { ...base.estimands[1], riskDifference: { source: "calculated" } }] };
    expect(readTargetTrial(unreadable)).toBeNull();
    expect(readTargetTrial({ ...base, estimands: [] })).toBeNull();
    expect(readTargetTrial({ ...base, estimands: undefined })).toBeNull();
  });

  it("keeps a naive number only with the sentence that says what it is", () => {
    const base = payloads["clone-censor-weight"];
    expect(readTargetTrial(base)?.naive?.value).toBe(-15.86820295);
    expect(readTargetTrial({ ...base, naiveSentence: null })?.naive).toBeNull();
    expect(readTargetTrial({ ...base, naive: null })?.naiveSentence).toBeNull();
  });
});
