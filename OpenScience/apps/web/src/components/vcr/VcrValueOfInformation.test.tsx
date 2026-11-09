import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readValueOfInformationCards, type VcrValueOfInformationCard } from "@/lib/vcrClient";
import { VcrValueOfInformation } from "./VcrValueOfInformation";
import payloads from "./__fixtures__/valueOfInformationPayloads.json";

/**
 * 决策的信息价值: the card drawn from what the server's presenter makes of the engine's real results (`__fixtures__/valueOfInformationPayloads.json`).
 * Tables and a sentence that names the top row and leaves the decision to the person; an input with no distribution has no row in the table of values.
 */

afterEach(cleanup);

const sample = (key: "two-arm" | "range" | "table"): VcrValueOfInformationCard => {
  const [card] = readValueOfInformationCards([payloads[key]]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const draw = (card: VcrValueOfInformationCard) => {
  const view = render(<VcrValueOfInformation cards={[card]} />);
  return { ...view, root: view.container.querySelector("[data-vcr-voi]") as HTMLElement };
};

describe("决策的信息价值 · the card", () => {
  it("opens with the title and question, names the top input without choosing for the person, and lists a row for each input", () => {
    const { root } = draw(sample("two-arm"));
    expect(within(root).getByRole("heading", { name: "下一步最值得弄清什么（信息价值）" })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-voi-lead]")).toHaveTextContent(/最值得先弄清的是“药物效应”.*由你决定。/);
    const rows = [...root.querySelectorAll("[data-vcr-voi-input]")].map((row) => row.getAttribute("data-vcr-voi-input"));
    expect(rows).toContain("effect");
    expect(rows).toContain("effect + sd");
    expect(within(root).getByText("药物效应 + 结局的标准差")).toBeInTheDocument();
  });

  it("shows the studies with the value of learning what they observe beside them, and the current best option", () => {
    const { root } = draw(sample("two-arm"));
    expect([...root.querySelectorAll("[data-vcr-voi-study]")]).toHaveLength(2);
    expect(within(root).getByText(/现在期望收益最大/)).toBeInTheDocument();
    expect(within(root).getByText("把它观察的输入完全弄清的价值")).toBeInTheDocument();
  });

  it("words an input with no distribution as three decisions and a turning point, and gives it no row of values", () => {
    const { root } = draw(sample("range"));
    const block = root.querySelector("[data-vcr-voi-threshold='effect']") as HTMLElement;
    expect(block).toHaveTextContent("没有概率分布");
    expect(block).toHaveTextContent("之间改变");
    expect(root.querySelector("[data-vcr-voi-input='effect']")).toBeNull();
  });

  it("says in the premises that a table of draws was not computed here", () => {
    const { root } = draw(sample("table"));
    expect(root).toHaveTextContent("没有重新计算");
  });

  it("reads nothing out of a result of another shape", () => {
    expect(readValueOfInformationCards([{ id: "x", title: "t", form: "win_ratio" }, { id: "y", title: "t", form: "value_of_information", options: [] }, 3, null])).toEqual([]);
  });
});
