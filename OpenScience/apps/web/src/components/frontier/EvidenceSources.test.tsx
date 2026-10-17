import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { EvidenceInspector } from "./EvidenceInspector";
import { EvidenceSources } from "./EvidenceSources";
import { card, programmeCard } from "./__fixtures__/evidenceCards";

const mount = (evidence: EvidenceCard) => render(<EvidenceInspector evidence={evidence}><EvidenceSources evidence={evidence} /></EvidenceInspector>);
const rows = () => within(screen.getByRole("list", { name: "来源与引用" })).getAllByRole("listitem");

describe("the sources of a card", () => {
  it("lists each source as a row — its number, its title, how much of it was read, how many conclusions stand on it — with no excerpt on the page", () => {
    mount(card);
    const [row] = rows();
    expect(row).toHaveTextContent("[1]");
    expect(row).toHaveTextContent("试验 A");
    expect(row).toHaveTextContent("依据全文");
    expect(row).toHaveTextContent("2 条结论依据它");
    expect(row).toHaveTextContent("example.org");
    expect(screen.queryByText(/Among 100 adults/)).not.toBeInTheDocument();
  });

  it("opens a source with the way to the original, its excerpt and the conclusions that name it, and a conclusion from there", async () => {
    mount(card);
    await userEvent.click(within(rows()[0]).getByRole("button", { name: "试验 A" }));
    const drawer = screen.getByRole("dialog", { name: "来源 1" });
    expect(within(drawer).getByRole("link", { name: /打开原文/ })).toHaveAttribute("href", "https://example.org/a");
    expect(within(drawer).getByText("Among 100 adults on the drug, 7 had a stroke")).toBeInTheDocument();
    const cited = within(drawer).getByRole("region", { name: "依据这个来源的结论" });
    expect(within(cited).getAllByRole("button").map((button) => button.textContent)).toEqual(["试验中卒中更少。", "出血减半。"]);
    await userEvent.click(within(cited).getByRole("button", { name: "出血减半。" }));
    expect(screen.getByRole("dialog", { name: "结论的依据" })).toHaveTextContent("出血减半。");
  });

  it("says a retraction on the row, in the safety tag, and narrows to the sources that have one", async () => {
    const warned = { ...card, sources: [{ ...card.sources[0], publicationStatus: { kind: "retracted" as const, notices: ["撤稿声明"] } }, { ...card.sources[0], title: "试验 B" }] };
    mount(warned);
    expect(within(rows()[0]).getByText("存在撤稿记录")).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /有警示/ }));
    expect(rows()).toHaveLength(1);
    await userEvent.click(within(rows()[0]).getByRole("button"));
    expect(within(screen.getByRole("dialog")).getByText("撤稿声明")).toBeInTheDocument();
  });
});

describe("the sources of a programme card (39 of them)", () => {
  const big = programmeCard();
  it("lists ten and the rest on request, under a toolbar with a search, and finds a source by its title", async () => {
    mount(big);
    expect(rows()).toHaveLength(10);
    expect(screen.getByRole("heading", { level: 2, name: /来源与引用/ }).parentElement).toHaveTextContent("39");
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 29 个" }));
    expect(rows()).toHaveLength(30);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索来源" }), "研究 39");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("[39]");
    expect(screen.getByRole("group", { name: "筛选来源" })).toHaveTextContent("匹配 1 个");
  });

  it("draws no filter for sources when none of them is warned, and no toolbar at all for a short list", () => {
    mount(big);
    expect(screen.queryByRole("button", { name: /有警示/ })).not.toBeInTheDocument();
    const { container } = render(<EvidenceInspector evidence={card}><EvidenceSources evidence={card} /></EvidenceInspector>);
    expect(within(container).queryByRole("group", { name: "筛选来源" })).not.toBeInTheDocument();
  });
});
