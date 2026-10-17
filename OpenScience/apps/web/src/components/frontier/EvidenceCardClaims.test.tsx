import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";
import { EvidenceClaims } from "./EvidenceCardClaims";
import { EvidenceInspector } from "./EvidenceInspector";
import { card, programmeCard } from "./__fixtures__/evidenceCards";

const mount = (evidence: EvidenceCard, challenges?: EvidenceChallengeView[]) =>
  render(<EvidenceInspector evidence={evidence} challenges={challenges}><EvidenceClaims evidence={evidence} /></EvidenceInspector>);
const rows = () => within(screen.getByRole("list", { name: "证据要点" })).getAllByRole("listitem");

describe("the claims of a card", () => {
  it("lists each claim with its mark in front — ✓ found, ⚠ not — and the sentence for what ⚠ means, and no quotation on the page", () => {
    mount(card);
    const [verified, unverified] = rows();
    expect(within(verified).getByLabelText("引文已核对")).toHaveTextContent("✓");
    expect(within(verified).getByText("来源 1")).toBeInTheDocument();
    expect(within(unverified).getByLabelText("未核对上")).toHaveTextContent("⚠");
    expect(within(unverified).getByText("来源里没有找到这段引文")).toBeInTheDocument();
    // The quotation is read in the drawer, not stacked under the row (R19: it was most of 40,000 px).
    expect(screen.queryByText(/Among 100 adults/)).not.toBeInTheDocument();
    expect(screen.queryByRole("blockquote")).not.toBeInTheDocument();
  });

  it("opens a claim in the drawer with its quotation, where it came from, and what it is uncertain about", async () => {
    mount(card);
    await userEvent.click(within(rows()[0]).getByRole("button", { name: /试验中卒中更少/ }));
    const drawer = screen.getByRole("dialog", { name: "结论的依据" });
    expect(within(drawer).getByLabelText("引文已核对")).toHaveTextContent("✓");
    expect(within(drawer).getByText("“Among 100 adults on the drug, 7 had a stroke”")).toBeInTheDocument();
    expect(within(drawer).getByText("不确定性：开放标签。")).toBeInTheDocument();
    // A [n] in the drawer opens that source in the same drawer, with the way back to the claim.
    await userEvent.click(within(drawer).getByRole("link", { name: "查看来源 1" }));
    const source = screen.getByRole("dialog", { name: "来源 1" });
    expect(within(source).getByText("Among 100 adults on the drug, 7 had a stroke")).toBeInTheDocument();
    await userEvent.click(within(source).getByRole("button", { name: "回到这条结论" }));
    expect(screen.getByRole("dialog", { name: "结论的依据" })).toHaveTextContent("试验中卒中更少");
  });

  it("says a quotation found only in the author's own excerpt is theirs and not the platform's reading, with ⚠", async () => {
    mount({ ...card, claims: [
      { text: "试验药降低卒中风险。", claimId: "CLM-009", claimType: "direct", sourceIndexes: [1], supportQuote: "7 had a stroke",
        verification: { claimId: "CLM-009", claimType: "direct", status: "author_excerpt_only", mark: "⚠", sources: [{ sourceIndex: 1, status: "author_excerpt_only", mark: "⚠" }] } },
    ] });
    const [item] = rows();
    expect(within(item).getByLabelText("未核对上")).toHaveTextContent("⚠");
    expect(within(item).getByText("摘录由作者提供，平台未读取原文")).toBeInTheDocument();
    await userEvent.click(within(item).getByRole("button"));
    expect(within(screen.getByRole("dialog")).getByText("摘录由作者提供，平台未读取原文")).toBeInTheDocument();
  });

  it("shows an estimate with its working and a synthesis with each of its sources, in the drawer", async () => {
    mount({ ...card, claims: [
      { text: "约少 50 例。", claimId: "CLM-003", claimType: "derived", method: "120 减 70", assumptions: "两组可比", sensitivity: "随事件数变化", verification: { claimId: "CLM-003", claimType: "derived", status: "derived", mark: null, sources: [] } },
      { text: "两项试验方向一致。", claimId: "CLM-004", claimType: "synthesized", confidence: "moderate", sourceIndexes: [1, 2], supportingSources: [{ sourceIndex: 1, supportQuote: "q1" }, { sourceIndex: 2, supportQuote: "q2" }],
        verification: { claimId: "CLM-004", claimType: "synthesized", status: "verified", mark: "✓", sources: [{ sourceIndex: 1, status: "verified", mark: "✓" }, { sourceIndex: 2, status: "quote_not_found", mark: "⚠" }] } },
    ] });
    const [estimate, synthesis] = rows();
    expect(within(estimate).getByText("推导结果")).toBeInTheDocument();
    expect(within(synthesis).getByText("综合结论 · 把握程度中 · 来源 1、2")).toBeInTheDocument();
    await userEvent.click(within(estimate).getByRole("button"));
    expect(screen.getByText("方法：120 减 70")).toBeInTheDocument();
    expect(screen.getByText("假设：两组可比")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await userEvent.click(within(synthesis).getByRole("button"));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("“q1”")).toBeInTheDocument();
    expect(within(drawer).getByText("“q2”")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("未核对上")).toBeInTheDocument();
  });

  // R30, 2026-10-10: the claim-type tag 平台计算 is content (how the number came about); the engine, the method and the receipt id behind it, and the
  // sentence for why a receipt did not hold, are the back office's. A ⚠ is the mark the product fixed for a claim that did not check out.
  it("shows a calculated claim as 平台计算 with its mark, and neither its engine, method and receipt nor why a receipt did not hold", async () => {
    const basis = { engine: "drug_safety_analysis", method: "faers.signals@1.1.0", receiptId: `rv_${"a".repeat(64)}`, valuePath: "values[0].ror.value", machineValue: 2.4012, format: "f2" };
    const { container } = mount({ ...card, claims: [
      { text: "报告比值比为 2.40。", claimId: "CALC-1", claimType: "calculated", calculation: basis, verification: { claimId: "CALC-1", claimType: "calculated", status: "verified", mark: "✓", sources: [] } },
      { text: "报告数为 1,234。", claimId: "CALC-2", claimType: "calculated", calculation: basis, verification: { claimId: "CALC-2", claimType: "calculated", status: "calculation_unverified", reason: "value_mismatch", mark: "⚠", sources: [] } },
    ] });
    const [held, lost] = rows();
    expect(within(held).getByText("平台计算")).toBeInTheDocument();
    expect(within(lost).getByText("平台计算")).toBeInTheDocument();
    expect(within(held).getByLabelText("引文已核对")).toHaveTextContent("✓");
    expect(within(lost).getByLabelText("未核对上")).toHaveTextContent("⚠");
    await userEvent.click(within(lost).getByRole("button"));
    expect(container.ownerDocument.body.textContent).not.toMatch(/引擎|方法 faers|回执|drug_safety_analysis|faers\.signals|机器值|不一致/);
    expect(within(held).queryByText(/来源 \d/)).not.toBeInTheDocument();
  });

  it("shows a claim of an older card as a plain line that opens nothing, and draws nothing for a card with none", () => {
    const { container, rerender } = mount({ ...card, claims: [{ text: "旧卡片的结论 [1]" }] });
    const [line] = rows();
    expect(line).toHaveTextContent("旧卡片的结论 [1]");
    expect(within(line).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("引文已核对")).not.toBeInTheDocument();
    rerender(<EvidenceInspector evidence={{ ...card, claims: [] }}><EvidenceClaims evidence={{ ...card, claims: [] }} /></EvidenceInspector>);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers 质疑 on a claim in its drawer where the deployment keeps evidence current", async () => {
    mount(card, []);
    await userEvent.click(within(rows()[0]).getByRole("button"));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: /质疑/ })).toBeInTheDocument();
  });
});

