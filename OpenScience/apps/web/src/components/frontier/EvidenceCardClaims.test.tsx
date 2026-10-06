import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceClaims, EvidenceDisclosure } from "./EvidenceCardClaims";
import { card } from "./__fixtures__/evidenceCards";

describe("the claims of a card", () => {
  it("marks each claim ✓ or ⚠ and shows its quotation, with the sentence for what ⚠ means", () => {
    render(<EvidenceClaims evidence={card} />);
    const [verified, unverified] = screen.getAllByRole("listitem");
    expect(within(verified).getByLabelText("已核验")).toHaveTextContent("✓");
    expect(within(verified).getByText("“Among 100 adults on the drug, 7 had a stroke”")).toBeInTheDocument();
    expect(within(verified).getByText("不确定性：开放标签。")).toBeInTheDocument();
    expect(within(unverified).getByLabelText("未能核验")).toHaveTextContent("⚠");
    expect(within(unverified).getByText("来源里没有找到这段引文")).toBeInTheDocument();
    expect(within(unverified).getByRole("link", { name: "查看来源 1" })).toHaveAttribute("href", expect.stringContaining("evidence-source-"));
  });
  it("shows an estimate with its working and a synthesis with each of its sources", () => {
    render(<EvidenceClaims evidence={{ ...card, claims: [
      { text: "约少 50 例。", claimId: "CLM-003", claimType: "derived", method: "120 减 70", assumptions: "两组可比", sensitivity: "随事件数变化", verification: { claimId: "CLM-003", claimType: "derived", status: "derived", mark: null, sources: [] } },
      { text: "两项试验方向一致。", claimId: "CLM-004", claimType: "synthesized", confidence: "moderate", sourceIndexes: [1, 2], supportingSources: [{ sourceIndex: 1, supportQuote: "q1" }, { sourceIndex: 2, supportQuote: "q2" }],
        verification: { claimId: "CLM-004", claimType: "synthesized", status: "verified", mark: "✓", sources: [{ sourceIndex: 1, status: "verified", mark: "✓" }, { sourceIndex: 2, status: "quote_not_found", mark: "⚠" }] } },
    ] }} />);
    expect(screen.getByText("推导结果")).toBeInTheDocument();
    expect(screen.getByText("方法：120 减 70")).toBeInTheDocument();
    expect(screen.getByText("综合结论 · 把握程度中")).toBeInTheDocument();
    expect(screen.getByText("“q1”")).toBeInTheDocument();
    expect(screen.getByText("“q2”")).toBeInTheDocument();
    expect(screen.getByLabelText("未能核验")).toBeInTheDocument();
  });
  it("shows a calculated claim as 平台计算 with its engine, method and receipt, and a ⚠ with the sentence for why its receipt did not hold", () => {
    const basis = { engine: "drug_safety_analysis", method: "faers.signals@1.1.0", receiptId: `rv_${"a".repeat(64)}`, valuePath: "values[0].ror.value", machineValue: 2.4012, format: "f2" };
    render(<EvidenceClaims evidence={{ ...card, claims: [
      { text: "报告比值比为 2.40。", claimId: "CALC-1", claimType: "calculated", calculation: basis, verification: { claimId: "CALC-1", claimType: "calculated", status: "verified", mark: "✓", sources: [] } },
      { text: "报告数为 1,234。", claimId: "CALC-2", claimType: "calculated", calculation: basis, verification: { claimId: "CALC-2", claimType: "calculated", status: "calculation_unverified", reason: "value_mismatch", mark: "⚠", sources: [] } },
    ] }} />);
    const [held, lost] = screen.getAllByRole("listitem");
    expect(within(held).getByText("平台计算")).toBeInTheDocument();
    expect(within(held).getByText(`引擎 drug_safety_analysis · 方法 faers.signals@1.1.0 · 回执 rv_${"a".repeat(64)}`)).toBeInTheDocument();
    expect(within(held).getByLabelText("已核验")).toHaveTextContent("✓");
    expect(within(lost).getByLabelText("未能核验")).toHaveTextContent("⚠");
    expect(within(lost).getByText("回执里的数值与结论记录的机器值不一致")).toBeInTheDocument();
    expect(within(held).queryByText(/来源 \d/)).not.toBeInTheDocument();
  });
  it("shows a claim of an older card as a plain line, and draws nothing for a card with none", () => {
    const { container, rerender } = render(<EvidenceClaims evidence={{ ...card, claims: [{ text: "旧卡片的结论 [1]" }] }} />);
    expect(screen.getByText("旧卡片的结论 [1]")).toBeInTheDocument();
    expect(screen.queryByLabelText("已核验")).not.toBeInTheDocument();
    rerender(<EvidenceClaims evidence={{ ...card, claims: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the disclosure of a card", () => {
  it("states the model, the dates, what the AI did, who wrote it and who reviewed it", () => {
    render(<EvidenceDisclosure evidence={{ ...card, disclosure: { ...card.disclosure!, modelVersion: "2026-09", reviewers: [{ name: "王药师", title: "主管药师", affiliation: "某医院" }] } }} />);
    expect(screen.getByText("AI 模型").nextElementSibling).toHaveTextContent("deepseek-v4-flash 2026-09");
    expect(screen.getByText("AI 做了").nextElementSibling).toHaveTextContent("检索、筛选、抽取、综合");
    expect(screen.getByText("作者").nextElementSibling).toHaveTextContent("李研究");
    expect(screen.getByText("审核").nextElementSibling).toHaveTextContent("王药师，主管药师，某医院");
    expect(screen.getByText("最后核对")).toBeInTheDocument();
  });
  it("draws nothing when a card discloses nothing", () => {
    const { container } = render(<EvidenceDisclosure evidence={{ ...card, disclosure: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
