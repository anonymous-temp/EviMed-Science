import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EvidenceCardViews, EvidenceFactBoxView, evidenceViewsHaveContent } from "./EvidenceCardViews";
import { availableFactBox, card, clinicalView, publicView, reasonedFactBox } from "./__fixtures__/evidenceCards";

describe("the two views of one card", () => {
  it("opens on the clinical summary-of-findings table, with the server's absolute effects and the reason where there is none", () => {
    render(<EvidenceCardViews evidence={card} />);
    expect(screen.getByRole("radio", { name: "临床版" })).toBeChecked();
    const table = screen.getByRole("table", { name: "结局总结表" });
    const [stroke, bleeding] = within(table).getAllByRole("row").slice(1);
    expect(within(stroke).getByText("RR 0.58")).toBeInTheDocument();
    expect(within(stroke).getByText("120 → 70（−50）")).toBeInTheDocument();
    expect(within(stroke).getByText("4,200 人 / 3 项研究")).toBeInTheDocument();
    expect(within(stroke).getByText("中")).toBeInTheDocument();
    expect(within(bleeding).getByText("缺少事件数或分母")).toBeInTheDocument();
    expect(screen.getByText("适用人群 · 有卒中风险的成人")).toBeInTheDocument();
    // A column nothing fills is not drawn.
    expect(screen.queryByText("公众版内容")).not.toBeInTheDocument();
  });
  it("switches to the public view: the written panels, the trace marks and the fact box per 1000 people", async () => {
    render(<EvidenceCardViews evidence={card} />);
    await userEvent.click(screen.getByRole("radio", { name: "公众版" }));
    expect(screen.queryByRole("table", { name: "结局总结表" })).not.toBeInTheDocument();
    expect(screen.getByText("一句话回答")).toBeInTheDocument();
    expect(screen.getByText("试验显示卒中减少，但大出血增多。")).toBeInTheDocument();
    expect(screen.getByText("误解：吃了就不会中风")).toBeInTheDocument();
    expect(screen.getByText("核对于 2026-10-04")).toBeInTheDocument();
    // A panel the author left empty is not drawn as an empty heading.
    expect(screen.queryByText("说明书怎么说")).not.toBeInTheDocument();
    // One panel rests on a verified claim, one on none.
    expect(screen.getAllByText("✓ 对应已核验的结论").length).toBeGreaterThan(0);
    expect(screen.getAllByText("⚠ 没有对应到已核验的结论").length).toBeGreaterThan(0);
    expect(screen.getByText("每 1000 人里")).toBeInTheDocument();
    expect(screen.getByText(/卒中（2 年）：常规治疗 120，试验药 70/)).toBeInTheDocument();
    expect(screen.getByText(/大出血（2 年）：常规治疗 10，试验药 30/)).toBeInTheDocument();
  });
  it("shows the reason in place of a fact box that has no numbers", () => {
    render(<EvidenceFactBoxView factBox={reasonedFactBox} />);
    expect(screen.getByText("比较里没有标明每个结局是获益还是不良反应，所以没有事实框。")).toBeInTheDocument();
    expect(screen.queryByText("每 1000 人里")).not.toBeInTheDocument();
  });
  it("says how many outcomes did not make it into an available fact box", () => {
    render(<EvidenceFactBoxView factBox={{ ...availableFactBox, excluded: [{ index: 2, reason: "counts_missing" }] }} />);
    expect(screen.getByText("另有 1 个结局没有放进事实框。")).toBeInTheDocument();
  });
  it("draws nothing for a card without views, or with views that have nothing to show", () => {
    const { container, rerender } = render(<EvidenceCardViews evidence={{ ...card, views: null }} />);
    expect(container).toBeEmptyDOMElement();
    const empty = { clinical: { ...clinicalView, rows: [] }, public: { ...publicView, panels: publicView.panels.map((panel) => ({ ...panel, status: "missing" as const })), factBox: reasonedFactBox } };
    expect(evidenceViewsHaveContent(empty)).toBe(false);
    rerender(<EvidenceCardViews evidence={{ ...card, views: empty }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("tells a reader of the public view that the author has written nothing there when it has only a fact box", async () => {
    const onlyBox = { clinical: { ...clinicalView, rows: [] }, public: { ...publicView, panels: publicView.panels.map((panel) => ({ ...panel, status: "missing" as const })), factBox: availableFactBox } };
    render(<EvidenceCardViews evidence={{ ...card, views: onlyBox }} />);
    await userEvent.click(screen.getByRole("radio", { name: "公众版" }));
    expect(screen.getByText("作者还没有写公众版内容。")).toBeInTheDocument();
    expect(screen.getByText("每 1000 人里")).toBeInTheDocument();
  });
});
