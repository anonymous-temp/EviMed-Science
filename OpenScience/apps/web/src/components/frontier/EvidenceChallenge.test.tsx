import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceChallenge } from "./EvidenceChallenge";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";

const client = vi.hoisted(() => ({ submitEvidenceChallenge: vi.fn(), listMyEvidenceChallenges: vi.fn() }));
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

  it("says a challenge is received and queued while the platform's day for judging is spent", async () => {
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge({ waiting: true })} />);
    expect(await screen.findByText(/已收到，排队复核/)).toBeInTheDocument();
    expect(screen.queryByText(/正在复核/)).toBeNull();
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

describe("a challenge that is being reviewed (module workspace audit, D7)", () => {
  beforeEach(() => { vi.clearAllMocks(); useToastStore.setState({ toasts: [] }); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("asks again while the review lasts, and shows the result, with a notice, when it comes", async () => {
    client.listMyEvidenceChallenges.mockResolvedValue([challenge()]);
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge()} />);
    expect(screen.getByText("已提交，正在复核。结果会写进变更记录，也会通知你。")).toBeInTheDocument();
    await advance(9_000);
    expect(client.listMyEvidenceChallenges).not.toHaveBeenCalled();
    await advance(1_000);
    expect(client.listMyEvidenceChallenges).toHaveBeenCalledWith("ec_1");
    // Still open: the status is as it was, and the next wait is longer than the first.
    expect(screen.getByText(/正在复核/)).toBeInTheDocument();
    client.listMyEvidenceChallenges.mockResolvedValue([challenge({ state: "resolved", outcome: "uphold", outcomeLabel: "成立", explanation: "原文确实没有这个数字" })]);
    await advance(19_000);
    expect(client.listMyEvidenceChallenges).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(screen.getByText("复核结果：成立")).toBeInTheDocument();
    expect(screen.queryByText(/正在复核/)).toBeNull();
    expect(useToastStore.getState().toasts.map((item) => item.message)).toEqual(["你的质疑有结果了。复核结果：成立"]);
    // Settled: it asks no more.
    await advance(600_000);
    expect(client.listMyEvidenceChallenges).toHaveBeenCalledTimes(2);
  });

  it("stops asking after a few minutes and says that the answer will come by the inbox", async () => {
    client.listMyEvidenceChallenges.mockResolvedValue([challenge()]);
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" existing={challenge()} />);
    for (let wait = 0; wait < 8; wait += 1) await advance(121_000);
    expect(client.listMyEvidenceChallenges).toHaveBeenCalledTimes(7);
    expect(screen.getByText("复核还没有结果，不用等在这里：结果会写进变更记录，也会通知你。")).toBeInTheDocument();
    expect(screen.queryByText(/正在复核/)).toBeNull();
  });

  it("keeps the status when a read fails, and watches a challenge filed on the card too", async () => {
    client.submitEvidenceChallenge.mockResolvedValue(challenge({ id: "ch_new" }));
    client.listMyEvidenceChallenges.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([challenge({ id: "ch_new", state: "notified", route: "producer_notice" })]);
    render(<EvidenceChallenge cardId="ec_1" claimId="CLM-2" />);
    await act(async () => { screen.getByRole("button", { name: "质疑结论 CLM-2" }).click(); });
    const field = screen.getByRole("textbox");
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(field, "原文里没有这个数字"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { screen.getByRole("button", { name: "提交质疑" }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/正在复核/)).toBeInTheDocument();
    await advance(10_000);
    expect(screen.getByText(/正在复核/)).toBeInTheDocument();
    await advance(20_000);
    expect(screen.getByText(/已通知出品方/)).toBeInTheDocument();
    expect(useToastStore.getState().toasts.map((item) => item.message)).toEqual(["你的质疑已通知出品方。"]);
  });
});
