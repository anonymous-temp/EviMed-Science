import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VCR_PREMISES_DECISIVE_MAX } from "@evimed/domain";
import { readPremises, type VcrPremise } from "@/lib/vcrClient";
import { VcrPremises, premiseDraft } from "./VcrPremises";

/**
 * 「这个结论的前提」 (remediation plan 5.2): one block, the decisive premises open (at most five), every other folded into one
 * disclosure, each with its value, where it came from, and one way to change it — the draft into the conversation's composer.
 */

const premise = (key: string, over: Partial<VcrPremise> = {}): VcrPremise => ({ key, label: `名称 ${key}`, value: `值 ${key}`, source: "assumed", decisive: true, ...over });
const SIX = [
  premise("effect", { label: "真实效应（风险比）", value: "0.7" }),
  premise("control", { label: "对照组中位时间", value: "12 个月" }),
  premise("dropout", { label: "每年脱落率", value: "0%", source: "default" }),
  premise("accrual", { label: "入组与随访", value: "入组 18 个月，随访 12 个月" }),
  premise("alpha", { label: "显著性水平", value: "单侧2.5%", source: "default" }),
  premise("method", { label: "分析方法", value: "log-rank 检验", source: "default", decisive: false }),
];

describe("这个结论的前提", () => {
  it("opens the decisive premises with value and source, and folds every other into one disclosure", () => {
    const { container } = render(<VcrPremises premises={SIX} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "这个结论的前提" })).toBeInTheDocument();
    const open = container.querySelector("[data-vcr-premises-open]") as HTMLElement;
    expect([...open.querySelectorAll("[data-vcr-premise]")].map((row) => row.getAttribute("data-vcr-premise"))).toEqual(["effect", "control", "dropout", "accrual", "alpha"]);
    // The dropout nobody wrote is there with its value and its source, in the attention tone.
    const dropout = open.querySelector("[data-vcr-premise='dropout']") as HTMLElement;
    expect(within(dropout).getByText("每年脱落率")).toBeInTheDocument();
    expect(within(dropout).getByText("0%")).toBeInTheDocument();
    expect(within(dropout).getByText("默认")).toBeInTheDocument();
    expect(within(open.querySelector("[data-vcr-premise='effect']") as HTMLElement).getByText("假设")).toBeInTheDocument();
    // The rest is one disclosure, closed.
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText("其余 1 条前提")).toBeInTheDocument();
    expect(details.querySelector("[data-vcr-premise='method']")).not.toBeNull();
    // No banner, no general caveat: the block is the heading and the rows.
    expect(container.querySelector("[role='alert'], [role='status']")).toBeNull();
  });

  it("shows no more than five open premises however many arrive decisive", () => {
    const many = Array.from({ length: 8 }, (_, index) => premise(`p${index}`));
    const { container } = render(<VcrPremises premises={many} />);
    expect(container.querySelectorAll("[data-vcr-premises-open] [data-vcr-premise]")).toHaveLength(VCR_PREMISES_DECISIVE_MAX);
    expect(container.querySelectorAll("details [data-vcr-premise]")).toHaveLength(3);
    expect(screen.getByText("其余 3 条前提")).toBeInTheDocument();
  });

  it("changes a premise one way: a draft named for it, sent to the composer and not sent anywhere else", async () => {
    const onChange = vi.fn();
    render(<VcrPremises premises={SIX} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 调整：每年脱落率" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ key: "dropout", label: "每年脱落率", value: "0%" });
    expect(premiseDraft(onChange.mock.calls[0][0])).toBe("改“每年脱落率”（现在是 0%）为：");
    // Every row has the one way, the folded ones too.
    expect(screen.getAllByRole("button", { name: /^让 AI 调整：/ })).toHaveLength(6);
  });

  it("offers no button to a reader who may not change anything, and draws nothing when there is nothing to say", () => {
    const { container, rerender } = render(<VcrPremises premises={SIX} />);
    expect(screen.queryByRole("button", { name: /让 AI 调整/ })).toBeNull();
    rerender(<VcrPremises premises={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VcrPremises premises={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the disclosure when nothing is decisive, so the premises are not hidden behind a label that says nothing", () => {
    const { container } = render(<VcrPremises premises={[premise("method", { decisive: false })]} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(within(details).getByText("全部 1 条前提")).toBeInTheDocument();
  });

  it("reads only well-formed rows from the server's payload, with a source the page has a word for", () => {
    expect(readPremises([
      { key: "a", label: "甲", value: "1", source: "literature", decisive: true },
      { key: "b", label: "乙", value: "2", source: "no such source", decisive: true },
      { key: "c", label: "", value: "3", source: "given" },
      { key: "d", label: "丁", value: "4", source: "given", reason: "一句话" },
    ])).toEqual([
      { key: "a", label: "甲", value: "1", source: "literature", decisive: true, reason: null },
      { key: "d", label: "丁", value: "4", source: "given", decisive: false, reason: "一句话" },
    ]);
    expect(readPremises(undefined)).toEqual([]);
  });
});
