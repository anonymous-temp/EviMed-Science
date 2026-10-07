import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceChangeLog } from "./EvidenceChangeLog";
import type { EvidenceChangeEntry } from "@/lib/evidenceUpkeepClient";

const client = vi.hoisted(() => ({ fetchEvidenceChanges: vi.fn() }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()),
  ...client,
}));

const entry = (over: Partial<EvidenceChangeEntry> = {}): EvidenceChangeEntry => ({
  id: "9", zoneId: "z1", cardId: "ec_1", cardTitle: "阿哌沙班预防卒中", revisionBefore: 2, revisionAfter: 3,
  category: "correction", categoryLabel: "更正", trigger: "challenge", triggerLabel: "读者质疑",
  summary: "读者对结论 CLM-2 提出质疑；复核后修正了该条结论的表述（第 2 版 → 第 3 版）。", occurredAt: "2026-10-05T08:00:00Z", ...over,
});

describe("the change log", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists each entry with its day, its category, what triggered it and the sentence the server made", async () => {
    client.fetchEvidenceChanges.mockResolvedValue({ items: [entry(), entry({ id: "8", category: "searched_no_change", categoryLabel: "已重新检索，结论未变", trigger: "scheduled_check", triggerLabel: "定期核对", summary: "平台重新比对了前沿动态里的新研究，没有发现与本卡对得上的新证据，结论未变。" })], nextBefore: null });
    render(<EvidenceChangeLog zoneId="z1" />);
    expect(await screen.findByText(/读者对结论 CLM-2 提出质疑/)).toBeInTheDocument();
    expect(screen.getByText("更正")).toBeInTheDocument();
    expect(screen.getByText("由读者质疑触发")).toBeInTheDocument();
    expect(screen.getByText("已重新检索，结论未变")).toBeInTheDocument();
    expect(screen.getAllByText("阿哌沙班预防卒中")).toHaveLength(2);
    expect(client.fetchEvidenceChanges).toHaveBeenCalledWith("z1", { cardId: undefined, limit: 20 });
    expect(screen.queryByRole("button", { name: "查看更早的记录" })).toBeNull();
  });

  it("pages back through older entries, and narrows to one card without repeating its title on each line", async () => {
    client.fetchEvidenceChanges
      .mockResolvedValueOnce({ items: [entry({ id: "9" })], nextBefore: "9" })
      .mockResolvedValueOnce({ items: [entry({ id: "7", summary: "出品方更新了本卡（第 1 版 → 第 2 版）。", trigger: "producer_edit", triggerLabel: "出品方修改" })], nextBefore: null });
    render(<EvidenceChangeLog zoneId="z1" cardId="ec_1" />);
    await screen.findByText(/读者对结论 CLM-2/);
    expect(screen.queryByText("阿哌沙班预防卒中")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看更早的记录" }));
    expect(client.fetchEvidenceChanges).toHaveBeenLastCalledWith("z1", { cardId: "ec_1", before: "9", limit: 20 });
    expect(await screen.findByText("出品方更新了本卡（第 1 版 → 第 2 版）。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看更早的记录" })).toBeNull();
  });

  it("says so when there is nothing yet, and offers a retry when the log cannot be read", async () => {
    client.fetchEvidenceChanges.mockResolvedValueOnce({ items: [], nextBefore: null });
    const { unmount } = render(<EvidenceChangeLog zoneId="z1" />);
    expect(await screen.findByText("还没有变更记录")).toBeInTheDocument();
    unmount();
    client.fetchEvidenceChanges.mockRejectedValueOnce(new WebApiError("gone", { status: 404, code: "evidence_not_found" })).mockResolvedValueOnce({ items: [entry()], nextBefore: null });
    render(<EvidenceChangeLog zoneId="z1" />);
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(/读者对结论 CLM-2/)).toBeInTheDocument();
  });
});
