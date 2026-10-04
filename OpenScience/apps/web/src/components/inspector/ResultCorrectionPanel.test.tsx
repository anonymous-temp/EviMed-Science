import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultCorrectionPanel } from "./ResultCorrectionPanel";
import type { ResultCorrectionEntry } from "@/lib/resultProvenance";

const api = vi.hoisted(() => ({ corrections: vi.fn() }));
vi.mock("@/lib/resultProvenance", async (original) => ({ ...await original<typeof import("@/lib/resultProvenance")>(), getResultCorrections: api.corrections }));

const ORIGINAL = `rv_${"a".repeat(64)}`;
const SUCCESSOR = `rv_${"b".repeat(64)}`;
const entry = (extra: Partial<ResultCorrectionEntry> = {}): ResultCorrectionEntry => ({ id: "feedback:1", occurredAt: "2026-10-04T10:00:00Z", role: "original", outcome: null,
  correction: { revisionId: `rr_${"c".repeat(64)}`, original: { versionId: ORIGINAL, digest: "1".repeat(64), path: "report.md" }, successor: { versionId: SUCCESSOR, digest: "2".repeat(64), path: "o/report.md" },
    kind: "analytic", anchor: { kind: "text", selectedText: "合并 OR 为 0.71" }, instruction: "核对分母并加入新研究",
    effects: { bytes: "changed", printedNumbers: "changed", machineValues: "none", evidence: "changed", numbersAdded: ["0.68"], numbersRemoved: ["0.71"],
      identifiersAdded: ["doi:10.1000/beta"], identifiersRemoved: [], claimsAdded: [], claimsRemoved: [] } }, ...extra });
const onOpen = vi.fn();
const mount = (versionId = ORIGINAL) => render(<ResultCorrectionPanel key={versionId} versionId={versionId} onOpen={onOpen} />);
beforeEach(() => { vi.clearAllMocks(); });

describe("the corrections made to a version", () => {
  it("says what was asked, what moved between the two versions and which calculation was recomputed, and opens the other version", async () => {
    api.corrections.mockResolvedValue({ versionId: ORIGINAL, items: [entry({ outcome: { status: "settled", successorVersionId: SUCCESSOR, outputs: [], calculations: [
      { key: "values.pooled_effect", unit: "odds_ratio", before: { versionId: `rv_${"d".repeat(64)}`, value: 0.7134 }, after: { versionId: `rv_${"e".repeat(64)}`, value: 0.6812 } }] } })] });
    mount();
    const section = await screen.findByRole("region", { name: "一次修改" });
    expect(section).toHaveTextContent("此版本被修改过：数值有变化");
    expect(section).toHaveTextContent("你的要求：“核对分母并加入新研究”");
    expect(section).toHaveTextContent("所选内容：“合并 OR 为 0.71”");
    expect(section).toHaveTextContent("不再出现的数值：0.71");
    expect(section).toHaveTextContent("新出现的数值：0.68");
    expect(section).toHaveTextContent("新增来源：doi:10.1000/beta");
    expect(section).toHaveTextContent("重新计算：values.pooled_effect（0.7134 → 0.6812 odds_ratio）");
    await userEvent.click(within(section).getByRole("button", { name: "查看修改后的版本" }));
    expect(onOpen).toHaveBeenCalledWith(SUCCESSOR);
  });

  it("reads from the successor's side too, and says a rendering the run wrote was not checked against it", async () => {
    api.corrections.mockResolvedValue({ versionId: SUCCESSOR, items: [entry({ role: "successor", outcome: { status: "settled", successorVersionId: SUCCESSOR, calculations: [],
      outputs: [{ versionId: `rv_${"f".repeat(64)}`, path: "o/report.docx", role: "rendering", format: "docx", consistency: "not_checked" }] } })] });
    mount(SUCCESSOR);
    const section = await screen.findByRole("region", { name: "一次修改" });
    expect(section).toHaveTextContent("此版本由一次修改得到");
    expect(section).toHaveTextContent("随这次修改生成的 DOCX 没有逐项核对数值是否与修改后的版本一致；可在修改后的版本里直接导出 Word 或 PDF");
    await userEvent.click(within(section).getByRole("button", { name: "查看原版本" }));
    expect(onOpen).toHaveBeenCalledWith(ORIGINAL);
  });

  it("says a version that could not be compared is not comparable, and never reads it as unchanged", async () => {
    const base = entry();
    api.corrections.mockResolvedValue({ versionId: ORIGINAL, items: [entry({ correction: { ...base.correction, kind: "unknown", instruction: null,
      effects: { ...base.correction.effects, printedNumbers: "unknown", evidence: "unknown", numbersAdded: [], numbersRemoved: [], identifiersAdded: [] } } })] });
    mount();
    const section = await screen.findByRole("region", { name: "一次修改" });
    expect(section).toHaveTextContent("两个版本的内容无法逐项比较");
    expect(section).toHaveTextContent("文中的数值无法比较");
    expect(section).not.toHaveTextContent("你的要求");
  });

  it("shows nothing for a version that was never corrected, and a retry when the record cannot be read", async () => {
    api.corrections.mockResolvedValueOnce({ versionId: ORIGINAL, items: [] });
    const { container } = mount();
    await vi.waitFor(() => expect(api.corrections).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    api.corrections.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ versionId: SUCCESSOR, items: [entry()] });
    mount(SUCCESSOR);
    await userEvent.click(await screen.findByRole("button", { name: "重试读取修改记录" }));
    expect(await screen.findByRole("region", { name: "一次修改" })).toBeInTheDocument();
  });

  it("refuses an answer for another version", async () => {
    api.corrections.mockResolvedValue({ versionId: `rv_${"9".repeat(64)}`, items: [entry()] });
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("修改记录");
    expect(screen.queryByRole("region", { name: "一次修改" })).toBeNull();
  });
});
