import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readSplineFit, readVcrComparator, type VcrBorrowingCard, type VcrSplineFitBlock } from "@/lib/vcrClient";
import { VcrBorrowing } from "./VcrBorrowing";
import { VcrSplineFit } from "./VcrSplineFit";
import payloads from "./__fixtures__/borrowingPayloads.json";

/**
 * 外部对照的动态借用 and 样条生存拟合: drawn from what the server's presenters make of real engine results
 * (`__fixtures__/borrowingPayloads.json`). The web places the numbers it is sent; it computes none of them.
 */

afterEach(cleanup);

const sample = (key: "power-binary" | "sam-binary" | "elastic-binary" | "elastic-mean"): VcrBorrowingCard => {
  const card = readVcrComparator({ borrowing: payloads[key] }).borrowing;
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const spline = (): VcrSplineFitBlock => {
  const block = readSplineFit(payloads.spline);
  if (!block) throw new Error("the spline sample did not read");
  return block;
};

describe("外部对照的动态借用 · the card", () => {
  it("opens with the question of its prior and shows no borrowing, the prior and full borrowing side by side", () => {
    const { container } = render(<VcrBorrowing card={sample("power-binary")} />);
    const card = container.querySelector("[data-vcr-borrowing]") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "外部对照每个人只按一部分算时，结论如何？" })).toBeInTheDocument();
    const rows = Array.from(card.querySelectorAll("[data-vcr-borrowing-row]")).map((row) => row.getAttribute("data-vcr-borrowing-row"));
    expect(rows).toEqual(["none", "chosen", "full"]);
    expect(card).toHaveTextContent("固定折扣（幂先验）");
    expect(card).toHaveTextContent("全部借用（折扣 1）");
    expect(card.querySelector("[data-vcr-borrowing-part='conflict']")).toBeNull();
  });

  it("a self-adapting prior has its table of conflict against borrowing and the operating characteristics with and without borrowing", () => {
    const { container } = render(<VcrBorrowing card={sample("sam-binary")} />);
    const card = container.querySelector("[data-vcr-borrowing]") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "借用多少由数据决定时，结果如何？" })).toBeInTheDocument();
    const conflict = card.querySelector("[data-vcr-borrowing-part='conflict']") as HTMLElement;
    expect(conflict).toHaveTextContent("与历史一致");
    expect(conflict).toHaveTextContent("高出历史");
    const operating = card.querySelector("[data-vcr-borrowing-part='operating']") as HTMLElement;
    for (const header of ["I 类错误（不借用）", "I 类错误（借用）", "功效（不借用）", "功效（借用）"]) expect(within(operating).getByText(header)).toBeInTheDocument();
    expect(within(operating).getAllByRole("row")).toHaveLength(1 + 5);
    expect(operating).toHaveTextContent("没有模拟误差");
  });

  it("an elastic prior with no current data is the conflict table and the design alone; a mean is not drawn as a percentage", () => {
    const design = render(<VcrBorrowing card={sample("elastic-binary")} />);
    expect(design.container.querySelector("[data-vcr-borrowing-row]")).toBeNull();
    expect(design.container.querySelector("[data-vcr-borrowing-part='conflict']")).not.toBeNull();
    cleanup();
    const { container } = render(<VcrBorrowing card={sample("elastic-mean")} />);
    const chosen = container.querySelector("[data-vcr-borrowing-row='chosen']") as HTMLElement;
    const cells = Array.from((chosen.closest("tr") as HTMLElement).querySelectorAll("td, th"));
    expect(cells[1]).not.toHaveTextContent("%");                       // the posterior mean and its interval are a mean, not a share
    expect(cells[2]).not.toHaveTextContent("%");
    expect(cells[3]).toHaveTextContent("%");                           // the probability that the treatment is better is
  });

  it("reads nothing from an unknown shape and draws nothing without a card", () => {
    expect(readVcrComparator({ borrowing: { question: "x", kind: "magic" } }).borrowing).toBeNull();
    expect(readVcrComparator({ borrowing: { question: "x", kind: "power", posterior: [] } }).borrowing).toBeNull();
    const { container } = render(<VcrBorrowing card={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("样条生存拟合 · the block", () => {
  it("asks the question, flags the times beyond the data with how many times the follow-up they are, and lists the other numbers of knots", () => {
    const { container } = render(<VcrSplineFit block={spline()} />);
    const block = container.querySelector("[data-vcr-spline-fit]") as HTMLElement;
    expect(within(block).getByRole("heading", { name: "风险曲线不单调时，长期生存和 RMST 是多少？" })).toBeInTheDocument();
    const flags = Array.from(block.querySelectorAll("[data-vcr-spline-beyond]")).map((cell) => cell.getAttribute("data-vcr-spline-beyond"));
    expect(flags).toEqual(["false", "false", "true"]);
    expect(block.querySelector("[data-vcr-spline-beyond='true']")).toHaveTextContent("外推");
    expect(block).toHaveTextContent("限制性平均生存时间（RMST）");
    expect(block.querySelectorAll("[data-vcr-spline-selected='true']")).toHaveLength(1);
    expect(block).toHaveTextContent("没有算进区间");
  });

  it("states three decisive premises with their values and no back-office word", () => {
    const { container } = render(<VcrSplineFit block={spline()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("这个结论的前提");
    expect(text).toContain("最后一个时间点离数据有多远");
    expect(text).toContain("曲线的灵活程度");
    expect(text).toContain("最后一个结点之后的形状");
    expect(text).not.toMatch(/spline|flexsurv|optim|delta/);
  });

  it("draws nothing for a block of an unknown shape", () => {
    expect(readSplineFit({ question: "x", curve: [] })).toBeNull();
    const { container } = render(<VcrSplineFit block={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