describe("the claims of a programme card (58 of them)", () => {
  const big = programmeCard();
  it("lists ten and the rest on request, with the count and a toolbar above the list: 全部 / 需要核对, a search, and the count of what matches", async () => {
    mount(big);
    expect(rows()).toHaveLength(10);
    expect(screen.getByRole("heading", { level: 2, name: /证据要点/ }).parentElement).toHaveTextContent("58");
    const toolbar = screen.getByRole("group", { name: "筛选证据要点" });
    expect(toolbar).toBeInTheDocument();
    expect(toolbar.compareDocumentPosition(screen.getByRole("list", { name: "证据要点" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 48 条" }));
    expect(rows()).toHaveLength(30);
    await userEvent.click(within(toolbar).getByRole("button", { name: /需要核对/ }));
    expect(rows()).toHaveLength(3);
    for (const row of rows()) expect(within(row).getByLabelText("未核对上")).toBeInTheDocument();
    expect(toolbar).toHaveTextContent("匹配 3 条");
    await userEvent.click(within(toolbar).getByRole("button", { name: "全部" }));
    await userEvent.type(within(toolbar).getByRole("searchbox", { name: "搜索证据要点" }), "结论 58");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("结论 58：");
  });

  it("draws neither the filter nor the search for a short list with nothing to check", () => {
    mount(card.claims.length ? { ...card, claims: card.claims.slice(0, 1) } : card);
    expect(screen.queryByRole("group", { name: "筛选证据要点" })).not.toBeInTheDocument();
  });

  it("says when nothing matches and lets go of the filter", async () => {
    mount(big);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索证据要点" }), "没有这个词");
    expect(screen.getByText("没有符合的结论。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(rows()).toHaveLength(10);
  });
});
