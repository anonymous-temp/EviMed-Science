import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceChallenge } from "./EvidenceChallenge";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";

const client = vi.hoisted(() => ({ submitEvidenceChallenge: vi.fn() }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()),
  ...client,
}));

const challenge = (over: Partial<EvidenceChallengeView> = {}): EvidenceChallengeView => ({
  id: "ch_1", cardId: "ec_1", claimId: "CLM-2", state: "open", route: "platform_recheck", outcome: null, outcomeLabel: null,
  reason: "原文里没有这个数字", createdAt: "2026-10-05T00:00:00Z", resolvedAt: null, explanation: null, changeLogId: null, ...over,
});

describe("challenging one claim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a reason field from the 质疑 action, files the challenge and shows where it stands", async () => {
    client.submitEvidenceChallenge.mockResolvedValue(challenge());
    const onFiled = vi.fn();
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" onFiled={onFiled} />);
    await userEvent.click(screen.getByRole("button", { name: "质疑结论 CLM-2" }));
    const field = screen.getByRole("textbox", { name: /说明你认为哪里不对/ });
    expect(screen.getByRole("button", { name: "提交质疑" })).toBeDisabled();
    await userEvent.type(field, "原文里没有这个数字");
    await userEvent.click(screen.getByRole("button", { name: "提交质疑" }));
    expect(client.submitEvidenceChallenge).toHaveBeenCalledWith("ec_1", "CLM-2", "原文里没有这个数字");
    expect(onFiled).toHaveBeenCalledWith(expect.objectContaining({ id: "ch_1" }));
    expect(await screen.findByText("已提交，正在复核。结果会写进变更记录，也会通知你。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps what the reader wrote when the server refuses, and says why in the registry's words", async () => {
    client.submitEvidenceChallenge.mockRejectedValue(new WebApiError("limit", { status: 429, code: "evidence_challenge_rate_limited" }));
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" />);
    await userEvent.click(screen.getByRole("button", { name: "质疑结论 CLM-2" }));
    await userEvent.type(screen.getByRole("textbox"), "我的理由写在这里");
    await userEvent.click(screen.getByRole("button", { name: "提交质疑" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上限");
    expect(screen.getByRole("textbox")).toHaveValue("我的理由写在这里");
    expect(screen.getByRole("button", { name: "提交质疑" })).toBeEnabled();
  });

  it("closes the form without sending anything when the reader cancels", async () => {
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" />);
    await userEvent.click(screen.getByRole("button", { name: "质疑结论 CLM-2" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(client.submitEvidenceChallenge).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "质疑结论 CLM-2" })).toBeInTheDocument();
  });

  it("shows an earlier challenge's state instead of the action: judged, told to the producer, or closed by their edit", () => {
    const { rerender } = render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge({ state: "resolved", outcome: "amend", outcomeLabel: "修正", explanation: "原文是 3/100。" })} />);
    expect(screen.getByText("复核结果：修正")).toBeInTheDocument();
    expect(screen.getByText("原文是 3/100。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "质疑结论 CLM-2" }), "once settled the reader may challenge again").toHaveTextContent("再次质疑");
    rerender(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge({ state: "notified", route: "producer_notice" })} />);
    expect(screen.getByText(/已通知出品方。平台不会替出品方修改内容/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /质疑结论/ }), "one open challenge per claim").toBeNull();
    rerender(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge({ state: "closed", route: "producer_notice" })} />);
    expect(screen.getByText("出品方已修改这张卡，这条质疑已关闭。")).toBeInTheDocument();
  });
});
